'use strict';
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const hb = Buffer.from(h, 'base64');
    const hh = crypto.scryptSync(pw, Buffer.from(s, 'base64'), hb.length, { N: +N, r: 8, p: 1 });
    return hh.length === hb.length && crypto.timingSafeEqual(hh, hb);
  } catch (e) { return false; }
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(32).toString('hex');
// 6 символов без похожих (0/O, 1/I)
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(6);
  let o = ''; for (let i = 0; i < 6; i++) o += A[b[i] % A.length];
  return o;
}
/* Отпечаток устройства по строке браузера. Номера версий выбрасываем:
   иначе очередное обновление Chrome выглядело бы как чужое устройство
   и выкидывало человека из программы каждую неделю. */
function deviceKey(ua) {
  const s = String(ua || '').replace(/[0-9._]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return s ? sha(s).slice(0, 32) : '';
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Ограничитель частоты в памяти: не более max событий за окно
class Limiter {
  constructor(max, windowMs) { this.max = max; this.win = windowMs; this.m = new Map(); }
  hit(key) {
    const now = Date.now(), arr = (this.m.get(key) || []).filter((t) => now - t < this.win);
    arr.push(now); this.m.set(key, arr);
    if (this.m.size > 5000) for (const [k, v] of this.m) if (!v.length || now - v[v.length - 1] > this.win) this.m.delete(k);
    return arr.length <= this.max;
  }
  reset(key) { this.m.delete(key); }
}
module.exports = { hashPassword, verifyPassword, DUMMY_HASH, sha, newId, newToken, newCode, safeEqual, deviceKey, Limiter };
