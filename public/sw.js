const CACHE = 'clara-v3';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k))) // apaga TODOS os caches, não só os antigos
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/dashboard')) {
    // Network first — sempre busca versão nova, cache só como fallback
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', e => {
  let data = { title: 'Clara ✨', body: 'Você tem um novo lembrete!' };
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.svg',
      badge: '/icon-192.svg',
      vibrate: [200, 100, 200],
      tag: 'clara-notification',
      renotify: true,
      data: { url: data.url || '/dashboard' },
      actions: [
        { action: 'open', title: '✅ Ver agora' },
        { action: 'dismiss', title: 'Dispensar' }
      ]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const url = e.notification.data?.url || '/dashboard';
      const existing = list.find(c => c.url.includes('/dashboard'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
