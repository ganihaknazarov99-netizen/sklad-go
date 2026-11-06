/* Сервер для Sklad Go (Supabase). Приложение разговаривает с сервером так же, как раньше:
   db.doc('warehouse/main').get/set/onSnapshot, db.collection('staff'|'activity') — здесь это
   переведено на таблицы docs/staff/activity. Версия документа (version) и проверка ifMatch
   остались: при столкновении двух телефонов сервер отвечает version_conflict, а merge.js сливает.
   Пока config.js не заполнен — грузим демо-режим, данные остаются в браузере. */
(function (root) {
  'use strict';

  function loadJS(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('Не удалось загрузить ' + src)); };
      document.body.appendChild(s);
    });
  }
  root.skladLoadJS = loadJS;

  var cfg = root.SKLAD_CONFIG || {};
  // Свой сервер на Railway ({ api: '/api' }, backend-server.js) говорит так же, как Supabase,
  // поэтому дальше всё одинаково. Не загрузился его файл — это не демо, а «нет связи»
  // Библиотека Supabase больше не грузится со страницы: адрес с url+ключом без неё — это демо, а не падение
  var configured = !!cfg.api || !!(cfg.url && cfg.anonKey && String(cfg.url).indexOf('http') === 0 && root.supabase);
  var sb = cfg.api ? (root.skladServerClient ? root.skladServerClient(cfg.api) : null)
    : (configured && root.supabase)
      ? root.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
      : null;

  /* ---------- Ошибки ----------
     Приложению важны коды: version_conflict (слить и повторить), network (данные
     остаются на телефоне, отправим при связи) и отказы охраны долгов и истории
     склада — тогда записанное берём с сервера как есть. Остальное — обычная ошибка. */
  var ОТКАЗЫ = {
    debt_changed: 'Записанный долг нельзя изменить задним числом. Добавьте обратную запись',
    debt_vanished: 'Запись о долге нельзя удалить незаметно — она уходит в корзину',
    log_vanished: 'Запись в истории склада нельзя стереть задним числом. Исправьте пересчётом или новой записью'
  };
  function err(e) {
    var m = (e && (e.message || e.error_description || e.details)) || '';
    if (/version_conflict/i.test(m)) return { code: 'version_conflict', message: m };
    var отказ = /\b(debt_changed|debt_vanished|log_vanished)\b/.exec(m);
    if (отказ) return { code: отказ[1], message: ОТКАЗЫ[отказ[1]] };
    // Свой сервер: вход закрыт (сменили пароль, «выйти везде» на другом телефоне) — 401
    if (e && (e.status === 401 || e.code === 'not authenticated')) return { code: 'auth', message: m };
    if (!navigator.onLine || /fetch|network|timeout|connection|ECONN/i.test(m)) return { code: 'network', message: m };
    return { code: (e && e.code) || 'error', message: m };
  }
  function rows(r) { if (r.error) throw err(r.error); return r.data; }

  /* ---------- Склад и долги: docs ---------- */
  function snap(row) {
    return {
      exists: !!row,
      version: row && row.version != null ? Number(row.version) : null,
      data: function () { return row ? row.data : null; }
    };
  }
  function docRef(id) {
    var ref = {};
    ref.get = function () {
      return sb.from('docs').select('data,version').eq('id', id).maybeSingle().then(function (r) { return snap(rows(r)); });
    };
    ref.set = function (payload, opt) {
      var m = (opt && opt.ifMatch != null) ? opt.ifMatch : null;
      return sb.rpc('doc_set', { p_id: id, p_data: payload, p_if_match: m }).then(function (r) {
        return { version: Number(rows(r)) };
      });
    };
    ref.onSnapshot = function (cb, onerr) {
      ref.get().then(cb, function (e) { if (onerr) onerr(e); });
      var ch = sb.channel('doc-' + id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'id=eq.' + id }, function (p) {
          if (p && p.new && p.new.id) cb(snap(p.new));
        })
        .subscribe(function (st) { if ((st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') && onerr) onerr({ code: 'network', message: st }); });
      return function () { sb.removeChannel(ch); };
    };
    return ref;
  }

  /* ---------- Команда (staff) и покупатели (customers): строка по uid ---------- */
  function staffRef(uid, table) {
    table = table || 'staff';
    return {
      get: function () {
        return sb.from(table).select('*').eq('uid', uid).maybeSingle().then(function (r) {
          var d = rows(r);
          return { exists: !!d, data: function () { return d; } };
        });
      },
      // Роль и статус при добавлении решает сервер (триггер staff_guard): первый вошедший —
      // владелец, остальные ждут подтверждения.
      set: function (o) { return sb.from(table).insert(o).then(rows); },
      update: function (o) { return sb.from(table).update(o).eq('uid', uid).then(rows); }
    };
  }

  /* ---------- Списки: staff и лента activity ----------
     Ключ строки: у сотрудника — uid, у записи ленты — id. На любое изменение перечитываем
     список целиком: он короткий, зато всегда совпадает с правами доступа. */
  var PK = { staff: 'uid', activity: 'id', customers: 'uid' };
  function collection(name) {
    var ord = null, lim = null, q = {};
    q.orderBy = function (f, dir) { ord = { f: f, asc: dir !== 'desc' }; return q; };
    q.limit = function (n) { lim = n; return q; };
    q.add = function (o) { return sb.from(name).insert(o).then(rows); };
    q.onSnapshot = function (cb, onerr) {
      function pull() {
        var s = sb.from(name).select('*');
        if (ord) s = s.order(ord.f, { ascending: ord.asc });
        if (lim) s = s.limit(lim);
        return s.then(function (r) {
          if (r.error) { if (onerr) onerr(err(r.error)); return; }
          cb({
            docs: (r.data || []).map(function (x) {
              return { id: String(x[PK[name]]), data: function () { return x; } };
            })
          });
        });
      }
      pull();
      var ch = sb.channel('col-' + name)
        .on('postgres_changes', { event: '*', schema: 'public', table: name }, function () { pull(); })
        .subscribe(function (st) { if ((st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') && onerr) onerr({ code: 'network', message: st }); });
      return function () { sb.removeChannel(ch); };
    };
    return q;
  }

  var db = {
    doc: function (path) {
      var p = String(path).split('/');
      if (p[0] === 'staff' || p[0] === 'customers') return staffRef(p[1], p[0]);
      return docRef(p[1] || p[0]);          // warehouse/main → 'main', warehouse/debts → 'debts'
    },
    collection: collection
  };

  var session = null, lostP = null;
  var api = {
    db: function () { return Promise.resolve(sb && session ? db : null); },
    user: function () {
      if (!sb || !session) return Promise.resolve(null);
      return Promise.resolve({
        id: function () { return Promise.resolve(session.user.id); },
        // Владелец определяется на сервере, а не этим браузером.
        isOwner: function () { return sb.rpc('is_owner').then(function (r) { return !r.error && !!r.data; }, function () { return false; }); }
      });
    }
  };
  root.skladBackend = api;

  /* ---------- Вход ---------- */
  // prompt=select_account: Google каждый раз показывает список аккаунтов. Без этого он молча
  // входил в последний — и войти другим Gmail (продавцу на телефоне хозяина) было не выйти
  function signIn() {
    var to = location.href.split('#')[0].split('?')[0];
    return sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: to, queryParams: { prompt: 'select_account' } } });
  }
  function wipeLocal() {
    try {
      // язык — не данные аккаунта: после выхода продавец-таджик не должен оказаться на русском
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('skladgo.') === 0 && k !== 'skladgo.lang') localStorage.removeItem(k); });
      localStorage.removeItem('skladgo.v1');
    } catch (e) {}
  }
  if (sb) {
    root.skladAuth = {
      signIn: signIn,
      signOut: function () {
        return sb.auth.signOut().then(function () { wipeLocal(); location.reload(); });
      },
      // Выйти и сразу к выбору аккаунта Google. Данные этого аккаунта с телефона стираются, как при выходе
      switchAccount: function () {
        return sb.auth.signOut().then(function () { wipeLocal(); return signIn(); })
          .then(function (r) { if (r && r.error) location.reload(); }, function () { location.reload(); });
      },
      // Свой сервер умеет вход по почте и паролю: тем, кто входит через Google, — задать пароль
      setPassword: sb.auth.setPassword ? function (pass, current) {
        return sb.auth.setPassword(pass, current).then(function (r) {
          if (r.error) throw new Error(r.error.message || 'Не удалось сохранить');
          if (session) session.user.has_password = true;
        });
      } : undefined,
      /* Сервер ответил «нужно войти»: вход закрыли с другого устройства, а здесь есть
         неотправленное. Данные телефона не стираем — показываем вход. Войдёт тот же человек —
         программа дошлёт изменения сама (другой аккаунт, как и раньше, сотрёт их при входе).
         Вход на самом деле жив или нет связи проверить — false: программа просто повторит */
      lost: function () {
        if (lostP) return lostP;
        lostP = sb.auth.getSession().then(function (r) {
          if ((r && r.data && r.data.session) || noNet(r)) { lostP = null; return false; }
          session = null;
          loginScreen('Вход закрыт на другом устройстве. Войдите снова тем же аккаунтом — несохранённое на этом телефоне отправится само');
          return true;
        }, function () { lostP = null; return false; });
        return lostP;
      },
      hasPassword: function () { return !!(session && session.user.has_password); },
      hasTotp: function () { return !!(session && session.user.has_totp); },
      totpStart: sb.auth.totpStart ? function (pass) {
        return sb.auth.totpStart(pass).then(function (r) { if (r.error) throw new Error(r.error.message || 'Не удалось'); return r.data; });
      } : undefined,
      totpConfirm: sb.auth.totpConfirm ? function (code) {
        return sb.auth.totpConfirm(code).then(function (r) { if (r.error) throw new Error(r.error.message || 'Не удалось'); if (session) session.user.has_totp = true; });
      } : undefined,
      totpOff: sb.auth.totpOff ? function (pass) {
        return sb.auth.totpOff(pass).then(function (r) { if (r.error) throw new Error(r.error.message || 'Не удалось'); if (session) session.user.has_totp = false; });
      } : undefined,
      // Потеряли телефон — выйти везде. Этот телефон тоже выходит, его данные стираются, как при выходе
      logoutAll: sb.auth.logoutAll ? function () {
        return sb.auth.logoutAll().then(function (r) { if (r.error) throw new Error(r.error.message || 'Нет связи'); wipeLocal(); location.reload(); });
      } : undefined,
      deleteAccount: function () {
        return sb.rpc('delete_my_account').then(function (r) {
          if (r.error) throw new Error(/owner_cannot_delete/.test(r.error.message || '') ? 'Владелец не может удалить свой аккаунт' : 'Не удалось удалить аккаунт');
          wipeLocal();
          return sb.auth.signOut();
        }).then(function () { location.reload(); });
      }
    };
  }

  /* ---------- Экран входа ---------- */
  var LOGO_IMG = '<div class="brand"><img src="logo.svg" alt="Sklad Go"></div>';
  function screen(html) {
    var a = document.getElementById('auth'), app = document.getElementById('app');
    if (app) app.style.display = 'none';
    a.style.display = 'block';
    a.innerHTML = '<div class="authbox">' + LOGO_IMG + '<h1>Sklad <span>Go</span></h1>' + html + '</div>';
    return a;
  }
  // Если вход сорвался, Supabase возвращает человека на склад с ошибкой в адресе
  // (?error=… и #error=…). Раньше программа её молча проглатывала и снова показывала
  // кнопку «Войти» — и человек думал, что всё прошло, просто склад почему-то не открылся.
  // Текст из адреса на экран не переносим: ссылку с любым «описанием ошибки» может
  // прислать кто угодно. Узнаём ошибку и говорим своими словами.
  function authErrorFromUrl() {
    var q = new URLSearchParams((location.search || '').slice(1));
    var h = new URLSearchParams((location.hash || '').slice(1));
    var code = q.get('error') || h.get('error');
    if (!code) return '';
    var desc = q.get('error_description') || h.get('error_description') || '';
    if (/access_denied/i.test(code)) return 'Вход отменён. Нажмите «Войти через Google» ещё раз.';
    if (/exchange external code/i.test(desc)) {
      return 'Google не подтвердил вход. Попробуйте ещё раз через пару минут. ' +
        'Если повторится — скажите хозяину склада: у него неверно настроен вход через Google.';
    }
    return 'Не удалось войти через Google. Попробуйте ещё раз.';
  }
  function loginScreen(msg) {
    screen('<p>Склад и долги магазина — на всех ваших устройствах. Входите тем же Gmail, ' +
      'что и остальная команда: владелец подтвердит доступ.</p><div class="err" id="ae"></div>' +
      '<button class="go ac" id="gin">Войти через Google</button>' +
      // Регистрация — тот же вход через Google: аккаунт Supabase заводится сам, а имя и телефон
      // программа спросит сразу после входа. Отдельная кнопка — чтобы новичок не искал, где «зарегистрироваться»
      '<button class="go" id="greg" style="width:100%;margin-top:8px;background:var(--card);color:var(--tx);border:1px solid var(--bd)">Регистрация</button>' +
      '<p style="color:var(--mu);font-size:13px;margin:8px 2px 0">Новый в команде? Регистрация — это тот же вход через ваш Gmail: выберите почту, потом впишите имя и телефон. Владелец подтвердит доступ.</p>' +
      '<p style="text-align:center;margin:8px 0 0"><a href="https://accounts.google.com/signup" target="_blank" rel="noopener" style="color:var(--mu)">Нет Gmail? Создать бесплатно</a></p>' +
      '<div id="pwb"></div>' +
      // Google требует, чтобы со входа была видна политика конфиденциальности
      '<p style="text-align:center;margin-top:14px"><a href="privacy.html" style="color:var(--mu)">Конфиденциальность · Privacy</a></p>' +
      // язык выбирают ещё до входа: продавец может не читать по-русски. Названия не переводим
      (root.setLang ? '<p data-notr style="text-align:center;margin-top:6px"><button class="link" id="lgtg">Тоҷикӣ</button> · <button class="link" id="lgru">Русский</button></p>' : ''));
    if (root.setLang) {
      document.getElementById('lgtg').onclick = function () { if (root.SKLAD_LANG !== 'tg') root.setLang('tg'); };
      document.getElementById('lgru').onclick = function () { if (root.SKLAD_LANG !== 'ru') root.setLang('ru'); };
    }
    if (msg) document.getElementById('ae').textContent = msg;
    var go = function (b, label) {
      var fail = function (m) { document.getElementById('ae').textContent = m || 'Не удалось войти'; b.disabled = false; b.textContent = label; };
      b.disabled = true;
      b.textContent = 'Открываю Google…';
      signIn().then(function (r) { if (r && r.error) fail(r.error.message); }, function () { fail(); });
    };
    document.getElementById('gin').onclick = function () { go(this, 'Войти через Google'); };
    document.getElementById('greg').onclick = function () { go(this, 'Регистрация'); };
    pwBlock();
  }

  /* ---------- Вход по почте и паролю (только свой сервер) ----------
     Покупатели входят так: им Gmail магазина ни к чему. Сотрудник тоже может, а хозяин и
     продавцы, вошедшие через Google, задают пароль во вкладке «Команда» */
  var pwTab = 'in', pwRole = 'customer', pwCode = false, PWR = { customer: '🛍 Покупатель', staff: '👤 Сотрудник магазина' };
  function pwBlock() {
    var box = document.getElementById('pwb');
    if (!box || !cfg.api || !sb.auth.signInWithPassword) return;
    var $ = function (i) { return document.getElementById(i); }, up = pwTab === 'up', cust = pwRole === 'customer';
    box.innerHTML = '<div class="lbl" style="text-align:center;margin:18px 0 8px">или по почте и паролю</div>'
      + '<div class="seg2" id="pwt" style="margin-bottom:10px"><button type="button" data-v="in" class="' + (up ? '' : 'on') + '">Вход</button><button type="button" data-v="up" class="' + (up ? 'on' : '') + '">Регистрация</button></div>'
      + (up ? '<div class="two" id="pwr" style="margin-bottom:8px">' + Object.keys(PWR).map(function (k) {
          return '<button type="button" class="go" data-r="' + k + '" style="' + (k === pwRole ? 'background:var(--ac)' : 'background:var(--card);color:var(--tx);border:1px solid var(--bd)') + '">' + PWR[k] + '</button>';
        }).join('') + '</div>'
        + '<input id="pwn" autocomplete="name" placeholder="Имя">'
        + (cust ? '<input id="pwp" type="tel" inputmode="tel" autocomplete="tel" placeholder="Телефон: +992 90 111 22 33">'
          + '<small style="display:block;color:var(--mu);margin:-2px 0 8px">Тот номер, которым магазин записывает ваши долги. Вы увидите только свой долг — после того как магазин подтвердит.</small>'
          : '<small style="display:block;color:var(--mu);margin:-2px 0 8px">Сотрудника подтверждает владелец: после входа впишите телефон.</small>') : '')
      + '<input id="pwe" type="email" inputmode="email" autocomplete="email" placeholder="Почта">'
      + '<input id="pww" type="password" autocomplete="' + (up ? 'new-password' : 'current-password') + '" placeholder="' + (up ? 'Пароль — не короче 8 знаков' : 'Пароль') + '">'
      // второй шаг: 6 цифр из Google Authenticator — сервер попросит, если код включён
      + (!up && pwCode ? '<input id="pwc" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Код из приложения — 6 цифр">' : '')
      + '<button class="go" id="pwgo" type="button" style="width:100%;background:var(--card);color:var(--tx);border:1px solid var(--bd)">' + (up ? 'Создать аккаунт' : 'Войти по почте') + '</button>';
    [].forEach.call(document.querySelectorAll('#pwt [data-v]'), function (b) { b.onclick = function () { pwTab = b.dataset.v; pwCode = false; pwBlock(); }; });
    [].forEach.call(document.querySelectorAll('#pwr [data-r]'), function (b) {
      b.onclick = function () {
        var keep = { n: $('pwn').value, e: $('pwe').value };
        pwRole = b.dataset.r; pwBlock();
        $('pwn').value = keep.n; $('pwe').value = keep.e;
      };
    });
    var go = function () {
      var b = $('pwgo'), label = b.textContent, ae = $('ae');
      b.disabled = true; b.textContent = '…'; ae.textContent = '';
      var q = up ? sb.auth.signUp({ role: pwRole, name: $('pwn').value, phone: $('pwp') ? $('pwp').value : '', email: $('pwe').value, password: $('pww').value })
        : sb.auth.signInWithPassword({ email: $('pwe').value, password: $('pww').value, code: $('pwc') ? $('pwc').value : undefined });
      q.then(function (r) {
        if (!r || !r.error) { location.reload(); return; }
        if (!up && (r.error.code === 'need_code' || r.error.code === 'bad_code') && !pwCode) {
          // пароль верный — нужен код: показываем поле, почту и пароль не теряем
          var keep = { e: $('pwe').value, w: $('pww').value };
          pwCode = true; pwBlock();
          $('pwe').value = keep.e; $('pww').value = keep.w;
          $('ae').textContent = 'Введите 6 цифр из приложения Google Authenticator';
          $('pwc').focus();
          return;
        }
        ae.textContent = /^network/.test(r.error.message || '') ? 'Нет связи с сервером. Попробуйте ещё раз' : r.error.message;
        b.disabled = false; b.textContent = label;
        if (ae.scrollIntoView) ae.scrollIntoView({ block: 'center' });
      });
    };
    $('pwgo').onclick = go;
    $('pww').onkeydown = function (e) { if (e.key === 'Enter') go(); };
    if ($('pwc')) $('pwc').onkeydown = function (e) { if (e.key === 'Enter') go(); };
  }

  // Покупатель: вместо склада — его долг. Сервер отдаёт только его записи (public.my_debt)
  function startCustomer() {
    var shown = false;
    var go = function () {
      sb.rpc('my_debt').then(function (r) {
        var d = r && r.data;
        if (r.error || !d) {
          if (shown) return;                        // уже на экране — оставляем, обновим позже
          screen('<div class="empty">Нет связи с магазином. Проверьте интернет.</div><button class="go ac" id="cuRt" style="width:100%">Ещё раз</button>');
          document.getElementById('cuRt').onclick = go;
          return;
        }
        shown = true;
        root.SkladCustomer.render({ name: d.name || ((session.user.user_metadata || {}).full_name || ''), status: d.status, biz: d.biz, ownerPhone: d.owner_phone, person: d.person, ops: d.ops },
          { logout: function () { root.skladAuth.signOut(); }, refresh: go });
      });
    };
    go();
    // подтвердили или записали долг — экран обновится сам
    sb.channel('customer').on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, go)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, go).subscribe();
  }
  function startApp() {
    var a = document.getElementById('auth'), app = document.getElementById('app');
    a.style.display = 'none';
    a.innerHTML = '';
    if (app) app.style.display = '';
    return loadJS('app.js');
  }

  /* ---------- Приложение на телефоне ----------
     sw.js хранит копию программы: склад открывается и без интернета. Кнопку «Установить»
     программа показывает сама (вкладка «Команда»), если телефон её предлагает. */
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && root.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  if (root.addEventListener) {
    root.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); root.skladInstall = e; });
  }

  // Открыли склад без связи — работаем с тем, что в памяти телефона. Связь появилась —
  // перезапускаемся, чтобы войти и дослать изменения (но не посреди открытой формы)
  function offline() {
    startApp().then(function () { if (root.setSy) root.setSy('off'); });
    if (root.addEventListener) root.addEventListener('online', function again() {
      var ov = document.getElementById('ov');
      if (ov && ov.innerHTML) { setTimeout(again, 2000); return; }
      location.reload();
    }, { once: true });
  }
  // Ключ входа живёт час. Без интернета его не продлить — Supabase отвечает «нет сессии».
  // Раньше это открывало экран входа, и без связи склад было не открыть вовсе
  function noNet(r) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    var e = r && r.error;
    return !!e && /fetch|network|retryable/i.test((e.name || '') + ' ' + (e.message || ''));
  }
  function knownHere() { try { return !!localStorage.getItem('skladgo.uid'); } catch (e) { return false; } }

  /* ---------- Запуск ----------
     Нет настроек → демо. Есть настройки, но нет входа → экран входа.
     Есть вход → чистим данные чужого аккаунта на этом телефоне и запускаем программу. */
  function boot() {
    var bar = document.getElementById('demobar');
    if (cfg.mock) {
      loadJS('mock.js').catch(function (e) { document.getElementById('app').textContent = e.message; });
      return;
    }
    if (!configured) {
      loadJS('demo.js').catch(function (e) { document.getElementById('app').textContent = e.message; });
      return;
    }
    if (bar) bar.style.display = 'none';

    if (!sb) {                                  // нет интернета при первом открытии
      offline();
      return;
    }
    sb.auth.getSession().then(function (r) {
      session = (r && r.data && r.data.session) || null;
      if (!session && noNet(r) && knownHere()) { offline(); return; }
      if (!session) {
        var why = authErrorFromUrl();
        // Убираем ошибку из адреса: иначе она висела бы и после обновления страницы
        if (why && history.replaceState) history.replaceState(null, '', location.pathname);
        loginScreen(why);
        return;
      }
      // Чужой аккаунт на этом телефоне или остатки демо — стираем, иначе уедут на сервер.
      var prev = null, demo = null;
      try { prev = localStorage.getItem('skladgo.uid'); demo = localStorage.getItem('skladgo.demo.v1'); } catch (e) {}
      if (demo || (prev && prev !== session.user.id)) wipeLocal();
      try { localStorage.setItem('skladgo.uid', session.user.id); } catch (e) {}
      // Имя и Gmail из аккаунта Google — чтобы при первом входе форма была уже заполнена.
      try {
        if (!localStorage.getItem('skladgo.me') && !localStorage.getItem('skladgo.draft')) {
          var mt = session.user.user_metadata || {};
          localStorage.setItem('skladgo.draft', JSON.stringify({ name: mt.full_name || mt.name || '', phone: '', mail: session.user.email || '' }));
        }
      } catch (e) {}
      if (history.replaceState) history.replaceState(null, '', location.pathname);
      if (session.user.kind === 'customer') { startCustomer(); return; }
      startApp();
    }, function () {
      session = null;
      offline();
    });

    sb.auth.onAuthStateChange(function (ev) {
      if (ev === 'SIGNED_IN' && !session) location.reload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
