import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

function change(token: string, current_password: string, new_password: string) {
  return call(
    '/me/password',
    { method: 'POST', body: JSON.stringify({ current_password, new_password }) },
    token,
  )
}

describe('POST /me/password', () => {
  it('rejects a wrong current password (403)', async () => {
    const u = await register()
    expect((await change(u.token, 'not-my-password', 'newpassword1')).status).toBe(403)
  })

  it('rejects a too-short new password (400)', async () => {
    const u = await register()
    expect((await change(u.token, 'password123', 'short')).status).toBe(400)
  })

  it('requires authentication (401)', async () => {
    const r = await call('/me/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: 'a', new_password: 'bbbbbbbb' }),
    })
    expect(r.status).toBe(401)
  })

  it('changes the password: old stops working, new logs in', async () => {
    const u = await register()
    expect((await change(u.token, 'password123', 'newpassword1')).status).toBe(200)

    const oldLogin = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email: u.email, password: 'password123' }),
    })
    expect(oldLogin.status).toBe(401)

    const newLogin = await call('/login', {
      method: 'POST',
      body: JSON.stringify({ email: u.email, password: 'newpassword1' }),
    })
    expect(newLogin.status).toBe(200)
  })
})
