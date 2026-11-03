/* Язык программы: русский или тоҷикӣ. Словарь — tg.js: слева русская надпись, справа перевод.

   Лёгкая версия не оборачивает каждую надпись в коде (как полная — функцией T): она
   переводит экран целиком, после того как программа его нарисовала. Каждый текст на экране
   и подсказки в полях проходят через словарь: известные фразы заменяются целиком, длинные
   раньше коротких, и только как отдельные слова — «до» в «долг» не тронем.

   Данные не переводятся: в памяти и в базе всё по-русски, как было. Поэтому не трогаем
   поля ввода, текстовые поля и пункты списков без value — их текст программа читает как
   данные (категория товара). И всё, что внутри data-notr. */
(function () {
  'use strict';
  var ЯЗЫКИ = { ru: 1, tg: 1 };
  var L = 'ru';
  try {
    L = localStorage.getItem('skladgo.lang') || ((navigator.language || '').toLowerCase().indexOf('tg') === 0 ? 'tg' : 'ru');
  } catch (e) {}
  if (!ЯЗЫКИ[L]) L = 'ru';
  window.SKLAD_LANG = L;
  document.documentElement.lang = L;
  window.setLang = function (l) {
    try { localStorage.setItem('skladgo.lang', ЯЗЫКИ[l] ? l : 'ru'); } catch (e) {}
    location.reload();
  };

  var D = L === 'tg' ? (window.SKLAD_TG || {}) : {};
  var keys = Object.keys(D).filter(function (k) { return k && D[k] !== k; }).sort(function (a, b) { return b.length - a.length; });
  var BUK = 'A-Za-zА-Яа-яЁёҒғӢӣҚқӮӯҲҳҶҷ';
  var esc = function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var RX = keys.length ? new RegExp('(^|[^' + BUK + '])(' + keys.map(esc).join('|') + ')(?=[^' + BUK + ']|$)', 'g') : null;
  var CY = /[А-Яа-яЁё]/;
  var tr = function (s) {
    if (!RX || !s || !CY.test(s)) return s;
    return s.replace(RX, function (m, pre, k) { return pre + D[k]; });
  };
  window.trSklad = tr;
  if (!RX) return;

  // У полей ввода переводим только подсказку (placeholder) — то, что вписал человек, не трогаем
  var SKIP = { SCRIPT: 1, STYLE: 1, svg: 1, SVG: 1 };
  var FIELD = { INPUT: 1, TEXTAREA: 1 };
  var ATTR = ['placeholder', 'title', 'aria-label', 'alt'];
  var done = new WeakMap();      // что мы сами написали в узел — чтобы не переводить перевод
  var skip = function (el) {
    for (var p = el; p && p.nodeType === 1; p = p.parentNode) {
      if (SKIP[p.tagName] || (p.hasAttribute && p.hasAttribute('data-notr'))) return true;
      if (p.tagName === 'OPTION' && !p.hasAttribute('value')) return true;
    }
    return false;
  };
  var attrs = function (el) {
    ATTR.forEach(function (a) {
      if (!el.hasAttribute(a)) return;
      var v = el.getAttribute(a), mem = done.get(el) || {};
      if (mem[a] === v) return;
      var t = tr(v);
      mem[a] = t; done.set(el, mem);
      if (t !== v) el.setAttribute(a, t);
    });
  };
  var conv = function (n) {
    if (n.nodeType === 3) {
      if (!n.parentNode || done.get(n) === n.nodeValue || FIELD[n.parentNode.tagName] || skip(n.parentNode)) return;
      var t = tr(n.nodeValue);
      if (t !== n.nodeValue) n.nodeValue = t;
      done.set(n, n.nodeValue);
    } else if (n.nodeType === 1) {
      if (skip(n)) return;
      attrs(n);
      for (var c = n.firstChild, nx; c; c = nx) { nx = c.nextSibling; conv(c); }
    }
  };
  var start = function () {
    new MutationObserver(function (ms) {
      ms.forEach(function (m) {
        if (m.type === 'characterData') conv(m.target);
        else if (m.type === 'attributes') { if (!skip(m.target)) attrs(m.target); }
        else m.addedNodes.forEach(conv);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTR });
    conv(document.body);
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
