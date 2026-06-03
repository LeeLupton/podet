import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, claim, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

// Guards the route-ordering bug where '/gigs/:id' shadowed '/gigs/mine'.
describe('GET /gigs/mine', () => {
  it('returns posted and claimed arrays (200), not a 404 from :id', async () => {
    const u = await register()
    const r = await call('/gigs/mine', {}, u.token)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.posted)).toBe(true)
    expect(Array.isArray(r.body.claimed)).toBe(true)
  })

  it('lists a gig you posted under posted[]', async () => {
    const u = await register()
    const gid = await postGig(u.token)
    const r = await call('/gigs/mine', {}, u.token)
    expect(r.body.posted.some((g: any) => g.id === gid)).toBe(true)
  })

  it('lists a gig you claimed under claimed[]', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    const r = await call('/gigs/mine', {}, worker.token)
    expect(r.body.claimed.some((g: any) => g.id === gid)).toBe(true)
  })
})
