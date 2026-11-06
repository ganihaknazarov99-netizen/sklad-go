'use strict';
/* Нечестный продавец против долгов и истории склада (supabase/schema.sql, docs_guard).

   Проверка безопасности нашла и подтвердила тестами:
   1. (критично) долг стирается насовсем в три записи: долг в корзину, следом сто
      пустых записей корзины «новее» — долг считается вытесненным, — пустые убрать;
   2. (высоко) история склада стирается так же: 400 записей «сейчас» — старое
      вытеснено, — а свои 400 «отменил сразу». И остаток 3 → 0 без записи в истории —
      продажа мимо кассы, в ленте ни строчки;
   3. (низко) заблокированный покупатель удалял аккаунт и вставал в очередь заново.

   Здесь каждая атака — как её делал бы продавец, и рядом обычная работа лавки,
   которая ломаться не должна: продажа, приход, пересчёт, «Отменить», долг, оплата
   частями, корзина и возврат из неё, слияние двух телефонов, полные история и корзина.
   Проверка — на настоящем Postgres (PGlite), через те же server/migrate.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const PGLITE = path.join(__dirname, '..', '..', 'supabase', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
const { migrate } = require('../../server/migrate');
const SkladMerge = require('../../merge.js');

const ХОЗЯИН = '11111111-1111-1111-1111-111111111111';
const ПРОДАВЕЦ = '33333333-3333-3333-3333-333333333333';
const ПОКУПАТЕЛЬ = '55555555-5555-5555-5555-555555555555';
const НОВЫЙ_ПОКУПАТЕЛЬ = '66666666-6666-6666-6666-666666666666';
const МИН = 60 * 1000;
const ДЕНЬ = 24 * 60 * МИН;

const нетPGlite = !fs.existsSync(PGLITE);

async function лавка() {
  const { PGlite } = await import(pathToFileURL(PGLITE).href);
  const pg = new PGlite();
  const db = {
    asUser: (uid, fn) => pg.transaction(async (tx) => {
      await tx.query('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      return fn((sql, p) => tx.query(sql, p).then((r) => r.rows));
    }),
    base: (sql, p) => pg.query(sql, p).then((r) => r.rows),
    exec: (sql) => pg.exec(sql),
  };
  await migrate(db);
  // Команда и покупатели — как есть, в обход охранников (их проверяют другие тесты)
  await pg.exec(`
    set session_replication_role = replica;
    insert into auth.users (id, email, email_confirmed_at, name) values
      ('${ХОЗЯИН}', 'owner@example.com', now(), 'Ганӣ'),
      ('${ПРОДАВЕЦ}', 'seller@example.com', now(), 'Алишер'),
      ('${ПОКУПАТЕЛЬ}', 'buyer@example.com', null, 'Бахром'),
      ('${НОВЫЙ_ПОКУПАТЕЛЬ}', 'new@example.com', null, 'Сафар');
    insert into public.staff (uid, name, owner, status) values
      ('${ХОЗЯИН}', 'Ганӣ', true, 'active'), ('${ПРОДАВЕЦ}', 'Алишер', false, 'active');
    insert into public.customers (uid, name, status) values
      ('${ПОКУПАТЕЛЬ}', 'Бахром', 'blocked'), ('${НОВЫЙ_ПОКУПАТЕЛЬ}', 'Сафар', 'pending');
    set session_replication_role = origin;
  `);

  const писать = (uid, id, data) =>
    db.asUser(uid, (q) => q('select public.doc_set($1, $2::jsonb, null) as v', [id, JSON.stringify(data)]));
  const попытка = async (uid, id, data) => { try { await писать(uid, id, data); return null; } catch (e) { return e.message; } };
  const док = async (id) => (await pg.query('select data from public.docs where id = $1', [id])).rows[0].data;
  // Положить документ как есть — как будто он лежит в базе давно (охрана не трогает запись без входа)
  const посеять = (id, data) => pg.query(
    `insert into public.docs (id, data) values ($1, $2::jsonb)
       on conflict (id) do update set data = excluded.data`, [id, JSON.stringify(data)]);
  // «Прошло время»: записи с отметкой базы (st) и своим временем (t) становятся старше
  async function состарить(id, поле, мс) {
    const d = await док(id);
    d[поле] = d[поле].map((x) => Object.assign({}, x,
      typeof x.st === 'number' ? { st: x.st - мс } : {}, typeof x.t === 'number' ? { t: x.t - мс } : {}));
    await посеять(id, d);
  }
  const меткаЛенты = async () => Number((await pg.query('select coalesce(max(id), 0) as m from public.activity')).rows[0].m);
  const лентаПосле = async (m) => (await pg.query('select "by", txt from public.activity where id > $1 order by id', [m])).rows;
  const архив = async () => (await pg.query('select doc, why, "by", rec from public.docs_archive order by id')).rows;
  return { pg, db, писать, попытка, док, посеять, состарить, меткаЛенты, лентаПосле, архив };
}

// ---------- Как пишет программа (app.js) ----------
const товар = (qty) => ({ id: 'i1', name: 'Куртка', cat: 'Одежда', price: 450, qty, u: 'шт', pk: 1 });
const запись = (t, type, qty, extra) => Object.assign({ by: 'Алишер', t, type, id: 'i1', name: 'Куртка', qty, sum: type === 'out' ? qty * 450 : 0, note: '' }, extra || {});
// apply(): остаток меняется, запись — в начало истории, история держит 400
function продать(S, n, type) {
  const S2 = JSON.parse(JSON.stringify(S));
  const it = S2.items.find((i) => i.id === 'i1');
  it.qty += type === 'in' ? n : -n;
  const l = запись(Date.now(), type || 'out', n);
  S2.log.unshift(l);
  S2.log = S2.log.slice(0, 400);
  return { S: S2, l };
}
const склад = (qty, log) => ({ items: [товар(qty)], log: log || [], cats: ['Одежда'], trash: [], biz: '' });
const бахром = { id: 'p1', name: 'Бахром' };
const долг = (id, amt, t, extra) => Object.assign({ id, pid: 'p1', type: 'give', amt, t, note: '', by: 'Ганӣ', at: t }, extra || {});
const всеДолги = (d) => [...(d.ops || []), ...(d.trash || []).flatMap((e) => e.k === 'op' ? [e.op] : e.k === 'person' ? e.ops || [] : [])];

// =====================================================================
// 1. Критично: долг стирается насовсем в три записи
// =====================================================================
test('атака: долг в корзину → сто пустых записей корзины «новее» → пустые убрать. Долг остаётся', { skip: нетPGlite && 'нет PGlite: cd supabase && npm install' }, async () => {
  const L = await лавка();
  const вчера = Date.now() - ДЕНЬ;
  await L.посеять('debts', { people: [бахром], ops: [долг('D', 1000, вчера)], trash: [] });

  // а) долг — в корзину: это можно
  let d = await L.док('debts');
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, ops: [],
    trash: [{ id: 'tD', k: 'op', t: Date.now(), by: 'Алишер', pn: 'Бахром', op: d.ops[0], person: null }] }), null);
  // б) сто пустых записей корзины «из будущего» — долг как будто вытеснен
  d = await L.док('debts');
  const мусор = Array.from({ length: 100 }, (_, k) => ({ id: 'j' + k, k: 'item', t: Date.now() + ДЕНЬ + k, by: 'Алишер', item: { id: 'x' + k, name: 'x', qty: 0 } }));
  await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, trash: мусор });
  // в) пустые — убрать, всё остальное оставить как есть
  d = await L.док('debts');
  await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, trash: d.trash.filter((e) => e.k !== 'item') });

  d = await L.док('debts');
  const D = всеДолги(d).find((o) => o.id === 'D');
  assert.ok(D, 'долг на 1000 не пропал из базы');
  assert.equal(D.amt, 1000);
  assert.ok(d.trash.some((e) => e.id === 'tD'), 'и лежит в корзине, откуда его можно вернуть');
  assert.ok(!d.trash.some((e) => e.k === 'item'), 'а пустые записи продавец убрал — это ничего не стирает');
});

test('атака: корзину забивают не пустыми, а выдуманными долгами — долг всё равно остаётся', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('debts', { people: [бахром], ops: [долг('D', 1000, Date.now() - ДЕНЬ)], trash: [] });
  let d = await L.док('debts');
  await L.писать(ПРОДАВЕЦ, 'debts', { ...d, ops: [], trash: [{ id: 'tD', k: 'op', t: Date.now(), pn: 'Бахром', op: d.ops[0], person: null }] });
  // сто записей корзины с долгами по 1 сомони, сразу «новее», долг выброшен — одной записью
  d = await L.док('debts');
  const выдумка = Array.from({ length: 100 }, (_, k) => ({ id: 'f' + k, k: 'op', t: Date.now() + ДЕНЬ + k, pn: 'Бахром',
    op: { id: 'fo' + k, pid: 'p1', type: 'give', amt: 1, t: Date.now() } }));
  await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, trash: выдумка });
  // то же в два шага: сначала сто настоящих долгов в список, потом все — в корзину
  d = await L.док('debts');
  const сто = Array.from({ length: 100 }, (_, k) => ({ id: 'r' + k, pid: 'p1', type: 'give', amt: 1, t: Date.now() }));
  await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, ops: [...d.ops, ...сто] });
  d = await L.док('debts');
  await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, ops: d.ops.filter((o) => !/^r/.test(o.id)),
    trash: [...d.trash, ...d.ops.filter((o) => /^r/.test(o.id)).map((o, k) => ({ id: 'rt' + k, k: 'op', t: Date.now(), pn: 'Бахром', op: o, person: null }))].slice(-100) });

  d = await L.док('debts');
  assert.equal(всеДолги(d).find((o) => o.id === 'D').amt, 1000, 'долг на 1000 на месте');
});

test('атака: продавец просто выбрасывает долг из корзины — отказ, как и раньше', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('debts', { people: [бахром], ops: [], trash: [{ id: 'tD', k: 'op', t: Date.now() - ДЕНЬ, pn: 'Бахром', op: долг('D', 1000, Date.now() - 2 * ДЕНЬ) }] });
  const d = await L.док('debts');
  assert.match(await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, trash: [] }), /debt_vanished/);
  assert.match(await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, trash: [{ id: 'j', k: 'item', t: Date.now(), item: {} }] }), /debt_vanished/);
});

// =====================================================================
// 2. Высоко: история склада и продажа мимо истории
// =====================================================================
test('атака: 400 записей истории «сейчас», потом «отменить» их — старая история на месте', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  const давно = Date.now() - 3 * ДЕНЬ;
  const старое = [запись(давно + 2000, 'out', 1, { by: 'Ганӣ' }), запись(давно + 1000, 'out', 2, { by: 'Ганӣ' }), запись(давно, 'in', 8, { by: 'Ганӣ', note: 'Поставка' })];
  await L.посеять('main', склад(5, старое));

  // 1) 400 «сегодняшних» записей, старое выброшено
  let m = await L.док('main');
  const мусор = Array.from({ length: 400 }, (_, k) => запись(Date.now() - k, 'fix', 0, { note: 'мусор' }));
  await L.попытка(ПРОДАВЕЦ, 'main', { ...m, log: мусор });
  // 2) свои 400 — «отменил сразу»: всё, кроме мусора, оставить как есть
  m = await L.док('main');
  await L.попытка(ПРОДАВЕЦ, 'main', { ...m, log: m.log.filter((l) => l.note !== 'мусор') });

  m = await L.док('main');
  for (const s of старое) {
    assert.ok(m.log.some((l) => l.t === s.t && l.qty === s.qty && l.type === s.type), 'запись от ' + new Date(s.t).toISOString() + ' на месте');
  }
});

test('атака: мусор выждал 10 минут — его уже не убрать, а вытесненное лежит в архиве', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  const давно = Date.now() - 3 * ДЕНЬ;
  const старое = [запись(давно + 1000, 'out', 2, { by: 'Ганӣ' }), запись(давно, 'in', 8, { by: 'Ганӣ' })];
  await L.посеять('main', склад(6, старое));
  let m = await L.док('main');
  const мусор = Array.from({ length: 400 }, (_, k) => запись(Date.now() - k, 'fix', 0, { note: 'мусор' }));
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', { ...m, log: мусор }), null, 'запись проходит');
  m = await L.док('main');
  assert.equal(m.log.length, 402, 'но старое база положила назад: внесённое только что ничего не вытесняет');

  await L.состарить('main', 'log', 11 * МИН);   // прошло 11 минут
  m = await L.док('main');
  assert.match(await L.попытка(ПРОДАВЕЦ, 'main', { ...m, log: m.log.filter((l) => l.note !== 'мусор') }), /log_vanished/,
    'через 10 минут свои 400 записей уже не «отменить»');
  // Теперь 400 устоявшихся записей новее — старое вытесняется по-честному
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', { ...m, log: m.log.filter((l) => l.note === 'мусор') }), null);
  m = await L.док('main');
  assert.equal(m.log.filter((l) => l.note === 'мусор').length, 400, 'мусор продавца остаётся в истории — под его именем');
  assert.ok(m.log.every((l) => l.by === 'Алишер'));
  const а = await L.архив();
  assert.equal(а.filter((x) => x.doc === 'main' && x.why === 'evicted').length, 2, 'вытесненное не пропало — оно в архиве');
  assert.ok(а.every((x) => x.by === 'Алишер'), 'и видно, чья запись его вытеснила');
});

test('атака: остаток 3 → 0 без записи в истории — в ленте строчка продавца', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('main', склад(3, [запись(Date.now() - ДЕНЬ, 'in', 3, { by: 'Ганӣ' })]));
  const m = await L.док('main');
  const метка = await L.меткаЛенты();
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', { ...m, items: [товар(0)] }), null, 'не отказ — слияние телефонов тоже меняет остаток');
  const л = await L.лентаПосле(метка);
  assert.ok(л.some((x) => x.by === 'Алишер' && /без записи в истории/.test(x.txt) && /«Куртка» 3 → 0/.test(x.txt)),
    'хозяин видит в ленте: ' + JSON.stringify(л));
});

test('атака: товар с остатком пропал из склада, но не в корзину — тоже строчка в ленте', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('main', склад(4));
  let m = await L.док('main');
  let метка = await L.меткаЛенты();
  await L.писать(ПРОДАВЕЦ, 'main', { ...m, items: [] });
  assert.ok((await L.лентаПосле(метка)).some((x) => /«Куртка» 4 → 0/.test(x.txt)));
  // в два шага: «удалить товар» (в корзину — остаток там виден) и «убрать из корзины»
  await L.посеять('main', склад(4));
  m = await L.док('main');
  метка = await L.меткаЛенты();
  await L.писать(ПРОДАВЕЦ, 'main', { ...m, items: [], trash: [{ id: 'ti', k: 'item', t: Date.now(), by: 'Алишер', item: m.items[0] }] });
  assert.deepEqual(await L.лентаПосле(метка), [], 'удалить в корзину — не строчка: товар с остатком лежит в корзине');
  m = await L.док('main');
  await L.писать(ПРОДАВЕЦ, 'main', { ...m, trash: [] });
  assert.ok((await L.лентаПосле(метка)).some((x) => x.by === 'Алишер' && /«Куртка» 4 → 0/.test(x.txt)), 'убрать из корзины — строчка');
});

test('атака: отметки базы (st, su) телефон не подделает', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('main', склад(5));
  let m = await L.док('main');
  // новая запись «давно внесена» и «хозяином»
  const { S, l } = продать(m, 1);
  S.log[0] = { ...l, st: 1, su: ХОЗЯИН };
  await L.писать(ПРОДАВЕЦ, 'main', S);
  m = await L.док('main');
  assert.ok(m.log[0].st > Date.now() - МИН, 'время появления поставила база');
  assert.equal(m.log[0].su, ПРОДАВЕЦ, 'и чья запись — тоже');
  // прежней записи — подменить отметку
  await L.писать(ПРОДАВЕЦ, 'main', { ...m, log: [{ ...m.log[0], st: 1, su: ХОЗЯИН }] });
  const m2 = await L.док('main');
  assert.equal(m2.log[0].st, m.log[0].st, 'отметка прежней записи — как была');
  assert.equal(m2.log[0].su, ПРОДАВЕЦ);
  // корзина долгов: время удаления по часам базы
  await L.посеять('debts', { people: [бахром], ops: [долг('o1', 10, Date.now() - ДЕНЬ)], trash: [] });
  let d = await L.док('debts');
  await L.писать(ПРОДАВЕЦ, 'debts', { ...d, ops: [], trash: [{ id: 't1', k: 'op', t: 5, st: 5, pn: 'Бахром', op: d.ops[0] }] });
  d = await L.док('debts');
  assert.ok(d.trash[0].st > Date.now() - МИН, 'время удаления в корзину поставила база');
  await L.писать(ПРОДАВЕЦ, 'debts', { ...d, trash: [{ ...d.trash[0], st: 5, t: 5 }] });
  const d2 = await L.док('debts');
  assert.equal(d2.trash[0].st, d.trash[0].st);
  assert.equal(d2.trash[0].t, d.trash[0].t, 'и время записи корзины — как было');
});

// =====================================================================
// 3. Низко: заблокированный покупатель
// =====================================================================
test('заблокированный покупатель аккаунт не удалит; ожидающий — удалит', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await assert.rejects(L.db.asUser(ПОКУПАТЕЛЬ, (q) => q('select public.delete_my_account()')), /blocked_cannot_delete/);
  assert.equal((await L.pg.query('select count(*)::int as n from auth.users where id = $1', [ПОКУПАТЕЛЬ])).rows[0].n, 1);
  assert.equal((await L.pg.query("select status from public.customers where uid = $1", [ПОКУПАТЕЛЬ])).rows[0].status, 'blocked');
  await L.db.asUser(НОВЫЙ_ПОКУПАТЕЛЬ, (q) => q('select public.delete_my_account()'));
  assert.equal((await L.pg.query('select count(*)::int as n from auth.users where id = $1', [НОВЫЙ_ПОКУПАТЕЛЬ])).rows[0].n, 0);
  await assert.rejects(L.db.asUser(ХОЗЯИН, (q) => q('select public.delete_my_account()')), /owner_cannot_delete/);
});

// =====================================================================
// Обычная работа лавки — не ломается
// =====================================================================
test('продавец: продажа, приход, пересчёт, «Отменить» — без отказов и без строчек про остаток', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('main', склад(5, [запись(Date.now() - ДЕНЬ, 'in', 5, { by: 'Ганӣ' })]));
  const метка = await L.меткаЛенты();
  let m = await L.док('main');

  let r = продать(m, 1);                                 // продажа
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', r.S), null);
  m = await L.док('main');
  assert.equal(m.items[0].qty, 4);
  assert.equal(m.log[0].by, 'Алишер');

  r = продать(m, 3, 'in');                               // приход
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', r.S), null);
  m = await L.док('main');
  assert.equal(m.items[0].qty, 7);

  // пересчёт: остаток 7 → 6, запись «fix» с разницей
  const S = JSON.parse(JSON.stringify(m));
  S.items[0].qty = 6; S.log.unshift(запись(Date.now(), 'fix', -1, { sum: 0, note: 'Пересчёт' }));
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', S), null);
  m = await L.док('main');

  // «Отменить» последнюю продажу сразу: остаток назад, запись — из истории
  r = продать(m, 2);
  await L.писать(ПРОДАВЕЦ, 'main', r.S);
  m = await L.док('main');
  assert.equal(m.items[0].qty, 4);
  const U = JSON.parse(JSON.stringify(m));
  U.items[0].qty += 2; U.log = U.log.filter((l) => l.t !== r.l.t);
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', U), null, 'отменить сразу можно');
  m = await L.док('main');
  assert.equal(m.items[0].qty, 6);
  assert.ok(!m.log.some((l) => l.t === r.l.t));

  assert.deepEqual((await L.лентаПосле(метка)).map((x) => x.txt), [], 'в ленте от охраны — ни строчки');
  const а = await L.архив();
  assert.deepEqual(а.map((x) => [x.why, x.rec.qty]), [['undone', 2]], 'отменённая продажа отложена в архив');

  // через 10 минут отменить уже нельзя
  r = продать(m, 1);
  await L.писать(ПРОДАВЕЦ, 'main', r.S);
  await L.состарить('main', 'log', 11 * МИН);
  m = await L.док('main');
  assert.match(await L.попытка(ПРОДАВЕЦ, 'main', { ...m, items: [товар(m.items[0].qty + 1)], log: m.log.slice(1) }), /log_vanished/);
});

test('чужую свежую запись продавец отменить может (как раньше), но хозяин это видит', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('main', склад(5));
  let m = await L.док('main');
  const r = продать(m, 1);
  r.S.log[0].by = 'Ганӣ';
  await L.писать(ХОЗЯИН, 'main', r.S);
  m = await L.док('main');
  const метка = await L.меткаЛенты();
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', { ...m, items: [товар(5)], log: [] }), null);
  const л = await L.лентаПосле(метка);
  assert.deepEqual(л.map((x) => [x.by, x.txt]), [['Алишер', 'отменил чужие записи в истории склада: 1']]);
  assert.deepEqual((await L.архив()).map((x) => [x.why, x.by, x.rec.by]), [['undone', 'Алишер', 'Ганӣ']]);
});

test('продавец: новый товар с остатком, удаление в корзину и возврат из неё — без строчек про остаток', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('main', склад(0));
  const метка = await L.меткаЛенты();
  let m = await L.док('main');
  // новый товар: заведён с нулём, «Начальный остаток» — приходом
  const n = { id: 'i2', name: 'Шапка', cat: 'Одежда', price: 100, qty: 4, u: 'шт' };
  await L.писать(ПРОДАВЕЦ, 'main', { ...m, items: [...m.items, n],
    log: [{ by: 'Алишер', t: Date.now(), type: 'in', id: 'i2', name: 'Шапка', qty: 4, sum: 0, note: 'Начальный остаток' }, ...m.log] });
  m = await L.док('main');
  // удалить в корзину склада
  await L.писать(ПРОДАВЕЦ, 'main', { ...m, items: m.items.filter((i) => i.id !== 'i2'),
    trash: [...m.trash, { id: 'ti2', k: 'item', t: Date.now(), by: 'Алишер', item: m.items.find((i) => i.id === 'i2') }] });
  m = await L.док('main');
  // вернуть из корзины — с прежним остатком
  await L.писать(ПРОДАВЕЦ, 'main', { ...m, items: [...m.items, m.trash[0].item], trash: [] });
  m = await L.док('main');
  assert.equal(m.items.find((i) => i.id === 'i2').qty, 4);
  assert.deepEqual((await L.лентаПосле(метка)).map((x) => x.txt), []);
});

test('два телефона продают одновременно: слияние (merge.js) проходит, остаток верный, строчек нет', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('main', склад(10));
  const метка = await L.меткаЛенты();
  const база = await L.док('main');
  // хозяин продал 1
  const a = продать(база, 1);
  a.l.by = 'Ганӣ'; a.S.log[0].by = 'Ганӣ';
  await L.писать(ХОЗЯИН, 'main', a.S);
  // продавец без связи продал 2 — потом сливает своё с тем, что на сервере
  const b = продать(база, 2);
  const R = await L.док('main');
  const слито = SkladMerge.mergeMain(база, b.S, R);
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', { ...слито, biz: '' }), null);
  const m = await L.док('main');
  assert.equal(m.items[0].qty, 7);
  assert.equal(m.log.length, 2);
  assert.deepEqual((await L.лентаПосле(метка)).map((x) => x.txt), []);
});

test('продавец: долг, оплата частями, в корзину и обратно', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('debts', { people: [], ops: [], trash: [] });
  const метка = await L.меткаЛенты();
  let d = await L.док('debts');
  const now = Date.now();
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { people: [бахром], ops: [долг('o1', 1000, now, { by: 'Алишер', at: 0 })], trash: [] }), null);
  d = await L.док('debts');
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, ops: [...d.ops, долг('o2', 300, now + 1, { type: 'get', by: 'Алишер', at: 0 })] }), null, 'оплата частями');
  d = await L.док('debts');
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, ops: d.ops.filter((o) => o.id !== 'o2'),
    trash: [{ id: 't2', k: 'op', t: Date.now(), by: 'Алишер', pn: 'Бахром', op: d.ops.find((o) => o.id === 'o2'), person: null }] }), null, 'в корзину');
  d = await L.док('debts');
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, ops: [...d.ops, d.trash[0].op], trash: [] }), null, 'вернуть из корзины');
  d = await L.док('debts');
  assert.deepEqual(d.ops.map((o) => [o.id, o.amt, o.by]), [['o1', 1000, 'Алишер'], ['o2', 300, 'Алишер']]);
  // человека со всеми долгами — в корзину, и вернуть
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { people: [], ops: [],
    trash: [{ id: 'tp', k: 'person', t: Date.now(), pn: 'Бахром', person: бахром, ops: d.ops }] }), null);
  d = await L.док('debts');
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { people: [бахром], ops: d.trash[0].ops, trash: [] }), null);
  assert.deepEqual((await L.лентаПосле(метка)).map((x) => x.txt), []);
  assert.deepEqual(await L.архив(), [], 'ничего не ушло — архив пуст');
});

test('полная корзина долгов: у продавца удаление проходит, старое база кладёт назад; хозяин вытесняет по-честному', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  const давно = Date.now() - 30 * ДЕНЬ;
  const корзина = Array.from({ length: 100 }, (_, k) => ({ id: 'x' + k, k: 'op', t: давно + k * МИН, by: 'Ганӣ', pn: 'Бахром',
    op: долг('ox' + k, 1, давно - ДЕНЬ + k) }));
  await L.посеять('debts', { people: [бахром], ops: [долг('o1', 50, давно), долг('o2', 70, давно)], trash: корзина });
  const метка = await L.меткаЛенты();
  // продавец удаляет долг — программа держит в корзине 100 последних
  let d = await L.док('debts');
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, ops: d.ops.filter((o) => o.id !== 'o1'),
    trash: d.trash.concat([{ id: 't1', k: 'op', t: Date.now(), by: 'Алишер', pn: 'Бахром', op: d.ops[0], person: null }]).slice(-100) }), null);
  d = await L.док('debts');
  assert.equal(d.trash.length, 101, 'самая старая запись корзины вернулась: продавец ничего не вытесняет');
  assert.equal(d.trash[0].id, 'x0');
  // хозяин удаляет долг — его программа обрезает до 100, и старое уходит по-честному
  assert.equal(await L.попытка(ХОЗЯИН, 'debts', { ...d, ops: d.ops.filter((o) => o.id !== 'o2'),
    trash: d.trash.concat([{ id: 't2', k: 'op', t: Date.now(), by: 'Ганӣ', pn: 'Бахром', op: d.ops.find((o) => o.id === 'o2'), person: null }]).slice(-100) }), null);
  d = await L.док('debts');
  assert.equal(d.trash.length, 100);
  assert.deepEqual(d.trash.slice(0, 1).map((x) => x.id), ['x2'], 'вытеснены две самые старые');
  assert.deepEqual((await L.лентаПосле(метка)).map((x) => x.txt), [], 'это не правка задним числом — строчки нет');
  const а = await L.архив();
  assert.deepEqual(а.map((x) => [x.doc, x.why, x.rec.id]), [['debts', 'evicted', 'ox0'], ['debts', 'evicted', 'ox1']], 'вытесненное — в архиве');
});

test('программу хозяина не обмануть: пустые записи продавца в корзине долг не вытесняют', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  const вчера = Date.now() - ДЕНЬ;
  await L.посеять('debts', { people: [бахром], ops: [долг('o9', 5, вчера)],
    trash: [{ id: 'tD', k: 'op', t: вчера, pn: 'Бахром', op: долг('D', 1000, вчера - ДЕНЬ) }] });
  // продавец докладывает 100 пустых записей «новее» (ничего не стирая — это пропускается)
  let d = await L.док('debts');
  const мусор = Array.from({ length: 100 }, (_, k) => ({ id: 'j' + k, k: 'item', t: Date.now() + k, item: { id: 'y' + k } }));
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'debts', { ...d, trash: [...d.trash, ...мусор] }), null);
  // хозяин удаляет долг: его программа обрезает корзину до 100 — и долг D оказался бы «вытеснен»
  d = await L.док('debts');
  const метка = await L.меткаЛенты();
  await L.писать(ХОЗЯИН, 'debts', { ...d, ops: [],
    trash: d.trash.concat([{ id: 't9', k: 'op', t: Date.now(), pn: 'Бахром', op: d.ops[0], person: null }]).slice(-100) });
  d = await L.док('debts');
  assert.equal(всеДолги(d).find((o) => o.id === 'D').amt, 1000, 'долг D на месте: пустые записи в счёт не идут');
  assert.deepEqual((await L.лентаПосле(метка)).map((x) => x.txt), []);
});

test('полная история (400): продажа проходит, история — 400 устоявшихся плюс свежие, старое уходит в архив', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  const давно = Date.now() - 10 * ДЕНЬ;
  const история = Array.from({ length: 400 }, (_, k) => запись(давно - k * МИН, 'in', 1, { by: 'Ганӣ' }));
  await L.посеять('main', склад(400, история));
  const метка = await L.меткаЛенты();
  let m = await L.док('main');
  let r = продать(m, 1);
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', r.S), null);
  m = await L.док('main');
  assert.equal(m.log.length, 401, 'самая старая осталась: свежая продажа ещё может быть отменена');
  assert.equal(m.log[400].t, давно - 399 * МИН);
  // прошло 11 минут — следующая продажа вытесняет самую старую по-честному
  await L.состарить('main', 'log', 11 * МИН);
  m = await L.док('main');
  r = продать(m, 1);
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', r.S), null);
  m = await L.док('main');
  assert.equal(m.log.length, 401);
  assert.equal(m.items[0].qty, 398);
  const а = await L.архив();
  assert.equal(а.length, 1);
  assert.equal(а[0].why, 'evicted');
  assert.equal(а[0].rec.t, давно - 399 * МИН - 11 * МИН);
  assert.deepEqual((await L.лентаПосле(метка)).map((x) => x.txt), []);
});

test('хозяин: полная история — по-настоящему старое вытесняется молча; стереть может, но со строчкой в ленте', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  const давно = Date.now() - 10 * ДЕНЬ;
  const история = Array.from({ length: 410 }, (_, k) => запись(давно - k * МИН, 'in', 1, { by: 'Ганӣ' }));
  await L.посеять('main', склад(410, история));
  const метка = await L.меткаЛенты();
  let m = await L.док('main');
  const r = продать(m, 1);
  r.S.log[0].by = 'Ганӣ';
  assert.equal(await L.попытка(ХОЗЯИН, 'main', r.S), null);
  m = await L.док('main');
  assert.equal(m.log.length, 401, '400 устоявшихся и одна свежая');
  assert.equal((await L.архив()).filter((x) => x.why === 'evicted').length, 10, 'десять самых старых — в архиве');
  assert.deepEqual((await L.лентаПосле(метка)).map((x) => x.txt), [], 'это не стирание — строчки нет');
  // хозяину можно стереть и старое — но на виду
  await L.писать(ХОЗЯИН, 'main', { ...m, log: m.log.slice(0, 10) });
  const л = await L.лентаПосле(метка);
  assert.ok(л.some((x) => x.by === 'Ганӣ' && /стёр задним числом записи истории склада: 391/.test(x.txt)), JSON.stringify(л));
  assert.equal((await L.архив()).filter((x) => x.why === 'removed').length, 391, 'и стёртое — в архиве');
});

test('хозяин переписал долг — строчка в ленте, прежний вид — в архиве; архив видит только хозяин', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  await L.посеять('debts', { people: [бахром], ops: [долг('o1', 1000, Date.now() - ДЕНЬ)], trash: [] });
  const d = await L.док('debts');
  await L.писать(ХОЗЯИН, 'debts', { ...d, ops: [{ ...d.ops[0], amt: 900 }] });
  const а = await L.архив();
  assert.deepEqual(а.map((x) => [x.why, x.rec.amt]), [['changed', 1000]]);
  assert.equal((await L.db.asUser(ХОЗЯИН, (q) => q('select count(*)::int as n from public.docs_archive')))[0].n, 1);
  assert.equal((await L.db.asUser(ПРОДАВЕЦ, (q) => q('select count(*)::int as n from public.docs_archive')))[0].n, 0, 'продавец архива не видит');
  await L.db.asUser(ПРОДАВЕЦ, (q) => q("insert into public.docs_archive (t, doc, why, rec) values (1, 'debts', 'x', '{}')")).catch(() => {});
  await L.db.asUser(ПРОДАВЕЦ, (q) => q('delete from public.docs_archive')).catch(() => {});
  assert.equal((await L.pg.query('select count(*)::int as n from public.docs_archive')).rows[0].n, 1, 'ни дописать, ни стереть');
});

test('схема при каждом запуске сервера: повторный запуск данных не меняет', { skip: нетPGlite && 'нет PGlite' }, async () => {
  const L = await лавка();
  // данные «как до этой правки»: записи без отметок базы
  await L.посеять('main', склад(3, [запись(Date.now() - ДЕНЬ, 'in', 3, { by: 'Ганӣ' })]));
  await L.посеять('debts', { people: [бахром], ops: [долг('o1', 10, Date.now() - ДЕНЬ)],
    trash: [{ id: 't', k: 'op', t: Date.now() - ДЕНЬ, op: долг('o0', 5, Date.now() - 2 * ДЕНЬ) }] });
  const до = (await L.pg.query('select id, data, version from public.docs order by id')).rows;
  await migrate({ exec: (s) => L.pg.exec(s), base: (s, p) => L.pg.query(s, p).then((r) => r.rows) });
  await migrate({ exec: (s) => L.pg.exec(s), base: (s, p) => L.pg.query(s, p).then((r) => r.rows) });
  const после = (await L.pg.query('select id, data, version from public.docs order by id')).rows;
  assert.deepEqual(после, до);
  assert.deepEqual(await L.архив(), []);
  // и старые записи дальше работают: продавец продаёт как обычно
  const m = await L.док('main');
  assert.equal(await L.попытка(ПРОДАВЕЦ, 'main', продать(m, 1).S), null);
});
