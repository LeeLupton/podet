// Theme bootstrap — a classic (non-module) script loaded in <head> so it runs
// before first paint and there's no flash of the wrong theme. The user's choice
// (System / Light / Dark) is kept in localStorage; "System" resolves to the OS
// preference here and re-resolves live if the OS flips. Exposed on
// window.podnetTheme so the (module) settings UI can read and set it.
;(() => {
  const KEY = 'podnet-theme' // 'system' | 'light' | 'dark'
  const BG = { light: '#f3f5f1', dark: '#0e1410' }
  const root = document.documentElement

  const prefersLight = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches

  const get = () => localStorage.getItem(KEY) || 'system'
  const resolve = (pref) =>
    pref === 'light' || pref === 'dark' ? pref : prefersLight() ? 'light' : 'dark'

  function apply(pref) {
    const theme = resolve(pref)
    root.dataset.theme = theme
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', BG[theme])
  }

  function set(pref) {
    if (pref === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
    apply(pref)
  }

  apply(get())

  // Follow the OS while in System mode.
  try {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (get() === 'system') apply('system')
    })
  } catch {
    // older browsers — System simply won't live-update; the choice still applies
  }

  window.podnetTheme = { get, set }
})()
