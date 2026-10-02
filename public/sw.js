const CACHE = 'isrm-urnik-v29';
const APP = ['/', '/manifest.webmanifest', '/icons/icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE)
  .then((cache) => cache.addAll(APP))
  .then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(Promise.all([
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  self.clients.claim(),
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => clients.forEach((client) => client.postMessage({ type: 'ISRM_UPDATED' }))),
])));
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) return;
  const url = new URL(event.request.url);
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/manifest.webmanifest')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/'))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  })));
});
