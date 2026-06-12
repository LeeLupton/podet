// Showcase weeks — pure ISO-8601 week math, unit-testable in isolation.
//
// The Showcase runs on a weekly rhythm: entries and votes belong to an ISO week
// key like "2026-W24" (Monday-start). A week earlier than the current one is
// closed — its winner can be finalized and no further votes are accepted.

// ISO-8601 week key for a date (UTC). The Thursday of a week determines which
// year the week belongs to (handles the Jan 1 / Dec 31 boundary correctly).
export function weekKey(d: Date = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7 // Mon=1 .. Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day) // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// Zero-padded "YYYY-Wnn" keys compare correctly as strings across years.
export function isPastWeek(week: string, now: Date = new Date()): boolean {
  return week < weekKey(now)
}

// Valid week key shape (used to sanitize the ?week= query param).
export function isWeekKey(s: unknown): boolean {
  return typeof s === 'string' && /^\d{4}-W\d{2}$/.test(s)
}
