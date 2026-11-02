'use strict';
/* Вкладка «Бот» в лёгкой версии (app.js, функция nav).

   Помощник работает через Claude (window.claude). На skladgo.vercel.app его нет,
   а вкладка висела: продавец спрашивал «Сколько стоит весь склад?» и получал
   «Помощник недоступен в этом режиме». Теперь без Claude вкладки нет,
   а нижняя панель делится на столько частей, сколько в ней кнопок.

   Берём настоящую nav() из программы. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const m = /^function nav\(\)\{[\s\S]*?\n\}/m.exec(src);
assert.ok(m, 'в программе не нашлась функция nav — тест устарел');

function панель(window) {
  const els = {};
  const $ = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', children: [] });
  new Function('window', '$', 'NI', 'tab', 'nbadge', 'tabHs', 'history', 'render', 'skipPop',
    m[0] + ' nav();')(window, $, { stock: '', hist: '', debt: '', team: '', bot: '' }, 'stock', () => 0, 0, {}, () => {}, 0);
  return {
    вкладки: [...els.nav.innerHTML.matchAll(/data-t="(\w+)"/g)].map((x) => x[1]),
    колонки: els.nav.style.gridTemplateColumns,
  };
}

test('на обычном сайте, без Claude, вкладки «Бот» нет — и пустого места под неё тоже', () => {
  const п = панель({});
  assert.deepEqual(п.вкладки, ['stock', 'hist', 'debt', 'team']);
  assert.equal(п.колонки, 'repeat(4,1fr)');
});

test('где помощник подключён, вкладка на месте', () => {
  const п = панель({ claude: { use() {} } });
  assert.deepEqual(п.вкладки, ['stock', 'hist', 'debt', 'team', 'bot']);
  assert.equal(п.колонки, 'repeat(5,1fr)');
});

test('NO_BOT по-прежнему выключает бота, даже если Claude есть', () => {
  const п = панель({ claude: { use() {} }, NO_BOT: true });
  assert.ok(!п.вкладки.includes('bot'));
  assert.equal(п.колонки, 'repeat(4,1fr)');
});
