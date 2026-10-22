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
    mailFrom: pick('mailFrom', e.MAIL_FROM || 'Sklad Go <no-reply@localhost>'),
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
