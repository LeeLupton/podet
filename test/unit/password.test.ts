import { describe, expect, it } from 'vitest'
import {
  DUMMY_PASSWORD_HASH,
  b64decode,
  b64encode,
  hashPassword,
  timingSafeEqual,
  verifyPassword,
} from '../../functions/lib/password'

describe('b64encode / b64decode', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect(Array.from(b64decode(b64encode(bytes)))).toEqual([0, 1, 2, 250, 255])
  })
})

describe('timingSafeEqual', () => {
  it('is true for identical arrays', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
  })
  it('is false for differing contents', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
  })
  it('is false for differing lengths', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})

describe('hashPassword', () => {
  it('produces the pbkdf2$iters$salt$hash encoding', async () => {
    const enc = await hashPassword('hunter2123')
    const parts = enc.split('$')
    expect(parts[0]).toBe('pbkdf2')
    expect(Number(parts[1])).toBeGreaterThan(0)
    expect(parts).toHaveLength(4)
  })

  it('uses a random salt (two hashes of the same password differ)', async () => {
    expect(await hashPassword('samepass1')).not.toBe(await hashPassword('samepass1'))
  })
})

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const enc = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', enc)).toBe(true)
  })
  it('rejects the wrong password', async () => {
    const enc = await hashPassword('correct horse')
    expect(await verifyPassword('wrong horse', enc)).toBe(false)
  })
  it('rejects a malformed encoding', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false)
    expect(await verifyPassword('x', 'scheme$1$a$b')).toBe(false)
  })
  it('the dummy hash is well-formed but matches nothing', async () => {
    expect(DUMMY_PASSWORD_HASH.startsWith('pbkdf2$')).toBe(true)
    expect(await verifyPassword('anything', DUMMY_PASSWORD_HASH)).toBe(false)
  })
})
