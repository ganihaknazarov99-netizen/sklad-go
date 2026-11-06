'use strict';
/* Сервер Sklad Go на Railway: то, что раньше делал Supabase.
   · Вход через Google или по почте и паролю. Сессия — случайный ключ в закрытой cookie
     (HttpOnly), в базе лежит только его отпечаток. От пароля — только отпечаток (scrypt).
   · Покупатели входят по почте и паролю и видят только свой долг (public.my_debt).
   · Данные. Каждый запрос идёт в базу от имени вошедшего (db.asUser), поэтому кто что
     видит и может — решают те же правила supabase/schema.sql. Сервер их не дублирует:
     он только не пускает без входа и пропускает в таблицы лишь известные поля.
   · Живые обновления. База шлёт сигнал «изменилось то-то» (srv.notify), сервер передаёт
     его всем открытым складам, а те перечитывают нужное обычным запросом.
   Ответы — как у Supabase: { data } или { error: { code, message } }, чтобы backend.js
   разбирал их так же, как раньше. */
const crypto = require('node:crypto');
const TOTP = require('./totp');

const СЕССИЯ_ДНЕЙ = 180;
const ПРОДЛИТЬ_ЗА = 170;              // осталось меньше 170 дней — продлеваем до полных 180
const БОЛЬШЕ_НЕЛЬЗЯ = 5 * 1024 * 1024; // склад с историей — сотни килобайт; 5 МБ с запасом
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Что можно писать в таблицы. Остальные поля решает база (staff_guard, activity_guard),
// поэтому uid, owner, by и т.п. даже не передаём
const ТАБЛИЦЫ = {
  staff: { ключ: 'uid', порядок: ['t', 'name'], новое: ['name', 'phone', 'mail', 't'], правка: ['name', 'phone', 'mail', 'status', 't'] },
  activity: { ключ: 'id', порядок: ['t', 'id'], новое: ['txt'], правка: [] },
  // статус и чьи долги (pid) меняет только хозяин — это держит customers_guard
  customers: { ключ: 'uid', порядок: ['t', 'name'], новое: ['name', 'phone'], правка: ['name', 'phone', 'status', 'pid'] },
};
const ВЫЗОВЫ = ['doc_set', 'is_owner', 'is_active', 'delete_my_account', 'my_debt'];
const ПАРОЛЬ_ОТ = 8, ПАРОЛЬ_ДО = 200;
const ПОПЫТОК = 10, ОКНО = 15 * 60000;   // неудачных входов с одного адреса на одну почту за 15 минут
// Отказы правил базы — их текст программа знает (backend.js)
const ОТКАЗЫ = /\b(version_conflict|debt_changed|debt_vanished|log_vanished|owner_cannot_delete|blocked_cannot_delete|doc_id_locked|bad_doc|not authenticated)\b/;

function createApp(o) {
  const db = o.db;
  const pub = new URL(o.publicUrl || 'http://localhost:8080');
  const свои = new Set([pub.origin].concat(o.origins || []));
  // Склад открывают с нескольких адресов (skladgo.com и прежний skladgo.vercel.app). После
  // Google человек должен вернуться туда, откуда пришёл: cookie входа у каждого адреса своя.
  // Страница говорит свой адрес сама (from) — берём его, только если он из нашего списка
  const откуда = (a) => (свои.has(a) ? a : pub.origin);
  const назад = (a) => откуда(a) + '/auth/callback';
  const сейчас = o.now || Date.now;
  const log = o.log || ((...a) => console.error(...a));
  const слушатели = new Set();
  const неудачи = new Map();   // ip|почта → [время неудачной попытки]
  // На http://127.0.0.1 (проверка на своём компьютере) cookie с Secure браузер не сохранит
  const secure = o.secureCookies === false ? '' : '; Secure';

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
    const c = name + '=' + value + '; Path=' + path + '; Max-Age=' + maxAge + '; HttpOnly' + secure + '; SameSite=Lax';
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
    const from = откуда(u.searchParams.get('from'));
    // адрес возврата запоминаем: обмен кода у Google должен назвать тот же самый
    cookie(res, 'sg_o', state + '.' + verifier + '.' + to + '.' + Buffer.from(from).toString('base64url'), 600, '/auth');
    const q = new URLSearchParams({
      client_id: o.googleId, redirect_uri: назад(from), response_type: 'code', scope: 'openid email profile', state,
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
    const [state, verifier, to64, from64] = String(cookies(req).sg_o || '').split('.');
    cookie(res, 'sg_o', '', 0, '/auth');
    let to = '/', from = '';
    try { to = путь(Buffer.from(to64 || '', 'base64url').toString('utf8')); } catch (e) {}
    try { from = Buffer.from(from64 || '', 'base64url').toString('utf8'); } catch (e) {}
    if (u.searchParams.get('error')) return redirect(res, '/?error=access_denied');
    if (!state || u.searchParams.get('state') !== state || !u.searchParams.get('code')) return redirect(res, '/?error=bad_state');
    let p;
    try {
      const r = await o.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: u.searchParams.get('code'), client_id: o.googleId, client_secret: o.googleSecret,
          redirect_uri: назад(from), grant_type: 'authorization_code', code_verifier: verifier,
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
    await сессия(res, uid);
    redirect(res, to);
  }
  async function сессия(res, uid) {
    const token = rnd(32);
    await db.base(`insert into srv.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${СЕССИЯ_ДНЕЙ} days')`, [hash(token), uid]);
    cookie(res, 'sg_s', token, СЕССИЯ_ДНЕЙ * 86400, '/');
  }

  /* ---------- Вход по почте и паролю ---------- */
  // scrypt: подбирать пароль по украденному отпечатку долго и дорого
  function отпечаток(pass, salt) {
    return new Promise((done, bad) => crypto.scrypt(String(pass), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? bad(e) : done(k))));
  }
  async function запароль(pass) {
    const salt = crypto.randomBytes(16).toString('hex');
    return 'scrypt$' + salt + '$' + (await отпечаток(pass, salt)).toString('hex');
  }
  async function верен(pass, stored) {
    const [kind, salt, h] = String(stored || 'scrypt$-$').split('$');
    const k = await отпечаток(pass, salt || '-');
    if (kind !== 'scrypt' || !h) return false;
    const want = Buffer.from(h, 'hex');
    return want.length === k.length && crypto.timingSafeEqual(want, k);
  }
  const ip = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  function много(key) {
    const t = сейчас(), L = (неудачи.get(key) || []).filter((x) => t - x < ОКНО);
    неудачи.set(key, L);
    return L.length >= ПОПЫТОК;
  }
  function неудача(key) {
    неудачи.set(key, (неудачи.get(key) || []).concat(сейчас()));
    if (неудачи.size > 10000) неудачи.clear();   // память сервера не забиваем
  }
  const почта = (e) => String(e || '').trim().toLowerCase();
  const цифры = (p) => String(p || '').replace(/\D/g, '');

  async function регистрация(req, res) {
    const a = await body(req);
    const mail = почта(a.email), name = String(a.name || '').trim().slice(0, 60), pass = String(a.password || '');
    const role = a.role === 'customer' ? 'customer' : 'staff';
    let phone = цифры(a.phone);
    if (phone.length === 9) phone = '992' + phone;
    if (!name) return нет(res, 400, 'bad_request', 'Впишите имя');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 200) return нет(res, 400, 'bad_request', 'Проверьте почту');
    if (pass.length < ПАРОЛЬ_ОТ || pass.length > ПАРОЛЬ_ДО) return нет(res, 400, 'bad_request', 'Пароль — не короче ' + ПАРОЛЬ_ОТ + ' знаков');
    if (role === 'customer' && phone.length < 11) return нет(res, 400, 'bad_request', 'Впишите телефон — по нему магазин найдёт ваши долги');
    const key = 'up|' + ip(req);
    if (много(key)) return нет(res, 429, 'rate_limited', 'Слишком много попыток. Подождите 15 минут');
    неудача(key);   // считаем и удачные: заводить аккаунты пачками с одного адреса незачем
    // почта, хоть раз виденная сервером, — уже чья-то: войти можно, завести второй аккаунт — нет
    const was = await db.base('select 1 from auth.users where lower(email) = $1', [mail]);
    if (was[0]) return нет(res, 409, 'exists', 'Аккаунт с этой почтой уже есть — войдите');
    let r;
    try {
      // почта не подтверждена: по ней не стать хозяином и не занять место человека, вошедшего через Google
      r = await db.base('insert into auth.users (email, name, pass_hash, last_sign_in_at) values ($1, $2, $3, now()) returning id', [mail, name, await запароль(pass)]);
    } catch (e) {
      if (e && e.code === '23505') return нет(res, 409, 'exists', 'Аккаунт с этой почтой уже есть — войдите');
      throw e;
    }
    const uid = r[0].id;
    if (role === 'customer') {
      await db.asUser(uid, (q) => q('insert into public.customers (name, phone) values ($1, $2)', [name, '+' + phone]));
    }
    await сессия(res, uid);
    return ok(res, { id: uid });
  }

  async function входПаролем(req, res) {
    const a = await body(req);
    const mail = почта(a.email), key = 'in|' + ip(req) + '|' + mail;
    if (много(key)) return нет(res, 429, 'rate_limited', 'Слишком много попыток. Подождите 15 минут');
    const r = await db.base('select id, pass_hash from auth.users where lower(email) = $1', [mail]);
    // нет такой почты — отпечаток всё равно считаем: по времени ответа не понять, есть ли аккаунт
    const good = await верен(a.password || '', r[0] && r[0].pass_hash);
    if (!r[0] || !r[0].pass_hash || !good) {
      неудача(key);
      return нет(res, 401, 'bad_login', 'Неверная почта или пароль');
    }
    // Второй шаг: код из приложения. Включён — без кода не пускаем. Хозяин без кода по паролю
    // не входит вовсе: у него есть Google с его подтверждением, а пароль один — лёгкая добыча
    const u = (await db.base('select totp_secret, totp_step from auth.users where id = $1', [r[0].id]))[0];
    if (u.totp_secret) {
      if (!String(a.code || '').trim()) return нет(res, 401, 'need_code', 'Введите код из приложения');
      const step = TOTP.verify(u.totp_secret, a.code, сейчас(), Number(u.totp_step));
      if (step === null) {
        неудача(key);
        return нет(res, 401, 'bad_code', 'Код не подходит. Введите новый код из приложения');
      }
      await db.base('update auth.users set totp_step = $2 where id = $1', [r[0].id, step]);
    } else if (await хозяин(r[0].id)) {
      return нет(res, 403, 'owner_needs_code', 'Хозяин входит по паролю только с кодом из приложения. Войдите через Google и включите код во вкладке «Команда»');
    }
    неудачи.delete(key);
    await db.base('update auth.users set last_sign_in_at = now() where id = $1', [r[0].id]);
    await сессия(res, r[0].id);
    return ok(res, { id: r[0].id });
  }
  async function хозяин(uid) {
    const r = await db.base('select owner from public.staff where uid = $1', [uid]);
    return !!(r[0] && r[0].owner);
  }
  // Включить и выключить код может только хозяин и только зная пароль: если кто-то завладел
  // его открытым телефоном, тихо подменить второй шаг не выйдет
  async function парольВерен(res, me, pass) {
    const r = await db.base('select pass_hash from auth.users where id = $1', [me.id]);
    if (!r[0] || !r[0].pass_hash) { нет(res, 400, 'no_password', 'Сначала задайте пароль для входа по почте'); return false; }
    const key = 'pw|' + me.id;
    if (много(key)) { нет(res, 429, 'rate_limited', 'Слишком много попыток. Подождите 15 минут'); return false; }
    if (!(await верен(pass || '', r[0].pass_hash))) { неудача(key); нет(res, 403, 'bad_login', 'Пароль не подходит'); return false; }
    return true;
  }
  async function код(req, res, me, what) {
    if (!(await хозяин(me.id))) return нет(res, 403, 'forbidden', 'Код из приложения — для хозяина');
    const a = await body(req);
    if (what === 'start') {
      if (!(await парольВерен(res, me, a.password))) return;
      const secret = TOTP.newSecret();
      await db.base('update auth.users set totp_pending = $2 where id = $1', [me.id, secret]);
      return ok(res, { secret, uri: TOTP.otpauthUri(secret, me.email || '') });
    }
    if (what === 'confirm') {
      const r = (await db.base('select totp_pending from auth.users where id = $1', [me.id]))[0];
      if (!r || !r.totp_pending) return нет(res, 400, 'bad_request', 'Начните заново: «Включить код»');
      const step = TOTP.verify(r.totp_pending, a.code, сейчас(), -1);
      if (step === null) return нет(res, 400, 'bad_code', 'Код не подходит. Проверьте, что время на телефоне верное, и введите новый код');
      await db.base('update auth.users set totp_secret = totp_pending, totp_pending = null, totp_step = $2 where id = $1', [me.id, step]);
      return ok(res, null);
    }
    if (!(await парольВерен(res, me, a.password))) return;
    await db.base('update auth.users set totp_secret = null, totp_pending = null, totp_step = -1 where id = $1', [me.id]);
    return ok(res, null);
  }

  // Задать или сменить пароль, будучи внутри. Был пароль — нужен прежний
  async function смена(req, res, me) {
    const a = await body(req), pass = String(a.password || '');
    if (pass.length < ПАРОЛЬ_ОТ || pass.length > ПАРОЛЬ_ДО) return нет(res, 400, 'bad_request', 'Пароль — не короче ' + ПАРОЛЬ_ОТ + ' знаков');
    const r = await db.base('select email, pass_hash from auth.users where id = $1', [me.id]);
    if (!r[0] || !r[0].email) return нет(res, 400, 'bad_request', 'У аккаунта нет почты — войти по паролю будет нельзя');
    if (r[0].pass_hash) {
      const key = 'pw|' + me.id;
      if (много(key)) return нет(res, 429, 'rate_limited', 'Слишком много попыток. Подождите 15 минут');
      if (!(await верен(a.current || '', r[0].pass_hash))) { неудача(key); return нет(res, 403, 'bad_login', 'Прежний пароль не подходит'); }
    }
    await db.base('update auth.users set pass_hash = $2 where id = $1', [me.id, await запароль(pass)]);
    // новый пароль — старые входы на других телефонах больше не действуют
    await db.base('delete from srv.sessions where user_id = $1 and token_hash <> $2', [me.id, hash(me.token)]);
    return ok(res, null);
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
      if (ключ === 'my_debt') return ok(res, r[0].v || null);
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
    if (ключ && (вид === 'staff' || вид === 'customers') && !UUID.test(ключ)) return нет(res, 400, 'bad_request', 'Неверный uid');
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
      if (p === '/auth/password/signup' || p === '/auth/password/login') {
        if (req.method !== 'POST') return нет(res, 405, 'not_allowed', 'Так нельзя');
        if (!свой(req)) return нет(res, 403, 'forbidden', 'Чужой запрос');
        return await (p === '/auth/password/signup' ? регистрация(req, res) : входПаролем(req, res));
      }
      if (!p.startsWith('/api/')) return нет(res, 404, 'not_found', 'Нет такого адреса');
      if (req.method !== 'GET' && !свой(req)) return нет(res, 403, 'forbidden', 'Чужой запрос');

      const me = await who(req, res);
      if (p === '/api/me') {
        if (!me) return нет(res, 401, 'not authenticated', 'Нужно войти');
        // покупатель или нет — от этого зависит, какой экран показать после входа
        const k = await db.base(`select exists (select 1 from public.customers where uid = $1) as c,
            (select pass_hash is not null from auth.users where id = $1) as pw,
            (select totp_secret is not null from auth.users where id = $1) as totp`, [me.id]);
        return ok(res, { id: me.id, email: me.email, name: me.name, kind: k[0].c ? 'customer' : 'staff', has_password: !!k[0].pw, has_totp: !!k[0].totp });
      }
      if (p === '/api/logout' && req.method === 'POST') { await выйти(res, me); return ok(res, null); }
      if (!me) return нет(res, 401, 'not authenticated', 'Нужно войти');
      if (p === '/api/events' && req.method === 'GET') return events(req, res, me);
      if (p === '/api/password' && req.method === 'POST') return await смена(req, res, me);
      const t = /^\/api\/totp\/(start|confirm|off)$/.exec(p);
      if (t && req.method === 'POST') return await код(req, res, me, t[1]);
      // Потеряли телефон — выйти везде, где был вход этого человека
      if (p === '/api/logout_all' && req.method === 'POST') {
        await db.base('delete from srv.sessions where user_id = $1', [me.id]);
        закрыть(me.id);
        cookie(res, 'sg_s', '', 0, '/');
        return ok(res, null);
      }

      const m = /^\/api\/(rpc|docs|staff|activity|customers)(?:\/([^/]+))?$/.exec(p);
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
