'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function словарь(файл) {
  // корневой tg.js — это скрипт с комментариями (window.SKLAD_TG = {...}), его выполняем как телефон
  const src = fs.readFileSync(path.join(__dirname, '..', '..', файл), 'utf8');
  const window = {};
  require('node:vm').runInNewContext(src, { window });
  return window.SKLAD_TG;
}
const СЛОВАРИ = { 'таджикского': словарь('tg.js') };   // в корне, который грузят телефоны, только русский и тоҷикӣ
const D = СЛОВАРИ['таджикского'];

// Лёгкий переводчик (корневой i18n.js) ищет ключ в тексте буквально, целым словом: знак на краю
// ключа ему не мешает, а вот пробел по краям или ключ без русских букв никогда не найдётся.
const РУС = /[А-Яа-яЁё]/;

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
      assert.ok(РУС.test(k), 'в ключе нет русских букв, он не найдётся: ' + JSON.stringify(k));
      assert.equal(k, k.trim(), 'пробелы по краям ключа: ' + JSON.stringify(k));
    }
  });
}

test('словарь покрывает надписи, которые программа показывает (основные экраны)', () => {
  const must = ['Склад', 'История', 'Долги', 'Команда', 'Привёз', 'Продал', 'продал', 'привёз', 'Сохранить', 'Удалить', 'Отмена', 'Войти',
    'Зарегистрироваться', 'Пароль', 'Мне должны', 'Я должен', 'Погасить', 'Ожидайте подтверждения', 'Нет связи с сервером', 'Неверная почта или пароль'];
  for (const [язык, С] of Object.entries(СЛОВАРИ)) for (const k of must) assert.ok(С[k], 'нет перевода ' + язык + ': ' + k);
});

// Сам переводчик (i18n.js: языки, знаки и эмодзи вокруг фраз) проверяет i18n-tg.test.js на тех же корневых файлах.
test('i18n.js: знает только русский и тоҷикӣ — английского словаря в корне нет', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'en.js')));
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'i18n.js'), 'utf8'), /ЯЗЫКИ = \{ ru: 1, tg: 1 \}/);
});
