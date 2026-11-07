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

/* С 7 ноября 2026 сам skladgo.com — страница о складе (хозяин: «на моём адресе — новая
   страница»), а склад — на app.skladgo.com. Прежний skladgo.vercel.app — склад, как был. */
test('skladgo.com ведёт на страницу о складе, склад — на app.skladgo.com', () => {
  const r = (vercel.redirects || []).find((x) => x.source === '/');
  assert.ok(r, 'есть перенаправление корня');
  assert.deepEqual(r.has, [{ type: 'host', value: 'skladgo.com' }], 'только для skladgo.com: на остальных адресах в корне склад');
  assert.equal(r.destination, '/about');
  assert.equal(r.permanent, false, 'временное: браузеры не запомнят навсегда');

  const html = read('about/index.html');
  assert.doesNotMatch(html, /href="https:\/\/skladgo\.com"/, 'кнопки склада не ведут обратно на страницу');
  assert.equal((html.match(/href="https:\/\/app\.skladgo\.com"/g) || []).length, 3, 'шапка, «начать», подвал');
  assert.match(html, /url: 'https:\/\/app\.skladgo\.com', host: 'app\.skladgo\.com'/);

  assert.match(read('server/index.js'), /const АДРЕСА = \[[^\]]*'https:\/\/app\.skladgo\.com'/, 'сервер пускает вход и запись с app.skladgo.com');
});

function config(host, pathname, store) {
  let куда = null;
  const ctx = { location: { hostname: host, pathname, search: '', replace: (u) => { куда = u; } },
    localStorage: { getItem: (k) => (store || {})[k] ?? null, setItem() {}, removeItem() {} } };
  ctx.window = ctx;
  require('node:vm').createContext(ctx);
  require('node:vm').runInContext(read('config.js'), ctx);
  return куда;
}

test('сохранённая копия склада на skladgo.com уводит на страницу, если всё отправлено', () => {
  assert.equal(config('skladgo.com', '/'), '/about');
  assert.equal(config('skladgo.com', '/', { 'skladgo.dirty.main': '1' }), null, 'неотправленный склад — сначала дошлём');
  assert.equal(config('skladgo.com', '/', { 'skladgo.dirty.debts': '1' }), null, 'неотправленные долги — тоже');
  assert.equal(config('skladgo.com', '/index.html'), null, 'склад по прямому адресу открыть можно');
  assert.equal(config('app.skladgo.com', '/'), null);
  assert.equal(config('skladgo.vercel.app', '/'), null);
});
