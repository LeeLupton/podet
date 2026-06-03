// Shared location state. Geolocation is best-effort: it only works in a secure
// context (https or http://localhost), so the app always allows a manual fallback
// and remembers the last chosen spot so location is never a hard gate.

const STORE_KEY = 'podnet:coords'

export function getCoords() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw)
    return Number.isFinite(c?.lat) && Number.isFinite(c?.lng) ? c : null
  } catch {
    return null
  }
}

export function setCoords(coords) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ lat: coords.lat, lng: coords.lng }))
  } catch {
    // private mode / storage disabled — keep going without persistence
  }
  return coords
}

// Resolve the device location. Rejects with a short, human reason on failure.
export function requestGeolocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not available in this browser'))
      return
    }
    if (!window.isSecureContext) {
      // http over a LAN IP etc. — the browser will block it; fail fast with a hint.
      reject(new Error('Location needs https or localhost — enter it manually below'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? 'Location permission denied — enter it manually below'
              : 'Could not get your location — enter it manually below',
          ),
        ),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  })
}
