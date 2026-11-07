'use strict';
/* Магазин на двух адресах: свой skladgo.com и прежний skladgo.vercel.app.

   Хозяин купил skladgo.com: «сделай, чтобы склад открывался по моему адресу». Прежний
   адрес остаётся рабочим — на нём у продавцов склад в памяти телефона и установленный
   значок. Cookie входа у каждого адреса своя, поэтому после Google человек должен
   вернуться ровно туда, откуда пришёл, иначе вход не сработает. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createApp } = require('../../server/app');

const root = path.join(__dirname, '..', '..');
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function конфиг(host) {
  const ctx = { location: { hostname: host, search: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), ctx);
  return JSON.parse(JSON.stringify(ctx.SKLAD_CONFIG));
}

test('skladgo.com — настоящий магазин, как и прежний адрес', () => {
  assert.deepEqual(конфиг('skladgo.com'), { api: '/api' });
  assert.deepEqual(конфиг('www.skladgo.com'), { api: '/api' });
  assert.deepEqual(конфиг('skladgo.vercel.app'), { api: '/api' }, 'прежний адрес работает как раньше');
  assert.deepEqual(конфиг('sklad-go-gani26.vercel.app'), { mock: true, own: true }, 'ссылка для друзей не меняется');
});

// Сервер без базы: для входа через Google ему нужно только найти или завести человека
function сервер() {
  const обмен = [];
  const app = createApp({
    db: { base: async () => [{ id: '11111111-1111-4111-8111-111111111111' }] },
    publicUrl: 'https://skladgo.vercel.app',
    origins: ['https://skladgo.com', 'https://www.skladgo.com'],
    googleId: CLIENT_ID, googleSecret: 's', log() {},
    fetch: async (url, opt) => {
      обмен.push(new URLSearchParams(opt.body).get('redirect_uri'));
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return { ok: true, json: async () => ({ id_token: 'x.' + b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Date.now() / 1000 + 60, sub: 'g1', email: 'a@gmail.com', email_verified: true }) + '.x' }) };
    },
  });
  const jar = {};
  const go = (url) => new Promise((done) => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = url;
    req.headers = { cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') };
    const h = {};
    let code = 0;
    app.handle(req, {
      headersSent: false,
      setHeader: (k, v) => { h[k.toLowerCase()] = v; },
      getHeader: (k) => h[k.toLowerCase()],
      writeHead(c, hh) { code = c; Object.entries(hh || {}).forEach(([k, v]) => { h[k.toLowerCase()] = v; }); this.headersSent = true; },
      write() {},
      end() {
        [].concat(h['set-cookie'] || []).forEach((c) => {
          const [k, v] = c.split(';')[0].split('=');
          if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v;
        });
        done({ code, h });
      },
    });
  });
  // весь вход: страница → /auth/google → Google → /auth/callback
  async function войти(start) {
    const g = new URL((await go(start)).h.location);
    const back = await go('/auth/callback?code=c&state=' + g.searchParams.get('state'));
    return { уГугла: g.searchParams.get('redirect_uri'), back, обмен: обмен.pop(), jar };
  }
  return { go, войти, jar };
}

test('вход через Google возвращает на тот адрес, откуда пришли', async () => {
  const с = сервер();
  const r = await с.войти('/auth/google?to=%2F&from=' + encodeURIComponent('https://skladgo.com'));
  assert.equal(r.уГугла, 'https://skladgo.com/auth/callback');
  assert.equal(r.обмен, 'https://skladgo.com/auth/callback', 'обмен кода называет тот же адрес — иначе Google откажет');
  assert.equal(r.back.code, 302);
  assert.equal(r.back.h.location, '/');
  assert.ok(r.jar.sg_s, 'вошёл');

  const v = await сервер().войти('/auth/google?to=%2F&from=' + encodeURIComponent('https://skladgo.vercel.app'));
  assert.equal(v.уГугла, 'https://skladgo.vercel.app/auth/callback');
  assert.equal(v.обмен, 'https://skladgo.vercel.app/auth/callback');
});

test('чужой или пустой адрес — возврат на основной, а не куда скажут', async () => {
  for (const start of ['/auth/google?to=%2F&from=' + encodeURIComponent('https://evil.example'), '/auth/google?to=%2F', '/auth/google?from=skladgo.com']) {
    const r = await сервер().войти(start);
    assert.equal(r.уГугла, 'https://skladgo.vercel.app/auth/callback', start);
    assert.equal(r.обмен, 'https://skladgo.vercel.app/auth/callback', start);
  }
});

test('вход, начатый до обновления сервера (старая cookie без адреса), не ломается', async () => {
  const с = сервер();
  const g = new URL((await с.go('/auth/google?to=%2F')).h.location);
  const [state, verifier, to] = с.jar.sg_o.split('.');
  с.jar.sg_o = [state, verifier, to].join('.');
  const back = await с.go('/auth/callback?code=c&state=' + g.searchParams.get('state'));
  assert.equal(back.h.location, '/');
  assert.ok(с.jar.sg_s);
});

test('app.skladgo.com — настоящий магазин (склад переехал туда с корня skladgo.com)', () => {
  assert.deepEqual(конфиг('app.skladgo.com'), { api: '/api' });
});
