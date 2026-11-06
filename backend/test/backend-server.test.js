'use strict';
/* Склад на своём сервере (backend-server.js ↔ server/app.js) — от кнопки до базы.

   backend.js разговаривает с сервером теми же словами, что и с Supabase. Проверяем, что
   перевод верный: склад читается и пишется, столкновение версий и отказ охраны долгов
   приходят теми же кодами, сервер недоступен — это «нет связи» (данные остаются на
   телефоне), а вход ведёт на сервер, а не в Supabase. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const PGLITE = path.join(__dirname, '..', '..', 'supabase', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
const { migrate } = require('../../server/migrate');
const { createApp } = require('../../server/app');
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

// fetch браузера → тот же handle, что слушает http.createServer. Cookie живут в «браузере»
function браузер(app) {
  const jar = {};
  const fetch = (url, opt) => {
    opt = opt || {};
    const req = Readable.from(opt.body ? [Buffer.from(opt.body)] : []);
    req.method = opt.method || 'GET';
    req.url = url;
    req.headers = { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), origin: 'https://skladgo.vercel.app' };
    Object.entries(opt.headers || {}).forEach(([k, v]) => { req.headers[k.toLowerCase()] = v; });
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
          done({ status: code, ok: code < 300, headers: h, json: async () => JSON.parse(out) });
        },
      });
    });
  };
  return { fetch, jar };
}

function клиент(fetch) {
  global.window = global;
  global.fetch = fetch;
  delete require.cache[require.resolve('../../backend-server.js')];
  require('../../backend-server.js');
  return global.skladServerClient('/api');
}

test('склад на своём сервере: backend-server.js говорит с сервером как с Supabase', async (t) => {
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
  await pg.query("insert into public.settings values ('owner_email', 'boss@gmail.com')");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const app = createApp({
    db, publicUrl: 'https://skladgo.vercel.app', googleId: CLIENT_ID, googleSecret: 's', log() {},
    fetch: async () => ({ ok: true, json: async () => ({ id_token: 'x.' + b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Date.now() / 1000 + 60, sub: 'g1', email: 'boss@gmail.com', email_verified: true, name: 'Хозяин' }) + '.x' }) }),
  });
  const br = браузер(app);
  const sb = клиент(br.fetch);

  await t.test('без входа: сессии нет, но это не «нет связи»', async () => {
    const r = await sb.auth.getSession();
    assert.equal(r.data.session, null);
    assert.equal(r.error, null);
  });

  await t.test('вход ведёт на свой сервер со списком аккаунтов, а не в Supabase', async () => {
    let куда = null;
    global.location = { href: 'https://skladgo.vercel.app/', assign: (u) => { куда = u; } };
    await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'https://skladgo.vercel.app/', queryParams: { prompt: 'select_account' } } });
    assert.equal(куда, '/auth/google?to=%2F&from=https%3A%2F%2Fskladgo.vercel.app', 'сервер знает, на какой адрес вернуть');
    // дальше браузер идёт по перенаправлениям сам
    const g = new URL((await br.fetch(куда)).headers.location);
    assert.equal(g.searchParams.get('prompt'), 'select_account');
    const back = await br.fetch('/auth/callback?code=c&state=' + g.searchParams.get('state'));
    assert.equal(back.headers.location, '/');
    const s = (await sb.auth.getSession()).data.session;
    assert.equal(s.user.email, 'boss@gmail.com');
    assert.equal(s.user.user_metadata.full_name, 'Хозяин', 'имя из Google — для первой формы');
  });

  await t.test('хозяин встаёт в команду, склад пишется и читается', async () => {
    const uid = (await sb.auth.getSession()).data.session.user.id;
    assert.equal((await sb.from('staff').insert({ uid, name: 'Хозяин', phone: '1', mail: 'boss@gmail.com', owner: true, status: 'active', t: 1 })).error, null);
    assert.equal((await sb.rpc('is_owner')).data, true);
    const me = await sb.from('staff').select('*').eq('uid', uid).maybeSingle();
    assert.equal(me.data.owner, true);
    assert.equal((await sb.from('staff').update({ phone: '2' }).eq('uid', uid)).error, null);
    assert.equal((await sb.rpc('doc_set', { p_id: 'main', p_data: { items: [{ id: 'a', name: 'Шапка', qty: 2 }], log: [] }, p_if_match: null })).data, 1);
    const d = await sb.from('docs').select('data,version').eq('id', 'main').maybeSingle();
    assert.equal(d.data.version, 1);
    assert.equal(d.data.data.items[0].name, 'Шапка');
    const c = await sb.rpc('doc_set', { p_id: 'main', p_data: { items: [], log: [] }, p_if_match: 0 });
    assert.match(c.error.message, /version_conflict/, 'столкновение — тем же словом, merge.js сольёт');
    await sb.from('activity').insert({ t: 1, by: 'кто-то', uid: 'x', txt: 'добавил шапку' });
    const a = await sb.from('activity').select('*').order('t', { ascending: false }).limit(100);
    assert.equal(a.data[0].txt, 'добавил шапку');
    assert.equal(a.data[0].by, 'Хозяин');
  });

  await t.test('сервер недоступен — это «нет связи», а не ошибка', async () => {
    const off = клиент(() => Promise.reject(new TypeError('Failed to fetch')));
    const r = await off.rpc('doc_set', { p_id: 'main', p_data: {}, p_if_match: 1 });
    assert.match(r.error.message, /^network/);
    const s = await off.auth.getSession();
    assert.equal(s.data.session, null);
    assert.match(s.error.name + s.error.message, /retryable|network/i, 'backend.js откроет склад из памяти телефона');
    const down = клиент(async () => ({ status: 502, ok: false, json: async () => { throw new Error('html'); } }));
    assert.match((await down.from('docs').select('*').eq('id', 'main').maybeSingle()).error.message, /^network/);
  });

  await t.test('живые обновления: документ перечитывается, только если изменился', async () => {
    const was = global.EventSource;
    let es = null;
    global.EventSource = function (url) { es = this; this.url = url; this.readyState = 1; this.close = () => {}; };
    const live = клиент(br.fetch);
    const got = [];
    let колонка = 0;
    const ch = live.channel('doc-main').on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'id=eq.main' }, (p) => got.push(p.new)).subscribe();
    const ch2 = live.channel('col-staff').on('postgres_changes', { event: '*', schema: 'public', table: 'staff' }, () => колонка++).subscribe();
    assert.equal(es.url, '/api/events');
    const ждать = () => new Promise((r) => setTimeout(r, 30));
    es.onmessage({ data: JSON.stringify({ t: 'docs', id: 'main' }) });
    await ждать();
    assert.equal(got.length, 1);
    assert.equal(got[0].id, 'main', 'backend.js узнаёт документ по new.id');
    es.onmessage({ data: JSON.stringify({ t: 'docs', id: 'main' }) });
    await ждать();
    assert.equal(got.length, 1, 'версия та же — склад целиком не гоняем');
    es.onmessage({ data: JSON.stringify({ t: 'docs', id: 'debts' }) });
    es.onmessage({ data: JSON.stringify({ t: 'staff' }) });
    await ждать();
    assert.equal(got.length, 1, 'чужой документ — не наш сигнал');
    assert.equal(колонка, 1);
    live.removeChannel(ch);
    live.removeChannel(ch2);
    global.EventSource = was;
  });

  await t.test('выход снимает вход на сервере', async () => {
    await sb.auth.signOut();
    assert.equal((await sb.auth.getSession()).data.session, null);
  });

  await pg.close();
});

test('config.js { api } включает свой сервер: экран входа, а не демо', async () => {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', textContent: '', onclick: null, disabled: false });
  global.window = global;
  global.document = { readyState: 'complete', getElementById: el, addEventListener() {}, body: { appendChild() {} }, createElement: () => ({}), querySelectorAll: () => [] };
  let куда = null;
  global.location = { search: '', hash: '', pathname: '/', href: 'https://skladgo.vercel.app/', reload() {}, assign: (u) => { куда = u; } };
  global.history = { replaceState() {} };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.SKLAD_CONFIG = { api: '/api' };
  global.supabase = { createClient() { throw new Error('Supabase больше не нужен'); } };
  global.fetch = async () => ({ status: 401, ok: false, json: async () => ({ error: { code: 'not authenticated', message: 'Нужно войти' } }) });
  delete require.cache[require.resolve('../../backend-server.js')];
  require('../../backend-server.js');
  delete require.cache[require.resolve('../../backend.js')];
  require('../../backend.js');
  await new Promise((r) => setTimeout(r, 10));
  assert.match(els.auth.innerHTML, /id="gin"/, 'экран входа');
  els.gin.onclick.call(els.gin);
  assert.equal(куда, '/auth/google?to=%2F&from=https%3A%2F%2Fskladgo.vercel.app', 'сервер знает, на какой адрес вернуть');
  delete global.SKLAD_CONFIG;
  delete global.supabase;
});
