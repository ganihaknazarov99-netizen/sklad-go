'use strict';
/* «Покупатели» у хозяина (корневой app.js, custHtml): телефон, который покупатель вписал
   при регистрации, никто не проверял.

   Было: экран сам выбирал человека из «Долгов» с тем же номером и писал зелёное
   «✓ Телефон совпал». Любой, кто зарегистрировался с чужим номером, после одного нажатия
   хозяина «Подтвердить» видел чужие долги.

   Теперь человек не выбран, пока хозяин не выберет сам, а рядом — спокойное
   «Телефон не проверен — позвоните покупателю» (по-русски и по-таджикски). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const взять = (name) => {
  const m = new RegExp('^function ' + name + '\\(.*\\}$', 'm').exec(src)
    || new RegExp('^function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm').exec(src);
  assert.ok(m, 'в программе не нашлась функция ' + name + ' — тест устарел');
  return m[0];
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const НАДПИСЬ = 'Телефон не проверен — позвоните покупателю';

function экран(custList, D) {
  return new Function('custList', 'D', 'esc', взять('custHtml') + ' return custHtml;')(custList, D, esc)();
}

test('покупатель вписал номер должника — человек сам не выбран и «совпал» не написано', () => {
  const D = { people: [{ id: 'p1', name: 'Фируз', phone: '+992901112233' }, { id: 'p2', name: 'Мадина', phone: '+992937778899' }] };
  // Чужой человек зарегистрировался с номером Фируза (номер никто не проверял)
  const h = экран([{ uid: 'x1', name: 'Фируз', phone: '+992 90 111 22 33', status: 'pending' }], D);
  assert.doesNotMatch(h, /selected/, 'ничего не выбрано заранее');
  assert.match(h, /<option value="">Чьи это долги\? — выберите человека<\/option>/, 'первым — «выберите человека»');
  assert.doesNotMatch(h, /совпал/i, 'никакого «совпал»');
  assert.doesNotMatch(h, /var\(--in\)/, 'и никакого зелёного «всё хорошо»');
  assert.ok(h.includes(НАДПИСЬ), 'спокойная надпись: телефон не проверен');
  assert.match(h, /<option value="p1">Фируз · \+992901112233<\/option>/, 'хозяин видит номера и выбирает сам');
});

test('номер ни с кем не совпал — та же надпись: проверка всегда одна — звонок', () => {
  const D = { people: [{ id: 'p1', name: 'Фируз', phone: '+992901112233' }] };
  const h = экран([{ uid: 'x2', name: 'Нигина', phone: '+992555000111', status: 'pending' }], D);
  assert.ok(h.includes(НАДПИСЬ));
  assert.doesNotMatch(h, /selected/);
});

test('новая надпись и сообщение экрана входа есть по-таджикски', () => {
  global.window = global;
  delete require.cache[require.resolve(path.join(ROOT, 'tg.js'))];
  require(path.join(ROOT, 'tg.js'));
  const TG = global.SKLAD_TG;
  for (const s of [НАДПИСЬ, 'Вход закрыт на другом устройстве. Войдите снова тем же аккаунтом — несохранённое на этом телефоне отправится само']) {
    assert.ok(TG[s], 'нет перевода: ' + s);
    assert.ok(!/[цщыьЦЩЫЬ]/.test(TG[s]), 'осталось по-русски: ' + TG[s]);
    assert.notEqual(TG[s], s);
  }
  // Словарь находит только фразу целиком — в программе она должна быть ровно такой
  assert.ok(src.includes(НАДПИСЬ));
  assert.ok(fs.readFileSync(path.join(ROOT, 'backend.js'), 'utf8').includes('Вход закрыт на другом устройстве. Войдите снова тем же аккаунтом — несохранённое на этом телефоне отправится само'));
  assert.ok(!('Телефон совпал с' in TG), 'старой надписи «совпал» больше нет');
});
