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

describe('responses never leak PII', () => {
  it('a public profile omits password_hash and email', async () => {
    const viewer = await register()
    const target = await register()
    const r = await call(`/users/${target.id}`, {}, viewer.token)
    expect(r.raw).not.toContain('password_hash')
    expect(r.raw).not.toContain(target.email)
  })

  it('the nearby feed omits password_hash', async () => {
    const hirer = await register()
    const worker = await register()
    await postGig(hirer.token)
    const r = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5', {}, worker.token)
    expect(r.raw).not.toContain('password_hash')
  })

  it('worker reviews omit the worker’s hashed password', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await complete(gid, hirer.token, 5, 'ok')
    const r = await call(`/users/${worker.id}/reviews`, {}, hirer.token)
    expect(r.raw).not.toContain('password_hash')
  })

  it('/me returns the caller’s own email but never a hash', async () => {
    const me = await register()
    const r = await call('/me', {}, me.token)
    expect(r.body.email).toBe(me.email)
    expect(r.raw).not.toContain('password_hash')
  })
})
