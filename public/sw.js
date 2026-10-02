const CACHE = 'isrm-urnik-v21';
const APP = ['/', '/manifest.webmanifest', '/icons/icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE)
  .then((cache) => cache.addAll(APP))
  .then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(Promise.all([
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  self.clients.claim(),
])));
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  })));
});
