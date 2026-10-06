// Service Worker：オフラインでも起動できるようにアプリ本体をキャッシュ
// ★ ファイルを更新して GitHub に上げたら、VERSION の数字を上げてください（iPad 側に「更新」が出ます）
const VERSION = 'v1.0.0';
const CACHE = 'benkyo-note-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/util.js',
  './js/icons.js',
  './js/db.js',
  './js/settings.js',
  './js/store.js',
  './js/ink.js',
  './js/scribble.js',
  './js/shapes.js',
  './js/render.js',
  './js/engine.js',
  './js/ui.js',
  './js/pickers.js',
  './js/exporter.js',
  './js/editor.js',
  './js/library.js',
  './js/panels.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('benkyo-note-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        try {
          return await fetch(req);
        } catch (_) {
          if (shell) return shell;
          throw _;
        }
      }
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (err) {
        return Response.error();
      }
    })()
  );
});
