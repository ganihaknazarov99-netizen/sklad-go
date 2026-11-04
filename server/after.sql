-- ============================================================
--  Запускается после supabase/schema.sql. Повторный запуск безопасен.
-- ============================================================

-- Права на таблицы — как в Supabase: роли видят таблицы, а что именно — решают правила (RLS).
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- Команда с первого шага переезда: строки команды переносятся как есть, с тем же uid.
-- Пользователи для них — пока без почты: почту в команде человек вписывал сам, и по ней
-- нельзя решать, кто есть кто. Настоящие почту и аккаунт Google (подтверждённые) кладёт
-- последний перенос из Supabase — server/import.sql. Тогда хозяин, войдя тем же Gmail,
-- остаётся хозяином. Охранник staff_guard на это время выключен: он пускает только «себя».
do $$ begin
  if to_regclass('public.staff_step1') is not null then
    insert into auth.users (id, name)
      select uid::uuid, name from public.staff_step1
      on conflict do nothing;
    set local session_replication_role = replica;
    insert into public.staff (uid, name, phone, mail, owner, status, t)
      select uid::uuid, name, phone, mail, owner, status, t from public.staff_step1
      on conflict (uid) do nothing;
    set local session_replication_role = origin;
    drop table public.staff_step1;
  end if;
end $$;

-- ---------- Живые обновления ----------
-- Supabase сам рассылал изменения. Здесь база шлёт серверу короткий сигнал «изменилось
-- то-то», а сервер передаёт его телефонам. Сами данные в сигнал не кладём: телефон
-- перечитает их обычным запросом — со всеми правилами доступа.
create or replace function srv.notify() returns trigger language plpgsql as $$
declare i text;
begin
  -- new.id есть только у документов: у staff его нет, и обращение к нему было бы ошибкой
  if tg_table_name = 'docs' then i := new.id; end if;
  perform pg_notify('sklad', json_build_object('t', tg_table_name, 'id', i)::text);
  return null;
end $$;
drop trigger if exists sklad_notify on public.docs;
create trigger sklad_notify after insert or update on public.docs for each row execute function srv.notify();
drop trigger if exists sklad_notify on public.staff;
create trigger sklad_notify after insert or update or delete on public.staff for each row execute function srv.notify();
drop trigger if exists sklad_notify on public.activity;
create trigger sklad_notify after insert on public.activity for each row execute function srv.notify();

-- ---------- Понятные таблицы для хозяина ----------
-- Склад и долги хранятся одним документом. Чтобы в Railway их было видно строками,
-- как в Excel, держим рядом таблицы «товары», «операции» и т.д. Они пересобираются
-- сами при каждом изменении. Программе они не нужны, продавцам недоступны.
drop table if exists public.товары, public.операции, public.люди, public.долги, public.команда, public.лента;
create table public.товары (название text, категория text, цвет text, размер text, единица text, количество numeric,
  цена numeric, цена_за text, штук_в_пачке int, нет_в_наличии boolean, добавил text, добавлено timestamptz, id text);
create table public.операции (время timestamptz, вид text, товар text, количество numeric, сумма numeric, заметка text, сотрудник text);
create table public.люди (имя text, телефон text, id text);
create table public.долги (человек text, вид text, сумма numeric, время timestamptz, вернуть_до text, заметка text, записал text, id text);
create table public.команда (имя text, телефон text, почта text, роль text, статус text);
create table public.лента (время timestamptz, кто text, что text);
revoke all on public.товары, public.операции, public.люди, public.долги, public.команда, public.лента from public, anon, authenticated;

create or replace function srv.rebuild_docs() returns void language plpgsql security definer set search_path = public as $$
begin
    delete from товары; delete from операции; delete from люди; delete from долги;
    insert into товары select i->>'name', i->>'cat', nullif(i->>'color',''), nullif(i->>'size',''),
        coalesce(nullif(i->>'u',''),'шт'), (i->>'qty')::numeric, (i->>'price')::numeric,
        case when i->>'pb' = 'pack' then 'за пачку' else 'за штуку' end,
        case when jsonb_typeof(i->'pk') = 'array' then (i->'pk'->>0)::int end,
        coalesce((i->>'qty')::numeric, 0) <= 0, i->>'ab', to_timestamp((i->>'ad')::bigint / 1000.0), i->>'id'
      from docs, jsonb_array_elements(coalesce(docs.data->'items','[]'::jsonb)) i where docs.id = 'main';
    insert into операции select to_timestamp((l->>'t')::bigint / 1000.0),
        case l->>'type' when 'out' then 'продажа' when 'in' then 'приход' when 'fix' then 'пересчёт' else l->>'type' end,
        l->>'name', (l->>'qty')::numeric, (l->>'sum')::numeric, nullif(l->>'note',''), l->>'by'
      from docs, jsonb_array_elements(coalesce(docs.data->'log','[]'::jsonb)) l where docs.id = 'main';
    insert into люди select p->>'name', nullif(p->>'phone',''), p->>'id'
      from docs, jsonb_array_elements(coalesce(docs.data->'people','[]'::jsonb)) p where docs.id = 'debts';
    insert into долги select
        (select p->>'name' from docs d2, jsonb_array_elements(coalesce(d2.data->'people','[]'::jsonb)) p where d2.id = 'debts' and p->>'id' = o->>'pid'),
        case o->>'type' when 'give' then 'дал в долг' when 'get' then 'получил' else o->>'type' end,
        (o->>'amt')::numeric, to_timestamp((o->>'t')::bigint / 1000.0), nullif(o->>'due',''), nullif(o->>'note',''), o->>'by', o->>'id'
      from docs, jsonb_array_elements(coalesce(docs.data->'ops','[]'::jsonb)) o where docs.id = 'debts';
end $$;
create or replace function srv.rebuild_staff() returns void language plpgsql security definer set search_path = public as $$
begin
    delete from команда;
    insert into команда select name, phone, mail, case when owner then 'хозяин' else 'продавец' end,
        case status when 'active' then 'разрешён' when 'pending' then 'ждёт' when 'blocked' then 'заблокирован' else status end
      from staff;
end $$;
create or replace function srv.rebuild_activity() returns void language plpgsql security definer set search_path = public as $$
begin
    delete from лента;
    insert into лента select to_timestamp(t / 1000.0), "by", txt from activity order by t desc;
end $$;
create or replace function srv.readable() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'docs' then perform srv.rebuild_docs();
  elsif tg_table_name = 'staff' then perform srv.rebuild_staff();
  else perform srv.rebuild_activity(); end if;
  return null;
end $$;
revoke all on function srv.readable(), srv.rebuild_docs(), srv.rebuild_staff(), srv.rebuild_activity() from public, anon, authenticated;
revoke all on function srv.notify() from public, anon, authenticated;
drop trigger if exists sklad_readable on public.docs;
create trigger sklad_readable after insert or update on public.docs for each statement execute function srv.readable();
drop trigger if exists sklad_readable on public.staff;
create trigger sklad_readable after insert or update or delete on public.staff for each statement execute function srv.readable();
drop trigger if exists sklad_readable on public.activity;
create trigger sklad_readable after insert or delete on public.activity for each statement execute function srv.readable();
-- Сразу заполнить (документы не трогаем: их «пустое» изменение сдвинуло бы версию и телефоны перечитали бы склад)
select srv.rebuild_docs(), srv.rebuild_staff(), srv.rebuild_activity();

-- ---------- Последний перенос из Supabase ----------
-- В Supabase выполняют запрос из server/import.sql — он выдаёт всё одной строкой JSON.
-- Здесь: select srv.import_supabase('…строка…'::jsonb);
-- Supabase — главный: что есть там, то и будет здесь (команда, склад, долги, лента,
-- настройки). Пользователи переносятся с настоящей почтой и аккаунтом Google — по ним
-- сервер узнаёт человека при входе, и uid остаётся прежним. Версии документов тоже
-- прежние: телефоны продолжат писать без столкновений.
create or replace function srv.import_supabase(j jsonb) returns text language plpgsql as $$
declare n_users int; n_staff int; n_docs int; n_act int;
begin
  if jsonb_typeof(j->'users') <> 'array' or jsonb_typeof(j->'docs') <> 'array' then
    raise exception 'Это не выгрузка из Supabase';
  end if;
  -- Охранники пускают в команду только «себя» и подписывают записи сами — а здесь
  -- переносим всех разом, как было
  set local session_replication_role = replica;

  -- Кто вошёл сюда для проверки до переноса — уступает место настоящей записи
  delete from auth.users a where a.id not in (select (x->>'id')::uuid from jsonb_array_elements(j->'users') x);
  delete from srv.sessions s where s.user_id not in (select id from auth.users);
  delete from public.staff s where s.uid not in (select id from auth.users);
  insert into auth.users (id, email, email_confirmed_at, google_sub, name, created_at)
    select (x->>'id')::uuid, nullif(lower(trim(x->>'email')), ''), (x->>'confirmed')::timestamptz,
           nullif(x->>'sub', ''), coalesce(x->>'name', ''), coalesce((x->>'created')::timestamptz, now())
      from jsonb_array_elements(j->'users') x
    on conflict (id) do update set email = excluded.email, email_confirmed_at = excluded.email_confirmed_at,
      google_sub = excluded.google_sub, name = case when excluded.name <> '' then excluded.name else auth.users.name end;
  get diagnostics n_users = row_count;

  delete from public.staff s where s.uid not in (select (x->>'uid')::uuid from jsonb_array_elements(j->'staff') x);
  insert into public.staff (uid, name, phone, mail, owner, status, t)
    select (x->>'uid')::uuid, x->>'name', x->>'phone', x->>'mail', (x->>'owner')::boolean, x->>'status', (x->>'t')::bigint
      from jsonb_array_elements(j->'staff') x
    on conflict (uid) do update set name = excluded.name, phone = excluded.phone, mail = excluded.mail,
      owner = excluded.owner, status = excluded.status, t = excluded.t;
  get diagnostics n_staff = row_count;

  insert into public.docs (id, data, version, updated_at)
    select x->>'id', x->'data', (x->>'version')::bigint, (x->>'updated_at')::timestamptz
      from jsonb_array_elements(j->'docs') x
    on conflict (id) do update set data = excluded.data, version = excluded.version, updated_at = excluded.updated_at;
  get diagnostics n_docs = row_count;

  delete from public.activity;
  insert into public.activity (id, t, "by", uid, txt)
    select (x->>'id')::bigint, (x->>'t')::bigint, x->>'by', x->>'uid', x->>'txt'
      from jsonb_array_elements(coalesce(j->'activity', '[]'::jsonb)) x;
  get diagnostics n_act = row_count;
  perform setval(pg_get_serial_sequence('public.activity', 'id'), coalesce((select max(id) from public.activity), 0) + 1, false);

  insert into public.settings (key, value)
    select x->>'key', x->>'value' from jsonb_array_elements(coalesce(j->'settings', '[]'::jsonb)) x
    on conflict (key) do update set value = excluded.value;

  set local session_replication_role = origin;
  perform srv.rebuild_docs(); perform srv.rebuild_staff(); perform srv.rebuild_activity();
  return format('Перенесено: людей %s, в команде %s, документов %s, записей ленты %s', n_users, n_staff, n_docs, n_act);
end $$;
revoke all on function srv.import_supabase(jsonb) from public, anon, authenticated;
