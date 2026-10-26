'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dictSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'tg.js'), 'utf8');
const D = JSON.parse(dictSrc.slice(dictSrc.indexOf('{'), dictSrc.lastIndexOf('}') + 1));

test('словарь таджикского: все переводы непустые и безопасные для вставки в HTML', () => {
  const keys = Object.keys(D);
  assert.ok(keys.length > 400, 'переводов меньше ожидаемого: ' + keys.length);
  for (const k of keys) {
    const v = D[k];
    assert.ok(typeof v === 'string' && v.trim().length > 0, 'пустой перевод: ' + k);
    if (k.indexOf('">') < 0) assert.ok(!/["<>]/.test(v), 'в переводе недопустимые символы: ' + k);
  }
});

test('словарь покрывает надписи, которые программа показывает (основные экраны)', () => {
  const must = ['Склад', 'История', 'Долги', 'Команда', 'Привёз', 'Продал', 'продал', 'привёз', 'Сохранить', 'Удалить', 'Отмена', 'Войти',
    'Зарегистрироваться', 'Пароль', 'Мне должны', 'Я должен', 'Погасить', 'Ожидайте подтверждения', 'Нет связи с сервером', 'Неверная почта или пароль'];
  for (const k of must) assert.ok(D[k], 'нет перевода: ' + k);
});

test('i18n.js: переводит с сохранением знаков, эмодзи и вставленных данных', () => {
  global.window = { SKLAD_TG: D };
  global.document = { documentElement: {}, body: null, addEventListener() {} };
  global.localStorage = { getItem: (k) => (k === 'skladgo.lang' ? 'tg' : null), setItem() {} };
  Object.defineProperty(global, 'navigator', { value: { language: 'ru' }, configurable: true });
  global.location = { reload() {} };
  global.MutationObserver = class { observe() {} };
  global.Intl = Intl;
  delete require.cache[require.resolve('../../frontend/i18n.js')];
  require('../../frontend/i18n.js');
  const T = global.window.T;
  assert.equal(T('⚠️ Не удалось изменить доступ'), '⚠️ ' + D['Не удалось изменить доступ']);
  assert.equal(T('Добавлено позиций: '), D['Добавлено позиций'] + ': ');
  assert.equal(T('<button class="go">Сохранить</button>'), '<button class="go">' + D['Сохранить'] + '</button>');
  assert.equal(T('<input placeholder="Имя клиента" id="x">'), '<input placeholder="' + D['Имя клиента'] + '" id="x">');
  assert.equal(T('Неизвестная фраза'), 'Неизвестная фраза'); // нет перевода — остаётся русский
  assert.equal(T('123'), '123');
});
