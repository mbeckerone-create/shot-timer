// Offline cache so the timer works at a range with no signal. Bump VERSION on every release.
const VERSION = 'st-v0.1.4';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'detector.js', 'worklet.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // network first (so updates land), cache fallback (so it works offline)
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
