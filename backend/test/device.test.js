'use strict';
/* Три замка на вход: привязка к устройству, замок после промахов
   и весть о чужом устройстве.

   Проверяем не «работает ли вызов», а то, ради чего это сделано:
   украденный доступ не должен работать с чужого телефона, перебор —
   прекращаться, а хозяин — узнавать, что входили не с его устройства. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

const КОМПЬЮТЕР = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ТОТ_ЖЕ_ПОСЛЕ_ОБНОВЛЕНИЯ = КОМПЬЮТЕР.replace('141.0.0.0', '142.0.7444.59');
const ТЕЛЕФОН = 'Mozilla/5.0 (Linux; Android 14; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

async function boot(ctx) {
  const app = createApp({ port: 0, dbPath: ':memory:', mailMode: 'memory', staticDir: __dirname });
  const port = await app.listen();
  ctx.after(() => app.close());
  const call = async (method, p, body, token, ua) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (ua) h['User-Agent'] = ua;
    const r = await fetch(`http://127.0.0.1:${port}` + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) { /* пусто */ }
    return { status: r.status, body: j };
  };
  const lastCode = (to) => /: ([A-Z0-9]{6})\n/.exec([...app.mailer.sent].reverse().find((x) => x.to === to).text)[1];
  async function signup(email, name, ua) {
    assert.equal((await call('POST', '/api/auth/register', { email, password: 'password123', name, phone: '+992901234567' }, null, ua)).status, 201);
    await call('POST', '/api/auth/verify', { email, code: lastCode(email) }, null, ua);
    const l = await call('POST', '/api/auth/login', { email, password: 'password123' }, null, ua);
    assert.equal(l.status, 200, JSON.stringify(l.body));
    return { token: l.body.token, body: l.body };
  }
  return { app, call, signup };
}

test('украденный доступ не работает с чужого устройства', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);

  // со своего — всё как было
  assert.equal((await t.call('GET', '/api/me', undefined, a.token, КОМПЬЮТЕР)).status, 200);

  // тот же доступ унесли на другой телефон
  const чужой = await t.call('GET', '/api/me', undefined, a.token, ТЕЛЕФОН);
  assert.equal(чужой.status, 401, 'с чужого устройства доступ должен быть мёртв');

  // и он сгорел совсем: даже на своём больше не работает
  const своё = await t.call('GET', '/api/me', undefined, a.token, КОМПЬЮТЕР);
  assert.equal(своё.status, 401, 'попытка кражи должна закрывать вход насовсем');
});

test('обновление браузера не выкидывает из программы', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);
  const после = await t.call('GET', '/api/me', undefined, a.token, ТОТ_ЖЕ_ПОСЛЕ_ОБНОВЛЕНИЯ);
  assert.equal(после.status, 200, 'Chrome обновляется каждую неделю — это не чужое устройство');
});

test('доступ без строки браузера не проходит: иначе защиту обходили бы молча', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);
  const r = await fetch('http://127.0.0.1:' + t.app.server.address().port + '/api/me', {
    headers: { Authorization: 'Bearer ' + a.token, 'User-Agent': '' },
  });
  assert.equal(r.status, 401);
});

test('пять промахов запирают учётную запись, верный пароль уже не спасает', async (ctx) => {
  const t = await boot(ctx);
  await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);

  for (let i = 0; i < 5; i++) {
    const r = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'не-тот-пароль' }, null, КОМПЬЮТЕР);
    assert.equal(r.status, 401);
  }
  const потом = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' }, null, КОМПЬЮТЕР);
  assert.equal(потом.status, 423, 'после пяти промахов дверь закрыта, даже с верным паролем');
  assert.ok(потом.body.minutes > 0 && потом.body.minutes <= 15, 'и сказано, на сколько: ' + потом.body.minutes);
});

test('удачный вход обнуляет счётчик промахов', async (ctx) => {
  const t = await boot(ctx);
  await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);
  for (let i = 0; i < 4; i++) await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'мимо' }, null, КОМПЬЮТЕР);
  assert.equal((await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' }, null, КОМПЬЮТЕР)).status, 200);
  // счётчик сброшен — снова есть пять попыток, а не одна
  for (let i = 0; i < 4; i++) {
    const r = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'мимо' }, null, КОМПЬЮТЕР);
    assert.equal(r.status, 401, 'замок не должен защёлкнуться раньше времени');
  }
});

test('замок виден владельцу в журнале входов', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'мимо' }, null, КОМПЬЮТЕР);
  const j = await t.call('GET', '/api/security', undefined, a.token, КОМПЬЮТЕР);
  assert.ok(j.body.events.some((e) => e.action === 'account_locked'), 'хозяин должен увидеть, что его ломали');
});

test('хозяин узнаёт, что входили с чужого устройства', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);

  // на своём устройстве никаких тревог
  let me = await t.call('GET', '/api/me', undefined, a.token, КОМПЬЮТЕР);
  assert.equal(me.body.newDevices, undefined, 'первый вход — не новость');

  // кто-то вошёл с телефона, зная пароль
  const чужой = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' }, null, ТЕЛЕФОН);
  assert.equal(чужой.status, 200);
  assert.equal(чужой.body.newDevice, true);

  // хозяин открывает программу у себя и видит предупреждение
  me = await t.call('GET', '/api/me', undefined, a.token, КОМПЬЮТЕР);
  assert.ok(me.body.newDevices && me.body.newDevices.length === 1, 'предупреждение должно быть');
  assert.match(me.body.newDevices[0].ua, /Android/, 'и видно, с чего входили');

  // «это был я» — больше не напоминать
  assert.equal((await t.call('POST', '/api/devices/ack', {}, a.token, КОМПЬЮТЕР)).status, 200);
  me = await t.call('GET', '/api/me', undefined, a.token, КОМПЬЮТЕР);
  assert.equal(me.body.newDevices, undefined, 'после подтверждения не напоминаем');
});

test('свой второй телефон тоже считается новым устройством — и это правильно', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);
  await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' }, null, ТЕЛЕФОН);
  const me = await t.call('GET', '/api/me', undefined, a.token, КОМПЬЮТЕР);
  assert.ok(me.body.newDevices, 'лучше лишний раз спросить, чем пропустить чужого');
});

test('у соседа по серверу свои устройства', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани', КОМПЬЮТЕР);
  await t.signup('firuz@shop.tj', 'Фируз', ТЕЛЕФОН);
  const me = await t.call('GET', '/api/me', undefined, a.token, КОМПЬЮТЕР);
  assert.equal(me.body.newDevices, undefined, 'чужие входы не должны тревожить соседа');
});
