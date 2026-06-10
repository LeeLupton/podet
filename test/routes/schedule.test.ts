import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applySchema, call, clearRateLimits, postGig, register } from '../helpers.ts'

beforeAll(applySchema)
beforeEach(clearRateLimits)

// A window comfortably in the future relative to test time.
const DAY = 86_400_000
const ws = new Date(Date.now() + 2 * DAY).toISOString()
const we = new Date(Date.now() + 3 * DAY).toISOString()
const inside = new Date(Date.now() + 2 * DAY + 3_600_000).toISOString()

function claimAt(gid: string, token: string, scheduled_at: string | null) {
  return call(
    `/gigs/${gid}/claim`,
    { method: 'POST', body: JSON.stringify({ scheduled_at }) },
    token,
  )
}

describe('windowed gig creation', () => {
  it('stores the window and notice on the gig', async () => {
    const hirer = await register()
    const gid = await postGig(hirer.token, { window_start: ws, window_end: we, notice_hours: 4 })
    const g = await call(`/gigs/${gid}`, {}, hirer.token)
    expect(g.body.window_start).toBe(ws)
    expect(g.body.window_end).toBe(we)
    expect(g.body.notice_hours).toBe(4)
  })

  it('rejects a window with end before start (400)', async () => {
    const hirer = await register()
    const r = await call(
      '/gigs',
      {
        method: 'POST',
        body: JSON.stringify({
          task_type: 't',
          neighborhood: 'n',
          cash_payout: 1,
          est_hours: 1,
          lat: 34.72,
          lng: -76.66,
          description: 'd',
          window_start: we,
          window_end: ws,
        }),
      },
      hirer.token,
    )
    expect(r.status).toBe(400)
  })
})

describe('claiming a windowed gig', () => {
  it('rejects a claim with no slot (400)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token, { window_start: ws, window_end: we })
    expect((await call(`/gigs/${gid}/claim`, { method: 'POST' }, worker.token)).status).toBe(400)
  })

  it('rejects a slot outside the window (400)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token, { window_start: ws, window_end: we })
    const outside = new Date(Date.now() + 5 * DAY).toISOString()
    expect((await claimAt(gid, worker.token, outside)).status).toBe(400)
  })

  it('rejects a slot inside the notice period (400)', async () => {
    const hirer = await register()
    const worker = await register()
    // window starts in 2 days but the hirer needs 100h (>4 days) notice
    const gid = await postGig(hirer.token, {
      window_start: ws,
      window_end: we,
      notice_hours: 100,
    })
    expect((await claimAt(gid, worker.token, inside)).status).toBe(400)
  })

  it('accepts a valid slot and stores scheduled_at (200)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token, { window_start: ws, window_end: we, notice_hours: 1 })
    const r = await claimAt(gid, worker.token, inside)
    expect(r.status).toBe(200)
    const g = await call(`/gigs/${gid}`, {}, hirer.token)
    expect(g.body.scheduled_at).toBe(new Date(inside).toISOString())
  })

  it('abandon clears the scheduled slot', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token, { window_start: ws, window_end: we })
    await claimAt(gid, worker.token, inside)
    await call(`/gigs/${gid}/abandon`, { method: 'POST' }, worker.token)
    const g = await call(`/gigs/${gid}`, {}, hirer.token)
    expect(g.body.scheduled_at).toBeNull()
  })

  it('windowless gigs still claim with no body (200)', async () => {
    const hirer = await register()
    const worker = await register()
    const gid = await postGig(hirer.token)
    expect((await call(`/gigs/${gid}/claim`, { method: 'POST' }, worker.token)).status).toBe(200)
  })
})
