import { describe, expect, it } from 'vitest'
import { REVIEW, planReview, planRevision } from '../../functions/lib/review'

describe('planReview', () => {
  it('publishes 4 and 5 star reviews immediately', () => {
    expect(planReview(4).status).toBe('PUBLISHED')
    expect(planReview(5).status).toBe('PUBLISHED')
    expect(planReview(5).resolve_deadline).toBeNull()
  })

  it('publishes a 3 star review (the reflection is client-side)', () => {
    expect(planReview(3).status).toBe('PUBLISHED')
  })

  it('holds 1 and 2 star reviews for resolution', () => {
    expect(planReview(1).status).toBe('RESOLVING')
    expect(planReview(2).status).toBe('RESOLVING')
  })

  it('sets the deadline RESOLVE_DAYS out for a held review', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const plan = planReview(1, now)
    expect(plan.status).toBe('RESOLVING')
    if (plan.status !== 'RESOLVING') throw new Error('unreachable')
    const expected = new Date(now.getTime() + REVIEW.RESOLVE_DAYS * 86_400_000).toISOString()
    expect(plan.resolve_deadline).toBe(expected)
  })
})

describe('planRevision (ceiling-of-harm: up only)', () => {
  it('rejects a lower score', () => {
    expect(planRevision(2, 1).ok).toBe(false)
  })

  it('rejects an equal score', () => {
    expect(planRevision(2, 2).ok).toBe(false)
  })

  it('rejects out-of-range or non-integer scores', () => {
    expect(planRevision(2, 6).ok).toBe(false)
    expect(planRevision(2, 0).ok).toBe(false)
    expect(planRevision(2, 3.5).ok).toBe(false)
  })

  it('publishes when raised above the hold threshold', () => {
    const r = planRevision(2, 4)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.status).toBe('PUBLISHED')
    expect(r.stars).toBe(4)
  })

  it('stays in resolution when raised but still within the hold range (1 -> 2)', () => {
    const r = planRevision(1, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.status).toBe('RESOLVING')
  })
})
