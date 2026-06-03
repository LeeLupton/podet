import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

async function createPost(token: string, body = 'Corner needs a bench') {
  const r = await call('/posts', { method: 'POST', body: JSON.stringify({ body }) }, token)
  expect(r.status).toBe(201)
  return r.body.id as string
}

describe('POST /posts', () => {
  it('creates a post (201)', async () => {
    const a = await register()
    expect(await createPost(a.token)).toBeTruthy()
  })

  it('rejects an empty body (400)', async () => {
    const a = await register()
    const r = await call(
      '/posts',
      { method: 'POST', body: JSON.stringify({ body: '   ' }) },
      a.token,
    )
    expect(r.status).toBe(400)
  })
})

describe('post comments & interest counts', () => {
  it('reflects a new comment in comment_count', async () => {
    const a = await register()
    const b = await register()
    const pid = await createPost(a.token)
    await call(
      `/posts/${pid}/comments`,
      { method: 'POST', body: JSON.stringify({ body: 'yes' }) },
      b.token,
    )
    const list = await call('/posts', {}, a.token)
    expect(list.body.find((p: any) => p.id === pid).comment_count).toBe(1)
  })

  it('reflects interest in interest_count and i_am_interested', async () => {
    const a = await register()
    const b = await register()
    const pid = await createPost(a.token)
    await call(`/posts/${pid}/interest`, { method: 'POST' }, b.token)
    const list = await call('/posts', {}, b.token)
    const post = list.body.find((p: any) => p.id === pid)
    expect(post.interest_count).toBe(1)
    expect(post.i_am_interested).toBeTruthy()
  })

  it('is idempotent: interest twice still counts once', async () => {
    const a = await register()
    const b = await register()
    const pid = await createPost(a.token)
    await call(`/posts/${pid}/interest`, { method: 'POST' }, b.token)
    await call(`/posts/${pid}/interest`, { method: 'POST' }, b.token)
    const list = await call('/posts', {}, a.token)
    expect(list.body.find((p: any) => p.id === pid).interest_count).toBe(1)
  })
})

describe('post ownership', () => {
  it('rejects a non-author delete (403)', async () => {
    const a = await register()
    const b = await register()
    const pid = await createPost(a.token)
    expect((await call(`/posts/${pid}`, { method: 'DELETE' }, b.token)).status).toBe(403)
  })

  it('lets the author edit (200)', async () => {
    const a = await register()
    const pid = await createPost(a.token)
    const r = await call(
      `/posts/${pid}`,
      { method: 'PUT', body: JSON.stringify({ body: 'updated' }) },
      a.token,
    )
    expect(r.status).toBe(200)
  })

  it('lets the author delete a post that has comments (cascade)', async () => {
    const a = await register()
    const b = await register()
    const pid = await createPost(a.token)
    await call(
      `/posts/${pid}/comments`,
      { method: 'POST', body: JSON.stringify({ body: 'hi' }) },
      b.token,
    )
    expect((await call(`/posts/${pid}`, { method: 'DELETE' }, a.token)).status).toBe(200)
  })
})
