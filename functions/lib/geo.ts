// Geo helpers — pure. SQLite has no guaranteed trig functions, so the SQL
// prefilters by an indexable bounding box and the exact distance is computed here.

export const MILES_PER_DEG_LAT = 69

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8 // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Latitude/longitude deltas (degrees) for a bounding box of `radiusMi` around `lat`.
export function bboxDeltas(lat: number, radiusMi: number): { latDelta: number; lngDelta: number } {
  const latDelta = radiusMi / MILES_PER_DEG_LAT
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const lngDelta =
    radiusMi / (MILES_PER_DEG_LAT * (Math.abs(cosLat) < 1e-6 ? 1e-6 : Math.abs(cosLat)))
  return { latDelta, lngDelta }
}
