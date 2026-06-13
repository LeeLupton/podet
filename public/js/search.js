// The Search tab — an Instagram-style people finder. Type a name to search the
// whole network; tap a result to open the profile sheet, or use the inline
// Connect / Message action. With an empty box it suggests landscapers near your
// route. Discovery lives here, not buried in a settings list.

import { ApiError, api } from './api.js'
import { connActionRow, openUserProfile } from './profile.js'
import { avatar, clear, emptyState, errorState, h, spinner } from './ui.js'

const CONNECTION_LABEL = {
  connected: 'Connected',
  pending_out: 'Request sent',
  pending_in: 'Wants to connect',
}

export function renderSearch(root) {
  clear(root)
  const input = h('input', {
    class: 'input',
    type: 'search',
    maxlength: '60',
    placeholder: 'Search landscapers by name…',
    'aria-label': 'Search landscapers',
    autocomplete: 'off',
  })
  const header = h('div', { class: 'search-header' }, input)
  const results = h('div', { class: 'list' })
  root.append(header, results)

  // A row: tappable identity (→ profile) + an inline connect/message action.
  function resultRow(u) {
    const sub = u.verified ? 'Verified business' : CONNECTION_LABEL[u.connection] || ''
    const main = h(
      'button',
      { class: 'result-main', onClick: () => openUserProfile(u.id) },
      avatar(u.display_name, u.id),
      h(
        'span',
        { class: 'result-text' },
        h(
          'span',
          { class: 'result-name' },
          `${u.display_name || 'Neighbor'}${u.verified ? ' ✓' : ''}`,
        ),
        sub ? h('span', { class: 'result-sub' }, sub) : null,
      ),
    )
    return h(
      'div',
      { class: 'result-row' },
      main,
      connActionRow(u.id, u.display_name || 'Neighbor', u.connection),
    )
  }

  // Guard against out-of-order responses: only the latest query may render.
  let seq = 0
  async function run() {
    const q = input.value.trim()
    const mine = ++seq
    clear(results)
    results.append(spinner(q.length < 2 ? 'Loading suggestions…' : 'Searching…'))
    try {
      const list = q.length < 2 ? await api.neighbors() : await api.searchUsers(q)
      if (mine !== seq) return // a newer query superseded this one
      clear(results)
      if (q.length < 2) {
        results.append(h('h3', { class: 'subhead' }, 'Near your route'))
      }
      if (!list.length) {
        results.append(
          emptyState(
            q.length < 2
              ? 'No suggestions yet — add the properties on your route, or search by name above.'
              : `No landscapers matching “${q}”.`,
          ),
        )
        return
      }
      for (const u of list) results.append(resultRow(u))
    } catch (err) {
      if (mine !== seq) return
      clear(results)
      results.append(errorState(err instanceof ApiError ? err.message : 'Search failed', run))
    }
  }

  let timer = null
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(run, 250)
  })
  input.addEventListener('search', run) // clearing the field (the × ) fires this
  // Focus + initial suggestions when the tab opens.
  setTimeout(() => input.focus(), 0)
  run()
}
