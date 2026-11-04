'use strict';
/* Подключение к PostgreSQL (Railway). Каждый запрос человека идёт в своей транзакции
   под ролью authenticated, а в request.jwt.claim.sub записан его uid — так же, как делал
   Supabase. Поэтому правила supabase/schema.sql работают здесь без единой правки. */
const { Pool, Client, types } = require('pg');

// bigint (время в миллисекундах, версия документа) — числом, как отдавал Supabase
types.setTypeParser(20, (v) => Number(v));

function createPg(url) {
  if (!url) throw new Error('Не задан DATABASE_URL — адрес базы на Railway');
  const pool = new Pool({ connectionString: url, max: 10 });
  pool.on('error', () => {});   // оборвалось простаивающее соединение — пул откроет новое

  const db = {
    // от имени человека: правила доступа и охрана долгов действуют
    async asUser(uid, fn) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
        const r = await fn((sql, params) => c.query(sql, params).then((x) => x.rows));
        await c.query('commit');
        return r;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    // от имени самого сервера: вход, сессии
    base: (sql, params) => pool.query(sql, params).then((x) => x.rows),
    // несколько команд разом (подготовка базы при запуске)
    exec: (sql) => pool.query(sql),
    // «изменилось то-то» из базы (srv.notify) — для живых обновлений на телефонах
    listen(cb) {
      let wait = 1000;
      const go = () => {
        const c = new Client({ connectionString: url });
        c.on('notification', (n) => { if (n.channel === 'sklad') cb(n.payload); });
        c.on('error', () => {});
        c.on('end', () => setTimeout(go, wait = Math.min(wait * 2, 30000)));
        c.connect().then(() => c.query('listen sklad')).then(() => { wait = 1000; }, () => c.end().catch(() => {}));
      };
      go();
    },
    close: () => pool.end(),
  };
  return db;
}

module.exports = { createPg };
