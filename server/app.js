'use strict';
/* Сервер Sklad Go на Railway: то, что раньше делал Supabase.
   · Вход через Google. Сессия — случайный ключ в закрытой cookie (HttpOnly), в базе лежит
     только его отпечаток.
   · Данные. Каждый запрос идёт в базу от имени вошедшего (db.asUser), поэтому кто что
     видит и может — решают те же правила supabase/schema.sql. Сервер их не дублирует:
     он только не пускает без входа и пропускает в таблицы лишь известные поля.
   · Живые обновления. База шлёт сигнал «изменилось то-то» (srv.notify), сервер передаёт
     его всем открытым складам, а те перечитывают нужное обычным запросом.
   Ответы — как у Supabase: { data } или { error: { code, message } }, чтобы backend.js
   разбирал их так же, как раньше. */
const crypto = require('node:crypto');

const СЕССИЯ_ДНЕЙ = 180;
const ПРОДЛИТЬ_ЗА = 170;              // осталось меньше 170 дней — продлеваем до полных 180
const БОЛЬШЕ_НЕЛЬЗЯ = 5 * 1024 * 1024; // склад с историей — сотни килобайт; 5 МБ с запасом
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Что можно писать в таблицы. Остальные поля решает база (staff_guard, activity_guard),
// поэтому uid, owner, by и т.п. даже не передаём
const ТАБЛИЦЫ = {
  staff: { ключ: 'uid', порядок: ['t', 'name'], новое: ['name', 'phone', 'mail', 't'], правка: ['name', 'phone', 'mail', 'status', 't'] },
  activity: { ключ: 'id', порядок: ['t', 'id'], новое: ['txt'], правка: [] },
};
const ВЫЗОВЫ = ['doc_set', 'is_owner', 'is_active', 'delete_my_account'];
// Отказы правил базы — их текст программа знает (backend.js)
const ОТКАЗЫ = /\b(version_conflict|debt_changed|debt_vanished|log_vanished|owner_cannot_delete|blocked_cannot_delete|doc_id_locked|bad_doc|not authenticated)\b/;

function createApp(o) {
  const db = o.db;
  const pub = new URL(o.publicUrl || 'http://localhost:8080');
  const свои = new Set([pub.origin].concat(o.origins || []));
  const назад = pub.origin + '/auth/callback';
  const сейчас = o.now || Date.now;
  const log = o.log || ((...a) => console.error(...a));
  const слушатели = new Set();

  /* ---------- Ответы ---------- */
  function json(res, code, obj, head) {
    res.writeHead(code, Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    }, head || {}));
    res.end(JSON.stringify(obj));
  }
  const ok = (res, data) => json(res, 200, { data: data === undefined ? null : data });
  const нет = (res, code, kod, message) => json(res, code, { error: { code: kod, message } });
  function redirect(res, to) {
    res.writeHead(302, { location: to, 'cache-control': 'no-store' });
    res.end();
  }
  function cookie(res, name, value, maxAge, path) {
    const c = name + '=' + value + '; Path=' + path + '; Max-Age=' + maxAge + '; HttpOnly; Secure; SameSite=Lax';
    const was = res.getHeader('set-cookie');
    res.setHeader('set-cookie', (was ? [].concat(was) : []).concat(c));
  }
  function cookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return out;
  }
  const rnd = (n) => crypto.randomBytes(n || 32).toString('base64url');
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  // Куда вернуть после входа — только путь на этом же сайте
  const путь = (p) => (typeof p === 'string' && /^\/(?![/\\])/.test(p) ? p : '/');

  // В базе bigint — время в миллисекундах и версия документа. Драйвер отдаёт их строкой,
  // а программа ждёт число
  function числа(r) {
    if (!r) return r;
    ['t', 'version'].forEach((k) => { if (r[k] != null) r[k] = Number(r[k]); });
    if (r.id != null && typeof r.id === 'bigint') r.id = String(r.id);
    return r;
  }

  function fail(res, e) {
    if (e && e.status) return нет(res, e.status, 'bad_request', e.message);
    const m = String((e && e.message) || '');
    const отказ = ОТКАЗЫ.exec(m);
    if (отказ) {
      const k = отказ[1];
      const code = k === 'version_conflict' ? 409 : k === 'not authenticated' ? 401 : 422;
      return нет(res, code, k, k);
    }
    const c = String((e && e.code) || '');
    if (c === '42501') return нет(res, 403, 'forbidden', 'Нет доступа');   // в том числе правила RLS
    if (/^(22|23)/.test(c)) return нет(res, 400, 'bad_request', m);       // неверное значение
    log('Ошибка сервера:', e);
    return нет(res, 500, 'server', 'Ошибка сервера');
  }

  function body(req) {
    return new Promise((done, bad) => {
      const ch = [];
      let n = 0;
      req.on('data', (b) => {
        n += b.length;
        if (n > БОЛЬШЕ_НЕЛЬЗЯ) { bad(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); } else ch.push(b);
      });
      req.on('end', () => {
        try { done(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { bad(Object.assign(new Error('Неверный JSON'), { status: 400 })); }
      });
      req.on('error', bad);
    });
  }

  /* ---------- Кто спрашивает ---------- */
  async function who(req, res) {
    const t = cookies(req).sg_s;
    if (!t || t.length > 100) return null;
    const r = await db.base(
      `select u.id, u.email, u.name, extract(epoch from s.expires_at - now()) / 86400 as left_days
         from srv.sessions s join auth.users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now()`, [hash(t)]);
    if (!r[0]) return null;
    if (Number(r[0].left_days) < ПРОДЛИТЬ_ЗА) {
      await db.base(`update srv.sessions set expires_at = now() + interval '${СЕССИЯ_ДНЕЙ} days' where token_hash = $1`, [hash(t)]);
      cookie(res, 'sg_s', t, СЕССИЯ_ДНЕЙ * 86400, '/');
    }
    return { id: r[0].id, email: r[0].email, name: r[0].name, token: t };
  }
  // Писать можно только со своей страницы. Чужой сайт не поставит заголовок X-Sklad без
  // разрешения CORS, а мы его не даём; Origin, если браузер его прислал, должен быть наш
  function свой(req) {
    if (!req.headers['x-sklad']) return false;
    const og = req.headers.origin;
    return !og || свои.has(og);
  }

  /* ---------- Вход через Google ---------- */
  function google(req, res, u) {
    if (!o.googleId || !o.googleSecret) return redirect(res, '/?error=server_error');
    const state = rnd(24), verifier = rnd(48);
    const to = Buffer.from(путь(u.searchParams.get('to'))).toString('base64url');
    cookie(res, 'sg_o', state + '.' + verifier + '.' + to, 600, '/auth');
    const q = new URLSearchParams({
      client_id: o.googleId, redirect_uri: назад, response_type: 'code', scope: 'openid email profile', state,
      // каждый раз список аккаунтов: иначе Google молча входит в последний и другим Gmail не войти
      prompt: 'select_account',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?' + q);
  }

  // Ключ входа (id_token) приходит прямо от Google по защищённому соединению, а не из
  // браузера. Поэтому подпись можно не проверять (OpenID Connect Core, 3.1.3.7) — но чей
  // он, для кого и не просрочен ли, проверяем всегда
  function idToken(jwt) {
    const p = JSON.parse(Buffer.from(String(jwt).split('.')[1] || '', 'base64url').toString('utf8'));
    if (p.aud !== o.googleId) throw new Error('id_token: чужой aud');
    if (p.iss !== 'https://accounts.google.com' && p.iss !== 'accounts.google.com') throw new Error('id_token: чужой iss');
    if (!(p.exp * 1000 > сейчас())) throw new Error('id_token: просрочен');
    if (!p.sub) throw new Error('id_token: нет sub');
    return p;
  }

  // Тот же аккаунт Google — тот же человек. Перенесённые из Supabase узнаются по почте,
  // которую Google там уже подтвердил (google_sub у них пока пуст). Почту, которую Google
  // не подтвердил, не записываем: по ней хозяином не стать и чужое место не занять
  async function человек(p) {
    const sub = String(p.sub);
    const name = String(p.name || '').slice(0, 100);
    const mail = (p.email_verified === true || p.email_verified === 'true') && p.email ? String(p.email).trim().toLowerCase() : null;
    let r = await db.base(
      `update auth.users set name = case when $2 <> '' then $2 else name end, last_sign_in_at = now()
        where google_sub = $1 returning id`, [sub, name]);
    if (!r[0] && mail) {
      r = await db.base(
        `update auth.users set google_sub = $1, name = case when $2 <> '' then $2 else name end, last_sign_in_at = now()
          where lower(email) = $3 and google_sub is null and email_confirmed_at is not null returning id`, [sub, name, mail]);
    }
    if (!r[0]) {
      r = await db.base(
        `insert into auth.users (email, email_confirmed_at, google_sub, name, last_sign_in_at)
           values ($1, case when $1::text is null then null else now() end, $2, $3, now())
           on conflict (email) do nothing returning id`, [mail, sub, name]);
    }
    if (!r[0]) {   // почта уже у другой записи — войти можно, но без почты
      r = await db.base(`insert into auth.users (google_sub, name, last_sign_in_at) values ($1, $2, now()) returning id`, [sub, name]);
    }
    return r[0].id;
  }

  async function callback(req, res, u) {
    const [state, verifier, to64] = String(cookies(req).sg_o || '').split('.');
    cookie(res, 'sg_o', '', 0, '/auth');
    let to = '/';
    try { to = путь(Buffer.from(to64 || '', 'base64url').toString('utf8')); } catch (e) {}
    if (u.searchParams.get('error')) return redirect(res, '/?error=access_denied');
    if (!state || u.searchParams.get('state') !== state || !u.searchParams.get('code')) return redirect(res, '/?error=bad_state');
    let p;
    try {
      const r = await o.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: u.searchParams.get('code'), client_id: o.googleId, client_secret: o.googleSecret,
          redirect_uri: назад, grant_type: 'authorization_code', code_verifier: verifier,
        }).toString(),
      });
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.id_token) throw new Error('Google не выдал ключ: ' + (t.error || r.status));
      p = idToken(t.id_token);
    } catch (e) {
      log('Вход через Google:', e.message);
      // этот текст backend.js узнаёт: «у хозяина неверно настроен вход через Google»
      return redirect(res, '/?error=server_error&error_description=' + encodeURIComponent('Unable to exchange external code'));
    }
    const uid = await человек(p);
    const token = rnd(32);
    await db.base(`insert into srv.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${СЕССИЯ_ДНЕЙ} days')`, [hash(token), uid]);
    cookie(res, 'sg_s', token, СЕССИЯ_ДНЕЙ * 86400, '/');
    redirect(res, to);
  }

  async function выйти(res, me) {
    if (me) {
      await db.base('delete from srv.sessions where token_hash = $1', [hash(me.token)]);
      закрыть(me.id);
    }
    cookie(res, 'sg_s', '', 0, '/');
  }

  /* ---------- Живые обновления ---------- */
  function events(req, res, me) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const c = { res, uid: me.id };
    слушатели.add(c);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    // Раз в 10 минут склад переподключается сам — заодно сервер снова проверяет вход
    const end = setTimeout(() => res.end(), 10 * 60000);
    req.on('close', () => { clearInterval(ping); clearTimeout(end); слушатели.delete(c); });
  }
  function notify(payload) {
    for (const c of слушатели) c.res.write('data: ' + String(payload).replace(/\n/g, ' ') + '\n\n');
  }
  function закрыть(uid) {
    for (const c of слушатели) if (c.uid === uid) c.res.end();
  }

  /* ---------- Данные ---------- */
  function поля(o2, можно) {
    const k = [], v = [];
    можно.forEach((f) => {
      if (!o2 || o2[f] === undefined) return;
      k.push(f);
      v.push(f === 't' ? Math.round(Number(o2[f])) || 0 : String(o2[f] == null ? '' : o2[f]).slice(0, f === 'txt' ? 300 : 200));
    });
    return { k, v };
  }
  function порядок(u, т) {
    const [f, dir] = String(u.searchParams.get('order') || '').split('.');
    const col = т.порядок.includes(f) ? f : т.ключ;
    const lim = Math.min(Math.max(parseInt(u.searchParams.get('limit'), 10) || 500, 1), 500);
    return ' order by "' + col + '" ' + (dir === 'desc' ? 'desc' : 'asc') + ' limit ' + lim;
  }

  async function данные(req, res, u, me, вид, ключ) {
    const как = (fn) => db.asUser(me.id, fn);
    const m = req.method;

    if (вид === 'rpc') {
      if (m !== 'POST' || !ВЫЗОВЫ.includes(ключ)) return нет(res, 404, 'not_found', 'Нет такого вызова');
      const a = await body(req);
      if (ключ === 'doc_set') {
        if (typeof a.p_id !== 'string' || !a.p_data || typeof a.p_data !== 'object') return нет(res, 400, 'bad_request', 'Нужны p_id и p_data');
        const r = await как((q) => q('select public.doc_set($1, $2::jsonb, $3) as v',
          [a.p_id, JSON.stringify(a.p_data), a.p_if_match == null ? null : Number(a.p_if_match)]));
        return ok(res, Number(r[0].v));
      }
      const r = await как((q) => q('select public.' + ключ + '() as v'));
      if (ключ === 'delete_my_account') { await выйти(res, null); закрыть(me.id); return ok(res, null); }
      return ok(res, !!r[0].v);
    }

    if (вид === 'docs') {
      if (m !== 'GET' || !ключ) return нет(res, 404, 'not_found', 'Документ пишется через rpc/doc_set');
      const r = await как((q) => q('select id, data, version from public.docs where id = $1', [ключ]));
      const d = числа(r[0]) || null;
      // Телефон уже видел эту версию — не гоняем склад целиком ещё раз
      const v = u.searchParams.get('v');
      if (d && v != null && String(d.version) === v) return ok(res, { id: d.id, version: d.version, same: true });
      return ok(res, d);
    }

    const т = ТАБЛИЦЫ[вид];
    if (ключ && вид === 'staff' && !UUID.test(ключ)) return нет(res, 400, 'bad_request', 'Неверный uid');
    if (m === 'GET') {
      if (ключ) {
        const r = await как((q) => q(`select * from public.${вид} where "${т.ключ}" = $1`, [ключ]));
        return ok(res, числа(r[0]) || null);
      }
      const r = await как((q) => q(`select * from public.${вид}` + порядок(u, т)));
      return ok(res, r.map(числа));
    }
    const a = await body(req);
    if (m === 'POST' && !ключ) {
      const { k, v } = поля(a, т.новое);
      const sql = k.length
        ? `insert into public.${вид} (${k.map((f) => '"' + f + '"').join(', ')}) values (${k.map((_, i) => '$' + (i + 1)).join(', ')})`
        : `insert into public.${вид} default values`;
      await как((q) => q(sql, v));
      return ok(res, null);
    }
    if (m === 'PATCH' && ключ && т.правка.length) {
      const { k, v } = поля(a, т.правка);
      if (!k.length) return ok(res, null);
      await как((q) => q(`update public.${вид} set ${k.map((f, i) => '"' + f + '" = $' + (i + 2)).join(', ')} where "${т.ключ}" = $1`, [ключ].concat(v)));
      return ok(res, null);
    }
    return нет(res, 405, 'not_allowed', 'Так нельзя');
  }

  /* ---------- Адреса ---------- */
  async function handle(req, res) {
    try {
      const u = new URL(req.url, pub.origin);
      const p = u.pathname;
      if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
      if (p === '/auth/google' && req.method === 'GET') return google(req, res, u);
      if (p === '/auth/callback' && req.method === 'GET') return await callback(req, res, u);
      if (!p.startsWith('/api/')) return нет(res, 404, 'not_found', 'Нет такого адреса');
      if (req.method !== 'GET' && !свой(req)) return нет(res, 403, 'forbidden', 'Чужой запрос');

      const me = await who(req, res);
      if (p === '/api/me') return me ? ok(res, { id: me.id, email: me.email, name: me.name }) : нет(res, 401, 'not authenticated', 'Нужно войти');
      if (p === '/api/logout' && req.method === 'POST') { await выйти(res, me); return ok(res, null); }
      if (!me) return нет(res, 401, 'not authenticated', 'Нужно войти');
      if (p === '/api/events' && req.method === 'GET') return events(req, res, me);

      const m = /^\/api\/(rpc|docs|staff|activity)(?:\/([^/]+))?$/.exec(p);
      if (!m) return нет(res, 404, 'not_found', 'Нет такого адреса');
      return await данные(req, res, u, me, m[1], m[2] && decodeURIComponent(m[2]));
    } catch (e) {
      if (!res.headersSent) return fail(res, e);
      log('Ошибка после ответа:', e);
    }
  }

  return { handle, notify };
}

module.exports = { createApp };
