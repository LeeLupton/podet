// Input validation helpers — pure, no I/O, so they're unit-testable in isolation.

// Input length caps — reject oversized payloads before they hit the DB.
export const LIMITS = {
  email: 254,
  password: 200,
  display_name: 60,
  task_type: 80,
  neighborhood: 80,
  description: 2000,
  post_body: 1000,
  comment_body: 1000,
  area_label: 120,
  review_body: 1000,
  photo_bytes: 5 * 1024 * 1024, // 5 MB
}

export type ValidateResult = { ok: true; value: string | null } | { ok: false }

// Returns a trimmed string, or null if missing/optional; fails if required-empty
// or longer than `max`.
export function validateString(
  value: unknown,
  max: number,
  { required = true } = {},
): ValidateResult {
  if (value == null || value === '') return required ? { ok: false } : { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (required && !trimmed) return { ok: false }
  if (trimmed.length > max) return { ok: false }
  return { ok: true, value: trimmed || null }
}

// True when n is an integer rating in [1,5].
export function isValidRating(n: unknown): boolean {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 5
}

// True when lat/lng are finite and within valid geographic ranges.
export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  )
}
