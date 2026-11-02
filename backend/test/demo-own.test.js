'use strict';
/* Демо для друзей (demo.js): ссылку без магазина друзья открывают как витрину,
   а «Начать свой склад» делает из неё свой склад в браузере.

   Раньше и в своём складе в «Команде» висели показательные Алишер и Нигина
   («ждёт подтверждения»), а в ленте — «Алишер записал долг: Мадина». Человек,
   который только что начал свой склад, видел чужих людей. И «Сбросить» одним
   нажатием стирало его товары.

   Гоняем настоящий demo.js в песочнице: окно, хранилище и кнопки — поддельные. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'demo.js'), 'utf8');
// массивы из песочницы — из другого «мира», для сравнения переводим в обычные
const plain = (x) => JSON.parse(JSON.stringify(x));

async function открыть(хранилище) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, textContent: '', innerHTML: '', dataset: {}, firstChild: { innerHTML: '' }, onclick: null });
  const store = { ...хранилище };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  Object.defineProperty(localStorage, 'keys', { value: () => Object.keys(store) });
  const тосты = [];
  let перезагрузок = 0;
  const ctx = {
    localStorage, document: { getElementById: el }, location: { search: '', pathname: '/', reload: () => { перезагрузок++; }, href: '/' },
    ME: store['skladgo.me'] ? JSON.parse(store['skladgo.me']) : null,
    isOwn: false, myId: null, staff: [], actList: [], setSt: null, logAct: null,
    toast: (m, u) => тосты.push({ m, u: !!u }), render() {}, setTimeout: (f) => f(), Date,
    JSON, Object,
  };
  ctx.window = ctx;
  ctx.window.skladLoadJS = () => Promise.resolve();
  // Object.keys(localStorage) в demo.js перебирает ключи хранилища
  ctx.Object = { keys: (o) => (o === localStorage ? Object.keys(store) : Object.keys(o)) };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  await new Promise((r) => setImmediate(r));
  return { ctx, els, store, тосты, перезагрузки: () => перезагрузок };
}

test('витрина: показательная команда и лента на месте', async () => {
  const { ctx, els, тосты } = await открыть({});
  assert.deepEqual(plain(ctx.staff).map((s) => s.name), ['Ганӣ', 'Алишер', 'Нигина']);
  assert.equal(ctx.actList.length, 3);
  assert.notEqual(els.democlean.style.display, 'none');
  assert.equal(тосты[0].u, false, 'в приветствии нет кнопки «Отменить» — отменять нечего');
});

test('свой склад: в команде только хозяин, лента пустая, вместо «Демо» — «Свой склад»', async () => {
  const { ctx, els } = await открыть({
    'skladgo.demo.v1': '1', 'skladgo.own': '1',
    'skladgo.me': JSON.stringify({ name: 'Фарход', phone: '+992900000000', mail: 'f@gmail.com' }),
  });
  assert.deepEqual(plain(ctx.staff).map((s) => [s.name, s.owner, s.status]), [['Фарход', true, 'active']], 'чужих людей в своём складе нет');
  assert.deepEqual(plain(ctx.actList), [], 'и чужих записей в ленте');
  assert.match(els.demobar.firstChild.innerHTML, /Свой склад/);
  assert.equal(els.democlean.style.display, 'none', '«Начать свой склад» уже нажата');
});

test('«Начать свой склад» помечает склад своим', async () => {
  const { els, store } = await открыть({});
  els.democlean.onclick.call(els.democlean);
  assert.equal(store['skladgo.own'], undefined, 'первое нажатие только переспрашивает');
  els.democlean.onclick.call(els.democlean);
  assert.equal(store['skladgo.own'], '1');
  assert.equal(store['skladgo.v1'], undefined, 'показательных курток в своём складе нет');
});

test('в своём складе «Показать демо» стирает товары только со второго нажатия', async () => {
  const мойСклад = JSON.stringify({ items: [{ id: 'x', name: 'Мой товар', qty: 5 }] });
  const { els, store, перезагрузки } = await открыть({ 'skladgo.demo.v1': '1', 'skladgo.own': '1', 'skladgo.v1': мойСклад, 'skladgo.me': '{"name":"Фарход"}' });
  els.demoreset.onclick.call(els.demoreset);
  assert.equal(store['skladgo.v1'], мойСклад, 'после первого нажатия товары на месте');
  assert.equal(перезагрузки(), 0);
  assert.match(els.demoreset.textContent, /сотрутся/);
  els.demoreset.onclick.call(els.demoreset);
  assert.equal(store['skladgo.v1'], undefined);
  assert.equal(перезагрузки(), 1);
});
