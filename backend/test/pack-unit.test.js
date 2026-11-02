'use strict';
/* Пачка в форме товара (app.js, функция unitBlock).

   Хозяин: «в одной пачке 4 или 5 размеров, учёт — пачками, а цена — за штуку».
   Раньше в форме нового товара был выбор «Цена указана за: 1 штуку / 1 пачку»,
   и пробные товары легли с ценой за пачку. Теперь у нового товара цена всегда
   за штуку. Выбор остаётся только при изменении товара и когда копируют товар,
   у которого цена уже за пачку, — иначе его цена молча стала бы ценой за штуку.

   Сама форма (размеры → одна пачка на цвет) проверена в браузере: там нужен DOM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const m = /^function unitBlock\(.*\}$/m.exec(src);
assert.ok(m, 'в программе не нашлась функция unitBlock — тест устарел');
const unitBlock = new Function(m[0] + ' return unitBlock;')();
const выборЦены = (h) => /data-b="pack"/.test(h);

test('новый товар в пачках: цена только за штуку, выбора «за пачку» нет', () => {
  const h = unitBlock('f', 'пачка', null, undefined, true);
  assert.ok(!выборЦены(h), 'в форме нового товара не должно быть «1 пачку»');
  assert.match(h, /id="fpn"/, 'есть место для «В пачке N шт: …»');
  assert.match(h, /id="fkk"/, '«от и до» можно спрятать, когда штук в пачке задают размеры');
});

test('копия товара, у которого цена уже за пачку, — выбор виден и стоит на «1 пачку»', () => {
  const h = unitBlock('f', 'пачка', [4, 4], 'pack', true);
  assert.ok(выборЦены(h));
  assert.match(h, /class="chip on" data-b="pack"/);
});

test('изменение товара — выбор на месте, как раньше', () => {
  assert.ok(выборЦены(unitBlock('f', 'пачка', [4, 5], 'piece')));
  assert.ok(выборЦены(unitBlock('g', 'пачка', [4, 5], 'pack')));
});

test('штучный товар: блок пачки скрыт', () => {
  assert.match(unitBlock('f', 'шт', null, undefined, true), /id="fpb" style="display:none"/);
});
