-- ============================================================
--  Sklad Go на своём PostgreSQL (Railway): то, что раньше давал Supabase.
--  Правила доступа и охрана долгов — те же supabase/schema.sql, слово в слово.
--  Им нужны три вещи Supabase: роль authenticated, таблица auth.users и auth.uid() —
--  «кто спрашивает». Здесь они свои: сервер (server/) на каждый запрос включает роль
--  authenticated и записывает в request.jwt.claim.sub того, кто вошёл через Google.
--  Повторный запуск безопасен.
-- ============================================================

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  email_confirmed_at timestamptz,
  google_sub         text unique,
  name               text not null default '',
  created_at         timestamptz not null default now(),
  last_sign_in_at    timestamptz
);
-- Вход по почте и паролю: здесь только отпечаток пароля (scrypt с солью), сам пароль — нигде.
-- Почта при таком входе не подтверждена Google (email_confirmed_at пуст), поэтому стать
-- по ней хозяином нельзя (may_claim_owner в schema.sql)
alter table auth.users add column if not exists pass_hash text;
-- Код из приложения (Google Authenticator) к входу по паролю: общий секрет, секрет на время
-- настройки и номер последнего принятого окна — один и тот же код дважды не проходит
alter table auth.users add column if not exists totp_secret text,
                       add column if not exists totp_pending text,
                       add column if not exists totp_step bigint not null default -1;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

grant usage on schema public, auth to anon, authenticated;
-- Supabase сам выдаёт этим ролям право вызывать новые функции в public — schema.sql
-- поэтому отбирает его поимённо. Делаем так же, иначе правила здесь были бы мягче.
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- Вход: сессии живут только на сервере. В браузере — случайный ключ в закрытой cookie,
-- здесь — его отпечаток (sha256), чтобы утёкшая таблица не давала войти.
create schema if not exists srv;
revoke all on schema srv from public;
create table if not exists srv.sessions (
  token_hash text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on srv.sessions (user_id);

-- Копия с первого шага переезда: там staff.uid был текстом и без auth.users.
-- Убираем её в сторону — schema.sql создаст настоящую таблицу, а данные перенесёт after.sql.
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'staff' and column_name = 'uid' and data_type = 'text') then
    alter table public.staff rename to staff_step1;
  end if;
end $$;
