'use strict';
/* Запуск без интернета (корневой backend.js).

   Ключ входа Supabase живёт час. Без связи его не продлить, и Supabase отвечает
   «сессии нет». Раньше на это программа показывала «Войти через Google» — и на
   базаре без связи склад было не открыть вовсе, хотя все данные лежат в телефоне.

   Теперь: телефон уже входил (есть skladgo.uid), а связи нет — открываем склад
   из памяти. Телефон не входил ни разу — без входа нельзя, показываем вход. */
const test = require('node:test');
const assert = require('node:assert/strict');

function загрузить({ getSession, store = {}, onLine }) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', textContent: '', onclick: null });
  const скрипты = [];
  global.window = global;
  global.document = {
    readyState: 'complete', getElementById: el, addEventListener() {},
    body: { appendChild: (s) => скрипты.push(s.src) }, createElement: () => ({}),
  };
  global.location = { search: '', hash: '', pathname: '/', href: 'https://skladgo.vercel.app/' };
  global.history = { replaceState() {} };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true });
  global.SKLAD_CONFIG = { url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' };
  global.supabase = {
    createClient: () => ({
      auth: { getSession, onAuthStateChange() {} },
      from() {}, rpc() {}, channel() {}, removeChannel() {},
    }),
  };
  delete require.cache[require.resolve('../../backend.js')];
  require('../../backend.js');
  return { els, скрипты };
}
const дождаться = () => new Promise((r) => setImmediate(r));
const нетСвязи = () => Promise.resolve({ data: { session: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch' } });
const входПоказан = (els) => /Войти через Google/.test((els.auth && els.auth.innerHTML) || '');

test('телефон уже входил, связи нет — склад открывается из памяти, а не экран входа', async () => {
  const { els, скрипты } = загрузить({ getSession: нетСвязи, store: { 'skladgo.uid': 'u1' }, onLine: undefined });
  await дождаться();
  assert.ok(!входПоказан(els), 'без связи не просим войти заново');
  assert.ok(скрипты.includes('app.js'), 'программа запущена');
});

test('то же, если телефон сам говорит «нет сети»', async () => {
  const { els, скрипты } = загрузить({ getSession: () => Promise.resolve({ data: { session: null } }), store: { 'skladgo.uid': 'u1' }, onLine: false });
  await дождаться();
  assert.ok(!входПоказан(els));
  assert.ok(скрипты.includes('app.js'));
});

test('телефон ни разу не входил — без связи всё равно нужен вход', async () => {
  const { els, скрипты } = загрузить({ getSession: нетСвязи, store: {}, onLine: false });
  await дождаться();
  assert.ok(входПоказан(els), 'чужому телефону склад без входа не открываем');
  assert.ok(!скрипты.includes('app.js'));
});

test('связь есть, просто вышли из аккаунта — экран входа, как раньше', async () => {
  const { els, скрипты } = загрузить({ getSession: () => Promise.resolve({ data: { session: null } }), store: { 'skladgo.uid': 'u1' }, onLine: true });
  await дождаться();
  assert.ok(входПоказан(els), 'выход из аккаунта — это выход, а не «нет связи»');
  assert.ok(!скрипты.includes('app.js'));
});
