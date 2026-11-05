'use strict';
/* Копии базы на своём сервере (after.sql: srv.backup_now, srv.restore_backup) — на
   настоящем Postgres (PGlite).

   Хозяин: «копии базы». Проверяем: копия снимается, только когда что-то изменилось;
   старые копии прореживаются, а не копятся вечно; после порчи данных копия возвращает
   склад, и сам возврат тоже можно отменить; с сайта до копий не добраться никому. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const PGLITE = path.join(__dirname, '..', '..', 'supabase', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
const { migrate } = require('../../server/migrate');
const ХОЗЯИН = '11111111-1111-1111-1111-111111111111';

test('копии базы: снимаются, прореживаются, возвращают данные и закрыты для сайта', async (t) => {
  if (!fs.existsSync(PGLITE)) { t.skip('нет PGlite: cd supabase && npm install'); return; }
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
  await pg.query("insert into public.settings values ('owner_email', 'g@test.tj')");
  await pg.query("insert into auth.users (id, email, email_confirmed_at, google_sub, name) values ($1, 'g@test.tj', now(), 'g1', 'Гани')", [ХОЗЯИН]);
  await db.asUser(ХОЗЯИН, (q) => q("insert into public.staff (name, phone, mail) values ('Гани', '+992900097337', 'g@test.tj')"));
  const склад = { items: [{ id: 'i1', name: 'Куртка', qty: 4, price: 450 }, { id: 'i2', name: 'Кепка', qty: 1, price: 40 }], log: [], biz: 'Магазин' };
  const долги = { people: [{ id: 'p1', name: 'Фируз' }], ops: [{ id: 'o1', pid: 'p1', type: 'give', amt: 450, t: 1, note: 'Куртка' }], trash: [] };
  await db.asUser(ХОЗЯИН, async (q) => {
    await q('select public.doc_set($1, $2::jsonb, null)', ['main', JSON.stringify(склад)]);
    await q('select public.doc_set($1, $2::jsonb, null)', ['debts', JSON.stringify(долги)]);
    await q("insert into public.activity (txt) values ('добавил куртку')");
  });
  const снять = async () => (await pg.query('select srv.backup_now() as m')).rows[0].m;
  const копий = async () => (await pg.query('select count(*)::int as n from srv.backups')).rows[0].n;

  await t.test('копия — только когда что-то изменилось', async () => {
    assert.equal(await снять(), 'копия сохранена');
    assert.equal(await снять(), 'без изменений');
    assert.equal(await копий(), 1);
    await db.asUser(ХОЗЯИН, (q) => q("insert into public.activity (txt) values ('продал кепку')"));
    assert.equal(await снять(), 'копия сохранена');
    assert.equal(await копий(), 2);
    const v = (await pg.query('select * from public.копии_базы')).rows[0];
    assert.deepEqual([Number(v.товаров), Number(v.записей_долгов), v.в_команде], [2, 1, 1], 'в списке видно, что в копии');
  });

  await t.test('склад испортили — копия возвращает всё, а возврат можно отменить', async () => {
    const хорошая = (await pg.query('select max(id) as id from srv.backups')).rows[0].id;
    const до = Number((await pg.query("select version from public.docs where id = 'main'")).rows[0].version);
    // хозяину можно всё — например, по ошибке стереть склад
    await db.asUser(ХОЗЯИН, (q) => q('select public.doc_set($1, $2::jsonb, $3)', ['main', JSON.stringify({ items: [], log: [], biz: 'Магазин' }), до]));
    assert.equal((await pg.query("select jsonb_array_length(data->'items') as n from public.docs where id = 'main'")).rows[0].n, 0);
    const m = (await pg.query('select srv.restore_backup($1) as m', [хорошая])).rows[0].m;
    assert.match(m, /Возвращено из копии №/);
    const main = (await pg.query("select data, version from public.docs where id = 'main'")).rows[0];
    assert.deepEqual(main.data.items.map((i) => i.name), ['Куртка', 'Кепка']);
    assert.ok(Number(main.version) > до + 1, 'версия выросла — телефоны перечитают склад, а не затрут его своим');
    const лента = (await pg.query('select txt from public.activity order by id')).rows.map((r) => r.txt);
    assert.deepEqual(лента.slice(0, 2), ['добавил куртку', 'продал кепку'], 'лента не стёрта');
    assert.match(лента.at(-1), /данные возвращены из копии от/);
    assert.equal(Number((await pg.query("select count(*) from public.товары")).rows[0].count), 2, 'понятные таблицы пересобраны');
    // перед возвратом снята копия испорченного состояния — возврат тоже можно отменить
    const испорченная = (await pg.query("select count(*)::int as n from srv.backups where jsonb_array_length((select x->'data'->'items' from jsonb_array_elements(data->'docs') x where x->>'id' = 'main')) = 0")).rows[0].n;
    assert.equal(испорченная, 1);
    assert.equal((await pg.query('select owner, status from public.staff where uid = $1', [ХОЗЯИН])).rows[0].owner, true, 'хозяин на месте');
  });

  await t.test('старые копии прореживаются: месяц — все, дальше — одна в неделю, полгода', async () => {
    // старые копии: 5 в одну и ту же неделю 40 дней назад (понедельник, с 10 до 14 часов), 3 — полгода назад
    for (const h of [10, 11, 12, 13, 14]) await pg.query("insert into srv.backups (t, sha, data) values (date_trunc('week', now() - interval '40 days') + make_interval(hours => $1), $2, '{}')", [h, 'old' + h]);
    for (const d of [200, 201, 202]) await pg.query("insert into srv.backups (t, sha, data) values (now() - make_interval(days => $1), $2, '{}')", [d, 'old' + d]);
    await db.asUser(ХОЗЯИН, (q) => q("insert into public.activity (txt) values ('ещё запись')"));
    await снять();
    const старых = (await pg.query("select count(*)::int as n from srv.backups where t < now() - interval '30 days'")).rows[0].n;
    assert.equal(старых, 1, 'из пяти в той неделе осталась одна, полугодовые — ушли');
    assert.ok((await копий()) >= 4, 'свежие на месте');
  });

  await t.test('с сайта до копий не добраться', async () => {
    const нельзя = async (sql) => { try { await db.asUser(ХОЗЯИН, (q) => q(sql)); return false; } catch (e) { return /permission denied/.test(e.message); } };
    assert.ok(await нельзя('select * from srv.backups'), 'даже хозяин через программу не читает копии');
    assert.ok(await нельзя('select srv.restore_backup(1)'));
    assert.ok(await нельзя('select srv.backup_now()'));
    assert.ok(await нельзя('select * from public.копии_базы'));
    assert.ok(await нельзя('delete from srv.backups'));
  });

  await pg.close();
});
