import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, claim, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

const connectPair = async (a: any, b: any) => {
  await call(`/users/${b.id}/connect`, { method: 'POST' }, a.token)
  await call(`/users/${a.id}/connect/accept`, { method: 'POST' }, b.token)
}

describe('unread badge count', () => {
  it('counts an incoming direct message and clears once read', async () => {
    const a = await register('A')
    const b = await register('B')
    await connectPair(a, b)
    await call(`/dms/${b.id}`, { method: 'POST', body: JSON.stringify({ body: 'hey' }) }, a.token)

    // b has 1 unread; a (the sender) has 0
    expect((await call('/me/unread', {}, b.token)).body.messages).toBe(1)
    expect((await call('/me/unread', {}, a.token)).body.messages).toBe(0)

    // b reads the thread → back to 0
    await call(
      '/reads',
      { method: 'POST', body: JSON.stringify({ scope: 'dm', scope_id: a.id }) },
      b.token,
    )
    expect((await call('/me/unread', {}, b.token)).body.messages).toBe(0)
  })

  it('counts an unread gig message for the other party only', async () => {
    const hirer = await register('H')
    const worker = await register('W')
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await call(
      `/gigs/${gid}/messages`,
      { method: 'POST', body: JSON.stringify({ body: 'gate code?' }) },
      hirer.token,
    )
    expect((await call('/me/unread', {}, worker.token)).body.messages).toBe(1)
    expect((await call('/me/unread', {}, hirer.token)).body.messages).toBe(0)
    await call(
      '/reads',
      { method: 'POST', body: JSON.stringify({ scope: 'gig', scope_id: gid }) },
      worker.token,
    )
    expect((await call('/me/unread', {}, worker.token)).body.messages).toBe(0)
  })

  it('folds a pending connection request into the badge total', async () => {
    const a = await register('A')
    const b = await register('B')
    await call(`/users/${b.id}/connect`, { method: 'POST' }, a.token)
    const u = await call('/me/unread', {}, b.token)
    expect(u.body.requests).toBe(1)
    expect(u.body.unread).toBe(1)
  })

  it('returns a per-thread breakdown so the UI can mark which conversation is new', async () => {
    const a = await register('A')
    const b = await register('B')
    await connectPair(a, b)
    await call(`/dms/${b.id}`, { method: 'POST', body: JSON.stringify({ body: 'one' }) }, a.token)
    await call(`/dms/${b.id}`, { method: 'POST', body: JSON.stringify({ body: 'two' }) }, a.token)
    const u = await call('/me/unread', {}, b.token)
    expect(u.body.threads.dm[a.id]).toBe(2)
    expect(u.body.messages).toBe(2)
  })

  it('rejects a bad scope (400)', async () => {
    const a = await register('A')
    expect(
      (
        await call(
          '/reads',
          { method: 'POST', body: JSON.stringify({ scope: 'x', scope_id: '1' }) },
          a.token,
        )
      ).status,
    ).toBe(400)
  })
})
