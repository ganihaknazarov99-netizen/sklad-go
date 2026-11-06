'use strict';
/* Слияние долгов «телефон ↔ сервер»: корзина побеждает правку (корневой merge.js — тот,
   что грузит телефон).

   Было: на этом телефоне долг удалили в корзину, а на другом в это время поправили его
   заметку. Слияние видело «на сервере запись менялась» и возвращало её в список — а она
   и в корзине. Удалённый долг снова считался в итоге «мне должны».

   Теперь запись в корзине из списка уходит, но правка не теряется: она в записи внутри
   корзины — вернут из корзины, вернётся с новой заметкой. */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../merge.js');

const T = 1_700_000_000_000;
const долг = (id, pid, amt, extra) => Object.assign({ id, pid, type: 'give', amt, t: T, at: T, by: 'Гани', note: '' }, extra || {});
const копия = (x) => JSON.parse(JSON.stringify(x));
const бахром = { id: 'p1', name: 'Бахром', phone: '+992901112233' };
const мадина = { id: 'p2', name: 'Мадина' };
// Баланс человека, как на экране «Долги»: живые записи людей, что есть в списке
const итог = (D) => {
  const есть = new Set(D.people.map((p) => p.id));
  return D.ops.filter((o) => есть.has(o.pid)).reduce((s, o) => s + (o.type === 'give' ? o.amt : -o.amt), 0);
};
const вКорзине = (D) => D.trash.flatMap((e) => (e.k === 'op' ? [e.op] : e.ops || [])).map((o) => o.id);

test('удалили на телефоне, на сервере поправили заметку — долг остаётся удалённым, заметка новая', () => {
  const B = { people: [бахром], ops: [долг('o1', 'p1', 500), долг('o2', 'p1', 100)], trash: [] };
  const L = { people: [бахром], ops: [долг('o2', 'p1', 100)],
    trash: [{ id: 't1', k: 'op', t: T + 9, by: 'Гани', pn: 'Бахром', op: долг('o1', 'p1', 500), person: null }] };
  const R = { people: [бахром], ops: [долг('o1', 'p1', 500, { note: 'отдаст в пятницу' }), долг('o2', 'p1', 100)], trash: [] };
  const m = M.mergeDebts(копия(B), копия(L), копия(R));
  assert.deepEqual(m.ops.map((o) => o.id), ['o2'], 'в списке удалённого нет');
  assert.deepEqual(вКорзине(m), ['o1'], 'он в корзине');
  assert.equal(m.trash[0].op.note, 'отдаст в пятницу', 'правка с сервера не потерялась — она в корзине');
  assert.equal(итог(m), 100, 'удалённый долг в итоге не считается');
});

test('наоборот: удалили на сервере, а мы поправили заметку — тоже остаётся удалённым, с нашей заметкой', () => {
  const B = { people: [бахром], ops: [долг('o1', 'p1', 500), долг('o2', 'p1', 100)], trash: [] };
  const L = { people: [бахром], ops: [долг('o1', 'p1', 500, { note: 'звонил' }), долг('o2', 'p1', 100)], trash: [] };
  const R = { people: [бахром], ops: [долг('o2', 'p1', 100)],
    trash: [{ id: 't1', k: 'op', t: T + 9, by: 'Мадина', pn: 'Бахром', op: долг('o1', 'p1', 500), person: null }] };
  const m = M.mergeDebts(копия(B), копия(L), копия(R));
  assert.deepEqual(m.ops.map((o) => o.id), ['o2']);
  assert.deepEqual(вКорзине(m), ['o1']);
  assert.equal(m.trash[0].op.note, 'звонил');
  assert.equal(итог(m), 100);
});

test('правки с двух сторон в разных полях — в корзине обе', () => {
  const B = { people: [бахром], ops: [долг('o1', 'p1', 500), долг('o2', 'p1', 100)], trash: [] };
  const L = { people: [бахром], ops: [долг('o2', 'p1', 100)],
    trash: [{ id: 't1', k: 'op', t: T + 9, pn: 'Бахром', op: долг('o1', 'p1', 500, { note: 'наша' }), person: null }] };
  const R = { people: [бахром], ops: [долг('o1', 'p1', 500, { due: '2026-12-01' }), долг('o2', 'p1', 100)], trash: [] };
  const m = M.mergeDebts(копия(B), копия(L), копия(R));
  assert.equal(m.trash[0].op.note, 'наша');
  assert.equal(m.trash[0].op.due, '2026-12-01');
  assert.deepEqual(m.ops.map((o) => o.id), ['o2']);
});

test('удалили человека целиком, а на сервере поправили заметку одного его долга — человек и долги удалены', () => {
  const B = { people: [бахром, мадина], ops: [долг('o1', 'p1', 500), долг('o2', 'p1', 100), долг('o3', 'p2', 40)], trash: [] };
  const L = { people: [мадина], ops: [долг('o3', 'p2', 40)],
    trash: [{ id: 't1', k: 'person', t: T + 9, pn: 'Бахром', person: бахром, ops: [долг('o1', 'p1', 500), долг('o2', 'p1', 100)] }] };
  const R = { people: [бахром, мадина], ops: [долг('o1', 'p1', 500, { note: 'новая' }), долг('o2', 'p1', 100), долг('o3', 'p2', 40)], trash: [] };
  const m = M.mergeDebts(копия(B), копия(L), копия(R));
  assert.deepEqual(m.ops.map((o) => o.id), ['o3']);
  assert.deepEqual(m.people.map((p) => p.id), ['p2'], 'Бахром удалён');
  assert.equal(m.trash[0].ops.find((o) => o.id === 'o1').note, 'новая');
  assert.equal(итог(m), 40);
});

test('удалили последний долг человека (он ушёл вместе с ним), а на сервере поправили человека — оба удалены', () => {
  const B = { people: [бахром], ops: [долг('o1', 'p1', 500)], trash: [] };
  const L = { people: [], ops: [], trash: [{ id: 't1', k: 'op', t: T + 9, pn: 'Бахром', op: долг('o1', 'p1', 500), person: бахром }] };
  const R = { people: [Object.assign({}, бахром, { phone: '+992935554433' })], ops: [долг('o1', 'p1', 500, { note: 'x' })], trash: [] };
  const m = M.mergeDebts(копия(B), копия(L), копия(R));
  assert.deepEqual(m.ops, []);
  assert.deepEqual(m.people, [], 'пустой Бахром без долгов в списке не висит');
  assert.equal(m.trash[0].op.note, 'x');
});

test('удалили последний долг человека, а на другом телефоне ему записали новый — человек возвращается с новым долгом', () => {
  const B = { people: [бахром], ops: [долг('o1', 'p1', 500)], trash: [] };
  const L = { people: [], ops: [], trash: [{ id: 't1', k: 'op', t: T + 9, pn: 'Бахром', op: долг('o1', 'p1', 500), person: бахром }] };
  const R = { people: [бахром], ops: [долг('o1', 'p1', 500), долг('o5', 'p1', 70, { t: T + 10, at: T + 10 })], trash: [] };
  const m = M.mergeDebts(копия(B), копия(L), копия(R));
  assert.deepEqual(m.ops.map((o) => o.id), ['o5'], 'новый долг в списке, удалённый — нет');
  assert.deepEqual(m.people.map((p) => p.id), ['p1'], 'человек есть — иначе новый долг не видно');
  assert.equal(итог(m), 70);
  assert.deepEqual(вКорзине(m), ['o1']);
});

test('как и раньше: восстановили из корзины — долг в списке, корзина пуста', () => {
  const t1 = { id: 't1', k: 'op', t: T + 9, pn: 'Бахром', op: долг('o1', 'p1', 500), person: null };
  const B = { people: [бахром], ops: [долг('o2', 'p1', 100)], trash: [t1] };
  const L = { people: [бахром], ops: [долг('o2', 'p1', 100), долг('o1', 'p1', 500)], trash: [] };
  const R = копия(B);
  const m = M.mergeDebts(копия(B), копия(L), R);
  assert.deepEqual(m.ops.map((o) => o.id).sort(), ['o1', 'o2']);
  assert.deepEqual(m.trash, []);
  assert.equal(итог(m), 600);
});

test('как и раньше: никто ничего не удалял — правки с двух сторон сливаются, корзина не трогается', () => {
  const B = { people: [бахром], ops: [долг('o1', 'p1', 500)], trash: [] };
  const L = { people: [бахром], ops: [долг('o1', 'p1', 500), долг('o2', 'p1', 30, { t: T + 1, at: T + 1 })], trash: [] };
  const R = { people: [бахром], ops: [долг('o1', 'p1', 500, { note: 'с сервера' })], trash: [] };
  const m = M.mergeDebts(копия(B), копия(L), копия(R));
  assert.deepEqual(m.ops.map((o) => [o.id, o.note]), [['o1', 'с сервера'], ['o2', '']]);
  assert.deepEqual(m.trash, []);
});
