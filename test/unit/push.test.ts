import { describe, expect, it } from 'vitest'
import {
  b64urlDecode,
  b64urlEncode,
  buildContentHeader,
  buildVapidJwt,
  concatBytes,
  encryptPayload,
  hkdf,
  vapidAuthHeader,
} from '../../functions/lib/push'

describe('b64url', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128])
    expect(Array.from(b64urlDecode(b64urlEncode(bytes)))).toEqual([0, 1, 2, 250, 255, 128])
  })
  it('emits url-safe chars with no padding', () => {
    const s = b64urlEncode(new Uint8Array([251, 255, 191]))
    expect(s).not.toMatch(/[+/=]/)
  })
})

describe('concatBytes', () => {
  it('joins arrays in order', () => {
    expect(Array.from(concatBytes(new Uint8Array([1, 2]), new Uint8Array([3])))).toEqual([1, 2, 3])
  })
})

describe('buildContentHeader', () => {
  it('lays out salt(16) | rs(4) | idlen(1) | keyid', () => {
    const salt = new Uint8Array(16).fill(7)
    const keyid = new Uint8Array(65).fill(9)
    const header = buildContentHeader(salt, 4096, keyid)
    expect(header.length).toBe(16 + 4 + 1 + 65)
    expect(Array.from(header.slice(0, 16))).toEqual(Array.from(salt))
    // record size 4096 big-endian = 00 00 10 00
    expect(Array.from(header.slice(16, 20))).toEqual([0, 0, 0x10, 0])
    expect(header[20]).toBe(65)
  })
})

describe('hkdf', () => {
  it('returns the requested length', async () => {
    const out = await hkdf(
      new Uint8Array(16),
      new Uint8Array(32).fill(1),
      new TextEncoder().encode('info'),
      12,
    )
    expect(out.length).toBe(12)
  })
  it('is deterministic for the same inputs', async () => {
    const a = await hkdf(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6]), 16)
    const b = await hkdf(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6]), 16)
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})

describe('vapidAuthHeader', () => {
  it('formats the single-header vapid scheme', () => {
    expect(vapidAuthHeader('JWT', 'PUB')).toBe('vapid t=JWT, k=PUB')
  })
})

describe('buildVapidJwt', () => {
  it('produces a JWT whose ES256 signature verifies with the public key', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
    const jwt = await buildVapidJwt('https://push.example.com', 'mailto:a@b.c', privateJwk)

    const [h, p, s] = jwt.split('.')
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)))
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)))
    expect(claims.aud).toBe('https://push.example.com')
    expect(claims.sub).toBe('mailto:a@b.c')

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      kp.publicKey,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    )
    expect(ok).toBe(true)
  })
})

describe('encryptPayload', () => {
  it('emits header(86) | ciphertext(plaintext+1+16) with the given salt up front', async () => {
    // A real subscriber key (P-256 ECDH public, raw 65 bytes) + 16-byte auth.
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const salt = new Uint8Array(16).fill(3)
    const plaintext = new TextEncoder().encode('hello push')

    const { body } = await encryptPayload(plaintext, uaPublic, auth, { salt })
    expect(Array.from(body.slice(0, 16))).toEqual(Array.from(salt))
    expect(body.length).toBe(86 + plaintext.length + 1 + 16)
  })
})
