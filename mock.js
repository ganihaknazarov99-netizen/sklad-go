/* Тестовый режим Sklad Go (адрес с ?mock): регистрация и вход по почте и паролю —
   как владелец магазина или как покупатель. Всё живёт только в этом браузере:
   аккаунты здесь, а склад и долги — показательные (demo.js). Так оба входа можно
   проверить без Google и без сервера.

   Покупатель видит только свой долг. Сам привязаться к чужим долгам он не может:
   после регистрации владелец подтверждает его и выбирает, чьи это долги (подсказка —
   по телефону). На настоящем сервере это потом будет делать сервер, а не браузер. */
(function (root) {
  'use strict';
  var ACC = 'skladgo.mock.accounts', SES = 'skladgo.mock.session';
  var ROLES = { owner: '🏪 Владелец магазина', customer: '🛍 Покупатель' };

  /* ---------- Аккаунты ---------- */
  function get(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function put(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function accounts() { return get(ACC, []); }
  function hex(b) { return [].map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function rnd(n) { var a = new Uint8Array(n || 16); root.crypto.getRandomValues(a); return hex(a.buffer); }
  // Пароль не храним — только его отпечаток (PBKDF2, 100 000 повторов, у каждого своя соль)
  function hash(pass, salt) {
    var enc = new TextEncoder(), s = root.crypto && root.crypto.subtle;
    if (!s) return Promise.reject(new Error('Этот браузер не умеет защищать пароли. Откройте адрес через https или localhost'));
    return s.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, k, 256);
    }).then(hex);
  }
  function digits(p) { return String(p || '').replace(/\D/g, ''); }
  // 9 цифр — номер Таджикистана без кода
  function normPhone(p) { var d = digits(p); if (!d) return ''; if (d.length === 9) d = '992' + d; return '+' + d; }
  function normEmail(e) { return String(e || '').trim().toLowerCase(); }

  function signUp(o) {
    var email = normEmail(o.email), name = String(o.name || '').trim(), phone = normPhone(o.phone);
    var no = function (m) { return Promise.reject(new Error(m)); };
    if (!ROLES[o.role]) return no('Выберите: владелец магазина или покупатель');
    if (!name) return no('Впишите имя');
    if (o.role === 'customer' && digits(phone).length < 11) return no('Впишите телефон — по нему магазин найдёт ваши долги');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return no('Проверьте почту');
    if (String(o.password || '').length < 6) return no('Пароль — не короче 6 знаков');
    if (accounts().some(function (x) { return x.email === email; })) return no('Аккаунт с этой почтой уже есть — войдите');
    // хозяин у магазина один, как и на настоящем сервере
    if (o.role === 'owner' && accounts().some(function (x) { return x.role === 'owner'; })) return no('У магазина уже есть владелец. Зарегистрируйтесь как покупатель');
    var salt = rnd();
    return hash(String(o.password), salt).then(function (h) {
      var acc = { id: 'a' + rnd(6), role: o.role, name: name.slice(0, 60), phone: phone, email: email, salt: salt, hash: h,
        status: o.role === 'owner' ? 'active' : 'pending', pid: null, t: Date.now() };
      var a = accounts(); a.push(acc); put(ACC, a); put(SES, acc.id);
      return acc;
    });
  }
  function login(email, password) {
    email = normEmail(email);
    var acc = accounts().filter(function (x) { return x.email === email; })[0];
    // такой почты нет — отпечаток всё равно считаем: по времени ответа не понять, есть ли аккаунт
    return hash(String(password || ''), acc ? acc.salt : 'нет такого').then(function (h) {
      if (!acc || h !== acc.hash) throw new Error('Неверная почта или пароль');
      put(SES, acc.id);
      return acc;
    });
  }
  function current() { var id = get(SES, null); return accounts().filter(function (x) { return x.id === id; })[0] || null; }
  function logout() { put(SES, null); }
  function update(id, ch) {
    var a = accounts();
    a.forEach(function (x) { if (x.id === id) Object.keys(ch).forEach(function (k) { x[k] = ch[k]; }); });
    put(ACC, a);
  }

  /* ---------- Долг покупателя ----------
     Только записи его человека из «Долгов». На сервере это будет отдельный запрос,
     который отдаёт покупателю его строки: весь документ долгов ему не уйдёт */
  function customerDebt(acc, D) {
    var p = acc && acc.status === 'active' && acc.pid && ((D && D.people) || []).filter(function (x) { return x.id === acc.pid; })[0];
    if (!p) return null;
    var ops = (D.ops || []).filter(function (o) { return o.pid === p.id; }).sort(function (a, b) { return b.t - a.t; });
    var bal = Math.round(ops.reduce(function (s, o) { return s + (o.type === 'give' ? o.amt : -o.amt); }, 0) * 100) / 100;
    var today = new Date().toISOString().slice(0, 10), late = '', next = '';
    if (bal > 0) ops.forEach(function (o) {
      if (o.type !== 'give' || !o.due) return;
      if (o.due < today) { if (!late || o.due < late) late = o.due; }
      else if (!next || o.due < next) next = o.due;
    });
    return { person: p, ops: ops, balance: bal === 0 ? 0 : bal, late: late, next: next };
  }

  /* ---------- Экран ---------- */
  function $(i) { return document.getElementById(i); }
  function nt(s) { return '<span data-notr>' + esc(s) + '</span>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(n) { return (Math.round((+n || 0) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' сом'; }
  function ddate(s) { var p = String(s).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : s; }
  function dtime(t) { return new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  function screen(html) {
    var a = $('auth'), app = $('app');
    if (app) app.style.display = 'none';
    $('nav').innerHTML = ''; $('fab').style.display = 'none';
    a.style.display = 'block';
    a.innerHTML = '<div class="authbox"><div class="brand"><img src="logo.svg" alt="Sklad Go"></div><h1>Sklad <span>Go</span></h1>' + html + '</div>';
  }
  function bar() {
    var b = $('demobar');
    if (!b) return;
    b.style.display = '';
    b.firstChild.innerHTML = '<b>Тест</b> · аккаунты и данные только в этом браузере';
    ['democlean', 'demoreset'].forEach(function (id) { if ($(id)) $(id).style.display = 'none'; });
    if (!$('mkreset')) {
      b.lastChild.insertAdjacentHTML('beforeend', '<button id="mkreset" type="button">Сбросить тест</button> <button id="mkexit" type="button">Выйти из теста</button>');
    }
    $('mkreset').onclick = function () {
      if (this.dataset.ok !== '1') { this.dataset.ok = '1'; this.textContent = 'Аккаунты и данные сотрутся. Ещё раз'; return; }
      try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('skladgo.') === 0 && k !== 'skladgo.lang' && k !== 'skladgo.mockmode') localStorage.removeItem(k); }); } catch (e) {}
      location.reload();
    };
    $('mkexit').onclick = function () {
      try { localStorage.removeItem('skladgo.mockmode'); } catch (e) {}
      logout();
      location.href = location.pathname;
    };
  }
  function langLinks() {
    return root.setLang ? '<p data-notr style="text-align:center;margin-top:10px"><button class="link" id="lgtg" type="button">Тоҷикӣ</button> · <button class="link" id="lgru" type="button">Русский</button></p>' : '';
  }
  function bindLang() {
    if (!root.setLang || !$('lgtg')) return;
    $('lgtg').onclick = function () { if (root.SKLAD_LANG !== 'tg') root.setLang('tg'); };
    $('lgru').onclick = function () { if (root.SKLAD_LANG !== 'ru') root.setLang('ru'); };
  }

  var tab = 'in', role = 'owner';
  function loginScreen(msg) {
    var up = tab === 'up';
    screen('<p>Тестовый вход: как владелец магазина или как покупатель. Без Google — по почте и паролю.</p>'
      + '<div class="seg3" id="mktab" style="margin-bottom:12px"><button type="button" data-v="in" class="' + (up ? '' : 'on') + '">Вход</button><button type="button" data-v="up" class="' + (up ? 'on' : '') + '">Регистрация</button></div>'
      + '<div class="err" id="ae"></div>'
      + (up
        ? '<div class="lbl">Кто вы?</div><div class="two" id="mkrole" style="margin-bottom:8px">' + Object.keys(ROLES).map(function (k) {
            return '<button type="button" class="go" data-r="' + k + '" style="' + (k === role ? '' : 'background:var(--card);color:var(--tx);border:1px solid var(--bd)') + (k === role ? ';background:var(--ac)' : '') + '">' + ROLES[k] + '</button>';
          }).join('') + '</div>'
          + '<label for="mkn">Имя</label><input id="mkn" autocomplete="name" placeholder="Напр. Фируз">'
          + '<label for="mkp">Телефон' + (role === 'customer' ? '' : ' (необязательно)') + '</label><input id="mkp" type="tel" inputmode="tel" autocomplete="tel" placeholder="+992 90 111 22 33">'
          + (role === 'customer' ? '<small style="display:block;color:var(--mu);margin:-2px 0 8px">Тот номер, которым магазин записывает ваши долги. Для проверки: 90 111 22 33 — это Фируз из показательных долгов (должен 300 сом).</small>' : '')
          + '<label for="mke">Почта</label><input id="mke" type="email" inputmode="email" autocomplete="email" placeholder="name@gmail.com">'
          + '<label for="mkw">Пароль</label><input id="mkw" type="password" autocomplete="new-password" placeholder="Не короче 6 знаков">'
          + '<button class="go ac" id="mkgo" type="button" style="width:100%;margin-top:6px">Создать аккаунт</button>'
        : '<label for="mke">Почта</label><input id="mke" type="email" inputmode="email" autocomplete="email" placeholder="name@gmail.com">'
          + '<label for="mkw">Пароль</label><input id="mkw" type="password" autocomplete="current-password" placeholder="Пароль">'
          + '<button class="go ac" id="mkgo" type="button" style="width:100%;margin-top:6px">Войти</button>'
          + (accounts().length ? '' : '<small style="display:block;text-align:center;color:var(--mu);margin-top:8px">Аккаунтов ещё нет — начните с «Регистрации»</small>'))
      + langLinks());
    bindLang();
    if (msg) $('ae').textContent = msg;
    [].forEach.call(document.querySelectorAll('#mktab [data-v]'), function (b) { b.onclick = function () { tab = b.dataset.v; loginScreen(); }; });
    [].forEach.call(document.querySelectorAll('#mkrole [data-r]'), function (b) {
      b.onclick = function () {
        var keep = { n: $('mkn').value, p: $('mkp').value, e: $('mke').value };
        role = b.dataset.r; loginScreen();
        $('mkn').value = keep.n; $('mkp').value = keep.p; $('mke').value = keep.e;
      };
    });
    var go = function () {
      var b = $('mkgo'), label = b.textContent;
      b.disabled = true; b.textContent = '…'; $('ae').textContent = '';
      var p = up ? signUp({ role: role, name: $('mkn').value, phone: $('mkp').value, email: $('mke').value, password: $('mkw').value })
        : login($('mke').value, $('mkw').value);
      p.then(start, function (e) { $('ae').textContent = e.message; b.disabled = false; b.textContent = label; });
    };
    $('mkgo').onclick = go;
    $('mkw').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    ($('mkn') || $('mke')).focus();
  }

  // Склад и долги — показательные. demo.js кладёт их в этот браузер при первом запуске
  function seed() { root.SKLAD_MOCK = true; return root.skladDemoStart ? Promise.resolve() : root.skladLoadJS('demo.js'); }

  function customerScreen(acc) {
    var D = get('skladgo.debts', { people: [], ops: [] }), shop = get('skladgo.v1', {}) || {};
    var owner = accounts().filter(function (x) { return x.role === 'owner'; })[0];
    var biz = shop.biz || (owner ? owner.name : 'магазин');
    var foot = '<button class="link" id="mklo" type="button" style="display:block;margin:16px auto 0">Выйти</button>' + langLinks();
    if (acc.status === 'blocked') {
      screen('<p>Здравствуйте, ' + nt(acc.name) + '!</p><div class="empty">⛔ Магазин отклонил ваш аккаунт. Если это ошибка — свяжитесь с магазином.</div>' + foot);
    } else if (acc.status !== 'active') {
      screen('<p>Здравствуйте, ' + nt(acc.name) + '!</p><div class="empty">⏳ Магазин «' + nt(biz) + '» ещё не подтвердил ваш аккаунт. Как только подтвердит — здесь появится ваш долг.</div>'
        + '<button class="go ac" id="mkrf" type="button" style="width:100%">Проверить снова</button>' + foot);
      $('mkrf').onclick = function () { customerScreen(current() || acc); };
    } else {
      var r = customerDebt(acc, D), h = '<p>Здравствуйте, ' + nt(acc.name) + '! Магазин: <b>' + nt(biz) + '</b></p>';
      if (!r) h += '<div class="empty">Магазин подтвердил вас, но ещё не связал с записями о долгах.</div>';
      else {
        var b = r.balance;
        h += '<div class="card" style="display:block;text-align:center;padding:16px"><small style="color:var(--mu)">' + (b > 0 ? 'Ваш долг магазину' : b < 0 ? 'Магазин должен вам' : 'Долгов нет') + '</small>'
          + '<div style="font-size:34px;font-weight:800;margin:4px 0;color:' + (b > 0 ? 'var(--out)' : b < 0 ? 'var(--in)' : 'var(--tx)') + '">' + (b ? money(Math.abs(b)) : '✓ 0 сом') + '</div>'
          + (r.late ? '<small style="color:var(--out);font-weight:700">⏰ Срок возврата прошёл: ' + ddate(r.late) + '</small>'
            : r.next ? '<small style="color:var(--mu)">Вернуть до ' + ddate(r.next) + '</small>' : '') + '</div>';
        h += '<div class="lbl">История</div>' + (r.ops.length ? r.ops.map(function (o) {
          return '<div class="log"><div><b>' + (o.type === 'give' ? '🛍 В долг' : '💵 Оплата') + '</b><small>' + nt(o.note || '') + (o.due && o.type === 'give' ? ' · вернуть до ' + ddate(o.due) : '') + '</small></div>'
            + '<span style="text-align:right"><b style="color:' + (o.type === 'give' ? 'var(--out)' : 'var(--in)') + '">' + (o.type === 'give' ? '+' : '−') + money(o.amt) + '</b><br><small style="color:var(--mu)">' + dtime(o.t) + '</small></span></div>';
        }).join('') : '<div class="empty">Записей пока нет</div>');
      }
      if (owner && owner.phone) {
        var dg = digits(owner.phone);
        h += '<div class="two" style="margin-top:12px"><a class="go" style="background:var(--card);color:var(--tx);border:1px solid var(--bd);text-align:center;text-decoration:none" href="tel:+' + dg + '">📞 Позвонить</a>'
          + '<a class="go" style="background:#25d366;text-align:center;text-decoration:none" href="https://wa.me/' + dg + '" target="_blank" rel="noopener noreferrer">💬 WhatsApp</a></div>';
      }
      screen(h + foot);
    }
    $('mklo').onclick = function () { logout(); location.reload(); };
    bindLang();
  }

  /* ---------- Владелец: покупатели в «Команде» ---------- */
  function teamExtra() {
    var C = accounts().filter(function (x) { return x.role === 'customer'; });
    var people = (root.D && root.D.people) || [];
    var pd = C.filter(function (x) { return x.status === 'pending'; }), ac = C.filter(function (x) { return x.status === 'active'; });
    var h = '<div class="lbl">🛍 Покупатели (' + (pd.length + ac.length) + ')</div>';
    if (!pd.length && !ac.length) h += '<div class="empty">Покупатели появятся здесь после регистрации. Они увидят только свой долг</div>';
    pd.forEach(function (x) {
      var m = people.filter(function (p) { return p.phone && digits(p.phone) === digits(x.phone); })[0];
      h += '<div class="card" style="display:block"><div class="info"><b>⏳ ' + nt(x.name) + '</b><small>' + esc(x.phone) + ' · ' + esc(x.email) + '</small></div>'
        + '<select id="mkp_' + x.id + '" style="margin:8px 0"><option value="">Чьи это долги? — выберите человека</option>' + people.map(function (p) {
          return '<option value="' + p.id + '"' + (m && m.id === p.id ? ' selected' : '') + '>' + esc(p.name) + (p.phone ? ' · ' + esc(p.phone) : '') + '</option>';
        }).join('') + '</select>'
        + (m ? '<small style="color:var(--in)">✓ Телефон совпал с «' + nt(m.name) + '»</small>' : '<small style="color:var(--mu)">Телефон ни с кем в «Долгах» не совпал — проверьте, тот ли это человек</small>')
        + '<div class="two" style="margin-top:8px"><button class="go ac" type="button" data-mka="' + x.id + '">✓ Подтвердить</button><button class="go" type="button" data-mkb="' + x.id + '" style="background:var(--card);color:var(--out);border:1px solid var(--bd)">✕ Отклонить</button></div></div>';
    });
    ac.forEach(function (x) {
      var p = people.filter(function (q) { return q.id === x.pid; })[0];
      h += '<div class="card"><div class="info"><b>🛍 ' + nt(x.name) + '</b><small>' + esc(x.phone) + ' · видит долги: ' + (p ? nt(p.name) : '—') + '</small></div><button class="link del" type="button" data-mku="' + x.id + '">Отвязать</button></div>';
    });
    return h;
  }
  function teamBind() {
    var name = function (id) { var a = accounts().filter(function (x) { return x.id === id; })[0]; return a ? a.name : ''; };
    [].forEach.call(document.querySelectorAll('[data-mka]'), function (b) {
      b.onclick = function () {
        var id = b.dataset.mka, pid = $('mkp_' + id).value;
        if (!pid) { root.toast('⚠️ Выберите, чьи это долги'); return; }
        update(id, { status: 'active', pid: pid });
        root.logAct('подтвердил покупателя: ' + name(id));
        root.toast('✓ Покупатель подтверждён: ' + name(id));
        root.render();
      };
    });
    [].forEach.call(document.querySelectorAll('[data-mkb]'), function (b) {
      b.onclick = function () { update(b.dataset.mkb, { status: 'blocked', pid: null }); root.logAct('отклонил покупателя: ' + name(b.dataset.mkb)); root.render(); };
    });
    [].forEach.call(document.querySelectorAll('[data-mku]'), function (b) {
      b.onclick = function () {
        if (b.dataset.ok !== '1') { b.dataset.ok = '1'; b.textContent = 'Точно?'; return; }
        update(b.dataset.mku, { status: 'pending', pid: null }); root.logAct('отвязал покупателя: ' + name(b.dataset.mku)); root.render();
      };
    });
  }

  function ownerApp(acc) {
    seed().then(function () {
      try { localStorage.setItem('skladgo.me', JSON.stringify({ name: acc.name, phone: acc.phone, mail: acc.email })); } catch (e) {}
      var a = $('auth'); a.style.display = 'none'; a.innerHTML = '';
      $('app').style.display = '';
      var out = function () { logout(); location.reload(); };
      root.skladAuth = { signOut: out, switchAccount: out, deleteAccount: function () { return Promise.reject(new Error('Владелец не может удалить свой аккаунт')); } };
      root.skladTeamExtra = teamExtra;
      root.skladTeamBind = teamBind;
      return root.skladDemoStart();
    });
  }

  function start(acc) {
    tab = 'in';
    if (acc.role === 'owner') ownerApp(acc);
    else seed().then(function () { customerScreen(acc); });
  }

  root.SkladMock = { signUp: signUp, login: login, current: current, logout: logout, update: update, accounts: accounts, customerDebt: customerDebt, normPhone: normPhone };

  if (typeof document === 'undefined' || !document.getElementById('auth')) return;   // проверка без страницы
  bar();
  var me = current();
  if (me) start(me); else loginScreen();
})(typeof window !== 'undefined' ? window : globalThis);
