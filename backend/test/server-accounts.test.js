'use strict';
/* Вход по почте и паролю и покупатели на своём сервере (server/app.js + after.sql) —
   на настоящем Postgres (PGlite из supabase/).

   Хозяин: «дай войти как владелец и как покупатель». Проверяем то, что важно в живом
   магазине: пароль не хранится, перебор пароля упирается в предел, по паролю нельзя
   стать хозяином, покупатель без подтверждения хозяина не видит ничего, а после —
   только свои записи о долге: ни склада, ни чужих долгов, ни команды. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const PGLITE = path.join(__dirname, '..', '..', 'supabase', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
const { migrate } = require('../../server/migrate');
const { createApp } = require('../../server/app');

const ХОЗЯИН = '11111111-1111-1111-1111-111111111111';
const ПОЧТА_ХОЗЯИНА = 'ganihaknazarov99@gmail.com';

function клиент(app, ip) {
  const jar = {};
  async function go(method, url, body, head) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.socket = { remoteAddress: ip || '10.0.0.1' };
    req.headers = Object.assign({ cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') },
      method === 'GET' ? {} : { 'x-sklad': '1', origin: 'https://skladgo.vercel.app' }, head || {});
    return new Promise((done) => {
      const h = {};
      let code = 0, out = '';
      app.handle(req, {
        headersSent: false,
        setHeader: (k, v) => { h[k.toLowerCase()] = v; },
        getHeader: (k) => h[k.toLowerCase()],
        writeHead(c, hh) { code = c; Object.entries(hh || {}).forEach(([k, v]) => { h[k.toLowerCase()] = v; }); this.headersSent = true; },
        write(s) { out += s; },
        end(s) {
          if (s) out += s;
          [].concat(h['set-cookie'] || []).forEach((c) => {
            const [k, v] = c.split(';')[0].split('=');
            if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v;
          });
          let json = null;
          try { json = JSON.parse(out); } catch (e) {}
          done({ code, h, json });
        },
      });
    });
  }
  return { go, jar };
}

test('вход по паролю и покупатели на своём сервере', async (t) => {
  if (!fs.existsSync(PGLITE)) { t.skip('нет PGlite: cd supabase && npm install'); return; }
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
  };
  await migrate(db);
  // Хозяин вошёл через Google (почта подтверждена), магазин и долги — как в жизни
  await pg.query("insert into public.settings values ('owner_email', $1)", [ПОЧТА_ХОЗЯИНА]);
  await pg.query("insert into auth.users (id, email, email_confirmed_at, google_sub, name) values ($1, $2, now(), 'g-gani', 'Гани')", [ХОЗЯИН, ПОЧТА_ХОЗЯИНА]);
  await db.asUser(ХОЗЯИН, (q) => q("insert into public.staff (name, phone, mail) values ('Гани', '+992900097337', $1)", [ПОЧТА_ХОЗЯИНА]));
  const day = 864e5, now = Date.now();
  await db.asUser(ХОЗЯИН, async (q) => {
    await q('select public.doc_set($1, $2::jsonb, null)', ['main', JSON.stringify({ items: [{ id: 'i1', name: 'Куртка', qty: 3, price: 450 }], log: [], biz: 'Магазин Ганӣ' })]);
    await q('select public.doc_set($1, $2::jsonb, null)', ['debts', JSON.stringify({
      people: [{ id: 'p1', name: 'Фируз', phone: '+992901112233' }, { id: 'p2', name: 'Мадина', phone: '+992937778899' }],
      ops: [
        { id: 'o1', pid: 'p1', type: 'give', amt: 450, t: now - 12 * day, due: '2026-11-01', note: 'Куртка' },
        { id: 'o2', pid: 'p1', type: 'get', amt: 150, t: now - 5 * day, note: 'Частично' },
        { id: 'o3', pid: 'p2', type: 'give', amt: 220, t: now - 3 * day, note: 'Джинсы' },
      ], trash: [],
    })]);
  });
  const app = createApp({ db, publicUrl: 'https://skladgo.vercel.app', googleId: 'x', googleSecret: 'y', log() {} });
  const хозяин = клиент(app);
  const token = crypto.randomBytes(16).toString('hex');
  await pg.query("insert into srv.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [crypto.createHash('sha256').update(token).digest('hex'), ХОЗЯИН]);
  хозяин.jar.sg_s = token;

  const фируз = клиент(app, '10.0.0.2');
  let uidФ;
  await t.test('покупатель регистрируется: пароль не хранится, ждёт подтверждения', async () => {
    const r = await фируз.go('POST', '/auth/password/signup', { role: 'customer', name: 'Фируз', phone: '90 111 22 33', email: 'Firuz@Test.tj', password: 'parol-123' });
    assert.equal(r.code, 200, JSON.stringify(r.json));
    uidФ = r.json.data.id;
    const me = (await фируз.go('GET', '/api/me')).json.data;
    assert.deepEqual([me.kind, me.email, me.has_password], ['customer', 'firuz@test.tj', true]);
    const u = (await pg.query('select pass_hash, email_confirmed_at from auth.users where id = $1', [uidФ])).rows[0];
    assert.match(u.pass_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.doesNotMatch(u.pass_hash, /parol-123/);
    assert.equal(u.email_confirmed_at, null, 'почта по паролю не подтверждена — хозяином по ней не стать');
    const d = (await фируз.go('POST', '/api/rpc/my_debt')).json.data;
    assert.equal(d.status, 'pending');
    assert.equal(d.person, null);
    assert.deepEqual(d.ops, []);
  });

  await t.test('покупатель не видит ни склада, ни долгов, ни команды и сам себя не подтвердит', async () => {
    assert.equal((await фируз.go('GET', '/api/docs/debts')).json.data, null);
    assert.equal((await фируз.go('GET', '/api/docs/main')).json.data, null);
    assert.deepEqual((await фируз.go('GET', '/api/staff')).json.data, []);
    assert.deepEqual((await фируз.go('GET', '/api/activity')).json.data, []);
    await фируз.go('PATCH', '/api/customers/' + uidФ, { status: 'active', pid: 'p2', name: 'Фируз Р.' });
    const own = (await фируз.go('GET', '/api/customers/' + uidФ)).json.data;
    assert.deepEqual([own.status, own.pid, own.name], ['pending', null, 'Фируз Р.'], 'имя поправить можно, статус и чужие долги — нет');
    assert.equal((await фируз.go('POST', '/api/rpc/doc_set', { p_id: 'debts', p_data: { people: [], ops: [] }, p_if_match: null })).code, 403);
  });

  await t.test('хозяин видит покупателя и подтверждает: покупатель видит только свои записи', async () => {
    const L = (await хозяин.go('GET', '/api/customers')).json.data;
    assert.deepEqual(L.map((c) => [c.name, c.phone, c.status]), [['Фируз Р.', '+992901112233', 'pending']]);
    assert.equal((await хозяин.go('PATCH', '/api/customers/' + uidФ, { status: 'active', pid: 'p1' })).code, 200);
    const d = (await фируз.go('POST', '/api/rpc/my_debt')).json.data;
    assert.equal(d.status, 'active');
    assert.deepEqual(d.person, { name: 'Фируз' });
    assert.deepEqual(d.ops.map((o) => [o.type, Number(o.amt), o.note]).sort(), [['get', 150, 'Частично'], ['give', 450, 'Куртка']]);
    assert.equal(d.biz, 'Магазин Ганӣ');
    assert.equal(d.owner_phone, '+992900097337', 'есть куда позвонить');
    assert.equal(JSON.stringify(d).indexOf('Мадина'), -1, 'чужих долгов в ответе нет');
    assert.equal(JSON.stringify(d).indexOf('Куртка","qty'), -1);
    assert.equal((await фируз.go('GET', '/api/docs/debts')).json.data, null, 'и подтверждённому — только свои строки, не весь документ');
  });

  await t.test('другой покупатель не видит первого', async () => {
    const м = клиент(app, '10.0.0.3');
    assert.equal((await м.go('POST', '/auth/password/signup', { role: 'customer', name: 'Мадина', phone: '937778899', email: 'madina@test.tj', password: 'parol-456' })).code, 200);
    const L = (await м.go('GET', '/api/customers')).json.data;
    assert.deepEqual(L.map((c) => c.name), ['Мадина']);
    assert.equal((await м.go('GET', '/api/customers/' + uidФ)).json.data, null);
    assert.equal((await м.go('POST', '/api/rpc/my_debt')).json.data.person, null);
  });

  await t.test('вход: неверный пароль и чужая почта — одна ошибка; перебор упирается в предел', async () => {
    const к = клиент(app, '10.0.0.9');
    const плохо = await к.go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'не тот' });
    assert.equal(плохо.code, 401);
    const нетПочты = await к.go('POST', '/auth/password/login', { email: 'nobody@test.tj', password: 'parol-123' });
    assert.deepEqual(нетПочты.json, плохо.json, 'не выдаём, есть ли такой аккаунт');
    assert.equal((await к.go('POST', '/auth/password/login', { email: ' FIRUZ@test.tj ', password: 'parol-123' })).code, 200);
    assert.equal((await к.go('GET', '/api/me')).json.data.kind, 'customer');
    const в = клиент(app, '10.0.0.10');
    for (let i = 0; i < 10; i++) await в.go('POST', '/auth/password/login', { email: 'madina@test.tj', password: 'x' + i });
    const стоп = await в.go('POST', '/auth/password/login', { email: 'madina@test.tj', password: 'parol-456' });
    assert.equal(стоп.code, 429, 'после 10 неудач — пауза, даже с верным паролем');
  });

  await t.test('почта занята — второй аккаунт не завести; по паролю хозяином не стать', async () => {
    const к = клиент(app, '10.0.0.4');
    const r = await к.go('POST', '/auth/password/signup', { role: 'staff', name: 'Вор', email: ПОЧТА_ХОЗЯИНА.toUpperCase(), password: 'parol-789' });
    assert.equal(r.code, 409);
    const c = await к.go('POST', '/auth/password/signup', { role: 'customer', name: 'X', phone: '901112233', email: 'x@test.tj', password: 'short' });
    assert.equal(c.code, 400);
    assert.match(c.json.error.message, /не короче 8/);
    // магазин без хозяина: регистрация по паролю с почтой хозяина хозяина не даёт
    await pg.query("update public.settings set value = 'new-owner@test.tj' where key = 'owner_email'");
    // хозяина на время снимаем (охранник staff_guard сам этого не даст), чтобы место было свободно
    await pg.exec('alter table public.staff disable trigger staff_guard');
    await pg.query('update public.staff set owner = false where uid = $1', [ХОЗЯИН]);
    await pg.exec('alter table public.staff enable trigger staff_guard');
    const s = клиент(app, '10.0.0.5');
    assert.equal((await s.go('POST', '/auth/password/signup', { role: 'staff', name: 'Самозванец', email: 'new-owner@test.tj', password: 'parol-000' })).code, 200);
    await s.go('POST', '/api/staff', { name: 'Самозванец', phone: '1', mail: 'new-owner@test.tj' });
    const me = (await s.go('GET', '/api/me')).json.data;
    const row = (await pg.query('select owner, status from public.staff where uid = $1', [me.id])).rows[0];
    assert.deepEqual([row.owner, row.status], [false, 'pending'], 'почта не подтверждена — ждёт, как все');
    assert.equal(me.kind, 'staff');
    await pg.query("update public.settings set value = $1 where key = 'owner_email'", [ПОЧТА_ХОЗЯИНА]);
    await pg.exec('alter table public.staff disable trigger staff_guard');
    await pg.query('update public.staff set owner = true where uid = $1', [ХОЗЯИН]);
    await pg.exec('alter table public.staff enable trigger staff_guard');
  });

  await t.test('хозяин, вошедший через Google, задаёт пароль и входит по нему', async () => {
    assert.equal((await хозяин.go('GET', '/api/me')).json.data.has_password, false);
    assert.equal((await хозяин.go('POST', '/api/password', { password: 'owner-pass-1' })).code, 200);
    const к = клиент(app, '10.0.0.6');
    assert.equal((await к.go('POST', '/auth/password/login', { email: ПОЧТА_ХОЗЯИНА, password: 'owner-pass-1' })).code, 200);
    assert.equal((await к.go('POST', '/api/rpc/is_owner')).json.data, true);
    assert.equal((await хозяин.go('POST', '/api/password', { password: 'owner-pass-2' })).code, 403, 'сменить — только зная прежний');
    assert.equal((await хозяин.go('POST', '/api/password', { password: 'owner-pass-2', current: 'owner-pass-1' })).code, 200);
  });

  await t.test('чужой сайт не регистрирует и не входит', async () => {
    const к = клиент(app, '10.0.0.7');
    assert.equal((await к.go('POST', '/auth/password/signup', { role: 'customer', name: 'Y', phone: '901112233', email: 'y@test.tj', password: 'parol-111' }, { 'x-sklad': '' })).code, 403);
    assert.equal((await к.go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'parol-123' }, { origin: 'https://evil.example' })).code, 403);
    assert.equal((await к.go('GET', '/auth/password/login')).code, 405);
  });

  await pg.close();
});
