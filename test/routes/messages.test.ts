import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, claim, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

function send(gid: string, token: string, body = 'hello') {
  return call(`/gigs/${gid}/messages`, { method: 'POST', body: JSON.stringify({ body }) }, token)
}

describe('gig messages', () => {
  it('rejects messaging before the gig is claimed (409)', async () => {
    const hirer = await register()
    const gid = await postGig(hirer.token)
    expect((await send(gid, hirer.token)).status).toBe(409)
  })

  it('rejects a third party reading the thread (403)', async () => {
    const hirer = await register()
    const worker = await register()
    const other = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await call(`/gigs/${gid}/messages`, {}, other.token)).status).toBe(403)
  })

  it('rejects a third party sending (403)', async () => {
    const hirer = await register()
    const worker = await register()
    const other = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await send(gid, other.token)).status).toBe(403)
  })

  it('hirer and worker exchange messages, ordered oldest-first', async () => {
    const hirer = await register('H')
    const worker = await register('W')
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await send(gid, hirer.token, 'gate code is 4242')).status).toBe(201)
    expect((await send(gid, worker.token, 'got it, see you then')).status).toBe(201)
    const thread = await call(`/gigs/${gid}/messages`, {}, worker.token)
    expect(thread.status).toBe(200)
    expect(thread.body).toHaveLength(2)
    expect(thread.body[0].body).toBe('gate code is 4242')
    expect(thread.body[1].sender_name).toBe('W')
  })

  it('rejects an empty message (400)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await send(gid, hirer.token, '   ')).status).toBe(400)
  })
})
