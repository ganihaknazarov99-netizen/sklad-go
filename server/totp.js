'use strict';
/* Второй фактор входа: шестизначный код из приложения-аутентификатора
   (Google Authenticator, Microsoft Authenticator, Authy, FreeOTP — любое).

   Стандарты: RFC 4226 (HOTP) и RFC 6238 (TOTP). Ничего сверх node:crypto не нужно.
   Телефон и сервер не разговаривают друг с другом: оба считают один и тот же код
   из общего секрета и текущего времени. Поэтому код работает без интернета и без СМС —
   для Таджикистана это важно. */
const crypto = require('node:crypto');

const STEP = 30;            // окно в секундах, как у всех
const DIGITS = 6;
const SKEW = 1;             // терпим ±30 секунд: часы на телефоне редко идут точно

/* ---------- Base32 (RFC 4648) — в этом виде секрет понимают аутентификаторы ---------- */
const A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += A32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += A32[(val << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/[\s=-]/g, '')) {
    const i = A32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/* ---------- Сам код ---------- */
// 20 байт случайности — столько же, сколько у Google
const newSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 15;                       // динамическое усечение, RFC 4226
  const num = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(num % 10 ** DIGITS).padStart(DIGITS, '0');
}

const codeAt = (secret, timeMs) => hotp(base32Decode(secret), Math.floor(timeMs / 1000 / STEP));

/* Проверка кода. Возвращает номер окна (его запоминаем, чтобы один код не прошёл дважды)
   или null, если код не подошёл. Сравнение без утечки времени. */
function verify(secret, code, timeMs = Date.now(), lastStep = -1) {
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== DIGITS) return null;
  let buf;
  try { buf = base32Decode(secret); } catch (e) { return null; }
  const now = Math.floor(timeMs / 1000 / STEP);
  let hit = null;
  for (let d = -SKEW; d <= SKEW; d++) {
    const step = now + d;
    if (step <= lastStep) continue;                        // этот код уже использован
    const want = Buffer.from(hotp(buf, step));
    const got = Buffer.from(given);
    // сравниваем все окна до конца, чтобы по времени ответа нельзя было угадать нужное
    if (want.length === got.length && crypto.timingSafeEqual(want, got) && hit === null) hit = step;
  }
  return hit;
}

/* Ссылка для QR-кода. Аутентификатор читает её и показывает «Sklad Go (почта)». */
function otpauthUri(secret, email, issuer = 'Sklad Go') {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(email || '');
  return 'otpauth://totp/' + label + '?secret=' + secret +
    '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=' + DIGITS + '&period=' + STEP;
}

/* ---------- Запасные коды ----------
   Телефон теряют, ломают и меняют. Без запасных кодов владелец останется
   за дверью своего же склада, поэтому они обязательны, а не дополнение. */
function newBackupCodes(n = 8) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = crypto.randomBytes(5);
    let s = '';
    for (const x of b) s += '0123456789'[x % 10];
    out.push(s.slice(0, 5) + '-' + base32Encode(crypto.randomBytes(3)).slice(0, 4));
  }
  return out;
}
const normBackup = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

module.exports = { newSecret, codeAt, verify, otpauthUri, newBackupCodes, normBackup, base32Encode, base32Decode, STEP, DIGITS };
