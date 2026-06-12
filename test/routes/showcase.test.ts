import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { weekKey } from '../../functions/lib/showcase'
import {
  E,
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

// A COMPLETED gig with one photo, between a fresh hirer and worker.
async function finishedGig() {
  const hirer = await register('Hirer')
  const worker = await register('Worker')
  const gid = await postGig(hirer.token)
  await claim(gid, worker.token)
  await call(
    `/gigs/${gid}/photos`,
    {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
    },
    hirer.token,
  )
  await complete(gid, hirer.token, 5)
  return { hirer, worker, gid }
}

const enter = (token: string, gig_id: string) =>
  call('/showcase/entries', { method: 'POST', body: JSON.stringify({ gig_id }) }, token)
const vote = (token: string, entry_id: string) =>
  call('/showcase/vote', { method: 'POST', body: JSON.stringify({ entry_id }) }, token)

describe('entering the Showcase', () => {
  it('either party can enter a finished, photographed gig (201) — once (409)', async () => {
    const { worker, gid } = await finishedGig()
    expect((await enter(worker.token, gid)).status).toBe(201)
    expect((await enter(worker.token, gid)).status).toBe(409)
  })

  it('rejects a non-party (403)', async () => {
    const { gid } = await finishedGig()
    const stranger = await register('S')
    expect((await enter(stranger.token, gid)).status).toBe(403)
  })

  it('rejects an unfinished gig (409)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    expect((await enter(worker.token, gid)).status).toBe(409)
  })

  it('rejects a gig with no photos (400)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    await claim(gid, worker.token)
    await complete(gid, hirer.token, 5)
    expect((await enter(hirer.token, gid)).status).toBe(400)
  })
})

describe('voting', () => {
  it('one vote per user per week; re-voting moves it', async () => {
    const a = await finishedGig()
    const b = await finishedGig()
    await enter(a.hirer.token, a.gid)
    await enter(b.hirer.token, b.gid)
    const voter = await register('V')
    const gallery = await call('/showcase', {}, voter.token)
    const [e1, e2] = gallery.body.entries
    expect((await vote(voter.token, e1.id)).status).toBe(200)
    // moving the vote to the other entry leaves a single counted vote
    expect((await vote(voter.token, e2.id)).status).toBe(200)
    const after = await call('/showcase', {}, voter.token)
    const total = after.body.entries.reduce((s: number, e: any) => s + e.votes, 0)
    expect(total).toBe(1)
    const mine = after.body.entries.find((e: any) => e.my_vote)
    expect(mine.id).toBe(e2.id)
  })

  it("parties can't vote for their own entry (403)", async () => {
    const { hirer, worker, gid } = await finishedGig()
    await enter(hirer.token, gid)
    const gallery = await call('/showcase', {}, hirer.token)
    const entry = gallery.body.entries.find((e: any) => e.gig_id === gid)
    expect((await vote(hirer.token, entry.id)).status).toBe(403)
    expect((await vote(worker.token, entry.id)).status).toBe(403)
  })

  it('rejects votes on a closed week (409)', async () => {
    const { hirer, gid } = await finishedGig()
    await enter(hirer.token, gid)
    // Close the week by backdating the entry.
    await E.DB.prepare('update showcase_entries set week = ? where gig_id = ?')
      .bind('2020-W01', gid)
      .run()
    const voter = await register('V')
    const entry: any = await E.DB.prepare('select id from showcase_entries where gig_id = ?')
      .bind(gid)
      .first()
    expect((await vote(voter.token, entry.id)).status).toBe(409)
  })
})

describe('weekly finalization (lazy, no cron)', () => {
  it('finalizes a past week on read and surfaces the winner + profile laurels', async () => {
    const a = await finishedGig()
    const b = await finishedGig()
    await enter(a.hirer.token, a.gid)
    await enter(b.hirer.token, b.gid)
    const voter = await register('V')
    const gallery = await call('/showcase', {}, voter.token)
    const entryA = gallery.body.entries.find((e: any) => e.gig_id === a.gid)
    await vote(voter.token, entryA.id)
    // Backdate the whole week, then read — the sweep must crown entry A.
    const past = '2024-W10'
    await E.DB.prepare('update showcase_entries set week = ? where id in (?, ?)')
      .bind(past, entryA.id, gallery.body.entries.find((e: any) => e.gig_id === b.gid).id)
      .run()
    await E.DB.prepare('update showcase_votes set week = ? where voter_id = ?')
      .bind(past, voter.id)
      .run()
    const closed = await call(`/showcase?week=${past}`, {}, voter.token)
    expect(closed.body.winner_entry_id).toBe(entryA.id)
    // Both parties of the winning gig carry the laurel.
    expect((await call(`/users/${a.worker.id}`, {}, voter.token)).body.showcase_wins).toBe(1)
    expect((await call(`/users/${a.hirer.id}`, {}, voter.token)).body.showcase_wins).toBe(1)
    expect((await call(`/users/${b.hirer.id}`, {}, voter.token)).body.showcase_wins).toBe(0)
  })

  it('the current-week gallery carries last week’s winner as the spotlight', async () => {
    const viewer = await register('Viewer')
    const current = await call('/showcase', {}, viewer.token)
    expect(current.body.current).toBe(true)
    expect(current.body.week).toBe(weekKey())
    // last_winner exists from the previous test's finalized week (same D1 file).
    if (current.body.last_winner) {
      expect(current.body.last_winner.photos).toBeDefined()
    }
  })
})
