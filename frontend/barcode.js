/* Распознавание штрихкодов по картинке с камеры: EAN-13, EAN-8, UPC-A, Code 128, Code 39.
   Работает без интернета и без сторонних библиотек (нужен на iPhone, где встроенного сканера в браузере нет).
   Идея: берём строки пикселей поперёк изображения (в том числе под наклоном), превращаем их в чередование чёрных и белых полос
   и сверяем с таблицами символик. Контрольные цифры проверяются, поэтому случайный шум почти не даёт ложных срабатываний. */
(function (root) {
  'use strict';
  var C128 = ["212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112"];
  var C39 = {"000110100": "0", "100100001": "1", "001100001": "2", "101100000": "3", "000110001": "4", "100110000": "5", "001110000": "6", "000100101": "7", "100100100": "8", "001100100": "9", "100001001": "A", "001001001": "B", "101001000": "C", "000011001": "D", "100011000": "E", "001011000": "F", "000001101": "G", "100001100": "H", "001001100": "I", "000011100": "J", "100000011": "K", "001000011": "L", "101000010": "M", "000010011": "N", "100010010": "O", "001010010": "P", "000000111": "Q", "100000110": "R", "001000110": "S", "000010110": "T", "110000001": "U", "011000001": "V", "111000000": "W", "010010001": "X", "110010000": "Y", "011010000": "Z", "010000101": "-", "110000100": ".", "011000100": " ", "010010100": "*", "010101000": "$", "010100010": "/", "010001010": "+", "000101010": "%"};
  var EAN_L = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'];
  var EAN_G = EAN_L.map(function (p) { return p.split('').reverse().join(''); });
  var PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  var MAX_AVG = 0.48, MAX_IND = 0.7;

  // Насколько 4–7 подряд идущих полос похожи на эталон (ширины в модулях). Меньше — лучше; Infinity — не похоже.
  function variance(runs, off, pat, len) {
    var total = 0, pt = 0, i;
    for (i = 0; i < len; i++) { total += runs[off + i]; pt += pat.charCodeAt(i) - 48; }
    if (total < pt) return Infinity;
    var unit = total / pt, mx = MAX_IND * unit, sum = 0;
    for (i = 0; i < len; i++) {
      var d = Math.abs(runs[off + i] - (pat.charCodeAt(i) - 48) * unit);
      if (d > mx) return Infinity;
      sum += d;
    }
    return sum / total;
  }
  function checkDigitOk(s) {
    var sum = 0, n = s.length - 1, w = 3;
    for (var i = n - 1; i >= 0; i--) { sum += (s.charCodeAt(i) - 48) * w; w = 4 - w; }
    return ((10 - sum % 10) % 10) === s.charCodeAt(n) - 48;
  }

  function span(runs, i, n) { var t = 0; for (var k = 0; k < n; k++) t += runs[i + k]; return t; }

  function ean13At(runs, i) {
    if (i + 59 > runs.length) return null;
    if (variance(runs, i, '111', 3) > MAX_AVG) return null;
    var digits = '', par = '', k, j, best, bv, v;
    for (k = 0; k < 6; k++) {
      var off = i + 3 + 4 * k; best = -1; bv = MAX_AVG;
      for (j = 0; j < 10; j++) {
        v = variance(runs, off, EAN_L[j], 4); if (v < bv) { bv = v; best = j; par = par.slice(0, k) + 'L'; }
        v = variance(runs, off, EAN_G[j], 4); if (v < bv) { bv = v; best = j; par = par.slice(0, k) + 'G'; }
      }
      if (best < 0) return null; digits += best;
    }
    if (variance(runs, i + 27, '11111', 5) > MAX_AVG) return null;
    for (k = 0; k < 6; k++) {
      best = -1; bv = MAX_AVG;
      for (j = 0; j < 10; j++) { v = variance(runs, i + 32 + 4 * k, EAN_L[j], 4); if (v < bv) { bv = v; best = j; } }
      if (best < 0) return null; digits += best;
    }
    if (variance(runs, i + 56, '111', 3) > MAX_AVG) return null;
    var first = PARITY.indexOf(par); if (first < 0) return null;
    var code = first + digits;
    return checkDigitOk(code) ? { text: code, format: first === 0 ? 'upc_a' : 'ean_13', end: i + 59, mod: span(runs, i, 59) / 95 } : null;
  }
  function ean8At(runs, i) {
    if (i + 43 > runs.length) return null;
    if (variance(runs, i, '111', 3) > MAX_AVG) return null;
    var digits = '', k, j, best, bv, v;
    for (k = 0; k < 4; k++) {
      best = -1; bv = MAX_AVG;
      for (j = 0; j < 10; j++) { v = variance(runs, i + 3 + 4 * k, EAN_L[j], 4); if (v < bv) { bv = v; best = j; } }
      if (best < 0) return null; digits += best;
    }
    if (variance(runs, i + 19, '11111', 5) > MAX_AVG) return null;
    for (k = 0; k < 4; k++) {
      best = -1; bv = MAX_AVG;
      for (j = 0; j < 10; j++) { v = variance(runs, i + 24 + 4 * k, EAN_L[j], 4); if (v < bv) { bv = v; best = j; } }
      if (best < 0) return null; digits += best;
    }
    if (variance(runs, i + 40, '111', 3) > MAX_AVG) return null;
    return checkDigitOk(digits) ? { text: digits, format: 'ean_8', end: i + 43, mod: span(runs, i, 43) / 67 } : null;
  }

  function c128Sym(runs, off) {
    var best = -1, bv = MAX_AVG;
    for (var j = 0; j < 106; j++) { var v = variance(runs, off, C128[j], 6); if (v < bv) { bv = v; best = j; } }
    return best;
  }
  function c128At(runs, i) {
    if (i + 6 > runs.length) return null;
    var start = c128Sym(runs, i);
    if (start < 103 || start > 105) return null;
    var vals = [start], pos = i + 6;
    for (;;) {
      if (pos + 7 <= runs.length && variance(runs, pos, C128[106], 7) <= MAX_AVG) break;
      if (pos + 6 > runs.length || vals.length > 80) return null;
      var v = c128Sym(runs, pos); if (v < 0) return null;
      vals.push(v); pos += 6;
    }
    var n = vals.length; if (n < 3) return null;
    var sum = vals[0]; for (var k = 1; k < n - 1; k++) sum += k * vals[k];
    if (sum % 103 !== vals[n - 1]) return null;
    var set = start === 103 ? 'A' : start === 104 ? 'B' : 'C', out = '', shift = false;
    for (k = 1; k < n - 1; k++) {
      var x = vals[k];
      if (set === 'C') {
        if (x < 100) out += (x < 10 ? '0' : '') + x; else if (x === 100) set = 'B'; else if (x === 101) set = 'A';
      } else {
        var cur = shift ? (set === 'A' ? 'B' : 'A') : set; shift = false;
        if (x === 99) set = 'C';
        else if (x === 98) shift = true;
        else if (x === 100) { if (cur === 'A') set = 'B'; }
        else if (x === 101) { if (cur === 'B') set = 'A'; }
        else if (x < 96) out += String.fromCharCode(cur === 'A' ? (x < 64 ? x + 32 : x - 64) : x + 32);
      }
    }
    return out ? { text: out, format: 'code_128', end: pos + 7, mod: span(runs, i, pos + 7 - i) / (11 * n + 2) } : null;
  }

  function c39Char(runs, off) {
    var w = [], i;
    for (i = 0; i < 9; i++) { w.push(runs[off + i]); }
    var sorted = w.slice().sort(function (a, b) { return a - b; });
    var narrow = (sorted[0] + sorted[1] + sorted[2] + sorted[3] + sorted[4] + sorted[5]) / 6;
    var wide = (sorted[6] + sorted[7] + sorted[8]) / 3;
    if (wide < narrow * 1.9 || wide > narrow * 3.6) return null;
    if (sorted[5] > narrow * 1.45 || sorted[6] < wide * 0.7) return null;      // узкие должны быть ровными, широкие — заметно шире
    var cut = (sorted[5] + sorted[6]) / 2, bits = '';
    for (i = 0; i < 9; i++) bits += w[i] > cut ? '1' : '0';
    var ch = C39[bits];
    return ch ? { ch: ch, narrow: narrow } : null;
  }
  function c39At(runs, i) {
    if (i + 9 > runs.length) return null;
    var st = c39Char(runs, i);
    if (!st || st.ch !== '*') return null;
    var pos = i + 10, out = '';
    while (pos + 9 <= runs.length && out.length < 40) {
      var gap = runs[pos - 1], c = c39Char(runs, pos);
      if (!c || gap > st.narrow * 1.9 || gap < st.narrow * 0.45) return null;  // между символами — узкий белый промежуток
      if (c.ch === '*') return out.length >= 3 ? { text: out, format: 'code_39', end: pos + 9, mod: st.narrow } : null;
      out += c.ch; pos += 10;
    }
    return null;
  }

  // Превращаем строку яркости в ширины чёрных/белых полос (с дробной точностью границ). Порог — локальный, чтобы тень не мешала.
  function lineRuns(g, mode) {
    var n = g.length, B = 12, nb = Math.ceil(n / B), mins = [], maxs = [], b, x, thr = new Float32Array(n);
    for (b = 0; b < nb; b++) {
      var lo = 255, hi = 0;
      for (x = b * B; x < Math.min(n, (b + 1) * B); x++) { if (g[x] < lo) lo = g[x]; if (g[x] > hi) hi = g[x]; }
      mins.push(lo); maxs.push(hi);
    }
    var R = mode === 1 ? 2 : 5;
    for (b = 0; b < nb; b++) {
      var l2 = 255, h2 = 0;
      for (var q = Math.max(0, b - R); q <= Math.min(nb - 1, b + R); q++) { if (mins[q] < l2) l2 = mins[q]; if (maxs[q] > h2) h2 = maxs[q]; }
      var t = (h2 - l2) < 28 ? -1 : (l2 + h2) / 2;
      for (x = b * B; x < Math.min(n, (b + 1) * B); x++) thr[x] = t;
    }
    var runs = [], cols = [], cur = g[0] < thr[0] ? 1 : 0, start = 0;
    if (thr[0] < 0) cur = 0;
    for (x = 1; x < n; x++) {
      var c = thr[x] < 0 ? 0 : (g[x] < thr[x] ? 1 : 0);
      if (c !== cur) {
        var tv = thr[x] < 0 ? thr[x - 1] : thr[x], d = g[x] - g[x - 1], pos = d === 0 ? x : (x - 1) + Math.max(0, Math.min(1, (tv - g[x - 1]) / d));
        runs.push(pos - start); cols.push(cur); start = pos; cur = c;
      }
    }
    runs.push(n - start); cols.push(cur);
    return { runs: runs, cols: cols };
  }

  function tryRuns(runs, cols) {
    var n = runs.length;
    for (var i = 1; i < n - 5; i++) {
      if (cols[i] !== 1) continue;                       // любой штрихкод начинается с чёрной полосы
      var r = ean13At(runs, i) || ean8At(runs, i) || c128At(runs, i) || c39At(runs, i);
      if (!r) continue;
      // белое поле перед кодом (не меньше 5 модулей) и, если линия продолжается, после него (не меньше 3)
      if (runs[i - 1] < 5 * r.mod) continue;
      if (r.end < n && cols[r.end] === 0 && runs[r.end] < 3 * r.mod && r.end < n - 1) continue;
      return r;
    }
    return null;
  }
  function decodeLine(g) {
    for (var mode = 0; mode < 2; mode++) {
      var lr = lineRuns(g, mode);
      var r = tryRuns(lr.runs, lr.cols);
      if (r) return r;
      var rr = lr.runs.slice().reverse(), rc = lr.cols.slice().reverse();   // штрихкод мог оказаться вверх ногами
      r = tryRuns(rr, rc);
      if (r) return r;
    }
    return null;
  }

  function sample(gray, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy;
  }
  // Одна линия под углом deg (0 — горизонтальная) со смещением off пикселей от центра изображения
  function lineAt(gray, w, h, deg, off) {
    var a = deg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), cx = w / 2 - dy * off, cy = h / 2 + dx * off;
    var L = Math.sqrt(w * w + h * h), half = L / 2, out = [], t, px, py, v;
    for (t = -half; t <= half; t += 1) {
      px = cx + dx * t; py = cy + dy * t; v = sample(gray, w, h, px, py);
      if (v >= 0) out.push(v);
    }
    return out.length > 60 ? out : null;
  }
  var LEVELS = [[0, 90], [-10, 10, 80, 100], [-20, 20, 70, 110], [-32, 32, 58, 122]];
  function decodeLevel(gray, w, h, level) {
    var angles = LEVELS[level], span = Math.min(w, h) * 0.42, step = Math.max(3, Math.round(Math.min(w, h) / 22));
    for (var ai = 0; ai < angles.length; ai++) {
      var deg = angles[ai], vertical = (deg >= 45 || deg <= -45);
      var half = vertical ? Math.min(span, w * 0.45) : span;
      var offs = [0];
      for (var o = step; o <= half; o += step) { offs.push(o); offs.push(-o); }
      for (var k = 0; k < offs.length; k++) {
        var ln = lineAt(gray, w, h, deg, offs[k]);
        if (!ln) continue;
        var r = decodeLine(ln);
        if (r) { r.angle = deg; return r; }
      }
    }
    return null;
  }
  // Для живой камеры: на каждом кадре — один «уровень» наклона, по кругу 0,1,0,2,0,3
  var SEQ = [0, 1, 0, 2, 0, 3];
  function decodeFrame(gray, w, h, frameNo) { return decodeLevel(gray, w, h, SEQ[(frameNo || 0) % SEQ.length]); }
  // Для фото: перебираем все уровни
  function decodeImage(gray, w, h) {
    for (var l = 0; l < LEVELS.length; l++) { var r = decodeLevel(gray, w, h, l); if (r) return r; }
    return null;
  }
  // Приводим коды к одному виду: UPC-A (12 цифр) = EAN-13 с нулём впереди
  function normalize(code) {
    code = String(code || '').trim();
    return /^\d{12}$/.test(code) ? '0' + code : code;
  }
  var api = { decodeImage: decodeImage, decodeFrame: decodeFrame, decodeLine: decodeLine, normalize: normalize, _tables: { C128: C128 } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SkladBarcode = api;
})(typeof window !== 'undefined' ? window : globalThis);
