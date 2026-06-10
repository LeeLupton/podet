// Web Push (RFC 8291 payload encryption + RFC 8292 VAPID) using Web Crypto.
// The pure/deterministic helpers here are unit-tested; actual delivery to a push
// service can't be verified in tests, so sending is best-effort at the call site.

// --- base64url (no padding) ----------------------------------------------
export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// --- HKDF-SHA256 (extract + expand) --------------------------------------
async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
}

export async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm)
  const out = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])))
  return out.slice(0, length)
}

// --- RFC 8188 content header (salt | rs(4) | idlen(1) | keyid) ------------
export function buildContentHeader(
  salt: Uint8Array,
  recordSize: number,
  keyid: Uint8Array,
): Uint8Array {
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, recordSize, false)
  return concatBytes(salt, rs, new Uint8Array([keyid.length]), keyid)
}

// --- VAPID (RFC 8292) JWT, ES256 -----------------------------------------
export async function buildVapidJwt(
  audience: string,
  subject: string,
  privateJwk: JsonWebKey,
): Promise<string> {
  const enc = (obj: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)))
  const header = enc({ typ: 'JWT', alg: 'ES256' })
  const payload = enc({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })
  const signingInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(signingInput),
    ),
  )
  return `${signingInput}.${b64urlEncode(sig)}`
}

// The single-header VAPID form: `vapid t=<jwt>, k=<public key>`.
export function vapidAuthHeader(jwt: string, publicKeyB64url: string): string {
  return `vapid t=${jwt}, k=${publicKeyB64url}`
}

// --- Payload encryption (RFC 8291, aes128gcm) ----------------------------
// `salt` and `ephemeral` are injectable for deterministic tests; both default to random.
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array, // subscription p256dh (raw, 65 bytes)
  authSecret: Uint8Array, // subscription auth (16 bytes)
  opts: { salt?: Uint8Array; ephemeral?: CryptoKeyPair } = {},
): Promise<{ body: Uint8Array; salt: Uint8Array; asPublic: Uint8Array }> {
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const ephemeral =
    opts.ephemeral ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair)
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer,
  )

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaKey } as any,
      ephemeral.privateKey,
      256,
    ),
  )

  // IKM = HKDF(auth, ecdh, "WebPush: info\0" | ua_public | as_public, 32)
  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)

  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12)

  // One record: plaintext | 0x02 delimiter (last record), then AES-128-GCM.
  const padded = concatBytes(plaintext, new Uint8Array([2]))
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded),
  )

  const header = buildContentHeader(salt, 4096, asPublic)
  return { body: concatBytes(header, ciphertext), salt, asPublic }
}

// Delivery options understood by all push services (RFC 8030):
//  - ttl: seconds the service may queue the message for an offline device.
//  - urgency: very-low | low | normal | high — battery-aware delivery hint.
//  - topic: collapse key (≤32 base64url chars); a newer message with the same
//    topic replaces a queued older one instead of stacking up.
export type PushDeliveryOptions = {
  ttl?: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  topic?: string
}

const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/
const DEFAULT_TTL = 2419200 // 28 days

// Browser push services we will deliver to. Subscriptions are client-supplied
// URLs and the server POSTs to them — without this allowlist that is an SSRF
// primitive (the API could be aimed at arbitrary third-party endpoints).
const PUSH_HOST_SUFFIXES = [
  '.googleapis.com', // Chrome/Edge/Samsung via FCM (fcm.googleapis.com)
  '.push.apple.com', // Safari / iOS web push
  '.push.services.mozilla.com', // Firefox autopush
  '.notify.windows.com', // WNS
]

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return PUSH_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx) || host === sfx.slice(1))
}

// Collapse key for events about one entity: a UUID minus hyphens is 32 hex
// chars — exactly the RFC 8030 Topic limit. Newer updates with the same topic
// replace queued older ones instead of stacking up on the device.
export function topicFor(id: string): string {
  return id.replace(/-/g, '').slice(0, 32)
}

// Pure header builder so delivery semantics are unit-testable.
export function pushHeaders(
  authorization: string,
  opts: PushDeliveryOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    TTL: String(Number.isFinite(opts.ttl) && (opts.ttl as number) >= 0 ? opts.ttl : DEFAULT_TTL),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: authorization,
    Urgency: opts.urgency ?? 'normal',
  }
  if (opts.topic && TOPIC_RE.test(opts.topic)) headers.Topic = opts.topic
  return headers
}

// Full send: encrypt + VAPID auth + POST. Returns the push service Response so
// the caller can prune dead subscriptions on 404/410.
export async function sendWebPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapid: { publicKey: string; privateJwk: JsonWebKey; subject: string },
  delivery: PushDeliveryOptions = {},
): Promise<Response> {
  const url = new URL(sub.endpoint)
  const jwt = await buildVapidJwt(url.origin, vapid.subject, vapid.privateJwk)
  const { body } = await encryptPayload(
    new TextEncoder().encode(payload),
    b64urlDecode(sub.p256dh),
    b64urlDecode(sub.auth),
  )
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: pushHeaders(vapidAuthHeader(jwt, vapid.publicKey), delivery),
    body,
  })
}
