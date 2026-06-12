import { describe, expect, it } from 'vitest'
import { isPastWeek, isWeekKey, weekKey } from '../../functions/lib/showcase'

describe('weekKey (ISO-8601)', () => {
  it('produces the YYYY-Wnn shape', () => {
    expect(weekKey(new Date())).toMatch(/^\d{4}-W\d{2}$/)
  })

  it('keeps Monday through Sunday in the same week', () => {
    // 2026-06-08 is a Monday; 2026-06-14 the following Sunday.
    const mon = weekKey(new Date(Date.UTC(2026, 5, 8)))
    const sun = weekKey(new Date(Date.UTC(2026, 5, 14)))
    expect(mon).toBe(sun)
  })

  it('rolls to a new week across the Monday boundary', () => {
    const sun = weekKey(new Date(Date.UTC(2026, 5, 14)))
    const nextMon = weekKey(new Date(Date.UTC(2026, 5, 15)))
    expect(nextMon).not.toBe(sun)
  })

  it('handles the year boundary by the ISO Thursday rule', () => {
    // Jan 1 2026 is a Thursday → its week is 2026-W01.
    expect(weekKey(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-W01')
    // Jan 1 2021 is a Friday → it still belongs to 2020's last week (W53).
    expect(weekKey(new Date(Date.UTC(2021, 0, 1)))).toBe('2020-W53')
  })
})

describe('isPastWeek', () => {
  it('is false for the current week and true for an earlier one', () => {
    const now = new Date(Date.UTC(2026, 5, 10))
    expect(isPastWeek(weekKey(now), now)).toBe(false)
    expect(isPastWeek('2026-W01', now)).toBe(true)
  })

  it('compares correctly across years (zero-padded keys)', () => {
    const now = new Date(Date.UTC(2026, 0, 8)) // 2026-W02
    expect(isPastWeek('2025-W52', now)).toBe(true)
  })
})

describe('isWeekKey', () => {
  it('accepts the canonical shape and rejects garbage', () => {
    expect(isWeekKey('2026-W24')).toBe(true)
    expect(isWeekKey('2026-w24')).toBe(false)
    expect(isWeekKey('2026-W2')).toBe(false)
    expect(isWeekKey(null)).toBe(false)
  })
})
