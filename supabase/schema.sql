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

-- ---------- Охрана долгов и истории склада ----------
-- Раньше любой подтверждённый продавец мог переписать склад и долги целиком:
-- уменьшить чужой долг, стереть его, подписать запись именем хозяина. Теперь
-- база сверяет каждую новую версию с прежней — так же, как сервер полной версии:
--   · записанный долг не меняется задним числом: чей, дал или взял, сколько
--     и какого числа — как было. Ошибку исправляют обратной записью;
--   · удалить долг можно только в корзину, а из корзины он уходит только
--     назад в долги. Телефон держит в корзине 100 последних и лишнее обрезает,
--     но у продавца база обрезанное кладёт назад: вытеснить долг из корзины
--     может только хозяин;
--   · человек не пропадёт из долгов, пока за ним остаются записи;
--   · запись в истории склада стирается, только если её отменили сразу
--     (10 минут) или её вытеснили новые (история держит 400 последних);
--   · кто внёс запись — подписывает база, а не телефон.
-- Хозяину можно всё, но в ленте останется строчка, что он переписывал.
--
-- Время, по которому решают «свежая» и «вытеснена», ставит база (поле st), а не
-- телефон. Раньше продавец стирал долг в три записи: долг в корзину, следом сто
-- пустых записей корзины «новее» — долг считался вытесненным, — и пустые убрать.
-- Историю склада так же: 400 записей «сейчас», старое вытеснено, а свои 400
-- «отменил сразу». Теперь:
--   · вытеснять старое могут только записи истории старше 10 минут — их уже не
--     отменить, они останутся в истории навсегда, под именем того, кто их внёс;
--   · обрезанное телефоном по краю, что вытеснять ещё рано, база кладёт назад;
--   · всё, что ушло из документа (вытеснено, отменено, стёрто хозяином), база
--     сама откладывает в docs_archive — пропасть насовсем не может ничего;
--   · продавец поменял остаток товара без записи в истории — в ленте строчка.

-- Список из документа. Не список — значит, пусто.
create or replace function public.jarr(j jsonb) returns jsonb
  language sql immutable set search_path = public as $$
  select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end
$$;

-- Число из документа. Не число — ноль, как и у программы.
create or replace function public.jnum(j jsonb) returns numeric
  language sql immutable set search_path = public as $$
  select case when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric else 0 end
$$;

-- Все записи долгов в документе: и в списке, и в корзине.
-- entry — запись корзины, в которой лежит долг (у тех, что в списке, — пусто).
create or replace function public.debt_recs(d jsonb)
  returns table (id text, rec jsonb, entry jsonb)
  language sql immutable set search_path = public as $$
  select x->>'id', x, null::jsonb
    from jsonb_array_elements(public.jarr(d->'ops')) x
   where x->>'id' is not null
  union all
  select e->'op'->>'id', e->'op', e
    from jsonb_array_elements(public.jarr(d->'trash')) e
   where e->>'k' = 'op' and e->'op'->>'id' is not null
  union all
  select o->>'id', o, e
    from jsonb_array_elements(public.jarr(d->'trash')) e,
         jsonb_array_elements(public.jarr(e->'ops')) o
   where e->>'k' = 'person' and o->>'id' is not null
$$;

-- Долг тот же: чей, дал или взял, сколько и какого числа. Старые записи
-- называли «дал» и «взял» по-другому; программа переводит их сама, и это
-- не правка долга.
create or replace function public.debt_same(a jsonb, b jsonb) returns boolean
  language sql immutable set search_path = public as $$
  select a->'pid' is not distinct from b->'pid'
     and a->'amt' is not distinct from b->'amt'
     and a->'t'   is not distinct from b->'t'
     and (case when a->>'type' in ('gave', 'paid') then 'give'
               when a->>'type' in ('took', 'got')  then 'get' else a->>'type' end)
         is not distinct from
         (case when b->>'type' in ('gave', 'paid') then 'give'
               when b->>'type' in ('took', 'got')  then 'get' else b->>'type' end)
$$;

-- Записи долгов в одной записи корзины: удалённый долг или человек со всеми долгами.
create or replace function public.trash_recs(e jsonb)
  returns table (id text, rec jsonb)
  language sql immutable set search_path = public as $$
  select e->'op'->>'id', e->'op'
   where e->>'k' = 'op' and e->'op'->>'id' is not null
  union all
  select o->>'id', o
    from jsonb_array_elements(public.jarr(e->'ops')) o
   where e->>'k' = 'person' and o->>'id' is not null
$$;

-- Когда запись попала в документ — по часам базы. Новой записи время ставит база
-- (st, см. stamp_rec), у прежней остаётся то, что было. У записей, сделанных до этой
-- правки, st нет — берём t, что прислал телефон. И то и другое — не позже прошлой
-- записи документа (cap): запись не может быть свежее документа, в котором уже лежала.
-- Так подделанное заранее «время из будущего» тоже ничего не даёт.
create or replace function public.rec_time(x jsonb, cap numeric) returns numeric
  language sql immutable set search_path = public as $$
  select least(case when jsonb_typeof(x->'st') = 'number' then public.jnum(x->'st')
                    else public.jnum(x->'t') end, cap)
$$;

-- Отметка базы на записи: st — когда запись появилась (часы базы), su — чья она.
-- Новой ставит база, у прежней — та, что была (и t тоже прежнее), что бы ни
-- прислал телефон.
create or replace function public.stamp_rec(x jsonb, was jsonb, at_ms bigint, who_uid text) returns jsonb
  language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(x) is distinct from 'object' then x
    when was is not null then
      (x - 'st' - 'su' - 't') || jsonb_strip_nulls(jsonb_build_object('t', coalesce(was->'t', x->'t'), 'st', was->'st', 'su', was->'su'))
    else (x - 'st' - 'su') || jsonb_strip_nulls(jsonb_build_object('st', at_ms, 'su', who_uid))
  end
$$;

-- Действие записи истории на остаток товара: привёз +, продал −, пересчёт — как записан.
create or replace function public.log_effect(l jsonb) returns numeric
  language sql immutable set search_path = public as $$
  select case l->>'type' when 'in' then public.jnum(l->'qty')
                         when 'out' then -public.jnum(l->'qty')
                         when 'fix' then public.jnum(l->'qty')
                         else 0 end
$$;

-- Всё, что ушло из склада и долгов, база откладывает сюда сама: записи долгов,
-- вытесненные из корзины или переписанные хозяином, и записи истории склада —
-- вытесненные, отменённые, стёртые. Читает только хозяин, писать и стирать через
-- программу нельзя никому (правил на запись нет). Railway → Data:
--   select * from public.docs_archive order by id desc;
create table if not exists public.docs_archive (
  id    bigserial primary key,
  t     bigint not null,                 -- когда ушло, по часам базы
  doc   text   not null,                 -- 'debts' — запись долга, 'main' — запись истории склада
  why   text   not null,                 -- evicted · undone · removed · changed
  "by"  text   not null default '',      -- чья запись документа это сделала
  uid   text   not null default '',
  rec   jsonb  not null                  -- сама запись, как была
);
create index if not exists docs_archive_t_idx on public.docs_archive (t desc);

-- Запись в истории склада узнаём по времени, операции, товару, количеству и сумме.
create or replace function public.log_key(l jsonb) returns text
  language sql immutable set search_path = public as $$
  select jsonb_build_array(l->'t', l->'type', l->'id', l->'qty', l->'sum')::text
$$;

-- Подпись записи. Новую подписывает база: кто внёс, а долгу (at_ms) — и когда,
-- если телефон не сказал. У прежней остаётся та подпись, что была, что бы ни
-- прислал телефон.
create or replace function public.sign_rec(x jsonb, was jsonb, who text, at_ms bigint) returns jsonb
  language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(x) is distinct from 'object' then x
    when was is not null then
      (x - 'by' - 'at') || jsonb_strip_nulls(jsonb_build_object('by', was->'by', 'at', was->'at'))
    when at_ms is null or (jsonb_typeof(x->'at') = 'number' and x->'at' > '0'::jsonb) then
      x || jsonb_build_object('by', who)
    else x || jsonb_build_object('by', who, 'at', at_ms)
  end
$$;

create or replace function public.docs_guard() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  prev     jsonb   := case when tg_op = 'UPDATE' then old.data else '{}'::jsonb end;
  nowms    bigint  := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  -- прошлая запись документа: ни одна прежняя запись в нём не свежее её
  cap      numeric := case when tg_op = 'UPDATE' then floor(extract(epoch from old.updated_at) * 1000) else 0 end;
  me       text    := coalesce(auth.uid()::text, '');
  boss     boolean;
  who      text;
  known    jsonb;   -- записи долгов, что уже были, по номеру
  seen     jsonb;   -- записи долгов в новой версии, по номеру
  ptrash   jsonb;   -- прежняя корзина, по номеру
  ntrash   jsonb;   -- номера записей новой корзины
  plog     jsonb;   -- прежняя история склада, по ключу записи
  nlog     jsonb;   -- ключи записей новой истории склада
  outs     jsonb;   -- что стало с каждой ушедшей записью
  putback  jsonb;   -- что база кладёт назад
  ncnt     int;     -- сколько записей прислал телефон
  changed  int := 0;
  gone     int := 0;
  other    int := 0;
  odd      text;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id then raise exception 'doc_id_locked'; end if;
    new.version := old.version + 1;          -- версию двигает база, телефон её не подделает
  else
    new.version := 1;
  end if;
  new.updated_at := now();                   -- и время записи тоже

  -- Без входа сюда пишет только SQL Editor — там хозяин базы, а не продавец.
  if auth.uid() is null or new.id not in ('main', 'debts') then return new; end if;
  if jsonb_typeof(new.data) is distinct from 'object' then raise exception 'bad_doc'; end if;

  boss := public.is_owner();
  who  := coalesce((select name from public.staff where uid = auth.uid()), '');

  if new.id = 'debts' then
    known  := coalesce((select jsonb_object_agg(r.id, r.rec) from public.debt_recs(prev) r), '{}'::jsonb);
    seen   := coalesce((select jsonb_object_agg(r.id, r.rec) from public.debt_recs(new.data) r), '{}'::jsonb);
    ptrash := coalesce((select jsonb_object_agg(e->>'id', e)
                          from jsonb_array_elements(public.jarr(prev->'trash')) e
                         where e->>'id' is not null), '{}'::jsonb);
    ntrash := coalesce((select jsonb_object_agg(e->>'id', true)
                          from jsonb_array_elements(public.jarr(new.data->'trash')) e
                         where e->>'id' is not null), '{}'::jsonb);
    ncnt   := jsonb_array_length(public.jarr(new.data->'trash'));

    -- Записанный долг изменили — где бы он ни лежал, в списке или в корзине.
    select count(*) into changed
      from public.debt_recs(new.data) n
     where (known -> n.id) is not null and not public.debt_same(known -> n.id, n.rec);

    -- Записи долгов, которых в новой версии нет нигде, и что с каждой:
    --   evicted — хозяин вытеснил запись корзины по-честному: в новой корзине сто
    --             настоящих удалений (с долгами внутри), и все новее по часам базы.
    --             Пустые или чужие записи корзины в счёт не идут;
    --   back    — телефон обрезал корзину по краю (держит 100), а вытеснять нельзя:
    --             база кладёт ту запись корзины назад. У продавца — всегда так,
    --             вытеснить долг из корзины он не может никакой чередой записей;
    --   gone    — пропала: продавцу отказ, хозяину строчка в ленте.
    with pt as (
      select e, e->>'id' as id, i as pos, public.rec_time(e, cap) as eff
        from jsonb_array_elements(public.jarr(prev->'trash')) with ordinality x(e, i)
    ),
    lim as (   -- что из прежней корзины осталось: всё, что раньше него, — обрезанный край
      select min(pos) as minpos, min(public.jnum(e->'t')) as mint
        from pt where id is not null and ntrash ? id
    ),
    nt as (
      select case when ptrash ? (e->>'id') then public.rec_time(ptrash -> (e->>'id'), cap) else nowms end as eff
        from jsonb_array_elements(public.jarr(new.data->'trash')) e
       where exists (select 1 from public.trash_recs(e))
    ),
    ptf as (
      select pt.pos, pt.e,
             case
               when boss and (select count(*) from nt where nt.eff > pt.eff) >= 100 then 'evicted'
               when ncnt >= 100 and (lim.minpos is null or pt.pos < lim.minpos
                                     or public.jnum(pt.e->'t') < lim.mint) then 'back'
               else 'gone'
             end as fate
        from pt, lim
       where pt.id is null or not (ntrash ? pt.id)
    ),
    lost as (
      select x as rec, 'gone'::text as fate, null::bigint as pos
        from jsonb_array_elements(public.jarr(prev->'ops')) x
       where x->>'id' is not null and (seen -> (x->>'id')) is null
      union all
      select r.rec, coalesce(ptf.fate, 'gone'), pt.pos
        from pt
        cross join lateral public.trash_recs(pt.e) r
        left join ptf on ptf.pos = pt.pos
       where (seen -> r.id) is null
    )
    select coalesce(jsonb_agg(jsonb_build_object('rec', l.rec, 'fate', l.fate)), '[]'::jsonb),
           coalesce((select jsonb_agg(ptf.e order by ptf.pos) from ptf
                      where ptf.fate = 'back' and exists (select 1 from lost where lost.pos = ptf.pos)), '[]'::jsonb)
      into outs, putback
      from lost l;

    select count(*) into gone from jsonb_array_elements(outs) f where f->>'fate' = 'gone';

    -- Человек пропал, а записи за ним остались — их долги не видно на экране.
    gone := gone + (
      select count(*)
        from jsonb_array_elements(public.jarr(prev->'people')) p
       where p->>'id' is not null
         and not exists (select 1 from jsonb_array_elements(public.jarr(new.data->'people')) q
                          where q->>'id' = p->>'id')
         and exists (select 1 from jsonb_array_elements(public.jarr(new.data->'ops')) o
                      where o->>'pid' = p->>'id'));

    if not boss and changed > 0 then raise exception 'debt_changed'; end if;
    if not boss and gone > 0 then raise exception 'debt_vanished'; end if;
    if changed + gone > 0 then
      insert into public.activity (txt) values ('переписал задним числом записи долгов: ' || (changed + gone));
    end if;

    -- Ушедшее из документа — в архив: вытесненное, стёртое и прежний вид переписанного.
    insert into public.docs_archive (t, doc, why, "by", uid, rec)
      select nowms, 'debts', case f->>'fate' when 'gone' then 'removed' else f->>'fate' end, who, me, f->'rec'
        from jsonb_array_elements(outs) f
       where f->>'fate' in ('evicted', 'gone');
    if changed > 0 then
      insert into public.docs_archive (t, doc, why, "by", uid, rec)
        select nowms, 'debts', 'changed', who, me, known -> n.id
          from public.debt_recs(new.data) n
         where (known -> n.id) is not null and not public.debt_same(known -> n.id, n.rec);
    end if;

    new.data := jsonb_set(new.data, '{ops}', coalesce((
      select jsonb_agg(public.sign_rec(x, known -> (x->>'id'), who, nowms) order by i)
        from jsonb_array_elements(public.jarr(new.data->'ops')) with ordinality e(x, i)
    ), '[]'::jsonb));

    -- Корзина: обрезанное, что вытеснять нельзя, — назад, в начало (там самое старое).
    -- Новой записи корзины база ставит своё время (st), у прежней — время как было.
    new.data := jsonb_set(new.data, '{trash}', coalesce((
      select jsonb_agg(
               case when jsonb_typeof(x) is distinct from 'object' then x
                    else public.stamp_rec(public.sign_rec(x, ptrash -> (x->>'id'), who, null), ptrash -> (x->>'id'), nowms, null)
                      || case
                           when x->>'k' = 'op' and jsonb_typeof(x->'op') = 'object' then
                             jsonb_build_object('op', public.sign_rec(x->'op', known -> (x->'op'->>'id'), who, nowms))
                           when x->>'k' = 'person' and jsonb_typeof(x->'ops') = 'array' then
                             jsonb_build_object('ops', (
                               select coalesce(jsonb_agg(public.sign_rec(o, known -> (o->>'id'), who, nowms) order by j), '[]'::jsonb)
                                 from jsonb_array_elements(x->'ops') with ordinality q(o, j)))
                           else '{}'::jsonb
                         end
               end order by i)
        from jsonb_array_elements(putback || public.jarr(new.data->'trash')) with ordinality e(x, i)
    ), '[]'::jsonb));

  else   -- 'main': история склада
    plog := coalesce((select jsonb_object_agg(public.log_key(l), l)
                        from jsonb_array_elements(public.jarr(prev->'log')) l), '{}'::jsonb);
    nlog := coalesce((select jsonb_object_agg(public.log_key(x), true)
                        from jsonb_array_elements(public.jarr(new.data->'log')) x), '{}'::jsonb);
    ncnt := jsonb_array_length(public.jarr(new.data->'log'));

    -- Записи истории, которых в новой версии нет, и что с каждой:
    --   undone  — отменили сразу: запись свежая (10 минут) и по часам базы, и по
    --             своему времени. Старую запись «свежей» не сделать: время её
    --             появления (st) ставит база;
    --   evicted — вытеснили новые: в истории 400 записей новее, и все старше
    --             10 минут — их уже не отменить, они останутся. Записи, внесённые
    --             только что, в счёт не идут: иначе внёс 400, старое вытеснилось,
    --             а свои 400 «отменил сразу»;
    --   back    — телефон обрезал историю по краю (держит 400), а вытеснять ещё
    --             рано: база кладёт запись назад. История — 400 устоявшихся записей
    --             плюс внесённое за последние 10 минут;
    --   gone    — стёрли: продавцу отказ, хозяину строчка в ленте.
    with p as (
      select l, public.log_key(l) as k, i as pos, public.rec_time(l, cap) as eff
        from jsonb_array_elements(public.jarr(prev->'log')) with ordinality e(l, i)
    ),
    lim as (   -- что из прежней истории осталось: всё, что после него, — обрезанный край
      select max(pos) as maxpos, min(public.jnum(l->'t')) as mint from p where nlog ? k
    ),
    miss as (
      select p.l, p.pos, p.eff,
             nowms - p.eff < 600000 as young,
             ncnt >= 400 and (lim.maxpos is null or p.pos > lim.maxpos
                              or public.jnum(p.l->'t') < lim.mint) as tail
        from p, lim
       where not (nlog ? p.k)
    ),
    s as (     -- устоявшиеся записи (старше 10 минут), что остаются или могут остаться
      select eff from p where nlog ? k and nowms - eff >= 600000
      union all
      select eff from miss where tail and not young
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'l', m.l, 'pos', m.pos,
             'fate', case
                       when m.young and nowms - public.jnum(m.l->'t') < 600000 then 'undone'
                       when m.tail and not m.young and (select count(*) from s where s.eff > m.eff) >= 400 then 'evicted'
                       when m.tail then 'back'
                       else 'gone'
                     end,
             'own', coalesce(m.l->>'su' = me, m.l->'su' is null and coalesce(m.l->>'by', '') = who)
           ) order by m.pos), '[]'::jsonb)
      into outs
      from miss m;

    select count(*) into gone from jsonb_array_elements(outs) f where f->>'fate' = 'gone';
    if not boss and gone > 0 then raise exception 'log_vanished'; end if;
    if gone > 0 then
      insert into public.activity (txt) values ('стёр задним числом записи истории склада: ' || gone);
    end if;

    if not boss then
      -- Отменить сразу можно, но чужую запись — на виду у хозяина.
      select count(*) into other from jsonb_array_elements(outs) f
       where f->>'fate' = 'undone' and not (f->>'own')::boolean;
      if other > 0 then
        insert into public.activity (txt) values ('отменил чужие записи в истории склада: ' || other);
      end if;

      -- Остаток товара поменялся, а в истории за эту запись этого нет: продажа мимо
      -- истории. Не отказываем — слияние двух телефонов и возврат из корзины законно
      -- меняют остаток, — но хозяин увидит строчку в ленте.
      if tg_op = 'UPDATE' then
        with moves as (   -- что внесли в историю этой записью: новые записи и отменённые
          select x->>'id' as id, public.log_effect(x) as d
            from jsonb_array_elements(public.jarr(new.data->'log')) x
           where not (plog ? public.log_key(x))
          union all
          select f->'l'->>'id', -public.log_effect(f->'l')
            from jsonb_array_elements(outs) f where f->>'fate' = 'undone'
        ),
        logged as (select id, sum(d) as d from moves where id is not null group by id),
        was as (select i->>'id' as id, i from jsonb_array_elements(public.jarr(prev->'items')) i
                 where i->>'id' is not null),
        binned as (   -- удалённые товары: вернувшийся из корзины приходит со своим остатком
          select e->'item'->>'id' as id, e->'item' as i from jsonb_array_elements(public.jarr(prev->'trash')) e
           where e->>'k' = 'item' and e->'item'->>'id' is not null
        ),
        cur as (select i->>'id' as id, i from jsonb_array_elements(public.jarr(new.data->'items')) i
                 where i->>'id' is not null),
        newbin as (select e->'item'->>'id' as id from jsonb_array_elements(public.jarr(new.data->'trash')) e
                    where e->>'k' = 'item'),
        diff as (   -- было → стало у каждого товара, что есть или был на складе
          select coalesce(c.i->>'name', w.i->>'name', '') as name,
                 case when w.id is not null then public.jnum(w.i->'qty')
                      else coalesce((select public.jnum(b.i->'qty') from binned b where b.id = c.id limit 1), 0) end as q0,
                 case when c.id is not null then public.jnum(c.i->'qty') else 0 end as q1,
                 coalesce((select g.d from logged g where g.id = coalesce(c.id, w.id)), 0) as dl
            from cur c full join was w on w.id = c.id
           where c.id is not null or not exists (select 1 from newbin nb where nb.id = w.id)
          union all
          -- товар с остатком ушёл из корзины склада, но не вернулся на склад: иначе
          -- «удалить товар» и следом «убрать из корзины» — остаток пропал бы молча
          select coalesce(b.i->>'name', ''), public.jnum(b.i->'qty'), 0,
                 coalesce((select g.d from logged g where g.id = b.id), 0)
            from binned b
           where not exists (select 1 from newbin nb where nb.id = b.id)
             and not exists (select 1 from cur c where c.id = b.id)
             and not exists (select 1 from was w where w.id = b.id)
        )
        select count(*), string_agg(case when rn <= 3 then format('«%s» %s → %s', name, q0, q1) end, ', ')
          into other, odd
          from (select diff.*, row_number() over (order by name) as rn
                  from diff where abs(q1 - q0 - dl) > 0.000001) z;
        if other > 0 then
          insert into public.activity (txt) values ('остаток изменился без записи в истории: ' || odd
            || case when other > 3 then ' и ещё ' || (other - 3) else '' end);
        end if;
      end if;
    end if;

    -- Ушедшее из истории — в архив: отменённое, вытесненное, стёртое хозяином.
    insert into public.docs_archive (t, doc, why, "by", uid, rec)
      select nowms, 'main', case f->>'fate' when 'gone' then 'removed' else f->>'fate' end, who, me, f->'l'
        from jsonb_array_elements(outs) f
       where f->>'fate' in ('undone', 'evicted', 'gone')
       order by (f->>'pos')::bigint;

    -- Обрезанное, что вытеснять рано, — назад, в конец (там самое старое).
    putback := coalesce((select jsonb_agg(f->'l' order by (f->>'pos')::bigint)
                           from jsonb_array_elements(outs) f where f->>'fate' = 'back'), '[]'::jsonb);

    new.data := jsonb_set(new.data, '{log}', coalesce((
      select jsonb_agg(public.stamp_rec(public.sign_rec(x, plog -> public.log_key(x), who, null),
                                        plog -> public.log_key(x), nowms, me) order by i)
        from jsonb_array_elements(public.jarr(new.data->'log') || putback) with ordinality e(x, i)
    ), '[]'::jsonb));
  end if;

  return new;
end $$;

drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs
  for each row execute function public.docs_guard();

-- ---------- Удаление своего аккаунта ----------
-- Хозяину нельзя: лавка осталась бы без хозяина.
-- Заблокированному тоже: удалил бы аккаунт, вошёл тем же Google заново —
-- и снова стоял бы в очереди «ждут подтверждения», как новенький.
-- Заблокированному покупателю — так же: раньше смотрели только на команду, и
-- покупатель уходил и регистрировался заново.
create or replace function public.delete_my_account() returns void
  language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); blocked boolean := false;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.staff where uid = me and owner) then
    raise exception 'owner_cannot_delete';
  end if;
  if exists (select 1 from public.staff where uid = me and status = 'blocked') then
    raise exception 'blocked_cannot_delete';
  end if;
  -- Покупатели (public.customers) есть только на своём сервере — её создаёт
  -- server/after.sql, в Supabase её нет. Поэтому спрашиваем отдельной командой.
  if to_regclass('public.customers') is not null then
    execute 'select exists (select 1 from public.customers where uid = $1 and status = ''blocked'')'
      into blocked using me;
    if blocked then raise exception 'blocked_cannot_delete'; end if;
  end if;
  delete from public.staff where uid = me;
  delete from auth.users where id = me;
end $$;

-- ---------- Права доступа ----------

alter table public.docs     enable row level security;
alter table public.staff    enable row level security;
alter table public.activity enable row level security;
alter table public.settings enable row level security;   -- и без единого правила: закрыто для всех
alter table public.docs_archive enable row level security;

drop policy if exists docs_archive_read on public.docs_archive;
-- Архив ушедшего читает только хозяин. Правил на запись нет: пишет туда только
-- охрана документов (docs_guard), исправить или стереть его через программу нельзя.
create policy docs_archive_read on public.docs_archive for select using (public.is_owner());

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
-- Закупочные цены лежат отдельным документом 'costs' — его читает и пишет только хозяин.
-- В самом складе их держать нельзя: склад уходит каждому продавцу целиком, и продавец
-- может скачать его резервной копией. Живые обновления идут через эти же правила.
create policy docs_read   on public.docs for select
  using (public.is_active() and (id <> 'costs' or public.is_owner()));
create policy docs_insert on public.docs for insert
  with check (public.is_active() and (id <> 'costs' or public.is_owner()));
create policy docs_update on public.docs for update
  using (public.is_active() and (id <> 'costs' or public.is_owner()))
  with check (public.is_active() and (id <> 'costs' or public.is_owner()));

-- Свою строку видно всегда — иначе не показать экран «ожидайте подтверждения».
create policy staff_read   on public.staff for select using (uid = auth.uid() or public.is_active());
create policy staff_insert on public.staff for insert with check (uid = auth.uid());
create policy staff_update on public.staff for update using (uid = auth.uid() or public.is_owner())
  with check (uid = auth.uid() or public.is_owner());
-- Удалять строки сотрудников через программу нельзя никому. Раньше было можно
-- удалить свою: заблокированный так возвращался в очередь, а хозяин мог
-- нечаянно освободить своё место. Уйти совсем — только через delete_my_account.

-- Лента: читают и пишут подтверждённые. Исправить или стереть запись нельзя.
create policy activity_read  on public.activity for select using (public.is_active());
create policy activity_write on public.activity for insert with check (public.is_active());

-- Supabase сам выдаёт anon и authenticated право вызывать любую функцию в public,
-- поэтому «from public» здесь мало: отбираем у этих ролей поимённо.
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
revoke all on function public.doc_set(text, jsonb, bigint) from public, anon;
grant execute on function public.doc_set(text, jsonb, bigint) to authenticated;
revoke all on function public.may_claim_owner(uuid) from public, anon, authenticated;
-- «Кто я такой» нужен вошедшим: на нём стоят правила доступа, а программа
-- спрашивает, хозяин ли она. Без входа спрашивать незачем.
revoke all on function public.is_active() from public, anon;
revoke all on function public.is_owner()  from public, anon;
grant execute on function public.is_active() to authenticated;
grant execute on function public.is_owner()  to authenticated;
-- Охранники срабатывают сами, при записи в таблицу. Вызывать их руками не нужно никому.
revoke all on function public.staff_guard()    from public, anon, authenticated;
revoke all on function public.activity_guard() from public, anon, authenticated;
revoke all on function public.docs_guard()     from public, anon, authenticated;
-- Помощники охраны долгов: снаружи их вызывать незачем.
revoke all on function public.jarr(jsonb)                       from public, anon, authenticated;
revoke all on function public.jnum(jsonb)                       from public, anon, authenticated;
revoke all on function public.debt_recs(jsonb)                  from public, anon, authenticated;
revoke all on function public.debt_same(jsonb, jsonb)           from public, anon, authenticated;
revoke all on function public.log_key(jsonb)                    from public, anon, authenticated;
revoke all on function public.sign_rec(jsonb, jsonb, text, bigint) from public, anon, authenticated;
revoke all on function public.trash_recs(jsonb)                 from public, anon, authenticated;
revoke all on function public.rec_time(jsonb, numeric)          from public, anon, authenticated;
revoke all on function public.stamp_rec(jsonb, jsonb, bigint, text) from public, anon, authenticated;
revoke all on function public.log_effect(jsonb)                 from public, anon, authenticated;

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
