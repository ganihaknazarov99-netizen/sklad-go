'use strict';
/* Тоҷикӣ в лёгкой версии (i18n.js + tg.js).

   Переводчик заменяет на экране известные фразы из словаря: длинные раньше коротких
   и только целыми словами. Здесь — сам перевод: важные экраны переведены целиком,
   «до» не откусывается от «долга», в русском режиме ничего не меняется.
   Что не переводится (поля ввода, списки категорий, заметки) — проверено в браузере. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function загрузить(lang) {
  const store = lang ? { 'skladgo.lang': lang } : {};
  global.window = global;
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true, writable: true });
  global.document = { documentElement: {}, body: null, addEventListener() {} };
  for (const f of ['tg.js', 'i18n.js']) delete require.cache[require.resolve(path.join(__dirname, '..', '..', f))];
  require('../../tg.js');
  require('../../i18n.js');
  return global.trSklad;
}
// Русские слова, которых в таджикском нет: буквы ц, щ, ы, ь — верный признак, что осталось по-русски
const поРусски = (s) => /[цщыьЦЩЫЬ]/.test(s);

test('главные экраны продавца переведены целиком', () => {
  const tr = загрузить('tg');
  const экраны = [
    'Войти через Google',
    'Склад и долги магазина — на всех ваших устройствах. Входите тем же Gmail, что и остальная команда: владелец подтвердит доступ.',
    'Ожидайте подтверждения',
    'Владелец склада должен разрешить вам доступ. Как только он нажмёт «Разрешить», программа откроется сама.',
    'Проверить снова', 'Выйти из аккаунта', 'Регистрация', 'Зарегистрироваться',
    'Склад', 'История', 'Долги', 'Команда',
    'Поиск: название, размер, цвет…',
    'Размеры в пачке — по одной штуке каждого',
    'Закупочная цена — видите только вы',
    '🗑 Удалить всё из архива (3)',
    'Нет в наличии. ＋ — товар вернётся на склад, 🗑 — удалить (вернуть можно внизу «Истории»).',
    '📲 Установить Sklad Go на телефон',
  ];
  for (const s of экраны) {
    const t = tr(s);
    assert.notEqual(t, s, 'не переведено: ' + s);
    assert.ok(!поРусски(t), 'осталось по-русски: ' + t);
  }
});

test('длинная фраза важнее коротких слов внутри неё', () => {
  const tr = загрузить('tg');
  assert.equal(tr('🗑 Удалить всё из архива (3)'), '🗑 Ҳамаро аз бойгонӣ нест кардан (3)');
  assert.equal(tr('Сколько пачек'), 'Чанд баста', 'а не «Сколько баста» по словам');
});

test('только целые слова: «до» не откусывается от «долга», «шт» — от «штуки»', () => {
  const tr = загрузить('tg');
  assert.ok(!tr('долг').startsWith('то'), '«до» внутри слова не тронуто: ' + tr('долг'));
  assert.equal(tr('до 5'), 'то 5', 'а отдельное «до» переводится');
  assert.equal(tr('5 шт'), '5 дона');
  assert.ok(!tr('штука').startsWith('дона'), '«шт» внутри «штука» не трогаем: ' + tr('штука'));
});

test('числа, деньги и эмодзи вокруг перевода сохраняются', () => {
  const tr = загрузить('tg');
  assert.equal(tr('14 шт'), '14 дона');
  assert.equal(tr('− Продал'), '− Фурӯхт');
});

test('по-русски ничего не меняется', () => {
  const tr = загрузить('ru');
  assert.equal(tr('Войти через Google'), 'Войти через Google');
  assert.equal(tr('Склад'), 'Склад');
});

test('язык телефона «tg» включает тоҷикӣ сам', () => {
  const store = {};
  global.window = global;
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem() {} };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'tg-TJ' }, configurable: true, writable: true });
  global.document = { documentElement: {}, body: null, addEventListener() {} };
  delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'i18n.js'))];
  require('../../i18n.js');
  assert.equal(global.SKLAD_LANG, 'tg');
});
