'use strict';
/* Долги: сервер смотрит не только кто пишет, но и что именно.

   Раньше сотрудник мог напрямую через API переписать документ долгов —
   стереть свой долг, поправить чужой, приписать запись другому человеку.
   Программа этого не делает, но программа и не единственный способ
   достучаться до сервера.

   Проверяем так, как это сделал бы человек с дурными намерениями:
   обычными запросами, минуя интерфейс. */
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
  const читать = async (who) => (await call('GET', '/api/docs/warehouse/debts', undefined, who.token)).body;
  const писать = (who, data, ver) => call('PUT', '/api/docs/warehouse/debts', { data }, who.token, ver);
  return { app, call, signup, signupStaff, читать, писать };
}

// Склад долгов с одной записью: Фируз взял 450.50
function начальные(by) {
  return {
    people: [{ id: 'p1', name: 'Фируз', phone: '+992901112233' }],
    ops: [{ id: 'o1', pid: 'p1', type: 'give', amt: 450.50, t: 1761000000000, due: '', note: 'Куртка', calc: '', by, at: 1761000000000 }],
    trash: [],
  };
}

test('записанный долг нельзя уменьшить задним числом', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');

  assert.equal((await t.писать(own, начальные('Гани'))).status, 200);

  // сотрудник пробует переписать сумму напрямую
  const свой = await t.читать(emp);
  свой.data.ops[0].amt = 50;
  const r = await t.писать(emp, свой.data);
  assert.equal(r.status, 409, 'сумму записанного долга менять нельзя');
  assert.equal(r.body.error, 'debt_changed');

  // и в базе осталось как было
  assert.equal((await t.читать(own)).data.ops[0].amt, 450.50);
});

test('долг нельзя тихо стереть — только в корзину, со следом', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.писать(own, начальные('Гани'));

  // просто выкинуть запись
  const тихо = await t.читать(emp);
  тихо.data.ops = [];
  const r = await t.писать(emp, тихо.data);
  assert.equal(r.status, 409, 'исчезнуть запись просто так не может');
  assert.equal(r.body.error, 'debt_vanished');

  // а через корзину — можно, след остаётся
  const честно = await t.читать(emp);
  const о = честно.data.ops[0];
  честно.data.ops = [];
  честно.data.trash = [{ id: 'tr1', k: 'op', t: Date.now(), by: 'Алишер', pn: 'Фируз', op: о }];
  assert.equal((await t.писать(emp, честно.data)).status, 200, 'удаление в корзину — обычная работа');

  const после = await t.читать(own);
  assert.equal(после.data.ops.length, 0);
  assert.equal(после.data.trash[0].op.amt, 450.50, 'в корзине видно, что именно убрали');
});

test('удаление человека вместе с его долгами тоже проходит', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  await t.писать(own, начальные('Гани'));

  const d = await t.читать(own);
  const оп = d.data.ops.slice();
  d.data.ops = [];
  d.data.people = [];
  d.data.trash = [{ id: 'tr2', k: 'person', t: Date.now(), by: 'Гани', pn: 'Фируз', person: { id: 'p1', name: 'Фируз' }, ops: оп }];
  assert.equal((await t.писать(own, d.data)).status, 200, 'так делает сама программа');
});

test('нельзя приписать свою запись другому человеку', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const emp = await t.signupStaff(own, 'alisher@shop.tj', 'Алишер');
  await t.писать(own, начальные('Гани'));

  const d = await t.читать(emp);
  d.data.ops.push({ id: 'o2', pid: 'p1', type: 'give', amt: 1000, t: Date.now(), due: '', note: '', calc: '', by: 'Гани', at: Date.now() });
  assert.equal((await t.писать(emp, d.data)).status, 200);

  const после = await t.читать(own);
  const новая = после.data.ops.find((o) => o.id === 'o2');
  assert.equal(новая.by, 'Алишер', 'автора ставит сервер, а не тот, кто пишет');
  assert.equal(после.data.ops.find((o) => o.id === 'o1').by, 'Гани', 'чужое авторство не переписано');
});

test('добавлять записи можно свободно — это обычная работа', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  await t.писать(own, начальные('Гани'));

  const d = await t.читать(own);
  d.data.ops.push({ id: 'o3', pid: 'p1', type: 'get', amt: 450.50, t: Date.now(), due: '', note: 'Вернул', calc: '', by: '', at: Date.now() });
  assert.equal((await t.писать(own, d.data)).status, 200);
  assert.equal((await t.читать(own)).data.ops.length, 2);
});

test('примечание и срок править можно: это не деньги', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  await t.писать(own, начальные('Гани'));

  const d = await t.читать(own);
  d.data.ops[0].note = 'Куртка зимняя, чёрная';
  d.data.ops[0].due = '2026-12-01';
  assert.equal((await t.писать(own, d.data)).status, 200);
  assert.equal((await t.читать(own)).data.ops[0].note, 'Куртка зимняя, чёрная');
});

test('правило одно для всех: владелец тоже не переписывает молча', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  await t.писать(own, начальные('Гани'));

  const d = await t.читать(own);
  d.data.ops[0].amt = 1;
  const r = await t.писать(own, d.data);
  assert.equal(r.status, 409, 'это не про недоверие к хозяину, а про честность записей');
});

test('перенести долг на другого человека задним числом нельзя', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  await t.писать(own, начальные('Гани'));

  const d = await t.читать(own);
  d.data.people.push({ id: 'p2', name: 'Мадина' });
  d.data.ops[0].pid = 'p2';
  const r = await t.писать(own, d.data);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'debt_changed');
});

test('дату записи задним числом не сдвинуть', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  await t.писать(own, начальные('Гани'));

  const d = await t.читать(own);
  d.data.ops[0].t = Date.now();
  assert.equal((await t.писать(own, d.data)).status, 409, 'сдвиг даты меняет просрочку и пени');
});

test('чужой магазин этим правилом не задет', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани');
  const b = await t.signup('firuz@shop.tj', 'Фируз');
  await t.писать(a, начальные('Гани'));
  // у соседа свой пустой склад долгов — пишет свободно
  assert.equal((await t.писать(b, начальные('Фируз'))).status, 200);
  assert.equal((await t.читать(a)).data.ops[0].by, 'Гани');
  assert.equal((await t.читать(b)).data.ops[0].by, 'Фируз');
});
