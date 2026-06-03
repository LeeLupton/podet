// The "+ Post" screen (single-screen gig creation) and the inspect+rate panel
// shown on your own CLAIMED gigs. Everything routes through api.js.

import { api, ApiError } from './api.js'
import { h, clear, toast, money } from './ui.js'

// Optional prefill when "Turn into a gig" comes from a board post.
let pendingPrefill = null
export function setPrefill(data) {
  pendingPrefill = data
}

// Callback the host (main.js) sets so a successful post can return to Nearby.
let onPosted = null
export function setOnPosted(fn) {
  onPosted = fn
}

export function renderPostForm(root) {
  clear(root)
  const prefill = pendingPrefill
  pendingPrefill = null

  // location pin state (lat/lng), optionally seeded from a post.
  const pin = { lat: prefill?.lat ?? null, lng: prefill?.lng ?? null }

  const pinLabel = h(
    'span',
    { class: 'pin-label' },
    pin.lat != null ? 'Pin set ✓' : 'No location yet',
  )

  const locBtn = h(
    'button',
    { type: 'button', class: 'btn-ghost', onClick: useLocation },
    'Use my location',
  )

  function useLocation() {
    if (!navigator.geolocation) {
      toast('Geolocation not available on this device', 'error')
      return
    }
    locBtn.textContent = 'Locating…'
    locBtn.disabled = true
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        pin.lat = pos.coords.latitude
        pin.lng = pos.coords.longitude
        pinLabel.textContent = 'Pin set ✓'
        locBtn.textContent = 'Update location'
        locBtn.disabled = false
      },
      () => {
        toast('Could not get your location', 'error')
        locBtn.textContent = 'Use my location'
        locBtn.disabled = false
      },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  const f = {
    task_type: field('Task', 'text', 'e.g. Rake leaves', prefill?.task_type),
    neighborhood: field('Neighborhood', 'text', 'e.g. Front St', prefill?.neighborhood),
    cash_payout: field('Cash payout ($)', 'number', '40', prefill?.cash_payout, { min: '0', step: '1' }),
    est_hours: field('Estimated hours', 'number', '2', prefill?.est_hours, { min: '0.5', step: '0.5' }),
  }

  const description = h('textarea', {
    class: 'input',
    rows: '4',
    placeholder: 'What needs doing? Any details the worker should know.',
    required: true,
  })
  if (prefill?.description) description.value = prefill.description

  const isEdit = !!prefill?.editId
  const submitBtn = h('button', { type: 'submit', class: 'btn-primary' }, isEdit ? 'Save changes' : 'Post gig')

  const form = h(
    'form',
    {
      class: 'card form',
      onSubmit: async (e) => {
        e.preventDefault()
        if (pin.lat == null || pin.lng == null) {
          toast('Set a location for the gig first', 'error')
          return
        }
        const gig = {
          task_type: f.task_type.input.value.trim(),
          neighborhood: f.neighborhood.input.value.trim(),
          cash_payout: Number(f.cash_payout.input.value),
          est_hours: Number(f.est_hours.input.value),
          description: description.value.trim(),
          lat: pin.lat,
          lng: pin.lng,
          from_post_id: prefill?.from_post_id ?? null,
        }
        submitBtn.disabled = true
        submitBtn.textContent = isEdit ? 'Saving…' : 'Posting…'
        try {
          if (isEdit) await api.updateGig(prefill.editId, gig)
          else await api.createGig(gig)
          toast(isEdit ? 'Gig updated' : 'Gig posted')
          if (onPosted) onPosted()
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not save gig', 'error')
          submitBtn.disabled = false
          submitBtn.textContent = isEdit ? 'Save changes' : 'Post gig'
        }
      },
    },
    h('h1', { class: 'screen-title' }, isEdit ? 'Edit gig' : 'Post a gig'),
    prefill?.from_post_id
      ? h('p', { class: 'hint' }, 'Started from a board post.')
      : null,
    f.task_type.wrap,
    f.neighborhood.wrap,
    h('div', { class: 'row' }, f.cash_payout.wrap, f.est_hours.wrap),
    labeled('Description', description),
    labeled('Location', h('div', { class: 'loc' }, locBtn, pinLabel)),
    submitBtn,
  )

  root.append(form)
}

function field(label, type, placeholder, value, extra = {}) {
  const input = h('input', { class: 'input', type, placeholder, required: true, ...extra })
  if (value != null) input.value = value
  return { input, wrap: labeled(label, input) }
}

function labeled(label, control) {
  return h('label', { class: 'lbl' }, h('span', {}, label), control)
}

// Inline rate panel for a CLAIMED gig you posted. Calls completeGig; server
// rejects non-owners. onDone() is invoked after a successful close & pay.
export function renderRatePanel(gig, onDone) {
  let selected = 0
  const starBtns = []
  const note = h('textarea', { class: 'input', rows: '2', placeholder: 'Optional note for the review' })
  const payBtn = h('button', { class: 'btn-primary', disabled: true }, 'Close & pay')

  function paint() {
    starBtns.forEach((b, i) => {
      b.classList.toggle('star-on', i < selected)
      b.setAttribute('aria-pressed', i < selected ? 'true' : 'false')
    })
    payBtn.disabled = selected < 1
  }

  for (let i = 1; i <= 5; i++) {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'star',
        'aria-label': `${i} star${i > 1 ? 's' : ''}`,
        onClick: () => {
          selected = i
          paint()
        },
      },
      '★',
    )
    starBtns.push(b)
  }

  payBtn.addEventListener('click', async () => {
    if (selected < 1) return
    payBtn.disabled = true
    payBtn.textContent = 'Closing…'
    try {
      await api.completeGig(gig.id, selected, note.value.trim() || null)
      toast(`Paid ${money(gig.cash_payout)} · rated ${selected}★`)
      if (onDone) onDone()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not complete gig', 'error')
      payBtn.disabled = false
      payBtn.textContent = 'Close & pay'
    }
  })

  return h(
    'div',
    { class: 'rate-panel' },
    h('div', { class: 'rate-head' }, 'Rate ', h('strong', {}, gig.worker_name || 'the worker')),
    h('div', { class: 'stars-row' }, ...starBtns),
    note,
    payBtn,
  )
}
