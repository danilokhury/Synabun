const CACHE_NAME = 'synabun-offline-v9';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL))
  );
});

// ── Notifications (required for Safari PWA) ──

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, routing } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, { body, tag, silent: true, data: routing || null })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const routing = event.notification.data;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const target = list.length > 0 ? list[0] : null;
      if (target) {
        target.focus();
        if (routing) target.postMessage({ type: 'NOTIFICATION_CLICK', ...routing });
      } else {
        clients.openWindow('/');
      }
    })
  );
});
