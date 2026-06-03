import { describe, expect, it } from 'vitest'
import { isValidLatLng, isValidRating, validateString } from '../../functions/lib/validate'

describe('validateString', () => {
  it('trims surrounding whitespace', () => {
    expect(validateString('  hi  ', 10)).toEqual({ ok: true, value: 'hi' })
  })

  it('accepts a string exactly at the max length', () => {
    expect(validateString('abcde', 5)).toEqual({ ok: true, value: 'abcde' })
  })

  it('rejects a string longer than max', () => {
    expect(validateString('abcdef', 5)).toEqual({ ok: false })
  })

  it('rejects required-but-empty', () => {
    expect(validateString('', 5)).toEqual({ ok: false })
    expect(validateString('   ', 5)).toEqual({ ok: false })
    expect(validateString(null, 5)).toEqual({ ok: false })
  })

  it('returns null for optional-and-empty', () => {
    expect(validateString('', 5, { required: false })).toEqual({ ok: true, value: null })
    expect(validateString(null, 5, { required: false })).toEqual({ ok: true, value: null })
  })

  it('rejects non-string input', () => {
    expect(validateString(42, 5)).toEqual({ ok: false })
    expect(validateString({}, 5)).toEqual({ ok: false })
  })
})

describe('isValidRating', () => {
  it('accepts integers 1 through 5', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(isValidRating(n)).toBe(true)
  })
  it('rejects 0 and 6', () => {
    expect(isValidRating(0)).toBe(false)
    expect(isValidRating(6)).toBe(false)
  })
  it('rejects non-integers', () => {
    expect(isValidRating(3.5)).toBe(false)
    expect(isValidRating('5')).toBe(false)
    expect(isValidRating(Number.NaN)).toBe(false)
  })
})

describe('isValidLatLng', () => {
  it('accepts in-range coordinates', () => {
    expect(isValidLatLng(34.72, -76.66)).toBe(true)
    expect(isValidLatLng(-90, 180)).toBe(true)
  })
  it('rejects out-of-range latitude', () => {
    expect(isValidLatLng(91, 0)).toBe(false)
    expect(isValidLatLng(-91, 0)).toBe(false)
  })
  it('rejects out-of-range longitude', () => {
    expect(isValidLatLng(0, 181)).toBe(false)
    expect(isValidLatLng(0, -181)).toBe(false)
  })
  it('rejects non-finite values', () => {
    expect(isValidLatLng(Number.NaN, 0)).toBe(false)
    expect(isValidLatLng(0, Number.POSITIVE_INFINITY)).toBe(false)
  })
})
