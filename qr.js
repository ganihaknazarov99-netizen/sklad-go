/* QR-код своими руками.

   Нужен он в одном месте: подключить аутентификатор, не переписывая руками
   ключ из 32 символов. Готовую библиотеку сюда не взять — страница пускает
   только свои файлы, чужие скрипты запрещены нарочно (см. заголовки сервера).

   Сделано по стандарту ISO/IEC 18004: режим «байты», уровень коррекции L,
   версии с 1-й по 10-ю (до 271 символа — для ссылки otpauth:// хватает втрое).
   Уровень L выбран сознательно: код смотрят с чистого яркого экрана
   с расстояния ладони, это самые лёгкие условия, какие бывают.

   Снаружи: SkladQR.svg(текст) — готовая картинка.
*/
(function () {
  'use strict';

  /* ---------- Поле Галуа GF(256): арифметика, на которой стоит коррекция ошибок ---------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function mul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }

  // Порождающий многочлен: произведение (x - a^i). Вычитание здесь — тот же XOR.
  function genPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var ng = new Array(g.length + 1);
      for (var k = 0; k < ng.length; k++) ng[k] = 0;
      for (var j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  // Остаток от деления — это и есть проверочные байты
  function rsEncode(data, ecLen) {
    var g = genPoly(ecLen), res = new Array(data.length + ecLen), i, j;
    for (i = 0; i < res.length; i++) res[i] = i < data.length ? data[i] : 0;
    for (i = 0; i < data.length; i++) {
      var f = res[i];
      if (!f) continue;
      for (j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], f);
    }
    return res.slice(data.length);
  }

  /* ---------- Таблицы версий (уровень L) ----------
     [всего кодовых слов, проверочных на блок, блоков] */
  var L = {
    1: [26, 7, 1], 2: [44, 10, 1], 3: [70, 15, 1], 4: [100, 20, 1], 5: [134, 26, 1],
    6: [172, 18, 2], 7: [196, 20, 2], 8: [242, 24, 2], 9: [292, 30, 2], 10: [346, 18, 4]
  };
  // Середины выравнивающих квадратов — без них большой код «плывёт» при наклоне
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  var dataWords = (v) => L[v][0] - L[v][1] * L[v][2];
  // Сколько байт влезет: минус заголовок (4 бита режима + счётчик)
  function capacity(v) { return Math.floor((dataWords(v) * 8 - 4 - (v < 10 ? 8 : 16)) / 8); }

  /* ---------- Контрольные биты (BCH) для служебных полей ---------- */
  function bch(value, gen, len) {
    var v = value << (len - 1);
    var top = 1 << (len - 1 + bitLen(gen) - 1);
    for (var i = bitLen(v); i >= bitLen(gen); i--) {
      if (v & (1 << (i - 1))) v ^= gen << (i - bitLen(gen));
    }
    return v;
    function bitLen(x) { var n = 0; while (x) { n++; x >>>= 1; } return n; }
  }
  // 15 бит: уровень коррекции + номер маски. Уровень L кодируется как 01.
  function formatBits(mask) {
    var d = (1 << 3) | mask;                       // 01 (уровень L) + 3 бита маски
    return ((d << 10) | bch(d, 0x537, 11)) ^ 0x5412;
  }
  // 18 бит: номер версии (нужен с 7-й)
  function versionBits(v) { return (v << 12) | bch(v, 0x1F25, 13); }

  /* ---------- Укладка узора ---------- */
  function makeFrame(v) {
    var size = v * 4 + 17;
    var m = new Uint8Array(size * size), res = new Uint8Array(size * size);
    var set = function (r, c, val) { m[r * size + c] = val; res[r * size + c] = 1; };

    // три больших квадрата по углам + пустая рамка вокруг каждого
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (p) {
      for (var r = -1; r <= 7; r++) for (var c = -1; c <= 7; c++) {
        var rr = p[0] + r, cc = p[1] + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, on ? 1 : 0);
      }
    });
    // пунктир: по нему сканер считает клетки
    for (var i = 8; i < size - 8; i++) { set(6, i, i % 2 ? 0 : 1); set(i, 6, i % 2 ? 0 : 1); }
    // маленькие квадраты выравнивания, кроме углов, занятых большими
    var ap = ALIGN[v];
    for (var a = 0; a < ap.length; a++) for (var b = 0; b < ap.length; b++) {
      var ar = ap[a], ac = ap[b];
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++)
        set(ar + dr, ac + dc, (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0);
    }
    // место под служебные биты держим занятым, чтобы данные туда не попали
    for (i = 0; i <= 8; i++) { if (!res[8 * size + i]) set(8, i, 0); if (!res[i * size + 8]) set(i, 8, 0); }
    for (i = 0; i < 8; i++) { set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
    set(size - 8, 8, 1);                                    // всегда тёмная клетка
    if (v >= 7) for (i = 0; i < 18; i++) {
      var r1 = Math.floor(i / 3), c1 = i % 3;
      set(size - 11 + c1, r1, 0); set(r1, size - 11 + c1, 0);
    }
    return { size: size, m: m, res: res };
  }

  /* ---------- Данные ---------- */
  function toBits(text, v) {
    var bytes = [], i;
    for (i = 0; i < text.length; i++) {                      // UTF-8
      var c = text.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
      else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    var bits = [], push = function (val, n) { for (var k = n - 1; k >= 0; k--) bits.push((val >> k) & 1); };
    push(4, 4);                                              // режим «байты»
    push(bytes.length, v < 10 ? 8 : 16);
    for (i = 0; i < bytes.length; i++) push(bytes[i], 8);
    var total = dataWords(v) * 8;
    for (i = 0; i < 4 && bits.length < total; i++) bits.push(0);   // завершитель
    while (bits.length % 8) bits.push(0);
    var words = [];
    for (i = 0; i < bits.length; i += 8) {
      var w = 0; for (var j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
      words.push(w);
    }
    // добивка до конца — чередующиеся байты из стандарта
    var pad = [0xEC, 0x11], p = 0;
    while (words.length < dataWords(v)) words.push(pad[p++ % 2]);
    return words;
  }

  // Разбиваем на блоки, к каждому свои проверочные байты, и перемешиваем:
  // так царапина портит по кусочку в каждом блоке, а не один блок целиком.
  function interleave(words, v) {
    var ecLen = L[v][1], nb = L[v][2], dw = dataWords(v);
    var short = Math.floor(dw / nb), long = dw % nb;
    var blocks = [], ecs = [], pos = 0, i, b;
    for (b = 0; b < nb; b++) {
      var len = short + (b >= nb - long ? 1 : 0);
      var blk = words.slice(pos, pos + len); pos += len;
      blocks.push(blk); ecs.push(rsEncode(blk, ecLen));
    }
    var out = [];
    for (i = 0; i < short + 1; i++) for (b = 0; b < nb; b++) if (i < blocks[b].length) out.push(blocks[b][i]);
    for (i = 0; i < ecLen; i++) for (b = 0; b < nb; b++) out.push(ecs[b][i]);
    return out;
  }

  // Змейкой снизу вверх, по два столбца справа налево, обходя занятое
  function placeWords(f, words) {
    var size = f.size, bits = [], i, j;
    for (i = 0; i < words.length; i++) for (j = 7; j >= 0; j--) bits.push((words[i] >> j) & 1);
    var p = 0, up = true;
    for (var c = size - 1; c > 0; c -= 2) {
      if (c === 6) c--;                                      // столбец с пунктиром пропускаем
      for (var k = 0; k < size; k++) {
        var r = up ? size - 1 - k : k;
        for (var d = 0; d < 2; d++) {
          var cc = c - d;
          if (f.res[r * size + cc]) continue;
          f.m[r * size + cc] = p < bits.length ? bits[p++] : 0;
        }
      }
      up = !up;
    }
    return p;
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
  ];

  /* Штраф за узоры, которые сбивают сканер: длинные полосы, квадраты одного
     цвета, куски, похожие на угловой квадрат, и перекос светлого к тёмному.
     Из восьми масок берём ту, где штраф меньше. */
  function penalty(m, size) {
    var score = 0, dark = 0, r, c, i;
    var at = function (r, c) { return m[r * size + c]; };
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (at(r, c)) dark++;
    // полосы
    for (i = 0; i < 2; i++) for (r = 0; r < size; r++) {
      var run = 1, prev = -1;
      for (c = 0; c < size; c++) {
        var val = i ? at(c, r) : at(r, c);
        if (val === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else { run = 1; prev = val; }
      }
    }
    // квадраты 2×2
    for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) {
      var v0 = at(r, c);
      if (v0 === at(r, c + 1) && v0 === at(r + 1, c) && v0 === at(r + 1, c + 1)) score += 3;
    }
    // похожее на угловой квадрат
    var pat = [1, 0, 1, 1, 1, 0, 1], zeros = [0, 0, 0, 0];
    var seq = pat.concat(zeros), seqR = zeros.concat(pat);
    for (i = 0; i < 2; i++) for (r = 0; r < size; r++) for (c = 0; c + 11 <= size; c++) {
      var okA = true, okB = true;
      for (var k = 0; k < 11; k++) {
        var val2 = i ? at(c + k, r) : at(r, c + k);
        if (val2 !== seq[k]) okA = false;
        if (val2 !== seqR[k]) okB = false;
      }
      if (okA) score += 40;
      if (okB) score += 40;
    }
    // перекос светлого и тёмного
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function putFormat(f, mask) {
    var size = f.size, fmt = formatBits(mask);
    // Счёт битов идёт от младшего: бит 0 ложится под верхний левый угол,
    // старший (14-й) — в начало строки 8. Перепутать порядок легко, и код
    // тогда выглядит правильным, но не читается ничем.
    var bit = function (i) { return (fmt >> i) & 1; };
    for (var i = 0; i <= 5; i++) f.m[i * size + 8] = bit(i);
    f.m[7 * size + 8] = bit(6); f.m[8 * size + 8] = bit(7); f.m[8 * size + 7] = bit(8);
    for (i = 9; i <= 14; i++) f.m[8 * size + (14 - i)] = bit(i);
    for (i = 0; i <= 7; i++) f.m[8 * size + (size - 1 - i)] = bit(i);
    for (i = 8; i <= 14; i++) f.m[(size - 15 + i) * size + 8] = bit(i);
  }
  function putVersion(f, v) {
    if (v < 7) return;
    var size = f.size, vb = versionBits(v);
    for (var i = 0; i < 18; i++) {
      var b = (vb >> i) & 1, r = Math.floor(i / 3), c = i % 3;
      f.m[(size - 11 + c) * size + r] = b;
      f.m[r * size + (size - 11 + c)] = b;
    }
  }

  function encode(text, forceVersion) {
    var v = forceVersion || 0;
    if (!v) { for (var k = 1; k <= 10; k++) if (capacity(k) >= utf8len(text)) { v = k; break; } }
    if (!v) throw new Error('Слишком длинный текст для QR');
    var f = makeFrame(v);
    placeWords(f, interleave(toBits(text, v), v));

    // выбираем маску с наименьшим штрафом
    var size = f.size, best = null, bestScore = Infinity, bestMask = 0;
    for (var mk = 0; mk < 8; mk++) {
      var test = { size: size, m: Uint8Array.from(f.m), res: f.res };
      for (var r = 0; r < size; r++) for (var c = 0; c < size; c++)
        if (!test.res[r * size + c] && MASKS[mk](r, c)) test.m[r * size + c] ^= 1;
      putFormat(test, mk); putVersion(test, v);
      var sc = penalty(test.m, size);
      if (sc < bestScore) { bestScore = sc; best = test; bestMask = mk; }
    }
    return { size: size, version: v, mask: bestMask, modules: best.m };
  }
  function utf8len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += c < 128 ? 1 : c < 2048 ? 2 : 3; }
    return n;
  }

  /* ---------- Картинка ----------
     Всегда чёрным по белому, независимо от тёмной темы: сканеру нужен контраст.
     Вокруг — пустое поле в 4 клетки, без него код не читается. */
  function svg(text, opt) {
    var o = opt || {}, q = o.quiet == null ? 4 : o.quiet, px = o.scale || 4;
    var r = encode(text), n = r.size, w = (n + q * 2) * px;
    var d = '';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!r.modules[y * n + x]) continue;
        d += 'M' + ((x + q) * px) + ' ' + ((y + q) * px) + 'h' + px + 'v' + px + 'h-' + px + 'z';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + w + '" viewBox="0 0 ' + w + ' ' + w +
      '" shape-rendering="crispEdges" role="img" aria-label="QR-код"><rect width="' + w + '" height="' + w +
      '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  window.SkladQR = { encode: encode, svg: svg, capacity: capacity, _inner: { toBits: toBits, interleave: interleave, rsEncode: rsEncode, formatBits: formatBits, versionBits: versionBits, dataWords: dataWords, EXP: EXP, MASKS: MASKS, makeFrame: makeFrame } };
})();
