// Bootstrap: auth gate, bottom-tab navigation, and wiring between view modules.
// Views talk to each other only through the small setters exposed here.

import { getUser, login, refresh, register } from './auth.js'
import { renderBoard, setOnTurnIntoGig } from './board.js'
import { renderFeed, resetFeed } from './feed.js'
import { renderPostForm, setOnPosted, setPrefill } from './post.js'
import { renderProfile, setOnEditGig, setOnLoggedOut } from './profile.js'
import { clear, h, toast } from './ui.js'

const VIEWS = {
  nearby: { el: () => document.getElementById('view-nearby'), render: renderFeed },
  board: { el: () => document.getElementById('view-board'), render: renderBoard },
  post: { el: () => document.getElementById('view-post'), render: renderPostForm },
  me: { el: () => document.getElementById('view-me'), render: renderProfile },
}

let active = null

function navigate(tab) {
  active = tab
  for (const [id, v] of Object.entries(VIEWS)) {
    v.el().classList.toggle('hidden', id !== tab)
  }
  for (const btn of document.querySelectorAll('#tabbar .tab')) {
    btn.classList.toggle('tab-on', btn.dataset.tab === tab)
    btn.setAttribute('aria-current', btn.dataset.tab === tab ? 'page' : 'false')
  }
  VIEWS[tab].render(VIEWS[tab].el())
}

function showApp() {
  document.getElementById('auth-gate').classList.add('hidden')
  document.getElementById('app').classList.remove('hidden')
  document.getElementById('tabbar').classList.remove('hidden')
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
    required: true,
  })
  const password = h('input', {
    class: 'input',
    type: 'password',
    placeholder: 'Password (8+ chars)',
    autocomplete: 'current-password',
    required: true,
  })
  const name = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Display name',
    autocomplete: 'name',
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
  })
  navigate('post')
})
setOnLoggedOut(() => {
  resetFeed()
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
