// Nearby gigs: geolocation → api.nearbyGigs → readable cards, nearest-first.
// The radius slider re-queries; the view re-queries on focus/visibility (no live
// connection — realtime is deferred per the spec).

import { ApiError, api } from './api.js'
import { nameLink } from './profile.js'
import { clear, emptyState, errorState, h, money, openSheet, spinner, toast } from './ui.js'

const DEFAULT_RADIUS = 5
let radius = DEFAULT_RADIUS
let coords = null // {lat, lng}
let listEl = null
let mounted = false

export function renderFeed(root) {
  clear(root)

  const radiusValue = h('span', { class: 'radius-val' }, `${radius} mi`)
  const slider = h('input', {
    type: 'range',
    class: 'slider',
    min: '1',
    max: '25',
    step: '1',
    value: String(radius),
    'aria-label': 'Search radius in miles',
    onInput: (e) => {
      radiusValue.textContent = `${e.target.value} mi`
    },
    onChange: (e) => {
      radius = Number(e.target.value)
      load()
    },
  })

  const header = h(
    'div',
    { class: 'feed-header' },
    h('div', { class: 'radius-row' }, h('span', { class: 'radius-label' }, 'Within'), radiusValue),
    slider,
  )

  listEl = h('div', { class: 'list' })
  root.append(header, listEl)

  if (!mounted) {
    mounted = true
    // Re-query when the tab/window regains focus.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isActive(root)) load()
    })
    window.addEventListener('focus', () => {
      if (isActive(root)) load()
    })
  }

  ensureCoordsThenLoad()
}

function isActive(root) {
  return root && !root.classList.contains('hidden')
}

function ensureCoordsThenLoad() {
  if (coords) {
    load()
    return
  }
  clear(listEl)
  listEl.append(spinner('Finding your location…'))
  if (!navigator.geolocation) {
    clear(listEl)
    listEl.append(errorState('Location unavailable on this device', null))
    return
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
      load()
    },
    () => {
      clear(listEl)
      listEl.append(
        errorState(
          'Location permission denied — enable it to see nearby gigs',
          ensureCoordsThenLoad,
        ),
      )
    },
    { enableHighAccuracy: true, timeout: 10000 },
  )
}

async function load() {
  if (!coords || !listEl) return
  clear(listEl)
  listEl.append(spinner('Loading nearby gigs…'))
  try {
    const gigs = await api.nearbyGigs(coords.lat, coords.lng, radius)
    clear(listEl)
    if (!gigs.length) {
      listEl.append(emptyState(`No gigs within ${radius} mi — widen the range above.`))
      return
    }
    for (const g of gigs) listEl.append(gigCard(g))
  } catch (err) {
    clear(listEl)
    listEl.append(errorState(err instanceof ApiError ? err.message : 'Could not load gigs', load))
  }
}

function gigCard(g) {
  return h(
    'button',
    { class: 'card gig-card', onClick: () => openGig(g) },
    h('div', { class: 'payout' }, money(g.cash_payout)),
    h('div', { class: 'gig-title' }, g.task_type),
    h(
      'div',
      { class: 'gig-meta' },
      `${g.distance_mi.toFixed(1)} mi · ${g.est_hours} hr · ${g.neighborhood}`,
    ),
  )
}

function openGig(g) {
  const claimBtn = h('button', { class: 'btn-primary', onClick: claim }, 'Claim')

  async function claim() {
    claimBtn.disabled = true
    claimBtn.textContent = 'Claiming…'
    try {
      await api.claimGig(g.id)
      claimBtn.textContent = 'Claimed ✓'
      claimBtn.classList.add('claimed')
      toast('Gig claimed — it’s yours')
      load() // re-query: claimed gig leaves the Nearby list
      setTimeout(close, 900)
    } catch (err) {
      // "unavailable or your own" → re-query and inform inline
      claimBtn.textContent = 'Unavailable'
      toast(err instanceof ApiError ? err.message : 'Could not claim gig', 'error')
      load()
    }
  }

  const content = h(
    'div',
    { class: 'sheet-body' },
    h('div', { class: 'payout payout-lg' }, money(g.cash_payout)),
    h('h2', { class: 'gig-title' }, g.task_type),
    h(
      'div',
      { class: 'gig-meta' },
      `${g.distance_mi.toFixed(1)} mi · ${g.est_hours} hr · ${g.neighborhood}`,
    ),
    g.poster_name
      ? h('div', { class: 'gig-meta' }, 'Posted by ', nameLink(g.poster_name, g.posted_by))
      : null,
    h('p', { class: 'gig-desc' }, g.description),
    mapLink(g),
    claimBtn,
  )
  const close = openSheet(content)
}

function mapLink(g) {
  if (g.lat == null || g.lng == null) return null
  return h(
    'a',
    {
      class: 'btn-ghost map-link',
      href: `https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lng}#map=17/${g.lat}/${g.lng}`,
      target: '_blank',
      rel: 'noopener',
    },
    '📍 View map pin',
  )
}

// Let other modules invalidate cached coords (e.g. after logout).
export function resetFeed() {
  coords = null
  radius = DEFAULT_RADIUS
}
