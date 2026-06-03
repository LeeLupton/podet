import { describe, expect, it } from 'vitest'
import { bboxDeltas, haversineMiles } from '../../functions/lib/geo'

describe('haversineMiles', () => {
  it('is zero for identical points', () => {
    expect(haversineMiles(34.72, -76.66, 34.72, -76.66)).toBeCloseTo(0, 6)
  })

  it('is ~69 miles for one degree of latitude', () => {
    expect(haversineMiles(34, -76, 35, -76)).toBeGreaterThan(68)
    expect(haversineMiles(34, -76, 35, -76)).toBeLessThan(70)
  })

  it('is symmetric', () => {
    const a = haversineMiles(34.72, -76.66, 35.1, -76.0)
    const b = haversineMiles(35.1, -76.0, 34.72, -76.66)
    expect(a).toBeCloseTo(b, 9)
  })
})

describe('bboxDeltas', () => {
  it('latDelta is radius/69 regardless of latitude', () => {
    expect(bboxDeltas(0, 69).latDelta).toBeCloseTo(1, 6)
    expect(bboxDeltas(60, 69).latDelta).toBeCloseTo(1, 6)
  })

  it('lngDelta widens as latitude increases (cos shrinks)', () => {
    expect(bboxDeltas(60, 10).lngDelta).toBeGreaterThan(bboxDeltas(0, 10).lngDelta)
  })

  it('does not divide by zero at the poles', () => {
    expect(Number.isFinite(bboxDeltas(90, 10).lngDelta)).toBe(true)
  })
})
