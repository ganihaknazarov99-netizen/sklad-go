'use strict';
/* Копия программы на телефоне (корневой sw.js): склад открывается без интернета.

   Гоняем настоящий sw.js в песочнице: сеть и хранилище копий — поддельные,
   поэтому можно «выключить интернет» и «замедлить» сеть. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'sw.js'), 'utf8');
const ORIGIN = 'https://skladgo.vercel.app';

function песочница({ сеть, копия = {} }) {
  const положено = {};
  const слушатели = {};
  const cache = {
    put: (r, res) => { положено[typeof r === 'string' ? r : r.url] = res; return Promise.resolve(); },
    addAll: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  };
  const ключ = (r) => { const u = new URL(typeof r === 'string' ? r : r.url, ORIGIN); return u.origin === ORIGIN ? u.pathname : u.href; };
  const ctx = {
    self: { addEventListener: (t, f) => { слушатели[t] = f; }, skipWaiting() {}, clients: { claim() {} } },
    location: { origin: ORIGIN },
    caches: {
      open: () => Promise.resolve(cache),
      keys: () => Promise.resolve([]),
      match: (r, o) => {
        const k = ключ(r);
        const без = k.split('?')[0];
        return Promise.resolve(копия[k] || (o && o.ignoreSearch ? копия[без] : undefined));
      },
    },
    fetch: сеть,
    Response, Request, URL, Promise,
    setTimeout: (f) => { setImmediate(f); return 1; }, clearTimeout() {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, положено, слушатели };
}
const ответ = (t, status = 200) => Object.assign(new Response(t, { status }), {}); // type у Response в Node — 'default'
const базовый = (t) => { const r = new Response(t); Object.defineProperty(r, 'type', { value: 'basic' }); return r; };
const запрос = (url, mode) => ({ url: new URL(url, ORIGIN).href, method: 'GET', mode: mode || 'cors' });
const текст = (r) => r.text();

test('интернет есть — отдаём свежее и обновляем копию', async () => {
  const { ctx, положено } = песочница({ сеть: () => Promise.resolve(базовый('новая app.js')), копия: { '/app.js': ответ('старая app.js') } });
  const r = await ctx.fresh(запрос('/app.js'));
  assert.equal(await текст(r), 'новая app.js', 'у продавцов сразу новая версия, а не через раз');
  await new Promise((d) => setImmediate(d));
  assert.ok(положено[new URL('/app.js', ORIGIN).href], 'копия обновлена');
});

test('интернета нет — склад открывается из копии', async () => {
  const { ctx } = песочница({ сеть: () => Promise.reject(new TypeError('Failed to fetch')), копия: { '/app.js': ответ('app.js из копии') } });
  assert.equal(await текст(await ctx.fresh(запрос('/app.js'))), 'app.js из копии');
});

test('открыли страницу с хвостом в адресе (после входа Google) — без сети тоже открывается', async () => {
  const { ctx } = песочница({ сеть: () => Promise.reject(new TypeError('offline')), копия: { '/': ответ('страница') } });
  assert.equal(await текст(await ctx.fresh(запрос('/?code=abc', 'navigate'))), 'страница');
});

test('сеть «висит» — не ждём бесконечно, а отдаём копию', async () => {
  const { ctx } = песочница({ сеть: () => new Promise(() => {}), копия: { '/backend.js': ответ('backend из копии') } });
  assert.equal(await текст(await ctx.fresh(запрос('/backend.js'))), 'backend из копии');
});

test('сервер ответил ошибкой — лучше копия, чем сломанная страница', async () => {
  const { ctx } = песочница({ сеть: () => Promise.resolve(ответ('ошибка', 502)), копия: { '/index.html': ответ('index из копии') } });
  assert.equal(await текст(await ctx.fresh(запрос('/index.html'))), 'index из копии');
});

test('ни сети, ни копии — честное «Нет связи», а не вечная загрузка', async () => {
  const { ctx } = песочница({ сеть: () => Promise.reject(new TypeError('offline')) });
  const r = await ctx.fresh(запрос('/neizvestno.js'));
  assert.equal(r.status, 503);
});

test('запросы к Supabase и прочие чужие идут мимо копии — данные склада не кешируются', async () => {
  const { слушатели } = песочница({ сеть: () => Promise.resolve(ответ('{}')) });
  let перехвачено = false;
  слушатели.fetch({ request: запрос('https://qjymwgulpcxyuuphsfrx.supabase.co/rest/v1/docs?id=eq.main'), respondWith: () => { перехвачено = true; } });
  assert.equal(перехвачено, false);
  слушатели.fetch({ request: { ...запрос('/app.js'), method: 'POST' }, respondWith: () => { перехвачено = true; } });
  assert.equal(перехвачено, false, 'запись не перехватываем');
});
