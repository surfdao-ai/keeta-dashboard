/* DashKee service worker — offline-capable shell + last-good API data.
   Navigation & static: stale-while-revalidate (fresh on second load),
   API: network-first with cache fallback so the dashboard still opens
   (with the last successful data) when offline. */
const VERSION = 'dashkee-v3';
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

  // static shell: stale-while-revalidate — instant from cache, refresh in
  // the background so deploys propagate on the next load
  e.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(VERSION).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => hit);
      return hit ?? refresh;
    })
  );
});
