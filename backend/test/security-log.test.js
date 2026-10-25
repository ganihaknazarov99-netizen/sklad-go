'use strict';
/* Журнал входов для владельца.

   Смысл его один: заметить чужого. Поэтому проверяем не то, что список
   приходит, а то, что в нём видно неудачные попытки — и что соседний
   магазин в него не заглядывает. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const TOTP = require('../src/totp');

async function boot(ctx) {
  const app = createApp({ port: 0, dbPath: ':memory:', mailMode: 'memory', staticDir: __dirname });
  const port = await app.listen();
  ctx.after(() => app.close());
  const call = async (method, p, body, token) => {
    const r = await fetch(`http://127.0.0.1:${port}` + p, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null; try { j = await r.json(); } catch (e) { /* пусто */ }
    return { status: r.status, body: j };
  };
  const lastCode = (to) => /: ([A-Z0-9]{6})\n/.exec([...app.mailer.sent].reverse().find((x) => x.to === to).text)[1];
  async function signup(email, name, invite) {
    assert.equal((await call('POST', '/api/auth/register', { email, password: 'password123', name, phone: '+992901234567', invite })).status, 201);
    await call('POST', '/api/auth/verify', { email, code: lastCode(email) });
    const l = await call('POST', '/api/auth/login', { email, password: 'password123' });
    return { token: l.body.token, user: l.body.user };
  }
  async function signupStaff(owner, email, name) {
    const inv = await call('GET', '/api/docs/meta/invite', undefined, owner.token);
    return signup(email, name, inv.body.data.code);
  }
  return { app, call, signup, signupStaff };
}

test('владелец видит, что кто-то подбирал пароль', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  assert.ok(emp.user);

  // кто-то трижды промахнулся паролем сотрудника
  for (let i = 0; i < 3; i++) await t.call('POST', '/api/auth/login', { email: 'alisher@shop.tj', password: 'не-тот-пароль' });

  const r = await t.call('GET', '/api/security', undefined, own.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const промахи = r.body.events.filter((e) => e.action === 'login_fail');
  assert.equal(промахи.length, 3, 'все три промаха должны быть видны');
  assert.equal(промахи[0].email, 'alisher@shop.tj', 'и видно, по чьей учётной записи');
});

test('сотрудник в этот журнал не допускается', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  const r = await t.call('GET', '/api/security', undefined, emp.token);
  assert.equal(r.status, 403, 'кто заходил — дело владельца');
});

test('сосед по серверу в чужой журнал не заглядывает', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани');
  const b = await t.signup('firuz@shop.tj', 'Фируз');     // свой отдельный магазин

  await t.call('POST', '/api/auth/login', { email: 'firuz@shop.tj', password: 'не-тот' });

  const r = await t.call('GET', '/api/security', undefined, a.token);
  assert.equal(r.status, 200);
  assert.ok(!r.body.events.some((e) => e.email === 'firuz@shop.tj'), 'чужих записей быть не должно');

  const r2 = await t.call('GET', '/api/security', undefined, b.token);
  assert.ok(r2.body.events.some((e) => e.email === 'firuz@shop.tj'), 'а свои — должны');
  assert.ok(!r2.body.events.some((e) => e.email === 'gani@shop.tj'));
});

test('видно и то, что касается второго фактора', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const st = await t.call('POST', '/api/2fa/setup', { password: 'password123' }, own.token);
  await t.call('POST', '/api/2fa/enable', { code: TOTP.codeAt(st.body.secret, Date.now()) }, own.token);

  // чужой знает пароль, но не знает кода
  const l = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' });
  await t.call('POST', '/api/auth/login-2fa', { pending: l.body.pending, code: '000000' });

  const r = await t.call('GET', '/api/security', undefined, own.token);
  const было = r.body.events.map((e) => e.action);
  assert.ok(было.includes('totp_on'), 'включение второго фактора');
  assert.ok(было.includes('totp_fail'), 'промах по коду — самое важное, что тут можно увидеть');
  assert.ok(!было.includes('login_half'), 'промежуточный шаг входа засорял бы список');
});

test('без входа журнал не отдаётся', async (ctx) => {
  const t = await boot(ctx);
  assert.equal((await t.call('GET', '/api/security')).status, 401);
});
