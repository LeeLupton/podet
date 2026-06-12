// Nearby gigs: geolocation → api.nearbyGigs → readable cards, nearest-first.
// The radius slider re-queries; the view re-queries on focus/visibility (no live
// connection — realtime is deferred per the spec).

import { ApiError, api } from './api.js'
import { getCoords, requestGeolocation, setCoords } from './location.js'
import { nameLink } from './profile.js'
import {
  clear,
  emptyState,
  errorState,
  fmtDateTime,
  h,
  isoToLocalInput,
  localInputToIso,
  money,
  openSheet,
  promptSheet,
  spinner,
  toast,
} from './ui.js'

const DEFAULT_RADIUS = 5
let radius = DEFAULT_RADIUS
let coords = getCoords() // {lat, lng} — remembered across reloads
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
    h(
      'div',
      { class: 'radius-row' },
      h('span', { class: 'radius-label' }, 'Within'),
      radiusValue,
      h('button', { class: 'link-btn', onClick: () => showLocationForm() }, 'Change location'),
    ),
    slider,
  )

  listEl = h('div', { class: 'list' })
  root.append(header, listEl)

  if (!mounted) {
    mounted = true
    // Re-query when the tab/window regains focus.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling()
      else if (isActive(root)) {
        load()
        startPolling(root)
      }
    })
    window.addEventListener('focus', () => {
      if (isActive(root)) load()
    })
  }

  startPolling(root)
  ensureCoordsThenLoad()
}

// Near-realtime: while Nearby is visible+active, re-query on an interval. This is
// the single-deployment alternative to a push feed — no extra Worker/binding.
const POLL_MS = 20000
let pollTimer = null
function startPolling(root) {
  stopPolling()
  pollTimer = setInterval(() => {
    if (!document.hidden && isActive(root) && coords) load()
  }, POLL_MS)
}
export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function isActive(root) {
  return root && !root.classList.contains('hidden')
}

function ensureCoordsThenLoad() {
  if (coords) {
    load()
    return
  }
  // Don't auto-request geolocation — browsers only show the permission prompt in
  // response to a user gesture (a tap), so present the panel and let the user ask.
  showLocationForm()
}

// Non-blocking location: try the device, or type coordinates by hand. Either way
// the choice is remembered, so location is never a dead end (great for local dev,
// non-secure origins, or when the user declines GPS).
function showLocationForm(message) {
  clear(listEl)
  const lat = h('input', {
    class: 'input',
    type: 'number',
    step: 'any',
    min: '-90',
    max: '90',
    placeholder: 'Latitude',
    value: coords ? String(coords.lat) : '',
  })
  const lng = h('input', {
    class: 'input',
    type: 'number',
    step: 'any',
    min: '-180',
    max: '180',
    placeholder: 'Longitude',
    value: coords ? String(coords.lng) : '',
  })

  const useGps = h(
    'button',
    {
      type: 'button',
      class: 'btn-ghost',
      onClick: async () => {
        useGps.textContent = 'Locating…'
        useGps.disabled = true
        try {
          // Called from a tap → the browser shows the permission prompt here.
          coords = setCoords(await requestGeolocation())
          renderFeed(document.getElementById('view-nearby'))
        } catch (err) {
          toast(err.message, 'error')
          useGps.textContent = 'Use my location'
          useGps.disabled = false
        }
      },
    },
    'Use my location',
  )

  const form = h(
    'form',
    {
      class: 'card form',
      onSubmit: (e) => {
        e.preventDefault()
        const la = Number(lat.value)
        const ln = Number(lng.value)
        if (
          !Number.isFinite(la) ||
          !Number.isFinite(ln) ||
          la < -90 ||
          la > 90 ||
          ln < -180 ||
          ln > 180
        ) {
          toast('Enter a valid latitude and longitude', 'error')
          return
        }
        coords = setCoords({ lat: la, lng: ln })
        renderFeed(document.getElementById('view-nearby'))
      },
    },
    h('h2', { class: 'screen-title' }, 'Set your location'),
    message ? h('p', { class: 'hint warn-text' }, message) : null,
    useGps,
    h('div', { class: 'row' }, lat, lng),
    h('button', { type: 'submit', class: 'btn-primary' }, 'Show nearby gigs'),
  )
  listEl.append(form)
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
    h(
      'div',
      { class: 'gig-row-top' },
      h('div', { class: 'payout' }, money(g.cash_payout)),
      g.neighbor ? h('span', { class: 'pill pill-neighbor' }, 'neighbor') : null,
    ),
    h('div', { class: 'gig-title' }, g.task_type),
    h(
      'div',
      { class: 'gig-meta' },
      `${g.distance_mi.toFixed(1)} mi · ${g.est_hours} hr · ${g.neighborhood}`,
    ),
  )
}

function openGig(g) {
  const windowed = !!(g.window_start && g.window_end)
  // Mirror the server's slot rules (functions/lib/schedule.ts validateSlot) in the
  // picker itself: min/max grey out days outside the window, and the notice
  // period pushes min forward so too-soon times can't be picked either.
  const noticeMs = (g.notice_hours || 0) * 3600_000
  const earliestMs = windowed
    ? Math.max(new Date(g.window_start).getTime(), Date.now() + noticeMs)
    : 0
  const latestMs = windowed ? new Date(g.window_end).getTime() : 0
  const unmeetable = windowed && earliestMs > latestMs
  const slotInput =
    windowed && !unmeetable
      ? h('input', {
          class: 'input',
          type: 'datetime-local',
          required: true,
          min: isoToLocalInput(new Date(earliestMs).toISOString()),
          max: isoToLocalInput(new Date(latestMs).toISOString()),
        })
      : null
  const claimBtn = h(
    'button',
    { class: 'btn-primary', onClick: claim, disabled: unmeetable },
    unmeetable ? 'Window has passed' : 'Claim',
  )

  async function claim() {
    if (unmeetable) return
    const slot = windowed ? localInputToIso(slotInput.value) : null
    if (windowed && !slot) {
      toast('Pick a time within the posted window first', 'error')
      return
    }
    if (windowed) {
      // Same checks the server runs — catch them here for an instant, clear message.
      const t = new Date(slot).getTime()
      if (t < new Date(g.window_start).getTime() || t > latestMs) {
        slotInput.reportValidity()
        toast('That time is outside the posted window', 'error')
        return
      }
      if (t < earliestMs) {
        slotInput.reportValidity()
        toast(
          `The hirer needs ${g.notice_hours}h notice — pick ${fmtDateTime(new Date(earliestMs).toISOString())} or later`,
          'error',
        )
        return
      }
    }
    claimBtn.disabled = true
    claimBtn.textContent = 'Claiming…'
    try {
      await api.claimGig(g.id, slot)
      claimBtn.textContent = 'Claimed'
      claimBtn.classList.add('claimed')
      toast('Gig claimed — it’s yours')
      load() // re-query: claimed gig leaves the Nearby list
      setTimeout(close, 900)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not claim gig', 'error')
      if (err instanceof ApiError && err.status === 400) {
        // bad slot — let them fix the time and retry
        claimBtn.disabled = false
        claimBtn.textContent = 'Claim'
      } else {
        // unavailable or your own → re-query
        claimBtn.textContent = 'Unavailable'
        load()
      }
    }
  }

  const content = h(
    'div',
    { class: 'sheet-body' },
    h(
      'div',
      { class: 'gig-row-top' },
      h('div', { class: 'payout payout-lg' }, money(g.cash_payout)),
      g.neighbor ? h('span', { class: 'pill pill-neighbor' }, 'neighbor') : null,
    ),
    h('h2', { class: 'gig-title' }, g.task_type),
    g.neighbor ? h('div', { class: 'gig-meta sched' }, 'Next to a property you manage') : null,
    h(
      'div',
      { class: 'gig-meta' },
      `${g.distance_mi.toFixed(1)} mi · ${g.est_hours} hr · ${g.neighborhood}`,
    ),
    g.poster_name
      ? h(
          'div',
          { class: 'gig-meta' },
          'Posted by ',
          nameLink(g.poster_name, g.posted_by, g.poster_verified),
        )
      : null,
    h('p', { class: 'gig-desc' }, g.description),
    windowed
      ? h(
          'div',
          { class: 'gig-meta' },
          `Works for the hirer: ${fmtDateTime(g.window_start)} – ${fmtDateTime(g.window_end)}${g.notice_hours ? ` · needs ${g.notice_hours}h notice` : ''}`,
        )
      : null,
    unmeetable
      ? h(
          'p',
          { class: 'hint warn-text' },
          'This window can no longer be met with the required notice.',
        )
      : null,
    windowed && !unmeetable
      ? h(
          'label',
          { class: 'lbl' },
          h('span', {}, 'Pick your time'),
          slotInput,
          earliestMs > new Date(g.window_start).getTime()
            ? h(
                'span',
                { class: 'hint' },
                `Earliest you can pick: ${fmtDateTime(new Date(earliestMs).toISOString())}`,
              )
            : null,
        )
      : null,
    mapLink(g),
    claimBtn,
    h(
      'button',
      {
        class: 'link-btn danger',
        onClick: async () => {
          const reason = await promptSheet('Report this gig', {
            placeholder: 'What’s wrong with it? An admin will review this.',
            submitLabel: 'Report',
          })
          if (!reason) return
          try {
            await api.report('gig', g.id, reason)
            toast('Reported — an admin will review it')
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not report', 'error')
          }
        },
      },
      'Report this gig',
    ),
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
    'Open map',
  )
}

// Let other modules invalidate cached coords (e.g. after logout).
export function resetFeed() {
  stopPolling()
  coords = null
  radius = DEFAULT_RADIUS
}
