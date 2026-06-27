/* Offline cache for the PT app. Bump CACHE to invalidate.
 * Core app shell is network-first so code/style updates land immediately when
 * online, with the cache as an offline fallback. */
const CACHE = "pt-shred-v39";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=39",
  "./app.js?v=39",
  "./data/plan.json",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function networkFirst(req) {
  return fetch(req).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
    return r;
  }).catch(() => caches.match(req).then((r) => r || caches.match("./index.html")));
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const isCore = e.request.mode === "navigate" ||
    /\/(index\.html|app\.js|styles\.css|plan\.json|manifest\.webmanifest)$/.test(url.pathname) ||
    url.pathname.endsWith("/");
  if (isCore) { e.respondWith(networkFirst(e.request)); return; }
  // icons and everything else: cache-first
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
