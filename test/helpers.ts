// Shared helpers for route tests. These arrange real state against the real app
// (no mocks) so each test can assert ONE branch in isolation.

import { env } from 'cloudflare:test'
import { expect } from 'vitest'
import { app } from '../functions/api/[[path]].ts'
// @ts-expect-error — vite raw import of the schema file
import schema from '../schema.sql?raw'

export const E = env as { DB: D1Database; SESSION_SECRET: string; PHOTOS: R2Bucket }

let schemaApplied = false
export async function applySchema() {
  if (schemaApplied) return
  const sql = (schema as string)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  for (const stmt of sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    await E.DB.prepare(stmt).run()
  }
  schemaApplied = true
}

export async function clearRateLimits() {
  await E.DB.prepare('delete from rate_limits').run()
}

let seq = 0
export function uniqueEmail() {
  seq += 1
  return `u${Date.now()}_${seq}@example.com`
}

export async function call(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  const res = await app.request(`/api${path}`, { ...init, headers }, E)
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, raw: text, res }
}

// Like call, but returns the raw Response (for binary bodies like images).
export async function rawRequest(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  return app.request(`/api${path}`, { ...init, headers }, E)
}

export async function register(displayName?: string) {
  const r = await call('/register', {
    method: 'POST',
    body: JSON.stringify({
      email: uniqueEmail(),
      password: 'password123',
      display_name: displayName,
    }),
  })
  expect(r.status).toBe(201)
  return {
    token: r.body.token as string,
    id: r.body.user.id as string,
    email: r.body.user.email as string,
  }
}

export async function postGig(token: string, over: Record<string, unknown> = {}) {
  const r = await call(
    '/gigs',
    {
      method: 'POST',
      body: JSON.stringify({
        task_type: 'Rake leaves',
        neighborhood: 'Front St',
        cash_payout: 40,
        est_hours: 2,
        lat: 34.72,
        lng: -76.66,
        description: 'Front yard',
        ...over,
      }),
    },
    token,
  )
  expect(r.status).toBe(201)
  return r.body.id as string
}

export async function claim(gid: string, token: string) {
  return call(`/gigs/${gid}/claim`, { method: 'POST' }, token)
}

export async function complete(gid: string, token: string, rating = 5, review?: string) {
  return call(
    `/gigs/${gid}/complete`,
    { method: 'POST', body: JSON.stringify({ rating, review }) },
    token,
  )
}
