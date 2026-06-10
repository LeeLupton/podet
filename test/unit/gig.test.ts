import { describe, expect, it } from 'vitest'
import { parseGigInput } from '../../functions/lib/gig'

const valid = {
  task_type: 'Rake leaves',
  neighborhood: 'Front St',
  cash_payout: 40,
  est_hours: 2,
  lat: 34.72,
  lng: -76.66,
  description: 'Front yard',
}

describe('parseGigInput', () => {
  it('accepts a valid windowless gig and normalizes fields', () => {
    const r = parseGigInput(valid)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.gig.task_type).toBe('Rake leaves')
      expect(r.gig.window_start).toBeNull()
      expect(r.gig.notice_hours).toBe(0)
    }
  })

  it('rounds cash_payout to an integer', () => {
    const r = parseGigInput({ ...valid, cash_payout: 39.6 })
    expect(r.ok && r.gig.cash_payout).toBe(40)
  })

  it('rejects a missing required string', () => {
    expect(parseGigInput({ ...valid, task_type: '  ' }).ok).toBe(false)
  })

  it('rejects an out-of-range payout', () => {
    expect(parseGigInput({ ...valid, cash_payout: -1 }).ok).toBe(false)
    expect(parseGigInput({ ...valid, cash_payout: 2_000_000 }).ok).toBe(false)
  })

  it('rejects non-positive est_hours', () => {
    expect(parseGigInput({ ...valid, est_hours: 0 }).ok).toBe(false)
  })

  it('rejects invalid coordinates', () => {
    expect(parseGigInput({ ...valid, lat: 91 }).ok).toBe(false)
  })

  it('carries a valid window through', () => {
    const ws = '2026-06-16T09:00:00Z'
    const we = '2026-06-16T17:00:00Z'
    const r = parseGigInput({ ...valid, window_start: ws, window_end: we, notice_hours: 4 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.gig.window_start).toBe('2026-06-16T09:00:00.000Z')
      expect(r.gig.notice_hours).toBe(4)
    }
  })

  it('rejects a backwards window', () => {
    expect(
      parseGigInput({
        ...valid,
        window_start: '2026-06-16T17:00:00Z',
        window_end: '2026-06-16T09:00:00Z',
      }).ok,
    ).toBe(false)
  })
})
