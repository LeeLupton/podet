import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, claim, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

describe('POST /gigs/:id/claim', () => {
  it('lets another user claim an AVAILABLE gig (200)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    expect((await claim(gid, worker.token)).status).toBe(200)
  })

  it('rejects claiming your own gig (409)', async () => {
    const hirer = await register()
    const gid = await postGig(hirer.token)
    expect((await claim(gid, hirer.token)).status).toBe(409)
  })

  it('rejects a second claim on an already-claimed gig (409)', async () => {
    const hirer = await register()
    const worker = await register()
    const other = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await claim(gid, other.token)).status).toBe(409)
  })
})
