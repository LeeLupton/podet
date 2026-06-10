import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, claim, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

function block(token: string, targetId: string) {
  return call(`/users/${targetId}/block`, { method: 'POST' }, token)
}

describe('blocking gates the message thread', () => {
  it('blocked parties can no longer read or write an existing thread (403)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    // thread works before the block
    expect(
      (
        await call(
          `/gigs/${gid}/messages`,
          { method: 'POST', body: JSON.stringify({ body: 'hello' }) },
          worker.token,
        )
      ).status,
    ).toBe(201)
    await block(hirer.token, worker.id)
    // both read and write are sealed, for both parties
    expect((await call(`/gigs/${gid}/messages`, {}, worker.token)).status).toBe(403)
    expect((await call(`/gigs/${gid}/messages`, {}, hirer.token)).status).toBe(403)
    expect(
      (
        await call(
          `/gigs/${gid}/messages`,
          { method: 'POST', body: JSON.stringify({ body: 'still there?' }) },
          worker.token,
        )
      ).status,
    ).toBe(403)
  })
})

describe('blocking gates detail views (direct links)', () => {
  it('a blocked author’s post 404s and their comments vanish from other posts', async () => {
    const a = await register()
    const b = await register()
    const aPost = await call(
      '/posts',
      { method: 'POST', body: JSON.stringify({ body: 'post by A' }) },
      a.token,
    )
    const bPost = await call(
      '/posts',
      { method: 'POST', body: JSON.stringify({ body: 'post by B' }) },
      b.token,
    )
    await call(
      `/posts/${aPost.body.id}/comments`,
      { method: 'POST', body: JSON.stringify({ body: 'comment by B' }) },
      b.token,
    )
    await block(a.token, b.id)
    // B's post is gone for A even by direct id
    expect((await call(`/posts/${bPost.body.id}`, {}, a.token)).status).toBe(404)
    // A's own post stays, but B's comment inside it is filtered
    const own = await call(`/posts/${aPost.body.id}`, {}, a.token)
    expect(own.status).toBe(200)
    expect(own.body.comments).toHaveLength(0)
  })

  it('a blocked poster’s gig 404s by direct id', async () => {
    const a = await register()
    const b = await register()
    const gid = await postGig(b.token)
    await block(a.token, b.id)
    expect((await call(`/gigs/${gid}`, {}, a.token)).status).toBe(404)
  })

  it('gig parties still see their own gig despite a block', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await block(hirer.token, worker.id)
    expect((await call(`/gigs/${gid}`, {}, worker.token)).status).toBe(200)
    expect((await call(`/gigs/${gid}`, {}, hirer.token)).status).toBe(200)
  })
})

describe('blocking and profiles', () => {
  it('someone who blocked you reads as not found; your own block keeps the profile visible', async () => {
    const a = await register()
    const b = await register()
    await block(a.token, b.id)
    // B cannot see A (A blocked B)
    expect((await call(`/users/${a.id}`, {}, b.token)).status).toBe(404)
    // A still sees B (to be able to unblock), with the flag set
    const p = await call(`/users/${b.id}`, {}, a.token)
    expect(p.status).toBe(200)
    expect(p.body.i_blocked).toBe(1)
  })
})

describe('account deletion cleanup', () => {
  it('a deleted account 404s as a profile and its open gigs leave the feed', async () => {
    const hirer = await register()
    const other = await register()
    const gid = await postGig(hirer.token)
    await call(
      '/me/delete',
      { method: 'POST', body: JSON.stringify({ password: 'password123' }) },
      hirer.token,
    )
    expect((await call(`/users/${hirer.id}`, {}, other.token)).status).toBe(404)
    const near = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, other.token)
    expect(near.body.some((g: any) => g.id === gid)).toBe(false)
    expect((await call(`/gigs/${gid}`, {}, other.token)).status).toBe(404)
  })

  it('completed gigs survive deletion (ledger intact)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await call(
      `/gigs/${gid}/complete`,
      { method: 'POST', body: JSON.stringify({ rating: 5 }) },
      hirer.token,
    )
    await call(
      '/me/delete',
      { method: 'POST', body: JSON.stringify({ password: 'password123' }) },
      hirer.token,
    )
    const reviews = await call(`/users/${worker.id}/reviews`, {}, worker.token)
    expect(reviews.body).toHaveLength(1)
  })
})
