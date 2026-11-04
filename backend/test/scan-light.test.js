'use strict';
/* Сканер штрихкода в магазине (корневой app.js + barcode.js + scan.js).

   Из списка советов: «сканер штрихкода камерой — продавать быстрее, ошибок меньше».
   Распознавание взято из полной версии как есть. Здесь проверяем то, что добавлено в
   магазин: код привязывается к одному товару, скан находит товар, продаёт или принимает
   по одной штуке, незнакомый код предлагает завести товар, а сайт пускает к камере. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const взять = (name) => {
  const m = new RegExp('^function ' + name + '\\(.*\\}$', 'm').exec(src)
    || new RegExp('^function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm').exec(src);
  assert.ok(m, 'в программе не нашлась функция ' + name + ' — тест устарел');
  return m[0];
};
const B = require('../../barcode.js');
const window = { SkladBarcode: B };
const bcNorm = new Function('window', 'SkladBarcode', взять('bcNorm') + ' return bcNorm;')(window, B);
const lab = (i) => i.name + (i.size ? ' · ' + i.size : '') + (i.color ? ' · ' + i.color : '');

function склад(items) {
  const S = { items };
  const тосты = [], лента = [];
  let сохранений = 0;
  const byBc = new Function('S', 'bcNorm', взять('byBc') + ' return byBc;')(S, bcNorm);
  const setBc = new Function('S', 'bcNorm', 'byBc', 'ME', 'save', 'toast', 'logAct', 'lab', взять('setBc') + ' return setBc;')(
    S, bcNorm, byBc, { name: 'Гани' }, () => { сохранений++; }, (t) => тосты.push(t), (t) => лента.push(t), lab);
  return { S, byBc, setBc, тосты, лента, сохранено: () => сохранений };
}

test('распознавание в магазине — то же, что в полной версии, и читает настоящие штрихкоды', () => {
  assert.equal(fs.readFileSync(path.join(root, 'barcode.js'), 'utf8'), fs.readFileSync(path.join(root, 'frontend', 'barcode.js'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(root, 'scan.js'), 'utf8'), fs.readFileSync(path.join(root, 'frontend', 'scan.js'), 'utf8'));
  const dir = path.join(__dirname, 'fixtures', 'barcodes');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).filter((m) => m.variant === 'clean').slice(0, 12);
  assert.ok(manifest.length >= 4);
  for (const m of manifest) {
    const buf = zlib.gunzipSync(fs.readFileSync(path.join(dir, m.file)));
    let p = 0;
    const tok = () => { while (buf[p] <= 32) p++; const s = p; while (buf[p] > 32) p++; return buf.slice(s, p).toString(); };
    tok(); const w = +tok(), h = +tok(); tok(); p++;
    const r = B.decodeImage(new Uint8Array(buf.slice(p, p + w * h)), w, h);
    assert.ok(r, 'не распознан ' + m.value);
    assert.equal(B.normalize(r.text), B.normalize(m.value));
  }
});

test('штрихкод привязывается к одному товару; чужой код не отдаётся', () => {
  const к = склад([{ id: 'a', name: 'Куртка', size: 'L' }, { id: 'b', name: 'Шапка' }]);
  assert.equal(к.setBc(к.S.items[0], ' 012345678905 '), true);
  assert.equal(к.S.items[0].bc, '0012345678905', 'UPC-A и EAN-13 — один и тот же товар');
  assert.equal(к.byBc('012345678905').id, 'a', 'находит по любому из двух видов');
  assert.equal(к.S.items[0].eb, 'Гани', 'видно, кто привязал');
  assert.deepEqual(к.лента, ['привязал штрихкод к «Куртка · L»']);
  assert.equal(к.setBc(к.S.items[1], '0012345678905'), false, 'один код — один товар, иначе сканер не поймёт, что продали');
  assert.equal(к.S.items[1].bc, undefined);
  assert.match(к.тосты.at(-1), /уже у: Куртка · L/);
  assert.equal(к.byBc('0012345678905', к.S.items[0]), null, 'свой код у себя — не помеха');
  assert.equal(к.setBc(к.S.items[0], ''), true, 'пустое поле — убрать код');
  assert.equal(к.S.items[0].bc, undefined);
  assert.equal(к.byBc(''), null);
});

// Окно сканера без браузера: камера — подделка, которая «видит» нужный код
function сканер(items, mode, cb) {
  const к = склад(items);
  const html = [], было = [];
  let камера = null;
  const els = {};
  const $ = (id) => els[id] || (els[id] = { id, value: '', innerHTML: '', className: '', style: {}, onclick: null });
  const win = { SkladBarcode: B, SkladScan: { mount: (box, o) => { камера = o; return { stop() { было.push('стоп'); }, torch() {} }; } } };
  const apply = (it, type, n) => { if (type === 'out' && n > it.qty) return false; it.qty += type === 'in' ? n : -n; было.push(type + ' ' + it.id); return true; };
  const scanUI = new Function('open', 'esc', '$', 'document', 'window', 'SkladScan', 'bcNorm', 'buzz', 'stopScan', 'close', 'byBc', 'sheet', 'unknownBc', 'apply', 'qt', 'uOf', 'lab', 'render', 'scMode',
    взять('scanUI') + ' return scanUI;')(
    (h) => html.push(h), (s) => String(s), $, { querySelectorAll: () => [] }, win, win.SkladScan, bcNorm, () => {},
    () => было.push('стоп'), () => было.push('закрыл'), к.byBc, (id) => было.push('карточка ' + id), (c) => было.push('незнаком ' + c),
    apply, (n) => n + ' шт', () => 'шт', lab, () => {}, 'find');
  scanUI(mode, cb);
  return { к, html, было, увидеть: (c) => камера.onCode(c), $ };
}

test('скан «Найти» открывает товар, незнакомый код — предлагает завести', () => {
  const т = сканер([{ id: 'a', name: 'Куртка', qty: 5, bc: '4600000000017' }], 'find');
  assert.match(т.html[0], /Сканер штрихкода/);
  assert.match(т.html[0], /data-sm="out"/, 'можно переключить на «Продал»');
  т.увидеть('4600000000017');
  assert.deepEqual(т.было, ['стоп', 'закрыл', 'карточка a'], 'камера выключается, открывается товар');
  const т2 = сканер([], 'find');
  т2.увидеть('4600000000024');
  assert.deepEqual(т2.было.at(-1), 'незнаком 4600000000024');
});

test('скан «Продал» продаёт по одной штуке, не уходя в минус', () => {
  const т = сканер([{ id: 'a', name: 'Куртка', qty: 1, bc: '4600000000017' }], 'out');
  т.увидеть('4600000000017');
  assert.equal(т.к.S.items[0].qty, 0);
  assert.match(т.$('scr').innerHTML, /✓ Куртка → 0 шт/);
  т.увидеть('4600000000017');
  assert.equal(т.к.S.items[0].qty, 0, 'больше, чем есть, не продать');
  assert.match(т.$('scr').innerHTML, /на складе только 0/);
  assert.equal(т.$('scr').className, 'scr bad');
  const п = сканер([{ id: 'a', name: 'Куртка', qty: 1, bc: '4600000000017' }], 'in');
  п.увидеть('4600000000017');
  п.увидеть('4600000000017');
  assert.equal(п.к.S.items[0].qty, 3, '«Привёз» — каждый скан +1');
});

test('привязать код из окна товара: камера отдаёт код, окно не ищет товар', () => {
  let got = null;
  const т = сканер([{ id: 'a', name: 'Куртка', qty: 1 }], 'find', (c) => { got = c; });
  assert.doesNotMatch(т.html[0], /data-sm=/, 'при привязке режимов нет');
  т.увидеть('012345678905');
  assert.equal(got, '0012345678905');
});

test('магазин пускает сканер к камере, файлы распознавания есть в программе и в копии на телефоне', () => {
  const vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const pp = vj.headers[0].headers.find((h) => h.key === 'Permissions-Policy').value;
  assert.match(pp, /camera=\(self\)/, 'камера — только этому сайту');
  assert.match(pp, /microphone=\(\)/);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="barcode.js"') > 0 && html.indexOf('src="scan.js"') > html.indexOf('src="barcode.js"'));
  assert.ok(html.indexOf('src="scan.js"') < html.indexOf('src="backend.js"'), 'до запуска программы');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /'\/barcode\.js', '\/scan\.js'/);
  assert.match(src, /id="scb"[^>]*aria-label="Сканер штрихкода"/, 'кнопка сканера рядом с поиском');
  assert.match(src, /placeholder="Штрихкод \(необязательно\)"/, 'код можно вписать при заведении товара');
  assert.match(src, /^function close\(fromPop\)\{stopScan\(\);/m, 'закрыли окно — камера выключилась');
});
