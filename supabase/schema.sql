-- ============================================================
--  Sklad Go · схема базы для Supabase
--  Откройте проект на supabase.com → SQL Editor → New query,
--  вставьте этот файл целиком и нажмите Run. Повторный запуск безопасен.
--
--  ПОСЛЕ ЭТОГО — ОДИН РАЗ, отдельным запросом: скажите базе, чья это лавка.
--  Хозяином станет только эта почта, кто бы ни вошёл первым.
--
--    insert into public.settings (key, value) values ('owner_email', 'ваша@gmail.com')
--      on conflict (key) do update set value = excluded.value;
--
--  Пока почта хозяина не задана, хозяином не станет никто — даже вы.
-- ============================================================

-- ---------- Таблицы ----------

-- Склад и долги лежат двумя документами: 'main' и 'debts'.
-- version растёт на каждую запись — по ней ловятся конфликты двух телефонов.
create table if not exists public.docs (
  id         text        primary key,
  data       jsonb       not null default '{}'::jsonb,
  version    bigint      not null default 0,
  updated_at timestamptz not null default now()
);

-- Команда. uid — это пользователь из auth.users (вход через Google).
create table if not exists public.staff (
  uid    uuid    primary key references auth.users(id) on delete cascade,
  name   text    not null default '',
  phone  text    not null default '',
  mail   text    not null default '',
  owner  boolean not null default false,
  status text    not null default 'pending' check (status in ('pending','active','blocked')),
  t      bigint  not null default (extract(epoch from now()) * 1000)::bigint
);

-- Хозяин у лавки один. Это держит сама база, а не программа.
create unique index if not exists staff_single_owner on public.staff (owner) where owner;

-- Лента изменений.
create table if not exists public.activity (
  id   bigserial primary key,
  t    bigint not null,
  "by" text   not null default '',
  uid  text   not null default '',
  txt  text   not null default ''
);
create index if not exists activity_t_idx on public.activity (t desc);

-- Настройки лавки. Читать и писать их через программу нельзя никому:
-- правил доступа у таблицы нет вовсе. Меняются они только в SQL Editor.
create table if not exists public.settings (
  key   text primary key,
  value text not null
);

-- ---------- Кто я такой ----------
-- security definer: эти функции читают staff в обход RLS, иначе правила
-- доступа к самой таблице staff ссылались бы сами на себя.

create or replace function public.is_active() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where uid = auth.uid() and status = 'active')
$$;

create or replace function public.is_owner() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where uid = auth.uid() and owner and status = 'active')
$$;

-- Может ли вошедший стать хозяином: его подтверждённая почта совпадает с той,
-- что записана в settings, и другого хозяина ещё нет. Раньше хозяином становился
-- просто первый вошедший — то есть любой, кто успеет раньше настоящего хозяина.
create or replace function public.may_claim_owner(p_uid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from auth.users u, public.settings s
     where u.id = p_uid
       and s.key = 'owner_email'
       and u.email_confirmed_at is not null
       and lower(trim(u.email)) = lower(trim(s.value))
  )
  and not exists (select 1 from public.staff where owner and uid <> p_uid)
$$;

-- ---------- Охрана таблицы staff ----------
-- Роль и статус нельзя выставить себе самому: их решает база.

create or replace function public.staff_guard() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.uid := auth.uid();
    if new.uid is null then raise exception 'not authenticated'; end if;
    new.owner := false;
    new.status := 'pending';
  else
    new.uid := old.uid;
    new.owner := old.owner;                  -- через программу хозяина не передать
    if not public.is_owner() then
      new.status := old.status;              -- статус меняет только хозяин
    end if;
  end if;

  -- Почта хозяина совпала — становится хозяином. Проверяется и при входе,
  -- и при каждом обновлении своей строки: поэтому неважно, что вы сделали
  -- раньше, вошли или записали почту в settings, — хозяином вы станете сами.
  if not new.owner and public.may_claim_owner(new.uid) then
    new.owner := true;
  end if;

  -- Хозяин всегда в строю: заблокировать себя случайно нельзя, иначе лавка
  -- осталась бы без хозяина, а свободное место занять уже некому.
  if new.owner then
    new.status := 'active';
  end if;

  -- Под чужое имя не встать: сотрудник не может назваться так же, как хозяин,
  -- иначе его записи в ленте выглядели бы как записи хозяина. Отказывать не
  -- будем — человек молча не зарегистрировался бы и не понял почему. База
  -- просто допишет к имени пометку.
  if not new.owner and exists (
       select 1 from public.staff
        where owner and uid <> new.uid and lower(trim(name)) = lower(trim(new.name)) and trim(name) <> '') then
    new.name := trim(new.name) || ' (сотрудник)';
  end if;

  return new;
end $$;

drop trigger if exists staff_guard on public.staff;
create trigger staff_guard before insert or update on public.staff
  for each row execute function public.staff_guard();

-- ---------- Охрана ленты ----------
-- Кто и когда — решает база. Раньше телефон сам писал, от чьего имени запись
-- и какого она числа, и запись можно было подписать хоть именем хозяина.

create or replace function public.activity_guard() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.uid := coalesce(auth.uid()::text, '');
  new."by" := coalesce((select name from public.staff where uid = auth.uid()), '');
  new.t := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  new.txt := left(coalesce(new.txt, ''), 300);
  return new;
end $$;

drop trigger if exists activity_guard on public.activity;
create trigger activity_guard before insert on public.activity
  for each row execute function public.activity_guard();

-- ---------- Запись склада с проверкой версии ----------
-- p_if_match — версия, которую телефон видел последней.
-- Не совпала → version_conflict, и приложение само сольёт изменения и повторит.

create or replace function public.doc_set(p_id text, p_data jsonb, p_if_match bigint)
  returns bigint language plpgsql security invoker set search_path = public as $$
declare cur bigint; v bigint;
begin
  select version into cur from public.docs where id = p_id for update;

  if cur is null then
    begin
      insert into public.docs (id, data, version) values (p_id, p_data, 1) returning version into v;
      return v;
    exception when unique_violation then
      raise exception 'version_conflict';    -- кто-то создал документ первым
    end;
  end if;

  if p_if_match is not null and p_if_match <> cur then
    raise exception 'version_conflict';
  end if;

  update public.docs set data = p_data, version = cur + 1, updated_at = now()
    where id = p_id returning version into v;
  return v;
end $$;

-- ---------- Удаление своего аккаунта ----------
-- Хозяину нельзя: лавка осталась бы без хозяина.
-- Заблокированному тоже: удалил бы аккаунт, вошёл тем же Google заново —
-- и снова стоял бы в очереди «ждут подтверждения», как новенький.
create or replace function public.delete_my_account() returns void
  language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.staff where uid = me and owner) then
    raise exception 'owner_cannot_delete';
  end if;
  if exists (select 1 from public.staff where uid = me and status = 'blocked') then
    raise exception 'blocked_cannot_delete';
  end if;
  delete from public.staff where uid = me;
  delete from auth.users where id = me;
end $$;

-- ---------- Права доступа ----------

alter table public.docs     enable row level security;
alter table public.staff    enable row level security;
alter table public.activity enable row level security;
alter table public.settings enable row level security;   -- и без единого правила: закрыто для всех

drop policy if exists docs_read      on public.docs;
drop policy if exists docs_insert    on public.docs;
drop policy if exists docs_update    on public.docs;
drop policy if exists staff_read     on public.staff;
drop policy if exists staff_insert   on public.staff;
drop policy if exists staff_update   on public.staff;
drop policy if exists staff_delete   on public.staff;
drop policy if exists activity_read  on public.activity;
drop policy if exists activity_write on public.activity;

-- Склад и долги: только подтверждённые сотрудники, и только чтение-запись.
create policy docs_read   on public.docs for select using (public.is_active());
create policy docs_insert on public.docs for insert with check (public.is_active());
create policy docs_update on public.docs for update using (public.is_active()) with check (public.is_active());

-- Свою строку видно всегда — иначе не показать экран «ожидайте подтверждения».
create policy staff_read   on public.staff for select using (uid = auth.uid() or public.is_active());
create policy staff_insert on public.staff for insert with check (uid = auth.uid());
create policy staff_update on public.staff for update using (uid = auth.uid() or public.is_owner()) with check (true);
-- Удалять строки сотрудников через программу нельзя никому. Раньше было можно
-- удалить свою: заблокированный так возвращался в очередь, а хозяин мог
-- нечаянно освободить своё место. Уйти совсем — только через delete_my_account.

-- Лента: читают и пишут подтверждённые. Исправить или стереть запись нельзя.
create policy activity_read  on public.activity for select using (public.is_active());
create policy activity_write on public.activity for insert with check (public.is_active());

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.doc_set(text, jsonb, bigint) to authenticated;
revoke all on function public.may_claim_owner(uuid) from public;

-- ---------- Живые обновления ----------
-- Без этого изменения с другого телефона не приедут сами.

alter table public.staff    replica identity full;
alter table public.activity replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.staff;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.activity;
exception when duplicate_object then null; end $$;
