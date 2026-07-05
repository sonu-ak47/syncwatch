// Minimal service worker — just enough to satisfy Chrome's installability
// requirement so SyncWatch can be added to the home screen and registered
// as a share target. No offline caching; every request just passes through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // Intentionally not intercepted — network handles every request as normal.
});
