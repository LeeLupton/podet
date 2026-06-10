import { describe, expect, it } from 'vitest'
import { MAX_NOTICE_HOURS, validateSlot, validateWindow } from '../../functions/lib/schedule'

const NOW = new Date('2026-06-15T12:00:00Z')
const WS = '2026-06-16T09:00:00Z'
const WE = '2026-06-16T17:00:00Z'

describe('validateWindow', () => {
  it('accepts no window at all', () => {
    expect(validateWindow(null, null, null)).toEqual({
      ok: true,
      window_start: null,
      window_end: null,
      notice_hours: 0,
    })
  })

  it('normalizes a valid window to ISO and keeps notice', () => {
    const r = validateWindow(WS, WE, 4)
    expect(r).toEqual({
      ok: true,
      window_start: '2026-06-16T09:00:00.000Z',
      window_end: '2026-06-16T17:00:00.000Z',
      notice_hours: 4,
    })
  })

  it('rejects start without end (and vice versa)', () => {
    expect(validateWindow(WS, null, 0).ok).toBe(false)
    expect(validateWindow(null, WE, 0).ok).toBe(false)
  })

  it('rejects end before start', () => {
    expect(validateWindow(WE, WS, 0).ok).toBe(false)
  })

  it('rejects unparseable dates', () => {
    expect(validateWindow('next tuesday', WE, 0).ok).toBe(false)
  })

  it('rejects notice without a window', () => {
    expect(validateWindow(null, null, 4).ok).toBe(false)
  })

  it('rejects out-of-range notice', () => {
    expect(validateWindow(WS, WE, -1).ok).toBe(false)
    expect(validateWindow(WS, WE, MAX_NOTICE_HOURS + 1).ok).toBe(false)
    expect(validateWindow(WS, WE, 2.5).ok).toBe(false)
  })
})

describe('validateSlot', () => {
  it('needs no slot when the gig has no window', () => {
    expect(validateSlot(null, null, null, 0, NOW)).toEqual({ ok: true, scheduled_at: null })
  })

  it('requires a slot when the gig is windowed', () => {
    expect(validateSlot(null, WS, WE, 0, NOW).ok).toBe(false)
  })

  it('accepts a slot inside the window after the notice period', () => {
    const r = validateSlot('2026-06-16T10:00:00Z', WS, WE, 4, NOW)
    expect(r).toEqual({ ok: true, scheduled_at: '2026-06-16T10:00:00.000Z' })
  })

  it('rejects a slot before the window opens', () => {
    expect(validateSlot('2026-06-16T08:00:00Z', WS, WE, 0, NOW).ok).toBe(false)
  })

  it('rejects a slot after the window closes', () => {
    expect(validateSlot('2026-06-16T18:00:00Z', WS, WE, 0, NOW).ok).toBe(false)
  })

  it('rejects a slot inside the window but inside the notice period', () => {
    // 30h notice from NOW (Jun 15 12:00) → earliest Jun 16 18:00; 10:00 is too soon.
    expect(validateSlot('2026-06-16T10:00:00Z', WS, WE, 30, NOW).ok).toBe(false)
  })

  it('rejects garbage slot input', () => {
    expect(validateSlot('whenever', WS, WE, 0, NOW).ok).toBe(false)
  })
})
