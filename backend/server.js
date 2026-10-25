'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv, makeConfig } = require('./src/config');
const { openDb } = require('./src/db');
const { makeMailer } = require('./src/mailer');
const { makeAuth } = require('./src/auth');
const { makeDocs } = require('./src/docs');
const { HttpError, send, readJson, clientIp } = require('./src/http');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function createApp(options = {}) {
  const cfg = makeConfig(options);
  const db = openDb(cfg.dbPath);
  const mailer = makeMailer(cfg);
  const ctx = { db, cfg, mailer, broadcast: null };
  const auth = makeAuth(ctx);
  const docs = makeDocs({ db, cfg, auth });
  ctx.broadcast = docs.broadcast;

  function cors(req, res) {
    if (cfg.corsOrigin && req.headers.origin === cfg.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
  }
  function secure(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Год на HTTPS. По обычному http браузер эту строку игнорирует, поэтому дома она не помешает.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Камера нужна сканеру штрихкодов, остальное ни к чему
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=(), payment=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" + (cfg.corsOrigin ? ' ' + cfg.corsOrigin : '') + "; object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  }

  async function api(req, res, url) {
    const ip = clientIp(req), m = req.method, p = url.pathname;
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? await readJson(req, cfg.maxDocBytes + 4096) : {};
    const A = auth.handlers;
    if (m === 'POST' && p === '/api/auth/register') return send(res, 201, await A.register(req, body, ip));
    if (m === 'POST' && p === '/api/auth/verify') return send(res, 200, await A.verify(req, body, ip));
    if (m === 'POST' && p === '/api/auth/resend') return send(res, 200, await A.resend(req, body, ip));
    if (m === 'POST' && p === '/api/auth/login') return send(res, 200, await A.login(req, body, ip));
    if (m === 'POST' && p === '/api/auth/login-2fa') return send(res, 200, await A.login2fa(req, body, ip));
    if (m === 'POST' && p === '/api/auth/logout') return send(res, 200, await A.logout(req));
    if (m === 'POST' && p === '/api/2fa/setup') return send(res, 200, await A.totpSetup(req, body));
    if (m === 'POST' && p === '/api/2fa/enable') return send(res, 200, await A.totpEnable(req, body, ip));
    if (m === 'POST' && p === '/api/2fa/disable') return send(res, 200, await A.totpDisable(req, body, ip));
    if (m === 'POST' && p === '/api/2fa/backup') return send(res, 200, await A.totpBackup(req, body));
    if (m === 'POST' && p === '/api/auth/forgot') return send(res, 200, await A.forgot(req, body, ip));
    if (m === 'POST' && p === '/api/auth/reset') return send(res, 200, await A.reset(req, body, ip));
    if (m === 'POST' && p === '/api/auth/change-password') return send(res, 200, await A.changePassword(req, body));
    if (m === 'GET' && p === '/api/me') return send(res, 200, await A.me(req));
    if (m === 'PATCH' && p === '/api/me') return send(res, 200, await A.updateMe(req, body));
    if (m === 'DELETE' && p === '/api/me') return send(res, 200, await A.deleteMe(req, body));
    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, time: Date.now() });
    if (m === 'GET' && p === '/api/dev/mailbox' && cfg.devMailbox) return send(res, 200, { mails: mailer.sent });

    if (m === 'GET' && p === '/api/stream') { // билет получаем заранее через POST /api/stream/ticket
      return docs.openStream(req, res, url.searchParams.get('ticket') || '');
    }
    const u = auth.requireUser(req);
    if (m === 'POST' && p === '/api/stream/ticket') return send(res, 200, docs.makeTicket(u));
    let mm;
    if ((mm = /^\/api\/docs\/([^/]+\/[^/]+)$/.exec(p))) {
      const dp = decodeURIComponent(mm[1]);
      if (m === 'GET') return send(res, 200, docs.getDoc(u, dp));
      if (m === 'PUT') return send(res, 200, docs.writeDoc(u, dp, body.data, 'set', req.headers['if-match']));
      if (m === 'PATCH') return send(res, 200, docs.writeDoc(u, dp, body.data, 'update', req.headers['if-match']));
      if (m === 'DELETE') return send(res, 200, docs.deleteDoc(u, dp));
    }
    if ((mm = /^\/api\/collections\/([a-z][a-z0-9_]*)$/.exec(p))) {
      if (m === 'GET') return send(res, 200, docs.listCollection(u, mm[1], url.searchParams));
      if (m === 'POST') return send(res, 201, docs.addDoc(u, mm[1], body.data));
    }
    throw new HttpError(404, 'not_found');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(cfg.staticDir, rel));
    if (!file.startsWith(path.normalize(cfg.staticDir + path.sep))) return send(res, 403, { error: 'forbidden' });
    // ничего, что начинается с точки: .env, .git и прочее наружу не отдаём
    if (rel.split(/[\/]/).some((part) => part.startsWith('.'))) return send(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) { // запасной вариант: отдаём index.html
        return fs.readFile(path.join(cfg.staticDir, 'index.html'), (e2, b2) => {
          if (e2) return send(res, 404, { error: 'not_found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(b2);
        });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    secure(res); cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch (x) { /* ignore */ } return; }
      if (e instanceof HttpError) return send(res, e.status, Object.assign({ error: e.code }, e.extra));
      console.error('[error]', e);
      send(res, 500, { error: 'server_error' });
    }
  });
  server.requestTimeout = 30000;

  return {
    server, cfg, db, mailer,
    listen: () => new Promise((r) => server.listen(cfg.port, () => r(server.address().port))),
    close: () => new Promise((r) => { docs.closeAll(); server.close(() => { try { db.close(); } catch (e) { /* ignore */ } r(); }); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

module.exports = { createApp };

/* Перед запуском смотрим, не выставлено ли наружу лишнее. Одна опечатка в DB_PATH —
   и база со всеми паролями и закупочными ценами качается по ссылке, молча. */
function checkSafety(cfg) {
  const inStatic = path.normalize(path.resolve(cfg.dbPath)).startsWith(path.normalize(path.resolve(cfg.staticDir) + path.sep));
  if (inStatic) {
    console.error('ОСТАНОВЛЕНО: база ' + cfg.dbPath + ' лежит в папке, которую сервер раздаёт наружу.');
    console.error('Её смог бы скачать кто угодно. Перенесите базу (DB_PATH) за пределы ' + cfg.staticDir);
    process.exit(1);
  }
  const warn = [];
  if (cfg.devMailbox) warn.push('DEV_MAILBOX=true — коды из писем видны по ссылке /api/dev/mailbox. Для рабочего сервера поставьте false.');
  if (!cfg.ownerEmail) warn.push('OWNER_EMAIL не задан — любой человек с адресом сервера заведёт себе магазин. Так и задумано для общего сервера; для своего укажите свою почту.');
  if (cfg.sessionDays > 90) warn.push('SESSION_DAYS=' + cfg.sessionDays + ' — вход не кончается больше трёх месяцев.');
  for (const w of warn) console.log('ВНИМАНИЕ: ' + w);
}

if (require.main === module) {
  loadEnv(path.join(__dirname, '.env'));
  checkSafety(makeConfig());   // до открытия базы: иначе опасный файл успеет создаться
  const app = createApp();
  app.listen().then((port) => {
    console.log(`Sklad Go запущен: http://localhost:${port}`);
    console.log(`База: ${app.cfg.dbPath} | почта: ${app.cfg.mailMode} | подтверждение почты: ${app.cfg.requireVerify ? 'включено' : 'выключено'}`);
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
