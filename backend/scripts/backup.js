'use strict';
// Резервная копия базы: node scripts/backup.js [папка]. Хранит последние 14 копий.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'skladgo.db');
const dir = process.argv[2] || path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const out = path.join(dir, `skladgo-${stamp}.db`);
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); // целостная копия даже во время работы сервера
db.close();
const files = fs.readdirSync(dir).filter((f) => /^skladgo-.*\.db$/.test(f)).sort();
files.slice(0, Math.max(0, files.length - 14)).forEach((f) => fs.unlinkSync(path.join(dir, f)));
console.log('Копия создана:', out, `(хранится копий: ${Math.min(files.length, 14)})`);
