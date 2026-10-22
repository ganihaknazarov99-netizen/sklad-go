'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../frontend/merge.js');

const item = (id, qty, extra) => Object.assign({ id, name: 'Товар ' + id, qty, ar: qty <= 0 }, extra || {});
const op = (t, id, type, qty) => ({ by: 'A', t, type, id, name: 'x', qty, sum: 0, note: '' });
const base = () => ({ items: [item('a', 10)], log: [], cats: ['Одежда'], trash: [], biz: '' });

test('остатки: +5 без интернета и −3 у коллеги дают 12', () => {
  const B = base(), L = base(), R = base();
  L.items[0].qty = 15; L.log = [op(2, 'a', 'in', 5)];
  R.items[0].qty = 7; R.log = [op(1, 'a', 'out', 3)];
  const m = M.mergeMain(B, L, R);
  assert.equal(m.items[0].qty, 12);
  assert.equal(m.log.length, 2);
  assert.equal(m.log[0].t, 2); // новые сверху
});

test('если остаток дошёл до нуля — товар уходит в архив, при пополнении возвращается', () => {
  const B = base(), L = base(), R = base();
  L.items[0].qty = 4; R.items[0].qty = 6;       // −6 и −4 → 0
  assert.equal(M.mergeMain(B, L, R).items[0].ar, true);
  const L2 = base(), R2 = base(); L2.items[0].qty = 12; R2.items[0].qty = 3; // +2 и −7 → 5
  const m2 = M.mergeMain(base(), L2, R2);
  assert.equal(m2.items[0].qty, 5); assert.equal(m2.items[0].ar, false);
});

test('новые товары с обеих сторон сохраняются', () => {
  const B = base(), L = base(), R = base();
  L.items.push(item('y', 3)); R.items.push(item('z', 8));
  const ids = M.mergeMain(B, L, R).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['a', 'y', 'z']);
});

test('удаление: побеждает только если с другой стороны товар не менялся', () => {
  const B = base(), L = base(), R = base();
  L.items = []; // мы удалили
  assert.equal(M.mergeMain(B, L, R).items.length, 0);       // сервер не менял → удалён
  R.items[0].qty = 11;                                       // а сервер менял
  assert.equal(M.mergeMain(B, L, R).items.length, 1);        // → остаётся (правка важнее удаления)
  const L3 = base(), R3 = base(); R3.items = []; L3.items[0].qty = 9; // сервер удалил, мы меняли
  assert.equal(M.mergeMain(base(), L3, R3).items[0].qty, 9);
});

test('разные поля одного товара: переименовал я, цену поменял коллега — оба изменения живут', () => {
  const B = base(), L = base(), R = base();
  L.items[0].name = 'Новая куртка'; R.items[0].price = 150;
  const it = M.mergeMain(B, L, R).items[0];
  assert.equal(it.name, 'Новая куртка'); assert.equal(it.price, 150);
});

test('спор об одном поле: приоритет у наших правок', () => {
  const B = base(), L = base(), R = base();
  L.items[0].name = 'Моё'; R.items[0].name = 'Чужое';
  assert.equal(M.mergeMain(B, L, R).items[0].name, 'Моё');
});

test('без прошлой версии (первое подключение): данные не удваиваются', () => {
  const L = { items: [item('a', 10)], log: [], cats: [], trash: [], biz: '' };
  const R = { items: [item('a', 10), item('b', 2)], log: [], cats: ['Одежда'], trash: [], biz: '' };
  const m = M.mergeMain(null, L, R);
  assert.equal(m.items.find((i) => i.id === 'a').qty, 10);
  assert.equal(m.items.length, 2);
});

test('журнал и категории: объединяются без дублей', () => {
  const B = base(), L = base(), R = base();
  const common = op(1, 'a', 'in', 1);
  B.log = [common]; L.log = [op(3, 'a', 'out', 1), common]; R.log = [op(2, 'a', 'in', 2), common];
  L.cats = ['Одежда', 'Обувь']; R.cats = ['Одежда', 'Сумки'];
  const m = M.mergeMain(B, L, R);
  assert.equal(m.log.length, 3); assert.deepEqual(m.log.map((x) => x.t), [3, 2, 1]);
  assert.deepEqual(m.cats, ['Одежда', 'Обувь', 'Сумки']);
});

test('долги: операции с обеих сторон складываются, баланс не теряется', () => {
  const dop = (id, amt) => ({ id, pid: 'p1', type: 'give', amt, t: 1, at: Number(id.slice(1)) });
  const B = { people: [{ id: 'p1', name: 'Рустам' }], ops: [dop('o1', 100)], trash: [] };
  const L = JSON.parse(JSON.stringify(B)); L.ops.push(dop('o2', 50));
  const R = JSON.parse(JSON.stringify(B)); R.ops.push(dop('o3', 30));
  const m = M.mergeDebts(B, L, R);
  assert.deepEqual(m.ops.map((o) => o.id), ['o1', 'o2', 'o3']);
  assert.equal(m.ops.reduce((s, o) => s + o.amt, 0), 180);
});

test('долги: человек удалён у коллеги, а мы добавили ему операцию — человек остаётся', () => {
  const B = { people: [{ id: 'p1', name: 'Рустам' }], ops: [], trash: [] };
  const L = { people: [{ id: 'p1', name: 'Рустам', phone: '+992900000000' }], ops: [], trash: [] };
  const R = { people: [], ops: [], trash: [] };
  assert.equal(M.mergeDebts(B, L, R).people[0].phone, '+992900000000');
});
