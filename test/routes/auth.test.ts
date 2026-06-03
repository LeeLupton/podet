import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, register, uniqueEmail } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

describe('POST /register', () => {
  it('creates a user and returns a token (201)', async () => {
    const r = await call('/register', {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
    })
    expect(r.status).toBe(201)
    expect(r.body.token).toBeTruthy()
  })

  it('rejects a duplicate email (409)', async () => {
    const email = uniqueEmail()
    await call('/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'password123' }),
    })
    const dup = await call('/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'password123' }),
    })
    expect(dup.status).toBe(409)
  })

  it('rejects a short password (400)', async () => {
    const r = await call('/register', {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail(), password: 'short' }),
    })
    expect(r.status).toBe(400)
  })

  it('rate-limits after the 5th attempt in a window (429)', async () => {
    let limited = false
    for (let i = 0; i < 7; i++) {
      const r = await call('/register', {
        method: 'POST',
        body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
      })
      if (r.status === 429) limited = true
    }
    expect(limited).toBe(true)
  })
})

describe('POST /login', () => {
  it('accepts correct credentials (200)', async () => {
    const { email } = await register()
    const r = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'password123' }),
    })
    expect(r.status).toBe(200)
  })

  it('rejects a wrong password (401)', async () => {
    const { email } = await register()
    const r = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'nope12345' }),
    })
    expect(r.status).toBe(401)
  })

  it('returns the same error for unknown email as for wrong password (no enumeration)', async () => {
    const { email } = await register()
    const wrong = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'nope12345' }),
    })
    const unknown = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com', password: 'nope12345' }),
    })
    expect(unknown.status).toBe(401)
    expect(unknown.body.error).toBe(wrong.body.error)
  })
})

describe('auth middleware', () => {
  it('rejects an unauthenticated protected request (401)', async () => {
    const r = await call('/gigs/near?lat=34.72&lng=-76.66&radius=5')
    expect(r.status).toBe(401)
  })

  it('rejects an invalid bearer token (401)', async () => {
    const r = await call('/me', {}, 'not-a-real-token')
    expect(r.status).toBe(401)
  })
})
