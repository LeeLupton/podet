// Auth + current-user state. The session itself lives in an HttpOnly cookie the
// page's JS can't read; this module only tracks the *public* user object the API
// returns, and the server re-checks every protected call regardless of UI state.

import { api } from './api.js'

let currentUser = null
const listeners = new Set()

export function getUser() {
  return currentUser
}

export function onAuthChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of listeners) fn(currentUser)
}

// Re-establish session state on load (cookie may already be valid).
export async function refresh() {
  try {
    currentUser = await api.me()
  } catch {
    currentUser = null
  }
  emit()
  return currentUser
}

export async function login(email, password) {
  const res = await api.login(email, password)
  currentUser = res.user
  emit()
  return currentUser
}

export async function register(email, password, displayName) {
  const res = await api.register(email, password, displayName)
  currentUser = res.user
  emit()
  return currentUser
}

export async function logout() {
  try {
    await api.logout()
  } finally {
    currentUser = null
    emit()
  }
}
