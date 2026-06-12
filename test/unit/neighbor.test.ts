import { describe, expect, it } from 'vitest'
import { ADJACENT_MILES, pointNearAny, setsAdjacent } from '../../functions/lib/neighbor'

// A point ~40 m east of the base (well within the ~80 m threshold) and one ~1 km
// away (well outside). 1 degree of longitude ≈ 69 mi * cos(lat); at lat 34.72,
// 0.0005° ≈ 0.028 mi ≈ 45 m.
const base = { lat: 34.72, lng: -76.66 }
const adjacent = { lat: 34.72, lng: -76.6594 } // ~55 m east
const farAway = { lat: 34.74, lng: -76.66 } // ~1.4 mi north

describe('pointNearAny', () => {
  it('is true when a point sits within the adjacency threshold of one in the set', () => {
    expect(pointNearAny(base.lat, base.lng, [farAway, adjacent])).toBe(true)
  })

  it('is false when every point is beyond the threshold', () => {
    expect(pointNearAny(base.lat, base.lng, [farAway])).toBe(false)
  })

  it('is false against an empty set', () => {
    expect(pointNearAny(base.lat, base.lng, [])).toBe(false)
  })

  it('honors a custom threshold', () => {
    // farAway is ~1.4 mi off — inside a 2 mi threshold, outside the default.
    expect(pointNearAny(base.lat, base.lng, [farAway], 2)).toBe(true)
    expect(pointNearAny(base.lat, base.lng, [farAway], ADJACENT_MILES)).toBe(false)
  })
})

describe('setsAdjacent', () => {
  it('is true when any pair across the two sets is within the threshold', () => {
    expect(setsAdjacent([farAway, base], [adjacent])).toBe(true)
  })

  it('is false when no pair is close enough', () => {
    expect(setsAdjacent([base], [farAway])).toBe(false)
  })

  it('is false when either set is empty', () => {
    expect(setsAdjacent([], [base])).toBe(false)
    expect(setsAdjacent([base], [])).toBe(false)
  })
})
