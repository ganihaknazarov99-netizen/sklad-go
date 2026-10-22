-- ============================================================
--  Sklad Go · схема базы для Supabase
--  Откройте проект на supabase.com → SQL Editor → New query,
--  вставьте этот файл целиком и нажмите Run. Повторный запуск безопасен.
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

-- Лента изменений.
create table if not exists public.activity (
  id   bigserial primary key,
  t    bigint not null,
  "by" text   not null default '',
  uid  text   not null default '',
  txt  text   not null default ''
);
create index if not exists activity_t_idx on public.activity (t desc);

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

-- ---------- Охрана таблицы staff ----------
-- Роль и статус нельзя выставить себе самому: их решает сервер.
-- Первый вошедший становится владельцем, все следующие — ждут подтверждения.

create or replace function public.staff_guard() returns trigger
  language plpgsql security definer set search_path = public as $$
declare has_owner boolean;
begin
  if tg_op = 'INSERT' then
    new.uid := auth.uid();
    if new.uid is null then raise exception 'not authenticated'; end if;
    select exists (select 1 from public.staff where owner) into has_owner;
    if has_owner then
      new.owner := false;
      new.status := 'pending';
    else
      new.owner := true;
      new.status := 'active';
    end if;
    return new;
  end if;

  new.uid := old.uid;
  new.owner := old.owner;                    -- владельца через эту таблицу не передать
  if not public.is_owner() then
    new.status := old.status;                -- статус меняет только владелец
  end if;
  return new;
end $$;

drop trigger if exists staff_guard on public.staff;
create trigger staff_guard before insert or update on public.staff
  for each row execute function public.staff_guard();

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
create or replace function public.delete_my_account() returns void
  language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.staff where uid = me and owner) then
    raise exception 'owner_cannot_delete';
  end if;
  delete from public.staff where uid = me;
  delete from auth.users where id = me;
end $$;

-- ---------- Права доступа ----------

alter table public.docs     enable row level security;
alter table public.staff    enable row level security;
alter table public.activity enable row level security;

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
create policy staff_delete on public.staff for delete using (uid = auth.uid());

-- Лента: читают и пишут подтверждённые.
create policy activity_read  on public.activity for select using (public.is_active());
create policy activity_write on public.activity for insert with check (public.is_active());

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.doc_set(text, jsonb, bigint) to authenticated;

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
