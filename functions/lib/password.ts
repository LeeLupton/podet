// Password hashing — PBKDF2-HMAC-SHA256 via Web Crypto. Pure functions (crypto is
// a platform global, available in both workerd and Node 20+), so unit-testable.
//
// Encoded as `pbkdf2$<iterations>$<saltB64>$<hashB64>`. Never store or compare
// plaintext; verification uses a constant-time compare.

export const PBKDF2_ITERATIONS = 100_000
const PBKDF2_HASH_BITS = 256

export function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function b64decode(str: string): Uint8Array {
  const s = atob(str)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_HASH_BITS,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(iterations)) return false
  const salt = b64decode(parts[2])
  const expected = b64decode(parts[3])
  const actual = await deriveBits(password, salt, iterations)
  return timingSafeEqual(actual, expected)
}

// A well-formed dummy hash so login can run the same PBKDF2 work for unknown
// emails — equalizing response time so it can't be used to enumerate accounts.
export const DUMMY_PASSWORD_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(new Uint8Array(16))}$${b64encode(new Uint8Array(32))}`
