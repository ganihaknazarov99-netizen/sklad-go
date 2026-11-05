'use strict';
/* Проверка магазина на своём компьютере: настоящий сервер (server/app.js) с тестовой
   базой в памяти (PGlite из supabase/) и сами файлы склада. Живой магазин и база на
   Railway не трогаются. После остановки всё забывается.

   Запуск:  cd supabase && npm install   (один раз — для PGlite)
            node server/dev.js            → http://127.0.0.1:8787

   Google здесь не работает (его адрес возврата — только у магазина). Входите по почте и
   паролю. Тестовый хозяин (только для этой проверки, не настоящий пароль):
     почта   owner@test.tj
     пароль  test-owner-1
   В показательных долгах Фируз записан с телефоном +992 90 111 22 33 — регистрируйтесь
   покупателем с этим номером, и хозяин увидит подсказку «телефон совпал». */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { migrate } = require('./migrate');
const { createApp } = require('./app');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const OWNER = { id: '11111111-1111-1111-1111-111111111111', email: 'owner@test.tj', password: 'test-owner-1', name: 'Гани (тест)', phone: '+992900097337' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function scrypt(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

async function seed(pg, db) {
  await pg.query("insert into public.settings values ('owner_email', $1)", [OWNER.email]);
  await pg.query('insert into auth.users (id, email, email_confirmed_at, name, pass_hash) values ($1, $2, now(), $3, $4)',
    [OWNER.id, OWNER.email, OWNER.name, scrypt(OWNER.password)]);
  await db.asUser(OWNER.id, (q) => q('insert into public.staff (name, phone, mail) values ($1, $2, $3)', [OWNER.name, OWNER.phone, OWNER.email]));
  const day = 864e5, now = Date.now(), iso = (d) => new Date(now + d * day).toISOString().slice(0, 10);
  let n = 0;
  const id = () => 'x' + (++n) + now.toString(36);
  const item = (name, cat, color, size, price, qty) => ({ id: id(), name, cat, color, size, price, qty, ar: qty <= 0, u: 'шт', pk: 1, pb: 'pcs', ab: OWNER.name, ad: now - 30 * day });
  const items = [
    item('Футболка хлопок', 'Одежда', 'Чёрный', 'M', 85, 14), item('Джинсы классика', 'Одежда', 'Синий', '32', 220, 6),
    item('Куртка зимняя', 'Одежда', 'Чёрный', 'L', 450, 4), item('Кепка', 'Аксессуары', 'Чёрный', '', 40, 1),
    item('Носки упаковка', 'Аксессуары', '', '', 15, 48),
  ];
  const people = [{ id: 'p1', name: 'Фируз', phone: '+992901112233' }, { id: 'p2', name: 'Мадина', phone: '+992937778899' }];
  const op = (pid, type, amt, daysAgo, note, due) => ({ id: id(), pid, type, amt, t: now - daysAgo * day, due: due || '', note, calc: '', by: OWNER.name, at: now - daysAgo * day });
  const ops = [op('p1', 'give', 450, 12, 'Куртка зимняя', iso(-4)), op('p1', 'get', 150, 5, 'Частично вернул'), op('p2', 'give', 220, 3, 'Джинсы', iso(7))];
  await db.asUser(OWNER.id, async (q) => {
    await q('select public.doc_set($1, $2::jsonb, null)', ['main', JSON.stringify({ items, log: [], cats: ['Одежда', 'Аксессуары', 'Хозтовары', 'Другое'], trash: [], biz: 'Магазин Ганӣ (тест)' })]);
    await q('select public.doc_set($1, $2::jsonb, null)', ['debts', JSON.stringify({ people, ops, trash: [] })]);
  });
}

(async () => {
  const lib = path.join(ROOT, 'supabase', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
  if (!fs.existsSync(lib)) { console.error('Нет PGlite: cd supabase && npm install'); process.exit(1); }
  const { PGlite } = await import(pathToFileURL(lib).href);
  const pg = new PGlite();
  const db = {
    asUser: (uid, fn) => pg.transaction(async (tx) => {
      await tx.query('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      return fn((sql, p) => tx.query(sql, p).then((r) => r.rows));
    }),
    base: (sql, p) => pg.query(sql, p).then((r) => r.rows),
    exec: (sql) => pg.exec(sql),
  };
  await migrate(db);
  await seed(pg, db);
  const app = createApp({ db, publicUrl: ORIGIN, secureCookies: false, googleId: '', googleSecret: '' });
  await pg.listen('sklad', app.notify);

  http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/health' || p.startsWith('/api/') || p.startsWith('/auth/')) return app.handle(req, res);
    // этот адрес — «магазин»: свой сервер, а не демо
    if (p === '/config.js') { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }); return res.end("window.SKLAD_CONFIG = { api: '/api' };"); }
    const f = path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
    if (!f.startsWith(ROOT + path.sep) || /[\\/](server|supabase|backend|frontend|node_modules|\.git|\.claude)[\\/]/.test(f.slice(ROOT.length))) { res.writeHead(404); return res.end('404'); }
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(d);
    });
  }).listen(PORT, '127.0.0.1', () => console.log('Sklad Go для проверки: ' + ORIGIN));
})().catch((e) => { console.error(e); process.exit(1); });
