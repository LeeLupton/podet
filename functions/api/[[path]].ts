// PodNet API — Cloudflare Pages Functions on the Workers runtime, built with Hono.
//
// Trust model: the API is the security boundary, not the database. D1 is never
// exposed to the browser. Every protected route runs the `auth` middleware
// (verify session) and then checks ownership/state in the handler. The API also
// shapes every response so PII (password_hash, other users' email) never leaks.
//
// SESSION_SECRET is read from the environment only (env.SESSION_SECRET) — never
// hardcoded, never committed. See wrangler.toml / .dev.vars for wiring.

import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { secureHeaders } from 'hono/secure-headers'

import { bboxDeltas, haversineMiles } from '../lib/geo'
import { parseGigInput } from '../lib/gig'
import { clampLimit, parseBefore } from '../lib/pagination'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/password'
import { MAX_PHOTOS_PER_GIG, checkImageUpload, photoKey } from '../lib/photos'
import { type PushDeliveryOptions, isAllowedPushEndpoint, sendWebPush, topicFor } from '../lib/push'
import { rateLimitKey, windowStart } from '../lib/ratelimit'
import { REVIEW, planReview, planRevision } from '../lib/review'
import { validateSlot } from '../lib/schedule'
import { LIMITS, isValidRating, validateString } from '../lib/validate'

type Env = {
  DB: D1Database
  SESSION_SECRET: string
  PHOTOS: R2Bucket
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string // JWK JSON string
  VAPID_SUBJECT?: string
}

type Vars = {
  userId: string
}

const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath('/api')

// Harden JSON responses (nosniff, frame-deny, no-referrer). CSP for the HTML/JS
// lives in public/_headers since those are static assets, not API responses.
app.use('*', secureHeaders())

const SESSION_DAYS = 30
const SESSION_TTL = 60 * 60 * 24 * SESSION_DAYS

// Rate limiting — D1-backed fixed window (pure key/window math in ../lib/ratelimit).
// Works on the free tier with no extra binding. Returns true if allowed.
async function rateLimit(
  c: any,
  route: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  const key = rateLimitKey(route, ip)
  const start = windowStart(Math.floor(Date.now() / 1000), windowSec)
  // Upsert: start a fresh window when the stored one is stale, else increment.
  const res = await c.env.DB.prepare(
    `insert into rate_limits (key, count, window_start) values (?, 1, ?)
     on conflict(key) do update set
       count = case when rate_limits.window_start = excluded.window_start then rate_limits.count + 1 else 1 end,
       window_start = excluded.window_start
     returning count`,
  )
    .bind(key, start)
    .first()
  return ((res as any)?.count ?? 1) <= limit
}

// Sessions — a JWT signed with env.SESSION_SECRET, delivered as an HttpOnly +
// Secure + SameSite cookie (and returned in the body for Bearer clients).
// The token carries the user's session_epoch; bumping it (password change,
// account close) invalidates every previously-issued token.
async function issueSession(c: any, userId: string, epoch = 0): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL
  const token = await sign({ sub: userId, epoch, exp }, c.env.SESSION_SECRET, 'HS256')
  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL,
  })
  return token
}

/* ------------------------------------------------------------------ *
 * Web Push — best-effort fan-out to a user's subscriptions. Never throws to
 * the caller; prunes dead subscriptions on 404/410. No-op if VAPID is unset.
 * ------------------------------------------------------------------ */
async function notifyUser(
  c: any,
  userId: string,
  payload: any,
  delivery: PushDeliveryOptions = {},
): Promise<void> {
  const pub = c.env.VAPID_PUBLIC_KEY
  const priv = c.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return
  let privateJwk: JsonWebKey
  try {
    privateJwk = JSON.parse(priv)
  } catch {
    return
  }
  const subs = await c.env.DB.prepare(
    'select endpoint, p256dh, auth from push_subscriptions where user_id = ?',
  )
    .bind(userId)
    .all()
  const body = JSON.stringify(payload)
  const subject = c.env.VAPID_SUBJECT || 'mailto:podnet@example.com'
  await Promise.all(
    (subs.results as any[]).map(async (s) => {
      try {
        const res = await sendWebPush(s, body, { publicKey: pub, privateJwk, subject }, delivery)
        if (res.status === 404 || res.status === 410) {
          await c.env.DB.prepare('delete from push_subscriptions where endpoint = ?')
            .bind(s.endpoint)
            .run()
        }
      } catch {
        // best-effort — a failed push must never affect the gig flow
      }
    }),
  )
}

// Run a background task without blocking the response (no-op-safe in tests).
function fireAndForget(c: any, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise)
  } catch {
    // no execution context (e.g. unit tests) — let it run detached
    void promise
  }
}

// Reputation accrues to the person a review is ABOUT, and only when the review
// reaches PUBLISHED (never while it's held in resolution).
function accrueRatingStmt(db: D1Database, subjectId: string, stars: number) {
  return db
    .prepare(
      `update users set rating_sum = rating_sum + ?, rating_count = rating_count + 1 where id = ?`,
    )
    .bind(stars, subjectId)
}

// Pages has no cron, so held reviews publish lazily: any read path that surfaces
// reputation sweeps RESOLVING reviews whose 7-day deadline has passed and
// publishes them at their committed score (accruing the rating then). This is
// the terminal state that stops a held review from being a silent veto.
async function publishExpiredReviews(db: D1Database): Promise<void> {
  const due = await db
    .prepare(
      `select id, subject_id, stars from reviews
        where status = 'RESOLVING' and resolve_deadline is not null
          and resolve_deadline <= ?`,
    )
    .bind(new Date().toISOString())
    .all()
  const rows = due.results as any[]
  if (!rows.length) return
  const stmts = []
  for (const r of rows) {
    stmts.push(db.prepare(`update reviews set status = 'PUBLISHED' where id = ?`).bind(r.id))
    stmts.push(accrueRatingStmt(db, r.subject_id, r.stars))
  }
  await db.batch(stmts)
}

/* ------------------------------------------------------------------ *
 * Auth middleware — reads the token from the HttpOnly cookie or a Bearer
 * header, verifies it, and puts the user id on the context. Applied to
 * every route registered below it (everything except register/login/logout).
 * Centralizing authz here means a route can't silently forget to check.
 * ------------------------------------------------------------------ */
async function auth(c: any, next: any) {
  let token = getCookie(c, 'session')
  if (!token) {
    const header = c.req.header('Authorization')
    if (header?.startsWith('Bearer ')) token = header.slice(7)
  }
  if (!token) return c.json({ error: 'unauthenticated' }, 401)
  let payload: any
  try {
    payload = await verify(token, c.env.SESSION_SECRET, 'HS256')
  } catch {
    return c.json({ error: 'invalid session' }, 401)
  }
  // Reject tokens whose epoch is stale or whose account is gone — this is how a
  // password change / account close logs out every existing session.
  const u: any = await c.env.DB.prepare('select session_epoch, deleted from users where id = ?')
    .bind(payload.sub)
    .first()
  if (!u || u.deleted || (payload.epoch ?? 0) !== u.session_epoch) {
    return c.json({ error: 'session expired' }, 401)
  }
  c.set('userId', payload.sub as string)
  await next()
}

/* ========================== AUTH (public) ========================== */

app.post('/register', async (c) => {
  if (!(await rateLimit(c, 'register', 5, 60))) {
    return c.json({ error: 'too many attempts — try again shortly' }, 429)
  }
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const emailCheck = validateString(body.email, LIMITS.email)
  if (!emailCheck.ok || !emailCheck.value) return c.json({ error: 'valid email required' }, 400)
  const email = emailCheck.value.toLowerCase()
  const password = String(body.password ?? '')
  if (!password) return c.json({ error: 'password required' }, 400)
  if (password.length < 8) return c.json({ error: 'password must be at least 8 characters' }, 400)
  if (password.length > LIMITS.password) return c.json({ error: 'password too long' }, 400)
  const nameCheck = validateString(body.display_name, LIMITS.display_name, { required: false })
  if (!nameCheck.ok) return c.json({ error: 'display_name too long' }, 400)
  const display_name = nameCheck.value

  const existing = await c.env.DB.prepare('select id from users where email = ?')
    .bind(email)
    .first()
  if (existing) return c.json({ error: 'email already registered' }, 409)

  const id = crypto.randomUUID()
  const password_hash = await hashPassword(password)
  try {
    await c.env.DB.prepare(
      'insert into users (id, email, password_hash, display_name) values (?, ?, ?, ?)',
    )
      .bind(id, email, password_hash, display_name)
      .run()
  } catch (e: any) {
    // Two concurrent registrations can both pass the SELECT — the unique
    // constraint is the real guard; surface it as the same 409.
    if (String(e?.message ?? e).includes('UNIQUE')) {
      return c.json({ error: 'email already registered' }, 409)
    }
    throw e
  }

  const token = await issueSession(c, id)
  return c.json({ token, user: { id, email, display_name } }, 201)
})

app.post('/login', async (c) => {
  if (!(await rateLimit(c, 'login', 10, 60))) {
    return c.json({ error: 'too many attempts — try again shortly' }, 429)
  }
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const email = String(body.email ?? '')
    .trim()
    .toLowerCase()
  const password = String(body.password ?? '')
  if (!email || !password) return c.json({ error: 'email and password required' }, 400)

  const user: any = await c.env.DB.prepare(
    'select id, email, password_hash, display_name, session_epoch, deleted from users where email = ?',
  )
    .bind(email)
    .first()
  // Always run the PBKDF2 verify (against a dummy hash when the email is unknown)
  // so response time doesn't reveal whether an account exists.
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH)
  if (!user || user.deleted || !ok) return c.json({ error: 'invalid credentials' }, 401)

  const token = await issueSession(c, user.id, user.session_epoch)
  return c.json({
    token,
    user: { id: user.id, email: user.email, display_name: user.display_name },
  })
})

app.post('/logout', (c) => {
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})

/* ===== Everything below requires a valid session ===== */
app.use('*', auth)

// Current signed-in user (own email is fine to return to oneself).
app.get('/me', async (c) => {
  const userId = c.get('userId')
  const user: any = await c.env.DB.prepare(
    'select id, email, display_name, total_gigs, rating_sum, rating_count, is_admin, business_name, verified from users where id = ?',
  )
    .bind(userId)
    .first()
  if (!user) return c.json({ error: 'not found' }, 404)
  return c.json(user)
})

// Set/update your business name. Changing it clears the verified badge and
// files a verification request for an admin to review.
app.put('/me/business', async (c) => {
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const nameCheck = validateString(b.business_name, LIMITS.business_name, { required: false })
  if (!nameCheck.ok) return c.json({ error: 'business_name too long' }, 400)
  await c.env.DB.prepare('update users set business_name = ?, verified = 0 where id = ?')
    .bind(nameCheck.value, userId)
    .run()
  if (nameCheck.value) {
    await c.env.DB.prepare(
      `insert into reports (id, reporter_id, kind, subject_id, reason) values (?, ?, 'user', ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, userId, `verification request: ${nameCheck.value}`)
      .run()
  }
  return c.json({ ok: true, business_name: nameCheck.value, verified: 0 })
})

// Close account — password-confirmed. Anonymizes the row and bumps session_epoch
// (logs out everywhere) but KEEPS reviews/gigs so the reputation ledger stays
// intact. Deletes push subscriptions. Auth middleware blocks deleted accounts.
app.post('/me/delete', async (c) => {
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const password = String(b.password ?? '')
  const user: any = await c.env.DB.prepare('select password_hash from users where id = ?')
    .bind(userId)
    .first()
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'password is incorrect' }, 403)
  }
  // The user's open gigs must not linger as claimable ghosts. Collect them,
  // notify any worker mid-claim, and drop their R2 photos before deleting.
  const openGigs = await c.env.DB.prepare(
    `select id, task_type, claimed_by from gigs where posted_by = ? and status <> 'COMPLETED'`,
  )
    .bind(userId)
    .all()
  const openIds = (openGigs.results as any[]).map((g) => g.id)
  if (openIds.length > 0) {
    const placeholders = openIds.map(() => '?').join(',')
    const photos = await c.env.DB.prepare(
      `select r2_key from gig_photos where gig_id in (${placeholders})`,
    )
      .bind(...openIds)
      .all()
    for (const ph of photos.results as any[]) {
      try {
        await c.env.PHOTOS.delete(ph.r2_key)
      } catch {
        // best-effort cleanup
      }
    }
    for (const g of openGigs.results as any[]) {
      if (g.claimed_by) {
        fireAndForget(
          c,
          notifyUser(
            c,
            g.claimed_by,
            {
              title: 'Gig cancelled',
              body: `${g.task_type} — the hirer closed their account`,
              url: '/',
            },
            { topic: topicFor(g.id), urgency: 'high' },
          ),
        )
      }
    }
    await c.env.DB.prepare(`delete from gigs where posted_by = ? and status <> 'COMPLETED'`)
      .bind(userId)
      .run()
  }
  // Scramble PII; keep the row so foreign keys (reviews, completed gigs) stay valid.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `update users set deleted = 1, session_epoch = session_epoch + 1,
                email = ?, display_name = 'Deleted user', business_name = null,
                verified = 0, password_hash = ? where id = ?`,
    ).bind(`deleted+${userId}@invalid`, DUMMY_PASSWORD_HASH, userId),
    c.env.DB.prepare('delete from push_subscriptions where user_id = ?').bind(userId),
  ])
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})

// Change password — requires the current password; rate-limited.
app.post('/me/password', async (c) => {
  if (!(await rateLimit(c, 'chpass', 5, 60))) {
    return c.json({ error: 'too many attempts — try again shortly' }, 429)
  }
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const current = String(b.current_password ?? '')
  const next = String(b.new_password ?? '')
  if (!current || !next) return c.json({ error: 'current and new password required' }, 400)
  if (next.length < 8) return c.json({ error: 'new password must be at least 8 characters' }, 400)
  if (next.length > LIMITS.password) return c.json({ error: 'new password too long' }, 400)

  const user: any = await c.env.DB.prepare('select password_hash from users where id = ?')
    .bind(userId)
    .first()
  if (!user || !(await verifyPassword(current, user.password_hash))) {
    return c.json({ error: 'current password is incorrect' }, 403)
  }
  const password_hash = await hashPassword(next)
  // Bump session_epoch → every existing token (incl. a thief's) becomes invalid…
  const row: any = await c.env.DB.prepare(
    'update users set password_hash = ?, session_epoch = session_epoch + 1 where id = ? returning session_epoch',
  )
    .bind(password_hash, userId)
    .first()
  // …then re-issue a fresh session for THIS device so the user stays logged in here.
  await issueSession(c, userId, row.session_epoch)
  return c.json({ ok: true })
})

/* ============================== GIGS =============================== */

// Nearby AVAILABLE gigs: SQL bounding-box prefilter, JS Haversine refine + sort.
app.get('/gigs/near', async (c) => {
  const lat = Number.parseFloat(c.req.query('lat') ?? '')
  const lng = Number.parseFloat(c.req.query('lng') ?? '')
  const radius = Number.parseFloat(c.req.query('radius') ?? '5')
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: 'lat and lng required' }, 400)
  }
  const r = Number.isFinite(radius) && radius > 0 ? radius : 5

  const { latDelta, lngDelta } = bboxDeltas(lat, r)

  const rows = await c.env.DB.prepare(
    `select g.id, g.status, g.task_type, g.neighborhood, g.cash_payout, g.est_hours,
            g.lat, g.lng, g.description, g.posted_by, g.from_post_id, g.created_at,
            g.window_start, g.window_end, g.notice_hours,
            u.display_name as poster_name, u.verified as poster_verified
       from gigs g
       join users u on u.id = g.posted_by
      where g.status = 'AVAILABLE'
        and g.lat between ? and ?
        and g.lng between ? and ?
        -- hide gigs whose scheduling window has already closed (unclaimable)
        and (g.window_end is null or g.window_end > ?)`,
  )
    .bind(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta, new Date().toISOString())
    .all()

  const blocked = await blockedSet(c.env.DB, c.get('userId'))
  const near = (rows.results as any[])
    .filter((g) => !blocked.has(g.posted_by))
    .map((g) => ({ ...g, distance_mi: haversineMiles(lat, lng, g.lat, g.lng) }))
    .filter((g) => g.distance_mi <= r)
    .sort((a, b) => a.distance_mi - b.distance_mi)

  return c.json(near)
})

// Gigs posted by, or claimed by, the signed-in user (for the Me view).
// NOTE: must be registered BEFORE '/gigs/:id', or ':id' captures "mine".
app.get('/gigs/mine', async (c) => {
  const userId = c.get('userId')
  const posted = await c.env.DB.prepare(
    `select g.*, wp.display_name as worker_name,
            (select count(*) from gig_messages m where m.gig_id = g.id) as message_count
       from gigs g left join users wp on wp.id = g.claimed_by
      where g.posted_by = ? order by g.created_at desc limit 200`,
  )
    .bind(userId)
    .all()
  const claimed = await c.env.DB.prepare(
    `select g.*, hp.display_name as poster_name,
            (select count(*) from gig_messages m where m.gig_id = g.id) as message_count,
            (select count(*) from reviews r where r.gig_id = g.id and r.author_id = ?) as reviewed_by_me
       from gigs g join users hp on hp.id = g.posted_by
      where g.claimed_by = ? order by g.created_at desc limit 200`,
  )
    .bind(userId, userId)
    .all()
  // Attach photos to the gigs you posted (shown on your profile).
  const postedRows = posted.results as any[]
  const photos = await loadPhotosByGig(
    c.env.DB,
    postedRows.map((g) => g.id),
  )
  for (const g of postedRows) g.photos = photos.get(g.id) ?? []
  return c.json({ posted: postedRows, claimed: claimed.results })
})

// Single gig (with poster + worker names) — useful for the detail sheet / Me view.
app.get('/gigs/:id', async (c) => {
  const gig: any = await c.env.DB.prepare(
    `select g.*, hp.display_name as poster_name, wp.display_name as worker_name
       from gigs g
       join users hp on hp.id = g.posted_by
       left join users wp on wp.id = g.claimed_by
      where g.id = ?`,
  )
    .bind(c.req.param('id'))
    .first()
  if (!gig) return c.json({ error: 'not found' }, 404)
  // Parties of the gig always see it; otherwise blocking hides it like the feed.
  const viewer = c.get('userId')
  if (
    gig.posted_by !== viewer &&
    gig.claimed_by !== viewer &&
    (await isBlockedBetween(c.env.DB, viewer, gig.posted_by))
  ) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json(gig)
})

// Create a gig — posted_by = session user.
app.post('/gigs', async (c) => {
  if (!(await rateLimit(c, 'gig-create', 15, 300))) {
    return c.json({ error: 'too many gigs — slow down' }, 429)
  }
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const parsed = parseGigInput(b)
  if (!parsed.ok) return c.json({ error: parsed.reason }, 400)
  const g = parsed.gig
  const from_post_id = b.from_post_id ? String(b.from_post_id) : null

  // from_post_id carries a FK — verify it up front so a stale/bogus id is a
  // clean 400 instead of a constraint failure. The row also feeds the
  // became-a-gig notification below.
  let origin: any = null
  if (from_post_id) {
    origin = await c.env.DB.prepare('select author_id from posts where id = ?')
      .bind(from_post_id)
      .first()
    if (!origin) return c.json({ error: 'the board post this gig came from no longer exists' }, 400)
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `insert into gigs (id, task_type, neighborhood, cash_payout, est_hours, lat, lng, description, posted_by, from_post_id, window_start, window_end, notice_hours)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      g.task_type,
      g.neighborhood,
      g.cash_payout,
      g.est_hours,
      g.lat,
      g.lng,
      g.description,
      userId,
      from_post_id,
      g.window_start,
      g.window_end,
      g.notice_hours,
    )
    .run()
  // Best-effort: if this gig grew out of a board post, tell the post author.
  if (from_post_id && origin) {
    if (origin.author_id !== userId) {
      fireAndForget(
        c,
        notifyUser(
          c,
          origin.author_id,
          {
            title: 'Your post became a gig',
            body: `${g.task_type} — ${g.cash_payout} offered`,
            url: '/',
          },
          { topic: topicFor(from_post_id), urgency: 'normal' },
        ),
      )
    }
  }
  return c.json({ id }, 201)
})

// Claim — atomic single statement; 0 changes means already claimed or your own.
// Windowed gigs require the worker to pick a slot inside the hirer's window,
// at least notice_hours in the future; the slot is stored on the gig.
app.post('/gigs/:id/claim', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  let slotInput: unknown = null
  try {
    const b = await c.req.json()
    slotInput = b?.scheduled_at ?? null
  } catch {
    // no body — fine for windowless gigs
  }

  const pre: any = await c.env.DB.prepare(
    'select posted_by, window_start, window_end, notice_hours from gigs where id = ?',
  )
    .bind(id)
    .first()
  if (!pre) return c.json({ error: 'not found' }, 404)
  // Either party having blocked the other prevents the claim.
  const blocked = await blockedSet(c.env.DB, userId)
  if (blocked.has(pre.posted_by)) return c.json({ error: 'gig is unavailable or your own' }, 409)
  const slot = validateSlot(slotInput, pre.window_start, pre.window_end, pre.notice_hours ?? 0)
  if (!slot.ok) return c.json({ error: slot.reason }, 400)

  const res = await c.env.DB.prepare(
    `update gigs set status = 'CLAIMED', claimed_by = ?, scheduled_at = ?
      where id = ? and status = 'AVAILABLE' and posted_by <> ?`,
  )
    .bind(userId, slot.scheduled_at, id, userId)
    .run()
  if (res.meta.changes !== 1) {
    return c.json({ error: 'gig is unavailable or your own' }, 409)
  }
  // Best-effort: tell the poster their gig was claimed (and for when).
  const g: any = await c.env.DB.prepare('select posted_by, task_type from gigs where id = ?')
    .bind(id)
    .first()
  if (g) {
    const when = slot.scheduled_at ? ` for ${new Date(slot.scheduled_at).toLocaleString()}` : ''
    fireAndForget(
      c,
      notifyUser(
        c,
        g.posted_by,
        {
          title: 'Your gig was claimed',
          body: `${g.task_type} — someone is on it${when}`,
          url: '/',
        },
        { topic: topicFor(id), urgency: 'high' },
      ),
    )
  }
  return c.json({ ok: true, scheduled_at: slot.scheduled_at })
})

// Complete + review — only the poster, only when CLAIMED, rating 1..5.
// Atomic batch: mark COMPLETED, insert review, bump the worker's reputation.
app.post('/gigs/:id/complete', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const rating = Number(b.rating)
  const reviewCheck = validateString(b.review, LIMITS.review_body, { required: false })
  if (!reviewCheck.ok) return c.json({ error: 'review too long' }, 400)
  const review = reviewCheck.value
  if (!isValidRating(rating)) {
    return c.json({ error: 'rating must be an integer 1-5' }, 400)
  }

  const gig: any = await c.env.DB.prepare('select * from gigs where id = ?').bind(id).first()
  if (!gig) return c.json({ error: 'not found' }, 404)
  if (gig.posted_by !== userId)
    return c.json({ error: 'only the poster can complete this gig' }, 403)
  if (gig.status !== 'CLAIMED') return c.json({ error: 'gig is not in a claimed state' }, 409)

  // Completion always pays/closes the gig and credits the worker's gig count;
  // the review's visibility, though, follows the restorative state machine.
  const plan = planReview(rating)
  const reviewId = crypto.randomUUID()
  const stmts = [
    c.env.DB.prepare(`update gigs set status = 'COMPLETED' where id = ?`).bind(id),
    c.env.DB.prepare(
      `insert into reviews (id, gig_id, worker_id, hirer_id, author_id, subject_id, stars, body, status, resolve_deadline)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      reviewId,
      id,
      gig.claimed_by,
      userId,
      userId,
      gig.claimed_by,
      rating,
      review,
      plan.status,
      plan.resolve_deadline,
    ),
    c.env.DB.prepare(`update users set total_gigs = total_gigs + 1 where id = ?`).bind(
      gig.claimed_by,
    ),
  ]
  // Reputation only moves when the review is public; a held review accrues on
  // resolution or at its deadline instead.
  if (plan.status === 'PUBLISHED') stmts.push(accrueRatingStmt(c.env.DB, gig.claimed_by, rating))
  await c.env.DB.batch(stmts)

  fireAndForget(
    c,
    notifyUser(
      c,
      gig.claimed_by,
      plan.status === 'PUBLISHED'
        ? {
            title: `You were rated ${rating}★`,
            body: `${gig.task_type} — paid ${gig.cash_payout}`,
            url: '/',
          }
        : {
            title: 'A review is open for discussion',
            body: `${gig.task_type} — paid ${gig.cash_payout}. Tap to talk it through.`,
            url: '/',
          },
      { topic: topicFor(id), urgency: 'high' },
    ),
  )
  return c.json({ ok: true, review_status: plan.status })
})

// The WORKER reviews the HIRER — the other half of two-sided accountability.
// Allowed once the worker has marked the work done (so a hirer who ghosts
// without paying can still be reviewed) or after the gig is completed. Same
// restorative state machine as the hirer's review.
app.post('/gigs/:id/review', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const rating = Number(b.rating)
  const reviewCheck = validateString(b.review, LIMITS.review_body, { required: false })
  if (!reviewCheck.ok) return c.json({ error: 'review too long' }, 400)
  if (!isValidRating(rating)) return c.json({ error: 'rating must be an integer 1-5' }, 400)

  const gig: any = await c.env.DB.prepare('select * from gigs where id = ?').bind(id).first()
  if (!gig) return c.json({ error: 'not found' }, 404)
  if (gig.claimed_by !== userId)
    return c.json({ error: 'only the worker can review the hirer' }, 403)
  if (!gig.done_at && gig.status !== 'COMPLETED') {
    return c.json({ error: 'review the hirer after marking the work done' }, 409)
  }
  const existing = await c.env.DB.prepare(
    `select 1 from reviews where gig_id = ? and author_id = ?`,
  )
    .bind(id, userId)
    .first()
  if (existing) return c.json({ error: 'you already reviewed this gig' }, 409)

  const plan = planReview(rating)
  const reviewId = crypto.randomUUID()
  const stmts = [
    c.env.DB.prepare(
      `insert into reviews (id, gig_id, worker_id, hirer_id, author_id, subject_id, stars, body, status, resolve_deadline)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      reviewId,
      id,
      gig.claimed_by,
      gig.posted_by,
      userId,
      gig.posted_by,
      rating,
      reviewCheck.value,
      plan.status,
      plan.resolve_deadline,
    ),
  ]
  if (plan.status === 'PUBLISHED') stmts.push(accrueRatingStmt(c.env.DB, gig.posted_by, rating))
  await c.env.DB.batch(stmts)

  fireAndForget(
    c,
    notifyUser(
      c,
      gig.posted_by,
      plan.status === 'PUBLISHED'
        ? { title: `A worker rated you ${rating}★`, body: gig.task_type, url: '/' }
        : {
            title: 'A review is open for discussion',
            body: `${gig.task_type} — tap to talk it through.`,
            url: '/',
          },
      { topic: topicFor(id), urgency: 'normal' },
    ),
  )
  return c.json({ ok: true, review_status: plan.status }, 201)
})

// Resolution surfaces for the signed-in user:
//  - authored: my held reviews, each with the counterpart's review IF it's 4-5
//    (the empathy nudge — "they thought well of you, sure you want to go low?").
//  - about_me: held reviews about me — the written feedback to act on, but NOT
//    the star number (resolution is about the substance, not the score).
app.get('/reviews/resolving', async (c) => {
  const userId = c.get('userId')
  await publishExpiredReviews(c.env.DB)
  const authoredRes = await c.env.DB.prepare(
    `select r.id, r.gig_id, r.subject_id, r.stars, r.body, r.responded, r.resolve_deadline,
            g.task_type, su.display_name as subject_name
       from reviews r join gigs g on g.id = r.gig_id
       join users su on su.id = r.subject_id
      where r.author_id = ? and r.status = 'RESOLVING'
      order by r.created_at desc`,
  )
    .bind(userId)
    .all()
  const authored = authoredRes.results as any[]
  for (const r of authored) {
    const counter: any = await c.env.DB.prepare(
      `select stars, body from reviews where gig_id = ? and author_id = ? and stars >= 4`,
    )
      .bind(r.gig_id, r.subject_id)
      .first()
    r.counterpart = counter ? { stars: counter.stars, body: counter.body } : null
  }
  const aboutRes = await c.env.DB.prepare(
    `select r.id, r.gig_id, r.body, r.resolve_deadline,
            g.task_type, au.display_name as author_name
       from reviews r join gigs g on g.id = r.gig_id
       join users au on au.id = r.author_id
      where r.subject_id = ? and r.status = 'RESOLVING'
      order by r.created_at desc`,
  )
    .bind(userId)
    .all()
  return c.json({ authored, about_me: aboutRes.results })
})

// Author raises a held review (ceiling-of-harm: up only). If it clears the hold
// threshold it publishes and accrues; otherwise it stays in resolution.
app.post('/reviews/:id/revise', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const review: any = await c.env.DB.prepare(
    `select id, author_id, subject_id, stars, status from reviews where id = ?`,
  )
    .bind(id)
    .first()
  if (!review || review.author_id !== userId) return c.json({ error: 'not found' }, 404)
  if (review.status !== 'RESOLVING') return c.json({ error: 'review is not in resolution' }, 409)
  const plan = planRevision(review.stars, Number(b.rating))
  if (!plan.ok) return c.json({ error: plan.reason }, 400)
  const stmts = [
    c.env.DB.prepare(`update reviews set stars = ?, status = ? where id = ?`).bind(
      plan.stars,
      plan.status,
      id,
    ),
  ]
  if (plan.status === 'PUBLISHED')
    stmts.push(accrueRatingStmt(c.env.DB, review.subject_id, plan.stars))
  await c.env.DB.batch(stmts)
  return c.json({ ok: true, review_status: plan.status })
})

// Author withdraws a held review entirely (no score, nothing published).
app.post('/reviews/:id/withdraw', async (c) => {
  const userId = c.get('userId')
  const res = await c.env.DB.prepare(
    `delete from reviews where id = ? and author_id = ? and status = 'RESOLVING'`,
  )
    .bind(c.req.param('id'), userId)
    .run()
  if (res.meta.changes < 1) return c.json({ error: 'not found or not in resolution' }, 404)
  return c.json({ ok: true })
})

// Subject acknowledges a held review — records that they engaged (so a review
// that auto-publishes unanswered is distinguishable from one that was discussed).
app.post('/reviews/:id/acknowledge', async (c) => {
  const userId = c.get('userId')
  const res = await c.env.DB.prepare(
    `update reviews set responded = 1 where id = ? and subject_id = ? and status = 'RESOLVING'`,
  )
    .bind(c.req.param('id'), userId)
    .run()
  if (res.meta.changes < 1) return c.json({ error: 'not found or not in resolution' }, 404)
  return c.json({ ok: true })
})

// The resolution thread — a private channel between a held review's author and
// subject, the place the improvement conversation actually happens. Loaded by
// either party; readable while the review exists (so they can see how it was
// settled). Unlike gig messages it is NOT sealed by a block: it is bounded to
// one held review and is the constructive path, not open DMs.
async function reviewForThread(
  db: D1Database,
  reviewId: string,
  userId: string,
): Promise<any | null> {
  const r: any = await db
    .prepare('select id, author_id, subject_id, status from reviews where id = ?')
    .bind(reviewId)
    .first()
  if (!r || (r.author_id !== userId && r.subject_id !== userId)) return null
  return r
}

app.get('/reviews/:id/messages', async (c) => {
  const userId = c.get('userId')
  const review = await reviewForThread(c.env.DB, c.req.param('id'), userId)
  if (!review) return c.json({ error: 'not found' }, 404)
  const rows = await c.env.DB.prepare(
    `select m.id, m.sender_id, m.body, m.created_at, u.display_name as sender_name
       from review_messages m join users u on u.id = m.sender_id
      where m.review_id = ? order by m.created_at asc limit 200`,
  )
    .bind(review.id)
    .all()
  return c.json(rows.results)
})

app.post('/reviews/:id/messages', async (c) => {
  if (!(await rateLimit(c, 'review-msg', 60, 300))) {
    return c.json({ error: 'too many messages — slow down' }, 429)
  }
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const bodyCheck = validateString(b.body, LIMITS.message_body)
  if (!bodyCheck.ok) return c.json({ error: 'message must be 1-1000 chars' }, 400)
  const review = await reviewForThread(c.env.DB, c.req.param('id'), userId)
  if (!review) return c.json({ error: 'not found' }, 404)
  if (review.status !== 'RESOLVING') {
    return c.json({ error: 'this review is no longer in resolution' }, 409)
  }
  const stmts = [
    c.env.DB.prepare(
      `insert into review_messages (id, review_id, sender_id, body) values (?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), review.id, userId, bodyCheck.value),
  ]
  // The subject participating IS engagement — fold acknowledgement into it.
  if (review.subject_id === userId && !review.responded) {
    stmts.push(c.env.DB.prepare(`update reviews set responded = 1 where id = ?`).bind(review.id))
  }
  await c.env.DB.batch(stmts)
  const other = review.author_id === userId ? review.subject_id : review.author_id
  fireAndForget(
    c,
    notifyUser(
      c,
      other,
      { title: 'New message about a review', body: 'Tap to continue the conversation.', url: '/' },
      { topic: topicFor(review.id), urgency: 'normal' },
    ),
  )
  return c.json({ ok: true }, 201)
})

// Edit your own gig — only while AVAILABLE (can't change a gig someone's working).
app.put('/gigs/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const parsed = parseGigInput(b)
  if (!parsed.ok) return c.json({ error: parsed.reason }, 400)
  const g = parsed.gig
  const res = await c.env.DB.prepare(
    `update gigs set task_type = ?, neighborhood = ?, description = ?, cash_payout = ?, est_hours = ?, lat = ?, lng = ?,
            window_start = ?, window_end = ?, notice_hours = ?
      where id = ? and posted_by = ? and status = 'AVAILABLE'`,
  )
    .bind(
      g.task_type,
      g.neighborhood,
      g.description,
      g.cash_payout,
      g.est_hours,
      g.lat,
      g.lng,
      g.window_start,
      g.window_end,
      g.notice_hours,
      id,
      userId,
    )
    .run()
  if (res.meta.changes !== 1) {
    return c.json({ error: 'not found, not yours, or no longer editable' }, 403)
  }
  return c.json({ ok: true })
})

// Delete your own gig — not once COMPLETED (keeps reviews/reputation honest).
// The row cascade removes gig_photos rows; the R2 objects need explicit cleanup
// (same pattern as account deletion) or they'd be orphaned in the bucket.
app.delete('/gigs/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const photos = await c.env.DB.prepare(
    `select p.r2_key from gig_photos p join gigs g on g.id = p.gig_id
      where g.id = ? and g.posted_by = ? and g.status <> 'COMPLETED'`,
  )
    .bind(id, userId)
    .all()
  const res = await c.env.DB.prepare(
    `delete from gigs where id = ? and posted_by = ? and status <> 'COMPLETED'`,
  )
    .bind(id, userId)
    .run()
  if (res.meta.changes < 1) {
    return c.json({ error: 'not found, not yours, or already completed' }, 403)
  }
  for (const ph of photos.results as any[]) {
    try {
      await c.env.PHOTOS.delete(ph.r2_key)
    } catch {
      // best-effort cleanup
    }
  }
  return c.json({ ok: true })
})

// Abandon a claim — the worker steps back; the gig returns to AVAILABLE.
// Only the current claimer, only while CLAIMED.
app.post('/gigs/:id/abandon', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const res = await c.env.DB.prepare(
    `update gigs set status = 'AVAILABLE', claimed_by = null, scheduled_at = null, done_at = null
      where id = ? and status = 'CLAIMED' and claimed_by = ?`,
  )
    .bind(id, userId)
    .run()
  if (res.meta.changes !== 1) {
    return c.json({ error: 'not your claimed gig' }, 403)
  }
  // Best-effort: tell the poster their gig is back on the market.
  const g: any = await c.env.DB.prepare('select posted_by, task_type from gigs where id = ?')
    .bind(id)
    .first()
  if (g) {
    fireAndForget(
      c,
      notifyUser(
        c,
        g.posted_by,
        {
          title: 'Worker released your gig',
          body: `${g.task_type} — it's available again`,
          url: '/',
        },
        { topic: topicFor(id), urgency: 'high' },
      ),
    )
  }
  return c.json({ ok: true })
})

// Unclaim — the HIRER removes a no-show worker (CLAIMED→AVAILABLE). Mirror of
// abandon but keyed on posted_by; notifies the dropped worker.
app.post('/gigs/:id/unclaim', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const before: any = await c.env.DB.prepare('select claimed_by, task_type from gigs where id = ?')
    .bind(id)
    .first()
  if (!before?.claimed_by) return c.json({ error: 'not your claimed gig' }, 403)
  // Pin claimed_by so a concurrent abandon+re-claim can't make us drop (and
  // notify) the wrong worker — the update only fires for the worker we read.
  const res = await c.env.DB.prepare(
    `update gigs set status = 'AVAILABLE', claimed_by = null, scheduled_at = null, done_at = null
      where id = ? and status = 'CLAIMED' and posted_by = ? and claimed_by = ?`,
  )
    .bind(id, userId, before.claimed_by)
    .run()
  if (res.meta.changes !== 1) {
    return c.json({ error: 'not your claimed gig' }, 403)
  }
  if (before?.claimed_by) {
    fireAndForget(
      c,
      notifyUser(
        c,
        before.claimed_by,
        {
          title: 'A gig was unassigned',
          body: `${before.task_type} — the hirer reopened it`,
          url: '/',
        },
        { topic: topicFor(id), urgency: 'high' },
      ),
    )
  }
  return c.json({ ok: true })
})

// Mark done — the WORKER signals the work is finished; the hirer then reviews+pays.
// Advisory only (sets done_at); completion still requires the hirer.
app.post('/gigs/:id/done', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const res = await c.env.DB.prepare(
    `update gigs set done_at = datetime('now')
      where id = ? and status = 'CLAIMED' and claimed_by = ?`,
  )
    .bind(id, userId)
    .run()
  if (res.meta.changes !== 1) {
    return c.json({ error: 'not your claimed gig' }, 403)
  }
  const g: any = await c.env.DB.prepare('select posted_by, task_type from gigs where id = ?')
    .bind(id)
    .first()
  if (g) {
    fireAndForget(
      c,
      notifyUser(
        c,
        g.posted_by,
        {
          title: 'Work marked done',
          body: `${g.task_type} — review & pay`,
          url: '/',
        },
        { topic: topicFor(id), urgency: 'high' },
      ),
    )
  }
  return c.json({ ok: true })
})

/* ============================= MESSAGES ============================ */
// Private per-gig thread between the hirer and the worker — the coordination
// channel (directions, gate codes, timing changes). Not open DMs: the thread
// exists only between the two parties of a claimed gig.

async function gigParties(db: D1Database, gigId: string): Promise<any | null> {
  return db
    .prepare('select id, posted_by, claimed_by, status, task_type from gigs where id = ?')
    .bind(gigId)
    .first()
}

app.get('/gigs/:id/messages', async (c) => {
  const userId = c.get('userId')
  const gig: any = await gigParties(c.env.DB, c.req.param('id'))
  if (!gig) return c.json({ error: 'not found' }, 404)
  if (gig.posted_by !== userId && gig.claimed_by !== userId) {
    return c.json({ error: 'only the hirer and worker can read this thread' }, 403)
  }
  const other = gig.posted_by === userId ? gig.claimed_by : gig.posted_by
  if (other && (await isBlockedBetween(c.env.DB, userId, other))) {
    return c.json({ error: 'messaging unavailable' }, 403)
  }
  const rows = await c.env.DB.prepare(
    `select m.id, m.sender_id, m.body, m.created_at, u.display_name as sender_name
       from gig_messages m join users u on u.id = m.sender_id
      where m.gig_id = ? order by m.created_at asc`,
  )
    .bind(gig.id)
    .all()
  return c.json(rows.results)
})

app.post('/gigs/:id/messages', async (c) => {
  if (!(await rateLimit(c, 'message-send', 60, 300))) {
    return c.json({ error: 'too many messages — slow down' }, 429)
  }
  const userId = c.get('userId')
  const gig: any = await gigParties(c.env.DB, c.req.param('id'))
  if (!gig) return c.json({ error: 'not found' }, 404)
  if (gig.posted_by !== userId && gig.claimed_by !== userId) {
    return c.json({ error: 'only the hirer and worker can message here' }, 403)
  }
  if (!gig.claimed_by) {
    return c.json({ error: 'messaging opens once the gig is claimed' }, 409)
  }
  {
    const other = gig.posted_by === userId ? gig.claimed_by : gig.posted_by
    if (await isBlockedBetween(c.env.DB, userId, other)) {
      return c.json({ error: 'messaging unavailable' }, 403)
    }
  }
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const bodyCheck = validateString(b.body, LIMITS.message_body)
  if (!bodyCheck.ok || !bodyCheck.value)
    return c.json({ error: 'message required (within length limit)' }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    'insert into gig_messages (id, gig_id, sender_id, body) values (?, ?, ?, ?)',
  )
    .bind(id, gig.id, userId, bodyCheck.value)
    .run()
  // Best-effort: ping the other party; bursts collapse per gig.
  const other = gig.posted_by === userId ? gig.claimed_by : gig.posted_by
  fireAndForget(
    c,
    notifyUser(
      c,
      other,
      { title: `Message · ${gig.task_type}`, body: bodyCheck.value.slice(0, 80), url: '/' },
      { topic: topicFor(gig.id), urgency: 'high' },
    ),
  )
  return c.json({ id }, 201)
})

/* ============================== PHOTOS ============================= */

// Load photos for a set of gigs → Map<gigId, [{id, key}]>.
async function loadPhotosByGig(db: D1Database, gigIds: string[]): Promise<Map<string, any[]>> {
  const map = new Map<string, any[]>()
  if (gigIds.length === 0) return map
  const placeholders = gigIds.map(() => '?').join(',')
  const rows = await db
    .prepare(
      `select id, gig_id, r2_key from gig_photos where gig_id in (${placeholders}) order by created_at asc`,
    )
    .bind(...gigIds)
    .all()
  for (const p of rows.results as any[]) {
    const list = map.get(p.gig_id) ?? []
    list.push({ id: p.id, key: p.r2_key })
    map.set(p.gig_id, list)
  }
  return map
}

// Upload a photo of the finished work — hirer only, while CLAIMED or COMPLETED.
app.post('/gigs/:id/photos', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const gig: any = await c.env.DB.prepare('select posted_by, status from gigs where id = ?')
    .bind(id)
    .first()
  if (!gig) return c.json({ error: 'not found' }, 404)
  if (gig.posted_by !== userId) return c.json({ error: 'only the hirer can add photos' }, 403)
  if (gig.status !== 'CLAIMED' && gig.status !== 'COMPLETED') {
    return c.json({ error: 'photos can be added once the gig is claimed' }, 409)
  }

  const contentType = c.req.header('content-type')
  const buf = await c.req.arrayBuffer()
  const check = checkImageUpload(contentType, buf.byteLength)
  if (!check.ok) return c.json({ error: check.reason }, 400)

  const countRow: any = await c.env.DB.prepare(
    'select count(*) as n from gig_photos where gig_id = ?',
  )
    .bind(id)
    .first()
  if ((countRow?.n ?? 0) >= MAX_PHOTOS_PER_GIG) {
    return c.json({ error: `at most ${MAX_PHOTOS_PER_GIG} photos per gig` }, 409)
  }

  const photoId = crypto.randomUUID()
  const key = photoKey(id, photoId, contentType as string)
  await c.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: contentType as string } })
  await c.env.DB.prepare(
    'insert into gig_photos (id, gig_id, uploader_id, r2_key) values (?, ?, ?, ?)',
  )
    .bind(photoId, id, userId, key)
    .run()
  return c.json({ id: photoId, key }, 201)
})

// Remove a photo — the hirer who owns the gig.
app.delete('/gigs/:id/photos/:photoId', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const photoId = c.req.param('photoId')
  const row: any = await c.env.DB.prepare(
    `select p.r2_key from gig_photos p join gigs g on g.id = p.gig_id
      where p.id = ? and p.gig_id = ? and g.posted_by = ?`,
  )
    .bind(photoId, id, userId)
    .first()
  if (!row) return c.json({ error: 'not found or not yours' }, 403)
  await c.env.PHOTOS.delete(row.r2_key)
  await c.env.DB.prepare('delete from gig_photos where id = ?').bind(photoId).run()
  return c.json({ ok: true })
})

// Serve an image from R2. Behind auth (same-origin <img> sends the cookie).
// The key is a wildcard so it can contain slashes (gigs/<id>/<uuid>.<ext>).
app.get('/img/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.json({ error: 'not found' }, 404)
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  headers.set('etag', obj.httpEtag)
  return new Response(obj.body, { headers })
})

/* ============================== BOARD ============================== */

app.get('/posts', async (c) => {
  const userId = c.get('userId')
  // Keyset pagination: ?before=<created_at>&limit (newest first).
  const limit = clampLimit(c.req.query('limit'))
  const before = parseBefore(c.req.query('before'))
  const rows = await c.env.DB.prepare(
    `select p.id, p.author_id, p.body, p.area_label, p.lat, p.lng, p.created_at,
            u.display_name as author_name, u.verified as author_verified,
            (select count(*) from post_comments pc where pc.post_id = p.id) as comment_count,
            (select count(*) from post_interest pi where pi.post_id = p.id) as interest_count,
            (select count(*) from gigs g where g.from_post_id = p.id) as gig_count,
            exists(select 1 from post_interest pi where pi.post_id = p.id and pi.user_id = ?) as i_am_interested
       from posts p
       join users u on u.id = p.author_id
      where (? is null or p.created_at < ?)
      order by p.created_at desc
      limit ?`,
  )
    .bind(userId, before, before, limit)
    .all()
  const blocked = await blockedSet(c.env.DB, userId)
  return c.json((rows.results as any[]).filter((p) => !blocked.has(p.author_id)))
})

app.post('/posts', async (c) => {
  if (!(await rateLimit(c, 'post-create', 15, 300))) {
    return c.json({ error: 'too many posts — slow down' }, 429)
  }
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const bodyCheck = validateString(b.body, LIMITS.post_body)
  const areaCheck = validateString(b.area_label, LIMITS.area_label, { required: false })
  if (!bodyCheck.ok || !bodyCheck.value)
    return c.json({ error: 'body required (within length limit)' }, 400)
  if (!areaCheck.ok) return c.json({ error: 'area_label too long' }, 400)
  const body = bodyCheck.value
  const area_label = areaCheck.value
  const lat = b.lat != null && Number.isFinite(Number(b.lat)) ? Number(b.lat) : null
  const lng = b.lng != null && Number.isFinite(Number(b.lng)) ? Number(b.lng) : null

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `insert into posts (id, author_id, body, area_label, lat, lng) values (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, body, area_label, lat, lng)
    .run()
  return c.json({ id }, 201)
})

// Single post with its comments (for the expanded card).
app.get('/posts/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const post: any = await c.env.DB.prepare(
    `select p.id, p.author_id, p.body, p.area_label, p.lat, p.lng, p.created_at,
            u.display_name as author_name, u.verified as author_verified,
            (select count(*) from post_interest pi where pi.post_id = p.id) as interest_count,
            (select count(*) from gigs g where g.from_post_id = p.id) as gig_count,
            exists(select 1 from post_interest pi where pi.post_id = p.id and pi.user_id = ?) as i_am_interested
       from posts p join users u on u.id = p.author_id
      where p.id = ?`,
  )
    .bind(userId, id)
    .first()
  if (!post) return c.json({ error: 'not found' }, 404)
  // Direct links don't bypass blocking: a blocked author's post reads as gone,
  // and comments from blocked users are filtered out of visible threads.
  const blocked = await blockedSet(c.env.DB, userId)
  if (blocked.has(post.author_id)) return c.json({ error: 'not found' }, 404)
  const comments = await c.env.DB.prepare(
    `select pc.id, pc.post_id, pc.author_id, pc.body, pc.created_at, u.display_name as author_name, u.verified as author_verified
       from post_comments pc join users u on u.id = pc.author_id
      where pc.post_id = ? order by pc.created_at asc`,
  )
    .bind(id)
    .all()
  return c.json({
    ...post,
    comments: (comments.results as any[]).filter((cm) => !blocked.has(cm.author_id)),
  })
})

// Edit own post.
app.put('/posts/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const bodyCheck = validateString(b.body, LIMITS.post_body)
  const areaCheck = validateString(b.area_label, LIMITS.area_label, { required: false })
  if (!bodyCheck.ok || !bodyCheck.value)
    return c.json({ error: 'body required (within length limit)' }, 400)
  if (!areaCheck.ok) return c.json({ error: 'area_label too long' }, 400)
  const body = bodyCheck.value
  const area_label = areaCheck.value
  const res = await c.env.DB.prepare(
    `update posts set body = ?, area_label = ? where id = ? and author_id = ?`,
  )
    .bind(body, area_label, id, userId)
    .run()
  if (res.meta.changes !== 1) return c.json({ error: 'not found or not yours' }, 403)
  return c.json({ ok: true })
})

// Delete own post (comments cascade).
app.delete('/posts/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const res = await c.env.DB.prepare(`delete from posts where id = ? and author_id = ?`)
    .bind(id, userId)
    .run()
  // meta.changes counts cascade-deleted comments/interest too, so a successful
  // owner delete is >= 1; a non-owner (or missing) match is 0.
  if (res.meta.changes < 1) return c.json({ error: 'not found or not yours' }, 403)
  return c.json({ ok: true })
})

app.post('/posts/:id/comments', async (c) => {
  if (!(await rateLimit(c, 'comment-create', 30, 300))) {
    return c.json({ error: 'too many comments — slow down' }, 429)
  }
  const userId = c.get('userId')
  const postId = c.req.param('id')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const bodyCheck = validateString(b.body, LIMITS.comment_body)
  if (!bodyCheck.ok || !bodyCheck.value)
    return c.json({ error: 'body required (within length limit)' }, 400)
  const body = bodyCheck.value
  const post: any = await c.env.DB.prepare('select id, author_id, body from posts where id = ?')
    .bind(postId)
    .first()
  if (!post) return c.json({ error: 'post not found' }, 404)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `insert into post_comments (id, post_id, author_id, body) values (?, ?, ?, ?)`,
  )
    .bind(id, postId, userId, body)
    .run()
  // Best-effort: tell the post author (not when commenting on your own post).
  // Topic = post id, so a burst of comments collapses to one queued notification.
  if (post.author_id !== userId) {
    fireAndForget(
      c,
      notifyUser(
        c,
        post.author_id,
        {
          title: 'New comment on your post',
          body: String(post.body).slice(0, 80),
          url: '/',
        },
        { topic: topicFor(postId), urgency: 'normal' },
      ),
    )
  }
  return c.json({ id }, 201)
})

// Edit own comment.
app.put('/comments/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const bodyCheck = validateString(b.body, LIMITS.comment_body)
  if (!bodyCheck.ok || !bodyCheck.value)
    return c.json({ error: 'body required (within length limit)' }, 400)
  const body = bodyCheck.value
  const res = await c.env.DB.prepare(
    `update post_comments set body = ? where id = ? and author_id = ?`,
  )
    .bind(body, id, userId)
    .run()
  if (res.meta.changes !== 1) return c.json({ error: 'not found or not yours' }, 403)
  return c.json({ ok: true })
})

// Delete own comment.
app.delete('/comments/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const res = await c.env.DB.prepare(`delete from post_comments where id = ? and author_id = ?`)
    .bind(id, userId)
    .run()
  if (res.meta.changes !== 1) return c.json({ error: 'not found or not yours' }, 403)
  return c.json({ ok: true })
})

// Toggle interest — your own row only.
app.post('/posts/:id/interest', async (c) => {
  const userId = c.get('userId')
  const postId = c.req.param('id')
  const post = await c.env.DB.prepare('select id from posts where id = ?').bind(postId).first()
  if (!post) return c.json({ error: 'post not found' }, 404)
  await c.env.DB.prepare(`insert or ignore into post_interest (post_id, user_id) values (?, ?)`)
    .bind(postId, userId)
    .run()
  return c.json({ ok: true, interested: true })
})

app.delete('/posts/:id/interest', async (c) => {
  const userId = c.get('userId')
  const postId = c.req.param('id')
  await c.env.DB.prepare(`delete from post_interest where post_id = ? and user_id = ?`)
    .bind(postId, userId)
    .run()
  return c.json({ ok: true, interested: false })
})

/* ============================ PROFILES ============================ */

// Public columns only — never email or password_hash.
app.get('/users/:id', async (c) => {
  const targetId = c.req.param('id')
  const callerId = c.get('userId')
  await publishExpiredReviews(c.env.DB)
  // One D1 batch (single round trip): profile row, hirer counts, distinct
  // counterparties (the hard-to-fake skill signal), block both ways.
  const [userRes, hirerRes, distinctRes, iBlockedRes, blockedMeRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `select id, display_name, total_gigs, rating_sum, rating_count, business_name, verified, deleted, created_at from users where id = ?`,
    ).bind(targetId),
    c.env.DB.prepare(
      `select count(*) as posted,
                sum(case when status = 'COMPLETED' then 1 else 0 end) as paid
           from gigs where posted_by = ?`,
    ).bind(targetId),
    c.env.DB.prepare(
      `select count(distinct author_id) as neighbors
         from reviews where subject_id = ? and status = 'PUBLISHED'`,
    ).bind(targetId),
    c.env.DB.prepare('select 1 from blocks where blocker_id = ? and blocked_id = ?').bind(
      callerId,
      targetId,
    ),
    c.env.DB.prepare('select 1 from blocks where blocker_id = ? and blocked_id = ?').bind(
      targetId,
      callerId,
    ),
  ])
  const user: any = (userRes.results as any[])[0]
  // Closed accounts read as gone; someone who blocked you is also gone to you.
  // (If YOU blocked THEM the profile stays visible so you can unblock from it.)
  if (!user || user.deleted) return c.json({ error: 'not found' }, 404)
  if ((blockedMeRes.results as any[]).length > 0 && targetId !== callerId) {
    return c.json({ error: 'not found' }, 404)
  }
  const average =
    user.rating_count > 0 ? Number((user.rating_sum / user.rating_count).toFixed(2)) : null
  // Hirer-side accountability: how many gigs they've posted and paid out, so a
  // worker can judge a hirer before claiming (total_gigs is worker-side only).
  const hirer: any = (hirerRes.results as any[])[0]
  const distinct: any = (distinctRes.results as any[])[0]
  const blocked = (iBlockedRes.results as any[]).length > 0
  return c.json({
    id: user.id,
    display_name: user.display_name,
    total_gigs: user.total_gigs,
    rating_count: user.rating_count,
    average_rating: average,
    distinct_counterparties: distinct?.neighbors ?? 0,
    business_name: user.business_name,
    verified: user.verified,
    gigs_posted: hirer?.posted ?? 0,
    gigs_paid: hirer?.paid ?? 0,
    i_blocked: blocked ? 1 : 0,
    created_at: user.created_at,
  })
})

/* ============================== BLOCKING =========================== */
// One-directional exclude. Helper returns ids the caller blocked OR who blocked
// the caller — used to filter feeds and gate claims/messaging both ways.
// True when either user has blocked the other. The single shared primitive for
// pairwise enforcement (messages, detail views, profiles) — list endpoints use
// blockedSet for bulk filtering.
async function isBlockedBetween(db: D1Database, a: string, b: string): Promise<boolean> {
  const row = await db
    .prepare(
      'select 1 from blocks where (blocker_id = ?1 and blocked_id = ?2) or (blocker_id = ?2 and blocked_id = ?1)',
    )
    .bind(a, b)
    .first()
  return !!row
}

async function blockedSet(db: D1Database, userId: string): Promise<Set<string>> {
  const rows = await db
    .prepare(
      'select blocked_id as id from blocks where blocker_id = ?1 union select blocker_id from blocks where blocked_id = ?1',
    )
    .bind(userId)
    .all()
  return new Set((rows.results as any[]).map((r) => r.id))
}

app.post('/users/:id/block', async (c) => {
  const userId = c.get('userId')
  const target = c.req.param('id')
  if (target === userId) return c.json({ error: 'cannot block yourself' }, 400)
  const exists = await c.env.DB.prepare('select id from users where id = ?').bind(target).first()
  if (!exists) return c.json({ error: 'not found' }, 404)
  await c.env.DB.prepare('insert or ignore into blocks (blocker_id, blocked_id) values (?, ?)')
    .bind(userId, target)
    .run()
  return c.json({ ok: true, blocked: true })
})

app.delete('/users/:id/block', async (c) => {
  await c.env.DB.prepare('delete from blocks where blocker_id = ? and blocked_id = ?')
    .bind(c.get('userId'), c.req.param('id'))
    .run()
  return c.json({ ok: true, blocked: false })
})

app.get('/me/blocks', async (c) => {
  const rows = await c.env.DB.prepare(
    `select u.id, u.display_name from blocks b join users u on u.id = b.blocked_id
      where b.blocker_id = ? order by b.created_at desc limit 200`,
  )
    .bind(c.get('userId'))
    .all()
  return c.json(rows.results)
})

app.get('/users/:id/reviews', async (c) => {
  const limit = clampLimit(c.req.query('limit'))
  const before = parseBefore(c.req.query('before'))
  await publishExpiredReviews(c.env.DB)
  // Reviews ABOUT this user that are public — both the work they did (as worker)
  // and how they treated workers (as hirer). hirer_name is kept for back-compat;
  // author_name is the actual reviewer in either direction.
  const rows = await c.env.DB.prepare(
    `select r.id, r.gig_id, r.stars, r.body, r.created_at,
            g.task_type, g.neighborhood,
            au.display_name as hirer_name,
            au.display_name as author_name
       from reviews r
       join gigs g on g.id = r.gig_id
       join users au on au.id = r.author_id
      where r.subject_id = ? and r.status = 'PUBLISHED' and (? is null or r.created_at < ?)
      order by r.created_at desc
      limit ?`,
  )
    .bind(c.req.param('id'), before, before, limit)
    .all()
  // Attach the work photos so they show in the worker's portfolio.
  const reviews = rows.results as any[]
  const photos = await loadPhotosByGig(
    c.env.DB,
    reviews.map((r) => r.gig_id),
  )
  for (const r of reviews) r.photos = photos.get(r.gig_id) ?? []
  return c.json(reviews)
})

/* ============================ WEB PUSH =========================== */

// The VAPID public key the client needs to subscribe (null if push isn't configured).
app.get('/push/key', (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY ?? null }))

// Store (or refresh) the caller's push subscription.
app.post('/push/subscribe', async (c) => {
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const endpoint = b?.endpoint
  const p256dh = b?.keys?.p256dh
  const auth = b?.keys?.auth
  if (typeof endpoint !== 'string' || !p256dh || !auth) {
    return c.json({ error: 'endpoint and keys required' }, 400)
  }
  // Only deliver to real browser push services — the server POSTs to this URL,
  // so anything else is a server-side request forgery vector.
  if (!isAllowedPushEndpoint(endpoint)) {
    return c.json({ error: 'unrecognized push service endpoint' }, 400)
  }
  await c.env.DB.prepare(
    `insert into push_subscriptions (endpoint, user_id, p256dh, auth) values (?, ?, ?, ?)
     on conflict(endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(endpoint, userId, p256dh, auth)
    .run()
  return c.json({ ok: true }, 201)
})

// Remove a subscription (the caller's own).
app.delete('/push/subscribe', async (c) => {
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  if (typeof b?.endpoint !== 'string') return c.json({ error: 'endpoint required' }, 400)
  await c.env.DB.prepare('delete from push_subscriptions where endpoint = ? and user_id = ?')
    .bind(b.endpoint, userId)
    .run()
  return c.json({ ok: true })
})

/* ======================= REPORTS / SUPPORT ======================== */
// One table covers content/user reports, business-verification requests, and
// support tickets — an admin works through them all in the same queue.

const REPORT_KINDS = new Set(['post', 'comment', 'gig', 'user', 'support'])

app.post('/reports', async (c) => {
  if (!(await rateLimit(c, 'report', 5, 300))) {
    return c.json({ error: 'too many reports — try again shortly' }, 429)
  }
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const kind = String(b.kind ?? '')
  if (!REPORT_KINDS.has(kind)) return c.json({ error: 'invalid kind' }, 400)
  const reasonCheck = validateString(b.reason, LIMITS.report_reason)
  if (!reasonCheck.ok || !reasonCheck.value) return c.json({ error: 'reason required' }, 400)
  const subject_id = b.subject_id ? String(b.subject_id) : null
  if (kind !== 'support' && !subject_id) return c.json({ error: 'subject_id required' }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    'insert into reports (id, reporter_id, kind, subject_id, reason) values (?, ?, ?, ?, ?)',
  )
    .bind(id, userId, kind, subject_id, reasonCheck.value)
    .run()
  return c.json({ id }, 201)
})

// Your own tickets/reports with status — so support requests aren't a black hole.
app.get('/reports/mine', async (c) => {
  const rows = await c.env.DB.prepare(
    'select id, kind, subject_id, reason, status, created_at from reports where reporter_id = ? order by created_at desc limit 50',
  )
    .bind(c.get('userId'))
    .all()
  return c.json(rows.results)
})

/* ============================== ADMIN ============================== */
// Moderation role: a users.is_admin flag the operator grants via SQL (see
// README). Admins triage reports, remove content, and verify businesses.
// Admin status confers NO gig authority — rating stays per-gig ownership.

// One shared gate for every /admin/* route — a new admin endpoint cannot be
// added without protection, unlike per-handler checks.
app.use('/admin/*', async (c: any, next: any) => {
  const row: any = await c.env.DB.prepare('select is_admin from users where id = ?')
    .bind(c.get('userId'))
    .first()
  if (!row?.is_admin) return c.json({ error: 'admin only' }, 403)
  await next()
})

// At-a-glance operational counts for the admin dashboard.
app.get('/admin/stats', async (c) => {
  const row: any = await c.env.DB.prepare(
    `select
       (select count(*) from users where deleted = 0) as users,
       (select count(*) from users where verified = 1) as verified_businesses,
       (select count(*) from gigs) as gigs,
       (select count(*) from gigs where status = 'AVAILABLE') as gigs_available,
       (select count(*) from gigs where status = 'COMPLETED') as gigs_completed,
       (select count(*) from posts) as posts,
       (select count(*) from reports where status = 'OPEN') as open_reports`,
  ).first()
  return c.json(row)
})

app.get('/admin/reports', async (c) => {
  const rows = await c.env.DB.prepare(
    `select r.id, r.kind, r.subject_id, r.reason, r.status, r.created_at,
            u.display_name as reporter_name
       from reports r join users u on u.id = r.reporter_id
      order by case r.status when 'OPEN' then 0 else 1 end, r.created_at desc
      limit 100`,
  ).all()
  return c.json(rows.results)
})

app.post('/admin/reports/:id/resolve', async (c) => {
  const res = await c.env.DB.prepare(`update reports set status = 'RESOLVED' where id = ?`)
    .bind(c.req.param('id'))
    .run()
  if (res.meta.changes !== 1) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

// Grant or revoke the verified-business badge.
app.post('/admin/users/:id/verify', async (c) => {
  let b: any = {}
  try {
    b = await c.req.json()
  } catch {
    // default: verify
  }
  const value = b?.verified === false ? 0 : 1
  const res = await c.env.DB.prepare('update users set verified = ? where id = ?')
    .bind(value, c.req.param('id'))
    .run()
  if (res.meta.changes !== 1) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true, verified: value })
})

// Admin content removal (moderation): posts cascade comments; comments direct.
app.delete('/admin/posts/:id', async (c) => {
  const res = await c.env.DB.prepare('delete from posts where id = ?').bind(c.req.param('id')).run()
  if (res.meta.changes < 1) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/admin/comments/:id', async (c) => {
  const res = await c.env.DB.prepare('delete from post_comments where id = ?')
    .bind(c.req.param('id'))
    .run()
  if (res.meta.changes < 1) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/admin/gigs/:id', async (c) => {
  // COMPLETED gigs carry reviews/reputation — even admins don't rewrite history.
  const res = await c.env.DB.prepare(`delete from gigs where id = ? and status <> 'COMPLETED'`)
    .bind(c.req.param('id'))
    .run()
  if (res.meta.changes < 1) return c.json({ error: 'not found or completed' }, 404)
  return c.json({ ok: true })
})

/* ============================ FALLBACKS =========================== */

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error('API error:', err)
  return c.json({ error: 'internal error' }, 500)
})

export const onRequest = handle(app)

// Exported for integration tests (call app.request(path, init, env) directly).
export { app }
