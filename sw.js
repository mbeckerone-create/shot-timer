// Offline cache so the timer works at a range with no signal. Bump VERSION on every release.
const VERSION = 'st-v0.8.5';
const FILES = ['./', 'index.html', 'style.css', 'design.css', 'app-skin.css', 'app.js', 'ui.js', 'runs.js', 'voice.js', 'detector.js', 'worklet.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // network first (so updates land), but give up after 3 s and use the cache (one bar of signal at the range);
  // only good answers are cached, so an error page can never replace the app
  const fromCache = () => caches.match(e.request, { ignoreSearch: true });
  const net = fetch(e.request).then((r) => { if (r.ok && r.type === 'basic') { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); } return r; });
  const slow = new Promise((ok) => setTimeout(ok, 3000, null));
  e.respondWith(Promise.race([net, slow])
    .then((r) => (r && r.ok ? r : fromCache().then((c) => c || r || net)))
    .catch(() => fromCache().then((c) => c || net)));
});
