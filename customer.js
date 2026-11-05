/* Экран покупателя: только его долг магазину — остаток, срок, история, связь с магазином.
   Один и тот же экран и в магазине (данные — с сервера, public.my_debt), и в тестовом
   режиме (mock.js, данные — в этом браузере). Склада и чужих долгов здесь нет. */
(function (root) {
  'use strict';

  function $(i) { return document.getElementById(i); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // имена, название магазина и заметки — данные людей: переводчик экрана их не трогает
  function nt(s) { return '<span data-notr>' + esc(s) + '</span>'; }
  function money(n) { return (Math.round((+n || 0) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' сом'; }
  function ddate(s) { var p = String(s).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : s; }
  function dtime(t) { return new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }); }

  // Остаток и сроки по записям одного человека. give — магазин дал в долг, get — получил
  function summarize(ops) {
    ops = (ops || []).slice().sort(function (a, b) { return b.t - a.t; });
    var bal = Math.round(ops.reduce(function (s, o) { return s + (o.type === 'give' ? +o.amt : -o.amt); }, 0) * 100) / 100;
    var today = new Date().toISOString().slice(0, 10), late = '', next = '';
    if (bal > 0) ops.forEach(function (o) {
      if (o.type !== 'give' || !o.due) return;
      if (o.due < today) { if (!late || o.due < late) late = o.due; }
      else if (!next || o.due < next) next = o.due;
    });
    return { ops: ops, balance: bal === 0 ? 0 : bal, late: late, next: next };
  }

  // s: { name, status, biz, ownerPhone, person, ops }; h: { logout, refresh }
  function render(s, h) {
    var a = $('auth'), app = $('app');
    if (app) app.style.display = 'none';
    if ($('nav')) $('nav').innerHTML = '';
    if ($('fab')) $('fab').style.display = 'none';
    var biz = s.biz || 'магазин', x = '';
    if (s.status === 'blocked') {
      x = '<p>Здравствуйте, ' + nt(s.name) + '!</p><div class="empty">⛔ Магазин отклонил ваш аккаунт. Если это ошибка — свяжитесь с магазином.</div>';
    } else if (s.status !== 'active') {
      x = '<p>Здравствуйте, ' + nt(s.name) + '!</p><div class="empty">⏳ Магазин «' + nt(biz) + '» ещё не подтвердил ваш аккаунт. Как только подтвердит — здесь появится ваш долг.</div>'
        + '<button class="go ac" id="cuRf" type="button" style="width:100%">Проверить снова</button>';
    } else {
      x = '<p>Здравствуйте, ' + nt(s.name) + '! Магазин: <b>' + nt(biz) + '</b></p>';
      if (!s.person) x += '<div class="empty">Магазин подтвердил вас, но ещё не связал с записями о долгах.</div>';
      else {
        var r = summarize(s.ops), b = r.balance;
        x += '<div class="card" style="display:block;text-align:center;padding:16px"><small style="color:var(--mu)">' + (b > 0 ? 'Ваш долг магазину' : b < 0 ? 'Магазин должен вам' : 'Долгов нет') + '</small>'
          + '<div style="font-size:34px;font-weight:800;margin:4px 0;color:' + (b > 0 ? 'var(--out)' : b < 0 ? 'var(--in)' : 'var(--tx)') + '">' + (b ? money(Math.abs(b)) : '✓ 0 сом') + '</div>'
          + (r.late ? '<small style="color:var(--out);font-weight:700">⏰ Срок возврата прошёл: ' + ddate(r.late) + '</small>'
            : r.next ? '<small style="color:var(--mu)">Вернуть до ' + ddate(r.next) + '</small>' : '') + '</div>';
        x += '<div class="lbl">История</div>' + (r.ops.length ? r.ops.map(function (o) {
          return '<div class="log"><div><b>' + (o.type === 'give' ? '🛍 В долг' : '💵 Оплата') + '</b><small>' + nt(o.note || '') + (o.due && o.type === 'give' ? ' · вернуть до ' + ddate(o.due) : '') + '</small></div>'
            + '<span style="text-align:right"><b style="color:' + (o.type === 'give' ? 'var(--out)' : 'var(--in)') + '">' + (o.type === 'give' ? '+' : '−') + money(o.amt) + '</b><br><small style="color:var(--mu)">' + dtime(o.t) + '</small></span></div>';
        }).join('') : '<div class="empty">Записей пока нет</div>');
      }
      var dg = String(s.ownerPhone || '').replace(/\D/g, '');
      if (dg) {
        x += '<div class="two" style="margin-top:12px"><a class="go" style="background:var(--card);color:var(--tx);border:1px solid var(--bd);text-align:center;text-decoration:none" href="tel:+' + dg + '">📞 Позвонить</a>'
          + '<a class="go" style="background:#25d366;text-align:center;text-decoration:none" href="https://wa.me/' + dg + '" target="_blank" rel="noopener noreferrer">💬 WhatsApp</a></div>';
      }
    }
    x += '<button class="link" id="cuLo" type="button" style="display:block;margin:16px auto 0">Выйти</button>'
      + (root.setLang ? '<p data-notr style="text-align:center;margin-top:10px"><button class="link" id="cuTg" type="button">Тоҷикӣ</button> · <button class="link" id="cuRu" type="button">Русский</button></p>' : '');
    a.style.display = 'block';
    a.innerHTML = '<div class="authbox"><div class="brand"><img src="logo.svg" alt="Sklad Go"></div><h1>Sklad <span>Go</span></h1>' + x + '</div>';
    $('cuLo').onclick = h.logout;
    if ($('cuRf')) $('cuRf').onclick = h.refresh;
    if ($('cuTg')) {
      $('cuTg').onclick = function () { if (root.SKLAD_LANG !== 'tg') root.setLang('tg'); };
      $('cuRu').onclick = function () { if (root.SKLAD_LANG !== 'ru') root.setLang('ru'); };
    }
  }

  root.SkladCustomer = { summarize: summarize, render: render };
})(typeof window !== 'undefined' ? window : globalThis);
