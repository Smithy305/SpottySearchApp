-- SpottySearch — Phase 6 SQL (feedback round, July 2026)
-- Run in the Supabase SQL Editor after phase5.sql. Safe to re-run.
--
-- What this adds:
--   1. pieces.chased_at — when a reminder ("chaser") email was last sent
--      from the admin page, so the dashboard can show it and the owner
--      doesn't double-chase.
--   2. admin_dashboard() updated:
--        - stale_days now defaults to 61 (~2 months), matching the
--          collect-by promise in the customer emails ("we can only keep
--          pieces for 2 months after your visit"). It used to be 28.
--        - the stale list includes chased_at.
--
-- ⚠ After running this, deploy the new edge function (JWT verification ON,
--   i.e. WITHOUT --no-verify-jwt):
--     supabase functions deploy send-chaser

-- 1. When was this piece last chased? -----------------------------------------
alter table pieces add column if not exists chased_at timestamptz;

-- 2. admin_dashboard: 2-month stale window + chased_at in the stale list ------
create or replace function admin_dashboard(stale_days int default 61)
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
      p.created_at, p.status, p.photo_path, p.chased_at,
      (p.contact_email is not null or p.contact_phone is not null) as has_contact,
      (p.contact_email is not null)                                as has_email,
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
