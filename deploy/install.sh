#!/usr/bin/env bash
# Установка Sklad Go на чистый Ubuntu 24.04 одной командой.
#
#   sudo bash install.sh sklad.example.com ваша@почта
#
# Ставит Node, Caddy (он сам берёт и продлевает сертификат HTTPS), заводит
# отдельного пользователя без права входа, кладёт программу в /opt/skladgo,
# закрывает лишние порты и включает ежедневные резервные копии.
#
# Запускать можно повторно: обновит программу и перезапустит её, а настройки
# и базу не тронет. Это же и способ обновляться.
set -euo pipefail

DOMAIN="${1:-}"
OWNER="${2:-}"
REPO="${SKLAD_REPO:-ganihaknazarov99-netizen/sklad-go}"
BRANCH="${SKLAD_BRANCH:-main}"
DIR=/opt/skladgo
USER_NAME=skladgo
NODE_MAJOR=24

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mВНИМАНИЕ: %s\033[0m\n' "$*"; }
die()  { printf '\033[31mОСТАНОВЛЕНО: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- Проверки до того, как что-то менять ----------
[ "$(id -u)" = 0 ] || die "запустите через sudo"
[ -n "$DOMAIN" ] || die "не указан домен. Пример: sudo bash install.sh sklad.example.com ваша@почта"
[ -n "$OWNER" ]  || die "не указана ваша почта — она станет почтой владельца магазина"
case "$DOMAIN" in *.*) ;; *) die "«$DOMAIN» не похож на домен";; esac
case "$OWNER"  in *@*.*) ;; *) die "«$OWNER» не похож на адрес почты";; esac
command -v apt-get >/dev/null || die "этот установщик рассчитан на Ubuntu/Debian"

say "Проверяю, что домен $DOMAIN указывает на этот сервер"
MYIPS="$(hostname -I 2>/dev/null || true) $(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
MYIP="$(printf '%s' "$MYIPS" | awk '{print $1}')"
DNSIP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [ -n "$DNSIP" ] && [ -n "$MYIP" ] && ! printf '%s' " $MYIPS " | grep -q " $DNSIP "; then
  warn "домен ведёт на $DNSIP, а этот сервер — $MYIP."
  warn "Пока запись A не укажет сюда, сертификат HTTPS не выдадут и сайт не откроется."
  warn "Поправьте запись у регистратора и запустите установщик ещё раз."
elif [ -z "$DNSIP" ]; then
  warn "домен $DOMAIN пока никуда не ведёт — сертификат HTTPS выдадут только после записи A."
fi

# ---------- Пакеты ----------
say "Ставлю системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw cron >/dev/null
systemctl enable --now cron >/dev/null 2>&1 || true

have_node() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if have_node; then
  say "Node уже подходящий: $(node -v)"
else
  say "Ставлю Node $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  have_node || die "Node не встал. Проверьте «node -v»"
fi

if ! command -v caddy >/dev/null; then
  say "Ставлю Caddy (он же выдаст и продлит сертификат HTTPS)"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# ---------- Пользователь и папки ----------
if ! id "$USER_NAME" >/dev/null 2>&1; then
  say "Завожу пользователя $USER_NAME без права входа"
  useradd --system --home "$DIR" --shell /usr/sbin/nologin "$USER_NAME"
fi
mkdir -p "$DIR"

# ---------- Программа ----------
say "Скачиваю программу из $REPO ($BRANCH)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)"
[ -f "$SRC/backend/server.js" ] || die "в архиве нет backend/server.js — проверьте имя репозитория"

# Копируем только то, что нужно для работы. База и настройки остаются на месте.
for part in backend/server.js backend/src backend/scripts backend/package.json frontend; do
  mkdir -p "$DIR/$(dirname "$part")"
  rm -rf "${DIR:?}/$part"
  cp -r "$SRC/$part" "$DIR/$part"
done
mkdir -p "$DIR/backend/data"

# ---------- Настройки ----------
ENVF="$DIR/backend/.env"
if [ -f "$ENVF" ]; then
  say "Настройки уже есть — не трогаю их"
else
  say "Пишу настройки"
  cat > "$ENVF" <<EOF
# Настройки сервера Sklad Go. Этот файл виден только пользователю $USER_NAME.
PORT=3000
DB_PATH=$DIR/backend/data/skladgo.db
SESSION_DAYS=30

# Ваша почта. Пока она задана, посторонний не заведёт на этом сервере свой
# магазин: другие попадают только по вашей ссылке-приглашению.
OWNER_EMAIL=$OWNER

# Подтверждение почты кодом выключено: сотрудников вы и так пускаете руками,
# кнопкой «Разрешить» на вкладке «Команда». Защита входа держится на пароле
# и втором факторе (включите его в первый же день).
REQUIRE_VERIFY=false

# Письма. Пока MAIL_MODE=console, кнопка «Забыли пароль?» не работает:
# код никуда не уйдёт. Чтобы заработала, впишите свой почтовый ящик ниже
# и поменяйте console на smtp.
#   Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, SMTP_USER=ваша@gmail.com,
#   а SMTP_PASS — «пароль приложения» из myaccount.google.com/apppasswords
#   (сначала включите двухэтапную проверку). Обычный пароль Google не примет.
MAIL_MODE=console
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM="Sklad Go <no-reply@$DOMAIN>"
MAIL_WEBHOOK_URL=
MAIL_API_KEY=

# Ящик для разработки. На рабочем сервере только false.
DEV_MAILBOX=false
EOF
fi

chown -R "$USER_NAME:$USER_NAME" "$DIR"
chmod 700 "$DIR/backend/data"     # в базе пароли и закупочные цены
chmod 600 "$ENVF"

# ---------- Служба ----------
say "Настраиваю автозапуск"
cat > /etc/systemd/system/skladgo.service <<EOF
[Unit]
Description=Sklad Go
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR/backend
ExecStart=/usr/bin/node --no-warnings server.js
EnvironmentFile=$ENVF
Restart=always
RestartSec=3

# Программе нужно писать только в свою папку с базой, больше никуда
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DIR/backend/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now skladgo >/dev/null
systemctl restart skladgo

# ---------- Caddy ----------
say "Настраиваю сайт $DOMAIN"
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "reverse_proxy 127.0.0.1:3000" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.до-sklad-go.$(date +%Y%m%d%H%M%S)"
  warn "прежний Caddyfile сохранён рядом с пометкой «до-sklad-go»"
fi
cat > /etc/caddy/Caddyfile <<EOF
# Сертификат HTTPS Caddy берёт и продлевает сам. Сам сервер наружу не смотрит.
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
EOF
# Проверяем настройку до перезапуска: с ошибочной Caddy не поднимется, и сайт ляжет
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1   || die "настройка Caddy не прошла проверку, сайт не трогаю"
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ---------- Сеть ----------
# Самое опасное место установщика: включить экран и отрезать себя от сервера.
# Поэтому порт SSH берём настоящий — из настроек, а если там пусто, из текущего
# подключения, и только в последнюю очередь считаем, что он обычный, 22-й.
SSH_PORT="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/{print $2; exit}' /etc/ssh/sshd_config 2>/dev/null || true)"
[ -n "$SSH_PORT" ] || SSH_PORT="$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $4}')"
[ -n "$SSH_PORT" ] || SSH_PORT=22
say "Закрываю всё, кроме сайта и входа по SSH (порт $SSH_PORT)"
ufw allow "$SSH_PORT"/tcp >/dev/null 2>&1 || true
ufw allow 80,443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ---------- Резервные копии ----------
if ! crontab -u "$USER_NAME" -l 2>/dev/null | grep -q backup.js; then
  say "Включаю ежедневные резервные копии (03:00)"
  ( crontab -u "$USER_NAME" -l 2>/dev/null || true
    echo "0 3 * * * cd $DIR/backend && /usr/bin/node --no-warnings scripts/backup.js >> $DIR/backup.log 2>&1"
  ) | crontab -u "$USER_NAME" -
fi

# ---------- Проверка ----------
say "Проверяю, что сервер отвечает"
for i in $(seq 1 15); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then OKK=1; break; fi
  sleep 1
done
if [ "${OKK:-0}" != 1 ]; then
  echo
  journalctl -u skladgo -n 20 --no-pager || true
  die "сервер не ответил. Журнал выше, он же: journalctl -u skladgo -n 50"
fi

cat <<EOF

================================================================
  Готово. Программа работает.

  Откройте:        https://$DOMAIN
  Зарегистрируйтесь почтой: $OWNER   (она станет владельцем)

  В первый же день:
  1. «Команда» → «Второй фактор входа» → «Включить».
  2. Запишите восемь запасных кодов НА БУМАГУ. Телефон теряют;
     без них вход в свой же склад закроется навсегда.
  3. Позовите сотрудников ссылкой-приглашением оттуда же.

  Если потом не сможете войти (телефон потерян, пароль забыт):
      cd $DIR/backend && sudo -u $USER_NAME node scripts/admin.js list

  Обновить потом — та же команда, что и сейчас.
  Журнал сервера:  journalctl -u skladgo -n 50
  Копии базы:      $DIR/backend/data/backups  (раз в неделю скачивайте к себе)
================================================================
EOF
