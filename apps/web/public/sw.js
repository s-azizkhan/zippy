// Installable PWA + fast repeat loads. Hashed /assets/* are immutable: cache-first. Pages: network-first,
// cached shell when offline. /api is never touched (live data, websockets).
const CACHE = "zippy-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api")) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => (res.ok && put(new Request("/"), res.clone()), res))
        .catch(() => caches.match("/").then((r) => r ?? Response.error())),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => (res.ok && put(req, res.clone()), res))));
  }
});

// ponytail: old hashed chunks pile up across updates; prune on activate if the cache grows noticeably.
const put = (req, res) => caches.open(CACHE).then((c) => c.put(req, res));
