'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function словарь(файл) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', файл), 'utf8');
  return JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
}
const СЛОВАРИ = { 'таджикского': словарь('tg.js'), 'английского': словарь('en.js') };
const D = СЛОВАРИ['таджикского'];

// Переводчик ищет надпись от первой до последней русской буквы: знаки, эмодзи и вставленные
// числа по краям он сохраняет сам. Ключ со знаком на краю никогда не найдётся — и когда-то
// два десятка таких ключей молча оставляли экран наполовину русским.
const ЯДРО = /^([\s\S]*?)([А-Яа-яЁё][\s\S]*[А-Яа-яЁё]|[А-Яа-яЁё])([\s\S]*)$/;

for (const [язык, С] of Object.entries(СЛОВАРИ)) {
  test('словарь ' + язык + ': все переводы непустые и безопасные для вставки в HTML', () => {
    const keys = Object.keys(С);
    assert.ok(keys.length > 400, 'переводов меньше ожидаемого: ' + keys.length);
    for (const k of keys) {
      const v = С[k];
      assert.ok(typeof v === 'string' && v.trim().length > 0, 'пустой перевод: ' + k);
      if (k.indexOf('">') < 0) assert.ok(!/["<>]/.test(v), 'в переводе недопустимые символы: ' + k);
    }
  });

  test('словарь ' + язык + ': каждый ключ такой, какой программа действительно ищет', () => {
    for (const k of Object.keys(С)) {
      const m = ЯДРО.exec(k);
      assert.ok(m, 'в ключе нет русских букв, он не найдётся: ' + JSON.stringify(k));
      assert.equal(m[2], k, 'ключ со знаком на краю никогда не совпадёт, нужно ' + JSON.stringify(m[2]) + ' вместо ' + JSON.stringify(k));
    }
  });
}

test('оба словаря переводят одно и то же: ни одной надписи только на одном языке', () => {
  const tg = Object.keys(СЛОВАРИ['таджикского']).sort();
  const en = Object.keys(СЛОВАРИ['английского']).sort();
  const нетEn = tg.filter((k) => !(k in СЛОВАРИ['английского']));
  const нетTg = en.filter((k) => !(k in СЛОВАРИ['таджикского']));
  assert.deepEqual(нетEn, [], 'есть по-таджикски, нет по-английски');
  assert.deepEqual(нетTg, [], 'есть по-английски, нет по-таджикски');
});

test('английский словарь не оставляет русских слов в переводе', () => {
  const EN = СЛОВАРИ['английского'];
  const свои = { 'Русский': 1, 'Тоҷик': 1, 'шт">шт': 1, 'пачка">пачка': 1 };   // названия языков и коды единиц — так и задумано
  for (const k of Object.keys(EN)) {
    if (свои[k]) continue;
    assert.ok(!/[А-Яа-яЁё]/.test(EN[k]), 'русские буквы в английском переводе: ' + k + ' → ' + EN[k]);
  }
});

test('словарь покрывает надписи, которые программа показывает (основные экраны)', () => {
  const must = ['Склад', 'История', 'Долги', 'Команда', 'Привёз', 'Продал', 'продал', 'привёз', 'Сохранить', 'Удалить', 'Отмена', 'Войти',
    'Зарегистрироваться', 'Пароль', 'Мне должны', 'Я должен', 'Погасить', 'Ожидайте подтверждения', 'Нет связи с сервером', 'Неверная почта или пароль'];
  for (const [язык, С] of Object.entries(СЛОВАРИ)) for (const k of must) assert.ok(С[k], 'нет перевода ' + язык + ': ' + k);
});

function загрузить(язык, словарь) {
  global.window = {};
  global.window['SKLAD_' + язык.toUpperCase()] = словарь;
  global.document = { documentElement: {}, body: null, addEventListener() {} };
  global.localStorage = { getItem: (k) => (k === 'skladgo.lang' ? язык : null), setItem() {} };
  Object.defineProperty(global, 'navigator', { value: { language: 'ru' }, configurable: true });
  global.location = { reload() {} };
  global.MutationObserver = class { observe() {} };
  global.Intl = Intl;
  delete require.cache[require.resolve('../../frontend/i18n.js')];
  require('../../frontend/i18n.js');
  return global.window;
}

test('i18n.js: переводит с сохранением знаков, эмодзи и вставленных данных', () => {
  const w = загрузить('tg', D);
  const T = w.T;
  assert.equal(T('⚠️ Не удалось изменить доступ'), '⚠️ ' + D['Не удалось изменить доступ']);
  assert.equal(T('Добавлено позиций: '), D['Добавлено позиций'] + ': ');
  assert.equal(T('<button class="go">Сохранить</button>'), '<button class="go">' + D['Сохранить'] + '</button>');
  assert.equal(T('<input placeholder="Имя клиента" id="x">'), '<input placeholder="' + D['Имя клиента'] + '" id="x">');
  assert.equal(T('Неизвестная фраза'), 'Неизвестная фраза'); // нет перевода — остаётся русский
  assert.equal(T('123'), '123');
});

test('i18n.js: английский берётся из своего словаря, русский остаётся как есть', () => {
  const EN = СЛОВАРИ['английского'];
  let w = загрузить('en', EN);
  assert.equal(w.SKLAD_LANG, 'en');
  assert.equal(w.T('Склад'), EN['Склад']);
  assert.equal(w.T('⚠️ Нет связи с сервером'), '⚠️ ' + EN['Нет связи с сервером']);
  assert.equal(w.SKLAD_LOC, 'en-GB', 'даты должны читаться по-английски');

  w = загрузить('ru', null);
  assert.equal(w.SKLAD_LANG, 'ru');
  assert.equal(w.T('Склад'), 'Склад', 'по-русски переводить нечего');
});

test('i18n.js: незнакомый язык не ломает программу, остаётся русский', () => {
  global.window = {};
  global.document = { documentElement: {}, body: null, addEventListener() {} };
  global.localStorage = { getItem: () => 'xx', setItem() {} };
  Object.defineProperty(global, 'navigator', { value: { language: 'xx' }, configurable: true });
  global.location = { reload() {} };
  global.MutationObserver = class { observe() {} };
  global.Intl = Intl;
  delete require.cache[require.resolve('../../frontend/i18n.js')];
  require('../../frontend/i18n.js');
  assert.equal(global.window.SKLAD_LANG, 'ru');
  assert.equal(global.window.T('Склад'), 'Склад');
});
