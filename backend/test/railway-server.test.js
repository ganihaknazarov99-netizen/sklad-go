'use strict';
/* Свой сервер на Railway (server/) — проверка на настоящем Postgres (PGlite из supabase/).

   Хозяин: «не используй Supabase, только Postgres на Railway». Сервер заменяет Supabase:
   вход через Google, сессии, данные от имени вошедшего, живые обновления. Правила доступа
   и охрана долгов — те же supabase/schema.sql. Проверяем, что они здесь действительно
   работают, а не только «запускаются»: продавец без подтверждения склад не видит, чужой
   сайт не пишет, долг задним числом не меняется, данные первого шага переезда на месте. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const PGLITE = path.join(__dirname, '..', '..', 'supabase', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
const { migrate } = require('../../server/migrate');
const { createApp } = require('../../server/app');

const ХОЗЯИН = '11111111-1111-1111-1111-111111111111';
const ПРОДАВЕЦ = '33333333-3333-3333-3333-333333333333';
const ПОЧТА = 'ganihaknazarov99@gmail.com';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

async function база() {
  const { PGlite } = await import(pathToFileURL(PGLITE).href);
  const pg = new PGlite();
  const db = {
    asUser: (uid, fn) => pg.transaction(async (tx) => {
      await tx.query('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      return fn((sql, p) => tx.query(sql, p).then((r) => r.rows));
    }),
    base: (sql, p) => pg.query(sql, p).then((r) => r.rows),
    exec: (sql) => pg.exec(sql),
    listen: (cb) => pg.listen('sklad', cb),
  };
  return { pg, db };
}

// Как Railway застал базу после первого шага: таблицы без правил, staff.uid — текст
async function первыйШаг(pg) {
  await pg.exec(`
    create table docs (id text primary key, data jsonb not null default '{}'::jsonb, version bigint not null default 0, updated_at timestamptz not null default now());
    create table staff (uid text primary key, name text not null default '', phone text not null default '', mail text not null default '', owner boolean not null default false, status text not null default 'pending', t bigint not null default 0);
    create table activity (id bigserial primary key, t bigint not null, "by" text not null default '', uid text not null default '', txt text not null default '');
    create table settings (key text primary key, value text not null);
  `);
  await pg.query("insert into settings values ('owner_email', $1)", [ПОЧТА]);
  // продавец вписал в команде почту хозяина — по ней его нельзя пустить на место хозяина
  await pg.query(`insert into staff values ($1, 'Гани', '900', $3, true, 'active', 1), ($2, 'Алишер', '901', $3, false, 'active', 2)`, [ХОЗЯИН, ПРОДАВЕЦ, ПОЧТА]);
  await pg.query(`insert into docs values ('main', $1, 7, now()), ('debts', $2, 3, now())`, [
    JSON.stringify({ items: [{ id: 'a', name: 'Куртка', cat: 'Одежда', qty: 5, price: 300 }], log: [] }),
    JSON.stringify({ people: [{ id: 'p1', name: 'Боб' }], ops: [{ id: 'o1', pid: 'p1', type: 'give', amt: 550, t: 1700000000000, by: 'Гани' }], trash: [] }),
  ]);
  await pg.query(`insert into activity (t, "by", uid, txt) values (5, 'Гани', $1, 'добавил куртку')`, [ХОЗЯИН]);
}

// Поддельный Google: выдаёт id_token для того, кого попросили
function google(кто) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return async (url, opt) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const f = new URLSearchParams(opt.body);
    assert.equal(f.get('client_secret'), 'test-secret');
    assert.ok(f.get('code_verifier'), 'PKCE: без проверочного кода вход не идёт');
    const p = кто.shift();
    return {
      ok: true,
      json: async () => ({ id_token: b64({ alg: 'none' }) + '.' + b64(Object.assign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Date.now() / 1000 + 600 }, p)) + '.x' }),
    };
  };
}

// Запрос к серверу без сети: тот же handle, что слушает http.createServer
function клиент(app) {
  const jar = {};
  async function go(method, url, body, head) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({ cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') },
      method === 'GET' ? {} : { 'x-sklad': '1', origin: 'https://skladgo.vercel.app' }, head || {});
    return new Promise((done) => {
      const h = {};
      let code = 0, out = '';
      const res = {
        headersSent: false,
        setHeader: (k, v) => { h[k.toLowerCase()] = v; },
        getHeader: (k) => h[k.toLowerCase()],
        writeHead(c, hh) { code = c; Object.entries(hh || {}).forEach(([k, v]) => { h[k.toLowerCase()] = v; }); this.headersSent = true; },
        write(s) { out += s; },
        end(s) {
          if (s) out += s;
          [].concat(h['set-cookie'] || []).forEach((c) => {
            const [kv, ...rest] = c.split(';');
            const [k, v] = kv.split('=');
            if (/Max-Age=0/.test(rest.join(';'))) delete jar[k]; else jar[k] = v;
          });
          let json = null;
          try { json = JSON.parse(out); } catch (e) {}
          done({ code, h, json, out });
        },
      };
      app.handle(req, res);
    });
  }
  // Полный вход: /auth/google → Google → /auth/callback
  async function войти() {
    const a = await go('GET', '/auth/google?to=/');
    assert.equal(a.code, 302);
    const g = new URL(a.h.location);
    assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(g.searchParams.get('prompt'), 'select_account');
    assert.equal(g.searchParams.get('redirect_uri'), 'https://skladgo.vercel.app/auth/callback');
    return go('GET', '/auth/callback?code=c1&state=' + g.searchParams.get('state'));
  }
  return { go, войти, jar };
}

test('свой сервер на Railway: перенос, вход, правила, живые обновления', async (t) => {
  if (!fs.existsSync(PGLITE)) { t.skip('нет PGlite: cd supabase && npm install'); return; }
  const { pg, db } = await база();
  await первыйШаг(pg);
  await migrate(db);
  await migrate(db);   // второй запуск сервера ничего не ломает

  const кто = [];
  const сигналы = [];
  const app = createApp({ db, publicUrl: 'https://skladgo.vercel.app', googleId: CLIENT_ID, googleSecret: 'test-secret', fetch: google(кто), log() {} });
  await db.listen((p) => { сигналы.push(JSON.parse(p)); app.notify(p); });

  await t.test('данные первого шага на месте, команда — с прежними uid', async () => {
    const s = await pg.query('select uid::text, owner, status from public.staff order by t');
    assert.deepEqual(s.rows.map((r) => [r.uid, r.owner, r.status]), [[ХОЗЯИН, true, 'active'], [ПРОДАВЕЦ, false, 'active']]);
    const u = await pg.query('select email from auth.users');
    assert.ok(u.rows.every((r) => r.email === null), 'почту из команды (её вписывал сам человек) в пользователей не переносим');
    const d = await pg.query("select version from public.docs where id = 'main'");
    assert.equal(Number(d.rows[0].version), 7, 'версия склада та же — телефоны не столкнутся');
    assert.equal((await pg.query('select count(*)::int as n from public.товары')).rows[0].n, 1, 'понятная таблица «товары» заполнена');
    assert.equal((await pg.query('select сумма from public.долги')).rows[0].сумма, '550');
  });

  await t.test('без входа — ничего', async () => {
    const c = клиент(app);
    assert.equal((await c.go('GET', '/api/me')).code, 401);
    assert.equal((await c.go('GET', '/api/docs/main')).code, 401);
    assert.equal((await c.go('GET', '/health')).out, 'ok');
  });

  await t.test('продавец вписал почту хозяина — хозяином не становится', async () => {
    // Вход «Алишера» со своим Gmail: по почте из команды его не узнать — он новый, ждёт
    кто.push({ sub: 'g-alisher', email: 'alisher@gmail.com', email_verified: true, name: 'Алишер' });
    const c = клиент(app);
    const r = await c.войти();
    assert.equal(r.code, 302);
    assert.equal(r.h.location, '/');
    const h = r.h['set-cookie'].find((x) => x.startsWith('sg_s='));
    assert.match(h, /HttpOnly/); assert.match(h, /Secure/); assert.match(h, /SameSite=Lax/);
    const me = (await c.go('GET', '/api/me')).json.data;
    assert.notEqual(me.id, ХОЗЯИН);
    assert.equal((await c.go('GET', '/api/docs/main')).json.data, null, 'не в команде — склад не видно');
    assert.equal((await c.go('POST', '/api/rpc/is_owner')).json.data, false);
  });

  // Последний перенос из Supabase: настоящие почты и аккаунты Google
  await t.test('перенос из Supabase узнаёт хозяина по аккаунту Google', async () => {
    const j = {
      users: [
        { id: ХОЗЯИН, email: ПОЧТА, confirmed: new Date().toISOString(), sub: 'g-gani', name: 'Гани' },
        { id: ПРОДАВЕЦ, email: 'alisher@gmail.com', confirmed: new Date().toISOString(), sub: 'g-alisher', name: 'Алишер' },
      ],
      staff: (await pg.query('select * from public.staff')).rows.filter((s) => [ХОЗЯИН, ПРОДАВЕЦ].includes(s.uid)),
      docs: (await pg.query('select * from public.docs')).rows,
      activity: (await pg.query('select * from public.activity')).rows,
      settings: [{ key: 'owner_email', value: ПОЧТА }],
    };
    const r = await pg.query('select srv.import_supabase($1::jsonb) as m', [JSON.stringify(j)]);
    assert.match(r.rows[0].m, /людей 2/);
    // запись, которую «Алишер» завёл, войдя до переноса, уступила настоящей
    assert.equal((await pg.query("select count(*)::int as n from auth.users where google_sub = 'g-alisher'")).rows[0].n, 1);
    assert.equal((await pg.query('select count(*)::int as n from srv.sessions')).rows[0].n, 0, 'старые сессии сняты');
  });

  const хозяин = клиент(app), продавец = клиент(app);
  await t.test('хозяин входит своим Gmail — тот же uid, он хозяин', async () => {
    кто.push({ sub: 'g-gani', email: ПОЧТА, email_verified: true, name: 'Гани' });
    await хозяин.войти();
    assert.equal((await хозяин.go('GET', '/api/me')).json.data.id, ХОЗЯИН);
    assert.equal((await хозяин.go('POST', '/api/rpc/is_owner')).json.data, true);
    const d = (await хозяин.go('GET', '/api/docs/main')).json.data;
    assert.equal(d.version, 7);
    assert.equal(d.data.items[0].name, 'Куртка');
    assert.deepEqual((await хозяин.go('GET', '/api/docs/main?v=7')).json.data, { id: 'main', version: 7, same: true });
  });

  await t.test('склад пишется с проверкой версии', async () => {
    const pl = { items: [{ id: 'a', name: 'Куртка', cat: 'Одежда', qty: 4, price: 300 }], log: [] };
    const r = await хозяин.go('POST', '/api/rpc/doc_set', { p_id: 'main', p_data: pl, p_if_match: 7 });
    assert.equal(r.json.data, 8);
    const c = await хозяин.go('POST', '/api/rpc/doc_set', { p_id: 'main', p_data: pl, p_if_match: 7 });
    assert.equal(c.code, 409);
    assert.equal(c.json.error.message, 'version_conflict');
    assert.equal((await pg.query('select количество from public.товары')).rows[0].количество, '4', '«товары» пересобрались сами');
  });

  await t.test('продавец: склад видит, долг задним числом не меняет, закупку не видит', async () => {
    кто.push({ sub: 'g-alisher', email: 'alisher@gmail.com', email_verified: true, name: 'Алишер' });
    await продавец.войти();
    assert.equal((await продавец.go('GET', '/api/me')).json.data.id, ПРОДАВЕЦ);
    assert.equal((await продавец.go('GET', '/api/docs/main')).json.data.version, 8);
    const d = (await продавец.go('GET', '/api/docs/debts')).json.data;
    const плохо = JSON.parse(JSON.stringify(d.data));
    плохо.ops[0].amt = 50;
    const r = await продавец.go('POST', '/api/rpc/doc_set', { p_id: 'debts', p_data: плохо, p_if_match: d.version });
    assert.equal(r.code, 422);
    assert.equal(r.json.error.message, 'debt_changed');
    // закупочные цены — только хозяину
    assert.equal((await хозяин.go('POST', '/api/rpc/doc_set', { p_id: 'costs', p_data: { items: { a: 200 } }, p_if_match: null })).json.data, 1);
    assert.equal((await продавец.go('GET', '/api/docs/costs')).json.data, null);
    const w = await продавец.go('POST', '/api/rpc/doc_set', { p_id: 'costs', p_data: { items: {} }, p_if_match: 1 });
    assert.ok(w.code >= 400 && w.code < 500);
  });

  await t.test('команда: статус меняет только хозяин, хозяином себя не сделать', async () => {
    await продавец.go('PATCH', '/api/staff/' + ПРОДАВЕЦ, { name: 'Алишер', owner: true, status: 'active' });
    await продавец.go('PATCH', '/api/staff/' + ХОЗЯИН, { status: 'blocked' });
    const s = (await хозяин.go('GET', '/api/staff')).json.data;
    assert.deepEqual(s.map((x) => [x.uid, x.owner, x.status]).sort(), [[ХОЗЯИН, true, 'active'], [ПРОДАВЕЦ, false, 'active']].sort());
    assert.equal(typeof s[0].t, 'number', 'время — числом, как у Supabase');
    const b = await хозяин.go('PATCH', '/api/staff/' + ПРОДАВЕЦ, { status: 'blocked' });
    assert.equal(b.code, 200, JSON.stringify(b.json));
    assert.equal((await продавец.go('GET', '/api/docs/main')).json.data, null, 'заблокирован — склад не видно');
    await хозяин.go('PATCH', '/api/staff/' + ПРОДАВЕЦ, { status: 'active' });
  });

  await t.test('новичок: регистрируется и ждёт подтверждения', async () => {
    кто.push({ sub: 'g-new', email: 'new@gmail.com', email_verified: true, name: 'Новый' });
    const н = клиент(app);
    await н.войти();
    const me = (await н.go('GET', '/api/me')).json.data;
    assert.equal(me.email, 'new@gmail.com');
    // программа присылает и owner, и status — решает всё равно база
    const ins = await н.go('POST', '/api/staff', { uid: ХОЗЯИН, name: 'Новый', phone: '1', mail: 'new@gmail.com', owner: true, status: 'active', t: 9 });
    assert.equal(ins.code, 200, JSON.stringify(ins.json));
    const r = (await н.go('GET', '/api/staff/' + me.id)).json.data;
    assert.equal(r.status, 'pending');
    assert.equal(r.owner, false);
    assert.equal((await н.go('GET', '/api/activity')).json.data.length, 0, 'ленту не видит, пока ждёт');
    assert.equal((await н.go('POST', '/api/activity', { txt: 'привет' })).code, 403);
    const del = await н.go('POST', '/api/rpc/delete_my_account');
    assert.equal(del.code, 200);
    assert.equal((await н.go('GET', '/api/me')).code, 401, 'аккаунт удалён — вход снят');
  });

  await t.test('лента: подпись ставит база', async () => {
    await продавец.go('POST', '/api/activity', { txt: 'продал куртку', by: 'Гани', uid: ХОЗЯИН, t: 1 });
    const a = (await хозяин.go('GET', '/api/activity?order=t.desc&limit=100')).json.data;
    assert.equal(a[0].txt, 'продал куртку');
    assert.equal(a[0].by, 'Алишер');
    assert.equal(a[0].uid, ПРОДАВЕЦ);
    assert.ok(a[0].t > 1e12);
  });

  await t.test('чужой сайт не пишет', async () => {
    const r1 = await продавец.go('POST', '/api/activity', { txt: 'x' }, { origin: 'https://evil.example' });
    assert.equal(r1.code, 403);
    const r2 = await продавец.go('POST', '/api/activity', { txt: 'x' }, { 'x-sklad': '' });
    assert.equal(r2.code, 403);
  });

  await t.test('живые обновления: сигнал без данных', async () => {
    const ev = [];
    const req = new (require('node:events'))();
    req.method = 'GET'; req.url = '/api/events'; req.headers = { cookie: 'sg_s=' + хозяин.jar.sg_s };
    const res = { setHeader() {}, getHeader() {}, headersSent: false, writeHead() { this.headersSent = true; }, write: (s) => ev.push(s), end() {} };
    await app.handle(req, res);
    await хозяин.go('POST', '/api/rpc/doc_set', { p_id: 'main', p_data: { items: [], log: [] }, p_if_match: 8 });
    await new Promise((r) => setTimeout(r, 50));
    req.emit('close');
    assert.ok(сигналы.some((s) => s.t === 'docs' && s.id === 'main'));
    const data = ev.filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)));
    assert.ok(data.some((s) => s.t === 'docs' && s.id === 'main'), 'склад узнал об изменении');
    assert.ok(data.every((s) => Object.keys(s).every((k) => k === 't' || k === 'id')), 'в сигнале нет самих данных');
  });

  await t.test('выход снимает сессию', async () => {
    await продавец.go('POST', '/api/logout');
    assert.equal((await продавец.go('GET', '/api/me')).code, 401);
  });

  await t.test('чужой или просроченный ключ Google не пускает', async () => {
    кто.push({ sub: 'g-x', aud: 'other-app' });
    const r = await клиент(app).войти();
    assert.match(r.h.location, /error=server_error/);
    кто.push({ sub: 'g-x', exp: 1 });
    assert.match((await клиент(app).войти()).h.location, /error=server_error/);
    const c = клиент(app);
    assert.match((await c.go('GET', '/auth/callback?code=c&state=forged')).h.location, /error=bad_state/);
  });

  await pg.close();
});
