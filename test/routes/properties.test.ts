import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { E, applySchema, call, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(async () => {
  await clearRateLimits()
  // Properties persist across tests in the shared per-file DB; the count tests
  // need a clean slate so earlier fixtures don't inflate neighbor counts.
  await E.DB.prepare('delete from properties').run()
})

const base = { lat: 34.72, lng: -76.66 }
const adjacent = { lat: 34.72, lng: -76.6594 } // ~55 m — within the ~80 m threshold
const farAway = { lat: 34.8, lng: -76.66 } // miles off

function addProperty(token: string, label: string, lat: number, lng: number) {
  return call(
    '/me/properties',
    { method: 'POST', body: JSON.stringify({ label, lat, lng }) },
    token,
  )
}

describe('properties CRUD', () => {
  it('adds, lists, and removes a property; only the owner sees it', async () => {
    const u = await register('Owner')
    expect((await addProperty(u.token, 'Oak St', base.lat, base.lng)).status).toBe(201)
    const list = await call('/me/properties', {}, u.token)
    expect(list.body).toHaveLength(1)
    const id = list.body[0].id
    expect((await call(`/me/properties/${id}`, { method: 'DELETE' }, u.token)).status).toBe(200)
    expect((await call('/me/properties', {}, u.token)).body).toHaveLength(0)
  })

  it('rejects a missing label or invalid coords (400)', async () => {
    const u = await register()
    expect((await addProperty(u.token, '', base.lat, base.lng)).status).toBe(400)
    expect((await addProperty(u.token, 'x', 999, 0)).status).toBe(400)
  })

  it("a stranger cannot delete someone else's property (404)", async () => {
    const owner = await register()
    const stranger = await register()
    const id = (await addProperty(owner.token, 'Oak St', base.lat, base.lng)).body.id
    expect((await call(`/me/properties/${id}`, { method: 'DELETE' }, stranger.token)).status).toBe(
      404,
    )
  })
})

describe('neighbor tag on gigs', () => {
  it('tags a gig adjacent to one of YOUR properties, and not a far one', async () => {
    const hirer = await register('Hirer')
    const me = await register('Me')
    await addProperty(me.token, 'My place', base.lat, base.lng)
    const near = await postGig(hirer.token, { lat: adjacent.lat, lng: adjacent.lng })
    const far = await postGig(hirer.token, { lat: farAway.lat, lng: farAway.lng })

    const feed = await call('/gigs/near?lat=34.72&lng=-76.66&radius=25', {}, me.token)
    const nearGig = feed.body.find((g: any) => g.id === near)
    const farGig = feed.body.find((g: any) => g.id === far)
    expect(nearGig.neighbor).toBe(1)
    expect(farGig.neighbor).toBe(0)

    const detail = await call(`/gigs/${near}`, {}, me.token)
    expect(detail.body.neighbor).toBe(1)
  })

  it('is 0 for a viewer with no properties', async () => {
    const hirer = await register()
    const viewer = await register()
    const gid = await postGig(hirer.token, { lat: base.lat, lng: base.lng })
    const detail = await call(`/gigs/${gid}`, {}, viewer.token)
    expect(detail.body.neighbor).toBe(0)
  })
})

describe('neighbor tag on profiles', () => {
  it('two users with adjacent properties see each other as neighbors', async () => {
    const a = await register('A')
    const b = await register('B')
    await addProperty(a.token, 'A place', base.lat, base.lng)
    await addProperty(b.token, 'B place', adjacent.lat, adjacent.lng)
    expect((await call(`/users/${b.id}`, {}, a.token)).body.neighbor).toBe(1)
    expect((await call(`/users/${a.id}`, {}, b.token)).body.neighbor).toBe(1)
  })

  it('is 0 when properties are far apart or absent', async () => {
    const a = await register('A')
    const b = await register('B')
    await addProperty(a.token, 'A place', base.lat, base.lng)
    await addProperty(b.token, 'B place', farAway.lat, farAway.lng)
    expect((await call(`/users/${b.id}`, {}, a.token)).body.neighbor).toBe(0)
  })

  it('never exposes another user’s property coordinates', async () => {
    const a = await register('A')
    const b = await register('B')
    await addProperty(b.token, 'secret', base.lat, base.lng)
    const profile = await call(`/users/${b.id}`, {}, a.token)
    expect(JSON.stringify(profile.body)).not.toContain('secret')
    expect(profile.body.lat).toBeUndefined()
    expect(profile.body.lng).toBeUndefined()
  })
})

describe('public neighbor count on profiles', () => {
  it('counts distinct adjacent landscapers and ignores far ones', async () => {
    const a = await register('A')
    const n1 = await register('N1')
    const n2 = await register('N2')
    const farUser = await register('Far')
    await addProperty(a.token, 'A', base.lat, base.lng)
    await addProperty(n1.token, 'N1', adjacent.lat, adjacent.lng)
    await addProperty(n2.token, 'N2', base.lat, base.lng) // same spot — adjacent
    await addProperty(farUser.token, 'Far', farAway.lat, farAway.lng)

    // a's profile reports 2 neighbors (n1, n2), not the far user
    expect((await call(`/users/${a.id}`, {}, n1.token)).body.neighbor_count).toBe(2)
    // a far user has no neighbors
    expect((await call(`/users/${farUser.id}`, {}, a.token)).body.neighbor_count).toBe(0)
  })

  it('counts each neighbor once even with several adjacent properties', async () => {
    const a = await register('A')
    const n = await register('N')
    await addProperty(a.token, 'A1', base.lat, base.lng)
    await addProperty(n.token, 'N1', adjacent.lat, adjacent.lng)
    await addProperty(n.token, 'N2', base.lat, base.lng) // also adjacent to A1
    expect((await call(`/users/${a.id}`, {}, n.token)).body.neighbor_count).toBe(1)
  })

  it('is 0 for a user with no properties', async () => {
    const a = await register('A')
    expect((await call(`/users/${a.id}`, {}, a.token)).body.neighbor_count).toBe(0)
  })
})
