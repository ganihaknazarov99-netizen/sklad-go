/* Sklad Go: оболочка программы хранится на телефоне — открывается без интернета.
   Данные (/api/*) сюда не попадают: они хранятся в самой программе и синхронизируются отдельно. */
const V = 'skladgo-shell-v4';
const SHELL = ['/', '/index.html', '/style.css', '/config.js', '/merge.js', '/barcode.js', '/scan.js', '/i18n.js', '/tg.js', '/auth.js', '/app.js', '/logo.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(caches.open(V).then(async (c) => {
    let hit = await c.match(e.request, { ignoreSearch: true });
    if (!hit && e.request.mode === 'navigate') hit = await c.match('/index.html');
    const net = fetch(e.request).then((r) => { if (r && r.ok && r.type === 'basic') c.put(e.request, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }      // сразу из памяти телефона, обновляем в фоне
    return (await net) || new Response('Нет связи', { status: 503 });
  }));
});
