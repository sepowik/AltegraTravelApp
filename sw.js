// Offline support: the app shell is cached; bump VERSION when shipping changes.
const VERSION = 'v6';
// Large, versioned third-party files (OCR engine) live in their own cache that survives app updates.
const VENDOR_CACHE = 'travel-vendor-tesseract-7.0.0';
const CACHE = `travel-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/charging.js',
  'js/db.js',
  'js/ev.js',
  'js/geo.js',
  'js/i18n.js',
  'js/ocr.js',
  'js/receipt-parse.js',
  'js/receipts.js',
  'js/ui.js',
  'js/util.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('travel-') && k !== CACHE && k !== VENDOR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Same-origin: network first so updates arrive quickly, cache as offline fallback.
// Cross-origin requests (maps, geocoding) are never cached.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    // Cache first: these files never change under the same path.
    e.respondWith(
      caches.open(VENDOR_CACHE).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }))),
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
