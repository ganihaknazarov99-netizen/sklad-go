'use strict';
/* server/db-pg.js: запрос человека дольше 10 секунд база обрывает сама (statement_timeout).
   Один тяжёлый запрос не должен занимать соединение (их в пуле 10) и вешать лавку всем.
   Проверяем: команда стоит в каждой транзакции человека до его запросов, и обычный
   запрос с ней работает как прежде — и на поддельном pg, и на настоящем Postgres (PGlite). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const PGLITE = path.join(__dirname, '..', '..', 'supabase', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
const ТАЙМАУТ = "set local statement_timeout = '10s'";

// Поддельный модуль pg: записывает команды, на запрос отвечает строкой
function поддельныйPg(запросы, ошибка) {
  class Client {
    async query(sql, params) {
      запросы.push(sql);
      if (ошибка && ошибка.test(sql)) throw new Error('canceling statement due to statement timeout');
      return { rows: [{ ok: 1, params: params || null }] };
    }
    release() {}
  }
  class Pool {
    on() {}
    async connect() { return new Client(); }
    async query() { return { rows: [] }; }
    async end() {}
  }
  return { Pool, Client: class {}, types: { setTypeParser() {} } };
}

function загрузить(pg) {
  const file = require.resolve('pg', { paths: [path.join(__dirname, '..', '..', 'server')] });
  const m = new Module(file);
  m.filename = file; m.loaded = true; m.exports = pg;
  require.cache[file] = m;
  delete require.cache[require.resolve('../../server/db-pg')];
  try { return require('../../server/db-pg'); } finally { delete require.cache[file]; }
}

test('db-pg: в каждой транзакции человека — предел 10 секунд, до его запросов; обычный запрос работает', async () => {
  const запросы = [];
  const { createPg } = загрузить(поддельныйPg(запросы));
  const db = createPg('postgres://u:p@localhost/x');
  const r = await db.asUser('11111111-1111-1111-1111-111111111111', (q) => q('select 1 as ok'));
  assert.equal(r[0].ok, 1, 'ответ запроса дошёл');
  assert.deepEqual(запросы, ['begin', ТАЙМАУТ, 'set local role authenticated',
    "select set_config('request.jwt.claim.sub', $1, true)", 'select 1 as ok', 'commit']);
});

test('db-pg: запрос, оборванный по времени, откатывает транзакцию и возвращает ошибку', async () => {
  const запросы = [];
  const { createPg } = загрузить(поддельныйPg(запросы, /^select pg_sleep/));
  const db = createPg('postgres://u:p@localhost/x');
  await assert.rejects(db.asUser('11111111-1111-1111-1111-111111111111', (q) => q('select pg_sleep(60)')), /statement timeout/);
  assert.equal(запросы[запросы.length - 1], 'rollback');
});

test('на настоящем Postgres: с пределом времени склад читается и пишется как прежде', { skip: !fs.existsSync(PGLITE) && 'нет PGlite' }, async () => {
  const { PGlite } = await import(pathToFileURL(PGLITE).href);
  const { migrate } = require('../../server/migrate');
  const pg = new PGlite();
  await migrate({ exec: (s) => pg.exec(s), base: (s, p) => pg.query(s, p).then((x) => x.rows) });
  const U = '11111111-1111-1111-1111-111111111111';
  await pg.exec(`set session_replication_role = replica;
    insert into auth.users (id, email, email_confirmed_at, name) values ('${U}', 'o@example.com', now(), 'Ганӣ');
    insert into public.staff (uid, name, owner, status) values ('${U}', 'Ганӣ', true, 'active');
    set session_replication_role = origin;`);
  // те же команды, что у asUser в server/db-pg.js
  const как = (fn) => pg.transaction(async (tx) => {
    await tx.query(ТАЙМАУТ);
    await tx.query('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [U]);
    const t = await tx.query('show statement_timeout');
    return fn((sql, p) => tx.query(sql, p).then((x) => x.rows), t.rows[0].statement_timeout);
  });
  const v = await как(async (q, предел) => {
    assert.equal(предел, '10s');
    return (await q("select public.doc_set('main', $1::jsonb, null) as v", [JSON.stringify({ items: [], log: [] })]))[0].v;
  });
  assert.equal(Number(v), 1);
  const d = await как((q) => q("select data from public.docs where id = 'main'"));
  assert.deepEqual(d[0].data.items, []);
  assert.equal((await pg.query('show statement_timeout')).rows[0].statement_timeout, '0', 'предел — только внутри транзакции человека');
  await pg.close();
});
