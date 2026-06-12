// Neighbor adjacency — pure, no I/O, so it unit-tests in isolation.
//
// We have no parcel polygons (county GIS isn't free/Cloudflare-native), so
// "next door" is a proximity heuristic: two points are adjacent when they're
// within ADJACENT_MILES of each other (~80 m, a house or two in typical lots).
// All matching returns booleans only — the API never exposes another user's
// coordinates, distance, or which property matched.

import { haversineMiles } from './geo'

export const ADJACENT_MILES = 0.05 // ~80 m

export type Point = { lat: number; lng: number }

// Is (lat,lng) within the threshold of any point in the set?
export function pointNearAny(
  lat: number,
  lng: number,
  points: Point[],
  threshold = ADJACENT_MILES,
): boolean {
  return points.some((p) => haversineMiles(lat, lng, p.lat, p.lng) <= threshold)
}

// Do the two point sets have any pair within the threshold? (e.g. my properties
// vs another user's properties → "we're neighbors").
export function setsAdjacent(a: Point[], b: Point[], threshold = ADJACENT_MILES): boolean {
  return a.some((p) => pointNearAny(p.lat, p.lng, b, threshold))
}
