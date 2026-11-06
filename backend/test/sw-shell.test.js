'use strict';
/* Список файлов для работы без интернета (SHELL в корневом sw.js) должен совпадать с тем, что
   программа реально грузит: нет файла в списке — без сети он не откроется; нет файла на диске —
   cache.addAll падает, и копия на телефоне не ставится вовсе. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const norm = (p) => '/' + p.replace(/^\.?\//, '').replace(/[?#].*$/, '');

const sw = read('sw.js');
const m = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
assert.ok(m, 'в sw.js не нашёлся список SHELL');
const SHELL = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

test('SHELL разобран и не пуст', () => {
  assert.ok(SHELL.length > 15);
  assert.equal(new Set(SHELL).size, SHELL.length, 'в SHELL есть повторы');
});

test('каждый файл из SHELL существует на диске (иначе копия не установится)', () => {
  for (const p of SHELL) {
    if (p === '/') { assert.ok(fs.existsSync(path.join(root, 'index.html'))); continue; }
    assert.ok(fs.existsSync(path.join(root, p.slice(1))), 'в SHELL есть, на диске нет: ' + p);
  }
});

test('каждый свой <script src> из index.html есть в SHELL', () => {
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((x) => x[1]).filter((s) => !/^(https?:)?\/\//.test(s));
  assert.ok(srcs.length > 8, 'скриптов найдено слишком мало: ' + srcs.length);
  for (const s of srcs) assert.ok(SHELL.includes(norm(s)), 'скрипт не в SHELL: ' + s);
});

test('всё, что догружают loadJS / skladLoadJS, есть в SHELL', () => {
  const names = new Set();
  for (const f of ['backend.js', 'app.js', 'mock.js', 'demo.js']) {
    for (const x of read(f).matchAll(/(?:skladLoadJS|loadJS)\(\s*'([^']+)'\s*\)/g)) names.add(x[1]);
  }
  for (const n of ['app.js', 'mock.js', 'demo.js', 'qr.js']) assert.ok(names.has(n), 'ожидали найти загрузку ' + n);
  for (const n of names) assert.ok(SHELL.includes(norm(n)), 'догружаемый файл не в SHELL: ' + n);
});

test('манифест: значки, логотип и сам манифест в SHELL; ссылки из index.html на значки тоже', () => {
  const man = JSON.parse(read('manifest.webmanifest'));
  assert.ok(man.icons && man.icons.length);
  for (const i of man.icons) assert.ok(SHELL.includes(norm(i.src)), 'значок манифеста не в SHELL: ' + i.src);
  assert.ok(SHELL.includes('/manifest.webmanifest'));
  assert.ok(SHELL.includes('/logo.svg'));
  const html = read('index.html');
  for (const x of html.matchAll(/<link[^>]*\shref="([^"]+)"/g)) {
    if (/^(https?:)?\/\//.test(x[1])) continue;
    assert.ok(SHELL.includes(norm(x[1])), 'ссылка из index.html не в SHELL: ' + x[1]);
  }
});
