// Запуск: cd supabase && npm install && npm test
// Проверка нужна каждый раз, когда меняется schema.sql. Без неё правки правил
// доступа проверить нечем: Supabase сам ошибку не покажет, пока ею не воспользуются.
// Проверка правил supabase/schema.sql на настоящем Postgres (PGlite).
// Supabase изображаем сами: роли anon/authenticated, схема auth, auth.uid().
// Каждый запрос «от пользователя» идёт под ролью authenticated — так же,
// как в Supabase, и правила доступа (RLS) действуют на самом деле.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const СХЕМА = process.argv[2] || new URL('./schema.sql', import.meta.url);
const db = new PGlite();
let ок = 0, провалов = 0;
const да = (усл, что) => { if (усл) { ок++; console.log('  ✓ ' + что); } else { провалов++; console.log('  ✗ ' + что); } };

const ХОЗЯИН = '11111111-1111-1111-1111-111111111111';
const ВОР    = '22222222-2222-2222-2222-222222222222';
const ПРОДАВЕЦ = '33333333-3333-3333-3333-333333333333';
const ДВОЙНИК = '44444444-4444-4444-4444-444444444444';   // почта хозяина, но не подтверждена
const ПОЧТА_ХОЗЯИНА = 'ganihaknazarov99@gmail.com';

async function как(uid, sql, p) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  await db.exec(uid ? 'set role authenticated' : 'set role anon');
  try { return await db.query(sql, p); } finally { await db.exec('reset role'); }
}
async function какОшибка(uid, sql, p) {
  try { await как(uid, sql, p); return null; } catch (e) { return e.message; }
}
async function строка(uid) {
  return (await db.query('select owner, status, name from public.staff where uid = $1', [uid])).rows[0];
}

// --- изображаем Supabase ---
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
`);
let безРеалтайма = false;
try { await db.exec('create publication supabase_realtime'); } catch (e) { безРеалтайма = true; }

let схема = fs.readFileSync(СХЕМА, 'utf8');
if (безРеалтайма) {
  // PGlite не умеет публикации. Этот кусок не менялся и уже отработал на вашем Supabase.
  схема = схема.slice(0, схема.indexOf('-- ---------- Живые обновления'));
  console.log('(живые обновления пропущены: PGlite их не умеет; этот кусок не менялся)');
}
await db.exec(схема);
// В Supabase права на таблицы выдаются сами; здесь — руками, после схемы.
await db.exec(`
  grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  grant usage, select on all sequences in schema public to anon, authenticated;
`);
await db.query(`insert into auth.users values
  ($1, $5, now()), ($2, 'vor@example.com', now()), ($3, 'alisher@gmail.com', now()), ($4, $5, null)`,
  [ХОЗЯИН, ВОР, ПРОДАВЕЦ, ДВОЙНИК, ПОЧТА_ХОЗЯИНА]);

const встать = (uid, name) => как(uid, "insert into public.staff (uid, name, owner, status) values ($1, $2, true, 'active')", [uid, name]);

console.log('\n1. Почта хозяина ещё не записана. Вор приходит первым');
await встать(ВОР, 'Вор');
let r = await строка(ВОР);
да(r && !r.owner, 'вор хозяином не стал, хотя пришёл первым и сам попросил owner=true');
да(r && r.status === 'pending', 'вор ждёт подтверждения, а не «active», как он попросил');

console.log('\n2. Хозяин входит раньше, чем записал свою почту');
await встать(ХОЗЯИН, 'Ганӣ');
r = await строка(ХОЗЯИН);
да(r && !r.owner && r.status === 'pending', 'пока почта не записана, хозяином не становится никто — даже хозяин');

console.log('\n3. Хозяин записывает почту в settings (SQL Editor)');
await db.query("insert into public.settings values ('owner_email', $1)", [ПОЧТА_ХОЗЯИНА]);

console.log('\n4. Кто-то зарегистрировался на почту хозяина, но подтвердить её не может');
await встать(ДВОЙНИК, 'Двойник');
r = await строка(ДВОЙНИК);
да(r && !r.owner && r.status === 'pending', 'неподтверждённая почта хозяина хозяином не делает');

console.log('\n5. Программа хозяина при следующем запуске обновляет его строку');
await как(ХОЗЯИН, 'update public.staff set name = $1 where uid = $2', ['Ганӣ', ХОЗЯИН]);
r = await строка(ХОЗЯИН);
да(r && r.owner && r.status === 'active', 'хозяин стал хозяином сам — порядок шагов неважен');

console.log('\n6. Вор пытается себя повысить');
await как(ВОР, "update public.staff set status = 'active', owner = true where uid = $1", [ВОР]);
r = await строка(ВОР);
да(r && !r.owner && r.status === 'pending', 'статус и хозяйство себе не выставить');

console.log('\n7. Хозяин у лавки один — это держит сама база');
await db.exec('set session_replication_role = replica');   // в обход охранника, как злоумышленник с доступом к базе
let ош = null;
try { await db.query('update public.staff set owner = true where uid = $1', [ВОР]); } catch (e) { ош = e.message; }
await db.exec('set session_replication_role = default');
да(ош && /unique|duplicate/i.test(ош), 'второго хозяина не записать даже в обход охранника: ' + (ош || 'записалось!'));

console.log('\n8. Продавец приходит, хозяин его пускает');
await встать(ПРОДАВЕЦ, 'Алишер');
да((await строка(ПРОДАВЕЦ)).status === 'pending', 'новенький ждёт подтверждения');
await как(ХОЗЯИН, "update public.staff set status = 'active' where uid = $1", [ПРОДАВЕЦ]);
да((await строка(ПРОДАВЕЦ)).status === 'active', 'хозяин пустил продавца');

console.log('\n9. Склад видят только свои');
await как(ПРОДАВЕЦ, "select public.doc_set('main', '{\"items\":[]}'::jsonb, null)");
да((await как(ПРОДАВЕЦ, 'select id from public.docs')).rows.length === 1, 'продавец видит склад');
да((await как(ВОР, 'select id from public.docs')).rows.length === 0, 'вор в очереди склада не видит');
да((await как(null, 'select id from public.docs')).rows.length === 0, 'без входа склада не видно');
да(!!(await какОшибка(ВОР, "select public.doc_set('main', '{}'::jsonb, null)")), 'вор в очереди склад не перепишет');

console.log('\n10. Продавец подделывает ленту');
await как(ПРОДАВЕЦ, 'insert into public.activity (t, "by", uid, txt) values (0, $1, $2, $3)', ['Ганӣ', ХОЗЯИН, 'удалил весь склад']);
const з = (await db.query('select t, "by", uid from public.activity order by id desc limit 1')).rows[0];
да(з["by"] === 'Алишер', 'подпись поставила база: «' + з["by"] + '», а не «Ганӣ»');
да(з.uid === ПРОДАВЕЦ, 'автор — настоящий продавец, а не хозяин');
да(Number(з.t) > Date.now() - 60000, 'время поставила база, а не «1 января 1970»');
да(!!(await какОшибка(ПРОДАВЕЦ, "update public.activity set txt = 'ничего не было'")) ||
   (await как(ПРОДАВЕЦ, "update public.activity set txt = 'ничего не было' returning id")).rows.length === 0, 'запись в ленте не исправить');
да((await как(ПРОДАВЕЦ, 'delete from public.activity returning id')).rows.length === 0, 'запись в ленте не стереть');

console.log('\n11. Продавец назвался именем хозяина');
await как(ПРОДАВЕЦ, 'update public.staff set name = $1 where uid = $2', ['ганӣ ', ПРОДАВЕЦ]);
const имя = (await строка(ПРОДАВЕЦ)).name;
да(имя !== 'ганӣ' && /сотрудник/.test(имя), 'под хозяина не встать, база дописала пометку: «' + имя + '»');

console.log('\n12. Хозяин увольняет продавца, тот пытается вернуться');
await как(ХОЗЯИН, "update public.staff set status = 'blocked' where uid = $1", [ПРОДАВЕЦ]);
да((await строка(ПРОДАВЕЦ)).status === 'blocked', 'продавец заблокирован');
await как(ПРОДАВЕЦ, 'delete from public.staff where uid = $1', [ПРОДАВЕЦ]);
да(!!(await строка(ПРОДАВЕЦ)), 'свою строку не стереть — в очередь заново не встать');
ош = await какОшибка(ПРОДАВЕЦ, 'select public.delete_my_account()');
да(ош && /blocked_cannot_delete/.test(ош), 'удалить аккаунт и войти заново не выйдет: ' + (ош || 'удалился!'));
да((await как(ПРОДАВЕЦ, 'select id from public.docs')).rows.length === 0, 'заблокированный склада не видит');

console.log('\n13. Хозяин не может случайно лишить лавку хозяина');
await как(ХОЗЯИН, "update public.staff set status = 'blocked' where uid = $1", [ХОЗЯИН]);
да((await строка(ХОЗЯИН)).status === 'active', 'себя не заблокировать');
await как(ХОЗЯИН, 'delete from public.staff where uid = $1', [ХОЗЯИН]);
да(!!(await строка(ХОЗЯИН)), 'свою строку не стереть');
ош = await какОшибка(ХОЗЯИН, 'select public.delete_my_account()');
да(ош && /owner_cannot_delete/.test(ош), 'аккаунт хозяина не удалить');

console.log('\n14. Настройки лавки закрыты для всех');
да((await как(ХОЗЯИН, 'select * from public.settings')).rows.length === 0, 'даже хозяин через программу почту хозяина не прочтёт');
ош = await какОшибка(ВОР, "insert into public.settings values ('owner_email', 'vor@example.com') on conflict (key) do update set value = excluded.value");
const почта = (await db.query("select value from public.settings where key = 'owner_email'")).rows[0].value;
да(почта === ПОЧТА_ХОЗЯИНА, 'вор не переписал почту хозяина на свою' + (ош ? '' : ' (запрос прошёл, но ничего не изменил)'));
да(!!(await какОшибка(ВОР, "select public.may_claim_owner($1::uuid)", [ВОР])), 'проверку «могу ли я стать хозяином» снаружи не вызвать');

console.log('\n15. Новенький в очереди уходит сам');
ош = await какОшибка(ВОР, 'select public.delete_my_account()');
да(!ош, 'ожидающий может удалить свой аккаунт' + (ош ? ': ' + ош : ''));
да(!(await строка(ВОР)), 'и его строки больше нет');

console.log('\n16. Схему можно запустить повторно');
ош = null;
try { await db.exec(схема); } catch (e) { ош = e.message; }
да(!ош, 'повторный запуск прошёл без ошибок' + (ош ? ': ' + ош : ''));
да((await строка(ХОЗЯИН)).owner, 'и хозяин после повторного запуска остался хозяином');

console.log('\nИтого: ' + ок + ' проверок прошло, ' + провалов + ' не прошло');
process.exit(провалов ? 1 : 0);
