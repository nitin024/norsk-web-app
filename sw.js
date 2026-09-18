// Service worker: offline reading.
//
// Strategy is network-first, cache-fallback for everything on this origin.
// Network-first means a developer on ./serve.sh never sees a stale app.js,
// and a reader on wifi always gets the newest lexicon; the cache only answers
// when the network fails. Every successful response is stored, so any text
// opened once is readable offline afterwards.
//
// Bump CACHE when the shell changes shape (new files) so old caches are
// dropped. Content changes need no bump — network-first refreshes them.

const CACHE = 'norsk-v3';

// The minimum needed to boot the app offline. Paragraphs are cached as they
// are read, and the occurrence index pulls the rest in on the first card.
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './parser.js',
  './stub.js',
  './speech.js',
  './review.js',
  './progress.js',
  './manifest.json',
  './icon.svg',
  './data/lexicon.json',
  './data/index.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A hash route reload while offline still needs the shell.
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      })
  );
});
