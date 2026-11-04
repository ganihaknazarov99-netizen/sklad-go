'use strict';
/* Подготовка базы при каждом запуске сервера. Всё повторяемо: второй запуск ничего не ломает.
   1. setup.sql — то, что давал Supabase: роли, auth.users, auth.uid(), сессии.
   2. supabase/schema.sql — те же правила доступа и охрана долгов, что и были. Живые
      обновления Supabase (publication supabase_realtime) отрезаем: здесь их нет, свои — в after.sql.
   3. after.sql — права, перенос команды с первого шага переезда, сигналы и понятные таблицы. */
const fs = require('node:fs');
const path = require('node:path');

function schemaSql() {
  const s = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  const cut = s.indexOf('-- ---------- Живые обновления');
  return cut > 0 ? s.slice(0, cut) : s;
}

async function migrate(db) {
  await db.exec(fs.readFileSync(path.join(__dirname, 'setup.sql'), 'utf8'));
  await db.exec(schemaSql());
  await db.exec(fs.readFileSync(path.join(__dirname, 'after.sql'), 'utf8'));
}

module.exports = { migrate, schemaSql };
