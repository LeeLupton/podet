// The "Me" view: name, average rating (large), total gigs — then your reviews and
// your posted/active gigs. CLAIMED gigs you posted get the inline rate panel.

import { api, ApiError } from './api.js'
import { getUser, logout } from './auth.js'
import { h, clear, toast, spinner, errorState, emptyState, starsText, money, fmtDate } from './ui.js'
import { renderRatePanel } from './post.js'

// main.js sets this so logout can return to the auth gate.
let onLoggedOut = null
export function setOnLoggedOut(fn) {
  onLoggedOut = fn
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
    const [profile, reviews, mine] = await Promise.all([
      api.user(me.id),
      api.userReviews(me.id),
      api.myGigs(),
    ])
    clear(root)
    root.append(headerBlock(me, profile))
    root.append(gigsBlock(mine, root))
    root.append(reviewsBlock(reviews))
  } catch (err) {
    clear(root)
    root.append(errorState(err instanceof ApiError ? err.message : 'Could not load profile', () => renderProfile(root)))
  }
}

function headerBlock(me, profile) {
  const avg = profile.average_rating != null ? profile.average_rating.toFixed(2) : '—'
  return h(
    'div',
    { class: 'card me-head' },
    h('div', { class: 'me-top' },
      h('h1', { class: 'me-name' }, me.display_name || me.email),
      h('button', { class: 'btn-ghost', onClick: doLogout }, 'Log out'),
    ),
    h(
      'div',
      { class: 'me-stats' },
      stat(avg, profile.rating_count ? `avg · ${profile.rating_count} review${profile.rating_count === 1 ? '' : 's'}` : 'no reviews yet'),
      stat(String(profile.total_gigs), profile.total_gigs === 1 ? 'gig done' : 'gigs done'),
    ),
  )
}

function stat(big, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-big' }, big), h('div', { class: 'stat-label' }, label))
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
    for (const g of claimed) wrap.append(claimedGigCard(g))
  }
  return wrap
}

function statusPill(status) {
  return h('span', { class: `pill pill-${status.toLowerCase()}` }, status.toLowerCase())
}

function postedGigCard(g, root) {
  const card = h(
    'div',
    { class: 'card gig-row' },
    h('div', { class: 'gig-row-top' },
      h('span', { class: 'gig-title' }, g.task_type),
      statusPill(g.status),
    ),
    h('div', { class: 'gig-meta' }, `${money(g.cash_payout)} · ${g.neighborhood}`),
    g.worker_name ? h('div', { class: 'gig-meta' }, `Worker: ${g.worker_name}`) : null,
  )
  // Your own CLAIMED gig → inline inspect + rate panel.
  if (g.status === 'CLAIMED') {
    card.append(renderRatePanel(g, () => renderProfile(root)))
  }
  return card
}

function claimedGigCard(g) {
  return h(
    'div',
    { class: 'card gig-row' },
    h('div', { class: 'gig-row-top' },
      h('span', { class: 'gig-title' }, g.task_type),
      statusPill(g.status),
    ),
    h('div', { class: 'gig-meta' }, `${money(g.cash_payout)} · ${g.neighborhood}`),
    g.poster_name ? h('div', { class: 'gig-meta' }, `Hirer: ${g.poster_name}`) : null,
  )
}

function reviewsBlock(reviews) {
  const wrap = h('div', { class: 'me-section' }, h('h2', { class: 'section-title' }, 'Reviews'))
  if (!reviews.length) {
    wrap.append(emptyState('No reviews yet — claim and complete a gig to build your portfolio.'))
    return wrap
  }
  for (const r of reviews) {
    wrap.append(
      h(
        'div',
        { class: 'card review' },
        h('div', { class: 'review-top' },
          h('span', { class: 'review-stars' }, starsText(r.stars)),
          h('span', { class: 'review-date' }, fmtDate(r.created_at)),
        ),
        h('div', { class: 'gig-meta' }, `${r.task_type}${r.neighborhood ? ' · ' + r.neighborhood : ''}`),
        r.body ? h('p', { class: 'review-body' }, r.body) : null,
        h('div', { class: 'review-by' }, `— ${r.hirer_name || 'hirer'}`),
      ),
    )
  }
  return wrap
}
