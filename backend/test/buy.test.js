'use strict';
/* «Что докупить» (корневой app.js: buyLow, buyOut, buyMsg, buyUI).

   Из списка советов: «список „⚠️ Мало" одной кнопкой уходит поставщику в WhatsApp».
   Проверяем, что в список попадает то, что надо докупить, а сообщение поставщику
   понятное: что, какого размера и цвета, сколько — или сколько осталось. */
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
const lab = (i) => i.name + (i.size ? ' · ' + i.size : '') + (i.color ? ' · ' + i.color : '');
const gone = new Function(взять('gone') + ' return gone;')();
const uOf = new Function(взять('uOf') + ' return uOf;')();
const uw = new Function(взять('uw') + ' return uw;')();
const qt = new Function('uw', взять('qt') + ' return qt;')(uw);
const списки = (S) => ({
  buyLow: new Function('S', 'gone', 'lab', взять('buyLow') + ' return buyLow;')(S, gone, lab),
  buyOut: new Function('S', 'gone', взять('buyOut') + ' return buyOut;')(S, gone),
});
const buyMsg = new Function('lab', 'qt', 'uOf', взять('buyMsg') + ' return buyMsg;')(lab, qt, uOf);

test('«мало» — от 1 до 3, самое срочное сверху; закончившиеся — отдельно, свежие сверху', () => {
  const S = { items: [
    { id: 'a', name: 'Куртка', size: 'L', qty: 3 },
    { id: 'b', name: 'Джинсы', size: '32', qty: 1 },
    { id: 'c', name: 'Шапка', qty: 10 },
    { id: 'd', name: 'Шарф', qty: 0, ar: true, ld: 100 },
    { id: 'e', name: 'Перчатки', qty: 0, ar: true, ld: 200 },
    { id: 'f', name: 'Носки', qty: 4 },
  ] };
  const { buyLow, buyOut } = списки(S);
  assert.deepEqual(buyLow().map((i) => i.id), ['b', 'a'], 'меньше всего осталось — первым');
  assert.deepEqual(buyOut().map((i) => i.id), ['e', 'd'], 'недавно закончившиеся — первыми');
});

test('сообщение поставщику: что, какого размера и цвета, сколько; пачки — пачками', () => {
  const t = buyMsg([
    { it: { name: 'Куртка', size: 'L', color: 'Чёрный', qty: 2 }, n: 10 },
    { it: { name: 'Носки', size: 'S, M, L', qty: 1, u: 'пачка' }, n: 5 },
    { it: { name: 'Джинсы', size: '32', qty: 2 }, n: 0 },
    { it: { name: 'Шарф', qty: 0 }, n: 0 },
  ], 'gani korvon');
  assert.equal(t, 'Салом! Нужно докупить:\n'
    + '1. Куртка · L · Чёрный — 10 шт\n'
    + '2. Носки · S, M, L — 5 пачек\n'
    + '3. Джинсы · 32 — осталось 2 шт\n'
    + '4. Шарф — осталось 0 шт\n'
    + '— gani korvon');
  assert.doesNotMatch(buyMsg([{ it: { name: 'Шарф', qty: 1 }, n: 2 }], ''), /—\s*$/, 'без названия магазина — без подписи');
});

test('кнопка «Что докупить» — на вкладке «⚠️ Мало», номер поставщика — только на этом телефоне', () => {
  assert.match(src, /if\(cat==='⚠️ Мало'\)h\+='<button class="go ac" id="buy"/);
  assert.match(src, /if\(\$\('buy'\)\)\$\('buy'\)\.onclick=buyUI;/);
  const ui = взять('buyUI');
  assert.match(ui, /LSS\('skladgo\.sup',ph\|\|null\)/, 'номер запоминается на телефоне, а не в общем складе');
  assert.match(ui, /'https:\/\/wa\.me\/'\+\(ph\|\|''\)/, 'без номера WhatsApp откроет выбор чата');
  assert.match(ui, /logAct\('отправил поставщику/, 'в ленте видно, кто отправил');
  const tg = fs.readFileSync(path.join(__dirname, '..', '..', 'tg.js'), 'utf8');
  assert.match(tg, /"Что докупить": "Чӣ харидан лозим"/, 'продавец-таджик тоже поймёт');
});
