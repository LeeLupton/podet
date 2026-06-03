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

type Env = {
  DB: D1Database
  SESSION_SECRET: string
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

// Input length caps — reject oversized payloads before they hit the DB.
const LIMITS = {
  email: 254,
  password: 200,
  display_name: 60,
  task_type: 80,
  neighborhood: 80,
  description: 2000,
  post_body: 1000,
  comment_body: 1000,
  area_label: 120,
  review_body: 1000,
}

// Returns a trimmed string, or null if missing/too long/blank-when-required.
function validateString(
  value: unknown,
  max: number,
  { required = true } = {},
): { ok: true; value: string | null } | { ok: false } {
  if (value == null || value === '') return required ? { ok: false } : { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (required && !trimmed) return { ok: false }
  if (trimmed.length > max) return { ok: false }
  return { ok: true, value: trimmed || null }
}

/* ------------------------------------------------------------------ *
 * Rate limiting — D1-backed fixed window, keyed by '<route>:<ip>'.
 * Works on the free tier with no extra binding. Returns true if allowed.
 * ------------------------------------------------------------------ */
async function rateLimit(
  c: any,
  route: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  const key = `${route}:${ip}`
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - (now % windowSec)
  // Upsert: start a fresh window when the stored one is stale, else increment.
  const res = await c.env.DB.prepare(
    `insert into rate_limits (key, count, window_start) values (?, 1, ?)
     on conflict(key) do update set
       count = case when rate_limits.window_start = excluded.window_start then rate_limits.count + 1 else 1 end,
       window_start = excluded.window_start
     returning count`,
  )
    .bind(key, windowStart)
    .first()
  return ((res as any)?.count ?? 1) <= limit
}

/* ------------------------------------------------------------------ *
 * Password hashing — PBKDF2-HMAC-SHA256 via Web Crypto.
 * Encoded as `pbkdf2$<iterations>$<saltB64>$<hashB64>`. Never store or
 * compare plaintext; login uses a constant-time compare.
 * Upgrade path: argon2id via WASM (the encoding scheme prefix allows it).
 * ------------------------------------------------------------------ */
const PBKDF2_ITERATIONS = 100_000
const PBKDF2_HASH_BITS = 256

function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function b64decode(str: string): Uint8Array {
  const s = atob(str)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_HASH_BITS,
  )
  return new Uint8Array(bits)
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// A well-formed dummy hash so login can run the same PBKDF2 work for unknown
// emails — equalizing response time so it can't be used to enumerate accounts.
const DUMMY_PASSWORD_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(new Uint8Array(16))}$${b64encode(new Uint8Array(32))}`

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(iterations)) return false
  const salt = b64decode(parts[2])
  const expected = b64decode(parts[3])
  const actual = await deriveBits(password, salt, iterations)
  return timingSafeEqual(actual, expected)
}

/* ------------------------------------------------------------------ *
 * Sessions — a JWT signed with env.SESSION_SECRET, delivered as an
 * HttpOnly + Secure + SameSite cookie (and returned in the body so any
 * non-browser client can send it as `Authorization: Bearer`).
 * ------------------------------------------------------------------ */
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
 * Geo helpers — SQLite has no guaranteed trig functions, so the SQL
 * prefilters by an indexable bounding box and the exact distance is
 * computed here with a JS Haversine.
 * ------------------------------------------------------------------ */
const MILES_PER_DEG_LAT = 69

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8 // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
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

  const latDelta = r / MILES_PER_DEG_LAT
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const lngDelta = r / (MILES_PER_DEG_LAT * (Math.abs(cosLat) < 1e-6 ? 1e-6 : Math.abs(cosLat)))

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

// Gigs posted by, or claimed by, the signed-in user (for the Me view).
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
  return c.json({ posted: posted.results, claimed: claimed.results })
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
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
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
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
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
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
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
  return c.json({ ok: true })
})

/* ============================== BOARD ============================== */

app.get('/posts', async (c) => {
  const userId = c.get('userId')
  const rows = await c.env.DB.prepare(
    `select p.id, p.author_id, p.body, p.area_label, p.lat, p.lng, p.created_at,
            u.display_name as author_name,
            (select count(*) from post_comments pc where pc.post_id = p.id) as comment_count,
            (select count(*) from post_interest pi where pi.post_id = p.id) as interest_count,
            exists(select 1 from post_interest pi where pi.post_id = p.id and pi.user_id = ?) as i_am_interested
       from posts p
       join users u on u.id = p.author_id
      order by p.created_at desc`,
  )
    .bind(userId)
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
  const post = await c.env.DB.prepare('select id from posts where id = ?').bind(postId).first()
  if (!post) return c.json({ error: 'post not found' }, 404)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `insert into post_comments (id, post_id, author_id, body) values (?, ?, ?, ?)`,
  )
    .bind(id, postId, userId, body)
    .run()
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
  const rows = await c.env.DB.prepare(
    `select r.id, r.gig_id, r.stars, r.body, r.created_at,
            g.task_type, g.neighborhood,
            hu.display_name as hirer_name
       from reviews r
       join gigs g on g.id = r.gig_id
       join users hu on hu.id = r.hirer_id
      where r.worker_id = ?
      order by r.created_at desc`,
  )
    .bind(c.req.param('id'))
    .all()
  return c.json(rows.results)
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
