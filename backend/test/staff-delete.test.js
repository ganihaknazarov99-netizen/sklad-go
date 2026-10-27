'use strict';
/* Убрать человека из магазина совсем.

   Блокировка закрывает вход, но уволенный остаётся в списке навсегда.
   Удаление убирает его вместе с входами, устройствами и кодами —
   и это должно быть доступно только хозяину и только в своём магазине. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

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
  const список = async (who) => (await call('GET', '/api/collections/staff', undefined, who.token)).body.docs;
  async function signupStaff(owner, email, name) {
    const inv = await call('GET', '/api/docs/meta/invite', undefined, owner.token);
    const s = await signup(email, name, inv.body.data.code);
    const row = (await список(owner)).find((d) => d.data.mail === email);
    await call('PUT', '/api/docs/staff/' + row.id, { data: { status: 'active' } }, owner.token);
    return Object.assign(s, { id: row.id });
  }
  return { app, call, signup, signupStaff, список };
}

test('владелец убирает сотрудника, и тот пропадает из списка', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');

  assert.equal((await t.список(own)).length, 2);
  assert.equal((await t.call('DELETE', '/api/docs/staff/' + emp.id, undefined, own.token)).status, 200);

  const после = await t.список(own);
  assert.equal(после.length, 1, 'остался только хозяин');
  assert.ok(!после.some((d) => d.data.mail === 'alisher@shop.tj'));
});

test('убранный сотрудник теряет вход в тот же миг', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');

  assert.equal((await t.call('GET', '/api/me', undefined, emp.token)).status, 200);
  await t.call('DELETE', '/api/docs/staff/' + emp.id, undefined, own.token);
  assert.equal((await t.call('GET', '/api/me', undefined, emp.token)).status, 401, 'его доступ должен умереть сразу');
});

test('убранный не войдёт и по своему паролю', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.call('DELETE', '/api/docs/staff/' + emp.id, undefined, own.token);

  const r = await t.call('POST', '/api/auth/login', { email: 'alisher@shop.tj', password: 'password123' });
  assert.equal(r.status, 401, 'учётной записи больше нет');
});

test('сотрудник не может убрать ни другого, ни себя', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const a = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  const b = await t.signupStaff(own, 'nodira@shop.tj', 'Нодира');

  assert.equal((await t.call('DELETE', '/api/docs/staff/' + b.id, undefined, a.token)).status, 403);
  assert.equal((await t.call('DELETE', '/api/docs/staff/' + a.id, undefined, a.token)).status, 403);
  assert.equal((await t.список(own)).length, 3, 'все на месте');
});

test('владельца убрать нельзя — магазин остался бы без хозяина', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const я = (await t.список(own)).find((d) => d.data.owner);
  const r = await t.call('DELETE', '/api/docs/staff/' + я.id, undefined, own.token);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'owner_cannot_delete');
});

test('сосед по серверу чужого сотрудника не тронет', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани');
  const b = await t.signup('firuz@shop.tj', 'Фируз');
  const мой = await t.signupStaff(a, 'alisher@shop.tj', 'Алишер');

  assert.equal((await t.call('DELETE', '/api/docs/staff/' + мой.id, undefined, b.token)).status, 404);
  assert.equal((await t.список(a)).length, 2, 'мой сотрудник на месте');
});

test('ждущего подтверждения тоже можно убрать, не подтверждая', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const inv = await t.call('GET', '/api/docs/meta/invite', undefined, own.token);
  await t.signup('chujoy@shop.tj', 'Незнакомец', inv.body.data.code);

  const строка = (await t.список(own)).find((d) => d.data.mail === 'chujoy@shop.tj');
  assert.equal(строка.data.status, 'pending');
  assert.equal((await t.call('DELETE', '/api/docs/staff/' + строка.id, undefined, own.token)).status, 200);
  assert.equal((await t.список(own)).length, 1);
});

test('удаление попадает в журнал «Кто заходил»', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.call('DELETE', '/api/docs/staff/' + emp.id, undefined, own.token);

  const ж = await t.call('GET', '/api/security', undefined, own.token);
  assert.ok(ж.body.events.some((e) => e.action === 'staff_delete'), 'след должен остаться');
});

test('история продаж уволенного остаётся на месте', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');

  // сотрудник продал товар
  await t.call('PUT', '/api/docs/warehouse/main', { data: {
    items: [{ id: 'i1', name: 'Куртка', cat: 'Одежда', price: 450, qty: 4, u: 'шт', pk: 1 }],
    log: [{ by: 'Алишер', t: Date.now() - 864e5, type: 'out', id: 'i1', name: 'Куртка', qty: 1, sum: 450, note: '' }],
    cats: ['Одежда'], trash: [],
  } }, emp.token);

  await t.call('DELETE', '/api/docs/staff/' + emp.id, undefined, own.token);

  const склад = await t.call('GET', '/api/docs/warehouse/main', undefined, own.token);
  assert.equal(склад.body.data.log.length, 1);
  assert.equal(склад.body.data.log[0].by, 'Алишер', 'что было, то было — прошлое не переписываем');
});
