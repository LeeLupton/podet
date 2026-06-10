import { describe, expect, it } from 'vitest'
import { pushHeaders, topicFor } from '../../functions/lib/push'

describe('pushHeaders', () => {
  it('sets the protocol headers with a 28-day default TTL and normal urgency', () => {
    const h = pushHeaders('vapid t=J, k=K')
    expect(h.TTL).toBe('2419200')
    expect(h['Content-Encoding']).toBe('aes128gcm')
    expect(h['Content-Type']).toBe('application/octet-stream')
    expect(h.Authorization).toBe('vapid t=J, k=K')
    expect(h.Urgency).toBe('normal')
    expect(h.Topic).toBeUndefined()
  })

  it('honors an explicit ttl, including 0 (deliver-now-or-drop)', () => {
    expect(pushHeaders('a', { ttl: 60 }).TTL).toBe('60')
    expect(pushHeaders('a', { ttl: 0 }).TTL).toBe('0')
  })

  it('falls back to the default TTL for a negative ttl', () => {
    expect(pushHeaders('a', { ttl: -5 }).TTL).toBe('2419200')
  })

  it('passes through a valid urgency', () => {
    expect(pushHeaders('a', { urgency: 'high' }).Urgency).toBe('high')
    expect(pushHeaders('a', { urgency: 'very-low' }).Urgency).toBe('very-low')
  })

  it('includes a valid topic', () => {
    expect(pushHeaders('a', { topic: 'gig_abc-123' }).Topic).toBe('gig_abc-123')
  })

  it('drops an invalid topic (too long or bad chars) instead of sending it', () => {
    expect(pushHeaders('a', { topic: 'x'.repeat(33) }).Topic).toBeUndefined()
    expect(pushHeaders('a', { topic: 'has space' }).Topic).toBeUndefined()
    expect(pushHeaders('a', { topic: '' }).Topic).toBeUndefined()
  })
})

describe('topicFor', () => {
  it('turns a UUID into exactly 32 base64url-safe chars', () => {
    const t = topicFor('0edabbee-543c-4442-9840-17e2d5c0c804')
    expect(t).toBe('0edabbee543c4442984017e2d5c0c804')
    expect(t).toHaveLength(32)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('truncates anything longer than 32 chars', () => {
    expect(topicFor('x'.repeat(50))).toHaveLength(32)
  })
})
