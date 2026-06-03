import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

const sub = {
  endpoint: 'https://push.example.com/abc',
  keys: { p256dh: 'BPEXAMPLEp256dh', auth: 'authsecret' },
}

describe('GET /push/key', () => {
  it('returns null when VAPID is not configured in the env', async () => {
    const u = await register()
    const r = await call('/push/key', {}, u.token)
    expect(r.status).toBe(200)
    expect(r.body.key).toBeNull()
  })
})

describe('POST /push/subscribe', () => {
  it('stores a valid subscription (201)', async () => {
    const u = await register()
    const r = await call('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }, u.token)
    expect(r.status).toBe(201)
  })

  it('rejects a body missing keys (400)', async () => {
    const u = await register()
    const r = await call(
      '/push/subscribe',
      { method: 'POST', body: JSON.stringify({ endpoint: 'https://x/y' }) },
      u.token,
    )
    expect(r.status).toBe(400)
  })

  it('requires authentication (401)', async () => {
    const r = await call('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) })
    expect(r.status).toBe(401)
  })

  it('is idempotent on the same endpoint (upsert)', async () => {
    const u = await register()
    await call('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }, u.token)
    const again = await call(
      '/push/subscribe',
      { method: 'POST', body: JSON.stringify(sub) },
      u.token,
    )
    expect(again.status).toBe(201)
  })
})

describe('DELETE /push/subscribe', () => {
  it('removes the caller’s subscription (200)', async () => {
    const u = await register()
    await call('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }, u.token)
    const r = await call(
      '/push/subscribe',
      { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) },
      u.token,
    )
    expect(r.status).toBe(200)
  })
})
