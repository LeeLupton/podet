import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { E, applySchema, call, clearRateLimits, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

async function makeAdmin(userId: string) {
  await E.DB.prepare('update users set is_admin = 1 where id = ?').bind(userId).run()
}

async function createPost(token: string) {
  const r = await call(
    '/posts',
    { method: 'POST', body: JSON.stringify({ body: 'reportable post' }) },
    token,
  )
  return r.body.id as string
}

describe('POST /reports', () => {
  it('files a content report (201)', async () => {
    const u = await register()
    const pid = await createPost(u.token)
    const r = await call(
      '/reports',
      { method: 'POST', body: JSON.stringify({ kind: 'post', subject_id: pid, reason: 'spam' }) },
      u.token,
    )
    expect(r.status).toBe(201)
  })

  it('files a support ticket without a subject (201)', async () => {
    const u = await register()
    const r = await call(
      '/reports',
      {
        method: 'POST',
        body: JSON.stringify({ kind: 'support', reason: 'app will not load my gigs' }),
      },
      u.token,
    )
    expect(r.status).toBe(201)
  })

  it('rejects an unknown kind (400)', async () => {
    const u = await register()
    const r = await call(
      '/reports',
      { method: 'POST', body: JSON.stringify({ kind: 'meme', subject_id: 'x', reason: 'r' }) },
      u.token,
    )
    expect(r.status).toBe(400)
  })

  it('rejects a content report without a subject (400)', async () => {
    const u = await register()
    const r = await call(
      '/reports',
      { method: 'POST', body: JSON.stringify({ kind: 'post', reason: 'spam' }) },
      u.token,
    )
    expect(r.status).toBe(400)
  })

  it('shows my tickets with status in /reports/mine', async () => {
    const u = await register()
    await call(
      '/reports',
      { method: 'POST', body: JSON.stringify({ kind: 'support', reason: 'help me' }) },
      u.token,
    )
    const mine = await call('/reports/mine', {}, u.token)
    expect(mine.body[0].status).toBe('OPEN')
  })
})

describe('admin gate', () => {
  it('blocks non-admins from the queue (403)', async () => {
    const u = await register()
    expect((await call('/admin/reports', {}, u.token)).status).toBe(403)
  })

  it('blocks non-admins from verifying users (403)', async () => {
    const u = await register()
    const target = await register()
    const r = await call(`/admin/users/${target.id}/verify`, { method: 'POST' }, u.token)
    expect(r.status).toBe(403)
  })
})

describe('admin actions', () => {
  it('lists reports and resolves one', async () => {
    const u = await register()
    const admin = await register()
    await makeAdmin(admin.id)
    await call(
      '/reports',
      { method: 'POST', body: JSON.stringify({ kind: 'support', reason: 'ticket' }) },
      u.token,
    )
    const list = await call('/admin/reports', {}, admin.token)
    expect(list.status).toBe(200)
    const open = list.body.find((r: any) => r.status === 'OPEN')
    const res = await call(`/admin/reports/${open.id}/resolve`, { method: 'POST' }, admin.token)
    expect(res.status).toBe(200)
  })

  it('verifies a business and the badge shows on the public profile', async () => {
    const biz = await register('Shop')
    const admin = await register()
    await makeAdmin(admin.id)
    await call(
      '/me/business',
      { method: 'PUT', body: JSON.stringify({ business_name: 'Shop LLC' }) },
      biz.token,
    )
    expect(
      (await call(`/admin/users/${biz.id}/verify`, { method: 'POST' }, admin.token)).status,
    ).toBe(200)
    const profile = await call(`/users/${biz.id}`, {}, admin.token)
    expect(profile.body.verified).toBe(1)
    expect(profile.body.business_name).toBe('Shop LLC')
  })

  it('changing the business name clears the badge', async () => {
    const biz = await register()
    const admin = await register()
    await makeAdmin(admin.id)
    await call(
      '/me/business',
      { method: 'PUT', body: JSON.stringify({ business_name: 'Old Name' }) },
      biz.token,
    )
    await call(`/admin/users/${biz.id}/verify`, { method: 'POST' }, admin.token)
    await call(
      '/me/business',
      { method: 'PUT', body: JSON.stringify({ business_name: 'New Name' }) },
      biz.token,
    )
    const profile = await call(`/users/${biz.id}`, {}, admin.token)
    expect(profile.body.verified).toBe(0)
  })

  it('admin removes a reported post (and a non-admin cannot)', async () => {
    const author = await register()
    const admin = await register()
    await makeAdmin(admin.id)
    const pid = await createPost(author.token)
    expect((await call(`/admin/posts/${pid}`, { method: 'DELETE' }, author.token)).status).toBe(403)
    expect((await call(`/admin/posts/${pid}`, { method: 'DELETE' }, admin.token)).status).toBe(200)
  })
})
