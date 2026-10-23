/* Язык интерфейса: ru (русский) или tg (тоҷикӣ). Словарь переводов — в файле tg.js (его легко править).
   Деньги и склад не затрагиваются: переводится только то, что показывается на экране. */
(function () {
  'use strict';
  var L = 'ru';
  try {
    L = localStorage.getItem('skladgo.lang') || ((navigator.language || '').toLowerCase().indexOf('tg') === 0 ? 'tg' : 'ru');
  } catch (e) {}
  if (L !== 'tg') L = 'ru';
  window.SKLAD_LANG = L;
  document.documentElement.lang = L;
  var D = window.SKLAD_TG || {};
  var CY = /[А-Яа-яЁё]/;
  var CORE = /^([\s\S]*?)([А-Яа-яЁё][\s\S]*[А-Яа-яЁё]|[А-Яа-яЁё])([\s\S]*)$/;
  var missing = {};
  window.SKLAD_MISSING = missing;

  // Переводит один кусок текста: знаки и эмодзи по краям сохраняются, переводится «ядро» от первой до последней русской буквы
  function tx(seg) {
    if (!CY.test(seg)) return seg;
    var m = CORE.exec(seg);
    if (!m) return seg;
    var v = D[m[2]];
    if (v === undefined) { missing[m[2]] = 1; return seg; }
    return m[1] + v + m[3];
  }
  function attrs(tag) {
    return tag.replace(/(placeholder|title|aria-label|alt)="([^"]*)"/g, function (a, k, v) { return k + '="' + tx(v) + '"'; });
  }
  window.T = function (s) {
    if (L !== 'tg' || typeof s !== 'string') return s;
    if (s.indexOf('<') < 0 && s.indexOf('>') < 0) return tx(s);
    return s.split(/(<[^>]*>)/).map(function (p, i) { return i % 2 ? attrs(p) : tx(p); }).join('');
  };
  window.setLang = function (l) {
    try { localStorage.setItem('skladgo.lang', l === 'tg' ? 'tg' : 'ru'); } catch (e) {}
    location.reload();
  };

  // Запасной вариант для надписей из данных (названия категорий, цвета, «Все»…): переводим только если весь текст совпал со словарём
  if (L === 'tg') {
    var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, svg: 1, SVG: 1 };
    var conv = function (n) {
      if (n.nodeType === 3) {
        var par = n.parentNode; if (!par || SKIP[par.tagName] || !CY.test(n.nodeValue)) return;
        var m = CORE.exec(n.nodeValue);
        if (m && D[m[2]] !== undefined && D[m[2]] !== m[2]) n.nodeValue = m[1] + D[m[2]] + m[3];
      } else if (n.nodeType === 1 && !SKIP[n.tagName]) {
        if (n.hasAttribute && n.hasAttribute('placeholder')) { var pv = n.getAttribute('placeholder'), mm = CORE.exec(pv); if (mm && D[mm[2]] !== undefined) n.setAttribute('placeholder', mm[1] + D[mm[2]] + mm[3]); }
        for (var c = n.firstChild, nx; c; c = nx) { nx = c.nextSibling; conv(c); }
      }
    };
    var start = function () {
      new MutationObserver(function (ms) { ms.forEach(function (m) { if (m.type === 'characterData') conv(m.target); else m.addedNodes.forEach(conv); }); })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
      conv(document.body);
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }
  // Месяцы и даты на таджикском, если телефон их знает; иначе русские
  var LOC = 'ru-RU';
  try { if (L === 'tg' && Intl.DateTimeFormat.supportedLocalesOf(['tg-TJ']).length) LOC = 'tg-TJ'; } catch (e) {}
  window.SKLAD_LOC = LOC;
})();
