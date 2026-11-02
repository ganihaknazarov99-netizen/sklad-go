'use strict';
class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra || {}; }
}
function send(res, status, obj, headers) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new HttpError(400, 'bad_json')); }
    });
    req.on('error', reject);
  });
}
// Адрес посетителя. За Caddy на этой же машине настоящий адрес приходит в X-Forwarded-For.
// Раньше заголовку верили от кого угодно: подставь туда случайный адрес на каждую попытку —
// и ограничение попыток входа не сработает. Теперь верим, только если запрос пришёл с этой
// же машины (то есть от своего прокси), и берём последний адрес — его дописал сам прокси.
const isLoopback = (a) => a === '::1' || /^(::ffff:)?127\./.test(a);
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  if (!isLoopback(peer)) return peer;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : peer;
}
module.exports = { HttpError, send, readJson, clientIp };
