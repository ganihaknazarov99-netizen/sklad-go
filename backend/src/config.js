'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Читает .env (простой формат KEY=VALUE), не перезаписывая уже заданные переменные окружения
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* .env необязателен */ }
}

function makeConfig(o = {}) {
  const e = process.env;
  const pick = (k, d) => (o[k] !== undefined ? o[k] : d);
  return {
    port: +pick('port', e.PORT || 3000),
    dbPath: pick('dbPath', e.DB_PATH || path.join(__dirname, '..', 'data', 'skladgo.db')),
    staticDir: pick('staticDir', path.join(__dirname, '..', '..', 'frontend')),
    requireVerify: pick('requireVerify', e.REQUIRE_VERIFY !== 'false'),
    mailMode: pick('mailMode', e.MAIL_MODE || 'console'),
    mailUrl: pick('mailUrl', e.MAIL_WEBHOOK_URL || ''),
    mailKey: pick('mailKey', e.MAIL_API_KEY || ''),
    smtpHost: pick('smtpHost', e.SMTP_HOST || ''),
    smtpPort: +pick('smtpPort', e.SMTP_PORT || 587),
    smtpUser: pick('smtpUser', e.SMTP_USER || ''),
    smtpPass: pick('smtpPass', e.SMTP_PASS || ''),
    // Обычно порт сам говорит: 465 — шифрование сразу, 587 — после STARTTLS
    smtpSecure: pick('smtpSecure', e.SMTP_SECURE === undefined ? undefined : e.SMTP_SECURE === 'true'),
    // Нужен только тем, у кого почтовый сервер свой, с собственным сертификатом
    smtpCa: pick('smtpCa', e.SMTP_CA_FILE ? fs.readFileSync(e.SMTP_CA_FILE) : ''),
    // Обратный адрес по умолчанию — сам почтовый ящик: Gmail всё равно подставит его
    mailFrom: pick('mailFrom', e.MAIL_FROM || (e.SMTP_USER ? 'Sklad Go <' + e.SMTP_USER + '>' : 'Sklad Go <no-reply@localhost>')),
    ownerEmail: String(pick('ownerEmail', e.OWNER_EMAIL || '')).trim().toLowerCase(),
    corsOrigin: pick('corsOrigin', e.CORS_ORIGIN || ''),
    sessionDays: +pick('sessionDays', e.SESSION_DAYS || 30),
    devMailbox: pick('devMailbox', e.DEV_MAILBOX === 'true'),
    maxDocBytes: 2 * 1024 * 1024,
    codeTtlMs: 15 * 60 * 1000,
    codeMaxAttempts: 5,
    resendCooldownMs: 60 * 1000,
  };
}
module.exports = { loadEnv, makeConfig };
