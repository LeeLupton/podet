// Shared DOM helpers. Everything builds nodes with textContent (never innerHTML
// with user data), so post/comment/review bodies can't inject markup.

// Tiny hyperscript: h('div', {class:'x', onClick:fn}, child, child, ...)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'html')
      el.innerHTML = v // only for trusted, static markup
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function')
      el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  appendChildren(el, children)
  return el
}

function appendChildren(el, children) {
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    el.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

// One-line, calm transient message.
export function toast(message, kind = 'info') {
  const root = document.getElementById('toast-root')
  if (!root) return
  // Classes, not style attributes — the strict CSP (style-src 'self') blocks inline styles.
  const el = h(
    'div',
    {
      class: kind === 'error' ? 'toast toast-error' : 'toast',
      role: 'status',
    },
    message,
  )
  root.append(el)
  setTimeout(() => el.classList.add('toast-out'), 2600)
  setTimeout(() => el.remove(), 3000)
}

// A bottom sheet / modal. Returns a close() fn. Tapping the backdrop closes it.
// Sheets anchor to the bottom on phones (thumb zone); pass { center: true } for
// content that should float centered instead (e.g. the photo viewer). On wide
// screens CSS centers every sheet regardless.
export function openSheet(contentNode, { center = false, onClose = null } = {}) {
  const sheet = h('div', { class: 'sheet' }, contentNode)
  const backdrop = h('div', { class: center ? 'backdrop backdrop-center' : 'backdrop' }, sheet)
  const close = () => {
    backdrop.remove()
    if (onClose) onClose()
  }
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  document.body.append(backdrop)
  return close
}

// A styled replacement for window.prompt(): title + textarea + Cancel/submit in a
// sheet. Resolves with the trimmed text, or null if cancelled/dismissed.
export function promptSheet(
  title,
  { placeholder = '', maxlength = '500', submitLabel = 'Send' } = {},
) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      close()
      resolve(value)
    }
    const text = h('textarea', {
      class: 'input',
      rows: '3',
      maxlength,
      placeholder,
      required: true,
    })
    const form = h(
      'form',
      {
        class: 'sheet-body form',
        onSubmit: (e) => {
          e.preventDefault()
          const value = text.value.trim()
          if (value) finish(value)
        },
      },
      h('h2', { class: 'screen-title' }, title),
      text,
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn-ghost', onClick: () => finish(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn-primary' }, submitLabel),
      ),
    )
    const close = openSheet(form, { onClose: () => finish(null) })
    text.focus()
  })
}

export function spinner(label = 'Loading…') {
  return h('div', { class: 'state' }, h('div', { class: 'spin' }), h('span', {}, label))
}

// Full-size image viewer (tap a thumbnail). Tapping the backdrop closes it.
export function openImage(url) {
  openSheet(
    h(
      'div',
      { class: 'sheet-body' },
      h('img', { class: 'photo-full', src: url, alt: 'work photo' }),
    ),
    { center: true },
  )
}

// A read-only row of photo thumbnails; tap to view full size.
export function photoStrip(photos, urlFor) {
  if (!photos || !photos.length) return null
  return h(
    'div',
    { class: 'photo-strip' },
    ...photos.map((p) =>
      h('img', {
        class: 'thumb',
        src: urlFor(p.key),
        alt: 'work photo',
        loading: 'lazy',
        onClick: () => openImage(urlFor(p.key)),
      }),
    ),
  )
}

export function errorState(message, onRetry) {
  return h(
    'div',
    { class: 'state' },
    h('span', { class: 'warn-text' }, message),
    onRetry ? h('button', { class: 'btn-ghost', onClick: onRetry }, 'Retry') : null,
  )
}

export function emptyState(message, extra) {
  return h('div', { class: 'state' }, h('span', {}, message), extra || null)
}

// 1–5 stars as text.
export function starsText(n) {
  const filled = Math.max(0, Math.min(5, Math.round(n)))
  return '★★★★★☆☆☆☆☆'.slice(5 - filled, 10 - filled)
}

export function fmtAvg(sum, count) {
  return count ? (sum / count).toFixed(2) : '—'
}

// D1 stores 'YYYY-MM-DD HH:MM:SS' in UTC.
export function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(`${iso.replace(' ', 'T')}Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Local-readable date+time for scheduled slots / windows.
export function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// <input type="datetime-local"> value (local time) → ISO string, or null.
export function localInputToIso(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// ISO string → <input type="datetime-local"> value (local wall-clock), or ''.
export function isoToLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function money(n) {
  return `$${Number(n).toLocaleString()}`
}
