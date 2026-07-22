/*
 * Prisboka service worker — offline app shell.
 * Same-origin static assets are cached (stale-while-revalidate, so a deploy is
 * picked up on the next load); navigations fall back to the cached shell when
 * offline. Cross-origin requests (Supabase REST + the scan Edge Function) are
 * never intercepted, so prices always come fresh from the network.
 */
var CACHE = 'prisboka-v1';
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
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let Supabase & co. hit the network

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
