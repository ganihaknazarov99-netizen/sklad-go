// Запуск: cd supabase && npm install && npm test
// Проверка нужна каждый раз, когда меняется schema.sql. Без неё правки правил
// доступа проверить нечем: Supabase сам ошибку не покажет, пока ею не воспользуются.
// Проверка правил supabase/schema.sql на настоящем Postgres (PGlite).
// Supabase изображаем сами: роли anon/authenticated, схема auth, auth.uid().
// Каждый запрос «от пользователя» идёт под ролью authenticated — так же,
// как в Supabase, и правила доступа (RLS) действуют на самом деле.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { createRequire } from 'node:module';

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
  -- Supabase сам выдаёт anon и authenticated право вызывать любую новую функцию
  -- в public. Поэтому «revoke ... from public» там ничего не закрывает — надо
  -- отбирать у этих ролей поимённо. Без этой строки проверка была бы мягче
  -- настоящего Supabase и пропускала бы такие ошибки.
  alter default privileges in schema public grant execute on functions to anon, authenticated;
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
// Без входа база не отвечает «пусто», а отказывает прямо: пустой ответ программа
// с истёкшим входом могла бы принять за пустой склад.
ош = await какОшибка(null, 'select id from public.docs');
да(ош && /permission denied/.test(ош), 'без входа склада не видно — база отказывает: ' + (ош || 'ответила'));
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

// --- Долги и история склада ---
const писать = (uid, id, data) => как(uid, 'select public.doc_set($1, $2::jsonb, null)', [id, JSON.stringify(data)]);
const отказ = async (uid, id, data) => { try { await писать(uid, id, data); return null; } catch (e) { return e.message; } };
const док = async (id) => (await db.query('select data from public.docs where id = $1', [id])).rows[0].data;
const последняя = async () => (await db.query('select "by", txt from public.activity order by id desc limit 1')).rows[0];
const долгО = (d, id) => d.ops.find((o) => o.id === id);
const ВЧЕРА = Date.now() - 864e5;
const бахром = { id: 'p1', name: 'Бахром' };
const долг = { id: 'o1', pid: 'p1', type: 'give', amt: 1000, t: ВЧЕРА, note: '', by: 'Ганӣ', at: ВЧЕРА };
const давний = { id: 'o0', pid: 'p1', type: 'gave', amt: 50, t: ВЧЕРА - 1, note: '', by: 'Ганӣ', at: ВЧЕРА - 1 };   // старое название «дал»

console.log('\n11. Хозяин записал долг. Продавец пытается его переписать');
await писать(ХОЗЯИН, 'debts', { people: [бахром], ops: [давний, долг], trash: [] });
let d = await док('debts');
да(d.ops.length === 2, 'долг записан');
ош = await отказ(ПРОДАВЕЦ, 'debts', { people: [бахром], ops: [давний, { ...долг, amt: 10 }], trash: [] });
да(ош && /debt_changed/.test(ош), 'сумму долга задним числом не уменьшить: ' + (ош || 'переписалось!'));
да(долгО(await док('debts'), 'o1').amt === 1000, 'в базе по-прежнему 1000');
ош = await отказ(ПРОДАВЕЦ, 'debts', { people: [бахром], ops: [давний, { ...долг, pid: 'p2' }], trash: [] });
да(ош && /debt_changed/.test(ош), 'долг на другого человека не перевесить');
ош = await отказ(ПРОДАВЕЦ, 'debts', { people: [бахром], ops: [давний, { ...долг, type: 'get' }], trash: [] });
да(ош && /debt_changed/.test(ош), '«я дал» на «я взял» не перевернуть');
ош = await отказ(ПРОДАВЕЦ, 'debts', { people: [бахром], ops: [давний], trash: [] });
да(ош && /debt_vanished/.test(ош), 'долг молча не стереть — только через корзину: ' + (ош || 'стёрся!'));
ош = await отказ(ПРОДАВЕЦ, 'debts', { people: [], ops: [давний, долг], trash: [] });
да(ош && /debt_vanished/.test(ош), 'человека с долгами из списка не убрать — его долги пропали бы с экрана');
ош = await какОшибка(ПРОДАВЕЦ, "update public.docs set data = jsonb_set(data, '{ops}', '[]'::jsonb) where id = 'debts'");
да(ош && /debt_vanished/.test(ош), 'и прямой записью в таблицу, в обход doc_set, — тоже');
ош = await какОшибка(ПРОДАВЕЦ, "update public.docs set id = 'debts_old' where id = 'debts'");
да(ош && /doc_id_locked/.test(ош), 'документ долгов не переименовать, чтобы завести чистый');

console.log('\n12. Честная работа продавца проходит');
const новый = { id: 'o2', pid: 'p1', type: 'get', amt: 300, t: Date.now(), note: '', by: 'Ганӣ', at: 0 };
ош = await отказ(ПРОДАВЕЦ, 'debts', { people: [бахром], ops: [{ ...давний, type: 'give' }, долг, новый], trash: [] });
да(!ош, 'новый долг записан; «gave → give», как переводит программа, — не правка' + (ош ? ': ' + ош : ''));
d = await док('debts');
да(долгО(d, 'o2').by === 'Алишер', 'подпись поставила база: «' + долгО(d, 'o2').by + '», а не «Ганӣ»');
да(долгО(d, 'o2').at > Date.now() - 60000, 'время записи — тоже база');
await писать(ПРОДАВЕЦ, 'debts', { ...d, ops: d.ops.map((o) => o.id === 'o2' ? { ...o, by: 'Ганӣ', note: 'вернёт в пятницу' } : o) });
d = await док('debts');
да(долгО(d, 'o2').by === 'Алишер', 'свою запись не переподписать именем хозяина — подпись вернулась');
да(долгО(d, 'o2').note === 'вернёт в пятницу', 'а заметку поправить можно');

console.log('\n13. Корзина долгов');
ош = await отказ(ПРОДАВЕЦ, 'debts', { ...d, ops: d.ops.filter((o) => o.id !== 'o1'),
  trash: [{ id: 't1', k: 'op', t: Date.now(), by: 'Ганӣ', pn: 'Бахром', op: долгО(d, 'o1'), person: null }] });
да(!ош, 'удалить долг в корзину можно' + (ош ? ': ' + ош : ''));
d = await док('debts');
да(d.trash[0].by === 'Алишер', 'кто удалил — подписала база: «' + d.trash[0].by + '»');
ош = await отказ(ПРОДАВЕЦ, 'debts', { ...d, trash: [{ ...d.trash[0], op: { ...d.trash[0].op, amt: 1 } }] });
да(ош && /debt_changed/.test(ош), 'долг в корзине не подправить');
ош = await отказ(ПРОДАВЕЦ, 'debts', { ...d, trash: [] });
да(ош && /debt_vanished/.test(ош), 'из корзины долг не выбросить — только вернуть');
ош = await отказ(ПРОДАВЕЦ, 'debts', { ...d, ops: [...d.ops, { ...d.trash[0].op, amt: 1 }], trash: [] });
да(ош && /debt_changed/.test(ош), 'вернуть из корзины с другой суммой нельзя');
ош = await отказ(ПРОДАВЕЦ, 'debts', { ...d, ops: [...d.ops, { ...d.trash[0].op, by: 'Алишер' }], trash: [] });
да(!ош, 'вернуть как было — можно' + (ош ? ': ' + ош : ''));
d = await док('debts');
да(долгО(d, 'o1').by === 'Ганӣ', 'и подпись у вернувшегося долга прежняя');

// Корзина держит 100 последних: сто первая запись вытесняет самую старую
const мусор = Array.from({ length: 100 }, (_, k) => ({ id: 'x' + k, k: 'op', t: ВЧЕРА + k, pn: 'Бахром',
  op: { id: 'ox' + k, pid: 'p1', type: 'give', amt: 1, t: ВЧЕРА + k } }));
await писать(ХОЗЯИН, 'debts', { ...d, trash: мусор });
d = await док('debts');
const вКорзину = { id: 't2', k: 'op', t: Date.now(), pn: 'Бахром', op: долгО(d, 'o2'), person: null };
ош = await отказ(ПРОДАВЕЦ, 'debts', { ...d, ops: d.ops.filter((o) => o.id !== 'o2'), trash: [...d.trash.slice(1), вКорзину] });
да(!ош, 'полная корзина: самая старая запись уходит сама' + (ош ? ': ' + ош : ''));
await писать(ХОЗЯИН, 'debts', d);   // вернуть как было — хозяину можно
d = await док('debts');
ош = await отказ(ПРОДАВЕЦ, 'debts', { ...d, ops: d.ops.filter((o) => o.id !== 'o2'),
  trash: [...d.trash.filter((x) => x.id !== 'x50'), вКорзину] });
да(ош && /debt_vanished/.test(ош), 'а выбросить запись из середины корзины — нельзя');

console.log('\n14. Хозяину можно, но след остаётся');
await писать(ХОЗЯИН, 'debts', { ...d, ops: d.ops.map((o) => o.id === 'o1' ? { ...o, amt: 900 } : o) });
да(долгО(await док('debts'), 'o1').amt === 900, 'хозяин исправил сумму');
let след = await последняя();
да(след["by"] === 'Ганӣ' && /переписал/.test(след.txt), 'в ленте: «' + след["by"] + ': ' + след.txt + '»');

console.log('\n15. История склада');
const продажа = (t, qty, by = 'Ганӣ') => ({ by, t, type: 'out', id: 'i1', name: 'Футболка', qty, sum: qty * 100, note: '' });
await писать(ХОЗЯИН, 'main', { items: [], log: [продажа(Date.now() - 60000, 1), продажа(ВЧЕРА, 2)], cats: [], trash: [], biz: '' });
let м = await док('main');
ош = await отказ(ПРОДАВЕЦ, 'main', { ...м, log: [м.log[0]] });
да(ош && /log_vanished/.test(ош), 'вчерашнюю продажу из истории не стереть: ' + (ош || 'стёрлась!'));
ош = await отказ(ПРОДАВЕЦ, 'main', { ...м, log: [м.log[0], { ...м.log[1], qty: 1, sum: 100 }] });
да(ош && /log_vanished/.test(ош), 'количество во вчерашней продаже не подправить');
ош = await отказ(ПРОДАВЕЦ, 'main', { ...м, log: [м.log[1]] });
да(!ош, 'только что сделанную продажу отменить можно (10 минут)' + (ош ? ': ' + ош : ''));
м = await док('main');
await писать(ПРОДАВЕЦ, 'main', { ...м, log: [продажа(Date.now(), 3), ...м.log] });
м = await док('main');
да(м.log[0].by === 'Алишер', 'новую запись подписала база: «' + м.log[0].by + '»');
await писать(ПРОДАВЕЦ, 'main', { ...м, log: м.log.map((l, k) => k === 0 ? { ...l, by: 'Ганӣ' } : l) });
да((await док('main')).log[0].by === 'Алишер', 'переподписать запись истории нельзя');
м = await док('main');
await писать(ХОЗЯИН, 'main', { ...м, log: м.log.filter((l) => l.t !== ВЧЕРА) });
след = await последняя();
да(след["by"] === 'Ганӣ' && /стёр/.test(след.txt), 'хозяин стёр старую запись — в ленте: «' + след["by"] + ': ' + след.txt + '»');
м = await док('main');
await писать(ХОЗЯИН, 'main', { ...м, log: [...м.log, продажа(ВЧЕРА, 5)] });
м = await док('main');
ош = await отказ(ПРОДАВЕЦ, 'main', { ...м, log: Array.from({ length: 400 }, (_, k) => продажа(Date.now() - k, 1)) });
да(!ош, 'история полна (400) — вчерашнее вытесняют новые записи' + (ош ? ': ' + ош : ''));

console.log('\n16. Программа продавца переживает отказ и ничего своего не теряет');
const SkladMerge = createRequire(import.meta.url)('../merge.js');
d = await док('debts');
const телефон = { ...d, ops: [...d.ops.map((o) => o.id === 'o1' ? { ...o, amt: 1 } : o),
  { id: 'o9', pid: 'p1', type: 'give', amt: 70, t: Date.now(), by: 'Алишер', at: Date.now() }] };
ош = await отказ(ПРОДАВЕЦ, 'debts', телефон);
да(ош && /debt_changed/.test(ош), 'сервер правку старого долга не принял');
ош = await отказ(ПРОДАВЕЦ, 'debts', SkladMerge.debtsServerWins(телефон, await док('debts')));
да(!ош, 'со второй попытки ушло: спорное взято с сервера' + (ош ? ': ' + ош : ''));
d = await док('debts');
да(долгО(d, 'o1').amt === 900 && !!долгО(d, 'o9'), 'старый долг — как на сервере (900), а новый долг продавца не потерялся');
const безЧеловека = { ...d, people: [] };
ош = await отказ(ПРОДАВЕЦ, 'debts', безЧеловека);
да(ош && /debt_vanished/.test(ош), 'сервер не принял список без человека с долгами');
ош = await отказ(ПРОДАВЕЦ, 'debts', SkladMerge.debtsServerWins(безЧеловека, await док('debts')));
да(!ош && (await док('debts')).people.some((p) => p.id === 'p1'), 'со второй попытки человек вернулся в список');
await писать(ХОЗЯИН, 'main', { ...м, log: Array.from({ length: 10 }, (_, k) => продажа(ВЧЕРА + k, 1)) });
м = await док('main');
const история = [продажа(Date.now(), 7, 'Алишер'), ...м.log.slice(0, 5)];   // половина старого стёрлась на телефоне
ош = await отказ(ПРОДАВЕЦ, 'main', { ...м, log: история });
да(ош && /log_vanished/.test(ош), 'сервер не принял историю с дырой');
ош = await отказ(ПРОДАВЕЦ, 'main', { ...м, log: SkladMerge.logServerWins(история, м.log) });
м = await док('main');
да(!ош && м.log.length === 11 && м.log.some((l) => l.qty === 7), 'со второй попытки: история целая, новая продажа на месте');

console.log('\n17. Продавец назвался именем хозяина');
await как(ПРОДАВЕЦ, 'update public.staff set name = $1 where uid = $2', ['ганӣ ', ПРОДАВЕЦ]);
const имя = (await строка(ПРОДАВЕЦ)).name;
да(имя !== 'ганӣ' && /сотрудник/.test(имя), 'под хозяина не встать, база дописала пометку: «' + имя + '»');

console.log('\n18. Хозяин увольняет продавца, тот пытается вернуться');
await как(ХОЗЯИН, "update public.staff set status = 'blocked' where uid = $1", [ПРОДАВЕЦ]);
да((await строка(ПРОДАВЕЦ)).status === 'blocked', 'продавец заблокирован');
await как(ПРОДАВЕЦ, 'delete from public.staff where uid = $1', [ПРОДАВЕЦ]);
да(!!(await строка(ПРОДАВЕЦ)), 'свою строку не стереть — в очередь заново не встать');
ош = await какОшибка(ПРОДАВЕЦ, 'select public.delete_my_account()');
да(ош && /blocked_cannot_delete/.test(ош), 'удалить аккаунт и войти заново не выйдет: ' + (ош || 'удалился!'));
да((await как(ПРОДАВЕЦ, 'select id from public.docs')).rows.length === 0, 'заблокированный склада не видит');

console.log('\n19. Хозяин не может случайно лишить лавку хозяина');
await как(ХОЗЯИН, "update public.staff set status = 'blocked' where uid = $1", [ХОЗЯИН]);
да((await строка(ХОЗЯИН)).status === 'active', 'себя не заблокировать');
await как(ХОЗЯИН, 'delete from public.staff where uid = $1', [ХОЗЯИН]);
да(!!(await строка(ХОЗЯИН)), 'свою строку не стереть');
ош = await какОшибка(ХОЗЯИН, 'select public.delete_my_account()');
да(ош && /owner_cannot_delete/.test(ош), 'аккаунт хозяина не удалить');

console.log('\n20. Настройки лавки закрыты для всех');
да((await как(ХОЗЯИН, 'select * from public.settings')).rows.length === 0, 'даже хозяин через программу почту хозяина не прочтёт');
ош = await какОшибка(ВОР, "insert into public.settings values ('owner_email', 'vor@example.com') on conflict (key) do update set value = excluded.value");
const почта = (await db.query("select value from public.settings where key = 'owner_email'")).rows[0].value;
да(почта === ПОЧТА_ХОЗЯИНА, 'вор не переписал почту хозяина на свою' + (ош ? '' : ' (запрос прошёл, но ничего не изменил)'));
да(!!(await какОшибка(ВОР, "select public.may_claim_owner($1::uuid)", [ВОР])), 'проверку «могу ли я стать хозяином» снаружи не вызвать');

console.log('\n21. Служебные функции снаружи не вызвать');
да(!!(await какОшибка(null, 'select public.is_owner()')), 'без входа «хозяин ли я» не спросить');
да(!!(await какОшибка(null, "select public.doc_set('main', '{}'::jsonb, null)")), 'без входа склад не записать');
да((await как(ХОЗЯИН, 'select public.is_owner() as да')).rows[0].да === true, 'вошедший хозяин спрашивает и получает ответ');
const права = (await db.query(`select
  has_function_privilege('authenticated', 'public.docs_guard()', 'execute')     as docs,
  has_function_privilege('authenticated', 'public.staff_guard()', 'execute')    as staff,
  has_function_privilege('authenticated', 'public.activity_guard()', 'execute') as activity,
  has_function_privilege('anon', 'public.is_active()', 'execute')               as anon_active`)).rows[0];
да(!права.docs && !права.staff && !права.activity, 'охранников руками не вызвать — а срабатывают они всё равно (все разделы выше)');
да(!права.anon_active, '«подтверждён ли я» без входа не вызвать');

console.log('\n22. Новенький в очереди уходит сам');
ош = await какОшибка(ВОР, 'select public.delete_my_account()');
да(!ош, 'ожидающий может удалить свой аккаунт' + (ош ? ': ' + ош : ''));
да(!(await строка(ВОР)), 'и его строки больше нет');

console.log('\n23. Схему можно запустить повторно');
ош = null;
try { await db.exec(схема); } catch (e) { ош = e.message; }
да(!ош, 'повторный запуск прошёл без ошибок' + (ош ? ': ' + ош : ''));
да((await строка(ХОЗЯИН)).owner, 'и хозяин после повторного запуска остался хозяином');

console.log('\nИтого: ' + ок + ' проверок прошло, ' + провалов + ' не прошло');
process.exit(провалов ? 1 : 0);
