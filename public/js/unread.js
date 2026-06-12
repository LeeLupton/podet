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

export async function refreshUnread() {
  if (!badgeEl) return
  try {
    const { unread } = await api.unread()
    if (unread > 0) {
      badgeEl.textContent = unread > 99 ? '99+' : String(unread)
      badgeEl.classList.remove('hidden')
    } else {
      badgeEl.classList.add('hidden')
    }
  } catch {
    // transient — leave the badge as-is
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
  if (badgeEl) badgeEl.classList.add('hidden')
}
