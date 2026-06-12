// Restorative review rules — pure, no I/O, so they unit-test in isolation.
//
// Model: a review's star score decides its fate at submission.
//   4-5  -> PUBLISHED immediately.
//   3    -> PUBLISHED (the client shows a reflection prompt first; the server
//           just publishes — the nudge is UX, not a hold).
//   1-2  -> RESOLVING: held unpublished, a private improvement conversation
//           opens, and it auto-publishes after RESOLVE_DAYS unless the author
//           revises it up or withdraws it. A held review can only ever be
//           raised (ceiling-of-harm) — never lowered — which removes the
//           "raise my rating or I'll drop you" coercion lever.

export const REVIEW = {
  HOLD_MAX_STARS: 2, // 1-2 are held for resolution
  RESOLVE_DAYS: 7,
}

export type ReviewPlan =
  | { status: 'PUBLISHED'; resolve_deadline: null }
  | { status: 'RESOLVING'; resolve_deadline: string }

// Decide a freshly-submitted review's status (and deadline if held).
export function planReview(stars: number, now: Date = new Date()): ReviewPlan {
  if (stars <= REVIEW.HOLD_MAX_STARS) {
    const deadline = new Date(now.getTime() + REVIEW.RESOLVE_DAYS * 86_400_000)
    return { status: 'RESOLVING', resolve_deadline: deadline.toISOString() }
  }
  return { status: 'PUBLISHED', resolve_deadline: null }
}

export type RevisionResult =
  | { ok: true; stars: number; status: 'PUBLISHED' | 'RESOLVING' }
  | { ok: false; reason: string }

// A revision to a held review may only RAISE the score. If the new score clears
// the hold threshold it publishes; otherwise it stays in resolution.
export function planRevision(current: number, next: unknown): RevisionResult {
  if (!Number.isInteger(next) || (next as number) < 1 || (next as number) > 5) {
    return { ok: false, reason: 'stars must be an integer 1-5' }
  }
  const n = next as number
  if (n <= current) {
    return { ok: false, reason: 'a review in resolution can only be raised' }
  }
  return { ok: true, stars: n, status: n > REVIEW.HOLD_MAX_STARS ? 'PUBLISHED' : 'RESOLVING' }
}
