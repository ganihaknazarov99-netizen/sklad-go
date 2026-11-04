/* Свой сервер Sklad Go на Railway (папка server/) вместо Supabase.
   backend.js разговаривает с ним теми же словами, что и с Supabase: sb.from(...).select().eq(),
   sb.rpc(...), sb.channel(...), sb.auth.*. Здесь эти слова переведены на адреса /api/... —
   поэтому всё остальное в backend.js (экран входа, работа без интернета, смена аккаунта)
   осталось как было. Включается в config.js: { api: '/api' }.
   Сервер на этом же сайте (Vercel пересылает /api и /auth на Railway), поэтому вход
   держится в закрытой cookie, и в телефоне никаких ключей нет. */
(function (root) {
  'use strict';

  root.skladServerClient = function (base) {
    base = String(base || '/api').replace(/\/$/, '');
    var authBase = base.replace(/\/api$/, '');

    // Ответ сервера → { data, error } как у Supabase. Сервер не ответил или ответил 5xx
    // (Railway перезапускается, Vercel не достучался) — это «нет связи»: данные остаются
    // на телефоне и уйдут позже, а не теряются как «ошибка»
    function call(method, path, body) {
      var o = { method: method, credentials: 'same-origin', headers: { 'X-Sklad': '1' } };
      if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
      return fetch(base + path, o).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status >= 500 || !j || (!('data' in j) && !j.error)) return { data: null, error: { message: 'network: сервер не ответил (' + r.status + ')' } };
          if (j.error) return { data: null, error: { message: j.error.message || '', code: j.error.code, status: r.status } };
          return { data: j.data, error: null };
        });
      }, function (e) {
        return { data: null, error: { message: 'network: ' + ((e && e.message) || 'fetch failed') } };
      });
    }

    /* ---------- Таблицы ---------- */
    // Поиск всегда по ключу строки: docs — id, staff — uid
    function from(table) {
      var q = { op: 'select', key: null, order: null, limit: null, body: undefined };
      var b = {
        select: function () { return b; },
        eq: function (f, v) { q.key = v; return b; },
        order: function (f, o) { q.order = f + '.' + (o && o.ascending === false ? 'desc' : 'asc'); return b; },
        limit: function (n) { q.limit = n; return b; },
        maybeSingle: function () { return b; },
        insert: function (o) { q.op = 'insert'; q.body = o; return b; },
        update: function (o) { q.op = 'update'; q.body = o; return b; },
        then: function (ok, bad) { return run().then(ok, bad); }
      };
      function run() {
        var key = q.key != null ? '/' + encodeURIComponent(q.key) : '';
        if (q.op === 'insert') return call('POST', '/' + table, q.body);
        if (q.op === 'update') return call('PATCH', '/' + table + key, q.body);
        var p = [];
        if (q.order) p.push('order=' + encodeURIComponent(q.order));
        if (q.limit) p.push('limit=' + q.limit);
        return call('GET', '/' + table + key + (p.length ? '?' + p.join('&') : ''));
      }
      return b;
    }

    /* ---------- Живые обновления ----------
       Сервер присылает только «изменилось то-то» — склад перечитывает это обычным запросом.
       Документ — с номером версии, которую уже видел: не изменился, значит, не гоняем его
       целиком. Сигнал мог потеряться (телефон спал, связь рвалась) — поэтому при
       переподключении, при возврате на экран и время от времени перечитываем всё сами. */
    var chans = [], es = null, timer = null;
    function deliver(s) {
      if (s.busy) { s.again = true; return; }
      s.busy = true;
      var done = function () { s.busy = false; if (s.again) { s.again = false; deliver(s); } };
      if (!s.id) { try { s.fn({}); } catch (e) {} done(); return; }
      call('GET', '/' + s.table + '/' + encodeURIComponent(s.id) + (s.ver != null ? '?v=' + s.ver : '')).then(function (r) {
        var d = r.data;
        if (d && !d.same) { s.ver = d.version; try { s.fn({ new: d }); } catch (e) {} }
        done();
      }, done);
    }
    function each(fn) { chans.forEach(function (c) { c.subs.forEach(fn); }); }
    function resync() { each(deliver); }
    function signal(m) {
      each(function (s) { if (s.table === m.t && (!s.id || s.id === m.id)) deliver(s); });
    }
    function live() {
      if (!timer) {
        // Сигналы идут — перечитываем раз в минуту на всякий случай; не идут — каждые 15 секунд
        var n = 0;
        timer = setInterval(function () { n++; if (!es || es.readyState !== 1 || n % 4 === 0) resync(); }, 15000);
        if (root.document && root.document.addEventListener) {
          root.document.addEventListener('visibilitychange', function () { if (chans.length && root.document.visibilityState === 'visible') resync(); });
        }
      }
      if (es || typeof root.EventSource !== 'function') return;
      es = new root.EventSource(base + '/events');
      var was = false;
      es.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m && m.t) signal(m); };
      es.onopen = function () { if (was) resync(); was = true; };
    }
    function channel() {
      var c = { subs: [] };
      c.on = function (kind, f, fn) {
        var id = /^id=eq\.(.+)$/.exec((f && f.filter) || '');
        c.subs.push({ table: f.table, id: id ? id[1] : null, fn: fn, ver: null });
        return c;
      };
      c.subscribe = function (st) {
        chans.push(c);
        live();
        if (st) setTimeout(function () { st('SUBSCRIBED'); }, 0);
        return c;
      };
      return c;
    }
    function removeChannel(c) {
      chans = chans.filter(function (x) { return x !== c; });
      if (!chans.length) {
        if (es) { es.close(); es = null; }
        if (timer) { clearInterval(timer); timer = null; }
      }
    }

    /* ---------- Вход ---------- */
    var auth = {
      getSession: function () {
        return call('GET', '/me').then(function (r) {
          // нет связи — пусть backend.js откроет склад из памяти телефона
          if (r.error && /^network/.test(r.error.message)) return { data: { session: null }, error: { name: 'AuthRetryableFetchError', message: r.error.message } };
          if (!r.data) return { data: { session: null }, error: null };
          return { data: { session: { user: { id: r.data.id, email: r.data.email || '', user_metadata: { full_name: r.data.name || '' } } } }, error: null };
        });
      },
      // Вход ведёт сервер: он отправит к Google (со списком аккаунтов) и вернёт сюда
      signInWithOAuth: function (o) {
        var to = '/';
        try { to = new URL((o && o.options && o.options.redirectTo) || root.location.href).pathname || '/'; } catch (e) {}
        root.location.assign(authBase + '/auth/google?to=' + encodeURIComponent(to));
        return Promise.resolve({ data: {}, error: null });
      },
      signOut: function () { return call('POST', '/logout').then(function (r) { return { error: r.error }; }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
    };

    return {
      from: from,
      rpc: function (name, args) { return call('POST', '/rpc/' + name, args || {}); },
      channel: channel,
      removeChannel: removeChannel,
      auth: auth
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
