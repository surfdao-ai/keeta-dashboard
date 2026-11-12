/* DashKee service worker — offline-capable shell + last-good API data.
   Static shell: cache-first. API: network-first with cache fallback so the
   dashboard still opens (with the last successful data) when offline. */
const VERSION = 'dashkee-v1';
const SHELL = [
  '/',
  '/app.js',
  '/styles.css',
  '/vendor/echarts.min.js',
  '/vendor/keetanet-browser.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // API: network-first, fall back to the last successful response
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(VERSION).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) =>
            hit ?? new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
          )
        )
    );
    return;
  }

  // static shell: cache-first
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ??
      fetch(req).then((res) => {
        if (res.ok && (req.destination === '' || url.pathname.startsWith('/'))) {
          const clone = res.clone();
          caches.open(VERSION).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match('/'))
    )
  );
});
