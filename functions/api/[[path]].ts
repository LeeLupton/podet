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
import { clampLimit, parseBefore } from '../lib/pagination'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/password'
import { MAX_PHOTOS_PER_GIG, checkImageUpload, photoKey } from '../lib/photos'
import { type PushDeliveryOptions, sendWebPush, topicFor } from '../lib/push'
import { rateLimitKey, windowStart } from '../lib/ratelimit'
import { LIMITS, isValidLatLng, isValidRating, validateString } from '../lib/validate'

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
async function issueSession(c: any, userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL
  const token = await sign({ sub: userId, exp }, c.env.SESSION_SECRET, 'HS256')
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
  try {
    const payload = await verify(token, c.env.SESSION_SECRET, 'HS256')
    c.set('userId', payload.sub as string)
  } catch {
    return c.json({ error: 'invalid session' }, 401)
  }
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
  await c.env.DB.prepare(
    'insert into users (id, email, password_hash, display_name) values (?, ?, ?, ?)',
  )
    .bind(id, email, password_hash, display_name)
    .run()

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
    'select id, email, password_hash, display_name from users where email = ?',
  )
    .bind(email)
    .first()
  // Always run the PBKDF2 verify (against a dummy hash when the email is unknown)
  // so response time doesn't reveal whether an account exists.
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH)
  if (!user || !ok) return c.json({ error: 'invalid credentials' }, 401)

  const token = await issueSession(c, user.id)
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
    'select id, email, display_name, total_gigs, rating_sum, rating_count from users where id = ?',
  )
    .bind(userId)
    .first()
  if (!user) return c.json({ error: 'not found' }, 404)
  return c.json(user)
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
  await c.env.DB.prepare('update users set password_hash = ? where id = ?')
    .bind(password_hash, userId)
    .run()
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
            u.display_name as poster_name
       from gigs g
       join users u on u.id = g.posted_by
      where g.status = 'AVAILABLE'
        and g.lat between ? and ?
        and g.lng between ? and ?`,
  )
    .bind(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta)
    .all()

  const near = (rows.results as any[])
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
    `select g.*, wp.display_name as worker_name
       from gigs g left join users wp on wp.id = g.claimed_by
      where g.posted_by = ? order by g.created_at desc`,
  )
    .bind(userId)
    .all()
  const claimed = await c.env.DB.prepare(
    `select g.*, hp.display_name as poster_name
       from gigs g join users hp on hp.id = g.posted_by
      where g.claimed_by = ? order by g.created_at desc`,
  )
    .bind(userId)
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
  return c.json(gig)
})

// Create a gig — posted_by = session user.
app.post('/gigs', async (c) => {
  const userId = c.get('userId')
  let b: any
  try {
    b = await c.req.json()
  } catch {
    return c.json({ error: 'invalid body' }, 400)
  }
  const taskCheck = validateString(b.task_type, LIMITS.task_type)
  const hoodCheck = validateString(b.neighborhood, LIMITS.neighborhood)
  const descCheck = validateString(b.description, LIMITS.description)
  if (!taskCheck.ok || !hoodCheck.ok || !descCheck.ok) {
    return c.json(
      { error: 'task_type, neighborhood and description required (and within length limits)' },
      400,
    )
  }
  const task_type = taskCheck.value as string
  const neighborhood = hoodCheck.value as string
  const description = descCheck.value as string
  const cash_payout = Math.round(Number(b.cash_payout))
  const est_hours = Number(b.est_hours)
  const lat = Number(b.lat)
  const lng = Number(b.lng)
  const from_post_id = b.from_post_id ? String(b.from_post_id) : null

  if (!Number.isFinite(cash_payout) || cash_payout < 0 || cash_payout > 1_000_000) {
    return c.json({ error: 'cash_payout must be a non-negative number' }, 400)
  }
  if (!Number.isFinite(est_hours) || est_hours <= 0 || est_hours > 10_000) {
    return c.json({ error: 'est_hours must be positive' }, 400)
  }
  if (!isValidLatLng(lat, lng)) {
    return c.json({ error: 'valid lat and lng required' }, 400)
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `insert into gigs (id, task_type, neighborhood, cash_payout, est_hours, lat, lng, description, posted_by, from_post_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      task_type,
      neighborhood,
      cash_payout,
      est_hours,
      lat,
      lng,
      description,
      userId,
      from_post_id,
    )
    .run()
  // Best-effort: if this gig grew out of a board post, tell the post author.
  if (from_post_id) {
    const origin: any = await c.env.DB.prepare('select author_id from posts where id = ?')
      .bind(from_post_id)
      .first()
    if (origin && origin.author_id !== userId) {
      fireAndForget(
        c,
        notifyUser(
          c,
          origin.author_id,
          {
            title: 'Your post became a gig',
            body: `${task_type} — ${cash_payout} offered`,
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
app.post('/gigs/:id/claim', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const res = await c.env.DB.prepare(
    `update gigs set status = 'CLAIMED', claimed_by = ?
      where id = ? and status = 'AVAILABLE' and posted_by <> ?`,
  )
    .bind(userId, id, userId)
    .run()
  if (res.meta.changes !== 1) {
    return c.json({ error: 'gig is unavailable or your own' }, 409)
  }
  // Best-effort: tell the poster their gig was claimed.
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
          title: 'Your gig was claimed',
          body: `${g.task_type} — someone is on it`,
          url: '/',
        },
        { topic: topicFor(id), urgency: 'high' },
      ),
    )
  }
  return c.json({ ok: true })
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

  const reviewId = crypto.randomUUID()
  await c.env.DB.batch([
    c.env.DB.prepare(`update gigs set status = 'COMPLETED' where id = ?`).bind(id),
    c.env.DB.prepare(
      `insert into reviews (id, gig_id, worker_id, hirer_id, stars, body) values (?, ?, ?, ?, ?, ?)`,
    ).bind(reviewId, id, gig.claimed_by, userId, rating, review),
    c.env.DB.prepare(
      `update users set total_gigs = total_gigs + 1, rating_sum = rating_sum + ?, rating_count = rating_count + 1 where id = ?`,
    ).bind(rating, gig.claimed_by),
  ])
  // Best-effort: tell the worker they were paid and rated.
  fireAndForget(
    c,
    notifyUser(
      c,
      gig.claimed_by,
      {
        title: `You were rated ${rating}★`,
        body: `${gig.task_type} — paid ${gig.cash_payout}`,
        url: '/',
      },
      { topic: topicFor(id), urgency: 'high' },
    ),
  )
  return c.json({ ok: true })
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
  const taskCheck = validateString(b.task_type, LIMITS.task_type)
  const hoodCheck = validateString(b.neighborhood, LIMITS.neighborhood)
  const descCheck = validateString(b.description, LIMITS.description)
  if (!taskCheck.ok || !hoodCheck.ok || !descCheck.ok) {
    return c.json(
      { error: 'task_type, neighborhood and description required (and within length limits)' },
      400,
    )
  }
  const cash_payout = Math.round(Number(b.cash_payout))
  const est_hours = Number(b.est_hours)
  const lat = Number(b.lat)
  const lng = Number(b.lng)
  if (!Number.isFinite(cash_payout) || cash_payout < 0 || cash_payout > 1_000_000) {
    return c.json({ error: 'cash_payout must be a non-negative number' }, 400)
  }
  if (!Number.isFinite(est_hours) || est_hours <= 0 || est_hours > 10_000) {
    return c.json({ error: 'est_hours must be positive' }, 400)
  }
  if (!isValidLatLng(lat, lng)) {
    return c.json({ error: 'valid lat and lng required' }, 400)
  }
  const res = await c.env.DB.prepare(
    `update gigs set task_type = ?, neighborhood = ?, description = ?, cash_payout = ?, est_hours = ?, lat = ?, lng = ?
      where id = ? and posted_by = ? and status = 'AVAILABLE'`,
  )
    .bind(
      taskCheck.value,
      hoodCheck.value,
      descCheck.value,
      cash_payout,
      est_hours,
      lat,
      lng,
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
app.delete('/gigs/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const res = await c.env.DB.prepare(
    `delete from gigs where id = ? and posted_by = ? and status <> 'COMPLETED'`,
  )
    .bind(id, userId)
    .run()
  if (res.meta.changes !== 1) {
    return c.json({ error: 'not found, not yours, or already completed' }, 403)
  }
  return c.json({ ok: true })
})

// Abandon a claim — the worker steps back; the gig returns to AVAILABLE.
// Only the current claimer, only while CLAIMED.
app.post('/gigs/:id/abandon', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const res = await c.env.DB.prepare(
    `update gigs set status = 'AVAILABLE', claimed_by = null
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
            u.display_name as author_name,
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
  return c.json(rows.results)
})

app.post('/posts', async (c) => {
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
            u.display_name as author_name,
            (select count(*) from post_interest pi where pi.post_id = p.id) as interest_count,
            (select count(*) from gigs g where g.from_post_id = p.id) as gig_count,
            exists(select 1 from post_interest pi where pi.post_id = p.id and pi.user_id = ?) as i_am_interested
       from posts p join users u on u.id = p.author_id
      where p.id = ?`,
  )
    .bind(userId, id)
    .first()
  if (!post) return c.json({ error: 'not found' }, 404)
  const comments = await c.env.DB.prepare(
    `select pc.id, pc.post_id, pc.author_id, pc.body, pc.created_at, u.display_name as author_name
       from post_comments pc join users u on u.id = pc.author_id
      where pc.post_id = ? order by pc.created_at asc`,
  )
    .bind(id)
    .all()
  return c.json({ ...post, comments: comments.results })
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
  const user: any = await c.env.DB.prepare(
    `select id, display_name, total_gigs, rating_sum, rating_count, created_at from users where id = ?`,
  )
    .bind(c.req.param('id'))
    .first()
  if (!user) return c.json({ error: 'not found' }, 404)
  const average =
    user.rating_count > 0 ? Number((user.rating_sum / user.rating_count).toFixed(2)) : null
  return c.json({
    id: user.id,
    display_name: user.display_name,
    total_gigs: user.total_gigs,
    rating_count: user.rating_count,
    average_rating: average,
    created_at: user.created_at,
  })
})

app.get('/users/:id/reviews', async (c) => {
  const limit = clampLimit(c.req.query('limit'))
  const before = parseBefore(c.req.query('before'))
  const rows = await c.env.DB.prepare(
    `select r.id, r.gig_id, r.stars, r.body, r.created_at,
            g.task_type, g.neighborhood,
            hu.display_name as hirer_name
       from reviews r
       join gigs g on g.id = r.gig_id
       join users hu on hu.id = r.hirer_id
      where r.worker_id = ? and (? is null or r.created_at < ?)
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
  // Push service endpoints are always https; reject anything else so we never
  // POST encrypted payloads to an arbitrary scheme/host of the client's choosing.
  let endpointUrl: URL
  try {
    endpointUrl = new URL(endpoint)
  } catch {
    return c.json({ error: 'invalid endpoint' }, 400)
  }
  if (endpointUrl.protocol !== 'https:') {
    return c.json({ error: 'endpoint must be https' }, 400)
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

/* ============================ FALLBACKS =========================== */

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error('API error:', err)
  return c.json({ error: 'internal error' }, 500)
})

export const onRequest = handle(app)

// Exported for integration tests (call app.request(path, init, env) directly).
export { app }
