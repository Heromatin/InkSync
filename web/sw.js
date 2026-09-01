// Inksync service worker: caches the PDF document (and the vendored pdf.js)
// on the client so it is downloaded exactly once. All subsequent zooming,
// scrolling, page turns and rendering are purely local operations.

const DOC_CACHE = "studyapp-docs-v1";
const VENDOR_CACHE = "studyapp-vendor-v1";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  if (url.pathname.startsWith("/doc/")) {
    // the document itself: download once, then serve from cache forever
    e.respondWith(cacheFirst(e.request, DOC_CACHE));
  } else if (url.pathname.startsWith("/static/vendor/")) {
    e.respondWith(cacheFirst(e.request, VENDOR_CACHE));
  }
  // everything else (html, app js/css, ws) goes to the network untouched
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
    cache.put(request, res.clone());
  }
  return res;
}
