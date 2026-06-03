import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  applySchema,
  call,
  claim,
  clearRateLimits,
  complete,
  postGig,
  rawRequest,
  register,
} from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

function upload(gid: string, token: string, type = 'image/png', bytes: Uint8Array = PNG) {
  return call(
    `/gigs/${gid}/photos`,
    { method: 'POST', headers: { 'content-type': type }, body: bytes },
    token,
  )
}

// A gig claimed by `worker`, posted by `hirer`.
async function claimedGig() {
  const hirer = await register('Hirer')
  const worker = await register('Worker')
  const gid = await postGig(hirer.token)
  await claim(gid, worker.token)
  return { hirer, worker, gid }
}

describe('POST /gigs/:id/photos', () => {
  it('lets the hirer upload on a CLAIMED gig (201)', async () => {
    const { hirer, gid } = await claimedGig()
    const r = await upload(gid, hirer.token)
    expect(r.status).toBe(201)
    expect(r.body.key).toMatch(new RegExp(`^gigs/${gid}/`))
  })

  it('rejects a non-hirer upload (403)', async () => {
    const { worker, gid } = await claimedGig()
    expect((await upload(gid, worker.token)).status).toBe(403)
  })

  it('rejects upload on an AVAILABLE (unclaimed) gig (409)', async () => {
    const hirer = await register()
    const gid = await postGig(hirer.token)
    expect((await upload(gid, hirer.token)).status).toBe(409)
  })

  it('rejects a non-image content-type (400)', async () => {
    const { hirer, gid } = await claimedGig()
    expect((await upload(gid, hirer.token, 'application/pdf')).status).toBe(400)
  })

  it('caps the number of photos per gig (409 past the limit)', async () => {
    const { hirer, gid } = await claimedGig()
    let limited = false
    for (let i = 0; i < 7; i++) {
      if ((await upload(gid, hirer.token)).status === 409) limited = true
    }
    expect(limited).toBe(true)
  })
})

describe('GET /img/:key', () => {
  it('returns the stored bytes', async () => {
    const { hirer, gid } = await claimedGig()
    const { body } = await upload(gid, hirer.token)
    const res = await rawRequest(`/img/${body.key}`, {}, hirer.token)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(PNG.byteLength)
  })

  it('404s for an unknown key', async () => {
    const { hirer } = await claimedGig()
    const res = await rawRequest('/img/gigs/none/none.png', {}, hirer.token)
    expect(res.status).toBe(404)
  })
})

describe('photos surface on the worker portfolio', () => {
  it('a completed gig review carries its photos', async () => {
    const { hirer, worker, gid } = await claimedGig()
    await upload(gid, hirer.token)
    await complete(gid, hirer.token, 5)
    const reviews = await call(`/users/${worker.id}/reviews`, {}, hirer.token)
    expect(reviews.body[0].photos).toHaveLength(1)
  })
})
