// SOSAlert service worker : interface hors ligne + réception des notifications push.
// Les appels /api/ ne sont jamais mis en cache.
const CACHE = 'sosalert-v2';
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Pages d'alerte et d'invitation : toujours le réseau (contenu à jour obligatoire)
  if (/^\/[aipvr]\//.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'SOSAlert', body: e.data ? e.data.text() : '' }; }
  const urgent = /^ALERTE|Échéance|Trajet/.test(d.title || '');
  e.waitUntil(self.registration.showNotification(d.title || 'SOSAlert', {
    body: d.body || '', tag: d.tag, renotify: true, requireInteraction: urgent,
    vibrate: urgent ? [400, 150, 400, 150, 400] : [100],
    icon: '/icon.svg', badge: '/icon.svg', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url === url && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  })());
});
