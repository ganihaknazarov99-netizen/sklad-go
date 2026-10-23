'use strict';
const { HttpError } = require('./http');
const S = require('./security');

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

  const audit = (user_id, action, detail) =>
    db.prepare('INSERT INTO audit(t,user_id,action,detail) VALUES(?,?,?,?)').run(Date.now(), user_id || '', action, detail || '');

  function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, status: u.role === 'owner' ? 'active' : u.status, verified: !!u.verified };
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
      const first = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
      const isOwner = cfg.ownerEmail ? email === cfg.ownerEmail : first;
      const id = S.newId();
      db.prepare('INSERT INTO users(id,email,pass_hash,name,phone,role,status,verified,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, email, S.hashPassword(password), name, phone, isOwner ? 'owner' : 'staff', isOwner ? 'active' : 'pending', cfg.requireVerify ? 0 : 1, now, now);
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
      audit(user.id, 'login', ip);
      const s = createSession(user, req);
      return { token: s.token, expiresAt: s.expiresAt, user: publicUser(user) };
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
      checkCode(user, 'reset', body.code);
      db.prepare('UPDATE users SET pass_hash=?,verified=1,updated_at=? WHERE id=?').run(S.hashPassword(pw), Date.now(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); // выкидываем со всех устройств
      audit(user.id, 'password_reset', '');
      return { ok: true };
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
