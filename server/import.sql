-- ============================================================
--  Последний перенос: Supabase → Railway.
--
--  1. Supabase → SQL Editor → вставить запрос ниже → Run.
--     Ответ — одна строка JSON (колонка export). Скопировать её целиком.
--  2. Railway → Postgres → Data → вставить:
--       select srv.import_supabase('…сюда строку…'::jsonb);
--     Ответ: сколько людей, документов и записей ленты перенесено.
--
--  Повторять можно сколько угодно: каждый раз Railway становится копией Supabase.
--  После переключения склада на Railway повторять не нужно — и нельзя: новые записи
--  на Railway затрутся старыми из Supabase.
-- ============================================================

select json_build_object(
  'users', (select coalesce(json_agg(json_build_object(
              'id', u.id, 'email', u.email, 'confirmed', u.email_confirmed_at, 'created', u.created_at,
              'name', coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''),
              -- аккаунт Google: по нему сервер на Railway узнаёт человека при входе
              'sub', (select i.provider_id from auth.identities i where i.user_id = u.id and i.provider = 'google' limit 1))), '[]'::json)
              from auth.users u),
  'staff',    (select coalesce(json_agg(s), '[]'::json) from public.staff s),
  'docs',     (select coalesce(json_agg(d), '[]'::json) from public.docs d),
  'activity', (select coalesce(json_agg(a), '[]'::json) from public.activity a),
  'settings', (select coalesce(json_agg(x), '[]'::json) from public.settings x)
)::text as export;
