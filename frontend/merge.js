/* Слияние изменений «телефон ↔ сервер» (трёхстороннее): BASE — что было на сервере в прошлый раз,
   L — наши изменения (в т.ч. сделанные без интернета), R — что сейчас на сервере.
   Правила: чужие и свои добавления сохраняются; остатки складываются как разницы (+5 у меня и −3 у коллеги = +2);
   удаление побеждает только если с той стороны запись не менялась; в остальных спорах приоритет у наших правок. */
(function (root) {
  'use strict';
  function canon(x) {
    if (x === null || typeof x !== 'object') return JSON.stringify(x) + '';
    if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
    return '{' + Object.keys(x).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(x[k]); }).join(',') + '}';
  }
  function eq(a, b) { return canon(a) === canon(b); }
  function idx(a, kf) { var m = {}; (a || []).forEach(function (x) { var k = kf(x); if (!(k in m)) m[k] = x; }); return m; }

  function mergeFields(b, l, r) {
    var o = {}, ks = {};
    Object.keys(l).concat(Object.keys(r)).forEach(function (k) { ks[k] = 1; });
    Object.keys(ks).forEach(function (k) {
      var lv = l[k], rv = r[k], bv = b[k];
      if (eq(lv, rv)) o[k] = lv;
      else if (k === 'qty' && typeof lv === 'number' && typeof rv === 'number' && typeof bv === 'number') o[k] = bv + (lv - bv) + (rv - bv);
      else if (!eq(lv, bv)) o[k] = lv;      // мы меняли (или оба) — приоритет нашему
      else o[k] = rv;                        // меняли только на сервере
      if (o[k] === undefined) delete o[k];
    });
    return o;
  }

  function mergeList(B, L, R, kf, fm) {
    var mb = idx(B, kf), ml = idx(L, kf), mr = idx(R, kf), out = [], done = {};
    function pick(k) {
      var b = mb[k], l = ml[k], r = mr[k];
      if (l && r) {
        if (eq(l, r)) return l;
        if (!b) return r;
        var lc = !eq(l, b), rc = !eq(r, b);
        if (lc && !rc) return l;
        if (rc && !lc) return r;
        return fm ? fm(b, l, r) : mergeFields(b, l, r);
      }
      if (l) return (!b || !eq(l, b)) ? l : null;   // на сервере удалили: удаляем, если мы не меняли
      if (r) return (!b || !eq(r, b)) ? r : null;   // мы удалили: удаляем, если на сервере не меняли
      return null;
    }
    (L || []).concat(R || []).forEach(function (x) {
      var k = kf(x); if (done[k]) return; done[k] = 1;
      var v = pick(k); if (v) out.push(v);
    });
    return out;
  }

  var byId = function (x) { return x.id; };
  var logKey = function (x) { return [x.t, x.type, x.id, x.qty, x.by].join('|'); };

  function mergeMain(B, L, R) {
    B = B || {};
    var o = {};
    o.items = mergeList(B.items, L.items, R.items, byId, function (b, l, r) {
      var m = mergeFields(b, l, r);
      if (l.qty !== r.qty && typeof m.qty === 'number') m.ar = m.qty <= 0;
      return m;
    });
    o.log = mergeList(B.log, L.log, R.log, logKey).sort(function (a, b) { return b.t - a.t; });
    o.trash = mergeList(B.trash, L.trash, R.trash, byId).sort(function (a, b) { return a.t - b.t; }).slice(-100);
    var cs = (L.cats || []).slice();
    (R.cats || []).forEach(function (c) { if (cs.indexOf(c) < 0) cs.push(c); });
    o.cats = cs;
    o.biz = (L.biz || '') !== (B.biz || '') ? (L.biz || '') : (R.biz || '');
    o.cur = (L.cur || '') !== (B.cur || '') ? (L.cur || '') : (R.cur || '');
    return o;
  }
  function mergeDebts(B, L, R) {
    B = B || {};
    var o = {};
    o.people = mergeList(B.people, L.people, R.people, byId);
    o.ops = mergeList(B.ops, L.ops, R.ops, byId).sort(function (a, b) { return (a.at || a.t || 0) - (b.at || b.t || 0); });
    o.trash = mergeList(B.trash, L.trash, R.trash, byId).sort(function (a, b) { return a.t - b.t; }).slice(-100);
    return o;
  }
  var api = { eq: eq, mergeMain: mergeMain, mergeDebts: mergeDebts, mergeList: mergeList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SkladMerge = api;
})(typeof window !== 'undefined' ? window : globalThis);
