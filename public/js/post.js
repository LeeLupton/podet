// The "+ Post" screen (single-screen gig creation) and the inspect+rate panel
// shown on your own CLAIMED gigs. Everything routes through api.js.

import { ApiError, api } from './api.js'
import { getCoords, requestGeolocation, setCoords } from './location.js'
import { clear, h, money, openImage, toast } from './ui.js'

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

  // Location: manual lat/lng inputs (so posting works without GPS), seeded from
  // the prefill, then the last location you used in Nearby.
  const seed = prefill?.lat != null ? { lat: prefill.lat, lng: prefill.lng } : getCoords()
  const latInput = h('input', {
    class: 'input',
    type: 'number',
    step: 'any',
    placeholder: 'Latitude',
    value: seed ? String(seed.lat) : '',
  })
  const lngInput = h('input', {
    class: 'input',
    type: 'number',
    step: 'any',
    placeholder: 'Longitude',
    value: seed ? String(seed.lng) : '',
  })

  const locBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn-ghost',
      onClick: async () => {
        locBtn.textContent = 'Locating…'
        locBtn.disabled = true
        try {
          const c = await requestGeolocation()
          latInput.value = String(c.lat)
          lngInput.value = String(c.lng)
        } catch (err) {
          toast(err.message, 'error')
        } finally {
          locBtn.textContent = '📍 Use my location'
          locBtn.disabled = false
        }
      },
    },
    '📍 Use my location',
  )

  const f = {
    task_type: field('Task', 'text', 'e.g. Rake leaves', prefill?.task_type),
    neighborhood: field('Neighborhood', 'text', 'e.g. Front St', prefill?.neighborhood),
    cash_payout: field('Cash payout ($)', 'number', '40', prefill?.cash_payout, {
      min: '0',
      step: '1',
    }),
    est_hours: field('Estimated hours', 'number', '2', prefill?.est_hours, {
      min: '0.5',
      step: '0.5',
    }),
  }

  const description = h('textarea', {
    class: 'input',
    rows: '4',
    placeholder: 'What needs doing? Any details the worker should know.',
    required: true,
  })
  if (prefill?.description) description.value = prefill.description

  const isEdit = !!prefill?.editId
  const submitBtn = h(
    'button',
    { type: 'submit', class: 'btn-primary' },
    isEdit ? 'Save changes' : 'Post gig',
  )

  const form = h(
    'form',
    {
      class: 'card form',
      onSubmit: async (e) => {
        e.preventDefault()
        const lat = Number(latInput.value)
        const lng = Number(lngInput.value)
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          lat < -90 ||
          lat > 90 ||
          lng < -180 ||
          lng > 180
        ) {
          toast('Set a valid location for the gig first', 'error')
          return
        }
        setCoords({ lat, lng }) // remember for Nearby + next post
        const gig = {
          task_type: f.task_type.input.value.trim(),
          neighborhood: f.neighborhood.input.value.trim(),
          cash_payout: Number(f.cash_payout.input.value),
          est_hours: Number(f.est_hours.input.value),
          description: description.value.trim(),
          lat,
          lng,
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
    prefill?.from_post_id ? h('p', { class: 'hint' }, 'Started from a board post.') : null,
    f.task_type.wrap,
    f.neighborhood.wrap,
    h('div', { class: 'row' }, f.cash_payout.wrap, f.est_hours.wrap),
    labeled('Description', description),
    labeled(
      'Location',
      h('div', { class: 'loc-fields' }, locBtn, h('div', { class: 'row' }, latInput, lngInput)),
    ),
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
  const note = h('textarea', {
    class: 'input',
    rows: '2',
    placeholder: 'Optional note for the review',
  })
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

  // Photos of the finished work — uploaded to the gig now; they show on both
  // the worker's portfolio and your profile after you close & pay.
  const thumbs = h('div', { class: 'photo-strip' })
  const photos = (gig.photos || []).slice()
  function paintThumbs() {
    clear(thumbs)
    for (const p of photos) {
      thumbs.append(
        h(
          'div',
          { class: 'thumb-wrap' },
          h('img', {
            class: 'thumb',
            src: api.imgUrl(p.key),
            alt: 'work photo',
            loading: 'lazy',
            onClick: () => openImage(api.imgUrl(p.key)),
          }),
          h(
            'button',
            {
              type: 'button',
              class: 'thumb-x',
              'aria-label': 'Remove photo',
              onClick: async () => {
                try {
                  await api.deleteGigPhoto(gig.id, p.id)
                  photos.splice(photos.indexOf(p), 1)
                  paintThumbs()
                } catch (err) {
                  toast(err instanceof ApiError ? err.message : 'Could not remove photo', 'error')
                }
              },
            },
            '×',
          ),
        ),
      )
    }
  }
  paintThumbs()

  const fileInput = h('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    multiple: true,
    class: 'hidden',
    onChange: async (e) => {
      const files = Array.from(e.target.files || [])
      e.target.value = ''
      for (const file of files) {
        try {
          const res = await api.uploadGigPhoto(gig.id, file)
          photos.push({ id: res.id, key: res.key })
          paintThumbs()
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not upload photo', 'error')
        }
      }
    },
  })
  const addPhotoBtn = h(
    'button',
    { type: 'button', class: 'btn-ghost', onClick: () => fileInput.click() },
    '📷 Add work photos',
  )

  return h(
    'div',
    { class: 'rate-panel' },
    h('div', { class: 'rate-head' }, 'Rate ', h('strong', {}, gig.worker_name || 'the worker')),
    h('div', { class: 'stars-row' }, ...starBtns),
    note,
    thumbs,
    addPhotoBtn,
    fileInput,
    payBtn,
  )
}
