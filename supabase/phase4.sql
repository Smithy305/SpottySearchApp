-- SpottySearch — Phase 4 SQL (multi-shop polish, owner dashboard, GDPR retention)
-- Run in the Supabase SQL Editor after schema.sql / phase2.sql / phase3.sql.
-- Safe to re-run.
--
-- What this adds:
--   1. Shop ownership so one owner (mom) can oversee several shops, while
--      workers stay strictly scoped to their own shop (RLS unchanged for them).
--   2. admin_dashboard() — one call returns every number the owner page shows.
--   3. anonymise_old_pieces() — GDPR retention: 6 months after collection,
--      strip personal data but keep the photo + caption (your training data).
--   4. A pg_cron schedule for that retention job.
--   5. A template for adding shop #2.

-- ===========================================================================
-- 1. Ownership
-- ===========================================================================
-- An owner can be set on any number of shops. Nullable: existing single-shop
-- installs keep working with owner_id left blank.
alter table shops add column if not exists owner_id uuid references auth.users (id);
create index if not exists shops_owner_idx on shops (owner_id);

-- The shops the calling user owns (empty for ordinary workers).
-- SECURITY DEFINER so it can read shops regardless of the caller's own RLS.
create or replace function my_owned_shop_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select id from shops where owner_id = auth.uid()
$$;

grant execute on function my_owned_shop_ids() to authenticated;

-- ===========================================================================
-- 2. Owner-scoped RLS (added alongside the existing per-shop worker policies).
--    Postgres ORs permissive policies together, so workers are unaffected:
--    a non-owner's owned-shop set is empty and these policies grant nothing.
-- ===========================================================================
drop policy if exists "owner read shops"   on shops;
drop policy if exists "owner read pieces"   on pieces;
drop policy if exists "owner update pieces" on pieces;
drop policy if exists "owner read logs"     on search_logs;

create policy "owner read shops" on shops for select
  using (owner_id = auth.uid());

create policy "owner read pieces" on pieces for select
  using (shop_id in (select my_owned_shop_ids()));

-- Lets the owner act on a piece from the dashboard (e.g. mark collected)
-- in any shop they own.
create policy "owner update pieces" on pieces for update
  using (shop_id in (select my_owned_shop_ids()))
  with check (shop_id in (select my_owned_shop_ids()));

create policy "owner read logs" on search_logs for select
  using (shop_id in (select my_owned_shop_ids()));

-- Storage: the owner can read photo thumbnails in every owned shop's folder.
drop policy if exists "owner read photos" on storage.objects;
create policy "owner read photos" on storage.objects for select
  using (
    bucket_id = 'pottery-photos'
    and (storage.foldername(name))[1] in (
      select id::text from shops where owner_id = auth.uid()
    )
  );

-- ===========================================================================
-- 3. Owner dashboard — one round-trip returns everything the page renders.
--    SECURITY DEFINER so it can aggregate cleanly, but it refuses anyone who
--    is not an admin, and only ever looks at shops the caller owns (plus their
--    own shop, so a single-shop admin works even before owner_id is set).
-- ===========================================================================
create or replace function admin_dashboard(stale_days int default 28)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role text;
  v_result jsonb;
begin
  select role into v_role from profiles where user_id = auth.uid();
  if v_role is distinct from 'admin' then
    raise exception 'Not authorised' using errcode = '42501';
  end if;

  with my_shops as (
    select id, name
    from shops
    where owner_id = auth.uid()
       or id = (select shop_id from profiles where user_id = auth.uid())
  ),
  per_shop as (
    select
      s.id   as shop_id,
      s.name as shop_name,
      count(p.*)                                                          as logged_total,
      count(p.*) filter (where p.created_at >= date_trunc('month', now())) as logged_month,
      count(p.*) filter (where p.status = 'awaiting')                     as awaiting,
      count(p.*) filter (where p.status = 'ready')                        as ready,
      count(p.*) filter (where p.status = 'collected')                    as collected,
      count(p.*) filter (where p.contact_email is not null
                           or p.contact_phone is not null)                as with_contact,
      count(p.*) filter (where p.status <> 'collected'
                           and p.created_at < now() - make_interval(days => stale_days)) as stale_count
    from my_shops s
    left join pieces p on p.shop_id = s.id
    group by s.id, s.name
    order by s.name
  ),
  searches as (
    select
      count(*)                                                  as total,
      count(*) filter (where created_at >= now() - interval '30 days') as last_30,
      count(*) filter (where result_rank is not null)          as ranked,
      count(*) filter (where result_rank between 1 and 3)      as top3
    from search_logs
    where shop_id in (select id from my_shops)
  ),
  daily as (
    select
      (p.created_at at time zone 'UTC')::date as day,
      s.name as shop_name,
      count(*) as n
    from pieces p
    join my_shops s on s.id = p.shop_id
    where p.created_at >= now() - interval '30 days'
    group by 1, 2
    order by 1
  ),
  stale as (
    select
      p.id, p.shop_id, s.name as shop_name, p.customer_name, p.item_count,
      p.created_at, p.status, p.photo_path,
      (p.contact_email is not null or p.contact_phone is not null) as has_contact,
      extract(day from now() - p.created_at)::int as days_waiting
    from pieces p
    join my_shops s on s.id = p.shop_id
    where p.status <> 'collected'
      and p.created_at < now() - make_interval(days => stale_days)
    order by p.created_at asc
    limit 200
  )
  select jsonb_build_object(
    'stale_days', stale_days,
    'shops',    coalesce((select jsonb_agg(to_jsonb(per_shop))  from per_shop),  '[]'::jsonb),
    'searches', coalesce((select to_jsonb(searches)            from searches), '{}'::jsonb),
    'daily',    coalesce((select jsonb_agg(to_jsonb(daily))     from daily),     '[]'::jsonb),
    'stale',    coalesce((select jsonb_agg(to_jsonb(stale))     from stale),     '[]'::jsonb)
  ) into v_result;

  return v_result;
end
$$;

grant execute on function admin_dashboard(int) to authenticated;

-- ===========================================================================
-- 4. GDPR retention — anonymise instead of delete, to keep labelled training
--    data. 6 months after a piece is collected, scrub the personal fields but
--    keep photo / caption / embedding. search_logs hold only pottery
--    descriptions, so they need no scrubbing.
-- ===========================================================================
create or replace function anonymise_old_pieces(older_than interval default interval '6 months')
returns int
language plpgsql security definer set search_path = public
as $$
declare
  n int;
begin
  update pieces
  set customer_name      = 'Anonymised',
      contact_email      = null,
      contact_phone      = null,
      square_customer_id = null
  where status = 'collected'
    and collected_at < now() - older_than
    and customer_name <> 'Anonymised';   -- idempotent: skip already-scrubbed rows
  get diagnostics n = row_count;
  return n;
end
$$;

-- Schedule it nightly with pg_cron.
-- First enable the extension once: Dashboard → Database → Extensions → pg_cron.
create extension if not exists pg_cron;

-- Re-runnable: clear any previous copy of this job, then (re)create it.
select cron.unschedule(jobid)
from cron.job
where jobname = 'spotty-anonymise-old-pieces';

select cron.schedule(
  'spotty-anonymise-old-pieces',
  '30 3 * * *',                         -- 03:30 nightly
  $$select anonymise_old_pieces()$$
);

-- ===========================================================================
-- 5. Adding shop #2  (uncomment, fill the blanks, run when ready)
-- ===========================================================================
-- -- a) Create the shop (its join_code is generated by registration.sql's defaults
-- --    when you re-run that file, or set one here):
-- insert into shops (name) values ('Spotty Pots — <branch name>')
-- on conflict do nothing;
--
-- -- b) Find mom's user id:   select user_id, display_name, role from profiles;
-- --    (or Dashboard → Authentication → Users)
--
-- -- c) Make mom the owner of BOTH shops and an admin:
-- update shops    set owner_id = '<mom-user-uuid>' where name like 'Spotty Pots%';
-- update profiles set role     = 'admin'           where user_id = '<mom-user-uuid>';
--
-- -- d) Make sure every shop has a join code, then read them out:
-- update shops set join_code = upper(substr(md5(random()::text), 1, 6)) where join_code is null;
-- select name, join_code from shops;
--    Give each shop's workers their own code — that's what scopes them to a shop.
