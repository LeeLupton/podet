import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  applySchema,
  call,
  claim,
  clearRateLimits,
  complete,
  postGig,
  register,
} from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

describe('POST /gigs/:id/complete', () => {
  it('rejects a non-owner (403)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await complete(gid, worker.token)).status).toBe(403)
  })

  it('rejects completing a gig that is not CLAIMED (409)', async () => {
    const hirer = await register()
    const gid = await postGig(hirer.token)
    expect((await complete(gid, hirer.token)).status).toBe(409)
  })

  it('rejects an out-of-range rating (400)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await complete(gid, hirer.token, 9)).status).toBe(400)
  })

  it('completes for the owner of a CLAIMED gig (200)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await complete(gid, hirer.token, 5, 'nice')).status).toBe(200)
  })

  it('increments the worker reputation (total_gigs, rating_count, average)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await complete(gid, hirer.token, 5)
    const p = await call(`/users/${worker.id}`, {}, hirer.token)
    expect(p.body.total_gigs).toBe(1)
    expect(p.body.rating_count).toBe(1)
    expect(p.body.average_rating).toBe(5)
  })

  it('removes the completed gig from the nearby feed', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await complete(gid, hirer.token, 4)
    const near = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, worker.token)
    expect(near.body.some((g: any) => g.id === gid)).toBe(false)
  })
})
