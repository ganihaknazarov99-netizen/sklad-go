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
  async function signup(email, name, pw = 'password123', phone = '+992901234567', invite) {
    const r = await call('POST', '/api/auth/register', { email, password: pw, name, phone, invite });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const v = await call('POST', '/api/auth/verify', { email, code: lastCode(email) });
    assert.equal(v.status, 200);
    const l = await call('POST', '/api/auth/login', { email, password: pw });
    assert.equal(l.status, 200);
    return { token: l.body.token, user: l.body.user };
  }
  // сотрудник того же магазина: берём код приглашения у владельца
  async function signupStaff(owner, email, name) {
    const inv = await call('GET', '/api/docs/meta/invite', undefined, owner.token);
    assert.equal(inv.status, 200, 'владелец должен видеть код приглашения');
    return signup(email, name, 'password123', '+992901234567', inv.body.data.code);
  }
  return { app, base, call, lastCode, signup, signupStaff };
}

test('кто зарегистрировался сам — владелец своего магазина, чужого не видит', async () => {
  const t = await boot();
  const a = await t.signup('a@gmail.com', 'Гани');
  const b = await t.signup('b@gmail.com', 'Фируз');
  assert.equal(a.user.role, 'owner'); assert.equal(a.user.status, 'active');
  assert.equal(b.user.role, 'owner'); assert.equal(b.user.status, 'active');

  // первый заводит товар
  await t.call('PUT', '/api/docs/warehouse/main', { data: { items: [{ id: 'x', name: 'Куртка', qty: 5 }], log: [] } }, a.token);
  // второй о нём не знает: у него свой пустой склад
  const forB = await t.call('GET', '/api/docs/warehouse/main', undefined, b.token);
  assert.equal(forB.body.exists, false, 'сосед не должен видеть чужой склад');
  // и в команде у каждого только он сам
  const teamA = await t.call('GET', '/api/collections/staff', undefined, a.token);
  const teamB = await t.call('GET', '/api/collections/staff', undefined, b.token);
  assert.equal(teamA.body.docs.length, 1);
  assert.equal(teamB.body.docs.length, 1);
  assert.notEqual(teamA.body.docs[0].id, teamB.body.docs[0].id);
  await t.app.close();
});

test('сотрудник приходит по ссылке-приглашению и попадает в тот же магазин', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const inv = await t.call('GET', '/api/docs/meta/invite', undefined, owner.token);
  assert.equal(inv.status, 200);
  const code = inv.body.data.code;
  assert.ok(code && code.length >= 8, 'код приглашения должен быть');

  const staff = await t.signup('staff@gmail.com', 'Алишер', 'password123', '+992901234567', code);
  assert.equal(staff.user.role, 'staff'); assert.equal(staff.user.status, 'pending');
  assert.equal((await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token)).status, 403);

  await t.call('PUT', '/api/docs/warehouse/main', { data: { items: [{ id: 'x', qty: 7 }], log: [] } }, owner.token);
  await t.call('PATCH', '/api/docs/staff/' + staff.user.id, { data: { status: 'active' } }, owner.token);
  const seen = await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token);
  assert.equal(seen.body.data.items[0].qty, 7, 'после подтверждения сотрудник видит склад владельца');

  // владелец видит в команде двоих, а код можно сменить — старый перестаёт работать
  assert.equal((await t.call('GET', '/api/collections/staff', undefined, owner.token)).body.docs.length, 2);
  const rot = await t.call('PATCH', '/api/docs/meta/invite', { data: {} }, owner.token);
  assert.equal(rot.status, 200);
  const r = await t.call('POST', '/api/auth/register', { email: 'late@gmail.com', password: 'password123', name: 'Поздний', invite: code });
  assert.equal(r.status, 400, 'старое приглашение больше не действует');
  await t.app.close();
});

test('сотрудник не может подсмотреть чужой магазин даже зная адрес', async () => {
  const t = await boot();
  const a = await t.signup('a@gmail.com', 'Гани');
  const b = await t.signup('b@gmail.com', 'Фируз');
  await t.call('PUT', '/api/docs/warehouse/debts', { data: { people: [{ id: 'p', name: 'Фируз' }], ops: [] } }, a.token);
  await t.call('POST', '/api/collections/activity', { data: { txt: 'тайная запись' } }, a.token);
  const debts = await t.call('GET', '/api/docs/warehouse/debts', undefined, b.token);
  assert.equal(debts.body.exists, false);
  const feed = await t.call('GET', '/api/collections/activity', undefined, b.token);
  assert.equal(feed.body.docs.length, 0, 'лента соседа должна быть пустой');
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
  const staff = await t.signupStaff(owner, 'staff@gmail.com', 'Алишер');
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

test('закупочные цены: сотруднику не отдаются и не стираются его записью', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const staff = await t.signupStaff(owner, 'staff@gmail.com', 'Алишер');
  await t.call('PATCH', '/api/docs/staff/' + staff.user.id, { data: { status: 'active' } }, owner.token);

  // владелец заводит товар с закупочной ценой
  const doc = { items: [{ id: 'a', name: 'Куртка', qty: 5, price: 450, cp: 279 }], log: [], trash: [{ id: 't1', item: { id: 'b', name: 'Кепка', qty: 0, price: 45, cp: 20 } }] };
  assert.equal((await t.call('PUT', '/api/docs/warehouse/main', { data: doc }, owner.token)).status, 200);

  // владелец видит закупку, сотрудник — нет, ни в товарах, ни в корзине
  const asOwner = await t.call('GET', '/api/docs/warehouse/main', undefined, owner.token);
  assert.equal(asOwner.body.data.items[0].cp, 279);
  const asStaff = await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token);
  assert.equal(asStaff.body.data.items[0].cp, undefined);
  assert.equal(asStaff.body.data.items[0].price, 450, 'продажная цена сотруднику нужна');
  assert.equal(asStaff.body.data.trash[0].item.cp, undefined);

  // сотрудник продаёт штуку и сохраняет склад тем, что у него есть
  const mine = asStaff.body.data;
  mine.items[0].qty = 4;
  assert.equal((await t.call('PUT', '/api/docs/warehouse/main', { data: mine }, staff.token, { 'If-Match': String(asStaff.body.version) })).status, 200);

  // остаток изменился, а закупочная цена уцелела
  const after = await t.call('GET', '/api/docs/warehouse/main', undefined, owner.token);
  assert.equal(after.body.data.items[0].qty, 4);
  assert.equal(after.body.data.items[0].cp, 279, 'закупка не должна теряться после записи сотрудника');
  assert.equal(after.body.data.trash[0].item.cp, 20);

  // и сотрудник не может проставить закупку сам
  mine.items[0].cp = 1;
  await t.call('PUT', '/api/docs/warehouse/main', { data: mine }, staff.token);
  const after2 = await t.call('GET', '/api/docs/warehouse/main', undefined, owner.token);
  assert.equal(after2.body.data.items[0].cp, 279, 'сотрудник не задаёт закупочную цену');
  await t.app.close();
});

test('блокировка сотрудника закрывает доступ и завершает его сессии', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const staff = await t.signupStaff(owner, 'staff@gmail.com', 'Алишер');
  await t.call('PATCH', '/api/docs/staff/' + staff.user.id, { data: { status: 'active' } }, owner.token);
  assert.equal((await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token)).status, 200);
  await t.call('PATCH', '/api/docs/staff/' + staff.user.id, { data: { status: 'blocked' } }, owner.token);
  assert.equal((await t.call('GET', '/api/docs/warehouse/main', undefined, staff.token)).status, 401);
  await t.app.close();
});

test('телефон и почта других сотрудников видит только владелец', async () => {
  const t = await boot();
  const owner = await t.signup('owner@gmail.com', 'Гани');
  const s1 = await t.signupStaff(owner, 's1@gmail.com', 'Один');
  const s2 = await t.signupStaff(owner, 's2@gmail.com', 'Два');
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
  const u = await t.signupStaff(owner, 'user@gmail.com', 'Юзер');
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

test('OWNER_EMAIL закрывает сервер: чужие заходят только по приглашению', async () => {
  const t = await boot({ ownerEmail: 'boss@gmail.com' });
  const no = await t.call('POST', '/api/auth/register', { email: 'first@gmail.com', password: 'password123', name: 'Первый' });
  assert.equal(no.status, 403, 'посторонний не может завести свой магазин на закрытом сервере');
  const boss = await t.signup('boss@gmail.com', 'Босс');
  assert.equal(boss.user.role, 'owner');
  const inv = await t.call('GET', '/api/docs/meta/invite', undefined, boss.token);
  const staff = await t.signup('first@gmail.com', 'Первый', 'password123', '+992901234567', inv.body.data.code);
  assert.equal(staff.user.role, 'staff');
  await t.app.close();
});
