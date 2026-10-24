'use strict';
const { HttpError } = require('./http');
const S = require('./security');
const TOTP = require('./totp');
const { newInvite } = require('./db');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();

function makeAuth(ctx) {
  const { db, cfg, mailer } = ctx;
  const broadcast = (c, p) => ctx.broadcast && ctx.broadcast(c, p);
  const loginByEmail = new S.Limiter(5, 15 * 60 * 1000);
  const loginByIp = new S.Limiter(30, 15 * 60 * 1000);
  const regByIp = new S.Limiter(10, 60 * 60 * 1000);
  const codeByIp = new S.Limiter(30, 15 * 60 * 1000);
  const totpByIp = new S.Limiter(20, 15 * 60 * 1000);

  /* Вход со вторым фактором идёт в два шага. Между ними пароль уже проверен,
     но сессии ещё нет — вместо неё короткий пропуск, живёт 5 минут и только в памяти.
     Перезапуск сервера его теряет: человек просто вводит пароль снова. */
  const half = new Map();
  const HALF_MS = 5 * 60 * 1000;
  function newHalf(userId) {
    const now = Date.now();
    for (const [k, v] of half) if (v.exp < now) half.delete(k);
    const t = S.newToken();
    half.set(t, { userId, exp: now + HALF_MS, tries: 0 });
    return t;
  }
  function takeHalf(pending) {
    const h = half.get(String(pending || ''));
    if (!h || h.exp < Date.now()) { half.delete(String(pending || '')); throw new HttpError(401, 'pending_expired'); }
    return h;
  }

  const audit = (user_id, action, detail) =>
    db.prepare('INSERT INTO audit(t,user_id,action,detail) VALUES(?,?,?,?)').run(Date.now(), user_id || '', action, detail || '');

  function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, status: u.role === 'owner' ? 'active' : u.status, verified: !!u.verified, totp: !!u.totp_on };
  }
  const byEmail = (email) => db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const byId = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

  async function issueCode(user, purpose) {
    const prev = db.prepare('SELECT sent_at FROM codes WHERE user_id=? AND purpose=?').get(user.id, purpose);
    if (prev && Date.now() - prev.sent_at < cfg.resendCooldownMs) throw new HttpError(429, 'too_soon');
    const code = S.newCode();
    db.prepare('INSERT OR REPLACE INTO codes(user_id,purpose,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,?,0,?)')
      .run(user.id, purpose, S.sha(user.id + ':' + purpose + ':' + code), Date.now() + cfg.codeTtlMs, Date.now());
    const what = purpose === 'verify' ? 'подтверждения почты' : 'сброса пароля';
    // Письмо не ушло (ключ, сеть, провайдер) — говорим об этом прямо, а не «ошибка сервера»
    try {
      await mailer.send(user.email, 'Sklad Go: код ' + what,
      `Ваш код ${what}: ${code}\n\nКод действует 15 минут. Если вы его не запрашивали, просто проигнорируйте письмо.`);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'mail_failed');
    }
  }
  function checkCode(user, purpose, code) {
    const row = db.prepare('SELECT * FROM codes WHERE user_id=? AND purpose=?').get(user.id, purpose);
    if (!row || row.expires_at < Date.now()) throw new HttpError(400, 'code_expired');
    if (row.attempts >= cfg.codeMaxAttempts) throw new HttpError(429, 'code_locked');
    db.prepare('UPDATE codes SET attempts=attempts+1 WHERE user_id=? AND purpose=?').run(user.id, purpose);
    const given = S.sha(user.id + ':' + purpose + ':' + String(code || '').trim().toUpperCase());
    if (!S.safeEqual(given, row.code_hash)) throw new HttpError(400, 'code_wrong');
    db.prepare('DELETE FROM codes WHERE user_id=? AND purpose=?').run(user.id, purpose);
  }
  function validatePassword(pw) {
    pw = String(pw || '');
    if (pw.length < 8 || pw.length > 200) throw new HttpError(400, 'weak_password');
    if (!/[A-Za-zА-Яа-я]/.test(pw) || !/[0-9]/.test(pw)) throw new HttpError(400, 'weak_password');
    return pw;
  }

  /* Запасные коды храним как хеши: из базы их не прочитать, даже украв её. */
  function issueBackup(userId, n = 8) {
    const codes = TOTP.newBackupCodes(n);
    db.prepare('DELETE FROM backup_codes WHERE user_id=?').run(userId);
    for (const c of codes) db.prepare('INSERT INTO backup_codes(user_id,code_hash,used_at) VALUES(?,?,NULL)').run(userId, S.sha(TOTP.normBackup(c)));
    return codes;
  }
  // Запасной код одноразовый: нашёлся — сразу гасим
  function useBackup(userId, given) {
    const h = S.sha(TOTP.normBackup(given));
    const row = db.prepare('SELECT * FROM backup_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL').get(userId, h);
    if (!row) return false;
    db.prepare('UPDATE backup_codes SET used_at=? WHERE user_id=? AND code_hash=?').run(Date.now(), userId, h);
    return true;
  }

  function createSession(user, req) {
    const token = S.newToken(), now = Date.now(), exp = now + cfg.sessionDays * 864e5;
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ua) VALUES(?,?,?,?,?)')
      .run(S.sha(token), user.id, now, exp, String(req.headers['user-agent'] || '').slice(0, 200));
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
    return { token, expiresAt: exp };
  }
  // Возвращает пользователя по заголовку Authorization: Bearer ... (или null)
  function authenticate(req) {
    const m = /^Bearer\s+([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(S.sha(m[1]));
    if (!s || s.expires_at < Date.now()) return null;
    const u = byId(s.user_id);
    if (!u) return null;
    u._token_hash = s.token_hash;
    return u;
  }
  function requireUser(req) {
    const u = authenticate(req);
    if (!u) throw new HttpError(401, 'unauthorized');
    if (cfg.requireVerify && !u.verified) throw new HttpError(403, 'not_verified');
    return u;
  }

  const handlers = {
    async register(req, body, ip) {
      if (!regByIp.hit(ip)) throw new HttpError(429, 'rate_limited');
      const email = normEmail(body.email);
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'bad_email');
      const password = validatePassword(body.password);
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) throw new HttpError(400, 'name_required');
      const phone = String(body.phone || '').trim();
      if (phone && !PHONE_RE.test(phone)) throw new HttpError(400, 'bad_phone');
      const now = Date.now();
      const existing = byEmail(email);
      if (existing) {
        // Незавершённую регистрацию (почта не подтверждена) можно начать заново; подтверждённый аккаунт — нет
        if (existing.verified || !cfg.requireVerify) throw new HttpError(409, 'email_taken');
        db.prepare('UPDATE users SET pass_hash=?,name=?,phone=?,updated_at=? WHERE id=?').run(S.hashPassword(password), name, phone, now, existing.id);
        await issueCode(existing, 'verify');
        return { ok: true, verify: true };
      }
      // Пришёл по ссылке-приглашению — попадает в тот магазин сотрудником.
      // Пришёл сам — заводит свой магазин и становится в нём владельцем.
      const invite = String(body.invite || '').trim().toUpperCase();
      let shop = null;
      if (invite) {
        shop = db.prepare('SELECT * FROM shops WHERE invite=?').get(invite);
        if (!shop) throw new HttpError(400, 'bad_invite');
      } else if (cfg.ownerEmail && email !== cfg.ownerEmail) {
        // сервер поднят под один магазин: чужие могут войти только по приглашению
        throw new HttpError(403, 'invite_required');
      }
      const isOwner = !shop;
      if (isOwner) {
        const sid = S.newId();
        db.prepare('INSERT INTO shops(id,name,invite,created_at) VALUES(?,?,?,?)')
          .run(sid, name ? 'Магазин ' + name : '', newInvite(), now);
        shop = { id: sid };
      }
      const id = S.newId();
      db.prepare('INSERT INTO users(id,email,pass_hash,name,phone,role,status,verified,created_at,updated_at,shop_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, email, S.hashPassword(password), name, phone, isOwner ? 'owner' : 'staff', isOwner ? 'active' : 'pending', cfg.requireVerify ? 0 : 1, now, now, shop.id);
      audit(id, 'register', isOwner ? 'owner' : 'staff');
      const user = byId(id);
      if (cfg.requireVerify) await issueCode(user, 'verify');
      broadcast('staff', 'staff/' + id);
      return { ok: true, verify: cfg.requireVerify };
    },
    async verify(req, body, ip) {
      if (!codeByIp.hit(ip)) throw new HttpError(429, 'rate_limited');
      const user = byEmail(normEmail(body.email));
      if (!user) throw new HttpError(400, 'code_wrong');
      checkCode(user, 'verify', body.code);
      db.prepare('UPDATE users SET verified=1,updated_at=? WHERE id=?').run(Date.now(), user.id);
      audit(user.id, 'verify', '');
      broadcast('staff', 'staff/' + user.id);
      return { ok: true };
    },
    async resend(req, body, ip) {
      if (!codeByIp.hit(ip)) throw new HttpError(429, 'rate_limited');
      const user = byEmail(normEmail(body.email));
      if (user && !user.verified) await issueCode(user, 'verify');
      return { ok: true }; // не раскрываем, есть ли такая почта
    },
    async login(req, body, ip) {
      const email = normEmail(body.email);
      if (!loginByIp.hit(ip) || !loginByEmail.hit(email)) throw new HttpError(429, 'rate_limited');
      const user = byEmail(email);
      const ok = S.verifyPassword(String(body.password || ''), user ? user.pass_hash : S.DUMMY_HASH) && !!user;
      if (!ok) { audit(user && user.id, 'login_fail', ip); throw new HttpError(401, 'bad_credentials'); }
      if (cfg.requireVerify && !user.verified) throw new HttpError(403, 'not_verified');
      loginByEmail.reset(email);
      // Пароль верен, но этого мало: просим код из аутентификатора
      if (user.totp_on) {
        audit(user.id, 'login_half', ip);
        return { needTotp: true, pending: newHalf(user.id) };
      }
      audit(user.id, 'login', ip);
      const s = createSession(user, req);
      return { token: s.token, expiresAt: s.expiresAt, user: publicUser(user) };
    },
    /* Второй шаг входа: шестизначный код из приложения или один запасной код. */
    async login2fa(req, body, ip) {
      if (!totpByIp.hit(ip)) throw new HttpError(429, 'rate_limited');
      const h = takeHalf(body.pending);
      if (++h.tries > 5) { half.delete(String(body.pending)); throw new HttpError(429, 'too_many_codes'); }
      const user = byId(h.userId);
      if (!user || !user.totp_on) throw new HttpError(401, 'unauthorized');
      const given = String(body.code || '').trim();

      let ok = false, backupLeft = null;
      const step = TOTP.verify(user.totp_secret, given, Date.now(), user.totp_step);
      if (step !== null) {
        db.prepare('UPDATE users SET totp_step=? WHERE id=?').run(step, user.id); // этот код больше не примем
        ok = true;
      } else if (useBackup(user.id, given)) {
        ok = true;
        backupLeft = db.prepare('SELECT COUNT(*) AS c FROM backup_codes WHERE user_id=? AND used_at IS NULL').get(user.id).c;
        audit(user.id, 'login_backup', ip);
      }
      if (!ok) { audit(user.id, 'totp_fail', ip); throw new HttpError(401, 'bad_code'); }

      half.delete(String(body.pending));
      audit(user.id, 'login', ip);
      const se = createSession(user, req);
      const out = { token: se.token, expiresAt: se.expiresAt, user: publicUser(user) };
      if (backupLeft !== null) out.backupLeft = backupLeft;
      return out;
    },
    async logout(req) {
      const u = authenticate(req);
      if (u) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(u._token_hash);
      return { ok: true };
    },
    async forgot(req, body, ip) {
      if (!codeByIp.hit(ip)) throw new HttpError(429, 'rate_limited');
      const user = byEmail(normEmail(body.email));
      if (user) { try { await issueCode(user, 'reset'); } catch (e) { if (!(e instanceof HttpError)) throw e; } }
      return { ok: true };
    },
    async reset(req, body, ip) {
      if (!codeByIp.hit(ip)) throw new HttpError(429, 'rate_limited');
      const user = byEmail(normEmail(body.email));
      if (!user) throw new HttpError(400, 'code_wrong');
      const pw = validatePassword(body.newPassword);
      // Второй фактор спрашиваем до кода с почты: иначе «забыл пароль» был бы
      // чёрным ходом мимо него, а неудачная попытка сжигала бы письмо зря.
      if (user.totp_on) {
        const ok = TOTP.verify(user.totp_secret, body.totp, Date.now(), user.totp_step) !== null || useBackup(user.id, body.totp);
        if (!ok) throw new HttpError(400, 'bad_code');
      }
      checkCode(user, 'reset', body.code);
      db.prepare('UPDATE users SET pass_hash=?,verified=1,updated_at=? WHERE id=?').run(S.hashPassword(pw), Date.now(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); // выкидываем со всех устройств
      audit(user.id, 'password_reset', '');
      return { ok: true };
    },
    /* ---------- Второй фактор ----------
       Пароль спрашиваем на каждом шаге: с украденной сессией нельзя ни включить
       второй фактор (и запереть хозяина), ни выключить его. */
    async totpSetup(req, body) {
      const u = requireUser(req);
      if (!S.verifyPassword(String(body.password || ''), u.pass_hash)) throw new HttpError(401, 'bad_credentials');
      if (u.totp_on) throw new HttpError(409, 'totp_already_on');
      const secret = TOTP.newSecret();
      db.prepare('UPDATE users SET totp_secret=?,totp_step=-1,updated_at=? WHERE id=?').run(secret, Date.now(), u.id);
      return { secret, uri: TOTP.otpauthUri(secret, u.email) };
    },
    async totpEnable(req, body, ip) {
      if (!totpByIp.hit(ip)) throw new HttpError(429, 'rate_limited');
      const u = requireUser(req);
      if (u.totp_on) throw new HttpError(409, 'totp_already_on');
      if (!u.totp_secret) throw new HttpError(409, 'totp_not_started');
      const step = TOTP.verify(u.totp_secret, body.code, Date.now(), u.totp_step);
      if (step === null) throw new HttpError(400, 'bad_code');
      // Окно не гасим: иначе человек включит второй фактор и тут же не сможет войти
      // своим же кодом — пришлось бы полминуты ждать у двери.
      db.prepare('UPDATE users SET totp_on=1,totp_step=-1,updated_at=? WHERE id=?').run(Date.now(), u.id);
      // Если кто-то уже сидел в аккаунте, второй фактор его не выгонит сам собой — выгоняем здесь
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id, u._token_hash);
      const codes = issueBackup(u.id);
      audit(u.id, 'totp_on', '');
      // Эти коды показываются один раз: на сервере остаются только хеши
      return { ok: true, backup: codes, user: publicUser(byId(u.id)) };
    },
    async totpDisable(req, body, ip) {
      if (!totpByIp.hit(ip)) throw new HttpError(429, 'rate_limited');
      const u = requireUser(req);
      if (!S.verifyPassword(String(body.password || ''), u.pass_hash)) throw new HttpError(401, 'bad_credentials');
      if (!u.totp_on) return { ok: true, user: publicUser(u) };
      const ok = TOTP.verify(u.totp_secret, body.code, Date.now(), u.totp_step) !== null || useBackup(u.id, body.code);
      if (!ok) throw new HttpError(400, 'bad_code');
      db.prepare("UPDATE users SET totp_on=0,totp_secret='',totp_step=-1,updated_at=? WHERE id=?").run(Date.now(), u.id);
      db.prepare('DELETE FROM backup_codes WHERE user_id=?').run(u.id);
      audit(u.id, 'totp_off', '');
      return { ok: true, user: publicUser(byId(u.id)) };
    },
    // Запасные коды кончились или разошлись по чужим рукам — выдаём новый набор
    async totpBackup(req, body) {
      const u = requireUser(req);
      if (!S.verifyPassword(String(body.password || ''), u.pass_hash)) throw new HttpError(401, 'bad_credentials');
      if (!u.totp_on) throw new HttpError(409, 'totp_off');
      audit(u.id, 'totp_backup_new', '');
      return { backup: issueBackup(u.id) };
    },
    async me(req) { return { user: publicUser(requireUser(req)) }; },
    async updateMe(req, body) {
      const u = requireUser(req), name = String(body.name == null ? u.name : body.name).trim().slice(0, 80);
      const phone = String(body.phone == null ? u.phone : body.phone).trim();
      if (!name) throw new HttpError(400, 'name_required');
      if (phone && !PHONE_RE.test(phone)) throw new HttpError(400, 'bad_phone');
      db.prepare('UPDATE users SET name=?,phone=?,updated_at=? WHERE id=?').run(name, phone, Date.now(), u.id);
      broadcast('staff', 'staff/' + u.id);
      return { user: publicUser(byId(u.id)) };
    },
    async changePassword(req, body) {
      const u = requireUser(req);
      if (!S.verifyPassword(String(body.oldPassword || ''), u.pass_hash)) throw new HttpError(401, 'bad_credentials');
      const pw = validatePassword(body.newPassword);
      db.prepare('UPDATE users SET pass_hash=?,updated_at=? WHERE id=?').run(S.hashPassword(pw), Date.now(), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id, u._token_hash);
      audit(u.id, 'password_change', '');
      return { ok: true };
    },
    async deleteMe(req, body) {
      const u = requireUser(req);
      if (u.role === 'owner') throw new HttpError(409, 'owner_cannot_delete');
      if (!S.verifyPassword(String(body.password || ''), u.pass_hash)) throw new HttpError(401, 'bad_credentials');
      db.prepare('DELETE FROM users WHERE id=?').run(u.id);
      audit(u.id, 'delete_account', '');
      broadcast('staff', 'staff/' + u.id);
      return { ok: true };
    },
  };
  return { handlers, authenticate, requireUser, publicUser, byId, audit };
}
module.exports = { makeAuth };
