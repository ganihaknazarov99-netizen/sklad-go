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
  var configured = !!(cfg.url && cfg.anonKey && String(cfg.url).indexOf('http') === 0);
  var sb = (configured && root.supabase)
    ? root.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;

  /* ---------- Ошибки ----------
     Приложению важны два кода: version_conflict (слить и повторить) и network (данные
     остаются на телефоне, отправим при связи). Остальное — обычная ошибка. */
  function err(e) {
    var m = (e && (e.message || e.error_description || e.details)) || '';
    if (/version_conflict/i.test(m)) return { code: 'version_conflict', message: m };
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

  /* ---------- Команда: staff ---------- */
  function staffRef(uid) {
    return {
      get: function () {
        return sb.from('staff').select('*').eq('uid', uid).maybeSingle().then(function (r) {
          var d = rows(r);
          return { exists: !!d, data: function () { return d; } };
        });
      },
      // Роль и статус при добавлении решает сервер (триггер staff_guard): первый вошедший —
      // владелец, остальные ждут подтверждения.
      set: function (o) { return sb.from('staff').insert(o).then(rows); },
      update: function (o) { return sb.from('staff').update(o).eq('uid', uid).then(rows); }
    };
  }

  /* ---------- Списки: staff и лента activity ----------
     Ключ строки: у сотрудника — uid, у записи ленты — id. На любое изменение перечитываем
     список целиком: он короткий, зато всегда совпадает с правами доступа. */
  var PK = { staff: 'uid', activity: 'id' };
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
      if (p[0] === 'staff') return staffRef(p[1]);
      return docRef(p[1] || p[0]);          // warehouse/main → 'main', warehouse/debts → 'debts'
    },
    collection: collection
  };

  var session = null;
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
  function signIn() {
    var to = location.href.split('#')[0].split('?')[0];
    return sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: to } });
  }
  function wipeLocal() {
    try {
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('skladgo.') === 0) localStorage.removeItem(k); });
      localStorage.removeItem('skladgo.v1');
    } catch (e) {}
  }
  if (sb) {
    root.skladAuth = {
      signIn: signIn,
      signOut: function () {
        return sb.auth.signOut().then(function () { wipeLocal(); location.reload(); });
      },
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
  function loginScreen(msg) {
    screen('<p>Склад и долги магазина — на всех ваших устройствах. Входите тем же Gmail, ' +
      'что и остальная команда: владелец подтвердит доступ.</p><div class="err" id="ae">' + (msg || '') + '</div>' +
      '<button class="go ac" id="gin">Войти через Google</button>');
    document.getElementById('gin').onclick = function () {
      this.disabled = true;
      this.textContent = 'Открываю Google…';
      var b = this;
      signIn().then(function (r) {
        if (r && r.error) { document.getElementById('ae').textContent = r.error.message || 'Не удалось войти'; b.disabled = false; b.textContent = 'Войти через Google'; }
      }, function () { document.getElementById('ae').textContent = 'Не удалось войти'; b.disabled = false; b.textContent = 'Войти через Google'; });
    };
  }
  function startApp() {
    var a = document.getElementById('auth'), app = document.getElementById('app');
    a.style.display = 'none';
    a.innerHTML = '';
    if (app) app.style.display = '';
    return loadJS('app.js');
  }

  /* ---------- Запуск ----------
     Нет настроек → демо. Есть настройки, но нет входа → экран входа.
     Есть вход → чистим данные чужого аккаунта на этом телефоне и запускаем программу. */
  function boot() {
    var bar = document.getElementById('demobar');
    if (!configured) {
      loadJS('demo.js').catch(function (e) { document.getElementById('app').textContent = e.message; });
      return;
    }
    if (bar) bar.style.display = 'none';

    if (!sb) {                                  // нет интернета при первом открытии
      startApp().then(function () { if (root.setSy) root.setSy('off'); });
      return;
    }
    sb.auth.getSession().then(function (r) {
      session = (r && r.data && r.data.session) || null;
      if (!session) { loginScreen(); return; }
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
      startApp();
    }, function () {
      session = null;
      startApp().then(function () { if (root.setSy) root.setSy('off'); });
    });

    sb.auth.onAuthStateChange(function (ev) {
      if (ev === 'SIGNED_IN' && !session) location.reload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
