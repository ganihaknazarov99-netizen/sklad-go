'use strict';
/* QR-код, который мы собираем сами (frontend/qr.js).

   Проверять его на глаз бесполезно: неправильный код выглядит точно так же,
   как правильный, и разница видна только телефону. Поэтому здесь три опоры:
   служебные биты сверяются с опубликованными в стандарте значениями,
   проверочные байты — со своим математическим определением, а сама картинка
   разбирается обратно в текст тем же путём, каким её читает сканер.

   Отдельно читаются биты формата прямо из картинки. Это то место, где ошибка
   прячется лучше всего: код собирается, разбирается своим же разбором — и не
   читается ничем. Порядок битов там идёт от младшего к старшему. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const win = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'qr.js'), 'utf8'))(win);
const QR = win.SkladQR, I = QR._inner;
const bits = (v, n) => v.toString(2).padStart(n, '0');

const SAMPLES = [
  'otpauth://totp/Sklad%20Go:gani%40shop.tj?secret=B7AAL4EPXF6OZCJTR7XMSBGOK3FXTYKK&issuer=Sklad%20Go&algorithm=SHA1&digits=6&period=30',
  'HELLO WORLD',
  'https://sklad.go/?invite=DB5FDC4E87',
  'Магазин Ганӣ — склад',
];

test('служебные биты формата совпадают со стандартом', () => {
  const want = ['111011111000100', '111001011110011', '111110110101010', '111100010011101',
    '110011000101111', '110001100011000', '110110001000001', '110100101110110'];
  for (let m = 0; m < 8; m++) assert.equal(bits(I.formatBits(m), 15), want[m], 'маска ' + m);
});

test('биты номера версии совпадают со стандартом', () => {
  const want = { 7: '000111110010010100', 8: '001000010110111100', 9: '001001101010011001', 10: '001010010011010011' };
  for (const v of Object.keys(want)) assert.equal(bits(I.versionBits(+v), 18), want[v], 'версия ' + v);
});

test('проверочные байты обращают слово в ноль в своих корнях', () => {
  const EXP = I.EXP, LOG = new Uint8Array(256);
  for (let i = 0; i < 255; i++) LOG[EXP[i]] = i;
  const mul = (a, b) => (a && b) ? EXP[(LOG[a] + LOG[b]) % 255] : 0;
  const evalAt = (poly, x) => poly.reduce((r, c) => mul(r, x) ^ c, 0);
  for (const ecLen of [7, 10, 15, 18, 20, 24, 26, 30]) {
    const data = Array.from({ length: 30 }, (_, i) => (i * 37 + 11) & 255);
    const full = data.concat(I.rsEncode(data, ecLen));
    for (let i = 0; i < ecLen; i++) assert.equal(evalAt(full, EXP[i]), 0, 'длина ' + ecLen + ', корень ' + i);
  }
});

// Читаем картинку так же, как её читает сканер: снимаем маску и идём змейкой
function decode(r) {
  const size = r.size, v = r.version;
  const res = I.makeFrame(v).res, m = Uint8Array.from(r.modules);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    if (!res[y * size + x] && I.MASKS[r.mask](y, x)) m[y * size + x] ^= 1;

  const seq = [];
  let up = true;
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c--;
    for (let k = 0; k < size; k++) {
      const y = up ? size - 1 - k : k;
      for (let d = 0; d < 2; d++) if (!res[y * size + (c - d)]) seq.push(m[y * size + (c - d)]);
    }
    up = !up;
  }
  const words = [];
  for (let i = 0; i + 8 <= seq.length; i += 8) {
    let w = 0; for (let j = 0; j < 8; j++) w = (w << 1) | seq[i + j];
    words.push(w);
  }
  // раскладываем перемешанные блоки обратно
  const tbl = { 1: [26, 7, 1], 2: [44, 10, 1], 3: [70, 15, 1], 4: [100, 20, 1], 5: [134, 26, 1], 6: [172, 18, 2], 7: [196, 20, 2], 8: [242, 24, 2], 9: [292, 30, 2], 10: [346, 18, 4] }[v];
  const nb = tbl[2], dw = I.dataWords(v), short = Math.floor(dw / nb), long = dw % nb;
  const lens = Array.from({ length: nb }, (_, b) => short + (b >= nb - long ? 1 : 0));
  const blocks = lens.map(() => []);
  let p = 0;
  for (let i = 0; i < short + 1; i++) for (let b = 0; b < nb; b++) if (i < lens[b]) blocks[b].push(words[p++]);
  const data = [].concat.apply([], blocks);

  let bi = 0;
  const take = (n) => { let x = 0; for (let k = 0; k < n; k++, bi++) x = (x << 1) | ((data[bi >> 3] >> (7 - (bi & 7))) & 1); return x; };
  assert.equal(take(4), 4, 'режим должен быть «байты»');
  const n = take(v < 10 ? 8 : 16), out = [];
  for (let i = 0; i < n; i++) out.push(take(8));
  return Buffer.from(out).toString('utf8');
}

test('картинка разбирается обратно в тот же текст', () => {
  for (const s of SAMPLES) assert.equal(decode(QR.encode(s)), s);
});

/* Места битов формата взяты из образцовой реализации Nayuki: бит 0 — в столбце 8
   сверху, бит 14 — слева в строке 8. Если порядок перепутать, всё остальное
   сойдётся, а телефон не прочитает ничего. */
function readFormat(r, copy) {
  const S = r.size, at = (y, x) => r.modules[y * S + x];
  let v = 0;
  const put = (i, b) => { v |= (b << i); };
  if (copy === 1) {
    for (let i = 0; i <= 5; i++) put(i, at(i, 8));
    put(6, at(7, 8)); put(7, at(8, 8)); put(8, at(8, 7));
    for (let i = 9; i <= 14; i++) put(i, at(8, 14 - i));
  } else {
    for (let i = 0; i <= 7; i++) put(i, at(8, S - 1 - i));
    for (let i = 8; i <= 14; i++) put(i, at(S - 15 + i, 8));
  }
  return v;
}

test('биты формата читаются из картинки как уровень L и записанная маска', () => {
  for (const s of SAMPLES) {
    const r = QR.encode(s);
    const c1 = readFormat(r, 1), c2 = readFormat(r, 2);
    assert.equal(c1, c2, 'две копии формата должны совпадать');
    const raw = c1 ^ 0x5412;
    let t = raw;
    for (let i = 14; i >= 10; i--) if (t & (1 << i)) t ^= 0x537 << (i - 10);
    assert.equal(t, 0, 'это должно быть настоящее слово формата');
    assert.equal((raw >> 13) & 3, 1, 'уровень коррекции L');
    assert.equal((raw >> 10) & 7, r.mask, 'маска');
  }
});

test('обязательные приметы на месте: углы, пунктир, тёмная клетка', () => {
  const r = QR.encode(SAMPLES[0]), S = r.size, at = (y, x) => r.modules[y * S + x];
  assert.equal(at(0, 0), 1); assert.equal(at(0, 6), 1); assert.equal(at(6, 0), 1);
  assert.equal(at(1, 1), 0); assert.equal(at(2, 2), 1);
  assert.equal(at(S - 8, 8), 1, 'всегда тёмная клетка');
  for (let i = 8; i < S - 8; i++) assert.equal(at(6, i), i % 2 ? 0 : 1, 'пунктир, клетка ' + i);
});

test('ссылка otpauth влезает с большим запасом', () => {
  const uri = SAMPLES[0];
  assert.ok(QR.capacity(10) > uri.length * 2, 'запас должен быть кратный');
  const r = QR.encode(uri);
  assert.ok(r.version <= 8, 'такая ссылка не должна требовать версию больше восьмой');
});

test('картинка выходит правильного размера и чёрно-белой', () => {
  const svg = QR.svg(SAMPLES[0], { scale: 4 });
  assert.match(svg, /^<svg /);
  assert.ok(svg.indexOf('fill="#fff"') > 0, 'белая подложка нужна даже в тёмной теме');
  assert.ok(svg.indexOf('fill="#000"') > 0);
  const r = QR.encode(SAMPLES[0]);
  const w = (r.size + 8) * 4;   // поле в 4 клетки с каждой стороны
  assert.ok(svg.indexOf('width="' + w + '"') > 0, 'ширина с пустым полем вокруг');
});
