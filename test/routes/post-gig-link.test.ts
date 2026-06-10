import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

describe('board→gig link (gig_count)', () => {
  it('is 0 for a fresh post', async () => {
    const u = await register()
    const created = await call(
      '/posts',
      { method: 'POST', body: JSON.stringify({ body: 'corner needs a bench' }) },
      u.token,
    )
    const list = await call('/posts', {}, u.token)
    expect(list.body.find((p: any) => p.id === created.body.id).gig_count).toBe(0)
  })

  it('increments when a gig is created with from_post_id', async () => {
    const u = await register()
    const created = await call(
      '/posts',
      { method: 'POST', body: JSON.stringify({ body: 'paint the fence' }) },
      u.token,
    )
    const pid = created.body.id
    await postGig(u.token, { from_post_id: pid })
    const list = await call('/posts', {}, u.token)
    expect(list.body.find((p: any) => p.id === pid).gig_count).toBe(1)
  })

  it('appears on the single-post view too', async () => {
    const u = await register()
    const created = await call(
      '/posts',
      { method: 'POST', body: JSON.stringify({ body: 'clear the lot' }) },
      u.token,
    )
    const pid = created.body.id
    await postGig(u.token, { from_post_id: pid })
    const single = await call(`/posts/${pid}`, {}, u.token)
    expect(single.body.gig_count).toBe(1)
  })
})
