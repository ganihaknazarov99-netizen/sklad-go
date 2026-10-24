# Выкладка Sklad Go на сервер (Ubuntu 24.04)

## 0. Что купить
1. **Сервер (VPS)** — самый маленький тариф (1 ГБ памяти) хватит. Ubuntu 24.04. Например Hetzner, DigitalOcean, Contabo. Цены проверьте на сайте.
2. **Домен** (Namecheap, Porkbun и т. п.) — около 10 долларов в год.
3. **Почтовый сервис Resend** (resend.com) — для писем с кодами; на старте обычно хватает бесплатного тарифа (проверьте условия).

## 1. Домен и почта
- В панели домена создайте запись **A**: `sklad` → IP вашего сервера.
- В Resend добавьте домен и вставьте в панель домена записи, которые он покажет (SPF/DKIM). Дождитесь «Verified». Создайте API-ключ.

## 2. Подготовка сервера (под root)
```
apt update && apt install -y curl unzip ufw debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
apt install -y caddy
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
useradd -r -m -d /opt/skladgo skladgo
```
Проверка: `node --version` должно показать 22.13 или выше.

## 3. Загрузка программы
С вашего компьютера: `scp sklad-go-fullstack.zip root@IP:/tmp/`
На сервере:
```
cd /opt/skladgo && unzip /tmp/sklad-go-fullstack.zip && mv sklad-go-fullstack/* . && rmdir sklad-go-fullstack
cp backend/.env.example backend/.env && nano backend/.env
chown -R skladgo:skladgo /opt/skladgo
```
В `.env` задайте:
```
MAIL_MODE=webhook
MAIL_WEBHOOK_URL=https://api.resend.com/emails
MAIL_API_KEY=ключ_из_Resend
MAIL_FROM=Sklad Go <no-reply@ваш-домен>
OWNER_EMAIL=ваша_почта@gmail.com
DEV_MAILBOX=false
```
`OWNER_EMAIL` — важно: так владельцем станете именно вы, а не случайный первый зарегистрировавшийся.

## 4. Запуск
```
cp deploy/skladgo.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now skladgo
systemctl status skladgo      # должно быть active (running)
```
HTTPS: впишите домен в `deploy/Caddyfile`, затем
```
cp deploy/Caddyfile /etc/caddy/Caddyfile && systemctl restart caddy
```
Откройте `https://sklad.ваш-домен` — должен появиться экран входа.

## 5. Проверка перед работой
1. Зарегистрируйтесь с почтой из `OWNER_EMAIL` — код должен прийти на почту (проверьте «Спам»).
2. Зарегистрируйте тестового сотрудника с другой почтой, разрешите его во вкладке «Команда».
3. Добавьте товар у одного и убедитесь, что второй видит его сразу.
4. Включите второй фактор (раздел 8) и выйдите-войдите: программа должна спросить код.

## 6. Резервные копии (ежедневно)
```
sudo -u skladgo crontab -e
```
добавьте строку (каждый день в 03:00):
```
0 3 * * * cd /opt/skladgo/backend && DB_PATH=/opt/skladgo/backend/data/skladgo.db /usr/bin/node --no-warnings scripts/backup.js >> /opt/skladgo/backup.log 2>&1
```
Копии лежат в `backend/data/backups/` (последние 14). **Раз в неделю скачивайте свежую копию к себе** (`scp`) — копии на том же сервере не спасут, если сломается сам сервер.

## 7. Обновление программы
Загрузите новый архив, замените папки `backend/src`, `backend/server.js`, `frontend` (не трогайте `.env` и `data/`), затем `systemctl restart skladgo`.

## 8. Безопасность: что сделать в первый день

**Включите второй фактор владельцу.** Вкладка «Команда» → «Второй фактор входа» → «Включить».
Поставьте на телефон Google Authenticator, наведите его на ключ (или нажмите «Открыть приложение»,
если открываете склад с того же телефона). После этого одного пароля для входа мало.

**Запишите запасные коды на бумагу.** Их восемь, каждый работает один раз. Телефон теряют
и меняют — без этих кодов вход в свой же склад закроется навсегда. Держите их не в телефоне.

**Попросите сотрудников сделать то же.** У каждого свой второй фактор, друг другу они не мешают.

**Закройте сервер от посторонних.** В `.env` поставьте свою почту:
```
OWNER_EMAIL=ваша@почта
```
Тогда чужой человек не заведёт на вашем сервере свой магазин — только по вашей ссылке-приглашению.

**Проверьте права на папку с данными** (там пароли и закупочные цены):
```
sudo chmod 700 /opt/skladgo/backend/data
sudo chown -R skladgo:skladgo /opt/skladgo/backend/data
sudo chmod 600 /opt/skladgo/backend/.env
```

**Закройте всё, кроме 80 и 443** — наружу должен смотреть только Caddy, не сам сервер:
```
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw --force enable
```

**При запуске сервер сам проверяет настройки.** Если он пишет `ОСТАНОВЛЕНО` — не запускайте
его насильно: база оказалась в папке, которую раздают наружу, и её смог бы скачать кто угодно.
Строки `ВНИМАНИЕ` в журнале (`journalctl -u skladgo`) стоит прочитать и поправить.

**Что уже сделано за вас, проверять не нужно:** пароли хранятся так, что обратно их не достать;
блокировка сотрудника сразу закрывает все его входы; смена пароля выбрасывает со всех устройств;
закупочные цены сервер сотрудникам не отдаёт вовсе; соседние магазины не видят друг друга.

## Если что-то не работает
- `journalctl -u skladgo -n 50` — журнал сервера.
- Письма не приходят: проверьте статус домена в Resend и `MAIL_FROM` (домен должен совпадать).
- Сайт не открывается: `systemctl status caddy`, и что запись A указывает на правильный IP.
