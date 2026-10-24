'use strict';
/* Второй фактор входа. Проверяем не «работает ли код», а то, что дверь закрыта:
   пароля одного мало, подсмотренный код не проходит дважды, перебор останавливается,
   а «забыл пароль» не оказывается чёрным ходом. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const TOTP = require('../src/totp');

async function boot(ctx, extra) {
  const app = createApp(Object.assign({ port: 0, dbPath: ':memory:', mailMode: 'memory', staticDir: __dirname }, extra));
  const port = await app.listen();
  if (ctx && ctx.after) ctx.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null; try { j = await r.json(); } catch (e) { /* пусто */ }
    return { status: r.status, body: j };
  };
  const lastCode = (to) => {
    const m = [...app.mailer.sent].reverse().find((x) => x.to === to);
    return /: ([A-Z0-9]{6})\n/.exec(m.text)[1];
  };
  async function signup(email, name, pw = 'password123', invite) {
    const r = await call('POST', '/api/auth/register', { email, password: pw, name, phone: '+992901234567', invite });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const v = await call('POST', '/api/auth/verify', { email, code: lastCode(email) });
    assert.equal(v.status, 200);
    const l = await call('POST', '/api/auth/login', { email, password: pw });
    assert.equal(l.status, 200);
    return { token: l.body.token, user: l.body.user };
  }
  async function signupStaff(owner, email, name) {
    const inv = await call('GET', '/api/docs/meta/invite', undefined, owner.token);
    assert.equal(inv.status, 200);
    return signup(email, name, 'password123', inv.body.data.code);
  }
  // включает второй фактор: заводит секрет и подтверждает его кодом
  async function turnOn2fa(who, pw = 'password123') {
    const st = await call('POST', '/api/2fa/setup', { password: pw }, who.token);
    assert.equal(st.status, 200, JSON.stringify(st.body));
    const secret = st.body.secret;
    const en = await call('POST', '/api/2fa/enable', { code: TOTP.codeAt(secret, Date.now()) }, who.token);
    assert.equal(en.status, 200, JSON.stringify(en.body));
    return { secret, backup: en.body.backup };
  }
  return { app, call, lastCode, signup, signupStaff, turnOn2fa };
}

test('коды сходятся с примерами RFC 6238 — значит и с Google Authenticator', () => {
  const sec = TOTP.base32Encode(Buffer.from('12345678901234567890'));
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
  for (const [t, want] of vectors) assert.equal(TOTP.codeAt(sec, t * 1000), want, 'время ' + t);
});

test('код живёт своё окно: минуту назад — уже не годится', () => {
  const sec = TOTP.newSecret(), now = Date.now();
  assert.notEqual(TOTP.verify(sec, TOTP.codeAt(sec, now), now), null);
  assert.notEqual(TOTP.verify(sec, TOTP.codeAt(sec, now - 30000), now), null, 'предыдущее окно терпим: часы врут');
  assert.equal(TOTP.verify(sec, TOTP.codeAt(sec, now - 120000), now), null, 'код двухминутной давности должен быть мёртв');
});

test('пароля одного мало, нужен код из аутентификатора', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('a@gmail.com', 'Гани');
  const { secret } = await t.turnOn2fa(a);

  const l = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  assert.equal(l.status, 200);
  assert.equal(l.body.needTotp, true, 'сервер должен попросить код');
  assert.equal(l.body.token, undefined, 'токен до кода выдавать нельзя');
  assert.ok(l.body.pending, 'должен прийти короткий пропуск');

  const bad = await t.call('POST', '/api/auth/login-2fa', { pending: l.body.pending, code: '000000' });
  assert.equal(bad.status, 401);

  const good = await t.call('POST', '/api/auth/login-2fa', { pending: l.body.pending, code: TOTP.codeAt(secret, Date.now()) });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.ok(good.body.token);
  const me = await t.call('GET', '/api/me', undefined, good.body.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.totp, true);
});

test('подсмотренный через плечо код второй раз не пройдёт', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('a@gmail.com', 'Гани');
  const { secret } = await t.turnOn2fa(a);
  const code = TOTP.codeAt(secret, Date.now());

  const l1 = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  assert.equal((await t.call('POST', '/api/auth/login-2fa', { pending: l1.body.pending, code })).status, 200);

  const l2 = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  const again = await t.call('POST', '/api/auth/login-2fa', { pending: l2.body.pending, code });
  assert.equal(again.status, 401, 'повтор того же кода должен отклоняться');
});

test('запасной код выручает при потерянном телефоне, но только раз', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('a@gmail.com', 'Гани');
  const { backup } = await t.turnOn2fa(a);
  assert.equal(backup.length, 8, 'должно быть восемь запасных кодов');

  const l1 = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  const r1 = await t.call('POST', '/api/auth/login-2fa', { pending: l1.body.pending, code: backup[0] });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.backupLeft, 7);

  const l2 = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  const r2 = await t.call('POST', '/api/auth/login-2fa', { pending: l2.body.pending, code: backup[0] });
  assert.equal(r2.status, 401, 'использованный запасной код должен сгореть');
});

test('перебор кодов останавливается на пятой попытке', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('a@gmail.com', 'Гани');
  const { secret } = await t.turnOn2fa(a);
  const l = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/login-2fa', { pending: l.body.pending, code: '111111' });
  const r = await t.call('POST', '/api/auth/login-2fa', { pending: l.body.pending, code: TOTP.codeAt(secret, Date.now()) });
  assert.ok(r.status === 429 || r.status === 401, 'пропуск должен сгореть, а не ждать дальше');
});

test('с украденной сессией второй фактор не включить и не выключить', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('a@gmail.com', 'Гани');
  const st = await t.call('POST', '/api/2fa/setup', { password: 'ne-tot-parol1' }, a.token);
  assert.equal(st.status, 401, 'без пароля включать нельзя: иначе вора запрёт хозяина');

  const { secret } = await t.turnOn2fa(a);
  const d1 = await t.call('POST', '/api/2fa/disable', { code: TOTP.codeAt(secret, Date.now()) }, a.token);
  assert.equal(d1.status, 401, 'без пароля выключать нельзя');
  const d2 = await t.call('POST', '/api/2fa/disable', { password: 'password123', code: '000000' }, a.token);
  assert.equal(d2.status, 400, 'без кода выключать нельзя');

  const d3 = await t.call('POST', '/api/2fa/disable', { password: 'password123', code: TOTP.codeAt(secret, Date.now()) }, a.token);
  assert.equal(d3.status, 200, JSON.stringify(d3.body));
  assert.equal(d3.body.user.totp, false);
  const l = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  assert.ok(l.body.token, 'после выключения вход снова в один шаг');
});

test('«забыл пароль» не обходит второй фактор', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('a@gmail.com', 'Гани');
  const { secret } = await t.turnOn2fa(a);

  await t.call('POST', '/api/auth/forgot', { email: 'a@gmail.com' });
  const code = t.lastCode('a@gmail.com');
  const r1 = await t.call('POST', '/api/auth/reset', { email: 'a@gmail.com', code, newPassword: 'newpass123' });
  assert.equal(r1.status, 400, 'кода с почты одного мало');

  const l = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  assert.equal(l.body.needTotp, true, 'старый пароль должен остаться в силе');

  const r2 = await t.call('POST', '/api/auth/reset', { email: 'a@gmail.com', code, newPassword: 'newpass123', totp: TOTP.codeAt(secret, Date.now()) });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
});

test('чужая настройка не касается соседа по магазину', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('own@gmail.com', 'Гани');
  const emp = await t.signupStaff(own, 'emp@gmail.com', 'Алишер');
  await t.turnOn2fa(emp);

  const l1 = await t.call('POST', '/api/auth/login', { email: 'own@gmail.com', password: 'password123' });
  assert.ok(l1.body.token, 'владельцу второй фактор сотрудника не мешает');
  const l2 = await t.call('POST', '/api/auth/login', { email: 'emp@gmail.com', password: 'password123' });
  assert.equal(l2.body.needTotp, true);
});

test('включение второго фактора выбрасывает со всех других устройств', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('a@gmail.com', 'Гани');
  // второй вход — как будто с телефона
  const phone = await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' });
  assert.ok(phone.body.token);
  await t.turnOn2fa(a);
  const me = await t.call('GET', '/api/me', undefined, phone.body.token);
  assert.equal(me.status, 401, 'старые сессии должны закрыться: иначе вор останется внутри');
});
