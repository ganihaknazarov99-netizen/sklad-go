'use strict';
/* Запасной ключ от склада (scripts/admin.js).

   Проверяем не вывод на экран, а то ради чего он есть: человек, запертый
   снаружи вторым фактором, должен снова войти — и на работающем сервере,
   без его перезапуска. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../server');
const TOTP = require('../src/totp');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'admin.js');

async function boot(ctx) {
  // Нужен файл на диске: скрипт открывает ту же базу отдельным процессом
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skladgo-admin-'));
  const dbPath = path.join(dir, 'sklad.db');
  const app = createApp({ port: 0, dbPath, mailMode: 'memory', staticDir: __dirname });
  const port = await app.listen();
  ctx.after(async () => { await app.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

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
  async function signup(email, name, pw = 'password123') {
    assert.equal((await call('POST', '/api/auth/register', { email, password: pw, name, phone: '+992901234567' })).status, 201);
    await call('POST', '/api/auth/verify', { email, code: lastCode(email) });
    const l = await call('POST', '/api/auth/login', { email, password: pw });
    return { token: l.body.token, user: l.body.user };
  }
  // запускаем ключ так же, как владелец на сервере
  const admin = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: Object.assign({}, process.env, { DB_PATH: dbPath }),
  });
  return { app, call, signup, admin, dbPath };
}

test('список показывает, кто есть и у кого включён второй фактор', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани');
  const st = await t.call('POST', '/api/2fa/setup', { password: 'password123' }, a.token);
  await t.call('POST', '/api/2fa/enable', { code: TOTP.codeAt(st.body.secret, Date.now()) }, a.token);

  const out = t.admin('list');
  assert.match(out, /gani@shop\.tj/);
  assert.match(out, /владелец/);
  assert.match(out, /второй фактор: включён/);
});

test('телефон утонул, запасные коды потеряны — владелец возвращается в свой склад', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани');
  const st = await t.call('POST', '/api/2fa/setup', { password: 'password123' }, a.token);
  await t.call('POST', '/api/2fa/enable', { code: TOTP.codeAt(st.body.secret, Date.now()) }, a.token);

  // вот она, беда: пароль помним, а подтвердить нечем
  const locked = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' });
  assert.equal(locked.body.needTotp, true);
  assert.equal(locked.body.token, undefined);

  // владелец заходит на сервер и снимает второй фактор
  const out = t.admin('2fa-off', 'gani@shop.tj');
  assert.match(out, /выключен/);

  // сервер НЕ перезапускался — и всё равно пускает сразу
  const back = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' });
  assert.equal(back.status, 200);
  assert.ok(back.body.token, 'после снятия второго фактора вход должен открыться');
  assert.equal(back.body.user.totp, false);
});

test('забыл пароль — новый выдаётся с сервера и сразу работает', async (ctx) => {
  const t = await boot(ctx);
  await t.signup('gani@shop.tj', 'Гани');

  const out = t.admin('password', 'gani@shop.tj');
  const pw = (out.match(/\n {6}(\S{12})\n/) || [])[1];
  assert.ok(pw, 'скрипт должен показать новый пароль, вот его вывод:\n' + out);

  assert.equal((await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' })).status, 401, 'старый пароль должен перестать работать');
  const ok = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: pw });
  assert.equal(ok.status, 200, 'новый пароль должен пускать');
});

test('выданный пароль годится и для самой программы: её же правила', async (ctx) => {
  const t = await boot(ctx);
  await t.signup('gani@shop.tj', 'Гани');
  const pw = (t.admin('password', 'gani@shop.tj').match(/\n {6}(\S{12})\n/) || [])[1];
  const l = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: pw });
  // меняем его на свой — значит программа приняла выданный как действующий
  const ch = await t.call('POST', '/api/auth/change-password', { oldPassword: pw, newPassword: 'moy-parol-7' }, l.body.token);
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
});

test('смена пароля с сервера закрывает прежние входы', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани');
  assert.equal((await t.call('GET', '/api/me', undefined, a.token)).status, 200);

  t.admin('password', 'gani@shop.tj');
  assert.equal((await t.call('GET', '/api/me', undefined, a.token)).status, 401,
    'если пароль меняют из-за кражи, вор не должен остаться внутри');
});

test('новые запасные коды работают, старые перестают', async (ctx) => {
  const t = await boot(ctx);
  const a = await t.signup('gani@shop.tj', 'Гани');
  const st = await t.call('POST', '/api/2fa/setup', { password: 'password123' }, a.token);
  const en = await t.call('POST', '/api/2fa/enable', { code: TOTP.codeAt(st.body.secret, Date.now()) }, a.token);
  const старый = en.body.backup[0];

  const out = t.admin('codes', 'gani@shop.tj');
  const новые = out.match(/\d{5}-[0-9A-Z]{4}/g) || [];
  assert.equal(новые.length, 8, 'должно выдаться восемь кодов');

  const l1 = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' });
  assert.equal((await t.call('POST', '/api/auth/login-2fa', { pending: l1.body.pending, code: старый })).status, 401, 'старый код должен умереть');

  const l2 = await t.call('POST', '/api/auth/login', { email: 'gani@shop.tj', password: 'password123' });
  assert.equal((await t.call('POST', '/api/auth/login-2fa', { pending: l2.body.pending, code: новые[0] })).status, 200, 'новый должен пустить');
});

test('заблокированного сотрудника можно вернуть с сервера', async (ctx) => {
  const t = await boot(ctx);
  const own = await t.signup('gani@shop.tj', 'Гани');
  const inv = await t.call('GET', '/api/docs/meta/invite', undefined, own.token);
  const r = await t.call('POST', '/api/auth/register', { email: 'alisher@shop.tj', password: 'password123', name: 'Алишер', phone: '+992901234567', invite: inv.body.data.code });
  assert.equal(r.status, 201);

  t.admin('unblock', 'alisher@shop.tj');
  const out = t.admin('list');
  assert.match(out, /alisher@shop\.tj\s+сотрудник\s+активен/);
});

test('на незнакомую почту отвечает по-человечески, а не падает', async (ctx) => {
  const t = await boot(ctx);
  await t.signup('gani@shop.tj', 'Гани');
  assert.throws(
    () => t.admin('password', 'нет-такого@shop.tj'),
    (e) => /в базе нет/.test(String(e.stderr || '')),
    'должно быть внятное объяснение, а не след ошибки'
  );
});
