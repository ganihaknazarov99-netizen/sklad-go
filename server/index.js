'use strict';
/* Запуск сервера Sklad Go на Railway: npm start.
   Настройки (Railway → сервис sklad-go → Variables):
     DATABASE_URL          — ${{Postgres.DATABASE_URL}}, база Railway
     PUBLIC_URL            — адрес склада, где его открывают люди: https://skladgo.vercel.app
     GOOGLE_CLIENT_ID      — из Google Cloud → APIs & Services → Credentials
     GOOGLE_CLIENT_SECRET  — оттуда же. Вписывает только хозяин, в код не попадает
   PORT Railway задаёт сам. */
const http = require('node:http');
const { createPg } = require('./db-pg');
const { migrate } = require('./migrate');
const { createApp } = require('./app');

(async () => {
  const env = process.env;
  const db = createPg(env.DATABASE_URL);
  await migrate(db);
  const app = createApp({
    db,
    publicUrl: env.PUBLIC_URL,
    origins: String(env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    googleId: env.GOOGLE_CLIENT_ID,
    googleSecret: env.GOOGLE_CLIENT_SECRET,
    fetch,
  });
  db.listen(app.notify);
  if (!env.GOOGLE_CLIENT_SECRET) console.error('Нет GOOGLE_CLIENT_SECRET — вход через Google не заработает');
  http.createServer(app.handle).listen(Number(env.PORT) || 8080, () => console.log('Sklad Go: сервер запущен'));
  // Просроченные сессии больше не нужны
  setInterval(() => db.base('delete from srv.sessions where expires_at < now()').catch(() => {}), 6 * 3600e3).unref();
})().catch((e) => {
  console.error('Сервер не запустился:', e);
  process.exit(1);
});
