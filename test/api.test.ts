// Integration tests — exercise the Hono app against a real (local) D1 inside the
// Workers runtime. These lock in the trust-model invariants: ownership checks,
// the claim/complete state machine, reputation math, and PII non-leakage.

import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../functions/api/[[path]].ts'
// @ts-expect-error — vite raw import of the schema file
import schema from '../schema.sql?raw'

const E = env as { DB: D1Database; SESSION_SECRET: string }

beforeAll(async () => {
  // Apply the schema once. Strip `--` comment lines first, then split on ';'
  // (no ';' appears inside any statement, so this is safe).
  const sql = (schema as string)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const stmt of statements) await E.DB.prepare(stmt).run()
})

beforeEach(async () => {
  // Clear auth rate-limit counters so per-IP limits don't bleed across tests.
  await E.DB.prepare('delete from rate_limits').run()
})

// --- helpers -------------------------------------------------------------

let seq = 0
function uniqueEmail() {
  seq += 1
  return `u${Date.now()}_${seq}@example.com`
}

async function call(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  const res = await app.request(`/api${path}`, { ...init, headers }, E)
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, raw: text }
}

async function register(displayName?: string) {
  const email = uniqueEmail()
  const r = await call('/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'password123', display_name: displayName }),
  })
  expect(r.status).toBe(201)
  return { token: r.body.token as string, id: r.body.user.id as string, email }
}

async function postGig(token: string, over: Record<string, unknown> = {}) {
  const r = await call(
    '/gigs',
    {
      method: 'POST',
      body: JSON.stringify({
        task_type: 'Rake leaves',
        neighborhood: 'Front St',
        cash_payout: 40,
        est_hours: 2,
        lat: 34.72,
        lng: -76.66,
        description: 'Front yard',
        ...over,
      }),
    },
    token,
  )
  expect(r.status).toBe(201)
  return r.body.id as string
}

// --- tests ---------------------------------------------------------------

describe('auth', () => {
  it('registers, rejects duplicate email, and rejects short passwords', async () => {
    const email = uniqueEmail()
    const a = await call('/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'password123' }),
    })
    expect(a.status).toBe(201)
    expect(a.body.token).toBeTruthy()

    const dup = await call('/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'password123' }),
    })
    expect(dup.status).toBe(409)

    const short = await call('/register', {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail(), password: 'short' }),
    })
    expect(short.status).toBe(400)
  })

  it('logs in with correct creds and rejects wrong ones (same generic error)', async () => {
    const { email } = await register()
    const ok = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'password123' }),
    })
    expect(ok.status).toBe(200)

    const bad = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'wrongpassword' }),
    })
    expect(bad.status).toBe(401)

    const missing = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever123' }),
    })
    expect(missing.status).toBe(401)
    // Unknown email and wrong password return the identical message (no enumeration).
    expect(missing.body.error).toBe(bad.body.error)
  })

  it('blocks unauthenticated access to protected routes', async () => {
    const r = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5')
    expect(r.status).toBe(401)
  })

  it('rate-limits rapid registrations', async () => {
    let sawLimit = false
    for (let i = 0; i < 7; i++) {
      const r = await call('/register', {
        method: 'POST',
        body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
      })
      if (r.status === 429) sawLimit = true
    }
    expect(sawLimit).toBe(true)
  })
})

describe('gig lifecycle & authorization', () => {
  it('enforces the claim/complete invariants and updates reputation', async () => {
    const hirer = await register('Alice')
    const worker = await register('Bob')
    const gid = await postGig(hirer.token)

    // worker sees it nearby
    const near = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, worker.token)
    expect(near.status).toBe(200)
    expect(near.body.some((g: any) => g.id === gid)).toBe(true)

    // hirer cannot claim their own gig
    const ownClaim = await call(`/gigs/${gid}/claim`, { method: 'POST' }, hirer.token)
    expect(ownClaim.status).toBe(409)

    // worker claims
    const claim = await call(`/gigs/${gid}/claim`, { method: 'POST' }, worker.token)
    expect(claim.status).toBe(200)

    // double claim fails
    const reclaim = await call(`/gigs/${gid}/claim`, { method: 'POST' }, worker.token)
    expect(reclaim.status).toBe(409)

    // non-owner cannot complete
    const badComplete = await call(
      `/gigs/${gid}/complete`,
      { method: 'POST', body: JSON.stringify({ rating: 5 }) },
      worker.token,
    )
    expect(badComplete.status).toBe(403)

    // out-of-range rating rejected
    const badRating = await call(
      `/gigs/${gid}/complete`,
      { method: 'POST', body: JSON.stringify({ rating: 9 }) },
      hirer.token,
    )
    expect(badRating.status).toBe(400)

    // owner completes + rates
    const done = await call(
      `/gigs/${gid}/complete`,
      { method: 'POST', body: JSON.stringify({ rating: 5, review: 'Great work' }) },
      hirer.token,
    )
    expect(done.status).toBe(200)

    // reputation updated, average derived
    const profile = await call(`/users/${worker.id}`, {}, hirer.token)
    expect(profile.body.total_gigs).toBe(1)
    expect(profile.body.rating_count).toBe(1)
    expect(profile.body.average_rating).toBe(5)

    const reviews = await call(`/users/${worker.id}/reviews`, {}, hirer.token)
    expect(reviews.body).toHaveLength(1)
    expect(reviews.body[0].stars).toBe(5)

    // completed gig leaves the nearby feed
    const after = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, worker.token)
    expect(after.body.some((g: any) => g.id === gid)).toBe(false)
  })

  it('allows edit/delete only when appropriate and abandon only by the claimer', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)

    // owner edits while AVAILABLE
    const edit = await call(
      `/gigs/${gid}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          task_type: 'Mow',
          neighborhood: 'Front St',
          cash_payout: 50,
          est_hours: 1,
          lat: 34.72,
          lng: -76.66,
          description: 'edited',
        }),
      },
      hirer.token,
    )
    expect(edit.status).toBe(200)

    // non-owner cannot edit
    const badEdit = await call(
      `/gigs/${gid}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          task_type: 'x',
          neighborhood: 'y',
          cash_payout: 1,
          est_hours: 1,
          lat: 34.72,
          lng: -76.66,
          description: 'z',
        }),
      },
      worker.token,
    )
    expect(badEdit.status).toBe(403)

    // claim, then editing is locked
    await call(`/gigs/${gid}/claim`, { method: 'POST' }, worker.token)
    const lockedEdit = await call(
      `/gigs/${gid}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          task_type: 'Mow',
          neighborhood: 'Front St',
          cash_payout: 50,
          est_hours: 1,
          lat: 34.72,
          lng: -76.66,
          description: 'again',
        }),
      },
      hirer.token,
    )
    expect(lockedEdit.status).toBe(403)

    // only the claimer can abandon
    const badAbandon = await call(`/gigs/${gid}/abandon`, { method: 'POST' }, hirer.token)
    expect(badAbandon.status).toBe(403)
    const abandon = await call(`/gigs/${gid}/abandon`, { method: 'POST' }, worker.token)
    expect(abandon.status).toBe(200)

    // now AVAILABLE again and deletable by the owner
    const del = await call(`/gigs/${gid}`, { method: 'DELETE' }, hirer.token)
    expect(del.status).toBe(200)
  })

  it('rejects oversized and malformed gig input', async () => {
    const hirer = await register()
    const big = await call(
      '/gigs',
      {
        method: 'POST',
        body: JSON.stringify({
          task_type: 't',
          neighborhood: 'n',
          cash_payout: 1,
          est_hours: 1,
          lat: 34.72,
          lng: -76.66,
          description: 'x'.repeat(2500),
        }),
      },
      hirer.token,
    )
    expect(big.status).toBe(400)

    const badGeo = await postBad(hirer.token, { lat: 999 })
    expect(badGeo).toBe(400)
  })
})

async function postBad(token: string, over: Record<string, unknown>) {
  const r = await call(
    '/gigs',
    {
      method: 'POST',
      body: JSON.stringify({
        task_type: 'Rake',
        neighborhood: 'Front',
        cash_payout: 10,
        est_hours: 1,
        lat: 34.72,
        lng: -76.66,
        description: 'd',
        ...over,
      }),
    },
    token,
  )
  return r.status
}

describe('board', () => {
  it('creates posts, comments, interest with correct counts and owner-only edits', async () => {
    const a = await register('Ann')
    const b = await register('Ben')

    const created = await call(
      '/posts',
      {
        method: 'POST',
        body: JSON.stringify({ body: 'Corner needs a bench', area_label: 'Front St' }),
      },
      a.token,
    )
    expect(created.status).toBe(201)
    const pid = created.body.id

    // b comments and marks interest
    expect(
      (
        await call(
          `/posts/${pid}/comments`,
          { method: 'POST', body: JSON.stringify({ body: 'Agreed' }) },
          b.token,
        )
      ).status,
    ).toBe(201)
    expect((await call(`/posts/${pid}/interest`, { method: 'POST' }, b.token)).status).toBe(200)

    const list = await call('/posts', {}, b.token)
    const post = list.body.find((p: any) => p.id === pid)
    expect(post.comment_count).toBe(1)
    expect(post.interest_count).toBe(1)
    expect(post.i_am_interested).toBeTruthy()

    // a (non-author of nothing here) — b cannot delete a's post
    const badDel = await call(`/posts/${pid}`, { method: 'DELETE' }, b.token)
    expect(badDel.status).toBe(403)

    // author can edit + delete
    expect(
      (
        await call(
          `/posts/${pid}`,
          { method: 'PUT', body: JSON.stringify({ body: 'Corner really needs a bench' }) },
          a.token,
        )
      ).status,
    ).toBe(200)
    expect((await call(`/posts/${pid}`, { method: 'DELETE' }, a.token)).status).toBe(200)
  })
})

describe('PII never leaks', () => {
  it('omits password_hash and other users’ email from responses', async () => {
    const a = await register('Ann')
    const b = await register('Ben')
    const gid = await postGig(a.token)
    await call(`/gigs/${gid}/claim`, { method: 'POST' }, b.token)
    await call(
      `/gigs/${gid}/complete`,
      { method: 'POST', body: JSON.stringify({ rating: 4, review: 'ok' }) },
      a.token,
    )

    const surfaces = [
      await call(`/gigs/near?lat=34.72&lng=-76.66&radius=5`, {}, a.token),
      await call(`/users/${b.id}`, {}, a.token),
      await call(`/users/${b.id}/reviews`, {}, a.token),
      await call('/posts', {}, a.token),
    ]
    for (const s of surfaces) {
      expect(s.raw).not.toContain('password_hash')
      expect(s.raw).not.toContain(b.email)
    }

    // /me may return the caller's OWN email, but never a hash
    const me = await call('/me', {}, a.token)
    expect(me.raw).not.toContain('password_hash')
  })
})
