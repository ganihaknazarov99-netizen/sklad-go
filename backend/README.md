# Backend Sklad Go

Запуск: `node server.js` (Node ≥ 22.13) · Тесты: `npm test` · Настройки: `.env.example`.

## Устройство
```
server.js          сервер, маршруты, раздача сайта, заголовки безопасности
src/config.js      настройки из переменных окружения / .env
src/db.js          схема SQLite (users, codes, sessions, docs, audit, settings)
src/security.js    scrypt, токены, коды, ограничитель частоты
src/mailer.js      отправка писем: console | memory | webhook
src/auth.js        регистрация, вход, коды, сброс пароля, профиль, удаление аккаунта
src/docs.js        документы склада/долгов, права, лента, виртуальная коллекция staff, SSE
test/api.test.js   автоматические проверки
```

## API (все ответы JSON; защищённые запросы — заголовок `Authorization: Bearer <token>`)
| Метод и путь | Что делает |
|---|---|
| `POST /api/auth/register` {email,password,name,phone} | регистрация, отправка кода |
| `POST /api/auth/verify` {email,code} | подтверждение почты |
| `POST /api/auth/resend` {email} | новый код |
| `POST /api/auth/login` {email,password} | вход → `{token,user}` |
| `POST /api/auth/logout` | выход |
| `POST /api/auth/forgot` {email} · `POST /api/auth/reset` {email,code,newPassword} | сброс пароля |
| `POST /api/auth/change-password` {oldPassword,newPassword} | смена пароля |
| `GET/PATCH/DELETE /api/me` | профиль, изменение, удаление (кроме владельца) |
| `GET/PUT/PATCH/DELETE /api/docs/{коллекция}/{id}` | документы: `warehouse/main`, `warehouse/debts`, виртуальные `staff/{id}`, `meta/owner` |
| `GET/POST /api/collections/{имя}` | список (`orderBy`, `dir`, `limit`) и добавление (только `activity`) |
| `POST /api/stream/ticket` → `GET /api/stream?ticket=` | события об изменениях (SSE), билет одноразовый |
| `GET /api/health` | проверка живости |

Коды ошибок возвращаются как `{"error":"bad_credentials"}` и т. п. (см. `frontend/auth.js`, словарь `ERR`).
