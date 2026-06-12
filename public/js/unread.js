// Unread badge on the Me tab: a single count across direct messages, gig
// threads, and review-resolution threads, plus connection requests. Refreshed
// on a gentle poll, on tab navigation, and immediately after a thread is read.

import { api } from './api.js'

let badgeEl = null
let timer = null
const POLL_MS = 30000

export function mountUnreadBadge(tabBtn) {
  if (badgeEl) return // already mounted
  badgeEl = document.createElement('span')
  badgeEl.className = 'tab-badge hidden'
  badgeEl.setAttribute('aria-label', 'unread')
  tabBtn.appendChild(badgeEl)
}

// The latest per-thread breakdown, so the Me view can mark which conversation
// is new. Refreshed alongside the badge.
let latest = { unread: 0, threads: { dm: {}, gig: {}, review: {} } }
export function unreadThreads() {
  return latest.threads
}

// Mirror the unread total onto the installed-PWA OS app badge, when supported.
function setOsBadge(n) {
  if (!('setAppBadge' in navigator)) return
  if (n > 0) navigator.setAppBadge(n).catch(() => {})
  else navigator.clearAppBadge?.().catch(() => {})
}

export async function refreshUnread() {
  try {
    latest = await api.unread()
  } catch {
    return // transient — leave the badge as-is
  }
  const { unread } = latest
  setOsBadge(unread)
  if (!badgeEl) return
  if (unread > 0) {
    badgeEl.textContent = unread > 99 ? '99+' : String(unread)
    badgeEl.classList.remove('hidden')
  } else {
    badgeEl.classList.add('hidden')
  }
}

// Mark a thread read, then refresh the badge. scope ∈ {dm, gig, review}.
export async function markThreadRead(scope, scopeId) {
  try {
    await api.markRead(scope, scopeId)
  } catch {
    // best-effort
  }
  refreshUnread()
}

export function startUnreadPolling() {
  stopUnreadPolling()
  refreshUnread()
  timer = setInterval(() => {
    if (!document.hidden) refreshUnread()
  }, POLL_MS)
}

export function stopUnreadPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  latest = { unread: 0, threads: { dm: {}, gig: {}, review: {} } }
  setOsBadge(0)
  if (badgeEl) badgeEl.classList.add('hidden')
}
