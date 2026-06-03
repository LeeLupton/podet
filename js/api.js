// PodNet data layer — the ONLY module aware of the API shape.
// Every call hits /api/* with credentials:'include' (so the HttpOnly session
// cookie rides along) and returns plain data. View modules call api.* and never
// fetch directly or touch the API's response envelope beyond what's returned here.

const BASE = '/api'

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

async function request(path, { method = 'GET', body, headers } = {}) {
  const opts = {
    method,
    credentials: 'include',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)

  let res
  try {
    res = await fetch(BASE + path, opts)
  } catch (e) {
    throw new ApiError('Network error — check your connection', 0, null)
  }

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || 'Request failed'
    throw new ApiError(msg, res.status, data)
  }
  return data
}

export const api = {
  // Auth
  register: (email, password, display_name) =>
    request('/register', { method: 'POST', body: { email, password, display_name } }),
  login: (email, password) => request('/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/logout', { method: 'POST' }),
  me: () => request('/me'),

  // Gigs
  nearbyGigs: (lat, lng, radius) =>
    request(`/gigs/near?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&radius=${encodeURIComponent(radius)}`),
  gig: (id) => request(`/gigs/${id}`),
  myGigs: () => request('/gigs/mine'),
  createGig: (gig) => request('/gigs', { method: 'POST', body: gig }),
  claimGig: (id) => request(`/gigs/${id}/claim`, { method: 'POST' }),
  completeGig: (id, rating, review) =>
    request(`/gigs/${id}/complete`, { method: 'POST', body: { rating, review } }),

  // Board
  posts: () => request('/posts'),
  post: (id) => request(`/posts/${id}`),
  createPost: (post) => request('/posts', { method: 'POST', body: post }),
  updatePost: (id, body, area_label) =>
    request(`/posts/${id}`, { method: 'PUT', body: { body, area_label } }),
  deletePost: (id) => request(`/posts/${id}`, { method: 'DELETE' }),
  addComment: (postId, body) =>
    request(`/posts/${postId}/comments`, { method: 'POST', body: { body } }),
  updateComment: (id, body) => request(`/comments/${id}`, { method: 'PUT', body: { body } }),
  deleteComment: (id) => request(`/comments/${id}`, { method: 'DELETE' }),
  addInterest: (postId) => request(`/posts/${postId}/interest`, { method: 'POST' }),
  removeInterest: (postId) => request(`/posts/${postId}/interest`, { method: 'DELETE' }),

  // Profiles
  user: (id) => request(`/users/${id}`),
  userReviews: (id) => request(`/users/${id}/reviews`),
}
