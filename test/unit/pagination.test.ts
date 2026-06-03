import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMIT, MAX_LIMIT, clampLimit, parseBefore } from '../../functions/lib/pagination'

describe('clampLimit', () => {
  it('defaults on missing/blank input', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT)
    expect(clampLimit('')).toBe(DEFAULT_LIMIT)
  })
  it('defaults on non-numeric or non-positive input', () => {
    expect(clampLimit('abc')).toBe(DEFAULT_LIMIT)
    expect(clampLimit('0')).toBe(DEFAULT_LIMIT)
    expect(clampLimit('-5')).toBe(DEFAULT_LIMIT)
  })
  it('passes through a valid in-range value', () => {
    expect(clampLimit('10')).toBe(10)
  })
  it('caps at MAX_LIMIT', () => {
    expect(clampLimit('1000')).toBe(MAX_LIMIT)
  })
})

describe('parseBefore', () => {
  it('returns null for missing or blank', () => {
    expect(parseBefore(undefined)).toBeNull()
    expect(parseBefore(null)).toBeNull()
    expect(parseBefore('   ')).toBeNull()
  })
  it('returns the trimmed cursor when present', () => {
    expect(parseBefore(' 2026-01-01 00:00:00 ')).toBe('2026-01-01 00:00:00')
  })
})
