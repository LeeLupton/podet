// The "+ Post" screen (single-screen gig creation) and the inspect+rate panel
// shown on your own CLAIMED gigs. Everything routes through api.js.

import { ApiError, api } from './api.js'
import { getCoords, requestGeolocation, setCoords } from './location.js'
import { clear, h, isoToLocalInput, localInputToIso, money, openImage, toast } from './ui.js'

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
    min: '-90',
    max: '90',
    placeholder: 'Latitude',
    value: seed ? String(seed.lat) : '',
  })
  const lngInput = h('input', {
    class: 'input',
    type: 'number',
    step: 'any',
    min: '-180',
    max: '180',
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
          locBtn.textContent = 'Use my location'
          locBtn.disabled = false
        }
      },
    },
    'Use my location',
  )

  const f = {
    task_type: field('Task', 'text', 'e.g. Rake leaves', prefill?.task_type, { maxlength: '80' }),
    neighborhood: field('Neighborhood', 'text', 'e.g. Front St', prefill?.neighborhood, {
      maxlength: '80',
    }),
    cash_payout: field('Cash payout ($)', 'number', '40', prefill?.cash_payout, {
      min: '0',
      max: '1000000',
      step: '1',
    }),
    est_hours: field('Estimated hours', 'number', '2', prefill?.est_hours, {
      min: '0.5',
      max: '10000',
      step: '0.5',
    }),
  }

  const description = h('textarea', {
    class: 'input',
    rows: '4',
    maxlength: '2000',
    placeholder: 'What needs doing? Any details the worker should know.',
    required: true,
  })
  if (prefill?.description) description.value = prefill.description

  // Scheduling: hours that work for the hirer + minimum notice. The worker
  // picks a slot inside this window when claiming. The pickers grey out the
  // past, and the end picker follows the chosen start.
  const nowLocal = isoToLocalInput(new Date().toISOString())
  const winStart = h('input', {
    class: 'input',
    type: 'datetime-local',
    min: nowLocal,
    value: isoToLocalInput(prefill?.window_start),
  })
  const winEnd = h('input', {
    class: 'input',
    type: 'datetime-local',
    min: isoToLocalInput(prefill?.window_start) || nowLocal,
    value: isoToLocalInput(prefill?.window_end),
  })
  winStart.addEventListener('change', () => {
    winEnd.min = winStart.value || nowLocal
  })
  const noticeInput = h('input', {
    class: 'input',
    type: 'number',
    min: '0',
    max: '720',
    step: '1',
    placeholder: '0',
  })
  if (prefill?.notice_hours) noticeInput.value = String(prefill.notice_hours)

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
        // The window is optional but comes as a pair, end after start — the same
        // rules as functions/lib/schedule.ts validateWindow, caught early here.
        if (!!winStart.value !== !!winEnd.value) {
          toast('Set both a start and an end for your window, or leave both empty', 'error')
          return
        }
        if (winStart.value && winEnd.value <= winStart.value) {
          toast('The window must end after it starts', 'error')
          return
        }
        if (!winStart.value && noticeInput.value && Number(noticeInput.value) > 0) {
          toast('Notice hours only apply when you set a time window', 'error')
          return
        }
        const gig = {
          task_type: f.task_type.input.value.trim(),
          neighborhood: f.neighborhood.input.value.trim(),
          cash_payout: Number(f.cash_payout.input.value),
          est_hours: Number(f.est_hours.input.value),
          description: description.value.trim(),
          lat,
          lng,
          from_post_id: prefill?.from_post_id ?? null,
          window_start: localInputToIso(winStart.value),
          window_end: localInputToIso(winEnd.value),
          notice_hours: noticeInput.value ? Number(noticeInput.value) : 0,
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
    labeled(
      'When works for you (optional)',
      h('div', { class: 'loc-fields' }, h('div', { class: 'row' }, winStart, winEnd)),
    ),
    labeled('Notice you need (hours)', noticeInput),
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

// A star picker (1-5) with a live "reflection" line that turns a low score into
// a constructive moment: 3 nudges for a tip, 1-2 explains the score won't
// publish immediately — it opens a private conversation — and points safety or
// payment problems at Report instead. Returns the building blocks the panels
// share. `get()` reads the current score; `note` is the textarea.
function starField() {
  let selected = 0
  const starBtns = []
  const note = h('textarea', {
    class: 'input',
    rows: '2',
    maxlength: '1000',
    placeholder: 'Optional note — specific, kind, useful',
  })
  const reflect = h('p', { class: 'hint' }, '')
  const onChange = []

  function paint() {
    starBtns.forEach((b, i) => {
      b.classList.toggle('star-on', i < selected)
      b.setAttribute('aria-pressed', i < selected ? 'true' : 'false')
    })
    if (selected === 0) reflect.textContent = ''
    else if (selected >= 4) reflect.textContent = 'Publishes to their portfolio right away.'
    else if (selected === 3)
      reflect.textContent = 'An honest middle score. Add a note so they know what to improve.'
    else
      reflect.textContent =
        'A low score is held, not published — it opens a private conversation so you can give feedback and they can respond. Safety or payment problem? Use Report instead.'
    for (const fn of onChange) fn(selected)
  }

  for (let i = 1; i <= 5; i++) {
    starBtns.push(
      h(
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
      ),
    )
  }

  return {
    row: h('div', { class: 'stars-row' }, ...starBtns),
    reflect,
    note,
    get: () => selected,
    onChange: (fn) => onChange.push(fn),
  }
}

// Inline rate panel for a CLAIMED gig you posted. Calls completeGig; server
// rejects non-owners. onDone() is invoked after a successful close & pay.
export function renderRatePanel(gig, onDone) {
  const stars = starField()
  const note = stars.note
  const payBtn = h('button', { class: 'btn-primary', disabled: true }, 'Close & pay')
  stars.onChange((s) => {
    payBtn.disabled = s < 1
    payBtn.textContent = s > 0 && s <= 2 ? 'Pay & open feedback chat' : 'Close & pay'
  })

  payBtn.addEventListener('click', async () => {
    const selected = stars.get()
    if (selected < 1) return
    payBtn.disabled = true
    payBtn.textContent = 'Closing…'
    try {
      const res = await api.completeGig(gig.id, selected, note.value.trim() || null)
      toast(
        res.review_status === 'RESOLVING'
          ? `Paid ${money(gig.cash_payout)} · feedback chat opened`
          : `Paid ${money(gig.cash_payout)} · rated ${selected}★`,
      )
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
    'Add work photos',
  )

  return h(
    'div',
    { class: 'rate-panel' },
    h('div', { class: 'rate-head' }, 'Rate ', h('strong', {}, gig.worker_name || 'the worker')),
    stars.row,
    stars.reflect,
    note,
    thumbs,
    addPhotoBtn,
    fileInput,
    payBtn,
  )
}

// The worker's side: review the hirer once the work is marked done. Same
// restorative star field, no photos, calls reviewHirer. onDone() runs on success.
export function renderReviewPanel(gig, onDone) {
  const stars = starField()
  const note = stars.note
  const submit = h('button', { class: 'btn-primary', disabled: true }, 'Submit review')
  stars.onChange((s) => {
    submit.disabled = s < 1
    submit.textContent = s > 0 && s <= 2 ? 'Send feedback privately' : 'Submit review'
  })

  submit.addEventListener('click', async () => {
    const selected = stars.get()
    if (selected < 1) return
    submit.disabled = true
    submit.textContent = 'Sending…'
    try {
      const res = await api.reviewHirer(gig.id, selected, note.value.trim() || null)
      toast(
        res.review_status === 'RESOLVING'
          ? 'Feedback sent — a private conversation is open'
          : `Reviewed the hirer ${selected}★`,
      )
      if (onDone) onDone()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not submit review', 'error')
      submit.disabled = false
      submit.textContent = 'Submit review'
    }
  })

  return h(
    'div',
    { class: 'rate-panel' },
    h('div', { class: 'rate-head' }, 'Review ', h('strong', {}, gig.poster_name || 'the hirer')),
    stars.row,
    stars.reflect,
    note,
    submit,
  )
}
