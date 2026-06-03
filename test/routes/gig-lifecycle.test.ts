import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, claim, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

const editBody = (over = {}) =>
  JSON.stringify({
    task_type: 'Mow',
    neighborhood: 'Front St',
    cash_payout: 50,
    est_hours: 1,
    lat: 34.72,
    lng: -76.66,
    description: 'edited',
    ...over,
  })

describe('PUT /gigs/:id', () => {
  it('lets the owner edit an AVAILABLE gig (200)', async () => {
    const hirer = await register()
    const gid = await postGig(hirer.token)
    expect(
      (await call(`/gigs/${gid}`, { method: 'PUT', body: editBody() }, hirer.token)).status,
    ).toBe(200)
  })

  it('rejects a non-owner edit (403)', async () => {
    const hirer = await register()
    const other = await register()
    const gid = await postGig(hirer.token)
    expect(
      (await call(`/gigs/${gid}`, { method: 'PUT', body: editBody() }, other.token)).status,
    ).toBe(403)
  })

  it('rejects editing once CLAIMED (403)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect(
      (await call(`/gigs/${gid}`, { method: 'PUT', body: editBody() }, hirer.token)).status,
    ).toBe(403)
  })
})

describe('DELETE /gigs/:id', () => {
  it('lets the owner delete an AVAILABLE gig (200)', async () => {
    const hirer = await register()
    const gid = await postGig(hirer.token)
    expect((await call(`/gigs/${gid}`, { method: 'DELETE' }, hirer.token)).status).toBe(200)
  })

  it('rejects deleting a COMPLETED gig (403)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await call(
      `/gigs/${gid}/complete`,
      { method: 'POST', body: JSON.stringify({ rating: 5 }) },
      hirer.token,
    )
    expect((await call(`/gigs/${gid}`, { method: 'DELETE' }, hirer.token)).status).toBe(403)
  })
})

describe('POST /gigs/:id/abandon', () => {
  it('lets the claimer release a CLAIMED gig (200)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await call(`/gigs/${gid}/abandon`, { method: 'POST' }, worker.token)).status).toBe(200)
  })

  it('rejects abandon by a non-claimer (403)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await call(`/gigs/${gid}/abandon`, { method: 'POST' }, hirer.token)).status).toBe(403)
  })

  it('returns the gig to AVAILABLE so it shows in the feed again', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await call(`/gigs/${gid}/abandon`, { method: 'POST' }, worker.token)
    const near = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, worker.token)
    expect(near.body.some((g: any) => g.id === gid)).toBe(true)
  })
})
