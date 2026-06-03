import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

describe('GET /posts pagination', () => {
  it('respects the limit query', async () => {
    const a = await register()
    for (let i = 0; i < 5; i++) {
      await call('/posts', { method: 'POST', body: JSON.stringify({ body: `post ${i}` }) }, a.token)
    }
    const page = await call('/posts?limit=3', {}, a.token)
    expect(page.body).toHaveLength(3)
  })

  it('before returns strictly older rows than the cursor', async () => {
    const a = await register()
    for (let i = 0; i < 4; i++) {
      await call('/posts', { method: 'POST', body: JSON.stringify({ body: `p${i}` }) }, a.token)
    }
    const first = await call('/posts?limit=2', {}, a.token)
    const cursor = first.body[first.body.length - 1].created_at
    const next = await call(`/posts?limit=10&before=${encodeURIComponent(cursor)}`, {}, a.token)
    for (const p of next.body) expect(p.created_at < cursor).toBe(true)
  })
})
