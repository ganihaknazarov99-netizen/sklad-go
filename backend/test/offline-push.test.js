'use strict';
/* Неотправленное с телефона уходит на сервер (корневые app.js и backend.js).

   1. Продали без связи, программу закрыли. Открыли снова — связь есть, а сервер с тех
      пор не менялся (та же версия, что помнит телефон). Раньше программа видела «версия
      та же» и молча ничего не слала: продажа и долг жили только в этом телефоне до
      следующей правки — другие телефоны видели неверный остаток, а при смене аккаунта
      или очистке телефона запись пропадала. Теперь досылает сразу.

   2. Вход закрыли с другого устройства (сменили пароль, «выйти везде»), а в телефоне
      неотправленное. Раньше — «ошибка сохранения» и повтор каждые 15 секунд без конца.
      Теперь — экран входа; данные телефона не стираются и уйдут после входа.

   Программа запускается целиком в vm, сервер поддельный: что и с какой версией он
   получил, видно в «записях». */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const MERGE = fs.readFileSync(path.join(ROOT, 'merge.js'), 'utf8');
const T = 1_700_000_000_000;
const копия = (x) => JSON.parse(JSON.stringify(x));

function элемент() {
  const t = { style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } };
  return new Proxy(t, {
    get(o, k) {
      if (k in o) return o[k];
      if (k === 'innerHTML' || k === 'textContent' || k === 'value') return '';
      if (k === 'querySelectorAll') return () => [];
      if (typeof k === 'string' && /^(querySelector|appendChild|addEventListener|focus|scrollIntoView|setAttribute|removeAttribute|getAttribute|insertAdjacentHTML|remove|closest|getBoundingClientRect|replaceWith)$/.test(k)) return () => (k === 'querySelector' ? null : {});
      return undefined;
    },
    set(o, k, v) { o[k] = v; return true; },
  });
}

// Документ на сервере, как у настоящего: set с чужой версией — version_conflict
function документ(data, version, отказ) {
  const d = { data: копия(data), version, записи: [] };
  d.ref = {
    get: () => Promise.resolve({ exists: true, version: d.version, data: () => копия(d.data) }),
    set: (pl, o) => {
      d.записи.push({ pl: копия(pl), ifMatch: o && o.ifMatch });
      if (отказ) return Promise.reject(отказ);
      if (o && o.ifMatch != null && o.ifMatch !== d.version) return Promise.reject({ code: 'version_conflict', message: 'version_conflict' });
      d.data = копия(pl); d.version++;
      return Promise.resolve({ version: d.version });
    },
    onSnapshot: (cb) => { d.ref.get().then(cb); return () => {}; },
  };
  return d;
}

// Склад и долги, как их помнит телефон: base — что было на сервере в прошлый раз
const товарБыло = { items: [{ id: 'a', name: 'Куртка', qty: 5, ar: false }], log: [], cats: ['Одежда'], trash: [], biz: '' };
const продажа = { by: 'Гани', t: T + 2, type: 'out', id: 'a', name: 'Куртка', qty: 2, sum: 0, note: '' };
const товарСтало = Object.assign(копия(товарБыло), { items: [{ id: 'a', name: 'Куртка', qty: 3, ar: false }], log: [продажа] });
const бахром = { id: 'p1', name: 'Бахром' };
const долгиБыло = { people: [бахром], ops: [{ id: 'o1', pid: 'p1', type: 'give', amt: 100, t: T, at: T, note: '' }], trash: [] };
const новыйДолг = { id: 'o9', pid: 'p1', type: 'give', amt: 70, t: T + 5, at: T + 5, note: 'без связи' };
const долгиСтало = Object.assign(копия(долгиБыло), { ops: долгиБыло.ops.concat([новыйДолг]) });

function память({ склад, долги } = {}) {
  const s = {
    'skladgo.me': JSON.stringify({ name: 'Гани', phone: '+992900000000', mail: 'gani@gmail.com' }),
    'skladgo.v1': JSON.stringify(товарБыло), 'skladgo.base.main': JSON.stringify(товарБыло), 'skladgo.ver.main': '7', 'skladgo.dirty.main': '0',
    'skladgo.debts': JSON.stringify(долгиБыло), 'skladgo.base.debts': JSON.stringify(долгиБыло), 'skladgo.ver.debts': '4', 'skladgo.dirty.debts': '0',
  };
  if (склад) Object.assign(s, { 'skladgo.v1': JSON.stringify(товарСтало), 'skladgo.dirty.main': '1' });
  if (долги) Object.assign(s, { 'skladgo.debts': JSON.stringify(долгиСтало), 'skladgo.dirty.debts': '1' });
  return s;
}

// Запуск программы. Повторы через 15 секунд не ждём — только запоминаем, что программа их поставила
async function запустить({ store, склад, долги, auth }) {
  const els = {}, отложено = [];
  const таймер = (fn, ms) => { if (ms > 1000) { отложено.push(ms); return 0; } return setTimeout(fn, ms); };
  const нигде = { get: () => new Promise(() => {}), set: () => new Promise(() => {}), update: () => new Promise(() => {}), onSnapshot() { return () => {}; } };
  const db = {
    doc: (p) => (p === 'warehouse/main' ? склад.ref : p === 'warehouse/debts' ? долги.ref : нигде),
    collection: () => { const q = { orderBy: () => q, limit: () => q, onSnapshot() { return () => {}; }, add: () => Promise.resolve() }; return q; },
  };
  const ctx = {
    console, setTimeout: таймер, clearTimeout,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: { getElementById: (i) => els[i] || (els[i] = элемент()), addEventListener() {}, createElement: () => элемент(), querySelectorAll: () => [], body: элемент(), hidden: false, documentElement: элемент() },
    navigator: { onLine: true }, history: { pushState() {}, back() {}, replaceState() {} },
    location: { href: 'https://skladgo.com/', reload() {} },
    skladBackend: { db: () => Promise.resolve(db), user: () => Promise.resolve(null) },
    skladAuth: auth,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    addEventListener() {}, scrollTo() {},
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(MERGE, ctx);
  vm.runInContext(APP, ctx);
  await new Promise((r) => setTimeout(r, 700));   // 300 мс — отправка ждёт, вдруг ещё правка
  return { повторы: отложено.filter((ms) => ms === 15000).length, sy: () => ctx.sytxt() };
}

// ---------- 1. Открыли программу с неотправленным, версия на сервере та же ----------

test('склад: продажа без связи уходит при запуске, хотя сервер не менялся (версия 7 = 7)', async () => {
  const store = память({ склад: true });
  const склад = документ(товарБыло, 7), долги = документ(долгиБыло, 4);
  await запустить({ store, склад, долги });
  assert.equal(склад.записи.length, 1, 'ровно одна отправка');
  assert.equal(склад.записи[0].ifMatch, 7, 'с той версией, что помнит телефон');
  assert.equal(склад.записи[0].pl.items[0].qty, 3, 'остаток после продажи');
  assert.equal(склад.записи[0].pl.log.length, 1, 'и сама продажа в истории');
  assert.equal(store['skladgo.dirty.main'], '0', 'отметка «не отправлено» снята');
  assert.equal(store['skladgo.ver.main'], '8');
  assert.equal(долги.записи.length, 0, 'долги не трогали — их и не шлём');
});

test('долги: долг, записанный без связи, уходит при запуске, хотя сервер не менялся (версия 4 = 4)', async () => {
  const store = память({ долги: true });
  const склад = документ(товарБыло, 7), долги = документ(долгиБыло, 4);
  await запустить({ store, склад, долги });
  assert.equal(долги.записи.length, 1, 'ровно одна отправка');
  assert.equal(долги.записи[0].ifMatch, 4);
  assert.deepEqual(долги.записи[0].pl.ops.map((o) => o.id), ['o1', 'o9'], 'новый долг дошёл');
  assert.equal(store['skladgo.dirty.debts'], '0', 'отметка «не отправлено» снята');
  assert.equal(склад.записи.length, 0);
});

test('нечего отправлять — при запуске ничего не шлём', async () => {
  const store = память();
  const склад = документ(товарБыло, 7), долги = документ(долгиБыло, 4);
  const app = await запустить({ store, склад, долги });
  assert.equal(склад.записи.length, 0);
  assert.equal(долги.записи.length, 0);
  assert.match(app.sy(), /сохранено/);
});

test('как и раньше: сервер успел измениться — слияние и одна отправка с новой версией', async () => {
  const store = память({ склад: true, долги: true });
  const чужое = Object.assign(копия(товарБыло), { items: товарБыло.items.concat([{ id: 'b', name: 'Шапка', qty: 4, ar: false }]) });
  const склад = документ(чужое, 8), долги = документ(долгиБыло, 5);
  await запустить({ store, склад, долги });
  assert.equal(склад.записи.length, 1);
  assert.equal(склад.записи[0].ifMatch, 8);
  assert.deepEqual(склад.записи[0].pl.items.map((i) => [i.id, i.qty]), [['a', 3], ['b', 4]], 'своё и чужое вместе');
  assert.equal(долги.записи.length, 1);
  assert.equal(долги.записи[0].ifMatch, 5);
  assert.equal(store['skladgo.dirty.main'], '0');
  assert.equal(store['skladgo.dirty.debts'], '0');
});

// ---------- 2. Вход закрыли с другого устройства ----------

const нужноВойти = { code: 'auth', message: 'Нужно войти' };

test('вход закрыт: экран входа вместо бесконечных повторов, неотправленное остаётся в телефоне', async () => {
  const store = память({ склад: true });
  const склад = документ(товарБыло, 7, нужноВойти), долги = документ(долгиБыло, 4);
  let спросили = 0;
  const app = await запустить({ store, склад, долги, auth: { lost: () => { спросили++; return Promise.resolve(true); } } });
  assert.equal(склад.записи.length, 1, 'одна попытка');
  assert.equal(спросили, 1, 'программа спросила вход');
  assert.equal(app.повторы, 0, 'повторять каждые 15 секунд не стала');
  assert.equal(store['skladgo.dirty.main'], '1', 'отметка «не отправлено» на месте');
  assert.equal(JSON.parse(store['skladgo.v1']).items[0].qty, 3, 'продажа в телефоне цела');
});

test('сервер сказал «нужно войти», а вход на деле жив (или проверить нечем) — просто повторяем', async () => {
  for (const auth of [{ lost: () => Promise.resolve(false) }, undefined]) {
    const store = память({ долги: true });
    const склад = документ(товарБыло, 7), долги = документ(долгиБыло, 4, нужноВойти);
    const app = await запустить({ store, склад, долги, auth });
    assert.equal(app.повторы, 1, 'повтор поставлен');
    assert.equal(store['skladgo.dirty.debts'], '1');
  }
});

test('обычная ошибка или нет связи — повтор, как раньше, экран входа не нужен', async () => {
  for (const отказ of [{ code: 'network', message: 'network' }, { code: 'error', message: 'Ошибка сервера' }]) {
    const store = память({ склад: true });
    const склад = документ(товарБыло, 7, отказ), долги = документ(долгиБыло, 4);
    let спросили = 0;
    const app = await запустить({ store, склад, долги, auth: { lost: () => { спросили++; return Promise.resolve(true); } } });
    assert.equal(спросили, 0);
    assert.equal(app.повторы, 1);
  }
});

// ---------- backend.js со своим сервером: 401 → «auth», экран входа без стирания ----------

function сервер(store, сессия) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', textContent: '', onclick: null, disabled: false });
  const скрипты = [];
  global.window = global;
  global.document = { readyState: 'complete', getElementById: el, addEventListener() {}, body: { appendChild: (s) => скрипты.push(s.src) }, createElement: () => ({}), querySelectorAll: () => [] };
  global.location = { search: '', hash: '', pathname: '/', href: 'https://skladgo.com/', origin: 'https://skladgo.com', reload() {}, assign() {} };
  global.history = { replaceState() {} };
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  Object.keys(store).forEach((k) => Object.defineProperty(global.localStorage, k, { value: store[k], enumerable: true, configurable: true, writable: true }));
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  global.SKLAD_CONFIG = { api: '/api' };
  const ответ = (status, j) => Promise.resolve({ status, ok: status < 300, json: async () => j });
  global.fetch = (url) => {
    if (/\/api\/me$/.test(url)) return сессия.жива ? ответ(200, { data: { id: сессия.uid, email: 'gani@gmail.com', name: 'Гани' } }) : ответ(401, { error: { code: 'not authenticated', message: 'Нужно войти' } });
    if (/\/api\/rpc\/doc_set$/.test(url)) return ответ(401, { error: { code: 'not authenticated', message: 'Нужно войти' } });
    return ответ(200, { data: null });
  };
  for (const f of ['backend-server.js', 'backend.js']) delete require.cache[require.resolve(path.join(ROOT, f))];
  require(path.join(ROOT, 'backend-server.js'));
  require(path.join(ROOT, 'backend.js'));
  return { els, скрипты };
}
const дождаться = () => new Promise((r) => setTimeout(r, 10));

test('backend.js: ответ 401 на запись приходит в программу кодом «auth»', async () => {
  const сессия = { жива: true, uid: 'u1' };
  сервер(память({ склад: true }), сессия);
  await дождаться();
  const db = await window.skladBackend.db();
  assert.ok(db, 'вошли');
  await assert.rejects(db.doc('warehouse/main').set({}, { ifMatch: 7 }), (e) => e.code === 'auth');
});

test('backend.js: вход закрыт — экран входа, данные телефона не стёрты; вход жив — экрана нет', async () => {
  const store = память({ склад: true, долги: true });
  store['skladgo.uid'] = 'u1';
  const сессия = { жива: true, uid: 'u1' };
  const { els } = сервер(store, сессия);
  await дождаться();
  assert.equal(await window.skladAuth.lost(), false, 'вход жив — это не про вход');
  assert.doesNotMatch(els.auth ? els.auth.innerHTML : '', /id="gin"/);

  сессия.жива = false;                                    // «выйти везде» на другом телефоне
  const [a, b] = await Promise.all([window.skladAuth.lost(), window.skladAuth.lost()]);
  assert.equal(a, true);
  assert.equal(b, true, 'склад и долги спросили вместе — экран один');
  assert.match(els.auth.innerHTML, /id="gin"/, 'экран входа');
  assert.match(els.ae.textContent, /Вход закрыт на другом устройстве/);
  assert.equal(els.app.style.display, 'none');
  assert.equal(store['skladgo.dirty.main'], '1', 'неотправленный склад на месте');
  assert.equal(store['skladgo.dirty.debts'], '1', 'неотправленные долги на месте');
  assert.equal(JSON.parse(store['skladgo.v1']).items[0].qty, 3);
  assert.equal(JSON.parse(store['skladgo.debts']).ops.length, 2);
  assert.equal(store['skladgo.uid'], 'u1');
});

test('backend.js: вошёл снова тот же человек — неотправленное не стёрто, программа запускается и дошлёт', async () => {
  const store = память({ склад: true, долги: true });
  store['skladgo.uid'] = 'u1';
  const { скрипты } = сервер(store, { жива: true, uid: 'u1' });
  await дождаться();
  assert.ok(скрипты.includes('app.js'), 'склад запущен');
  assert.equal(store['skladgo.dirty.main'], '1');
  assert.equal(store['skladgo.dirty.debts'], '1');
  assert.equal(JSON.parse(store['skladgo.debts']).ops.length, 2);
  delete global.SKLAD_CONFIG;
});
