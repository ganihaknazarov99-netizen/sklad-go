'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

async function boot(extra) {
  const app = createApp(Object.assign({ port: 0, dbPath: ':memory:', mailMode: 'memory', staticDir: __dirname }, extra));
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, token, headers) => {
    const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) { /* пусто */ }
    return { status: r.status, body: j };
  };
  const lastCode = (to) => { const m = [...app.mailer.sent].reverse().find((x) => x.to === to); return /: ([A-Z0-9]{6})\n/.exec(m.text)[1]; };
  // регистрация + подтверждение + вход одной функцией
  async function signup(email, name, pw = 'password123', phone = '+992901234567') {
    const r = await call('POST', '/api/auth/register', { email, password: pw, name, phone });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const v = await call('POST', '/api/auth/verify', { email, code: lastCode(email) });
    assert.equal(v.status, 200);
    const l = await call('POST', '/api/auth/login', { email, password: pw });
    assert.equal(l.status, 200);
    return { token: l.body.token, user: l.body.user };
  }
  return { app, base, call, lastCode, signup };
}

test('первый пользователь становится владельцем, второй ждёт подтверждения', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  assert.equal(owner.user.role, 'owner'); assert.equal(owner.user.status, 'active');
  const staff = await t.signup('staff@gmail.com', 'Алишер');
  assert.equal(staff.user.role, 'staff'); assert.equal(staff.user.status, 'pending');
  await t.app.close();
});

test('вход невозможен без подтверждённой почты; неверный код считается', async () => {
  const t = await boot();
  await t.call('POST', '/api/auth/register', { email: 'a@gmail.com', password: 'password123', name: 'A' });
  assert.equal((await t.call('POST', '/api/auth/login', { email: 'a@gmail.com', password: 'password123' })).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await t.call('POST', '/api/auth/verify', { email: 'a@gmail.com', code: 'AAAAAA' })).body.error, 'code_wrong');
  // после 5 неверных попыток даже правильный код блокируется
  assert.equal((await t.call('POST', '/api/auth/verify', { email: 'a@gmail.com', code: t.lastCode('a@gmail.com') })).body.error, 'code_locked');
  await t.app.close();
});

test('пароль: слабый отклоняется, чужой пароль не подходит', async () => {
  const t = await boot();
  assert.equal((await t.call('POST', '/api/auth/register', { email: 'w@gmail.com', password: 'short', name: 'W' })).body.error, 'weak_password');
  assert.equal((await t.call('POST', '/api/auth/register', { email: 'w@gmail.com', password: 'onlyletters', name: 'W' })).body.error, 'weak_password');
  await t.signup('ok@gmail.com', 'Ok');
  const bad = await t.call('POST', '/api/auth/login', { email: 'ok@gmail.com', password: 'wrongpass1' });
  assert.equal(bad.status, 401); assert.equal(bad.body.error, 'bad_credentials');
  const ghost = await t.call('POST', '/api/auth/login', { email: 'nobody@gmail.com', password: 'wrongpass1' });
  assert.equal(ghost.body.error, 'bad_credentials'); // тот же ответ, что и для неверного пароля
  await t.app.close();
});

test('ограничение попыток входа: 5 неудач блокируют вход на время', async () => {
  const t = await boot();
  await t.signup('lock@gmail.com', 'L');
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/login', { email: 'lock@gmail.com', password: 'badbadbad1' });
  assert.equal((await t.call('POST', '/api/auth/login', { email: 'lock@gmail.com', password: 'password123' })).status, 429);
  await t.app.close();
});

test('права: сотрудник без подтверждения не видит склад; после «Разрешить» работает', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const staff = await t.signup('staff@gmail.com', 'Алишер');
  assert.equal((await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token)).status, 403);
  assert.equal((await t.call('PUT', '/api/docs/warehouse/main', { data: { items: [] } }, staff.token)).status, 403);
  // сотрудник не может сам себя разрешить
  assert.equal((await t.call('PATCH', '/api/docs/staff/' + staff.user.id, { data: { status: 'active' } }, staff.token)).status, 200);
  assert.equal((await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token)).status, 403);
  // владелец разрешает
  assert.equal((await t.call('PATCH', '/api/docs/staff/' + staff.user.id, { data: { status: 'active' } }, owner.token)).status, 200);
  const put = await t.call('PUT', '/api/docs/warehouse/main', { data: { items: [{ id: 'a', qty: 3 }], log: [] } }, staff.token);
  assert.equal(put.status, 200); assert.equal(put.body.version, 1);
  const get = await t.call('GET', '/api/docs/warehouse/main', undefined, owner.token);
  assert.equal(get.body.data.items[0].qty, 3);
  await t.app.close();
});

test('блокировка сотрудника закрывает доступ и завершает его сессии', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const staff = await t.signup('staff@gmail.com', 'Алишер');
  await t.call('PATCH', '/api/docs/staff/' + staff.user.id, { data: { status: 'active' } }, owner.token);
  assert.equal((await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token)).status, 200);
  await t.call('PATCH', '/api/docs/staff/' + staff.user.id, { data: { status: 'blocked' } }, owner.token);
  assert.equal((await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token)).status, 401);
  await t.app.close();
});

test('телефон и почта других сотрудников видит только владелец', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const s1 = await t.signup('s1@gmail.com', 'Один');
  const s2 = await t.signup('s2@gmail.com', 'Два');
  for (const s of [s1, s2]) await t.call('PATCH', '/api/docs/staff/' + s.user.id, { data: { status: 'active' } }, owner.token);
  const asStaff = await t.call('GET', '/api/collections/staff', undefined, s1.token);
  const other = asStaff.body.docs.find((d) => d.id === s2.user.id).data;
  assert.equal(other.phone, ''); assert.equal(other.mail, '');
  const asOwner = await t.call('GET', '/api/collections/staff', undefined, owner.token);
  assert.equal(asOwner.body.docs.find((d) => d.id === s2.user.id).data.mail, 's2@gmail.com');
  await t.app.close();
});

test('лента изменений: автор и время ставит сервер, подделать нельзя', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const r = await t.call('POST', '/api/collections/activity', { data: { txt: 'добавил товар', by: 'Президент', uid: 'fake', t: 1 } }, owner.token);
  assert.equal(r.status, 201);
  const list = await t.call('GET', '/api/collections/activity?orderBy=t&dir=desc&limit=10', undefined, owner.token);
  assert.equal(list.body.docs[0].data.by, 'Гани'); assert.equal(list.body.docs[0].data.uid, owner.user.id); assert.ok(list.body.docs[0].data.t > 1);
  // записи ленты нельзя менять и удалять
  assert.equal((await t.call('DELETE', '/api/docs/activity/' + list.body.docs[0].id, undefined, owner.token)).status, 403);
  await t.app.close();
});

test('версии: конфликт при устаревшем If-Match', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  await t.call('PUT', '/api/docs/warehouse/debts', { data: { people: [] } }, owner.token);
  await t.call('PUT', '/api/docs/warehouse/debts', { data: { people: [1] } }, owner.token);
  const bad = await t.call('PUT', '/api/docs/warehouse/debts', { data: { people: [2] } }, owner.token, { 'If-Match': '1' });
  assert.equal(bad.status, 409); assert.equal(bad.body.version, 2);
  assert.equal((await t.call('PUT', '/api/docs/warehouse/debts', { data: { people: [3] } }, owner.token, { 'If-Match': '2' })).status, 200);
  assert.equal((await t.call('PATCH', '/api/docs/warehouse/nope', { data: { a: 1 } }, owner.token)).status, 404);
  await t.app.close();
});

test('посторонние пути и коллекции закрыты', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  assert.equal((await t.call('GET', '/api/docs/users/x', undefined, owner.token)).status, 403);
  assert.equal((await t.call('GET', '/api/docs/..%2Fsecret/x', undefined, owner.token)).status >= 400, true);
  assert.equal((await t.call('GET', '/api/collections/sessions', undefined, owner.token)).status, 403);
  assert.equal((await t.call('GET', '/api/docs/warehouse/main')).status, 401);
  await t.app.close();
});

test('сброс пароля по коду, выход и удаление аккаунта', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const u = await t.signup('user@gmail.com', 'Юзер');
  await t.call('POST', '/api/auth/forgot', { email: 'user@gmail.com' });
  const rs = await t.call('POST', '/api/auth/reset', { email: 'user@gmail.com', code: t.lastCode('user@gmail.com'), newPassword: 'newpassword9' });
  assert.equal(rs.status, 200);
  assert.equal((await t.call('GET', '/api/me', undefined, u.token)).status, 401); // старая сессия сброшена
  const l = await t.call('POST', '/api/auth/login', { email: 'user@gmail.com', password: 'newpassword9' });
  assert.equal(l.status, 200);
  await t.call('POST', '/api/auth/logout', {}, l.body.token);
  assert.equal((await t.call('GET', '/api/me', undefined, l.body.token)).status, 401);
  const l2 = await t.call('POST', '/api/auth/login', { email: 'user@gmail.com', password: 'newpassword9' });
  assert.equal((await t.call('DELETE', '/api/me', { password: 'wrong-pass1' }, l2.body.token)).status, 401);
  assert.equal((await t.call('DELETE', '/api/me', { password: 'newpassword9' }, l2.body.token)).status, 200);
  assert.equal((await t.call('POST', '/api/auth/login', { email: 'user@gmail.com', password: 'newpassword9' })).status, 401);
  assert.equal((await t.call('DELETE', '/api/me', { password: 'password123' }, owner.token)).body.error, 'owner_cannot_delete');
  await t.app.close();
});

test('реальное время: подписчик получает событие после записи', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const tk = await t.call('POST', '/api/stream/ticket', {}, owner.token);
  const ac = new AbortController();
  const r = await fetch(t.base + '/api/stream?ticket=' + tk.body.ticket, { signal: ac.signal });
  assert.equal(r.status, 200);
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  setTimeout(() => t.call('PUT', '/api/docs/warehouse/main', { data: { items: [] } }, owner.token), 100);
  const got = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('нет события')), 3000);
    (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); const m = /data: (\{.*\})/.exec(buf); if (m) { clearTimeout(to); return resolve(JSON.parse(m[1])); } } })();
  });
  assert.equal(got.p, 'warehouse/main');
  // билет одноразовый
  assert.equal((await fetch(t.base + '/api/stream?ticket=' + tk.body.ticket)).status, 401);
  ac.abort(); await t.app.close();
});

test('владельца можно назначить по OWNER_EMAIL', async () => {
  const t = await boot({ ownerEmail: 'boss@gmail.com' });
  const first = await t.signup('first@gmail.com', 'Первый');
  assert.equal(first.user.role, 'staff');
  const boss = await t.signup('boss@gmail.com', 'Босс');
  assert.equal(boss.user.role, 'owner');
  await t.app.close();
});
