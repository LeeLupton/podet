import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, claim, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

describe('session revocation (epochs)', () => {
  it('a password change invalidates the old token but the caller stays logged in', async () => {
    const u = await register()
    expect((await call('/me', {}, u.token)).status).toBe(200)
    const ch = await call(
      '/me/password',
      {
        method: 'POST',
        body: JSON.stringify({ current_password: 'password123', new_password: 'newpassword1' }),
      },
      u.token,
    )
    expect(ch.status).toBe(200)
    expect((await call('/me', {}, u.token)).status).toBe(401)
    const login = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email: u.email, password: 'newpassword1' }),
    })
    expect(login.status).toBe(200)
    expect((await call('/me', {}, login.body.token)).status).toBe(200)
  })
})

describe('account deletion', () => {
  it('requires the correct password (403)', async () => {
    const u = await register()
    expect(
      (
        await call(
          '/me/delete',
          { method: 'POST', body: JSON.stringify({ password: 'wrong' }) },
          u.token,
        )
      ).status,
    ).toBe(403)
  })

  it('closes the account: token dies, login fails', async () => {
    const u = await register('Real Name')
    const del = await call(
      '/me/delete',
      { method: 'POST', body: JSON.stringify({ password: 'password123' }) },
      u.token,
    )
    expect(del.status).toBe(200)
    expect((await call('/me', {}, u.token)).status).toBe(401)
    const login = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email: u.email, password: 'password123' }),
    })
    expect(login.status).toBe(401)
  })
})

describe('hirer can remove a no-show; worker can mark done', () => {
  it('unclaim is hirer-only and reopens the gig', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await call(`/gigs/${gid}/unclaim`, { method: 'POST' }, worker.token)).status).toBe(403)
    expect((await call(`/gigs/${gid}/unclaim`, { method: 'POST' }, hirer.token)).status).toBe(200)
    const g = await call(`/gigs/${gid}`, {}, hirer.token)
    expect(g.body.status).toBe('AVAILABLE')
    expect(g.body.claimed_by).toBeNull()
  })

  it('mark-done is worker-only and sets done_at', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await call(`/gigs/${gid}/done`, { method: 'POST' }, hirer.token)).status).toBe(403)
    expect((await call(`/gigs/${gid}/done`, { method: 'POST' }, worker.token)).status).toBe(200)
    const g = await call(`/gigs/${gid}`, {}, hirer.token)
    expect(g.body.done_at).toBeTruthy()
  })
})

describe('window edit + expiry', () => {
  const DAY = 86_400_000
  it('PUT /gigs updates the window', async () => {
    const hirer = await register()
    const gid = await postGig(hirer.token)
    const ws = new Date(Date.now() + 2 * DAY).toISOString()
    const we = new Date(Date.now() + 3 * DAY).toISOString()
    const r = await call(
      `/gigs/${gid}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          task_type: 'x',
          neighborhood: 'n',
          cash_payout: 10,
          est_hours: 1,
          lat: 34.72,
          lng: -76.66,
          description: 'd',
          window_start: ws,
          window_end: we,
          notice_hours: 2,
        }),
      },
      hirer.token,
    )
    expect(r.status).toBe(200)
    const g = await call(`/gigs/${gid}`, {}, hirer.token)
    expect(g.body.window_start).toBe(ws)
    expect(g.body.notice_hours).toBe(2)
  })

  it('nearby hides gigs whose window already ended', async () => {
    const hirer = await register()
    const worker = await register()
    const past1 = new Date(Date.now() - 2 * DAY).toISOString()
    const past2 = new Date(Date.now() - 1 * DAY).toISOString()
    const gid = await postGig(hirer.token, { window_start: past1, window_end: past2 })
    const near = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, worker.token)
    expect(near.body.some((g: any) => g.id === gid)).toBe(false)
  })
})

describe('blocking', () => {
  it("hides a blocked user's gigs from nearby and blocks claiming", async () => {
    const me = await register()
    const them = await register()
    const gid = await postGig(them.token)
    let near = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, me.token)
    expect(near.body.some((g: any) => g.id === gid)).toBe(true)
    expect((await call(`/users/${them.id}/block`, { method: 'POST' }, me.token)).status).toBe(200)
    near = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, me.token)
    expect(near.body.some((g: any) => g.id === gid)).toBe(false)
    expect((await claim(gid, me.token)).status).toBe(409)
    expect((await call('/me/blocks', {}, me.token)).body).toHaveLength(1)
    await call(`/users/${them.id}/block`, { method: 'DELETE' }, me.token)
    near = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, me.token)
    expect(near.body.some((g: any) => g.id === gid)).toBe(true)
  })

  it('cannot block yourself (400)', async () => {
    const me = await register()
    expect((await call(`/users/${me.id}/block`, { method: 'POST' }, me.token)).status).toBe(400)
  })
})

describe('hirer accountability counts', () => {
  it('reports gigs_posted and gigs_paid on the public profile', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await call(
      `/gigs/${gid}/complete`,
      { method: 'POST', body: JSON.stringify({ rating: 5 }) },
      hirer.token,
    )
    await postGig(hirer.token)
    const p = await call(`/users/${hirer.id}`, {}, worker.token)
    expect(p.body.gigs_posted).toBe(2)
    expect(p.body.gigs_paid).toBe(1)
  })
})

describe('admin stats gate', () => {
  it('blocks non-admins (403)', async () => {
    const u = await register()
    expect((await call('/admin/stats', {}, u.token)).status).toBe(403)
  })
})

describe('content-creation rate limits', () => {
  it('caps rapid gig creation (429 past the window limit)', async () => {
    const u = await register()
    let limited = false
    for (let i = 0; i < 17; i++) {
      const r = await call(
        '/gigs',
        {
          method: 'POST',
          body: JSON.stringify({
            task_type: `t${i}`,
            neighborhood: 'n',
            cash_payout: 1,
            est_hours: 1,
            lat: 34.72,
            lng: -76.66,
            description: 'd',
          }),
        },
        u.token,
      )
      if (r.status === 429) limited = true
    }
    expect(limited).toBe(true)
  })
})
