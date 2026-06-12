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

async function request(path, { method = 'GET', body, raw, headers } = {}) {
  // `raw` sends a Blob/File/ArrayBuffer as-is (for image uploads); `body` is JSON.
  const opts = {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(raw?.type ? { 'Content-Type': raw.type } : {}),
      ...headers,
    },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  else if (raw !== undefined) opts.body = raw

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
    const msg = data?.error || res.statusText || 'Request failed'
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
  changePassword: (current_password, new_password) =>
    request('/me/password', { method: 'POST', body: { current_password, new_password } }),

  // Gigs
  nearbyGigs: (lat, lng, radius) =>
    request(
      `/gigs/near?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&radius=${encodeURIComponent(radius)}`,
    ),
  gig: (id) => request(`/gigs/${id}`),
  myGigs: () => request('/gigs/mine'),
  createGig: (gig) => request('/gigs', { method: 'POST', body: gig }),
  updateGig: (id, gig) => request(`/gigs/${id}`, { method: 'PUT', body: gig }),
  deleteGig: (id) => request(`/gigs/${id}`, { method: 'DELETE' }),
  claimGig: (id, scheduled_at) =>
    request(`/gigs/${id}/claim`, { method: 'POST', body: { scheduled_at: scheduled_at ?? null } }),
  abandonGig: (id) => request(`/gigs/${id}/abandon`, { method: 'POST' }),
  unclaimGig: (id) => request(`/gigs/${id}/unclaim`, { method: 'POST' }),
  markGigDone: (id) => request(`/gigs/${id}/done`, { method: 'POST' }),
  uploadGigPhoto: (gigId, file) => request(`/gigs/${gigId}/photos`, { method: 'POST', raw: file }),
  deleteGigPhoto: (gigId, photoId) =>
    request(`/gigs/${gigId}/photos/${photoId}`, { method: 'DELETE' }),
  imgUrl: (key) => `${BASE}/img/${key}`,
  completeGig: (id, rating, review) =>
    request(`/gigs/${id}/complete`, { method: 'POST', body: { rating, review } }),
  reviewHirer: (id, rating, review) =>
    request(`/gigs/${id}/review`, { method: 'POST', body: { rating, review } }),

  // Restorative review resolution
  resolvingReviews: () => request('/reviews/resolving'),
  reviseReview: (id, rating) =>
    request(`/reviews/${id}/revise`, { method: 'POST', body: { rating } }),
  withdrawReview: (id) => request(`/reviews/${id}/withdraw`, { method: 'POST' }),
  acknowledgeReview: (id) => request(`/reviews/${id}/acknowledge`, { method: 'POST' }),
  reviewMessages: (id) => request(`/reviews/${id}/messages`),
  sendReviewMessage: (id, body) =>
    request(`/reviews/${id}/messages`, { method: 'POST', body: { body } }),

  // Board
  posts: (before) => request(`/posts${before ? `?before=${encodeURIComponent(before)}` : ''}`),
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
  userReviews: (id, before) =>
    request(`/users/${id}/reviews${before ? `?before=${encodeURIComponent(before)}` : ''}`),

  // Gig messages (hirer ↔ worker)
  gigMessages: (gigId) => request(`/gigs/${gigId}/messages`),
  sendGigMessage: (gigId, body) =>
    request(`/gigs/${gigId}/messages`, { method: 'POST', body: { body } }),

  // Reports / support / verification
  report: (kind, subject_id, reason) =>
    request('/reports', { method: 'POST', body: { kind, subject_id, reason } }),
  myReports: () => request('/reports/mine'),
  setBusiness: (business_name) =>
    request('/me/business', { method: 'PUT', body: { business_name } }),

  // Admin
  adminReports: () => request('/admin/reports'),
  resolveReport: (id) => request(`/admin/reports/${id}/resolve`, { method: 'POST' }),
  verifyUser: (id, verified = true) =>
    request(`/admin/users/${id}/verify`, { method: 'POST', body: { verified } }),
  adminDeletePost: (id) => request(`/admin/posts/${id}`, { method: 'DELETE' }),
  adminDeleteComment: (id) => request(`/admin/comments/${id}`, { method: 'DELETE' }),
  adminDeleteGig: (id) => request(`/admin/gigs/${id}`, { method: 'DELETE' }),

  // Blocking
  block: (userId) => request(`/users/${userId}/block`, { method: 'POST' }),
  unblock: (userId) => request(`/users/${userId}/block`, { method: 'DELETE' }),
  blocks: () => request('/me/blocks'),

  // Properties (private; power the derived "neighbor" tag)
  properties: () => request('/me/properties'),
  addProperty: (label, lat, lng) =>
    request('/me/properties', { method: 'POST', body: { label, lat, lng } }),
  deleteProperty: (id) => request(`/me/properties/${id}`, { method: 'DELETE' }),

  // Account
  deleteAccount: (password) => request('/me/delete', { method: 'POST', body: { password } }),

  // Admin stats
  adminStats: () => request('/admin/stats'),

  // Web push
  pushKey: () => request('/push/key'),
  subscribePush: (subscription) =>
    request('/push/subscribe', { method: 'POST', body: subscription }),
  unsubscribePush: (endpoint) =>
    request('/push/subscribe', { method: 'DELETE', body: { endpoint } }),
}
