-- SpottySearch — Phase 1 schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Includes Phase 2 columns (caption/embedding) now so no migration is needed later.

-- Extensions ----------------------------------------------------------------
create extension if not exists vector;

-- Tables ---------------------------------------------------------------------
create table if not exists shops (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  square_location_id  text,
  created_at          timestamptz not null default now()
);

create table if not exists profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  shop_id      uuid not null references shops (id),
  display_name text not null,
  role         text not null default 'worker' check (role in ('worker', 'admin')),
  created_at   timestamptz not null default now()
);

create table if not exists pieces (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references shops (id),
  created_by     uuid not null references auth.users (id),
  photo_path     text not null,            -- path inside the 'pottery-photos' bucket
  customer_name  text not null,
  item_count     int  not null check (item_count between 1 and 100),
  caption        text,                     -- Phase 2: vision-API caption
  embedding      vector(384),              -- Phase 2: caption embedding
  contact_email  text,                     -- Phase 3: from Square
  contact_phone  text,                     -- Phase 3: from Square
  -- lifecycle: awaiting (painted) → ready (fired) → collected
  status         text not null default 'awaiting' check (status in ('awaiting', 'ready', 'collected')),
  created_at     timestamptz not null default now(),
  ready_at       timestamptz,
  collected_at   timestamptz
);

create index if not exists pieces_shop_date_idx on pieces (shop_id, created_at desc);
create index if not exists pieces_status_idx    on pieces (shop_id, status);

create table if not exists search_logs (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references shops (id),
  query_text        text not null,
  selected_piece_id uuid references pieces (id),
  result_rank       int,
  created_at        timestamptz not null default now()
);

-- Helper: the calling user's shop --------------------------------------------
create or replace function my_shop_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select shop_id from profiles where user_id = auth.uid()
$$;

-- Row-level security ----------------------------------------------------------
alter table shops       enable row level security;
alter table profiles    enable row level security;
alter table pieces      enable row level security;
alter table search_logs enable row level security;

-- Workers can see their own shop and profile.
create policy "read own shop"    on shops    for select using (id = my_shop_id());
create policy "read own profile" on profiles for select using (user_id = auth.uid());

-- Pieces: full access within your own shop only.
create policy "read shop pieces"   on pieces for select using (shop_id = my_shop_id());
create policy "insert shop pieces" on pieces for insert
  with check (shop_id = my_shop_id() and created_by = auth.uid());
create policy "update shop pieces" on pieces for update
  using (shop_id = my_shop_id()) with check (shop_id = my_shop_id());

-- Search logs: same per-shop rule (used in Phase 2).
create policy "read shop logs"   on search_logs for select using (shop_id = my_shop_id());
create policy "insert shop logs" on search_logs for insert with check (shop_id = my_shop_id());

-- Storage bucket for photos ----------------------------------------------------
insert into storage.buckets (id, name, public)
values ('pottery-photos', 'pottery-photos', false)
on conflict (id) do nothing;

-- Photos live at <shop_id>/<uuid>.jpg; workers only touch their shop's folder.
create policy "upload shop photos" on storage.objects for insert
  with check (
    bucket_id = 'pottery-photos'
    and (storage.foldername(name))[1] = my_shop_id()::text
  );

create policy "read shop photos" on storage.objects for select
  using (
    bucket_id = 'pottery-photos'
    and (storage.foldername(name))[1] = my_shop_id()::text
  );

-- Seed the first shop -----------------------------------------------------------
insert into shops (name) values ('Spotty Pots')
on conflict do nothing;

-- After running this file:
-- 1. Note the shop id:        select id, name from shops;
-- 2. Create workers in Dashboard → Authentication → Users → Add user.
-- 3. Link each worker to the shop:
--    insert into profiles (user_id, shop_id, display_name)
--    values ('<user-uuid>', '<shop-uuid>', 'Worker name');
