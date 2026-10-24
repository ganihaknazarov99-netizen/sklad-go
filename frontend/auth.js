// Вход, регистрация, подтверждение почты + связь программы (app.js) с сервером.
(function () {
  'use strict';
  var API = window.SKLAD_API || '';
  var TOKEN_KEY = 'skladgo.token';
  var $ = function (i) { return document.getElementById(i); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var token = null, user = null, started = false;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}

  var ERR = {
    bad_credentials: T('Неверная почта или пароль'), not_verified: T('Почта ещё не подтверждена'), email_taken: T('Эта почта уже зарегистрирована — нажмите «Войти»'),
    weak_password: T('Пароль: минимум 8 символов, должны быть буквы и цифры'), bad_email: T('Проверьте адрес почты'), name_required: T('Введите имя'), bad_phone: T('Проверьте номер телефона'),
    code_wrong: T('Неверный код'), code_expired: T('Код не найден или истёк — запросите новый'), code_locked: T('Слишком много неверных попыток — запросите новый код'),
    mail_failed: T('Не удалось отправить письмо с кодом. Попробуйте через минуту или напишите владельцу'), too_soon: T('Подождите минуту перед повторной отправкой'), rate_limited: T('Слишком много попыток, подождите немного'), owner_cannot_delete: T('Владелец не может удалить аккаунт'),
    unauthorized: T('Нужно войти заново'), forbidden: T('Нет доступа'), too_large: T('Данные слишком большие'), server_error: T('Ошибка сервера, попробуйте позже'), network: T('Нет связи с сервером')
  };
  function ApiError(code, status, extra) { this.code = code; this.status = status; this.extra = extra || {}; this.message = ERR[code] || (T('Ошибка: ') + code); }

  function request(method, path, body, opts) {
    opts = opts || {};
    var h = { 'Content-Type': 'application/json' };
    if (token && !opts.noAuth) h.Authorization = 'Bearer ' + token;
    if (opts.headers) for (var hk in opts.headers) h[hk] = opts.headers[hk];
    return fetch(API + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) return j;
        if (r.status === 401 && token && !opts.noAuth && path.indexOf('/api/auth/') !== 0) { dropSession(); }
        throw new ApiError(j.error || 'server_error', r.status, j);
      });
    }, function () { throw new ApiError('network', 0); });
  }
  function dropSession() { token = null; try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} if (started) location.reload(); else loginUI(); }
  function clearLocal() { try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('skladgo.') === 0) localStorage.removeItem(k); }); } catch (e) {} }

  /* ---------- Подключение базы к программе (интерфейс, который ждёт app.js) ---------- */
  var listeners = [], es = null, esTimer = null;
  function snapDoc(r, id) { var d = r.data; return { exists: !!r.exists, id: id, version: r.version == null ? null : r.version, data: function () { return d ? JSON.parse(JSON.stringify(d)) : d; }, metadata: {} }; }
  function snapCol(r) { return { docs: r.docs.map(function (x) { return { id: x.id, data: function () { return JSON.parse(JSON.stringify(x.data)); } }; }) }; }
  function fireOne(l) {
    request('GET', l.url).then(function (r) { l.next(l.col ? snapCol(r) : snapDoc(r, l.path.split('/')[1])); }, function (e) { if (l.err) l.err(e); });
  }
  function refreshAll() { listeners.forEach(fireOne); }
  function connectStream() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    request('POST', '/api/stream/ticket', {}).then(function (t) {
      es = new EventSource(API + '/api/stream?ticket=' + encodeURIComponent(t.ticket));
      es.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.c === 'staff') { refreshAll(); return; } // изменился доступ — обновим всё
        listeners.forEach(function (l) { if (l.col ? l.col === m.c : l.path === m.p) fireOne(l); });
      };
      es.onopen = refreshAll;
      es.onerror = function () { try { es.close(); } catch (e) {} es = null; clearTimeout(esTimer); esTimer = setTimeout(connectStream, 3000); };
    }, function () { clearTimeout(esTimer); esTimer = setTimeout(connectStream, 5000); });
  }
  function docRef(path) {
    var url = '/api/docs/' + path;
    return {
      get: function () { return request('GET', url).then(function (r) { return snapDoc(r, path.split('/')[1]); }); },
      set: function (d, o) { return request('PUT', url, { data: d }, o && o.ifMatch != null ? { headers: { 'If-Match': String(o.ifMatch) } } : undefined); },
      update: function (d) { return request('PATCH', url, { data: d }); },
      delete: function () { return request('DELETE', url); },
      onSnapshot: function (next, err) { var l = { path: path, url: url, next: next, err: err }; listeners.push(l); fireOne(l); return function () { listeners = listeners.filter(function (x) { return x !== l; }); }; }
    };
  }
  function colRef(name, opt) {
    opt = opt || {};
    var q = {
      orderBy: function (f, dir) { return colRef(name, Object.assign({}, opt, { f: f, dir: dir })); },
      limit: function (n) { return colRef(name, Object.assign({}, opt, { n: n })); },
      add: function (d) { return request('POST', '/api/collections/' + name, { data: d }); },
      onSnapshot: function (next, err) {
        var url = '/api/collections/' + name + '?orderBy=' + encodeURIComponent(opt.f || 't') + '&dir=' + (opt.dir || 'desc') + '&limit=' + (opt.n || 100);
        var l = { col: name, url: url, next: next, err: err }; listeners.push(l); fireOne(l);
        return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
      }
    };
    return q;
  }
  var DB = { doc: docRef, collection: function (n) { return colRef(n); } };
  window.claude = { use: function (n) {
    if (n === 'db') return Promise.resolve(DB);
    if (n === 'user') return Promise.resolve({ id: function () { return Promise.resolve(user.id); }, isOwner: function () { return Promise.resolve(user.role === 'owner'); }, canEdit: function () { return Promise.resolve(true); } });
    if (n === 'downloads') return Promise.resolve({ save: function (o) { return new Promise(function (res) {
      var b = new Blob([o.data], { type: /\.ics$/.test(o.filename) ? 'text/calendar;charset=utf-8' : 'text/plain;charset=utf-8' }), a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = o.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000); res();
    }); } });
    return Promise.resolve(null);
  } };
  window.skladAuth = {
    signOut: function () { return request('POST', '/api/auth/logout', {}).catch(function () {}).then(function () { token = null; clearLocal(); location.reload(); }); },
    deleteAccount: function (password) { return request('DELETE', '/api/me', { password: password }).then(function () { token = null; clearLocal(); location.reload(); }); }
  };

  /* ---------- Запуск программы ---------- */
  function startApp() {
    if (started) return; started = true;
    try { localStorage.setItem('skladgo.user', JSON.stringify(user)); } catch (e) {}
    try { localStorage.setItem('skladgo.me', JSON.stringify({ name: user.name, phone: user.phone || '', mail: user.email })); } catch (e) {}
    $('auth').style.display = 'none'; $('app').style.display = '';
    if (window.NO_BOT) $('nav').style.gridTemplateColumns = 'repeat(4,1fr)';
    connectStream();
    var s = document.createElement('script'); s.src = 'app.js'; document.body.appendChild(s);
  }
  function screen(h) { $('auth').style.display = 'block'; $('auth').innerHTML = '<div class="authbox"><div style="text-align:right;margin-bottom:-6px"><button class="link" id="lgs">' + (window.SKLAD_LANG === 'tg' ? T('Русский') : T('Тоҷикӣ')) + '</button></div><div class="brand"><img src="logo.svg" alt="Sklad Go"></div>' + h + '</div>'; $('lgs').onclick = function () { setLang(window.SKLAD_LANG === 'tg' ? 'ru' : 'tg'); }; $('app').style.display = 'none'; $('fab').style.display = 'none'; $('nav').innerHTML = ''; }
  function busy(btn, on) { btn.disabled = on; btn.style.opacity = on ? '.6' : ''; }
  function showErr(e) { var el = $('aerr'); if (el) el.textContent = (e && e.message) || T('Ошибка'); }
  function field(id, label, type, ph, extra) { return '<label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type + '" placeholder="' + esc(ph || '') + '" ' + (extra || '') + '>'; }

  function loginUI(msg, email) {
    screen(T('<p>Войдите в свой аккаунт или создайте новый.</p>') +
      field('ae', T('Почта'), 'email', 'name@gmail.com', 'inputmode="email" autocomplete="username"') + field('ap', T('Пароль'), 'password', '', 'autocomplete="current-password"') +
      '<div class="err" id="aerr">' + esc(msg || '') + T('</div><button class="go ac" id="ain">Войти</button><button class="link" id="aup">Создать аккаунт</button><br><button class="link" id="afg">Забыли пароль?</button>'));
    if (email) $('ae').value = email;
    $('ain').onclick = function () {
      var em = $('ae').value.trim(), pw = $('ap').value; if (!em || !pw) { showErr({ message: T('Введите почту и пароль') }); return; }
      busy(this, true);
      doLogin(em, pw).catch(function (e) { busy($('ain'), false); if (e.code === 'not_verified') { verifyUI(em, pw, true); } else showErr(e); });
    };
    $('ap').onkeydown = function (e) { if (e.key === 'Enter') $('ain').click(); };
    $('aup').onclick = registerUI; $('afg').onclick = function () { forgotUI($('ae').value.trim()); };
  }
  function doLogin(email, pw) {
    return request('POST', '/api/auth/login', { email: email, password: pw }, { noAuth: true }).then(function (r) {
      token = r.token; user = r.user; try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
      startApp();
    });
  }
  function registerUI(msg) {
    screen(T('<p>Регистрация. На почту придёт код из 6 символов для подтверждения.</p>') +
      field('rn', T('Имя'), 'text', T('Ваше имя'), 'autocomplete="name"') + field('rp', T('Телефон (необязательно)'), 'tel', '+992 …', 'inputmode="tel" autocomplete="tel"') +
      field('re', T('Почта (Gmail)'), 'email', 'name@gmail.com', 'inputmode="email" autocomplete="username"') + field('rw', T('Пароль (от 8 символов, буквы и цифры)'), 'password', '', 'autocomplete="new-password"') +
      '<div class="err" id="aerr">' + (typeof msg === 'string' ? esc(msg) : '') + T('</div><button class="go ac" id="rg">Зарегистрироваться</button><button class="link" id="rb">Уже есть аккаунт — войти</button>'));
    $('rb').onclick = function () { loginUI(); };
    $('rg').onclick = function () {
      var em = $('re').value.trim(), pw = $('rw').value; busy(this, true);
      var inviteCode = (/[?&#]invite=([A-Za-z0-9]+)/.exec(location.href) || [])[1] || '';
      request('POST', '/api/auth/register', { name: $('rn').value.trim(), phone: $('rp').value.trim(), email: em, password: pw, invite: inviteCode }, { noAuth: true })
        .then(function (r) { if (r.verify) verifyUI(em, pw, false); else doLogin(em, pw).catch(showErr); })
        .catch(function (e) { busy($('rg'), false); showErr(e); });
    };
  }
  function verifyUI(email, pw, needSend) {
    screen(T('<p>Мы отправили код на <b>') + esc(email) + T('</b>. Введите 6 символов из письма (проверьте «Спам»).</p>') +
      T('<input id="vc" maxlength="6" placeholder="КОД" autocomplete="one-time-code" style="text-transform:uppercase;letter-spacing:6px;font-size:22px;text-align:center">') +
      T('<div class="err" id="aerr"></div><button class="go ac" id="vb">Подтвердить</button><button class="link" id="vr">Отправить код ещё раз</button><br><button class="link" id="vx">Назад</button>'));
    if (needSend) request('POST', '/api/auth/resend', { email: email }, { noAuth: true }).catch(function () {});
    $('vb').onclick = function () {
      busy(this, true);
      request('POST', '/api/auth/verify', { email: email, code: $('vc').value.trim().toUpperCase() }, { noAuth: true })
        .then(function () { return pw ? doLogin(email, pw) : loginUI(T('Почта подтверждена — войдите'), email); })
        .catch(function (e) { busy($('vb'), false); showErr(e); });
    };
    $('vc').onkeydown = function (e) { if (e.key === 'Enter') $('vb').click(); };
    $('vr').onclick = function () { request('POST', '/api/auth/resend', { email: email }, { noAuth: true }).then(function () { $('aerr').textContent = T('Код отправлен ещё раз'); }, showErr); };
    $('vx').onclick = function () { loginUI('', email); };
  }
  function forgotUI(email) {
    screen(T('<p>Сброс пароля. Мы отправим код на почту.</p>') + field('fe', T('Почта'), 'email', 'name@gmail.com', 'inputmode="email"') +
      T('<div class="err" id="aerr"></div><button class="go ac" id="fs">Отправить код</button><button class="link" id="fb">Назад</button>'));
    if (email) $('fe').value = email;
    $('fb').onclick = function () { loginUI(); };
    $('fs').onclick = function () { var em = $('fe').value.trim(); busy(this, true); request('POST', '/api/auth/forgot', { email: em }, { noAuth: true }).then(function () { resetUI(em); }, function (e) { busy($('fs'), false); showErr(e); }); };
  }
  function resetUI(email) {
    screen(T('<p>Если такая почта есть, мы отправили код на <b>') + esc(email) + '</b>.</p>' +
      T('<input id="xc" maxlength="6" placeholder="КОД" style="text-transform:uppercase;letter-spacing:6px;font-size:22px;text-align:center">') + field('xw', T('Новый пароль (от 8 символов, буквы и цифры)'), 'password', '', 'autocomplete="new-password"') +
      T('<div class="err" id="aerr"></div><button class="go ac" id="xs">Сменить пароль</button><button class="link" id="xb">Назад</button>'));
    $('xb').onclick = function () { loginUI('', email); };
    $('xs').onclick = function () {
      busy(this, true);
      request('POST', '/api/auth/reset', { email: email, code: $('xc').value.trim().toUpperCase(), newPassword: $('xw').value }, { noAuth: true })
        .then(function () { loginUI(T('Пароль изменён — войдите'), email); }, function (e) { busy($('xs'), false); showErr(e); });
    };
  }

  // Старт: если есть сохранённая сессия — проверяем её
  if (token) {
    request('GET', '/api/me').then(function (r) { user = r.user; startApp(); }, function (e) {
      if (e.code === 'not_verified') { token = null; loginUI(T('Подтвердите почту и войдите')); } else if (e.code === 'network') {
        var cu = null; try { cu = JSON.parse(localStorage.getItem('skladgo.user')); } catch (x) {}
        if (cu && cu.id) { user = cu; startApp(); } // без интернета: открываем программу с данными, сохранёнными на телефоне
        else screen('<p>' + esc(e.message) + T('. Для первого входа нужен интернет.</p>'));
      } else loginUI();
    });
  } else loginUI();
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
})();
