// The "Me" view: name, average rating (large), total gigs — then your reviews and
// your posted/active gigs. CLAIMED gigs you posted get the inline rate panel.
// Also exposes openUserProfile(id) — a read-only sheet for any worker's portfolio.

import { ApiError, api } from './api.js'
import { getUser, logout } from './auth.js'
import { renderRatePanel, renderReviewPanel } from './post.js'
import {
  clear,
  confirmSheet,
  emptyState,
  errorState,
  fmtDate,
  fmtDateTime,
  h,
  money,
  openSheet,
  photoStrip,
  spinner,
  starsText,
  toast,
} from './ui.js'

// main.js sets these so logout returns to the gate and "Edit" opens the gig form.
let onLoggedOut = null
export function setOnLoggedOut(fn) {
  onLoggedOut = fn
}
let onEditGig = null
export function setOnEditGig(fn) {
  onEditGig = fn
}

export function renderProfile(root) {
  clear(root)
  root.append(spinner('Loading your profile…'))
  load(root)
}

async function load(root) {
  const me = getUser()
  if (!me) {
    clear(root)
    root.append(errorState('Not signed in', null))
    return
  }
  try {
    const [pub, self, reviews, mine, resolving] = await Promise.all([
      api.user(me.id),
      api.me(),
      api.userReviews(me.id),
      api.myGigs(),
      api.resolvingReviews(),
    ])
    const profile = { ...pub, ...self, average_rating: pub.average_rating }
    clear(root)
    root.append(headerBlock(me, profile))
    const resolution = resolutionBlock(resolving, root)
    if (resolution) root.append(resolution)
    root.append(moneyBlock(mine))
    root.append(notificationsBlock())
    root.append(businessBlock(profile))
    root.append(changePasswordBlock())
    root.append(gigsBlock(mine, root))
    root.append(reviewsBlock(reviews, me.id))
    root.append(supportBlock())
    root.append(blocksBlock())
    if (profile.is_admin) root.append(adminBlock(root))
    root.append(dangerBlock(root))
  } catch (err) {
    clear(root)
    root.append(
      errorState(err instanceof ApiError ? err.message : 'Could not load profile', () =>
        renderProfile(root),
      ),
    )
  }
}

function headerBlock(me, profile) {
  const avg = profile.average_rating != null ? profile.average_rating.toFixed(2) : '—'
  return h(
    'div',
    { class: 'card me-head' },
    h(
      'div',
      { class: 'me-top' },
      h('h1', { class: 'me-name' }, me.display_name || me.email),
      h('button', { class: 'btn-ghost', onClick: doLogout }, 'Log out'),
    ),
    statsRow(avg, profile),
  )
}

function statsRow(avg, profile) {
  return h(
    'div',
    { class: 'me-stats' },
    stat(
      avg,
      profile.rating_count
        ? `avg · ${profile.rating_count} review${profile.rating_count === 1 ? '' : 's'}`
        : 'no reviews yet',
    ),
    stat(String(profile.total_gigs), profile.total_gigs === 1 ? 'gig done' : 'gigs done'),
    // Distinct reviewers — the hard-to-fake skill signal (sock puppets can't pad it).
    profile.distinct_counterparties
      ? stat(
          String(profile.distinct_counterparties),
          profile.distinct_counterparties === 1 ? 'neighbor' : 'neighbors',
        )
      : null,
  )
}

function stat(big, label) {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'stat-big' }, big),
    h('div', { class: 'stat-label' }, label),
  )
}

async function doLogout() {
  try {
    await logout()
  } finally {
    if (onLoggedOut) onLoggedOut()
  }
}

function gigsBlock(mine, root) {
  const wrap = h('div', { class: 'me-section' }, h('h2', { class: 'section-title' }, 'Your gigs'))

  const posted = mine.posted || []
  const claimed = mine.claimed || []

  if (!posted.length && !claimed.length) {
    wrap.append(emptyState('You haven’t posted or claimed any gigs yet.'))
    return wrap
  }

  if (posted.length) {
    wrap.append(h('h3', { class: 'subhead' }, 'Posted by you'))
    for (const g of posted) wrap.append(postedGigCard(g, root))
  }
  if (claimed.length) {
    wrap.append(h('h3', { class: 'subhead' }, 'Claimed by you'))
    for (const g of claimed) wrap.append(claimedGigCard(g, root))
  }
  return wrap
}

function statusPill(status) {
  return h('span', { class: `pill pill-${status.toLowerCase()}` }, status.toLowerCase())
}

// Held reviews awaiting resolution — both the ones I wrote (which I can raise or
// withdraw) and the ones about me (feedback to act on). Returns null when there's
// nothing pending, so the section only appears when it's relevant.
function resolutionBlock(resolving, root) {
  const authored = resolving?.authored || []
  const aboutMe = resolving?.about_me || []
  if (!authored.length && !aboutMe.length) return null
  const wrap = h(
    'div',
    { class: 'me-section' },
    h('h2', { class: 'section-title' }, 'Reviews in resolution'),
    h(
      'p',
      { class: 'hint' },
      'Low ratings stay private while you talk it through. Raise or withdraw yours; held reviews publish on their own after 7 days.',
    ),
  )

  for (const r of aboutMe) {
    wrap.append(
      h(
        'div',
        { class: 'card gig-row' },
        h('div', { class: 'gig-title' }, `${r.author_name} left feedback`),
        h('div', { class: 'gig-meta' }, r.task_type),
        h('p', { class: 'review-body' }, r.body || 'No note left.'),
        h(
          'p',
          { class: 'hint' },
          `Auto-publishes ${fmtDateTime(r.resolve_deadline)} if unresolved.`,
        ),
        h(
          'button',
          {
            class: 'btn-ghost',
            onClick: async () => {
              try {
                await api.acknowledgeReview(r.id)
                toast('Acknowledged — reply in the gig’s messages to talk it through')
                renderProfile(root)
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Could not acknowledge', 'error')
              }
            },
          },
          'Acknowledge',
        ),
      ),
    )
  }

  for (const r of authored) {
    const card = h(
      'div',
      { class: 'card gig-row' },
      h('div', { class: 'gig-title' }, `Your held review of ${r.subject_name}`),
      h('div', { class: 'gig-meta' }, `${r.task_type} · you rated ${r.stars}★ (held)`),
      r.body ? h('p', { class: 'review-body' }, r.body) : null,
    )
    if (r.counterpart) {
      card.append(
        h(
          'p',
          { class: 'hint' },
          `They rated you ${r.counterpart.stars}★${r.counterpart.body ? `: “${r.counterpart.body}”` : ''} — still want to hold this?`,
        ),
      )
    }
    card.append(
      h(
        'p',
        { class: 'hint' },
        `Auto-publishes ${fmtDateTime(r.resolve_deadline)}.${r.responded ? ' They’ve responded.' : ''}`,
      ),
    )
    const actions = h('div', { class: 'post-actions' })
    for (let n = r.stars + 1; n <= 5; n++) {
      actions.append(
        h(
          'button',
          {
            class: 'btn-ghost',
            onClick: async () => {
              try {
                const res = await api.reviseReview(r.id, n)
                toast(
                  res.review_status === 'PUBLISHED'
                    ? `Raised to ${n}★ — published`
                    : `Raised to ${n}★`,
                )
                renderProfile(root)
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Could not revise', 'error')
              }
            },
          },
          `Raise to ${n}★`,
        ),
      )
    }
    actions.append(
      h(
        'button',
        {
          class: 'btn-ghost danger',
          onClick: async () => {
            try {
              await api.withdrawReview(r.id)
              toast('Review withdrawn')
              renderProfile(root)
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'Could not withdraw', 'error')
            }
          },
        },
        'Withdraw',
      ),
    )
    card.append(actions)
    wrap.append(card)
  }
  return wrap
}

function postedGigCard(g, root) {
  const card = h(
    'div',
    { class: 'card gig-row' },
    h(
      'div',
      { class: 'gig-row-top' },
      h('span', { class: 'gig-title' }, g.task_type),
      statusPill(g.status),
    ),
    h('div', { class: 'gig-meta' }, `${money(g.cash_payout)} · ${g.neighborhood}`),
    g.worker_name
      ? h('div', { class: 'gig-meta' }, 'Worker: ', nameLink(g.worker_name, g.claimed_by))
      : null,
    g.scheduled_at
      ? h('div', { class: 'gig-meta sched' }, `Scheduled: ${fmtDateTime(g.scheduled_at)}`)
      : null,
    photoStrip(g.photos, api.imgUrl),
  )

  if (g.status !== 'AVAILABLE') card.append(messagesThread(g))
  if (g.status === 'AVAILABLE') {
    // Edit (reuses the Post form) + delete, available only before anyone claims it.
    card.append(
      h(
        'div',
        { class: 'post-actions' },
        h('button', { class: 'btn-ghost', onClick: () => onEditGig?.(g) }, 'Edit'),
        h('button', { class: 'btn-ghost danger', onClick: () => deleteGig(g, root) }, 'Delete'),
      ),
    )
  } else if (g.status === 'CLAIMED') {
    if (g.done_at) {
      card.append(h('div', { class: 'gig-meta sched' }, 'Work marked done — review and pay'))
    }
    // Inline inspect + rate panel, plus a way to drop a no-show worker.
    card.append(renderRatePanel(g, () => renderProfile(root)))
    card.append(
      h(
        'div',
        { class: 'post-actions' },
        h(
          'button',
          {
            class: 'btn-ghost danger',
            onClick: async () => {
              try {
                await api.unclaimGig(g.id)
                toast('Worker removed — the gig is open again')
                renderProfile(root)
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Could not remove worker', 'error')
              }
            },
          },
          'Remove worker',
        ),
      ),
    )
  }
  return card
}

async function deleteGig(g, root) {
  try {
    await api.deleteGig(g.id)
    toast('Gig deleted')
    renderProfile(root)
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not delete gig', 'error')
  }
}

function claimedGigCard(g, root) {
  const card = h(
    'div',
    { class: 'card gig-row' },
    h(
      'div',
      { class: 'gig-row-top' },
      h('span', { class: 'gig-title' }, g.task_type),
      statusPill(g.status),
    ),
    h('div', { class: 'gig-meta' }, `${money(g.cash_payout)} · ${g.neighborhood}`),
    g.poster_name
      ? h('div', { class: 'gig-meta' }, 'Hirer: ', nameLink(g.poster_name, g.posted_by))
      : null,
    g.scheduled_at
      ? h('div', { class: 'gig-meta sched' }, `Scheduled: ${fmtDateTime(g.scheduled_at)}`)
      : null,
  )
  card.append(messagesThread(g))
  if (g.status === 'CLAIMED') {
    const actions = h('div', { class: 'post-actions' })
    if (g.done_at) {
      actions.append(h('span', { class: 'gig-meta sched' }, 'Marked done — waiting on the hirer'))
    } else {
      actions.append(
        h(
          'button',
          {
            class: 'btn-ghost',
            onClick: async () => {
              try {
                await api.markGigDone(g.id)
                toast('Marked done — the hirer was notified')
                renderProfile(root)
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Could not mark done', 'error')
              }
            },
          },
          'Mark work done',
        ),
      )
    }
    actions.append(
      h(
        'button',
        {
          class: 'btn-ghost danger',
          onClick: async () => {
            try {
              await api.abandonGig(g.id)
              toast('Claim released — the gig is available again')
              renderProfile(root)
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'Could not release claim', 'error')
            }
          },
        },
        'Release claim',
      ),
    )
    card.append(actions)
  }
  // Once the work is done (or the gig is closed), the worker reviews the hirer —
  // the other half of accountability. Hidden once they've already reviewed.
  if ((g.done_at || g.status === 'COMPLETED') && !g.reviewed_by_me) {
    card.append(renderReviewPanel(g, () => renderProfile(root)))
  }
  return card
}

const PAGE = 20

function reviewsBlock(reviews, userId) {
  const wrap = h('div', { class: 'me-section' }, h('h2', { class: 'section-title' }, 'Reviews'))
  if (!reviews.length) {
    wrap.append(emptyState('No reviews yet — claim and complete a gig to build your portfolio.'))
    return wrap
  }
  const list = h('div', { class: 'list' })
  for (const r of reviews) list.append(reviewCard(r))
  wrap.append(list)
  attachReviewLoadMore(wrap, list, reviews, userId)
  return wrap
}

// Keyset "load more": only shown when the last batch filled a page.
function attachReviewLoadMore(wrap, list, batch, userId) {
  if (batch.length < PAGE) return
  const btn = h('button', { class: 'btn-ghost load-more' }, 'Load more')
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      const more = await api.userReviews(userId, batch[batch.length - 1].created_at)
      for (const r of more) list.append(reviewCard(r))
      btn.remove()
      attachReviewLoadMore(wrap, list, more, userId)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load more', 'error')
      btn.disabled = false
    }
  })
  wrap.append(btn)
}

function reviewCard(r) {
  return h(
    'div',
    { class: 'card review' },
    h(
      'div',
      { class: 'review-top' },
      h('span', { class: 'review-stars' }, starsText(r.stars)),
      h('span', { class: 'review-date' }, fmtDate(r.created_at)),
    ),
    h(
      'div',
      { class: 'gig-meta' },
      `${r.task_type}${r.neighborhood ? ` · ${r.neighborhood}` : ''}`,
    ),
    r.body ? h('p', { class: 'review-body' }, r.body) : null,
    photoStrip(r.photos, api.imgUrl),
    h('div', { class: 'review-by' }, `— ${r.hirer_name || 'hirer'}`),
  )
}

// A tappable name that opens another user's public portfolio. `verified`
// renders the admin-granted business badge.
export function nameLink(name, userId, verified = 0) {
  const label = verified ? `${name || 'Someone'} ✓` : name || 'Someone'
  if (!userId) return document.createTextNode(label)
  return h(
    'button',
    {
      class: verified ? 'link-btn vbadge' : 'link-btn',
      onClick: (e) => {
        e.stopPropagation()
        openUserProfile(userId)
      },
    },
    label,
  )
}

// Read-only portfolio sheet for any user (public columns only).
export async function openUserProfile(userId) {
  const body = h('div', { class: 'sheet-body' }, spinner('Loading profile…'))
  const close = openSheet(body)
  try {
    const [profile, reviews] = await Promise.all([api.user(userId), api.userReviews(userId)])
    clear(body)
    const avg = profile.average_rating != null ? profile.average_rating.toFixed(2) : '—'
    body.append(
      h(
        'h2',
        { class: 'me-name' },
        (profile.display_name || 'Neighbor') + (profile.verified ? ' ✓' : ''),
      ),
      profile.business_name
        ? h(
            'div',
            { class: 'gig-meta' },
            profile.business_name + (profile.verified ? ' · verified business' : ''),
          )
        : null,
      statsRow(avg, profile),
      h(
        'div',
        { class: 'gig-meta' },
        `As a hirer: ${profile.gigs_posted} posted · ${profile.gigs_paid} paid out`,
      ),
      blockToggle(userId, profile.i_blocked),
      h('h3', { class: 'subhead' }, 'Reviews'),
    )
    if (!reviews.length) {
      body.append(emptyState('No reviews yet.'))
    } else {
      const list = h('div', { class: 'list' })
      for (const r of reviews) list.append(reviewCard(r))
      body.append(list)
      attachReviewLoadMore(body, list, reviews, userId)
    }
  } catch (err) {
    clear(body)
    body.append(errorState(err instanceof ApiError ? err.message : 'Could not load profile', null))
  }
}

/* --- Change password --- */

function changePasswordBlock() {
  const current = h('input', {
    class: 'input',
    type: 'password',
    placeholder: 'Current password',
    autocomplete: 'current-password',
    maxlength: '200',
    required: true,
  })
  const next = h('input', {
    class: 'input',
    type: 'password',
    placeholder: 'New password (8+ chars)',
    autocomplete: 'new-password',
    minlength: '8',
    maxlength: '200',
    required: true,
  })
  const save = h('button', { class: 'btn-ghost', type: 'submit' }, 'Update password')
  const form = h(
    'form',
    {
      class: 'form hidden',
      onSubmit: async (e) => {
        e.preventDefault()
        save.disabled = true
        try {
          await api.changePassword(current.value, next.value)
          current.value = ''
          next.value = ''
          form.classList.add('hidden')
          toggle.textContent = 'Change password'
          toast('Password updated')
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not update password', 'error')
        } finally {
          save.disabled = false
        }
      },
    },
    current,
    next,
    save,
  )
  const toggle = h(
    'button',
    {
      class: 'link-btn',
      onClick: () => {
        const open = form.classList.toggle('hidden')
        toggle.textContent = open ? 'Change password' : 'Cancel'
      },
    },
    'Change password',
  )
  return h('div', { class: 'card form' }, toggle, form)
}

/* --- Web push opt-in --- */

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function notificationsBlock() {
  if (!pushSupported()) return document.createTextNode('')
  const btn = h('button', { class: 'btn-ghost' }, 'Enable notifications')
  if (Notification.permission === 'granted') btn.textContent = 'Notifications enabled'
  btn.addEventListener('click', () => enableNotifications(btn))
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'gig-meta' }, 'Get notified when your gig is claimed or your work is rated.'),
    btn,
  )
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

async function enableNotifications(btn) {
  btn.disabled = true
  try {
    const { key } = await api.pushKey()
    if (!key) {
      toast('Notifications aren’t configured on the server yet', 'error')
      return
    }
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      toast('Notifications permission denied', 'error')
      return
    }
    const reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    })
    await api.subscribePush(sub.toJSON())
    btn.textContent = 'Notifications enabled'
    toast('Notifications enabled')
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not enable notifications', 'error')
  } finally {
    btn.disabled = false
  }
}

/* --- Gig message thread (hirer ↔ worker) --- */

function messagesThread(g) {
  const wrap = h('div', { class: 'msg-wrap' })
  const list = h('div', { class: 'comments hidden' })
  const input = h('input', {
    class: 'input',
    type: 'text',
    maxlength: '1000',
    placeholder: 'Message…',
  })
  const sendBtn = h('button', { class: 'btn-ghost', type: 'submit' }, 'Send')
  const form = h(
    'form',
    {
      class: 'comment-form hidden',
      onSubmit: async (e) => {
        e.preventDefault()
        const text = input.value.trim()
        if (!text) return
        sendBtn.disabled = true
        try {
          await api.sendGigMessage(g.id, text)
          input.value = ''
          await loadThread()
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not send', 'error')
        } finally {
          sendBtn.disabled = false
        }
      },
    },
    input,
    sendBtn,
  )

  async function loadThread() {
    try {
      const msgs = await api.gigMessages(g.id)
      clear(list)
      if (!msgs.length) list.append(h('div', { class: 'gig-meta' }, 'No messages yet.'))
      for (const m of msgs) {
        list.append(
          h(
            'div',
            { class: 'comment' },
            h('span', { class: 'comment-author' }, m.sender_name || 'Someone'),
            h('span', { class: 'comment-body' }, m.body),
            h('span', { class: 'comment-date' }, fmtDate(m.created_at)),
          ),
        )
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load messages', 'error')
    }
  }

  const label = g.message_count > 0 ? `Messages (${g.message_count})` : 'Messages'
  const toggle = h(
    'button',
    {
      class: 'btn-ghost',
      onClick: async () => {
        const open = list.classList.toggle('hidden')
        form.classList.toggle('hidden', open)
        toggle.textContent = open ? label : 'Hide messages'
        if (!open) await loadThread()
      },
    },
    label,
  )
  wrap.append(toggle, list, form)
  return wrap
}

/* --- Business / verification --- */

function businessBlock(profile) {
  const name = h('input', {
    class: 'input',
    type: 'text',
    maxlength: '80',
    placeholder: 'Business name (optional)',
  })
  if (profile.business_name) name.value = profile.business_name
  const status = profile.business_name
    ? profile.verified
      ? 'Verified business'
      : 'Verification pending — an admin will review it'
    : 'Registering as a business adds a verified badge once an admin approves it.'
  const save = h('button', { class: 'btn-ghost', type: 'submit' }, 'Save business name')
  return h(
    'form',
    {
      class: 'card form',
      onSubmit: async (e) => {
        e.preventDefault()
        save.disabled = true
        try {
          await api.setBusiness(name.value.trim() || null)
          toast(name.value.trim() ? 'Saved — verification requested' : 'Business name cleared')
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not save', 'error')
        } finally {
          save.disabled = false
        }
      },
    },
    h('div', { class: 'gig-meta' }, status),
    name,
    save,
  )
}

/* --- Help & support --- */

function supportBlock() {
  const wrap = h(
    'div',
    { class: 'me-section' },
    h('h2', { class: 'section-title' }, 'Help & support'),
  )
  const text = h('textarea', {
    class: 'input',
    rows: '2',
    maxlength: '500',
    placeholder: 'Describe the problem — an admin will see this.',
  })
  const send = h('button', { class: 'btn-ghost', type: 'submit' }, 'Send to support')
  const tickets = h('div', { class: 'list' })

  async function loadTickets() {
    try {
      const mine = await api.myReports()
      clear(tickets)
      for (const t of mine.filter((r) => r.kind === 'support').slice(0, 5)) {
        tickets.append(
          h(
            'div',
            { class: 'gig-meta' },
            `${t.status === 'OPEN' ? 'Open' : 'Resolved'} · ${t.reason.slice(0, 60)} · ${fmtDate(t.created_at)}`,
          ),
        )
      }
    } catch {
      // non-fatal
    }
  }
  loadTickets()

  wrap.append(
    h(
      'form',
      {
        class: 'card form',
        onSubmit: async (e) => {
          e.preventDefault()
          const reason = text.value.trim()
          if (!reason) return
          send.disabled = true
          try {
            await api.report('support', null, reason)
            text.value = ''
            toast('Sent — you can check the status here')
            await loadTickets()
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not send', 'error')
          } finally {
            send.disabled = false
          }
        },
      },
      text,
      send,
      tickets,
    ),
  )
  return wrap
}

/* --- Admin panel (visible only to users with is_admin) --- */

function adminBlock(root) {
  const wrap = h('div', { class: 'me-section' }, h('h2', { class: 'section-title' }, 'Admin'))
  const list = h('div', { class: 'list' })
  wrap.append(list)

  async function loadQueue() {
    clear(list)
    list.append(spinner('Loading reports…'))
    try {
      const reports = await api.adminReports()
      clear(list)
      const open = reports.filter((r) => r.status === 'OPEN')
      if (!open.length) {
        list.append(emptyState('No open reports.'))
        return
      }
      for (const r of open) list.append(adminRow(r, loadQueue))
    } catch (err) {
      clear(list)
      list.append(errorState(err instanceof ApiError ? err.message : 'Could not load', loadQueue))
    }
  }

  function adminRow(r, reload) {
    const actions = h('div', { class: 'post-actions' })
    const resolve = h(
      'button',
      {
        class: 'btn-ghost',
        onClick: async () => {
          await api.resolveReport(r.id).catch(() => toast('Failed', 'error'))
          reload()
        },
      },
      'Resolve',
    )
    // Verification requests carry kind=user + the requester as subject.
    if (r.kind === 'user' && r.reason.startsWith('verification request')) {
      actions.append(
        h(
          'button',
          {
            class: 'btn-ghost',
            onClick: async () => {
              try {
                await api.verifyUser(r.subject_id, true)
                await api.resolveReport(r.id)
                toast('Verified')
                reload()
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Failed', 'error')
              }
            },
          },
          'Verify',
        ),
      )
    }
    // Content reports get a remove button matching their kind.
    const removers = {
      post: api.adminDeletePost,
      comment: api.adminDeleteComment,
      gig: api.adminDeleteGig,
    }
    if (removers[r.kind] && r.subject_id) {
      actions.append(
        h(
          'button',
          {
            class: 'btn-ghost danger',
            onClick: async () => {
              try {
                await removers[r.kind](r.subject_id)
                await api.resolveReport(r.id)
                toast('Content removed')
                reload()
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Failed', 'error')
              }
            },
          },
          'Remove content',
        ),
      )
    }
    actions.append(resolve)
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'post-head' },
        h('span', { class: 'post-author' }, `${r.kind} report`),
        h(
          'span',
          { class: 'post-area' },
          `by ${r.reporter_name || '?'} · ${fmtDate(r.created_at)}`,
        ),
      ),
      h('p', { class: 'post-body' }, r.reason),
      actions,
    )
  }

  loadQueue()
  return wrap
}

/* --- Money summary --- */

function moneyBlock(mine) {
  const earned = (mine.claimed || [])
    .filter((g) => g.status === 'COMPLETED')
    .reduce((n, g) => n + g.cash_payout, 0)
  const paid = (mine.posted || [])
    .filter((g) => g.status === 'COMPLETED')
    .reduce((n, g) => n + g.cash_payout, 0)
  return h(
    'div',
    { class: 'card me-stats' },
    stat(money(earned), 'earned'),
    stat(money(paid), 'paid out'),
  )
}

/* --- Block toggle (used in the profile sheet) --- */

function blockToggle(userId, blocked) {
  const btn = h('button', { class: 'btn-ghost danger' }, blocked ? 'Unblock' : 'Block')
  let isBlocked = !!blocked
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      if (isBlocked) await api.unblock(userId)
      else await api.block(userId)
      isBlocked = !isBlocked
      btn.textContent = isBlocked ? 'Unblock' : 'Block'
      toast(isBlocked ? 'Blocked' : 'Unblocked')
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update', 'error')
    } finally {
      btn.disabled = false
    }
  })
  return btn
}

/* --- Blocked-users list (Me) --- */

function blocksBlock() {
  // Static structure built once; load() only refills the list — re-running it
  // (after an unblock) can't duplicate the heading.
  const list = h('div', { class: 'list' })
  const wrap = h(
    'div',
    { class: 'me-section hidden' },
    h('h2', { class: 'section-title' }, 'Blocked'),
    list,
  )
  async function load() {
    try {
      const blocked = await api.blocks()
      clear(list)
      wrap.classList.toggle('hidden', blocked.length === 0)
      for (const u of blocked) {
        list.append(
          h(
            'div',
            { class: 'card gig-row' },
            h('div', { class: 'gig-row-top' }, h('span', {}, u.display_name || 'Someone')),
            h(
              'button',
              {
                class: 'btn-ghost',
                onClick: async () => {
                  await api.unblock(u.id).catch(() => toast('Failed', 'error'))
                  load()
                },
              },
              'Unblock',
            ),
          ),
        )
      }
    } catch {
      wrap.classList.add('hidden')
    }
  }
  load()
  return wrap
}

/* --- Danger zone: close account --- */

function dangerBlock(root) {
  const pw = h('input', {
    class: 'input',
    type: 'password',
    placeholder: 'Confirm password to delete',
    autocomplete: 'current-password',
    maxlength: '200',
    required: true,
  })
  const form = h(
    'form',
    {
      class: 'form hidden',
      onSubmit: async (e) => {
        e.preventDefault()
        const sure = await confirmSheet('Permanently close your account?', {
          body: 'Reviews stay on the ledger but your profile is removed and you are logged out everywhere.',
          confirmLabel: 'Delete account',
          danger: true,
        })
        if (!sure) return
        const btn = form.querySelector('button[type="submit"]')
        btn.disabled = true
        try {
          await api.deleteAccount(pw.value)
          toast('Account closed')
          if (onLoggedOut) onLoggedOut()
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not close account', 'error')
          btn.disabled = false
        }
      },
    },
    pw,
    h('button', { class: 'btn-ghost danger', type: 'submit' }, 'Permanently delete account'),
  )
  const toggle = h(
    'button',
    {
      class: 'link-btn danger',
      onClick: () => {
        form.classList.toggle('hidden')
      },
    },
    'Close account',
  )
  return h('div', { class: 'card form me-section' }, toggle, form)
}
