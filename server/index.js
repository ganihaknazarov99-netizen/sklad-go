'use strict';
/* Запуск сервера Sklad Go на Railway: npm start.
   Настройки (Railway → сервис sklad-go → Variables):
     DATABASE_URL          — ${{Postgres.DATABASE_URL}}, база Railway
     PUBLIC_URL            — основной адрес склада: https://skladgo.vercel.app (на него вернёт
                             Google, если страница не сказала свой адрес — старая копия программы)
     EXTRA_ORIGINS         — другие адреса склада через запятую (адрес для проверки правок).
                             Свой адрес магазина skladgo.com вписан ниже (АДРЕСА) и есть всегда.
                             Каждый адрес нужен и в Google
                             (Credentials → Authorized redirect URIs: <адрес>/auth/callback)
     GOOGLE_CLIENT_ID      — из Google Cloud → APIs & Services → Credentials
     GOOGLE_CLIENT_SECRET  — оттуда же. Вписывает только хозяин, в код не попадает
   PORT Railway задаёт сам. */
const http = require('node:http');
const { createPg } = require('./db-pg');
const { migrate } = require('./migrate');
const { createApp } = require('./app');

// Свой адрес магазина (куплен 4 ноября 2026). С него можно входить и писать всегда,
// даже если в Railway → Variables его не вписали
const АДРЕСА = ['https://app.skladgo.com', 'https://skladgo.com', 'https://www.skladgo.com'];

(async () => {
  const env = process.env;
  const db = createPg(env.DATABASE_URL);
  await migrate(db);
  const app = createApp({
    db,
    publicUrl: env.PUBLIC_URL,
    origins: АДРЕСА.concat(String(env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)),
    googleId: env.GOOGLE_CLIENT_ID,
    googleSecret: env.GOOGLE_CLIENT_SECRET,
    // адрес посетителя для счёта попыток входа ставит прокси Railway, в этом заголовке
    ipHeader: 'x-real-ip',
    fetch,
  });
  db.listen(app.notify);
  if (!env.GOOGLE_CLIENT_SECRET) console.error('Нет GOOGLE_CLIENT_SECRET — вход через Google не заработает');
  http.createServer(app.handle).listen(Number(env.PORT) || 8080, () => console.log('Sklad Go: сервер запущен'));
  // Просроченные сессии больше не нужны
  setInterval(() => db.base('delete from srv.sessions where expires_at < now()').catch(() => {}), 6 * 3600e3).unref();
  // Копия всей базы при запуске и каждые 6 часов — если что-то изменилось (srv.backup_now в after.sql)
  const копия = () => db.base('select srv.backup_now() as m')
    .then((r) => console.log('Копия базы: ' + r[0].m), (e) => console.error('Копия базы не снялась:', e.message));
  копия();
  setInterval(копия, 6 * 3600e3).unref();
})().catch((e) => {
  console.error('Сервер не запустился:', e);
  process.exit(1);
});
