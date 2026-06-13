import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

const connect = (token: string, id: string) =>
  call(`/users/${id}/connect`, { method: 'POST' }, token)
const accept = (token: string, id: string) =>
  call(`/users/${id}/connect/accept`, { method: 'POST' }, token)
const dm = (token: string, id: string, body: string) =>
  call(`/dms/${id}`, { method: 'POST', body: JSON.stringify({ body }) }, token)

describe('profile connection status', () => {
  it('GET /users/:id reports the connection relationship for the viewer', async () => {
    const a = await register('A')
    const b = await register('B')
    expect((await call(`/users/${b.id}`, {}, a.token)).body.connection).toBe('none')
    await connect(a.token, b.id)
    expect((await call(`/users/${b.id}`, {}, a.token)).body.connection).toBe('pending_out')
    expect((await call(`/users/${a.id}`, {}, b.token)).body.connection).toBe('pending_in')
    await accept(b.token, a.id)
    expect((await call(`/users/${b.id}`, {}, a.token)).body.connection).toBe('connected')
    expect((await call(`/users/${a.id}`, {}, b.token)).body.connection).toBe('connected')
  })
})

describe('connection lifecycle', () => {
  it('request → accept makes both sides connected', async () => {
    const a = await register('A')
    const b = await register('B')
    const r = await connect(a.token, b.id)
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('pending_out')
    // b sees an incoming request
    expect((await call('/me/connections', {}, b.token)).body.incoming).toHaveLength(1)
    expect((await accept(b.token, a.id)).status).toBe(200)
    expect((await call('/me/connections', {}, a.token)).body.connected).toHaveLength(1)
    expect((await call('/me/connections', {}, b.token)).body.connected).toHaveLength(1)
  })

  it('a reciprocal request auto-accepts', async () => {
    const a = await register('A')
    const b = await register('B')
    await connect(a.token, b.id)
    const back = await connect(b.token, a.id)
    expect(back.body.status).toBe('connected')
    expect((await call('/me/connections', {}, a.token)).body.connected).toHaveLength(1)
  })

  it('cannot connect with yourself (400)', async () => {
    const a = await register('A')
    expect((await connect(a.token, a.id)).status).toBe(400)
  })

  it('accept with no pending request is a 404', async () => {
    const a = await register('A')
    const b = await register('B')
    expect((await accept(b.token, a.id)).status).toBe(404)
  })

  it('disconnect removes the link either way', async () => {
    const a = await register('A')
    const b = await register('B')
    await connect(a.token, b.id)
    await accept(b.token, a.id)
    expect((await call(`/users/${b.id}/connect`, { method: 'DELETE' }, a.token)).status).toBe(200)
    expect((await call('/me/connections', {}, a.token)).body.connected).toHaveLength(0)
  })
})

describe('direct messages require an accepted connection', () => {
  it('rejects messaging before connecting (403)', async () => {
    const a = await register('A')
    const b = await register('B')
    expect((await dm(a.token, b.id, 'hi')).status).toBe(403)
  })

  it('allows messaging once connected, readable by both', async () => {
    const a = await register('A')
    const b = await register('B')
    await connect(a.token, b.id)
    await accept(b.token, a.id)
    expect((await dm(a.token, b.id, 'want to split the Oak St block?')).status).toBe(201)
    expect((await dm(b.token, a.id, 'sure')).status).toBe(201)
    const thread = await call(`/dms/${a.id}`, {}, b.token)
    expect(thread.body).toHaveLength(2)
  })

  it('blocks messaging across a block even when connected (403)', async () => {
    const a = await register('A')
    const b = await register('B')
    await connect(a.token, b.id)
    await accept(b.token, a.id)
    await call(`/users/${a.id}/block`, { method: 'POST' }, b.token)
    expect((await dm(a.token, b.id, 'hello?')).status).toBe(403)
  })
})
