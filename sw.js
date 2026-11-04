/* Sklad Go: копия программы на телефоне — чтобы склад открывался и без интернета.

   С интернетом страница и скрипты всегда берутся свежие, а копия тихо обновляется:
   изменения программы приезжают к продавцам сразу, а не через раз. Без интернета
   (или если сеть не ответила за несколько секунд) — отдаём то, что сохранили.

   Данные склада сюда не попадают: запросы к серверу (Supabase или свой, /api) идут мимо. Склад
   и долги программа и так держит в памяти телефона и досылает, когда появится связь. */
const V = 'skladgo-v3';   // номер меняем, только если меняется список ниже
const SHELL = ['/', '/index.html', '/theme.js', '/tg.js', '/i18n.js', '/merge.js', '/config.js', '/backend-server.js', '/backend.js', '/demo.js', '/app.js',
  '/logo.svg', '/privacy.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
// Supabase грузится с чужой раздачи. Версия в адресе зафиксирована, поэтому файл не меняется — берём из копии сразу
const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const WAIT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL.concat(new Request(LIB, { mode: 'cors' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.href === LIB) {
    e.respondWith(caches.match(LIB).then((hit) => hit || fetch(r).then((res) => { if (res.ok) caches.open(V).then((c) => c.put(LIB, res.clone())); return res; })));
    return;
  }
  if (u.origin !== location.origin) return;           // Supabase и всё чужое — мимо копии
  if (/^\/(api|auth)\//.test(u.pathname)) return;    // свой сервер (Railway): данные и вход — тоже мимо
  e.respondWith(fresh(r));
});

// Сначала сеть; не ответила вовремя или ответила ошибкой — копия. Ответ сети в копию кладём в любом случае
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
      if (res.ok) { over = true; clearTimeout(t); done(res); return; }
      saved().then((hit) => { if (!over) { over = true; clearTimeout(t); done(hit || res); } });
    }, () => {
      saved().then((hit) => { if (!over) { over = true; clearTimeout(t); done(hit || new Response('Нет связи', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })); } });
    });
  });
}
