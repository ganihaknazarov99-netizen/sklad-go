'use strict';
/* Страница о складе — skladgo.com/about (сделана в Claude Design, файлы в about/).
   Ей нужны React с unpkg (с проверкой целостности SRI), шрифты Google и eval для шаблона —
   поэтому у неё свои правила (CSP) в vercel.json. Склад остаётся на строгих правилах:
   ни чужих скриптов, ни eval. Старый адрес склада (skladgo.vercel.app) на странице не
   упоминается — хозяин попросил убрать. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const vercel = JSON.parse(read('vercel.json'));
const правило = (src) => vercel.headers.find((h) => h.source === src);
const csp = (r) => r.headers.find((h) => h.key === 'Content-Security-Policy').value;
// Vercel читает source как path-to-regexp; эти два — обычные регулярные выражения
const re = (src) => new RegExp('^' + src + '$');

test('страница о складе: свой помощник по абсолютному пути, заголовок, без старого адреса', () => {
  const html = read('about/index.html');
  assert.match(html, /<script src="\/about\/support\.js"><\/script>/, 'по /about без косой черты «./support.js» искался бы в корне');
  assert.match(html, /<title>Sklad Go[^<]*<\/title>/);
  assert.doesNotMatch(html, /skladgo\.vercel\.app/, 'старого адреса нет');
  assert.doesNotMatch(html, /\{\{ L\.k83 \}\}/, 'строчки про старую «полную версию» нет');
  assert.ok(fs.existsSync(path.join(root, 'about/support.js')));
});

test('React для страницы — с unpkg и только с проверкой целостности', () => {
  const js = read('about/support.js');
  assert.match(js, /REACT_URL = "https:\/\/unpkg\.com\/react@18\.3\.1\//);
  assert.match(js, /REACT_SRI = "sha384-/);
  assert.match(js, /REACT_DOM_SRI = "sha384-/);
});

test('правила: склад строгий, странице о складе — своё, и пути не пересекаются', () => {
  const склад = vercel.headers[0];
  const оНас = правило('/about(.*)');
  assert.ok(оНас, 'есть правило для /about');
  assert.equal(склад.source, '/((?!about).*)');
  for (const p of ['/', '/index.html', '/app.js', '/privacy.html', '/sw.js', '/config.js']) {
    assert.ok(re(склад.source).test(p), p + ' — по правилам склада');
    assert.ok(!re(оНас.source).test(p), p + ' — не по правилам страницы');
  }
  for (const p of ['/about', '/about/', '/about/support.js']) {
    assert.ok(re(оНас.source).test(p), p + ' — по правилам страницы');
    assert.ok(!re(склад.source).test(p), p + ' — не по правилам склада');
  }
  assert.doesNotMatch(csp(склад), /unsafe-eval|unpkg|googleapis|gstatic/, 'склад не пускает чужое');
  assert.match(csp(оНас), /script-src 'self' 'unsafe-eval' https:\/\/unpkg\.com;/);
  assert.match(csp(оНас), /font-src https:\/\/fonts\.gstatic\.com;/);
  assert.match(csp(оНас), /connect-src 'self';/);
  assert.match(csp(оНас), /frame-ancestors 'none'/);
  for (const k of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    assert.ok(оНас.headers.some((h) => h.key === k), k);
  }
});
