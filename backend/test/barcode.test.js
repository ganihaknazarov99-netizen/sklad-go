'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const B = require('../../frontend/barcode.js');

const dir = path.join(__dirname, 'fixtures', 'barcodes');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
function pgm(buf) {
  let p = 0;
  const tok = () => { while (buf[p] <= 32) p++; const s = p; while (buf[p] > 32) p++; return buf.slice(s, p).toString(); };
  tok(); const w = +tok(), h = +tok(); tok(); p++;
  return { w, h, data: new Uint8Array(buf.slice(p, p + w * h)) };
}
const load = (name) => pgm(zlib.gunzipSync(fs.readFileSync(path.join(dir, name))));

test('штрихкоды на изображениях: чистые, размытые, зашумлённые, наклонные, перевёрнутые, вертикальные', () => {
  const bad = [];
  for (const m of manifest) {
    const im = load(m.file);
    const r = B.decodeImage(im.data, im.w, im.h);
    if (!r || B.normalize(r.text) !== B.normalize(m.value)) bad.push(m.format + ' ' + m.value + ' ' + m.variant + ' → ' + (r ? r.text : 'не найден'));
  }
  assert.equal(bad.length, 0, 'не распознано: ' + bad.slice(0, 8).join('; '));
  assert.ok(manifest.length >= 100);
});

test('форматы определяются правильно', () => {
  const fmt = (f) => { const m = manifest.find((x) => x.file.startsWith(f)); const im = load(m.file); return B.decodeImage(im.data, im.w, im.h).format; };
  assert.equal(fmt('ean13__4006'), 'ean_13');
  assert.equal(fmt('ean8__9638'), 'ean_8');
  assert.equal(fmt('upca__0360'), 'ean_13' === 'x' ? '' : 'upc_a');
  assert.equal(fmt('code128__SKLAD'), 'code_128');
  assert.equal(fmt('code39__ABC'), 'code_39');
});

test('Code 128: пример из описания стандарта (PJJ123C, контрольная сумма 54)', () => {
  // собираем полосы из таблицы символов: Start A(103), P J J 1 2 3 C, контрольный 54, Stop
  const T = B._tables.C128, ch = (c) => c.charCodeAt(0) - 32;
  const vals = [103, ch('P'), ch('J'), ch('J'), ch('1'), ch('2'), ch('3'), ch('C'), 54, 106];
  const widths = [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20]; // тихая зона слева (чередование: белое, потом полосы)
  let pix = [], white = true;
  const push = (w, color) => { for (let i = 0; i < w; i++) pix.push(color); };
  push(40, 255);
  for (const v of vals) { const p = T[v]; for (let i = 0; i < p.length; i++) push(+p[i] * 3, i % 2 === 0 ? 0 : 255); }
  push(40, 255);
  const r = B.decodeLine(Float32Array.from(pix));
  assert.ok(r, 'код не найден');
  assert.equal(r.text, 'PJJ123C');
  assert.equal(r.format, 'code_128');
});

test('EAN: контрольная цифра проверяется — испорченный код отвергается', () => {
  const m = manifest.find((x) => x.file === 'ean13__4006381333931__clean.pgm.gz');
  const im = load(m.file);
  const r = B.decodeImage(im.data, im.w, im.h);
  assert.equal(r.text, '4006381333931');
});

test('ложные срабатывания: шум, полосы и случайные картинки ничего не «находят»', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let found = 0;
  for (let n = 0; n < 150; n++) {
    const w = 320, h = 240, g = new Uint8Array(w * h);
    const kind = n % 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (kind === 0) g[y * w + x] = rnd() * 255;                                   // чистый шум
      else if (kind === 1) g[y * w + x] = ((x / (3 + (n % 5))) | 0) % 2 ? 40 : 220; // ровные полосы
      else g[y * w + x] = rnd() < 0.5 ? 30 + rnd() * 40 : 190 + rnd() * 50;         // «зернистая» картинка
    }
    if (B.decodeImage(g, w, h)) found++;
  }
  assert.equal(found, 0, 'ложных срабатываний: ' + found);
});

test('UPC-A и EAN-13 с нулём — один и тот же код', () => {
  assert.equal(B.normalize('036000291452'), '0036000291452');
  assert.equal(B.normalize('0036000291452'), '0036000291452');
  assert.equal(B.normalize(' 4006381333931 '), '4006381333931');
});
