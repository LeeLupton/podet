// PodNet service worker — shows push notifications and focuses the app on click.

self.addEventListener('push', (event) => {
  let data = { title: 'PodNet', body: '', url: '/' }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch {
    if (event.data) data.body = event.data.text()
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'PodNet', {
      body: data.body || '',
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) return w.focus()
      }
      return clients.openWindow(url)
    }),
  )
})
