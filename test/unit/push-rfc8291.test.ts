// RFC 8291 Appendix A — the official Web Push encryption test vector.
// If encryptPayload reproduces these exact bytes, our sender is wire-compatible
// with every push service (Apple Web Push, FCM, Mozilla autopush) on every
// device platform. All values below are quoted verbatim from the RFC.

import { describe, expect, it } from 'vitest'
import { b64urlDecode, b64urlEncode, encryptPayload } from '../../functions/lib/push'

const VECTOR = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

// Import the RFC's fixed application-server keypair so the ECDH output is
// deterministic (normally encryptPayload generates an ephemeral pair).
async function importAsKeyPair(): Promise<CryptoKeyPair> {
  const pub = b64urlDecode(VECTOR.asPublic) // 0x04 | x(32) | y(32)
  const x = b64urlEncode(pub.slice(1, 33))
  const y = b64urlEncode(pub.slice(33, 65))
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: VECTOR.asPrivate, x, y },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  )
  const publicKey = await crypto.subtle.importKey(
    'raw',
    pub,
    { name: 'ECDH', namedCurve: 'P-256' },
    true, // extractable — encryptPayload re-exports it for the keyid/keyInfo
    [],
  )
  return { privateKey, publicKey } as CryptoKeyPair
}

describe('RFC 8291 Appendix A test vector', () => {
  it('encryptPayload reproduces the exact expected message bytes', async () => {
    const { body } = await encryptPayload(
      b64urlDecode(VECTOR.plaintext),
      b64urlDecode(VECTOR.uaPublic),
      b64urlDecode(VECTOR.authSecret),
      { salt: b64urlDecode(VECTOR.salt), ephemeral: await importAsKeyPair() },
    )
    expect(b64urlEncode(body)).toBe(VECTOR.message)
  })

  it('the decoded plaintext is the watermelon sentence', () => {
    expect(new TextDecoder().decode(b64urlDecode(VECTOR.plaintext))).toBe(
      'When I grow up, I want to be a watermelon',
    )
  })
})
