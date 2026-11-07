/* Подключение к серверу.

   Настоящий склад включается только на адресах из списка МАГАЗИН. На всех
   остальных — витрина: демо, данные только в этом браузере. Склад на всех
   адресах один и тот же код, поэтому без этого списка друзья, которым вы
   отправили ссылку «попробуй», попали бы к вам в магазин в очередь —
   со своими именами, телефонами и почтой.

   Сервер — свой, на Railway (папка server/, база Postgres там же).
   { api: '/api' } значит: спрашивать этот же сайт, а Vercel пересылает /api
   и /auth на Railway (vercel.json). Ключей здесь нет и не нужно: вход держит
   сервер, а кто что видит — решают правила supabase/schema.sql в базе.

   До 4 ноября 2026 магазин работал на Supabase. Его адрес и ключ publishable
   остались в истории git (config.js до коммита «Магазин на своём сервере
   Railway»): вернуть их сюда — и магазин снова на Supabase.

   Тайные ключи (secret, service_role, ключ Google) сюда не вписывать никогда. */
(function () {
  var МАГАЗИН = {
    // Склад магазина. Сам skladgo.com с 7 ноября 2026 — страница о складе (skladgo.com/about,
    // vercel.json → redirects); склад — на app.skladgo.com
    'app.skladgo.com': { api: '/api' },
    // Свой адрес магазина (куплен 4 ноября 2026 в Railway Domains). Оставлен для тех, кто успел
    // открыть склад по нему; www Vercel перенаправляет сюда же
    'skladgo.com': { api: '/api' },
    'www.skladgo.com': { api: '/api' },
    // Прежний адрес магазина: работает как раньше, данные и вход те же
    'skladgo.vercel.app': { api: '/api' },
    // Адрес для проверки правок сервера, прежде чем они попадут в магазин
    'sklad-go-git-claude-happy-agnesi-467428-gani26.vercel.app': { api: '/api' },
    // Ссылка для друзей: сначала регистрация, потом свой пустой склад в этом телефоне (mock.js)
    'sklad-go-gani26.vercel.app': { mock: true, own: true }
  };
  // Тестовый режим (адрес с ?mock, выключить — ?mock=off): вход по почте и паролю как
  // владелец или покупатель, всё только в этом браузере (mock.js). На адресах
  // магазина не включается никогда — там всегда настоящий сервер
  var mock = false;
  try {
    if (/[?&]mock=off\b/.test(location.search)) localStorage.removeItem('skladgo.mockmode');
    else if (/[?&]mock\b/.test(location.search)) localStorage.setItem('skladgo.mockmode', '1');
    mock = localStorage.getItem('skladgo.mockmode') === '1';
  } catch (e) {}
  // skladgo.com с 7 ноября 2026 — страница о складе, а склад — на app.skladgo.com. Телефон, где
  // склад уже открывали по skladgo.com, мог показать сохранённую копию склада: уводим на страницу.
  // Кроме случая, когда на телефоне есть неотправленное: тогда склад сначала дошлёт своё
  try {
    if (location.hostname === 'skladgo.com' && location.pathname === '/' &&
        localStorage.getItem('skladgo.dirty.main') !== '1' && localStorage.getItem('skladgo.dirty.debts') !== '1') {
      location.replace('/about');
    }
  } catch (e) {}
  window.SKLAD_CONFIG = МАГАЗИН[location.hostname] || (mock ? { mock: true } : { url: '', anonKey: '' });
})();
