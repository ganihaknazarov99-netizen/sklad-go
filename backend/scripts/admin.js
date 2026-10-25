'use strict';
/* Запасной ключ от склада — на случай, когда войти в программу уже нельзя.

   Второй фактор защищает вход, но он же умеет запереть снаружи: телефон утонул,
   бумажку с запасными кодами потеряли, писем сервер не шлёт. Без этого скрипта
   владелец остался бы без собственного склада навсегда.

   Работает только с сервера, из командной строки: кто дошёл сюда, у того и так
   есть доступ к машине и к самой базе. Сервер останавливать не нужно — он
   читает людей из базы каждый раз заново.

       node scripts/admin.js list
       node scripts/admin.js password  почта@пример
       node scripts/admin.js 2fa-off   почта@пример
       node scripts/admin.js codes     почта@пример
       node scripts/admin.js unblock   почта@пример
*/
const path = require('node:path');
const { loadEnv, makeConfig } = require('../src/config');
const { openDb } = require('../src/db');
const S = require('../src/security');
const TOTP = require('../src/totp');

loadEnv(path.join(__dirname, '..', '.env'));
const cfg = makeConfig();
const db = openDb(cfg.dbPath);

const cmd = (process.argv[2] || '').toLowerCase();
const who = String(process.argv[3] || '').trim().toLowerCase();
const now = () => Date.now();
const audit = (uid, action, detail) =>
  db.prepare('INSERT INTO audit(t,user_id,action,detail) VALUES(?,?,?,?)').run(now(), uid, action, detail || '');

function die(msg) { console.error('\nОшибка: ' + msg + '\n'); process.exit(1); }

function findUser() {
  if (!who) die('не указана почта. Посмотреть всех: node scripts/admin.js list');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(who);
  if (!u) die('человека с почтой «' + who + '» в базе нет. Посмотрите список: node scripts/admin.js list');
  return u;
}

// Пароль придумываем сами: тот, что человек придумает в спешке у сервера,
// обычно слабее, а этот всё равно меняется при первом входе.
function newPassword() {
  const A = 'abcdefghijkmnpqrstuvwxyz', B = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789';
  const all = A + B + D;
  const pick = (s) => s[require('node:crypto').randomInt(s.length)];
  let p = pick(A) + pick(B) + pick(D);
  for (let i = 0; i < 9; i++) p += pick(all);
  return p;
}

const dropSessions = (id) => db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);

switch (cmd) {
  case 'list': {
    const rows = db.prepare('SELECT u.*, s.name AS shop FROM users u LEFT JOIN shops s ON s.id=u.shop_id ORDER BY u.created_at').all();
    if (!rows.length) { console.log('\nВ базе пока никого нет.\n'); break; }
    console.log('');
    for (const u of rows) {
      const кто = u.role === 'owner' ? 'владелец' : 'сотрудник';
      const сост = u.role === 'owner' ? 'активен' : u.status === 'active' ? 'активен' : u.status === 'pending' ? 'ждёт подтверждения' : 'заблокирован';
      console.log(
        '  ' + u.email.padEnd(32) + ' ' + кто.padEnd(10) + ' ' + сост.padEnd(20) +
        ' второй фактор: ' + (u.totp_on ? 'включён' : 'выключен') +
        (u.shop ? '   магазин: ' + u.shop : '')
      );
    }
    console.log('');
    break;
  }

  case 'password': {
    const u = findUser();
    const pw = newPassword();
    db.prepare('UPDATE users SET pass_hash=?,verified=1,updated_at=? WHERE id=?').run(S.hashPassword(pw), now(), u.id);
    dropSessions(u.id);                       // старые входы закрываем: вдруг пароль и утёк
    audit(u.id, 'admin_password', 'с сервера');
    console.log('\n  Новый пароль для ' + u.email + ':\n\n      ' + pw +
      '\n\n  Войдите с ним и сразу смените на свой. Все прежние входы закрыты.');
    if (u.totp_on) console.log('  Второй фактор остался включённым — код из приложения всё ещё понадобится.');
    console.log('');
    break;
  }

  case '2fa-off': {
    const u = findUser();
    if (!u.totp_on) { console.log('\n  У ' + u.email + ' второй фактор и так выключен.\n'); break; }
    db.prepare("UPDATE users SET totp_on=0,totp_secret='',totp_step=-1,updated_at=? WHERE id=?").run(now(), u.id);
    db.prepare('DELETE FROM backup_codes WHERE user_id=?').run(u.id);
    dropSessions(u.id);
    audit(u.id, 'admin_totp_off', 'с сервера');
    console.log('\n  Второй фактор у ' + u.email + ' выключен, запасные коды стёрты.' +
      '\n  Войдите по паролю и включите его заново — с новым телефоном.\n');
    break;
  }

  case 'codes': {
    const u = findUser();
    if (!u.totp_on) die('у ' + u.email + ' второй фактор выключен — запасные коды не нужны');
    const codes = TOTP.newBackupCodes();
    db.prepare('DELETE FROM backup_codes WHERE user_id=?').run(u.id);
    for (const c of codes) db.prepare('INSERT INTO backup_codes(user_id,code_hash,used_at) VALUES(?,?,NULL)').run(u.id, S.sha(TOTP.normBackup(c)));
    audit(u.id, 'admin_backup_new', 'с сервера');
    console.log('\n  Новые запасные коды для ' + u.email + ' (старые больше не работают):\n');
    for (const c of codes) console.log('      ' + c);
    console.log('\n  Перепишите на бумагу. Больше их никто не покажет.\n');
    break;
  }

  case 'unblock': {
    const u = findUser();
    db.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').run('active', now(), u.id);
    audit(u.id, 'admin_unblock', 'с сервера');
    console.log('\n  Доступ для ' + u.email + ' открыт.\n');
    break;
  }

  default:
    console.log(`
  Запасной ключ от склада. Нужен, когда войти обычным путём уже нельзя.

      node scripts/admin.js list                 кто есть в базе
      node scripts/admin.js password почта@...   выдать новый пароль
      node scripts/admin.js 2fa-off  почта@...   снять второй фактор (телефон потерян)
      node scripts/admin.js codes    почта@...   выдать новые запасные коды
      node scripts/admin.js unblock  почта@...   открыть доступ заблокированному

  Останавливать сервер не нужно. Каждое действие записывается в журнал.
`);
}
db.close();
