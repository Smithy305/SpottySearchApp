-- SpottySearch — Phase 5 SQL (shop feedback, July 2026)
-- Run in the Supabase SQL Editor after phase4.sql. Safe to re-run.
--
-- What this adds:
--   1. Workers can read the profiles of colleagues in their own shop (and
--      owners those of shops they own) — needed to show who logged a piece.
--   2. ready_by / collected_by on pieces — who fired / handed over each piece.
--   3. shops.email_promo — owner-editable marketing line appended to the
--      "ready to collect" email (edited from the admin page).
--   4. Admins/owners can update their shop row (for email_promo).
--   5. match_pieces returns the worker ids; the edge function maps them to
--      display names for the UI.
--
-- ⚠ The match_pieces return type changes, so after running this you MUST
--   redeploy the search-pieces edge function (same lesson as last time):
--     supabase functions deploy search-pieces

-- 1. Same-shop profile visibility --------------------------------------------
drop policy if exists "read shop profiles"  on profiles;
drop policy if exists "owner read profiles" on profiles;

create policy "read shop profiles" on profiles for select
  using (shop_id = my_shop_id());

create policy "owner read profiles" on profiles for select
  using (shop_id in (select my_owned_shop_ids()));

-- 2. Who fired / handed over each piece ---------------------------------------
alter table pieces add column if not exists ready_by     uuid references auth.users (id);
alter table pieces add column if not exists collected_by uuid references auth.users (id);

-- 3. Owner-editable marketing line + optional image for the ready email --------
alter table shops add column if not exists email_promo text;
alter table shops add column if not exists email_promo_image text; -- path in promo-images bucket

-- Public bucket: email clients must be able to load the image with a plain URL.
-- (Nothing sensitive lives here — it's marketing material.)
insert into storage.buckets (id, name, public)
values ('promo-images', 'promo-images', true)
on conflict (id) do nothing;

-- Only a shop's admin/owner can put files in that shop's folder.
drop policy if exists "promo image write"  on storage.objects;
drop policy if exists "promo image delete" on storage.objects;

create policy "promo image write" on storage.objects for insert
  with check (
    bucket_id = 'promo-images'
    and (
      ((storage.foldername(name))[1] = my_shop_id()::text
        and exists (select 1 from profiles where user_id = auth.uid() and role = 'admin'))
      or (storage.foldername(name))[1] in (select id::text from shops where owner_id = auth.uid())
    )
  );

create policy "promo image delete" on storage.objects for delete
  using (
    bucket_id = 'promo-images'
    and (
      ((storage.foldername(name))[1] = my_shop_id()::text
        and exists (select 1 from profiles where user_id = auth.uid() and role = 'admin'))
      or (storage.foldername(name))[1] in (select id::text from shops where owner_id = auth.uid())
    )
  );

-- 4. Admins/owners can update their shop --------------------------------------
drop policy if exists "owner update shops" on shops;
drop policy if exists "admin update own shop" on shops;

create policy "owner update shops" on shops for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- A single-shop admin (before owner_id is set) can update their own shop too.
create policy "admin update own shop" on shops for update
  using (
    id = my_shop_id()
    and exists (select 1 from profiles where user_id = auth.uid() and role = 'admin')
  )
  with check (
    id = my_shop_id()
    and exists (select 1 from profiles where user_id = auth.uid() and role = 'admin')
  );

-- 5. match_pieces with worker ids ----------------------------------------------
-- Return type changes → drop first (create or replace can't change it).
drop function if exists match_pieces(vector, timestamptz, timestamptz, int, text, text);

create or replace function match_pieces(
  query_embedding vector(384),
  from_date timestamptz,
  to_date   timestamptz,
  max_results int default 12,
  name_filter text default null,
  status_filter text default 'not_collected'
)
returns table (
  id uuid,
  photo_path text,
  customer_name text,
  item_count int,
  caption text,
  status text,
  created_at timestamptz,
  created_by uuid,
  ready_by uuid,
  collected_by uuid,
  similarity float
)
language sql stable
as $$
  select
    p.id, p.photo_path, p.customer_name, p.item_count, p.caption,
    p.status, p.created_at,
    p.created_by, p.ready_by, p.collected_by,
    1 - (p.embedding <=> query_embedding) as similarity
  from pieces p
  where p.embedding is not null
    and p.created_at >= from_date
    and p.created_at <  to_date
    and (name_filter is null or p.customer_name ilike '%' || name_filter || '%')
    and (
      status_filter is null
      or (status_filter = 'not_collected' and p.status <> 'collected')
      or p.status = status_filter
    )
  order by p.embedding <=> query_embedding
  limit max_results
$$;
