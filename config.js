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
    'skladgo.vercel.app': { api: '/api' },
    // Адрес для проверки правок сервера, прежде чем они попадут в магазин
    'sklad-go-git-claude-happy-agnesi-467428-gani26.vercel.app': { api: '/api' }
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
  window.SKLAD_CONFIG = МАГАЗИН[location.hostname] || (mock ? { mock: true } : { url: '', anonKey: '' });
})();
