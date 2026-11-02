'use strict';
/* Архив и удаление на складе (app.js: gone, tov, cardHtml, delItems).

   Хозяин: «если какой одежды нету — удали; товар заканчивается — убери из
   списка в архив». Продавшийся до нуля и так уходил в архив, но только если
   у него было что-то на складе: заведённый с нулём висел в списке с «0».
   Удалить можно было только из окна товара, кнопкой в самом низу.

   Теперь «нет в наличии» = архив, а в архиве у каждой строки вместо «продал»
   стоит «удалить». Удалённое ложится в «Удалённые товары» — вернуть можно.

   Берём настоящие функции из программы. */
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
const gone = new Function(взять('gone') + ' return gone;')();
const tov = new Function(взять('tov') + ' return tov;')();
const cardHtml = new Function('esc', 'pTxt', взять('cardHtml') + ' return cardHtml;')((s) => String(s), () => '');

test('нет в наличии — значит в архиве, даже если товар завели с нулём', () => {
  assert.equal(gone({ qty: 0, ar: false }), true, 'заведённый с нулём больше не висит в списке');
  assert.equal(gone({ qty: 0, ar: true }), true);
  assert.equal(gone({ qty: -1 }), true);
  assert.equal(gone({}), true, 'без количества — тоже нечего продавать');
  assert.equal(gone({ qty: 3, ar: false }), false);
  assert.equal(gone({ qty: 3, ar: true }), false, 'есть на складе — на складе, что бы ни говорил старый флаг');
});

test('в архиве у строки «удалить» вместо «продал», на складе — как раньше', () => {
  const it = { id: 'a1', name: 'Платье', qty: 0, cat: 'Одежда' };
  const вАрхиве = cardHtml(it, false, true);
  assert.match(вАрхиве, /data-x="a1"/);
  assert.doesNotMatch(вАрхиве, /data-m=/, 'продавать из архива нечего');
  assert.match(вАрхиве, /data-p="a1"/, '＋ возвращает товар на склад');
  const наСкладе = cardHtml({ ...it, qty: 5 }, false, false);
  assert.match(наСкладе, /data-m="a1"/);
  assert.doesNotMatch(наСкладе, /data-x=/, 'на складе случайно не удалить');
});

test('удалённое уходит в «Удалённые товары», а не пропадает', () => {
  const S = { items: [{ id: 'a', name: 'А', qty: 0 }, { id: 'b', name: 'Б', qty: 0 }, { id: 'c', name: 'В', qty: 4 }], trash: [] };
  const лента = [];
  let n = 0;
  const delItems = new Function('S', 'uid', 'ME', 'save', 'logAct', 'toast', 'render', 'lab', 'tov',
    взять('delItems') + ' return delItems;')(S, () => 't' + n++, { name: 'Гани' }, () => {}, (t) => лента.push(t), () => {}, () => {}, (i) => i.name, tov);
  delItems([S.items[0], S.items[1]]);
  assert.deepEqual(S.items.map((i) => i.id), ['c'], 'остался только тот, что в наличии');
  assert.deepEqual(S.trash.map((e) => e.item.name), ['А', 'Б'], 'оба лежат в корзине — их можно вернуть');
  assert.equal(S.trash[0].by, 'Гани');
  assert.deepEqual(лента, ['удалил из архива 2 товара'], 'в ленте видно, кто и сколько удалил');
});

test('«товар» склоняется по числу', () => {
  assert.equal(tov(1), '1 товар');
  assert.equal(tov(3), '3 товара');
  assert.equal(tov(5), '5 товаров');
  assert.equal(tov(11), '11 товаров');
  assert.equal(tov(21), '21 товар');
  assert.equal(tov(104), '104 товара');
});
