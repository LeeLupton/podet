// Bootstrap: auth gate, bottom-tab navigation, and wiring between view modules.
// Views talk to each other only through the small setters exposed here.

import { getUser, login, refresh, register } from './auth.js'
import { renderBoard, setOnTurnIntoGig } from './board.js'
import { renderFeed, resetFeed, stopPolling } from './feed.js'
import { renderPostForm, setOnPosted, setPrefill } from './post.js'
import { renderProfile, setOnEditGig, setOnLoggedOut } from './profile.js'
import { renderSearch } from './search.js'
import { clear, h, toast } from './ui.js'
import { mountUnreadBadge, refreshUnread, startUnreadPolling, stopUnreadPolling } from './unread.js'

const VIEWS = {
  nearby: { el: () => document.getElementById('view-nearby'), render: renderFeed },
  board: { el: () => document.getElementById('view-board'), render: renderBoard },
  search: { el: () => document.getElementById('view-search'), render: renderSearch },
  post: { el: () => document.getElementById('view-post'), render: renderPostForm },
  me: { el: () => document.getElementById('view-me'), render: renderProfile },
}

let active = null

function navigate(tab) {
  active = tab
  // The live-feed interval only runs while Nearby is the active tab.
  if (tab !== 'nearby') stopPolling()
  for (const [id, v] of Object.entries(VIEWS)) {
    v.el().classList.toggle('hidden', id !== tab)
  }
  for (const btn of document.querySelectorAll('#tabbar .tab')) {
    btn.classList.toggle('tab-on', btn.dataset.tab === tab)
    btn.setAttribute('aria-current', btn.dataset.tab === tab ? 'page' : 'false')
  }
  VIEWS[tab].render(VIEWS[tab].el())
  // Opening Me marks threads read as you go; keep the badge in sync.
  refreshUnread()
}

function showApp() {
  document.getElementById('auth-gate').classList.add('hidden')
  document.getElementById('app').classList.remove('hidden')
  document.getElementById('tabbar').classList.remove('hidden')
  const meTab = document.querySelector('#tabbar .tab[data-tab="me"]')
  if (meTab) mountUnreadBadge(meTab)
  startUnreadPolling()
  navigate('nearby')
}

function showGate() {
  document.getElementById('app').classList.add('hidden')
  document.getElementById('tabbar').classList.add('hidden')
  const gate = document.getElementById('auth-gate')
  gate.classList.remove('hidden')
  renderGate(gate)
}

function renderGate(gate) {
  clear(gate)
  let mode = 'login' // or 'register'

  const email = h('input', {
    class: 'input',
    type: 'email',
    placeholder: 'you@example.com',
    autocomplete: 'email',
    maxlength: '254',
    required: true,
  })
  const password = h('input', {
    class: 'input',
    type: 'password',
    placeholder: 'Password (8+ chars)',
    autocomplete: 'current-password',
    minlength: '8',
    maxlength: '200',
    required: true,
  })
  const name = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Display name',
    autocomplete: 'name',
    maxlength: '60',
  })
  const nameWrap = h('div', { class: 'hidden' }, name)
  const submit = h('button', { class: 'btn-primary', type: 'submit' }, 'Log in')
  const toggle = h('button', { class: 'link-btn', type: 'button' }, 'New here? Create an account')

  function setMode(m) {
    mode = m
    nameWrap.classList.toggle('hidden', m !== 'register')
    submit.textContent = m === 'login' ? 'Log in' : 'Create account'
    password.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password')
    toggle.textContent = m === 'login' ? 'New here? Create an account' : 'Have an account? Log in'
  }
  toggle.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'))

  const form = h(
    'form',
    {
      class: 'card auth-card',
      onSubmit: async (e) => {
        e.preventDefault()
        submit.disabled = true
        const label = submit.textContent
        submit.textContent = '…'
        try {
          if (mode === 'login') {
            await login(email.value.trim(), password.value)
          } else {
            await register(email.value.trim(), password.value, name.value.trim() || null)
          }
          showApp()
        } catch (err) {
          toast(err.message || 'Authentication failed', 'error')
          submit.disabled = false
          submit.textContent = label
        }
      },
    },
    h('h1', { class: 'brand' }, 'PodNet'),
    h('p', { class: 'tagline' }, 'Neighborhood gigs & improvement board'),
    email,
    password,
    nameWrap,
    submit,
    toggle,
  )
  gate.append(form)
}

// Wire cross-module navigation.
setOnPosted(() => {
  toast('Back to nearby')
  navigate('nearby')
})
setOnTurnIntoGig((data) => {
  setPrefill(data)
  navigate('post')
})
setOnEditGig((g) => {
  setPrefill({
    editId: g.id,
    task_type: g.task_type,
    neighborhood: g.neighborhood,
    cash_payout: g.cash_payout,
    est_hours: g.est_hours,
    description: g.description,
    lat: g.lat,
    lng: g.lng,
    window_start: g.window_start,
    window_end: g.window_end,
    notice_hours: g.notice_hours,
  })
  navigate('post')
})
setOnLoggedOut(() => {
  resetFeed()
  stopUnreadPolling()
  showGate()
})

// Bottom tab bar.
for (const btn of document.querySelectorAll('#tabbar .tab')) {
  btn.addEventListener('click', () => navigate(btn.dataset.tab))
}
// Boot.
;(async () => {
  await refresh()
  if (getUser()) showApp()
  else showGate()
})()
