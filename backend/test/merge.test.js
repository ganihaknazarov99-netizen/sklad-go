'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../merge.js');

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

/* Слияние, которым пользуются телефоны (корневой merge.js, не frontend/). */
test('остатки: оба прибавили к общей базе — складываются разницы, а не побеждает последний', () => {
  const B = base(), L = base(), R = base();
  L.items[0].qty = 13; R.items[0].qty = 17;   // +3 и +7 от 10
  assert.equal(M.mergeMain(B, L, R).items[0].qty, 20);
});

test('остатки: одинаковое значение с обеих сторон не удваивается', () => {
  const B = base(), L = base(), R = base();
  L.items[0].qty = 7; R.items[0].qty = 7;
  assert.equal(M.mergeMain(B, L, R).items[0].qty, 7);
});

test('удаление и правка: удалили на сервере, а мы меняли цену — товар остаётся с нашей правкой', () => {
  const B = base(), L = base(), R = base();
  R.items = []; L.items[0].price = 99;
  const m = M.mergeMain(B, L, R);
  assert.equal(m.items.length, 1); assert.equal(m.items[0].price, 99);
});

test('удалили на сервере, мы не трогали — товар исчезает', () => {
  const B = base(), L = base(), R = base();
  R.items = [];
  assert.equal(M.mergeMain(B, L, R).items.length, 0);
});

test('название магазина: наше изменение важнее, иначе берётся серверное', () => {
  const B = base(), L = base(), R = base();
  R.biz = 'Сервер';
  assert.equal(M.mergeMain(B, L, R).biz, 'Сервер');
  L.biz = 'Мой';
  assert.equal(M.mergeMain(B, L, R).biz, 'Мой');
});

test('корзина: объединяется, не больше 100 записей', () => {
  const B = base(), L = base(), R = base();
  for (let i = 0; i < 80; i++) L.trash.push({ id: 'l' + i, t: i });
  for (let i = 0; i < 80; i++) R.trash.push({ id: 'r' + i, t: 1000 + i });
  const m = M.mergeMain(B, L, R);
  assert.equal(m.trash.length, 100);
  assert.equal(m.trash[99].id, 'r79', 'остаются самые свежие');
});

const dop = (id, amt, extra) => Object.assign({ id, pid: 'p1', type: 'give', amt, t: Number(id.slice(1)) }, extra || {});
const dbase = () => ({ people: [{ id: 'p1', name: 'Рустам' }], ops: [dop('o1', 100)], trash: [] });
const cp = (x) => JSON.parse(JSON.stringify(x));

test('долги: одна и та же операция с обеих сторон не дублируется', () => {
  const B = dbase(), L = cp(B), R = cp(B);
  L.ops.push(dop('o2', 5)); R.ops.push(dop('o2', 5));
  assert.deepEqual(M.mergeDebts(B, L, R).ops.map((o) => o.id), ['o1', 'o2']);
});

test('долги: без прошлой версии операции объединяются, не удваиваясь', () => {
  const L = dbase(), R = dbase(); R.ops.push(dop('o2', 7));
  const m = M.mergeDebts(null, L, R);
  assert.deepEqual(m.ops.map((o) => o.id), ['o1', 'o2']);
});

test('долги: операция удалена на сервере и не менялась у нас — исчезает', () => {
  const B = dbase(), L = cp(B), R = cp(B); R.ops = [];
  assert.equal(M.mergeDebts(B, L, R).ops.length, 0);
});

test('долги: операции сортируются по времени', () => {
  const B = dbase(), L = cp(B), R = cp(B);
  L.ops.push(dop('o9', 1, { at: 5 })); R.ops.push(dop('o2', 1, { at: 50 }));
  const at = M.mergeDebts(B, L, R).ops.map((o) => o.at || o.t);
  assert.deepEqual(at, at.slice().sort((a, b) => a - b));
});

test('debtsServerWins: записанный долг берётся с сервера, наша правка отбрасывается', () => {
  const R = dbase(); const L = cp(R); L.ops[0].amt = 1;
  const out = M.debtsServerWins(L, R);
  assert.equal(out.ops.find((o) => o.id === 'o1').amt, 100);
});

test('debtsServerWins: наш новый долг, которого на сервере нет, остаётся для повторной отправки', () => {
  const R = dbase(); const L = cp(R); L.ops.push(dop('o2', 30));
  assert.deepEqual(M.debtsServerWins(L, R).ops.map((o) => o.id), ['o1', 'o2']);
});

test('debtsServerWins: долг, пропавший у нас, но есть на сервере, возвращается вместе с человеком', () => {
  const R = dbase(); const L = { people: [], ops: [], trash: [] };
  const out = M.debtsServerWins(L, R);
  assert.deepEqual(out.ops.map((o) => o.id), ['o1']);
  assert.deepEqual(out.people.map((p) => p.id), ['p1']);
});

test('debtsServerWins: долг в корзине сервера не воскрешается в списке', () => {
  const R = { people: [{ id: 'p1', name: 'Рустам' }], ops: [], trash: [{ id: 't1', k: 'op', t: 9, op: dop('o1', 100) }] };
  const L = { people: R.people, ops: [], trash: [] };
  const out = M.debtsServerWins(L, R);
  assert.equal(out.ops.length, 0);
  assert.equal(out.trash.length, 1);
});

test('debtsServerWins: если мы восстановили долг из корзины сервера, корзина не возвращается', () => {
  const R = { people: [{ id: 'p1', name: 'Рустам' }], ops: [], trash: [{ id: 't1', k: 'op', t: 9, op: dop('o1', 100) }] };
  const L = { people: R.people, ops: [dop('o1', 100)], trash: [] };
  const out = M.debtsServerWins(L, R);
  assert.deepEqual(out.ops.map((o) => o.id), ['o1']);
  assert.equal(out.trash.length, 0);
});

test('debtsServerWins: пустые аргументы не ломают', () => {
  assert.deepEqual(M.debtsServerWins(null, null), { people: [], ops: [], trash: [] });
});

test('logServerWins: запись есть на сервере — берём серверную, свои новые остаются, новые сверху', () => {
  const s = op(1, 'a', 'in', 5); s.note = 'сервер';
  const mine = op(1, 'a', 'in', 5); mine.note = 'моя';
  const fresh = op(3, 'a', 'out', 1);
  const out = M.logServerWins([fresh, mine], [s]);
  assert.deepEqual(out.map((x) => x.t), [3, 1]);
  assert.equal(out[1].note, 'сервер');
});
