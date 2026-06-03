import { describe, expect, it } from 'vitest'
import { rateLimitKey, windowStart } from '../../functions/lib/ratelimit'

describe('rateLimitKey', () => {
  it('combines route and ip', () => {
    expect(rateLimitKey('login', '1.2.3.4')).toBe('login:1.2.3.4')
  })
})

describe('windowStart', () => {
  it('floors to the start of the window', () => {
    expect(windowStart(125, 60)).toBe(120)
    expect(windowStart(180, 60)).toBe(180)
  })

  it('two times in the same window share a start', () => {
    expect(windowStart(120, 60)).toBe(windowStart(179, 60))
  })

  it('crossing the boundary yields a new start', () => {
    expect(windowStart(179, 60)).not.toBe(windowStart(180, 60))
  })
})
