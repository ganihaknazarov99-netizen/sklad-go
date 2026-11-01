'use strict';
/* Показательная версия (корень: backend.js + merge.js) с Supabase. База теперь
   не даёт продавцу переписать записанный долг или стереть историю склада
   (supabase/schema.sql, docs_guard; сама охрана проверяется в supabase/proverka.mjs).
   Здесь — что программа делает с отказом: понимает его и чинит свои данные так,
   чтобы следующая отправка прошла и ничего своего не потерялось. */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../merge.js');

// Поддельные окно и Supabase: человек вошёл, а сервер на запись отвечает ошибкой
async function загрузить(ошибка) {
  const el = () => ({ style: {}, innerHTML: '', textContent: '', onclick: null });
  global.window = global;
  global.document = { readyState: 'complete', getElementById: el, addEventListener() {}, body: { appendChild() {} }, createElement: () => ({}) };
  global.location = { search: '', hash: '', pathname: '/', href: 'https://skladgo.vercel.app/' };
  global.history = { replaceState() {} };
  global.SKLAD_CONFIG = { url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' };
  global.supabase = {
    createClient: () => ({
      auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b.c', user_metadata: {} } } } }),
        onAuthStateChange() {},
      },
      rpc: () => Promise.resolve({ data: null, error: ошибка }),
      from() {}, channel() {}, removeChannel() {},
    }),
  };
  delete require.cache[require.resolve('../../backend.js')];
  require('../../backend.js');
  await new Promise((r) => setImmediate(r));
  return window.skladBackend.db();
}

for (const [код, слова] of [
  ['debt_changed', /долг нельзя изменить задним числом/],
  ['debt_vanished', /уходит в корзину/],
  ['log_vanished', /истории склада нельзя стереть/],
]) {
  test(`отказ базы «${код}» доходит до программы своим кодом и человеческими словами`, async () => {
    const db = await загрузить({ code: 'P0001', message: код });
    await assert.rejects(db.doc('warehouse/debts').set({}, { ifMatch: 3 }), (e) => {
      assert.equal(e.code, код);
      assert.match(e.message, слова);
      return true;
    });
  });
}

test('прочие ошибки работают как раньше: конфликт версий — слить и повторить', async () => {
  const db = await загрузить({ code: 'P0001', message: 'version_conflict' });
  await assert.rejects(db.doc('warehouse/main').set({}, { ifMatch: 3 }), (e) => e.code === 'version_conflict');
});

// ---------- Долги: после отказа берём записанное с сервера, своё новое оставляем ----------
const T = 1_700_000_000_000;
const долг = (id, amt, extra) => Object.assign({ id, pid: 'p1', type: 'give', amt, t: T, by: 'Ганӣ', at: T }, extra || {});
const бахром = { id: 'p1', name: 'Бахром' };

test('правка старого долга уходит, а новый долг, записанный без интернета, остаётся', () => {
  const сервер = { people: [бахром], ops: [долг('o1', 1000)], trash: [] };
  const телефон = { people: [бахром], ops: [долг('o1', 10), долг('o9', 70, { t: T + 5, at: T + 5 })], trash: [] };
  const r = M.debtsServerWins(телефон, сервер);
  assert.equal(r.ops.find((o) => o.id === 'o1').amt, 1000, 'спорное — как на сервере');
  assert.ok(r.ops.find((o) => o.id === 'o9'), 'своё новое не потерялось');
});

test('стёртый без корзины долг возвращается; удалённый в корзину — нет', () => {
  const сервер = { people: [бахром], ops: [долг('o1', 1000), долг('o2', 300)], trash: [] };
  const телефон = { people: [бахром], ops: [], trash: [{ id: 't2', k: 'op', t: T + 9, op: долг('o2', 300) }] };
  const r = M.debtsServerWins(телефон, сервер);
  assert.ok(r.ops.find((o) => o.id === 'o1'), 'стёртый молча — вернулся');
  assert.ok(!r.ops.find((o) => o.id === 'o2'), 'удалённый в корзину — в корзине и остался');
  assert.deepEqual(r.trash.map((x) => x.id), ['t2']);
});

test('корзину сервера не выбросить, но восстановленное из неё назад не попадает', () => {
  const сервер = { people: [бахром], ops: [], trash: [
    { id: 't1', k: 'op', t: T + 1, op: долг('o1', 1000) },
    { id: 't3', k: 'op', t: T + 3, op: долг('o3', 40) },
  ] };
  // t1 телефон выбросил, t3 — восстановил: долг o3 снова в списке
  const телефон = { people: [бахром], ops: [долг('o3', 40)], trash: [] };
  const r = M.debtsServerWins(телефон, сервер);
  assert.deepEqual(r.trash.map((x) => x.id), ['t1'], 'выброшенное вернулось в корзину');
  assert.deepEqual(r.ops.map((o) => o.id), ['o3'], 'восстановленное осталось в списке, в корзину не вернулось');
});

test('подправленный в корзине долг — как на сервере', () => {
  const сервер = { people: [бахром], ops: [], trash: [{ id: 't1', k: 'op', t: T + 1, op: долг('o1', 1000) }] };
  const телефон = { people: [бахром], ops: [], trash: [{ id: 't1', k: 'op', t: T + 1, op: долг('o1', 1) }] };
  assert.equal(M.debtsServerWins(телефон, сервер).trash[0].op.amt, 1000);
});

test('человек с долгами возвращается в список, без долгов — нет', () => {
  const сафар = { id: 'p2', name: 'Сафар' };
  const сервер = { people: [бахром, сафар], ops: [долг('o1', 1000)], trash: [] };
  const телефон = { people: [], ops: [долг('o1', 1000)], trash: [] };
  const r = M.debtsServerWins(телефон, сервер);
  assert.deepEqual(r.people.map((p) => p.id), ['p1'], 'Бахром вернулся: за ним долг; Сафара без долгов не тащим');
});

// ---------- История склада ----------
const запись = (t, qty, by) => ({ by: by || 'Ганӣ', t, type: 'out', id: 'i1', name: 'Футболка', qty, sum: qty * 85, note: '' });

test('история: стёртое возвращается, своё новое остаётся, подпись — как на сервере, новые сверху', () => {
  const сервер = [запись(T + 2, 1, 'Алишер'), запись(T + 1, 2), запись(T, 3)];
  const телефон = [запись(T + 9, 7, 'Алишер'), запись(T + 2, 1, 'Ганӣ')];   // T+1 и T стёрлись, подпись подменена
  const r = M.logServerWins(телефон, сервер);
  assert.deepEqual(r.map((l) => l.t), [T + 9, T + 2, T + 1, T]);
  assert.equal(r[1].by, 'Алишер');
});
