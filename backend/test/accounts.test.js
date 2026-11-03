'use strict';
/* Регистрация и смена аккаунта (корневой backend.js).

   Хозяин: «почему нет регистрации или смены аккаунта?». Регистрация здесь — тот же вход
   через Google, но на экране входа была одна кнопка «Войти», и новичок не понимал, где
   зарегистрироваться. А Google молча входил в последний аккаунт: войти другим Gmail
   (продавцу на телефоне хозяина) было никак. */
const test = require('node:test');
const assert = require('node:assert/strict');

function загрузить(store) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', textContent: '', onclick: null, disabled: false });
  const вход = [];
  let выходов = 0;
  global.window = global;
  global.document = { readyState: 'complete', getElementById: el, addEventListener() {}, body: { appendChild() {} }, createElement: () => ({}) };
  global.location = { search: '', hash: '', pathname: '/', href: 'https://skladgo.vercel.app/', reload() {} };
  global.history = { replaceState() {} };
  // хранилище как в браузере: ключи — свои поля, методы не перечисляются
  const ls = {};
  Object.assign(ls, store || {});
  Object.defineProperties(ls, {
    getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null) },
    setItem: { value: (k, v) => { ls[k] = String(v); } },
    removeItem: { value: (k) => { delete ls[k]; } },
  });
  global.localStorage = ls;
  global.SKLAD_CONFIG = { url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' };
  global.supabase = {
    createClient: () => ({
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange() {},
        signInWithOAuth: (o) => { вход.push(o); return Promise.resolve({ data: {} }); },
        signOut: () => { выходов++; return Promise.resolve({}); },
      },
      from() {}, rpc() {}, channel() {}, removeChannel() {},
    }),
  };
  delete require.cache[require.resolve('../../backend.js')];
  require('../../backend.js');
  return { els, вход, выходы: () => выходов, ls };
}
const дождаться = () => new Promise((r) => setImmediate(r));

test('на экране входа есть «Регистрация» и объяснение, что это вход своим Gmail', async () => {
  const { els } = загрузить();
  await дождаться();
  const h = els.auth.innerHTML;
  assert.match(h, /id="gin"[^>]*>Войти через Google/);
  assert.match(h, /id="greg"[^>]*>Регистрация/);
  assert.match(h, /Регистрация — это тот же вход через ваш Gmail/);
  assert.match(h, /href="https:\/\/accounts\.google\.com\/signup"/, 'у кого нет Gmail — есть куда пойти');
});

test('и «Войти», и «Регистрация» открывают Google со списком аккаунтов', async () => {
  const { els, вход } = загрузить();
  await дождаться();
  els.gin.onclick.call(els.gin);
  els.greg.onclick.call(els.greg);
  assert.equal(вход.length, 2);
  for (const o of вход) {
    assert.equal(o.provider, 'google');
    assert.equal(o.options.queryParams.prompt, 'select_account', 'Google не входит молча в последний аккаунт');
  }
  assert.equal(els.greg.textContent, 'Открываю Google…');
});

test('«Сменить аккаунт» выходит, стирает данные прежнего аккаунта на телефоне и ведёт к выбору аккаунта', async () => {
  const { вход, выходы, ls } = загрузить({ 'skladgo.v1': '{"items":[]}', 'skladgo.uid': 'u1', 'skladgo.lang': 'tg', 'чужое': '1' });
  await дождаться();
  await global.skladAuth.switchAccount();
  assert.equal(выходы(), 1, 'сначала выход');
  assert.equal(ls.getItem('skladgo.v1'), null, 'склад прежнего аккаунта с телефона стёрт');
  assert.equal(ls.getItem('skladgo.uid'), null);
  assert.equal(ls.getItem('чужое'), '1', 'не наше — не трогаем');
  assert.equal(ls.getItem('skladgo.lang'), 'tg', 'язык остаётся — продавец не окажется на русском');
  assert.equal(вход.length, 1, 'потом сразу вход');
  assert.equal(вход[0].options.queryParams.prompt, 'select_account');
});
