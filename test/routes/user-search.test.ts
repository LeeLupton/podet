import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

const search = (token: string, q: string) =>
  call(`/users/search?q=${encodeURIComponent(q)}`, {}, token)

describe('user search', () => {
  it('finds others by display name and annotates connection status', async () => {
    const me = await register('Seeker')
    const target = await register('Greenscape Lawns')
    const r = await search(me.token, 'greenscape')
    expect(r.status).toBe(200)
    const hit = r.body.find((u: any) => u.id === target.id)
    expect(hit).toBeTruthy()
    expect(hit.connection).toBe('none')

    await call(`/users/${target.id}/connect`, { method: 'POST' }, me.token)
    const after = await search(me.token, 'greenscape')
    expect(after.body.find((u: any) => u.id === target.id).connection).toBe('pending_out')
  })

  it('never returns yourself', async () => {
    const me = await register('Solo Mowing')
    const r = await search(me.token, 'solo')
    expect(r.body.find((u: any) => u.id === me.id)).toBeUndefined()
  })

  it('requires at least 2 characters', async () => {
    const me = await register('A')
    expect((await search(me.token, 'x')).body).toEqual([])
  })

  it('excludes users on either side of a block', async () => {
    const me = await register('Hedge Co')
    const other = await register('Blocked Bushes')
    await call(`/users/${other.id}/block`, { method: 'POST' }, me.token)
    expect((await search(me.token, 'bushes')).body).toHaveLength(0)
    // and the reverse direction
    const me2 = await register('Fence Folk')
    const blocker = await register('Wary Weeds')
    await call(`/users/${me2.id}/block`, { method: 'POST' }, blocker.token)
    expect((await search(me2.token, 'wary')).body).toHaveLength(0)
  })

  it('treats LIKE wildcards as literal text', async () => {
    const me = await register('Plain Name')
    // A query of pure wildcards must not match everyone.
    expect((await search(me.token, '%%')).body).toHaveLength(0)
  })

  it('matches a registered business name too', async () => {
    const me = await register('Looker')
    const biz = await register('Owner Person')
    await call(
      '/me/business',
      { method: 'PUT', body: JSON.stringify({ business_name: 'Acme Turf Care' }) },
      biz.token,
    )
    const r = await search(me.token, 'acme turf')
    expect(r.body.find((u: any) => u.id === biz.id)).toBeTruthy()
  })
})
