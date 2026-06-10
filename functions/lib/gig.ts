// Gig input parsing/validation — shared by POST /gigs and PUT /gigs/:id so the
// rules can never diverge between create and edit.

import { type WindowResult, validateWindow } from './schedule'
import { LIMITS, isValidLatLng, validateString } from './validate'

export type GigInput = {
  task_type: string
  neighborhood: string
  description: string
  cash_payout: number
  est_hours: number
  lat: number
  lng: number
  window_start: string | null
  window_end: string | null
  notice_hours: number
}

export type GigInputResult = { ok: true; gig: GigInput } | { ok: false; reason: string }

export function parseGigInput(b: any): GigInputResult {
  const taskCheck = validateString(b?.task_type, LIMITS.task_type)
  const hoodCheck = validateString(b?.neighborhood, LIMITS.neighborhood)
  const descCheck = validateString(b?.description, LIMITS.description)
  if (
    !taskCheck.ok ||
    !taskCheck.value ||
    !hoodCheck.ok ||
    !hoodCheck.value ||
    !descCheck.ok ||
    !descCheck.value
  ) {
    return {
      ok: false,
      reason: 'task_type, neighborhood and description required (and within length limits)',
    }
  }
  const cash_payout = Math.round(Number(b.cash_payout))
  if (!Number.isFinite(cash_payout) || cash_payout < 0 || cash_payout > 1_000_000) {
    return { ok: false, reason: 'cash_payout must be a non-negative number' }
  }
  const est_hours = Number(b.est_hours)
  if (!Number.isFinite(est_hours) || est_hours <= 0 || est_hours > 10_000) {
    return { ok: false, reason: 'est_hours must be positive' }
  }
  const lat = Number(b.lat)
  const lng = Number(b.lng)
  if (!isValidLatLng(lat, lng)) {
    return { ok: false, reason: 'valid lat and lng required' }
  }
  const win: WindowResult = validateWindow(b.window_start, b.window_end, b.notice_hours)
  if (!win.ok) return { ok: false, reason: win.reason }
  return {
    ok: true,
    gig: {
      task_type: taskCheck.value,
      neighborhood: hoodCheck.value,
      description: descCheck.value,
      cash_payout,
      est_hours,
      lat,
      lng,
      window_start: win.window_start,
      window_end: win.window_end,
      notice_hours: win.notice_hours,
    },
  }
}
