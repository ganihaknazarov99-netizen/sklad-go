'use strict';
/* Экран входа: если у аккаунта включён код из приложения, после верного пароля появляется
   поле для 6 цифр — почта и пароль при этом не теряются (корневой backend.js).
   И переводчик backend-server.js передаёт код серверу. */
const test = require('node:test');
const assert = require('node:assert/strict');

test('после верного пароля — поле для кода; с кодом — вход', async () => {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', textContent: '', value: '', onclick: null, disabled: false, dataset: {}, focus() {} });
  const вызовы = [];
  global.window = global;
  global.document = { readyState: 'complete', getElementById: el, addEventListener() {}, body: { appendChild() {} }, createElement: () => ({}), querySelectorAll: () => [] };
  global.location = { search: '', hash: '', pathname: '/', href: 'https://skladgo.vercel.app/', reload() { вызовы.push('reload'); } };
  global.history = { replaceState() {} };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.SKLAD_CONFIG = { api: '/api' };
  global.skladServerClient = () => ({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange() {}, signOut: async () => ({}), signInWithOAuth: async () => ({}),
      signUp: async () => ({}),
      signInWithPassword: async (o) => {
        вызовы.push(['in', o.email, o.password, o.code]);
        return o.code ? { data: {}, error: null } : { data: null, error: { code: 'need_code', message: 'Введите код из приложения' } };
      },
    },
    rpc: async () => ({}), channel: () => ({ on() { return this; }, subscribe() { return this; } }), from() {}, removeChannel() {},
  });
  delete require.cache[require.resolve('../../backend.js')];
  require('../../backend.js');
  await new Promise((r) => setTimeout(r, 10));
  assert.doesNotMatch(els.pwb.innerHTML, /id="pwc"/, 'сначала поля для кода нет');
  el('pwe').value = 'g@test.tj'; el('pww').value = 'owner-pass-1';
  await el('pwgo').onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(els.pwb.innerHTML, /id="pwc"[^>]*autocomplete="one-time-code"/, 'появилось поле для 6 цифр');
  assert.equal(el('pwe').value, 'g@test.tj', 'почта не потерялась');
  assert.equal(el('pww').value, 'owner-pass-1', 'пароль не потерялся');
  assert.match(els.ae.textContent, /6 цифр/);
  el('pwc').value = '123456';
  await el('pwgo').onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(вызовы.slice(-2), [['in', 'g@test.tj', 'owner-pass-1', '123456'], 'reload']);
  delete global.SKLAD_CONFIG; delete global.skladServerClient;
});

test('переводчик передаёт код и «выйти везде» серверу', async () => {
  const запросы = [];
  global.window = global;
  global.fetch = async (url, o) => { запросы.push([url, o.method, o.body ? JSON.parse(o.body) : null]); return { status: 200, ok: true, json: async () => ({ data: null }) }; };
  delete require.cache[require.resolve('../../backend-server.js')];
  require('../../backend-server.js');
  const sb = global.skladServerClient('/api');
  await sb.auth.signInWithPassword({ email: 'g@test.tj', password: 'p', code: '654321' });
  await sb.auth.totpStart('p');
  await sb.auth.totpConfirm('111111');
  await sb.auth.totpOff('p');
  await sb.auth.logoutAll();
  assert.deepEqual(запросы.map((q) => q[0]), ['/auth/password/login', '/api/totp/start', '/api/totp/confirm', '/api/totp/off', '/api/logout_all']);
  assert.equal(запросы[0][2].code, '654321');
  assert.ok(запросы.every((q) => q[1] === 'POST'));
});
