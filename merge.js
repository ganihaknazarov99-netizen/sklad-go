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
  function copy(x) { return JSON.parse(JSON.stringify(x)); }

  /* Сервер не принял правку записанного долга (debt_changed / debt_vanished).
     Слияние тут не поможет: оно сохранит нашу же правку, и сервер откажет снова.
     Поэтому всё, что на сервере уже записано, берём оттуда как есть, а своё новое —
     чего на сервере ещё нет — оставляем, чтобы отправить ещё раз. */
  function debtsServerWins(L, R) {
    L = L || {}; R = R || {};
    var srv = {}, srvTrash = {}, have = {}, live = {}, inTrash = {}, ppl = {};
    function opsOf(x) {
      if (!x) return [];
      if (x.k === 'op') return x.op ? [x.op] : [];
      if (x.k === 'person') return (x.ops || []).filter(Boolean);
      return [];
    }
    (R.ops || []).forEach(function (o) { if (o) srv[o.id] = o; });
    (R.trash || []).forEach(function (x) {
      if (!x) return;
      srvTrash[x.id] = x;
      opsOf(x).forEach(function (o) { srv[o.id] = o; });
    });
    var fix = function (o) { return o && srv[o.id] ? copy(srv[o.id]) : o; };

    var out = { people: (L.people || []).slice(), ops: (L.ops || []).map(fix), trash: [] };
    out.ops.forEach(function (o) { if (o) live[o.id] = 1; });
    // Своя корзина: что сервер уже знает — как на сервере, новое — с серверными долгами внутри
    (L.trash || []).forEach(function (x) {
      if (!x) return;
      var e = copy(srvTrash[x.id] || x);
      if (!srvTrash[x.id]) {
        if (e.k === 'op' && e.op) e.op = fix(e.op);
        if (e.k === 'person' && e.ops) e.ops = e.ops.map(fix);
      }
      have[e.id] = 1; out.trash.push(e);
    });
    // Корзина сервера, которой у нас нет: возвращаем, если её долги не вернулись в список
    (R.trash || []).forEach(function (x) {
      if (!x || have[x.id]) return;
      var ids = opsOf(x).map(function (o) { return o.id; });
      if (ids.length && ids.every(function (id) { return live[id]; })) return;   // мы её восстановили
      have[x.id] = 1; out.trash.push(copy(x));
    });
    out.trash.forEach(function (x) { opsOf(x).forEach(function (o) { inTrash[o.id] = 1; }); });
    // Долги сервера, которых у нас нет ни в списке, ни в корзине, — возвращаем
    (R.ops || []).forEach(function (o) {
      if (o && !live[o.id] && !inTrash[o.id]) { out.ops.push(copy(o)); live[o.id] = 1; }
    });
    // Человек, за которым остались долги, должен быть в списке — иначе их не видно
    out.people.forEach(function (p) { if (p) ppl[p.id] = 1; });
    (R.people || []).forEach(function (p) {
      if (p && !ppl[p.id] && out.ops.some(function (o) { return o && o.pid === p.id; })) { out.people.push(copy(p)); ppl[p.id] = 1; }
    });
    out.ops.sort(function (a, b) { return ((a && (a.at || a.t)) || 0) - ((b && (b.at || b.t)) || 0); });
    out.trash.sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
    return out;
  }

  /* То же для истории склада (log_vanished): записи, которые на сервере есть,
     берём оттуда как есть, свои новые оставляем. Ключ — как у сервера. */
  function logServerWins(L, R) {
    var key = function (x) { return [x.t, x.type, x.id, x.qty, x.sum].join('|'); };
    var srv = {}, have = {};
    (R || []).forEach(function (x) { if (x) srv[key(x)] = x; });
    var out = (L || []).filter(Boolean).map(function (x) { var k = key(x); have[k] = 1; return srv[k] ? copy(srv[k]) : x; });
    (R || []).forEach(function (x) { if (x && !have[key(x)]) { have[key(x)] = 1; out.push(copy(x)); } });
    return out.sort(function (a, b) { return b.t - a.t; });
  }

  var api = { eq: eq, mergeMain: mergeMain, mergeDebts: mergeDebts, mergeList: mergeList,
              debtsServerWins: debtsServerWins, logServerWins: logServerWins };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SkladMerge = api;
})(typeof window !== 'undefined' ? window : globalThis);
