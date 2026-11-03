'use strict';
/* Прибыль (app.js: cpOf, cfOf, profit).

   Хозяин хочет видеть не только «продано на сумму», а сколько заработал:
   выручка минус закупка. Закупочные цены лежат отдельно (документ 'costs'),
   база отдаёт их только хозяину — это проверяет supabase/proverka.mjs, раздел 22.

   Здесь — сам расчёт. Берём настоящие функции из программы. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const взять = (name) => {
  const m = new RegExp('^function ' + name + '\\(.*\\}$', 'm').exec(src)
    || new RegExp('^function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm').exec(src);
  assert.ok(m, 'в программе не нашлась функция ' + name + ' — тест устарел');
  return m[0];
};

function программа({ items, costs, owner = true }) {
  return new Function('S', 'CP', 'isOwn',
    ['uOf', 'pcs', 'find', 'cpOf', 'cfOf', 'profit', 'profTxt'].map(взять).join('\n') + ' return { cfOf, profit, profTxt };',
  )({ items }, costs, owner);
}
const продажа = (id, qty, sum) => ({ type: 'out', id, qty, sum });

test('прибыль — выручка минус закупка', () => {
  const p = программа({ items: [{ id: 'a', qty: 5, price: 40 }], costs: { a: 25 } });
  const r = p.profit([продажа('a', 2, 80), продажа('a', 1, 40)]);
  assert.equal(r.rev, 120);
  assert.equal(r.cost, 75);
  assert.equal(r.p, 45);
  assert.equal(r.miss, 0);
});

test('приход и пересчёт в прибыль не идут — только продажи', () => {
  const p = программа({ items: [{ id: 'a', qty: 5, price: 40 }], costs: { a: 25 } });
  const r = p.profit([{ type: 'in', id: 'a', qty: 10, sum: 0 }, { type: 'fix', id: 'a', qty: -1, sum: 0 }, продажа('a', 1, 40)]);
  assert.equal(r.p, 15);
});

test('товар без закупочной цены не выдумывает прибыль — его продажи сосчитаны отдельно', () => {
  const p = программа({ items: [{ id: 'a', qty: 5 }, { id: 'b', qty: 5 }], costs: { a: 25 } });
  const r = p.profit([продажа('a', 1, 40), продажа('b', 3, 300)]);
  assert.equal(r.p, 15, 'продажа без закупки не считается чистой прибылью');
  assert.equal(r.miss, 1);
  assert.match(p.profTxt(r), /без закупки: 1/);
});

test('пачка с ценой за штуку: закупка тоже за штуку, пачка = штук × цена', () => {
  // в пачке S, M, L, XL — 4 шт; купили по 25, продаём по 40 за штуку → с пачки 60
  const p = программа({ items: [{ id: 'p', qty: 3, u: 'пачка', pk: [4, 4], pb: 'piece', price: 40 }], costs: { p: 25 } });
  assert.equal(p.cfOf({ id: 'p', u: 'пачка', pk: [4, 4], pb: 'piece' }), 100, 'закупка пачки — 4 × 25');
  const r = p.profit([продажа('p', 2, 320)]);   // 2 пачки × 4 шт × 40
  assert.equal(r.p, 120);
});

test('пачка с ценой за пачку — закупка тоже за пачку', () => {
  const p = программа({ items: [{ id: 'd', qty: 5, u: 'пачка', pk: [4, 4], pb: 'pack', price: 100 }], costs: { d: 70 } });
  assert.equal(p.profit([продажа('d', 1, 100)]).p, 30);
});

test('продавцу закупка не видна, даже если что-то осталось в памяти телефона', () => {
  const p = программа({ items: [{ id: 'a', qty: 5 }], costs: { a: 25 }, owner: false });
  assert.equal(p.cfOf({ id: 'a' }), 0);
  assert.equal(p.profit([продажа('a', 1, 40)]).p, 0);
});
