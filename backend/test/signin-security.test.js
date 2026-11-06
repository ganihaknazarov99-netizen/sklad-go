'use strict';
/* Проверка входа на своём сервере (server/app.js) после разбора безопасности.

   Хозяин: «чтобы пароль нельзя было подбирать, а почту хозяина — занять». Проверяем дыры,
   которые нашёл разбор:
   · предел попыток обходили, подставляя новый X-Forwarded-For на каждую попытку;
   · ответ «нужен код» выдавал, что пароль хозяина верен, а код из приложения перебирали
     с разных адресов;
   · на 10 001-м счётчике неудач весь счёт стирался;
   · после Google можно было уйти на чужой сайт: «/<табуляция>/evil.example»;
   · Gmail хозяина или продавца занимали заранее аккаунтом по паролю — и настоящий
     человек после Google оставался без почты и хозяином не становился. */
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

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ОКНО = 15 * 60000;

// Запрос к серверу без сети. адрес — адрес соединения (у Railway это его прокси), head —
// заголовки, которые прислал посетитель или прокси
function клиент(app, адрес) {
  const jar = {};
  async function go(method, url, body, head) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.socket = { remoteAddress: адрес || '10.0.0.1' };
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
  // Полный вход через Google: /auth/google → Google → /auth/callback
  async function google(to) {
    const a = await go('GET', '/auth/google?to=' + encodeURIComponent(to || '/'));
    const g = new URL(a.h.location);
    return go('GET', '/auth/callback?code=c1&state=' + g.searchParams.get('state'));
  }
  return { go, google, jar };
}

// Поддельный Google: выдаёт id_token для того, кого попросили
function поддельныйGoogle(кто) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return async () => {
    const p = кто.shift();
    return { ok: true, json: async () => ({ id_token: b64({ alg: 'none' }) + '.' + b64(Object.assign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Date.now() / 1000 + 600 }, p)) + '.x' }) };
  };
}

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
  };
  await migrate(db);
  return { pg, db };
}

test('вход по паролю: подставной адрес не даёт новых попыток', async (t) => {
  if (!fs.existsSync(PGLITE)) { t.skip('нет PGlite: cd supabase && npm install'); return; }
  const { pg, db } = await база();
  let now = Date.now();
  // каждой проверке — свой сервер, то есть свой счёт неудач; railway — как на Railway (index.js)
  const сервер = (railway) => createApp({ db, publicUrl: 'https://skladgo.vercel.app', googleId: CLIENT_ID, googleSecret: 'y', now: () => now, log() {}, ipHeader: railway ? 'x-real-ip' : undefined });
  assert.equal((await клиент(сервер(), '10.9.9.9').go('POST', '/auth/password/signup', { role: 'staff', name: 'Фируз', email: 'firuz@test.tj', password: 'parol-123' })).code, 200);
  let n = 0;
  const новый = () => '198.51.' + (Math.floor(++n / 250) % 250) + '.' + (n % 250);

  await t.test('X-Forwarded-For с новым адресом на каждую попытку — счёт тот же', async () => {
    const вор = клиент(сервер(), '100.64.0.2');
    for (let i = 0; i < 10; i++) {
      const r = await вор.go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'x' + i }, { 'x-forwarded-for': новый(), 'x-real-ip': новый() });
      assert.equal(r.code, 401);
    }
    const r = await вор.go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'parol-123' }, { 'x-forwarded-for': новый(), 'x-real-ip': новый() });
    assert.equal(r.code, 429, 'заголовкам от самого посетителя не верим — считаем по адресу соединения');
  });

  await t.test('за прокси Railway: адрес посетителя — X-Real-IP, X-Forwarded-For не в счёт', async () => {
    const a = сервер(true);
    const за = клиент(a, '100.64.0.2');   // адрес соединения — прокси, один на всех
    for (let i = 0; i < 10; i++) {
      const r = await за.go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'y' + i }, { 'x-forwarded-for': новый() + ', 203.0.113.5', 'x-real-ip': '203.0.113.5' });
      assert.equal(r.code, 401);
    }
    assert.equal((await за.go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'parol-123' }, { 'x-forwarded-for': новый(), 'x-real-ip': '203.0.113.5' })).code, 429);
    assert.equal((await клиент(a, '100.64.0.2').go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'parol-123' }, { 'x-real-ip': '203.0.113.6' })).code, 200, 'другой посетитель за тем же прокси входит');
  });

  await t.test('на одну почту — не больше 30 неудач со всех адресов; после окна человек входит', async () => {
    const a = сервер();
    for (let i = 0; i < 30; i++) {
      const r = await клиент(a, новый()).go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'z' + i });
      assert.equal(r.code, 401, 'с каждого адреса — по одной попытке');
    }
    const стоп = await клиент(a, новый()).go('POST', '/auth/password/login', { email: 'FIRUZ@test.tj', password: 'parol-123' });
    assert.equal(стоп.code, 429, 'тридцать неудач на почту — пауза даже с нового адреса и с верным паролем');
    assert.equal((await клиент(a, новый()).go('POST', '/auth/password/login', { email: 'other@test.tj', password: 'parol-123' })).code, 401, 'чужую почту это не держит');
    now += ОКНО + 1000;
    const к = клиент(a, новый());
    assert.equal((await к.go('POST', '/auth/password/login', { email: 'firuz@test.tj', password: 'parol-123' })).code, 200, 'окно прошло — входит');
    assert.equal((await к.go('GET', '/api/me')).json.data.email, 'firuz@test.tj');
  });

  await t.test('регистрации пачкой: новый X-Forwarded-For на каждую не помогает', async () => {
    const к = клиент(сервер(true), '100.64.0.3');
    for (let i = 0; i < 30; i++) {   // 30 — предел регистраций с одного адреса
      const r = await к.go('POST', '/auth/password/signup', { role: 'staff', name: 'Спам ' + i, email: 'spam' + i + '@test.tj', password: 'parol-123' }, { 'x-forwarded-for': новый(), 'x-real-ip': '203.0.113.7' });
      assert.equal(r.code, 200);
    }
    const r = await к.go('POST', '/auth/password/signup', { role: 'staff', name: 'Спам', email: 'spam-x@test.tj', password: 'parol-123' }, { 'x-forwarded-for': новый(), 'x-real-ip': '203.0.113.7' });
    assert.equal(r.code, 429);
  });

  await pg.close();
});

test('пароль хозяина и код из приложения: ни подбор пароля по «нужен код», ни перебор кода', async (t) => {
  if (!fs.existsSync(PGLITE)) { t.skip('нет PGlite: cd supabase && npm install'); return; }
  const { pg, db } = await база();
  const ХОЗЯИН = '11111111-1111-1111-1111-111111111111';
  await pg.query("insert into public.settings values ('owner_email', 'g@test.tj')");
  await pg.query("insert into auth.users (id, email, email_confirmed_at, google_sub, name) values ($1, 'g@test.tj', now(), 'g1', 'Гани')", [ХОЗЯИН]);
  await db.asUser(ХОЗЯИН, (q) => q("insert into public.staff (name, phone, mail) values ('Гани', '1', 'g@test.tj')"));
  let now = Date.now();
  const app = createApp({ db, publicUrl: 'https://skladgo.vercel.app', googleId: CLIENT_ID, googleSecret: 'y', now: () => now, log() {} });
  // хозяин вошёл через Google, задал пароль и включил код
  const хозяин = клиент(app, '10.0.0.1'), token = crypto.randomBytes(16).toString('hex');
  await pg.query("insert into srv.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [crypto.createHash('sha256').update(token).digest('hex'), ХОЗЯИН]);
  хозяин.jar.sg_s = token;
  assert.equal((await хозяин.go('POST', '/api/password', { password: 'owner-pass-1' })).code, 200);
  const secret = (await хозяин.go('POST', '/api/totp/start', { password: 'owner-pass-1' })).json.data.secret;
  assert.equal((await хозяин.go('POST', '/api/totp/confirm', { code: TOTP.codeAt(secret, now) })).code, 200);
  let n = 0;
  const новый = () => '198.51.100.' + (++n % 250);
  const вход = (body) => клиент(app, новый()).go('POST', '/auth/password/login', Object.assign({ email: 'g@test.tj' }, body));

  await t.test('«нужен код» идёт в счёт: подбор пароля упирается в предел и с разных адресов', async () => {
    for (let i = 0; i < 30; i++) {
      const r = await вход(i % 2 ? { password: 'owner-pass-1' } : { password: 'не тот ' + i });
      assert.equal(r.code, 401);
    }
    now += 30000;
    const r = await вход({ password: 'owner-pass-1', code: TOTP.codeAt(secret, now) });
    assert.equal(r.code, 429, 'тридцать попыток на почту хозяина — пауза, даже с верным кодом');
  });

  await t.test('перебор кода закрывается после 5 неверных; после окна хозяин входит', async () => {
    now += ОКНО + 1000;
    for (let i = 0; i < 5; i++) {
      const r = await вход({ password: 'owner-pass-1', code: String(100000 + i) });
      assert.deepEqual([r.code, r.json.error.code], [401, 'bad_code']);
    }
    now += 30000;
    const стоп = await вход({ password: 'owner-pass-1', code: TOTP.codeAt(secret, now) });
    assert.equal(стоп.code, 429, 'пять неверных кодов с разных адресов — пауза даже с верным');
    assert.equal((await вход({ password: 'не тот' })).code, 429, 'и ответ одинаков при неверном пароле — пароль не выдаёт');
    now += ОКНО + 1000;
    const к = клиент(app, новый());
    const r = await к.go('POST', '/auth/password/login', { email: 'g@test.tj', password: 'owner-pass-1', code: TOTP.codeAt(secret, now) });
    assert.equal(r.code, 200, 'окно прошло — хозяин входит');
    assert.equal((await к.go('POST', '/api/rpc/is_owner')).json.data, true);
  });

  await pg.close();
});

test('переполнение счётчика неудач не сбрасывает счёт того, кого перебирают', async () => {
  let now = Date.now();
  // базе здесь нечего хранить: такой почты нет, а почта для регистрации уже занята
  const db = { base: async (sql) => (/^select 1 from auth\.users/.test(sql) ? [{ x: 1 }] : []) };
  const app = createApp({ db, publicUrl: 'https://skladgo.vercel.app', googleId: CLIENT_ID, googleSecret: 'y', now: () => now, log() {} });
  const вор = клиент(app, '203.0.113.9');
  for (let i = 0; i < 10; i++) assert.equal((await вор.go('POST', '/auth/password/login', { email: 'victim@test.tj', password: 'x' + i })).code, 401);
  assert.equal((await вор.go('POST', '/auth/password/login', { email: 'victim@test.tj', password: 'y' })).code, 429);
  assert.equal((await вор.go('POST', '/auth/password/login', { email: 'x'.repeat(5000) + '@test.tj', password: 'y' })).code, 401, 'огромная «почта» в счёт не идёт');
  // 10 001 пустая попытка с разных адресов — раньше на ней счёт стирался у всех
  for (let i = 0; i < 10001; i++) {
    const r = await клиент(app, '10.' + (i >> 16) + '.' + ((i >> 8) & 255) + '.' + (i & 255)).go('POST', '/auth/password/signup', { role: 'staff', name: 'X', email: 'taken@test.tj', password: 'parol-123' });
    assert.equal(r.code, 409);
  }
  assert.equal((await вор.go('POST', '/auth/password/login', { email: 'victim@test.tj', password: 'z' })).code, 429, 'перебор по-прежнему на паузе');
  now += ОКНО + 1000;
  assert.equal((await вор.go('POST', '/auth/password/login', { email: 'victim@test.tj', password: 'z' })).code, 401, 'окно прошло — счёт прошёл вместе с ним');
});

test('после Google — только на свой путь: ни управляющие знаки, ни «\\» не уводят на чужой сайт', async () => {
  const кто = [];
  const app = createApp({
    db: { base: async () => [{ id: '11111111-1111-4111-8111-111111111111' }] },
    publicUrl: 'https://skladgo.vercel.app', googleId: CLIENT_ID, googleSecret: 's', fetch: поддельныйGoogle(кто), log() {},
  });
  for (const to of ['/\t/evil.example', '/\\evil', '//evil', '/\\/evil.example', '/\n/evil.example', '/\r\n/evil', '/ok\x00', '/\x7f/evil', '/путь']) {
    кто.push({ sub: 'g1', email: 'a@gmail.com', email_verified: true });
    const r = await клиент(app).google(to);
    assert.equal(r.code, 302, JSON.stringify(to));
    assert.equal(r.h.location, '/', JSON.stringify(to));
  }
  for (const to of ['/path?x=1', '/', '/%D0%BF%D1%83%D1%82%D1%8C?a=b#c']) {
    кто.push({ sub: 'g1', email: 'a@gmail.com', email_verified: true });
    const r = await клиент(app).google(to);
    assert.equal(r.h.location, to, 'свой путь сохраняется');
  }
  // и прямо в адресе /auth/google — как пришло бы по ссылке
  const к = клиент(app);
  const a = await к.go('GET', '/auth/google?to=/%09/evil.example');
  кто.push({ sub: 'g1', email: 'a@gmail.com', email_verified: true });
  const back = await к.go('GET', '/auth/callback?code=c&state=' + new URL(a.h.location).searchParams.get('state'));
  assert.equal(back.h.location, '/');
});

test('Gmail, занятый аккаунтом по паролю, достаётся тому, кто вошёл им через Google', async (t) => {
  if (!fs.existsSync(PGLITE)) { t.skip('нет PGlite: cd supabase && npm install'); return; }
  const { pg, db } = await база();
  await pg.query("insert into public.settings values ('owner_email', 'boss@gmail.com')");
  const кто = [];
  const app = createApp({ db, publicUrl: 'https://skladgo.vercel.app', googleId: CLIENT_ID, googleSecret: 'test-secret', fetch: поддельныйGoogle(кто), log() {} });
  const вор = клиент(app, '10.0.0.66');
  let uidВора, uidХозяина;

  await t.test('самозванец заводит аккаунт по паролю на Gmail хозяина — хозяином не стал', async () => {
    assert.equal((await вор.go('POST', '/auth/password/signup', { role: 'staff', name: 'Самозванец', email: 'Boss@Gmail.com', password: 'squat-pass-1' })).code, 200);
    await вор.go('POST', '/api/staff', { name: 'Самозванец', phone: '1', mail: 'boss@gmail.com' });
    uidВора = (await вор.go('GET', '/api/me')).json.data.id;
    assert.equal((await вор.go('POST', '/api/rpc/is_owner')).json.data, false);
  });

  await t.test('настоящий хозяин входит через Google — почта его, он хозяин', async () => {
    кто.push({ sub: 'g-boss', email: 'boss@gmail.com', email_verified: true, name: 'Гани' });
    const хозяин = клиент(app, '10.0.0.1');
    assert.equal((await хозяин.google()).h.location, '/');
    const me = (await хозяин.go('GET', '/api/me')).json.data;
    uidХозяина = me.id;
    assert.notEqual(uidХозяина, uidВора, 'запись самозванца хозяину не отдаём — у него своя, чистая');
    assert.equal(me.email, 'boss@gmail.com');
    assert.equal(me.has_password, false);
    assert.equal(me.kind, 'staff');
    assert.equal((await хозяин.go('POST', '/api/staff', { name: 'Гани', phone: '2', mail: 'boss@gmail.com' })).code, 200);
    assert.equal((await хозяин.go('POST', '/api/rpc/is_owner')).json.data, true, 'почта совпала с owner_email — хозяин');
  });

  await t.test('пароль самозванца больше никуда не пускает', async () => {
    assert.equal((await вор.go('GET', '/api/me')).code, 401, 'его входы сняты');
    const r = await клиент(app, '10.0.0.67').go('POST', '/auth/password/login', { email: 'boss@gmail.com', password: 'squat-pass-1' });
    assert.deepEqual([r.code, r.json.error.code], [401, 'bad_login']);
    const u = (await pg.query('select email, pass_hash from auth.users where id = $1', [uidВора])).rows[0];
    assert.deepEqual([u.email, u.pass_hash], [null, null]);
    const s = (await pg.query('select owner, status from public.staff where uid = $1', [uidВора])).rows[0];
    assert.deepEqual([s.owner, s.status], [false, 'pending']);
    assert.equal((await клиент(app, '10.0.0.68').go('POST', '/auth/password/signup', { role: 'staff', name: 'Снова', email: 'boss@gmail.com', password: 'squat-pass-2' })).code, 409, 'занять почту заново нельзя');
  });

  await t.test('кто уже вошёл через Google без почты (её держал самозванец) — почту получает', async () => {
    // так было до исправления: продавец вошёл Google, а его Gmail уже занят аккаунтом по паролю
    const к = клиент(app, '10.0.0.70');
    assert.equal((await к.go('POST', '/auth/password/signup', { role: 'staff', name: 'Вор 2', email: 'seller@gmail.com', password: 'squat-pass-3' })).code, 200);
    await pg.query("insert into auth.users (google_sub, name) values ('g-seller', 'Алишер')");
    const id = (await pg.query("select id from auth.users where google_sub = 'g-seller'")).rows[0].id;
    // Google не подтвердил почту — ничего не забираем
    кто.push({ sub: 'g-seller', email: 'seller@gmail.com', email_verified: false, name: 'Алишер' });
    const п = клиент(app, '10.0.0.2');
    await п.google();
    assert.equal((await п.go('GET', '/api/me')).json.data.email, null);
    assert.equal((await к.go('GET', '/api/me')).json.data.email, 'seller@gmail.com', 'неподтверждённая почта у Google — у аккаунта по паролю ничего не забирают');
    // подтвердил — почта переходит к тому же аккаунту Google
    кто.push({ sub: 'g-seller', email: 'seller@gmail.com', email_verified: true, name: 'Алишер' });
    await п.google();
    const me = (await п.go('GET', '/api/me')).json.data;
    assert.deepEqual([me.id, me.email], [id, 'seller@gmail.com']);
    assert.ok((await pg.query('select email_confirmed_at from auth.users where id = $1', [id])).rows[0].email_confirmed_at);
    assert.equal((await к.go('GET', '/api/me')).code, 401);
  });

  await t.test('прежние входы через Google не изменились', async () => {
    кто.push({ sub: 'g-boss', email: 'boss@gmail.com', email_verified: true, name: 'Гани' });
    const х = клиент(app, '10.0.0.3');
    await х.google();
    assert.equal((await х.go('GET', '/api/me')).json.data.id, uidХозяина, 'тот же Google — та же запись');
    // перенесённый из Supabase: почта подтверждена, google_sub ещё пуст — узнаётся по почте
    const old = (await pg.query("insert into auth.users (email, email_confirmed_at, name) values ('old@gmail.com', now(), 'Старый') returning id")).rows[0].id;
    кто.push({ sub: 'g-old', email: 'old@gmail.com', email_verified: true, name: 'Старый' });
    const с = клиент(app, '10.0.0.4');
    await с.google();
    assert.equal((await с.go('GET', '/api/me')).json.data.id, old);
    // подтверждённую почту у другого аккаунта Google не забираем
    кто.push({ sub: 'g-other', email: 'old@gmail.com', email_verified: true, name: 'Другой' });
    const д = клиент(app, '10.0.0.5');
    await д.google();
    const me = (await д.go('GET', '/api/me')).json.data;
    assert.notEqual(me.id, old);
    assert.equal(me.email, null);
    assert.equal((await с.go('GET', '/api/me')).json.data.email, 'old@gmail.com');
  });

  await pg.close();
});
