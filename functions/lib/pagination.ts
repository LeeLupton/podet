// Pagination helpers — pure keyset paging on ISO `created_at` cursors.

export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 50

// Clamp a requested page size to [1, MAX_LIMIT], defaulting on bad/absent input.
export function clampLimit(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

// A `before` cursor is the created_at of the last item seen; blank → no cursor.
export function parseBefore(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  return s.length > 0 ? s : null
}
