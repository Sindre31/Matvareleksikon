/*
 * Prisboka service worker — offline app shell.
 * Same-origin static assets are cached (stale-while-revalidate, so a deploy is
 * picked up on the next load); navigations fall back to the cached shell when
 * offline. Cross-origin requests (Supabase REST + the scan Edge Function) are
 * never intercepted, so prices always come fresh from the network.
 */
// Bump this when a release must reach returning visitors on the FIRST load.
// The fetch handler below is stale-while-revalidate: it answers /app.js from
// the cache and refreshes it in the background, so a normal deploy lands on the
// visit AFTER the next one. That is the right trade for a price site — the data
// is network-only anyway — but it hides a shipped feature from everyone who has
// been here before, which is what happened with the feilrapport-knappen and
// #/admin. A new cache name is dropped by the activate handler, so the shell is
// re-fetched immediately instead.
var CACHE = 'prisboka-v2';
var CORE = [
  '/', '/index.html', '/styles.css', '/app.js',
  '/favicon.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      // Only drop our own OLD shell caches. Never touch the page's catalogue
      // cache ('prisboka-catalog-*'), which the app manages for offline data —
      // deleting it here would wipe the ~6 MB snapshot right after it's written.
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE && k.indexOf('prisboka-catalog-') !== 0; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let Supabase & co. hit the network
  // Vercel's own routes (Web Analytics' script + view beacon) are same-origin
  // but not ours to cache — a cached script.js would keep serving an old
  // tracker, and a cached beacon response would hide a failing one.
  if (url.pathname.indexOf('/_vercel/') === 0) return;

  // App-shell navigations: prefer the network (fresh HTML), fall back to cache.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('/index.html', copy); });
        return res;
      }).catch(function () { return caches.match('/index.html'); })
    );
    return;
  }

  // Static assets: serve cache immediately, refresh it in the background.
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      });
    })
  );
});
