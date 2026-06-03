// Rate-limit math — pure. The D1 read/write lives in the handler; this module
// computes the deterministic parts so they can be unit-tested.

export function rateLimitKey(route: string, ip: string): string {
  return `${route}:${ip}`
}

// Start (unix seconds) of the fixed window containing `nowSec`.
export function windowStart(nowSec: number, windowSec: number): number {
  return nowSec - (nowSec % windowSec)
}
