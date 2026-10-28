'use strict';
// Отправка писем. Режимы: console (печать в лог), memory (для тестов),
// smtp (обычная почта вроде Gmail) и webhook (HTTP API провайдера, например Resend).
const smtp = require('./smtp');
function makeMailer(cfg) {
  const sent = [];
  async function send(to, subject, text) {
    sent.push({ to, subject, text, t: Date.now() });
    if (sent.length > 200) sent.shift();
    if (cfg.mailMode === 'console') {
      console.log(`[mail] кому: ${to} | тема: ${subject}\n${text}\n`);
    } else if (cfg.mailMode === 'smtp') {
      if (!cfg.smtpHost) throw new Error('MAIL_MODE=smtp, но SMTP_HOST не задан');
      await smtp.отправить(
        { host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser, pass: cfg.smtpPass, ca: cfg.smtpCa, secure: cfg.smtpSecure },
        { from: cfg.mailFrom, to, subject, text }
      );
    } else if (cfg.mailMode === 'webhook') {
      const r = await fetch(cfg.mailUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.mailKey },
        body: JSON.stringify({ from: cfg.mailFrom, to, subject, text }),
      });
      if (!r.ok) throw new Error('mail provider responded ' + r.status);
    } // memory: только копим в sent
  }
  return { send, sent };
}
module.exports = { makeMailer };
