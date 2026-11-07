/* Sklad Go: копия программы на телефоне — чтобы склад открывался и без интернета.

   С интернетом страница и скрипты всегда берутся свежие, а копия тихо обновляется:
   изменения программы приезжают к продавцам сразу, а не через раз. Без интернета
   (или если сеть не ответила за несколько секунд) — отдаём то, что сохранили.

   Данные склада сюда не попадают: запросы к серверу (/api) идут мимо. Склад
   и долги программа и так держит в памяти телефона и досылает, когда появится связь. */
const V = 'skladgo-v8';   // номер меняем, только если меняется список ниже
const SHELL = ['/', '/index.html', '/theme.js', '/tg.js', '/i18n.js', '/merge.js', '/barcode.js', '/scan.js', '/config.js', '/backend-server.js', '/customer.js', '/backend.js', '/demo.js', '/mock.js', '/qr.js', '/app.js',
  '/logo.svg', '/privacy.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const WAIT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;           // всё чужое — мимо копии
  if (/^\/(api|auth)\//.test(u.pathname)) return;    // свой сервер (Railway): данные и вход — тоже мимо
  e.respondWith(fresh(r));
});

// Сначала сеть; не ответила вовремя или ответила ошибкой — копия. Ответ сети в копию кладём в любом случае.
// Перенаправление — не ошибка: сервер говорит «тебе туда» (skladgo.com с 7 ноября 2026 ведёт на
// страницу о складе). Раньше копия считала его ошибкой и показывала сохранённый склад — и на
// телефоне, где склад уже открывали, новая страница не появлялась никогда
const дальше = (res) => res.ok || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
function fresh(r) {
  const net = fetch(r).then((res) => {
    if (res && res.ok && res.type === 'basic') { const c = res.clone(); caches.open(V).then((cache) => cache.put(r, c)); }
    return res;
  });
  const saved = () => caches.match(r, { ignoreSearch: true })
    .then((hit) => hit || (r.mode === 'navigate' ? caches.match('/') : undefined));
  return new Promise((done) => {
    let over = false;
    const t = setTimeout(() => { saved().then((hit) => { if (hit && !over) { over = true; done(hit); } }); }, WAIT);
    net.then((res) => {
      if (over) return;
      if (дальше(res)) { over = true; clearTimeout(t); done(res); return; }
      saved().then((hit) => { if (!over) { over = true; clearTimeout(t); done(hit || res); } });
    }, () => {
      saved().then((hit) => { if (!over) { over = true; clearTimeout(t); done(hit || new Response('Нет связи', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })); } });
    });
  });
}
