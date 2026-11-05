'use strict';
/* Вход по почте и покупатели в самом магазине: backend.js, backend-server.js, customer.js
   и раздел «Покупатели» в app.js.

   Проверяем путь от кнопки до сервера: экран входа предлагает почту и пароль только со
   своим сервером, покупатель после входа видит свой долг, а не склад, хозяин
   подтверждает покупателя в «Команде», а пароль можно задать, войдя через Google. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', '..');
const PGLITE = path.join(root, 'supabase', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const взять = (name) => {
  const m = new RegExp('^function ' + name + '\\(.*\\}$', 'm').exec(src)
    || new RegExp('^function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm').exec(src);
  assert.ok(m, 'в программе не нашлась функция ' + name + ' — тест устарел');
  return m[0];
};

// Браузерный fetch → тот же handle, что слушает сервер; cookie живут в «браузере»
function браузер(app) {
  const jar = {};
  return (url, opt) => {
    opt = opt || {};
    const req = Readable.from(opt.body ? [Buffer.from(opt.body)] : []);
    req.method = opt.method || 'GET';
    req.url = url;
    req.socket = { remoteAddress: '10.1.1.1' };
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
          done({ status: code, ok: code < 300, json: async () => JSON.parse(out) });
        },
      });
    });
  };
}
function клиент(fetch) {
  global.window = global;
  global.fetch = fetch;
  delete require.cache[require.resolve('../../backend-server.js')];
  require('../../backend-server.js');
  return global.skladServerClient('/api');
}

test('переводчик backend-server.js: регистрация, вход и пароль — на своём сервере', async (t) => {
  if (!fs.existsSync(PGLITE)) { t.skip('нет PGlite: cd supabase && npm install'); return; }
  const { PGlite } = await import(pathToFileURL(PGLITE).href);
  const { migrate } = require('../../server/migrate');
  const { createApp } = require('../../server/app');
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
  const app = createApp({ db, publicUrl: 'https://skladgo.vercel.app', googleId: 'x', googleSecret: 'y', log() {} });

  const sb = клиент(браузер(app));
  const up = await sb.auth.signUp({ role: 'customer', name: 'Фируз', phone: '90 111 22 33', email: 'f@test.tj', password: 'parol-123' });
  assert.equal(up.error, null, JSON.stringify(up.error));
  const s = (await sb.auth.getSession()).data.session;
  assert.deepEqual([s.user.kind, s.user.has_password, s.user.email], ['customer', true, 'f@test.tj']);
  assert.equal((await sb.rpc('my_debt')).data.status, 'pending');

  const чужой = клиент(браузер(app));
  const bad = await чужой.auth.signInWithPassword({ email: 'f@test.tj', password: 'не тот пароль' });
  assert.equal(bad.error.message, 'Неверная почта или пароль');
  assert.equal((await чужой.auth.getSession()).data.session, null);
  assert.equal((await чужой.auth.signInWithPassword({ email: 'f@test.tj', password: 'parol-123' })).error, null);
  assert.equal((await чужой.auth.getSession()).data.session.user.kind, 'customer');

  // вошедший через Google задаёт пароль
  const uid = '11111111-1111-1111-1111-111111111111', token = crypto.randomBytes(16).toString('hex');
  await pg.query("insert into auth.users (id, email, email_confirmed_at, google_sub, name) values ($1, 'g@test.tj', now(), 'g1', 'Гани')", [uid]);
  await pg.query("insert into srv.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [crypto.createHash('sha256').update(token).digest('hex'), uid]);
  const f = браузер(app);
  const g = клиент((url, opt) => { opt = opt || {}; opt.headers = Object.assign({ cookie: 'sg_s=' + token }, opt.headers); return f(url, opt); });
  assert.equal((await g.auth.getSession()).data.session.user.has_password, false);
  assert.equal((await g.auth.setPassword('owner-pass-1')).error, null);
  assert.equal((await g.auth.getSession()).data.session.user.has_password, true);
  await pg.close();
});

test('экран покупателя: долг, срок, история; до подтверждения — ожидание', () => {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', onclick: null });
  global.window = global;
  global.document = { getElementById: el };
  delete require.cache[require.resolve('../../customer.js')];
  require('../../customer.js');
  const C = global.SkladCustomer;
  const day = 864e5, now = Date.now(), iso = (d) => new Date(now + d * day).toISOString().slice(0, 10);
  const r = C.summarize([
    { type: 'give', amt: 450, t: now - 12 * day, due: iso(-4), note: 'Куртка' },
    { type: 'get', amt: '150', t: now - 5 * day, note: 'Частично' },
  ]);
  assert.equal(r.balance, 300, 'суммы с сервера бывают строкой — считаются как числа');
  assert.equal(r.late, iso(-4));
  let вышел = 0;
  C.render({ name: 'Фируз', status: 'active', biz: 'Магазин Ганӣ', ownerPhone: '+992900097337', person: { name: 'Фируз' }, ops: r.ops }, { logout: () => вышел++, refresh() {} });
  const h = els.auth.innerHTML;
  assert.match(h, /Ваш долг магазину/);
  assert.match(h, /300 сом/);
  assert.match(h, /Срок возврата прошёл/);
  assert.match(h, /href="tel:\+992900097337"/);
  assert.match(h, /<span data-notr>Куртка<\/span>/, 'заметки не переводятся');
  els.cuLo.onclick();
  assert.equal(вышел, 1);
  C.render({ name: '<b>x</b>', status: 'pending', biz: 'Магазин', ops: [] }, { logout() {}, refresh() {} });
  assert.match(els.auth.innerHTML, /ещё не подтвердил/);
  assert.doesNotMatch(els.auth.innerHTML, /<b>x<\/b>/, 'имя экранируется');
  assert.ok(els.cuRf, 'есть «Проверить снова»');
});

test('«Покупатели» у хозяина: подсказка по телефону, подтвердить можно только выбрав человека', () => {
  const html = [], тосты = [], вызовы = [];
  const els = {};
  const $ = (id) => els[id] || (els[id] = { value: '' });
  const D = { people: [{ id: 'p1', name: 'Фируз', phone: '+992901112233' }, { id: 'p2', name: 'Мадина', phone: '+992937778899' }] };
  const custList = [
    { uid: 'u1', name: 'Фируз', phone: '+992 90 111 22 33', status: 'pending' },
    { uid: 'u2', name: 'Мадина', phone: '+992937778899', status: 'active', pid: 'p2' },
  ];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const phd = new Function(взять('phd') + ' return phd;')();
  const custHtml = new Function('custList', 'D', 'esc', 'phd', взять('custHtml') + ' return custHtml;')(custList, D, esc, phd);
  const h = custHtml();
  assert.match(h, /Покупатели \(2\)/);
  assert.match(h, /<option value="p1" selected>/, 'телефон совпал — человек выбран сам');
  assert.match(h, /Телефон совпал с «<span data-notr>Фируз<\/span>»/);
  assert.match(h, /видит долги: <span data-notr>Мадина<\/span>/);
  const btn = {};
  const document = { querySelectorAll: (q) => (q === '[data-ca]' ? [btn] : []) };
  btn.dataset = { ca: 'u1' };
  const custBind = new Function('document', 'custList', '$', 'toast', 'custSet', 'logAct', взять('custBind') + ' return custBind;')(
    document, custList, $, (m) => тосты.push(m), (uid, ch, done) => { вызовы.push([uid, ch]); done(); }, (t) => html.push(t));
  custBind();
  $('cs_u1').value = '';
  btn.onclick();
  assert.deepEqual(вызовы, [], 'без выбора человека не подтверждаем');
  assert.match(тосты[0], /Выберите, чьи это долги/);
  $('cs_u1').value = 'p1';
  btn.onclick();
  assert.deepEqual(вызовы, [['u1', { status: 'active', pid: 'p1' }]]);
  assert.deepEqual(html, ['подтвердил покупателя: Фируз'], 'в ленте видно, кто подтвердил');
});

test('экран входа: почта и пароль — только со своим сервером; покупатель после входа видит свой долг', async () => {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', textContent: '', value: '', onclick: null, disabled: false, dataset: {} });
  const вызовы = [];
  let показано = null;
  const загрузить = async (cfg, session) => {
    Object.keys(els).forEach((k) => delete els[k]);
    global.window = global;
    global.document = { readyState: 'complete', getElementById: el, addEventListener() {}, body: { appendChild() {} }, createElement: () => ({}), querySelectorAll: () => [] };
    global.location = { search: '', hash: '', pathname: '/', href: 'https://skladgo.vercel.app/', reload() { вызовы.push('reload'); } };
    global.history = { replaceState() {} };
    global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    global.SKLAD_CONFIG = cfg;
    global.SkladCustomer = { render: (s) => { показано = s; } };
    global.skladServerClient = () => ({
      auth: {
        getSession: async () => ({ data: { session }, error: null }),
        onAuthStateChange() {}, signOut: async () => ({}), signInWithOAuth: async () => ({}),
        signInWithPassword: async (o) => { вызовы.push(['in', o.email]); return { data: {}, error: null }; },
        signUp: async (o) => { вызовы.push(['up', o.role]); return { data: {}, error: { message: 'Аккаунт с этой почтой уже есть — войдите' } }; },
        setPassword: async () => ({ data: null, error: null }),
      },
      rpc: async (name) => { вызовы.push(['rpc', name]); return { data: { name: 'Фируз', status: 'active', biz: 'Магазин', owner_phone: '+992900097337', person: { name: 'Фируз' }, ops: [] }, error: null }; },
      channel: () => { const c = { on: () => c, subscribe: () => c }; return c; },
      from() {}, removeChannel() {},
    });
    global.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() {}, signInWithPassword() {} } }) };
    delete require.cache[require.resolve('../../backend.js')];
    require('../../backend.js');
    await new Promise((r) => setTimeout(r, 10));
  };

  await загрузить({ api: '/api' }, null);
  assert.match(els.pwb.innerHTML, /или по почте и паролю/, 'свой сервер — есть вход по почте');
  el('pwe').value = 'f@test.tj'; el('pww').value = 'parol-123';
  await el('pwgo').onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(вызовы.slice(-2), [['in', 'f@test.tj'], 'reload'], 'вошёл — перезапуск с входом');

  await загрузить({ url: 'https://example.supabase.co', anonKey: 'k' }, null);
  assert.equal(els.pwb.innerHTML, '', 'с Supabase вход по почте не предлагаем');

  await загрузить({ api: '/api' }, { user: { id: 'u1', email: 'f@test.tj', kind: 'customer', user_metadata: {} } });
  assert.ok(вызовы.some((v) => Array.isArray(v) && v[1] === 'my_debt'), 'покупателю — его долг с сервера');
  assert.deepEqual([показано.name, показано.status, показано.ownerPhone], ['Фируз', 'active', '+992900097337']);
  assert.equal(typeof global.skladAuth.setPassword, 'function');
  delete global.SKLAD_CONFIG; delete global.supabase; delete global.skladServerClient; delete global.SkladCustomer;
});
