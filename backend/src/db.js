'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./security');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'staff',        -- owner | staff
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | active | blocked
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes(
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,                      -- verify | reset
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, purpose),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS docs(
  path TEXT PRIMARY KEY,                      -- например warehouse/main
  collection TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection);
CREATE TABLE IF NOT EXISTS shops(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  invite TEXT NOT NULL,                       -- код приглашения для своих сотрудников
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shops_invite ON shops(invite);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
/* Переход на несколько магазинов: у каждого пользователя свой магазин,
   а пути документов получают приставку s/<магазин>/. Старые данные — те,
   что были до разделения — целиком переезжают в один магазин, чтобы ничего
   не потерялось. */
function newInvite() { return S.newToken().slice(0, 10).toUpperCase(); }

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('shop_id')) {
    db.exec("ALTER TABLE users ADD COLUMN shop_id TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_shop ON users(shop_id)');
  }
  const orphans = db.prepare("SELECT COUNT(*) AS c FROM users WHERE shop_id=''").get().c;
  if (!orphans) return;

  const id = S.newId(), now = Date.now();
  const owner = db.prepare("SELECT name FROM users WHERE shop_id='' AND role='owner' ORDER BY created_at LIMIT 1").get();
  db.prepare('INSERT INTO shops(id,name,invite,created_at) VALUES(?,?,?,?)')
    .run(id, owner ? 'Магазин ' + owner.name : '', newInvite(), now);
  db.prepare("UPDATE users SET shop_id=? WHERE shop_id=''").run(id);
  const old = db.prepare("SELECT path FROM docs WHERE path NOT LIKE 's/%'").all();
  for (const r of old) db.prepare('UPDATE docs SET path=? WHERE path=?').run('s/' + id + '/' + r.path, r.path);
  console.log('Перенос в отдельный магазин: людей ' + orphans + ', документов ' + old.length);
}

module.exports = { openDb, newInvite };
