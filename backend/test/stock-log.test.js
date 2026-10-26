'use strict';
/* История склада: продажи не переписываются.

   У записей истории нет своего номера, поэтому правило строится на том,
   что в них неизменного. И два законных исключения, без которых сломалась
   бы обычная работа: «Отменить» сразу после ошибки и вытеснение старого
   при переполнении.

   Проверяем и то, и другое: что дыра закрыта и что лавка работает. */
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
  async function signupStaff(owner, email, name) {
    const inv = await call('GET', '/api/docs/meta/invite', undefined, owner.token);
    const s = await signup(email, name, inv.body.data.code);
    const list = await call('GET', '/api/collections/staff', undefined, owner.token);
    const row = list.body.docs.find((d) => d.data.mail === email);
    await call('PUT', '/api/docs/staff/' + row.id, { data: { status: 'active' } }, owner.token);
    return s;
  }
  const читать = async (who) => (await call('GET', '/api/docs/warehouse/main', undefined, who.token)).body;
  const писать = (who, data) => call('PUT', '/api/docs/warehouse/main', { data }, who.token);
  return { app, call, signup, signupStaff, читать, писать };
}

const ДАВНО = Date.now() - 3 * 864e5;
function склад(by) {
  return {
    items: [{ id: 'i1', name: 'Куртка', cat: 'Одежда', price: 450, qty: 5, u: 'шт', pk: 1 }],
    cats: ['Одежда'],
    log: [
      { by, t: ДАВНО + 2000, type: 'out', id: 'i1', name: 'Куртка', qty: 1, sum: 450, note: '' },
      { by, t: ДАВНО + 1000, type: 'out', id: 'i1', name: 'Куртка', qty: 2, sum: 900, note: '' },
      { by, t: ДАВНО, type: 'in', id: 'i1', name: 'Куртка', qty: 8, sum: 0, note: 'Поставка' },
    ],
    trash: [],
  };
}

test('сотрудник не сотрёт вчерашнюю продажу', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  assert.equal((await t.писать(own, склад('Гани'))).status, 200);

  const d = await t.читать(emp);
  d.data.log = d.data.log.filter((l) => l.sum !== 900);     // спрятать продажу на 900
  const r = await t.писать(emp, d.data);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'log_vanished');

  assert.equal((await t.читать(own)).data.log.length, 3, 'история цела');
});

test('сотрудник не уменьшит сумму в записи', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.писать(own, склад('Гани'));

  const d = await t.читать(emp);
  d.data.log[1].sum = 100;                                   // было 900
  assert.equal((await t.писать(emp, d.data)).status, 409, 'изменение суммы — та же подмена записи');
});

test('нельзя «состарить» историю, прислав одну запись', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.писать(own, склад('Гани'));

  const d = await t.читать(emp);
  d.data.log = [d.data.log[0]];      // оставить только новейшую: остальные будто вытеснены
  assert.equal((await t.писать(emp, d.data)).status, 409, 'вытеснение засчитывается только у полной истории');
});

test('«Отменить» сразу после ошибки работает', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.писать(own, склад('Гани'));

  // сотрудник ошибся и тут же продал — запись уходит на сервер
  const d1 = await t.читать(emp);
  const ошибка = { by: 'Алишер', t: Date.now(), type: 'out', id: 'i1', name: 'Куртка', qty: 1, sum: 450, note: '' };
  d1.data.log.unshift(ошибка);
  assert.equal((await t.писать(emp, d1.data)).status, 200);

  // и нажал «Отменить»
  const d2 = await t.читать(emp);
  d2.data.log = d2.data.log.filter((l) => l.t !== ошибка.t);
  assert.equal((await t.писать(emp, d2.data)).status, 200, 'отмена свежей ошибки — обычная работа');
  assert.equal((await t.читать(own)).data.log.length, 3);
});

test('старое вытесняется само, когда история полна', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');

  // забиваем историю до предела
  const полная = склад('Гани');
  полная.log = [];
  for (let i = 0; i < 400; i++)
    полная.log.push({ by: 'Гани', t: ДАВНО + i * 1000, type: 'out', id: 'i1', name: 'Куртка', qty: 1, sum: 450, note: '' });
  полная.log.sort((a, b) => b.t - a.t);
  assert.equal((await t.писать(own, полная)).status, 200);

  // новая продажа вытесняет самую старую — так делает сама программа
  const d = await t.читать(emp);
  d.data.log.unshift({ by: 'Алишер', t: Date.now(), type: 'out', id: 'i1', name: 'Куртка', qty: 1, sum: 450, note: '' });
  d.data.log = d.data.log.slice(0, 400);
  assert.equal((await t.писать(emp, d.data)).status, 200, 'переполнение — обычная работа, а не подмена');
});

test('автора записи ставит сервер', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.писать(own, склад('Гани'));

  const d = await t.читать(emp);
  d.data.log.unshift({ by: 'Гани', t: Date.now(), type: 'out', id: 'i1', name: 'Куртка', qty: 1, sum: 450, note: '' });
  assert.equal((await t.писать(emp, d.data)).status, 200);

  const после = await t.читать(own);
  assert.equal(после.data.log[0].by, 'Алишер', 'приписать продажу другому не выйдет');
  assert.equal(после.data.log[1].by, 'Гани', 'чужое авторство не переписано');
});

test('владелец восстанавливает из копии, и это записывается в журнал', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  await t.писать(own, склад('Гани'));

  // восстановление из файла заменяет историю целиком
  const другая = склад('Гани');
  другая.log = [{ by: 'Гани', t: ДАВНО - 5000, type: 'in', id: 'i1', name: 'Куртка', qty: 3, sum: 0, note: 'Из копии' }];
  assert.equal((await t.писать(own, другая)).status, 200, 'иначе восстановление из копии было бы невозможно');

  const ж = await t.call('GET', '/api/security', undefined, own.token);
  assert.ok(ж.body.events.some((e) => e.action === 'log_rewrite'), 'но след остаётся');
});

test('обычная продажа проходит как ни в чём не бывало', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.писать(own, склад('Гани'));

  const d = await t.читать(emp);
  d.data.items[0].qty = 4;
  d.data.log.unshift({ by: 'Алишер', t: Date.now(), type: 'out', id: 'i1', name: 'Куртка', qty: 1, sum: 450, note: '' });
  assert.equal((await t.писать(emp, d.data)).status, 200);
  const после = await t.читать(own);
  assert.equal(после.data.log.length, 4);
  assert.equal(после.data.items[0].qty, 4);
});
