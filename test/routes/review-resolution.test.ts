import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  applySchema,
  call,
  claim,
  clearRateLimits,
  complete,
  postGig,
  register,
} from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

// Set a CLAIMED gig up between a fresh hirer and worker.
async function claimedGig() {
  const hirer = await register('Hirer')
  const worker = await register('Worker')
  const gid = await postGig(hirer.token)
  await claim(gid, worker.token)
  return { hirer, worker, gid }
}

describe('hirer review state machine', () => {
  it('a 5-star review publishes and accrues to the worker', async () => {
    const { hirer, worker, gid } = await claimedGig()
    const r = await complete(gid, hirer.token, 5)
    expect(r.status).toBe(200)
    expect(r.body.review_status).toBe('PUBLISHED')
    const prof = await call(`/users/${worker.id}`, {}, hirer.token)
    expect(prof.body.rating_count).toBe(1)
    expect(prof.body.average_rating).toBe(5)
  })

  it('a 2-star review is held: not published, no reputation moves yet', async () => {
    const { hirer, worker, gid } = await claimedGig()
    const r = await complete(gid, hirer.token, 2, 'edging was uneven')
    expect(r.status).toBe(200)
    expect(r.body.review_status).toBe('RESOLVING')
    const prof = await call(`/users/${worker.id}`, {}, hirer.token)
    expect(prof.body.rating_count).toBe(0)
    const reviews = await call(`/users/${worker.id}/reviews`, {}, hirer.token)
    expect(reviews.body).toHaveLength(0)
  })
})

describe('resolution surfaces', () => {
  it('the held review appears for the author with the counterpart shown only when 4-5', async () => {
    const { hirer, worker, gid } = await claimedGig()
    // hirer holds a 1★; the worker (now the gig is COMPLETED) thinks well of the
    // hirer at 5★ — that becomes the empathy nudge shown back to the hirer.
    await complete(gid, hirer.token, 1, 'late and rude')
    const wr = await call(
      `/gigs/${gid}/review`,
      { method: 'POST', body: JSON.stringify({ rating: 5, review: 'great to work with' }) },
      worker.token,
    )
    expect(wr.status).toBe(201)
    const mine = await call('/reviews/resolving', {}, hirer.token)
    expect(mine.body.authored).toHaveLength(1)
    expect(mine.body.authored[0].counterpart.stars).toBe(5)
  })

  it('the subject sees the written feedback but not the star number', async () => {
    const { hirer, worker, gid } = await claimedGig()
    await complete(gid, hirer.token, 1, 'needs to confirm timing')
    const theirs = await call('/reviews/resolving', {}, worker.token)
    expect(theirs.body.about_me).toHaveLength(1)
    expect(theirs.body.about_me[0].body).toBe('needs to confirm timing')
    expect(theirs.body.about_me[0].stars).toBeUndefined()
  })
})

describe('revise (up only) and withdraw', () => {
  it('raising above the threshold publishes and accrues', async () => {
    const { hirer, worker, gid } = await claimedGig()
    await complete(gid, hirer.token, 2)
    const mine = await call('/reviews/resolving', {}, hirer.token)
    const rid = mine.body.authored[0].id
    const rev = await call(
      `/reviews/${rid}/revise`,
      { method: 'POST', body: JSON.stringify({ rating: 4 }) },
      hirer.token,
    )
    expect(rev.status).toBe(200)
    expect(rev.body.review_status).toBe('PUBLISHED')
    const prof = await call(`/users/${worker.id}`, {}, hirer.token)
    expect(prof.body.rating_count).toBe(1)
    expect(prof.body.average_rating).toBe(4)
  })

  it('lowering a held review is rejected (ceiling-of-harm)', async () => {
    const { hirer, gid } = await claimedGig()
    await complete(gid, hirer.token, 2)
    const mine = await call('/reviews/resolving', {}, hirer.token)
    const rid = mine.body.authored[0].id
    const rev = await call(
      `/reviews/${rid}/revise`,
      { method: 'POST', body: JSON.stringify({ rating: 1 }) },
      hirer.token,
    )
    expect(rev.status).toBe(400)
  })

  it('only the author may revise', async () => {
    const { hirer, worker, gid } = await claimedGig()
    await complete(gid, hirer.token, 2)
    const mine = await call('/reviews/resolving', {}, hirer.token)
    const rid = mine.body.authored[0].id
    const rev = await call(
      `/reviews/${rid}/revise`,
      { method: 'POST', body: JSON.stringify({ rating: 5 }) },
      worker.token,
    )
    expect(rev.status).toBe(404)
  })

  it('withdraw removes the held review entirely', async () => {
    const { hirer, worker, gid } = await claimedGig()
    await complete(gid, hirer.token, 1)
    const mine = await call('/reviews/resolving', {}, hirer.token)
    const rid = mine.body.authored[0].id
    expect((await call(`/reviews/${rid}/withdraw`, { method: 'POST' }, hirer.token)).status).toBe(
      200,
    )
    const after = await call('/reviews/resolving', {}, hirer.token)
    expect(after.body.authored).toHaveLength(0)
    const prof = await call(`/users/${worker.id}`, {}, hirer.token)
    expect(prof.body.rating_count).toBe(0)
  })
})

describe('worker reviews the hirer', () => {
  it('is allowed after marking done, even if the hirer never completes', async () => {
    const { hirer, worker, gid } = await claimedGig()
    await call(`/gigs/${gid}/done`, { method: 'POST' }, worker.token)
    const r = await call(
      `/gigs/${gid}/review`,
      { method: 'POST', body: JSON.stringify({ rating: 5, review: 'paid promptly' }) },
      worker.token,
    )
    expect(r.status).toBe(201)
    const prof = await call(`/users/${hirer.id}`, {}, worker.token)
    expect(prof.body.rating_count).toBe(1)
  })

  it('is rejected before the work is marked done (409)', async () => {
    const { worker, gid } = await claimedGig()
    const r = await call(
      `/gigs/${gid}/review`,
      { method: 'POST', body: JSON.stringify({ rating: 5 }) },
      worker.token,
    )
    expect(r.status).toBe(409)
  })

  it('rejects a second review of the same gig by the same author (409)', async () => {
    const { hirer, worker, gid } = await claimedGig()
    await call(`/gigs/${gid}/done`, { method: 'POST' }, worker.token)
    await call(
      `/gigs/${gid}/review`,
      { method: 'POST', body: JSON.stringify({ rating: 5 }) },
      worker.token,
    )
    const again = await call(
      `/gigs/${gid}/review`,
      { method: 'POST', body: JSON.stringify({ rating: 4 }) },
      worker.token,
    )
    expect(again.status).toBe(409)
  })
})

describe('distinct counterparties signal', () => {
  it('counts unique reviewers, not raw reviews', async () => {
    const worker = await register('Worker')
    // two different hirers each complete a gig with this worker at 5★
    for (let i = 0; i < 2; i++) {
      const hirer = await register(`Hirer ${i}`)
      const gid = await postGig(hirer.token)
      await claim(gid, worker.token)
      await clearRateLimits()
      await complete(gid, hirer.token, 5)
    }
    const prof = await call(`/users/${worker.id}`, {}, worker.token)
    expect(prof.body.rating_count).toBe(2)
    expect(prof.body.distinct_counterparties).toBe(2)
  })
})
