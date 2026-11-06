/* Тестовый режим Sklad Go (адрес с ?mock): регистрация и вход по почте и паролю —
   как владелец магазина или как покупатель. Всё живёт только в этом браузере:
   аккаунты здесь, а склад и долги — показательные (demo.js). Так оба входа можно
   проверить без Google и без сервера.

   Экраны те же, что в магазине: экран покупателя — customer.js, раздел «Покупатели»
   у хозяина — app.js. Здесь подменены только данные: аккаунты в этом браузере вместо
   сервера. Покупатель сам привязаться к чужим долгам не может: хозяин подтверждает его
   и выбирает, чьи это долги (подсказка — по телефону).

   Свой склад (config.js: { mock: true, own: true } — ссылка для друзей): сначала
   регистрация, потом пустой склад этого человека, без показательных товаров. Роль одна —
   хозяин, склад один на телефон. Хранится только в этом телефоне. */
(function (root) {
  'use strict';
  var ACC = 'skladgo.mock.accounts', SES = 'skladgo.mock.session';
  var ROLES = { owner: '🏪 Владелец магазина', customer: '🛍 Покупатель' };
  var MIN = 8;   // как на сервере
  var OWN = !!(root.SKLAD_CONFIG && root.SKLAD_CONFIG.own);

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
    if (String(o.password || '').length < MIN) return no('Пароль — не короче ' + MIN + ' знаков');
    if (accounts().some(function (x) { return x.email === email; })) return no('Аккаунт с этой почтой уже есть — войдите');
    // хозяин у магазина один, как и на настоящем сервере
    if (o.role === 'owner' && accounts().some(function (x) { return x.role === 'owner'; })) {
      return no(OWN ? 'На этом телефоне уже есть склад — войдите' : 'У магазина уже есть владелец. Зарегистрируйтесь как покупатель');
    }
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

  // Долг покупателя: только записи его человека из «Долгов» — как public.my_debt на сервере
  function customerDebt(acc, D) {
    var p = acc && acc.status === 'active' && acc.pid && ((D && D.people) || []).filter(function (x) { return x.id === acc.pid; })[0];
    if (!p) return null;
    var r = root.SkladCustomer.summarize((D.ops || []).filter(function (o) { return o.pid === p.id; }));
    r.person = p;
    return r;
  }

  /* ---------- Экран ---------- */
  function $(i) { return document.getElementById(i); }
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
    ['democlean', 'demoreset'].forEach(function (id) { if ($(id)) $(id).style.display = 'none'; });
    if (OWN) { b.firstChild.innerHTML = '<b>Свой склад</b> · хранится только в этом телефоне'; return; }
    b.firstChild.innerHTML = '<b>Тест</b> · аккаунты и данные только в этом браузере';
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
    if (OWN) role = 'owner';
    screen((OWN ? '<p>Склад и долги вашего магазина — бесплатно. Зарегистрируйтесь, чтобы начать: склад будет пустой и только ваш.</p>'
        : '<p>Тестовый вход: как владелец магазина или как покупатель. Без Google — по почте и паролю.</p>')
      + '<div class="seg2" id="mktab" style="margin-bottom:12px"><button type="button" data-v="in" class="' + (up ? '' : 'on') + '">Вход</button><button type="button" data-v="up" class="' + (up ? 'on' : '') + '">Регистрация</button></div>'
      + '<div class="err" id="ae"></div>'
      + (up
        ? (OWN ? '' : '<div class="lbl">Кто вы?</div><div class="two" id="mkrole" style="margin-bottom:8px">' + Object.keys(ROLES).map(function (k) {
            return '<button type="button" class="go" data-r="' + k + '" style="' + (k === role ? 'background:var(--ac)' : 'background:var(--card);color:var(--tx);border:1px solid var(--bd)') + '">' + ROLES[k] + '</button>';
          }).join('') + '</div>')
          + '<label for="mkn">Имя</label><input id="mkn" autocomplete="name" placeholder="' + (OWN ? 'Ваше имя' : 'Напр. Фируз') + '">'
          + '<label for="mkp">Телефон' + (role === 'customer' ? '' : ' (необязательно)') + '</label><input id="mkp" type="tel" inputmode="tel" autocomplete="tel" placeholder="+992 90 111 22 33">'
          + (role === 'customer' ? '<small style="display:block;color:var(--mu);margin:-2px 0 8px">Тот номер, которым магазин записывает ваши долги. Для проверки: 90 111 22 33 — это Фируз из показательных долгов (должен 300 сом).</small>' : '')
          + (OWN ? '<label for="mkb">Название магазина (необязательно)</label><input id="mkb" placeholder="Напр. Магазин Фируз">' : '')
          + '<label for="mke">Почта</label><input id="mke" type="email" inputmode="email" autocomplete="email" placeholder="name@gmail.com">'
          + '<label for="mkw">Пароль</label><input id="mkw" type="password" autocomplete="new-password" placeholder="Не короче 8 знаков">'
          + '<button class="go ac" id="mkgo" type="button" style="width:100%;margin-top:6px">Создать аккаунт</button>'
        : '<label for="mke">Почта</label><input id="mke" type="email" inputmode="email" autocomplete="email" placeholder="name@gmail.com">'
          + '<label for="mkw">Пароль</label><input id="mkw" type="password" autocomplete="current-password" placeholder="Пароль">'
          + '<button class="go ac" id="mkgo" type="button" style="width:100%;margin-top:6px">Войти</button>'
          + (accounts().length ? '' : '<small style="display:block;text-align:center;color:var(--mu);margin-top:8px">Аккаунтов ещё нет — начните с «Регистрации»</small>'))
      + (OWN ? '<small style="display:block;color:var(--mu);margin-top:10px">Склад хранится только в этом телефоне: на другом его не будет. Иногда сохраняйте резервную копию (вкладка «История»).</small>' : '')
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
      var biz = up && $('mkb') ? $('mkb').value.trim() : '';
      p.then(function (acc) { if (biz) bizName = biz; start(acc); }, function (e) { $('ae').textContent = e.message; b.disabled = false; b.textContent = label; });
    };
    $('mkgo').onclick = go;
    $('mkw').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    ($('mkn') || $('mke')).focus();
  }

  // Склад и долги — показательные: demo.js кладёт их в этот браузер при первом запуске.
  // Свой склад — без них: метку засева ставим, а показательные данные убираем. Кто уже вёл
  // свой склад здесь («Начать свой склад» прежней витрины), его товары не трогаем
  var bizName = '';
  function ownPrep(biz) {
    try {
      if (localStorage.getItem('skladgo.own') !== '1') {
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf('skladgo.') === 0 && !/^skladgo\.(lang|mockmode|mock\.)/.test(k)) localStorage.removeItem(k);
        });
      }
      localStorage.setItem('skladgo.demo.v1', '1');
      localStorage.setItem('skladgo.own', '1');
      if (biz && !localStorage.getItem('skladgo.v1')) localStorage.setItem('skladgo.v1', JSON.stringify({ items: [], log: [], cats: ['Одежда', 'Аксессуары', 'Хозтовары', 'Другое'], biz: biz }));
    } catch (e) {}
  }
  function seed() {
    root.SKLAD_MOCK = true;
    if (OWN) ownPrep(bizName);
    return root.skladDemoStart ? Promise.resolve() : root.skladLoadJS('demo.js');
  }

  function customerScreen(acc) {
    var D = get('skladgo.debts', { people: [], ops: [] }), shop = get('skladgo.v1', {}) || {};
    var owner = accounts().filter(function (x) { return x.role === 'owner'; })[0];
    var r = customerDebt(acc, D);
    root.SkladCustomer.render({
      name: acc.name, status: acc.status, biz: shop.biz || (owner ? owner.name : ''), ownerPhone: owner ? owner.phone : '',
      person: r ? { name: r.person.name } : null, ops: r ? r.ops : [],
    }, {
      logout: function () { logout(); location.reload(); },
      refresh: function () { customerScreen(current() || acc); },
    });
  }

  /* ---------- Владелец: покупатели в «Команде» ----------
     Раздел рисует app.js (custHtml) — здесь только данные из этого браузера */
  function custSync() {
    root.custList = accounts().filter(function (x) { return x.role === 'customer'; }).map(function (x) {
      return { uid: x.id, name: x.name, phone: x.phone, email: x.email, status: x.status, pid: x.pid };
    });
    root.custOn = true;
  }
  function ownerApp(acc) {
    seed().then(function () {
      try { localStorage.setItem('skladgo.me', JSON.stringify({ name: acc.name, phone: acc.phone, mail: acc.email })); } catch (e) {}
      var a = $('auth'); a.style.display = 'none'; a.innerHTML = '';
      $('app').style.display = '';
      var out = function () { logout(); location.reload(); };
      root.skladAuth = { signOut: out, switchAccount: out, deleteAccount: function () { return Promise.reject(new Error('Владелец не может удалить свой аккаунт')); } };
      return root.skladDemoStart();
    }).then(function () {
      root.custSet = function (uid, ch, done) {
        update(uid, ch.status === 'active' ? ch : { status: ch.status, pid: null });
        custSync();
        if (done) done();
        root.render();
      };
      if (!OWN) custSync();   // в своём складе покупателей нет: им негде зарегистрироваться
      root.render();
    });
  }

  function start(acc) {
    tab = 'in';
    if (OWN && acc.role !== 'owner') { logout(); loginScreen(); return; }
    if (acc.role === 'owner') ownerApp(acc);
    else seed().then(function () { customerScreen(acc); });
  }

  root.SkladMock = { signUp: signUp, login: login, current: current, logout: logout, update: update, accounts: accounts, customerDebt: customerDebt, normPhone: normPhone, ownPrep: ownPrep };

  if (typeof document === 'undefined' || !document.getElementById('auth')) return;   // проверка без страницы
  bar();
  var me = current();
  if (OWN && !me && !accounts().length) tab = 'up';   // новый человек — сразу регистрация
  if (me) start(me); else loginScreen();
})(typeof window !== 'undefined' ? window : globalThis);
