import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, claim, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

// Regression net: every route the frontend data layer (public/js/api.js) can hit
// must exist — none may fall through to the 404 handler (or blow up with a 500).
// This is the sweep that would have caught '/gigs/:id' shadowing '/gigs/mine'.
// Keep this list in sync with public/js/api.js.
describe('UI surface sweep (no 404/500 from any api.js route)', () => {
  it('every data-layer route resolves', async () => {
    const failures: string[] = []
    const check = (label: string, status: number) => {
      if (status === 404 || status >= 500) failures.push(`${label} → ${status}`)
    }

    // Seed: hirer A, worker B, a gig (claimed by B), a photo, a post + comment.
    const a = await register('A')
    const b = await register('B')
    const gid = await postGig(a.token)
    check('POST /gigs/:id/claim', (await claim(gid, b.token)).status)

    const photo = await call(
      `/gigs/${gid}/photos`,
      {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
      },
      a.token,
    )
    check('POST /gigs/:id/photos', photo.status)

    const post = await call(
      '/posts',
      { method: 'POST', body: JSON.stringify({ body: 'sweep post' }) },
      a.token,
    )
    check('POST /posts', post.status)
    const pid = post.body.id
    const comment = await call(
      `/posts/${pid}/comments`,
      { method: 'POST', body: JSON.stringify({ body: 'sweep comment' }) },
      b.token,
    )
    check('POST /posts/:id/comments', comment.status)

    // Auth surface
    check('GET /me', (await call('/me', {}, a.token)).status)
    check(
      'POST /me/password',
      (
        await call(
          '/me/password',
          {
            method: 'POST',
            body: JSON.stringify({ current_password: 'wrong-pass', new_password: 'longenough1' }),
          },
          a.token,
        )
      ).status, // 403 expected — just must not be 404
    )
    check(
      'POST /login',
      (
        await call('/login', {
          method: 'POST',
          body: JSON.stringify({ email: a.email, password: 'password123' }),
        })
      ).status,
    )
    check('POST /logout', (await call('/logout', { method: 'POST' }, a.token)).status)

    // Gigs surface
    check(
      'GET /gigs/near',
      (await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, b.token)).status,
    )
    check('GET /gigs/mine', (await call('/gigs/mine', {}, a.token)).status)
    check('GET /gigs/:id', (await call(`/gigs/${gid}`, {}, b.token)).status)
    check(
      'PUT /gigs/:id',
      (
        await call(
          `/gigs/${gid}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              task_type: 't',
              neighborhood: 'n',
              cash_payout: 1,
              est_hours: 1,
              lat: 34.72,
              lng: -76.66,
              description: 'd',
            }),
          },
          a.token,
        )
      ).status, // 403 (claimed) — fine, not 404
    )
    check('GET /img/:key', (await call(`/img/${photo.body.key}`, {}, a.token)).status)
    check(
      'DELETE /gigs/:id/photos/:photoId',
      (await call(`/gigs/${gid}/photos/${photo.body.id}`, { method: 'DELETE' }, a.token)).status,
    )
    check(
      'POST /gigs/:id/abandon',
      (await call(`/gigs/${gid}/abandon`, { method: 'POST' }, b.token)).status,
    )
    check(
      'POST /gigs/:id/complete',
      (
        await call(
          `/gigs/${gid}/complete`,
          { method: 'POST', body: JSON.stringify({ rating: 5 }) },
          a.token,
        )
      ).status, // 409 (back to AVAILABLE after abandon) — fine, not 404
    )
    check('DELETE /gigs/:id', (await call(`/gigs/${gid}`, { method: 'DELETE' }, a.token)).status)

    // Board surface
    check('GET /posts', (await call('/posts?limit=5', {}, a.token)).status)
    check('GET /posts/:id', (await call(`/posts/${pid}`, {}, a.token)).status)
    check(
      'PUT /posts/:id',
      (
        await call(
          `/posts/${pid}`,
          { method: 'PUT', body: JSON.stringify({ body: 'edited' }) },
          a.token,
        )
      ).status,
    )
    check(
      'PUT /comments/:id',
      (
        await call(
          `/comments/${comment.body.id}`,
          { method: 'PUT', body: JSON.stringify({ body: 'edited' }) },
          b.token,
        )
      ).status,
    )
    check(
      'POST /posts/:id/interest',
      (await call(`/posts/${pid}/interest`, { method: 'POST' }, b.token)).status,
    )
    check(
      'DELETE /posts/:id/interest',
      (await call(`/posts/${pid}/interest`, { method: 'DELETE' }, b.token)).status,
    )
    check(
      'DELETE /comments/:id',
      (await call(`/comments/${comment.body.id}`, { method: 'DELETE' }, b.token)).status,
    )
    check('DELETE /posts/:id', (await call(`/posts/${pid}`, { method: 'DELETE' }, a.token)).status)

    // Messages, reports, business surface
    const gid2 = await postGig(a.token)
    check('POST /gigs/:id/claim (2)', (await claim(gid2, b.token)).status)
    check(
      'POST /gigs/:id/messages',
      (
        await call(
          `/gigs/${gid2}/messages`,
          { method: 'POST', body: JSON.stringify({ body: 'sweep message' }) },
          a.token,
        )
      ).status,
    )
    check('GET /gigs/:id/messages', (await call(`/gigs/${gid2}/messages`, {}, b.token)).status)
    check(
      'POST /reports',
      (
        await call(
          '/reports',
          { method: 'POST', body: JSON.stringify({ kind: 'support', reason: 'sweep ticket' }) },
          a.token,
        )
      ).status,
    )
    check('GET /reports/mine', (await call('/reports/mine', {}, a.token)).status)
    check(
      'PUT /me/business',
      (
        await call(
          '/me/business',
          { method: 'PUT', body: JSON.stringify({ business_name: 'Sweep LLC' }) },
          a.token,
        )
      ).status,
    )
    // Admin endpoints exist (403 for non-admins, never 404)
    check('GET /admin/reports', (await call('/admin/reports', {}, a.token)).status)
    check(
      'POST /admin/users/:id/verify',
      (await call(`/admin/users/${b.id}/verify`, { method: 'POST' }, a.token)).status,
    )

    // Lifecycle, blocking, account surface
    const gid3 = await postGig(a.token)
    check('POST /gigs/:id/claim (3)', (await claim(gid3, b.token)).status)
    check(
      'POST /gigs/:id/done',
      (await call(`/gigs/${gid3}/done`, { method: 'POST' }, b.token)).status,
    )
    check(
      'POST /gigs/:id/unclaim',
      (await call(`/gigs/${gid3}/unclaim`, { method: 'POST' }, a.token)).status,
    )
    check(
      'POST /users/:id/block',
      (await call(`/users/${b.id}/block`, { method: 'POST' }, a.token)).status,
    )
    check('GET /me/blocks', (await call('/me/blocks', {}, a.token)).status)
    check(
      'DELETE /users/:id/block',
      (await call(`/users/${b.id}/block`, { method: 'DELETE' }, a.token)).status,
    )
    check('GET /admin/stats', (await call('/admin/stats', {}, a.token)).status)
    check(
      'POST /me/delete',
      (
        await call(
          '/me/delete',
          { method: 'POST', body: JSON.stringify({ password: 'wrong' }) },
          a.token,
        )
      ).status,
    )

    // Profiles + push surface
    check('GET /users/:id', (await call(`/users/${b.id}`, {}, a.token)).status)
    check('GET /users/:id/reviews', (await call(`/users/${b.id}/reviews`, {}, a.token)).status)
    check('GET /push/key', (await call('/push/key', {}, a.token)).status)
    check(
      'POST /push/subscribe',
      (
        await call(
          '/push/subscribe',
          {
            method: 'POST',
            body: JSON.stringify({
              endpoint: 'https://fcm.googleapis.com/fcm/send/sweep1',
              keys: { p256dh: 'k', auth: 'a' },
            }),
          },
          a.token,
        )
      ).status,
    )
    check(
      'DELETE /push/subscribe',
      (
        await call(
          '/push/subscribe',
          {
            method: 'DELETE',
            body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/sweep1' }),
          },
          a.token,
        )
      ).status,
    )

    expect(failures).toEqual([])
  })
})
