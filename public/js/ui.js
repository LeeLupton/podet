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
export function openSheet(contentNode) {
  const sheet = h('div', { class: 'sheet' }, contentNode)
  const backdrop = h('div', { class: 'backdrop' }, sheet)
  const close = () => backdrop.remove()
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  document.body.append(backdrop)
  return close
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

export function money(n) {
  return `$${Number(n).toLocaleString()}`
}
