'use strict';
/* Тестовый режим (mock.js, адрес с ?mock): вход по почте и паролю как владелец
   магазина или как покупатель. Покупатель видит только свой долг.

   Хозяин: «дай создать аккаунт и войти как владелец и как покупатель, пока на
   тестовых данных». Проверяем то, что потом понадобится и на сервере: пароль не
   хранится, владелец один, неверный пароль не пускает, покупатель без
   подтверждения владельца ничего не видит, а после — только свои записи. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));

function хранилище(start) {
  const store = { ...(start || {}) };
  return {
    store,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
}
function мок() {
  const { store, localStorage } = хранилище();
  const ctx = { localStorage, crypto: globalThis.crypto, TextEncoder, Promise, JSON, Object, Date, Math, Uint8Array };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('mock.js'), ctx);
  return { M: ctx.SkladMock, store };
}

test('регистрация владельца: пароль не хранится, вход сразу', async () => {
  const { M, store } = мок();
  const a = await M.signUp({ role: 'owner', name: 'Гани', phone: '90 009 73 37', email: 'Owner@Test.tj', password: 'secret1' });
  assert.equal(a.status, 'active');
  assert.equal(a.email, 'owner@test.tj', 'почта без разницы в регистре');
  assert.equal(a.phone, '+992900097337');
  assert.equal(M.current().id, a.id, 'после регистрации — уже внутри');
  assert.doesNotMatch(store['skladgo.mock.accounts'], /secret1/, 'пароля в хранилище нет — только отпечаток');
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal('password' in a, false);
});

test('владелец у магазина один; почта не повторяется; короткий пароль и покупатель без телефона — нет', async () => {
  const { M } = мок();
  await M.signUp({ role: 'owner', name: 'Гани', email: 'owner@test.tj', password: 'secret1' });
  await assert.rejects(M.signUp({ role: 'owner', name: 'Вор', email: 'vor@test.tj', password: 'secret1' }), /уже есть владелец/);
  await assert.rejects(M.signUp({ role: 'customer', name: 'Фируз', phone: '901112233', email: 'OWNER@test.tj', password: 'secret1' }), /уже есть — войдите/);
  await assert.rejects(M.signUp({ role: 'customer', name: 'Фируз', phone: '901112233', email: 'f@test.tj', password: '123' }), /не короче 6/);
  await assert.rejects(M.signUp({ role: 'customer', name: 'Фируз', phone: '', email: 'f@test.tj', password: '123456' }), /Впишите телефон/);
  await assert.rejects(M.signUp({ role: 'admin', name: 'Х', email: 'x@test.tj', password: '123456' }), /владелец магазина или покупатель/);
  await assert.rejects(M.signUp({ role: 'customer', name: 'Фируз', phone: '901112233', email: 'не почта', password: '123456' }), /Проверьте почту/);
});

test('вход: верный пароль пускает; неверный и чужая почта — одна и та же ошибка', async () => {
  const { M } = мок();
  const a = await M.signUp({ role: 'owner', name: 'Гани', email: 'owner@test.tj', password: 'secret1' });
  M.logout();
  assert.equal(M.current(), null);
  await assert.rejects(M.login('owner@test.tj', 'secret2'), /^Error: Неверная почта или пароль$/);
  await assert.rejects(M.login('nobody@test.tj', 'secret1'), /^Error: Неверная почта или пароль$/, 'не выдаём, есть ли такой аккаунт');
  assert.equal((await M.login(' OWNER@test.tj ', 'secret1')).id, a.id);
  assert.equal(M.current().id, a.id);
});

test('покупатель: до подтверждения не видит ничего, после — только свои записи', async () => {
  const { M } = мок();
  const day = 864e5, now = Date.now(), iso = (d) => new Date(now + d * day).toISOString().slice(0, 10);
  const D = {
    people: [{ id: 'p1', name: 'Фируз', phone: '+992901112233' }, { id: 'p2', name: 'Мадина', phone: '+992937778899' }],
    ops: [
      { pid: 'p1', type: 'give', amt: 450, t: now - 12 * day, due: iso(-4), note: 'Куртка' },
      { pid: 'p1', type: 'get', amt: 150, t: now - 5 * day, note: 'Частично' },
      { pid: 'p2', type: 'give', amt: 220, t: now - 3 * day, due: iso(7), note: 'Джинсы' },
    ],
  };
  const c = await M.signUp({ role: 'customer', name: 'Фируз', phone: '90 111 22 33', email: 'f@test.tj', password: '123456' });
  assert.equal(c.status, 'pending', 'сам к долгам не привязывается');
  assert.equal(M.customerDebt(c, D), null);
  M.update(c.id, { status: 'active', pid: 'p1' });
  const r = M.customerDebt(M.current(), D);
  assert.equal(r.balance, 300);
  assert.deepEqual(plain(r.ops).map((o) => o.note), ['Частично', 'Куртка'], 'свежие сверху, чужих нет');
  assert.equal(r.late, iso(-4), 'срок прошёл — видно с какого числа');
  M.update(c.id, { status: 'blocked', pid: null });
  assert.equal(M.customerDebt(M.current(), D), null, 'отклонённый — снова ничего');
  const m = await M.signUp({ role: 'customer', name: 'Мадина', phone: '937778899', email: 'm@test.tj', password: '123456' });
  M.update(m.id, { status: 'active', pid: 'p2' });
  const r2 = M.customerDebt(M.current(), D);
  assert.equal(r2.balance, 220);
  assert.equal(r2.next, iso(7), 'срок ещё не наступил — «вернуть до»');
  assert.equal(r2.late, '');
});

function конфиг(host, search, store) {
  const { localStorage, store: s } = хранилище(store);
  const ctx = { location: { hostname: host, search }, localStorage };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('config.js'), ctx);
  return { cfg: plain(ctx.SKLAD_CONFIG), store: s };
}

test('тестовый режим включается только ?mock и никогда — на адресе магазина', () => {
  assert.deepEqual(конфиг('skladgo.vercel.app', '?mock').cfg, { api: '/api' }, 'магазин всегда на настоящем сервере');
  const on = конфиг('127.0.0.1', '?mock');
  assert.deepEqual(on.cfg, { mock: true });
  assert.equal(on.store['skladgo.mockmode'], '1', 'запоминается до выхода из теста');
  assert.deepEqual(конфиг('127.0.0.1', '', { 'skladgo.mockmode': '1' }).cfg, { mock: true });
  const off = конфиг('127.0.0.1', '?mock=off', { 'skladgo.mockmode': '1' });
  assert.deepEqual(off.cfg, { url: '', anonKey: '' }, '?mock=off — обратно демо');
  assert.equal(off.store['skladgo.mockmode'], undefined);
  assert.deepEqual(конфиг('sklad-go-gani26.vercel.app', '?mocking').cfg, { url: '', anonKey: '' }, 'похожее слово не включает');
});

test('в тестовом режиме склад запускается только после входа владельца', async () => {
  const { localStorage } = хранилище({ 'skladgo.me': JSON.stringify({ name: 'Гани', phone: '+992900097337', mail: 'owner@test.tj' }) });
  let запусков = 0;
  const el = () => ({ style: {}, firstChild: {}, dataset: {} });
  const ctx = {
    localStorage, document: { getElementById: el }, location: { search: '', pathname: '/' },
    ME: { name: 'Гани', phone: '+992900097337', mail: 'owner@test.tj' }, staff: [], actList: [], isOwn: false, myId: null, setSt: null, logAct: null,
    toast() {}, render() {}, setTimeout: (f) => f(), Date, JSON,
    SKLAD_MOCK: true,
  };
  ctx.window = ctx;
  ctx.skladLoadJS = () => { запусков++; return Promise.resolve(); };
  ctx.Object = { keys: (o) => Object.keys(o) };
  vm.createContext(ctx);
  vm.runInContext(read('demo.js'), ctx);
  assert.equal(запусков, 0, 'покупателю склад не нужен — только показательные долги');
  assert.ok(ctx.localStorage.getItem('skladgo.debts'), 'долги для проверки покупателя на месте');
  await ctx.skladDemoStart();
  assert.equal(запусков, 1);
  assert.deepEqual(plain(ctx.staff).map((s) => s.name), ['Гани'], 'в команде — владелец, который вошёл');
  assert.match(read('backend.js'), /if \(cfg\.mock\) \{\s*loadJS\('mock\.js'\)/);
});
