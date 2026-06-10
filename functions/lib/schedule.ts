// Scheduling — pure validators for gig availability windows and claim slots.
// Model: the hirer optionally posts a window of hours that work for them plus a
// minimum notice (hours). The worker claims by picking a slot inside the window
// that is at least `notice_hours` in the future.

export const MAX_NOTICE_HOURS = 720 // 30 days

export type WindowResult =
  | { ok: true; window_start: string | null; window_end: string | null; notice_hours: number }
  | { ok: false; reason: string }

function parseWhen(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

// Validate the window fields on gig create/edit. Both bounds optional, but they
// come as a pair; notice is meaningless without a window.
export function validateWindow(start: unknown, end: unknown, notice: unknown): WindowResult {
  const hasStart = start != null && start !== ''
  const hasEnd = end != null && end !== ''
  let notice_hours = 0
  if (notice != null && notice !== '') {
    const n = Number(notice)
    if (!Number.isInteger(n) || n < 0 || n > MAX_NOTICE_HOURS) {
      return { ok: false, reason: `notice_hours must be an integer 0-${MAX_NOTICE_HOURS}` }
    }
    notice_hours = n
  }
  if (!hasStart && !hasEnd) {
    if (notice_hours > 0) return { ok: false, reason: 'notice_hours requires a time window' }
    return { ok: true, window_start: null, window_end: null, notice_hours: 0 }
  }
  if (!hasStart || !hasEnd) {
    return { ok: false, reason: 'window_start and window_end go together' }
  }
  const s = parseWhen(start)
  const e = parseWhen(end)
  if (!s || !e) return { ok: false, reason: 'window times must be valid dates' }
  if (e.getTime() <= s.getTime())
    return { ok: false, reason: 'window_end must be after window_start' }
  return { ok: true, window_start: s.toISOString(), window_end: e.toISOString(), notice_hours }
}

export type SlotResult = { ok: true; scheduled_at: string | null } | { ok: false; reason: string }

// Validate the slot a worker picks when claiming. Windowless gigs need no slot.
export function validateSlot(
  slot: unknown,
  windowStart: string | null,
  windowEnd: string | null,
  noticeHours: number,
  now: Date = new Date(),
): SlotResult {
  if (!windowStart || !windowEnd) return { ok: true, scheduled_at: null }
  const t = parseWhen(slot)
  if (!t) return { ok: false, reason: 'pick a time within the posted window' }
  const ws = new Date(windowStart).getTime()
  const we = new Date(windowEnd).getTime()
  if (t.getTime() < ws || t.getTime() > we) {
    return { ok: false, reason: 'that time is outside the posted window' }
  }
  const earliest = now.getTime() + noticeHours * 3600_000
  if (t.getTime() < earliest) {
    return { ok: false, reason: `the hirer needs ${noticeHours}h notice` }
  }
  return { ok: true, scheduled_at: t.toISOString() }
}
