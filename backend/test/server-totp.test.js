'use strict';
/* Код из приложения к входу хозяина по паролю и «выйти на всех устройствах»
   (server/app.js + server/totp.js) — на настоящем Postgres (PGlite).

   Хозяин: «пароль + код из приложения» и «выйти на всех устройствах». Проверяем, что
   дверь закрыта: одного пароля мало, подсмотренный код второй раз не проходит, перебор
   кода упирается в предел, тихо выключить код без пароля нельзя, а «выйти везде»
   действительно закрывает все входы. */
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
const TOTP = require('../../server/totp');
const ХОЗЯИН = '11111111-1111-1111-1111-111111111111';
const ПРОДАВЕЦ = '33333333-3333-3333-3333-333333333333';

function клиент(app, ip) {
  const jar = {};
  async function go(method, url, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.socket = { remoteAddress: ip };
    req.headers = Object.assign({ cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') },
      method === 'GET' ? {} : { 'x-sklad': '1', origin: 'https://skladgo.vercel.app' });
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
          done({ code, json });
        },
      });
    });
  }
  return { go, jar };
}

test('код из приложения и выход на всех устройствах', async (t) => {
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
  await pg.query("insert into public.settings values ('owner_email', 'g@test.tj')");
  await pg.query("insert into auth.users (id, email, email_confirmed_at, google_sub, name) values ($1, 'g@test.tj', now(), 'g1', 'Гани'), ($2, 's@test.tj', now(), 'g2', 'Алишер')", [ХОЗЯИН, ПРОДАВЕЦ]);
  await db.asUser(ХОЗЯИН, (q) => q("insert into public.staff (name, phone, mail) values ('Гани', '1', 'g@test.tj')"));
  await db.asUser(ПРОДАВЕЦ, (q) => q("insert into public.staff (name, phone, mail) values ('Алишер', '2', 's@test.tj')"));
  let now = Date.now();
  const app = createApp({ db, publicUrl: 'https://skladgo.vercel.app', googleId: 'x', googleSecret: 'y', now: () => now, log() {} });
  // вход через Google (готовая сессия) — с него хозяин и настраивает код
  const google = async (uid, ip) => {
    const c = клиент(app, ip), token = crypto.randomBytes(16).toString('hex');
    await pg.query("insert into srv.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [crypto.createHash('sha256').update(token).digest('hex'), uid]);
    c.jar.sg_s = token;
    return c;
  };
  const хозяин = await google(ХОЗЯИН, '10.0.0.1');
  let secret;

  await t.test('включить код можно только хозяину и только зная пароль', async () => {
    const r0 = await хозяин.go('POST', '/api/totp/start', { password: 'x' });
    assert.equal(r0.json.error.code, 'no_password', 'сначала — пароль');
    assert.equal((await хозяин.go('POST', '/api/password', { password: 'owner-pass-1' })).code, 200);
    assert.equal((await хозяин.go('POST', '/api/totp/start', { password: 'не тот' })).code, 403);
    const r = await хозяин.go('POST', '/api/totp/start', { password: 'owner-pass-1' });
    assert.equal(r.code, 200);
    secret = r.json.data.secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(r.json.data.uri, /^otpauth:\/\/totp\/Sklad%20Go:g%40test\.tj\?secret=/);
    assert.equal((await хозяин.go('POST', '/api/totp/confirm', { code: '000000' })).code, 400, 'неверный код не включает');
    assert.equal((await хозяин.go('GET', '/api/me')).json.data.has_totp, false);
    assert.equal((await хозяин.go('POST', '/api/totp/confirm', { code: TOTP.codeAt(secret, now) })).code, 200);
    assert.equal((await хозяин.go('GET', '/api/me')).json.data.has_totp, true);
    const продавец = await google(ПРОДАВЕЦ, '10.0.0.2');
    assert.equal((await продавец.go('POST', '/api/totp/start', { password: 'x' })).code, 403, 'продавцу — не нужно');
  });

  await t.test('вход хозяина: пароль, потом код; использованный код второй раз не проходит', async () => {
    const к = клиент(app, '10.0.0.3');
    const r1 = await к.go('POST', '/auth/password/login', { email: 'g@test.tj', password: 'owner-pass-1' });
    assert.deepEqual([r1.code, r1.json.error.code], [401, 'need_code']);
    assert.equal((await к.go('GET', '/api/me')).code, 401, 'без кода не вошёл');
    now += 30000;
    const code = TOTP.codeAt(secret, now);
    assert.equal((await к.go('POST', '/auth/password/login', { email: 'g@test.tj', password: 'owner-pass-1', code })).code, 200);
    assert.equal((await к.go('POST', '/api/rpc/is_owner')).json.data, true);
    const вор = клиент(app, '10.0.0.4');
    const r2 = await вор.go('POST', '/auth/password/login', { email: 'g@test.tj', password: 'owner-pass-1', code });
    assert.deepEqual([r2.code, r2.json.error.code], [401, 'bad_code'], 'подсмотренный код уже использован');
  });

  await t.test('перебор кода упирается в предел', async () => {
    const к = клиент(app, '10.0.0.5');
    for (let i = 0; i < 10; i++) await к.go('POST', '/auth/password/login', { email: 'g@test.tj', password: 'owner-pass-1', code: String(100000 + i) });
    now += 30000;
    const r = await к.go('POST', '/auth/password/login', { email: 'g@test.tj', password: 'owner-pass-1', code: TOTP.codeAt(secret, now) });
    assert.equal(r.code, 429, 'после 10 неверных кодов — пауза даже с верным');
  });

  await t.test('выключить код — только с паролем; хозяин без кода по паролю не входит', async () => {
    assert.equal((await хозяин.go('POST', '/api/totp/off', { password: 'не тот' })).code, 403);
    assert.equal((await хозяин.go('GET', '/api/me')).json.data.has_totp, true);
    assert.equal((await хозяин.go('POST', '/api/totp/off', { password: 'owner-pass-1' })).code, 200);
    const r = await клиент(app, '10.0.0.6').go('POST', '/auth/password/login', { email: 'g@test.tj', password: 'owner-pass-1' });
    assert.equal(r.json.error.code, 'owner_needs_code');
  });

  await t.test('«выйти на всех устройствах» закрывает все входы этого человека, и только его', async () => {
    const ещё = await google(ХОЗЯИН, '10.0.0.7');
    const продавец = await google(ПРОДАВЕЦ, '10.0.0.8');
    assert.equal((await ещё.go('GET', '/api/me')).code, 200);
    assert.equal((await хозяин.go('POST', '/api/logout_all')).code, 200);
    assert.equal((await хозяин.go('GET', '/api/me')).code, 401);
    assert.equal((await ещё.go('GET', '/api/me')).code, 401, 'второй телефон тоже вышел');
    assert.equal((await продавец.go('GET', '/api/me')).code, 200, 'чужие входы не тронуты');
  });

  await t.test('новый пароль закрывает входы на других телефонах', async () => {
    const а = await google(ХОЗЯИН, '10.0.0.9'), б = await google(ХОЗЯИН, '10.0.0.10');
    assert.equal((await а.go('POST', '/api/password', { password: 'owner-pass-2', current: 'owner-pass-1' })).code, 200);
    assert.equal((await а.go('GET', '/api/me')).code, 200, 'тот, кто менял, остался');
    assert.equal((await б.go('GET', '/api/me')).code, 401);
  });

  await pg.close();
});
