-- SpottySearch — end-to-end row-level-security test
-- Paste the WHOLE file into the Supabase SQL Editor and Run.
--
-- It seeds two shops, two workers and one owner, then *becomes* each of them
-- (via the same JWT claims the real API uses) and checks who can see what.
-- Everything runs inside a transaction that ROLLS BACK at the end, so it
-- leaves no trace in your database.
--
-- Expected output: a series of "PASS: ..." notices and no error.
-- Any "FAIL" raises an exception (which also aborts + rolls back the test).

begin;

-- Make sure the API role can reach the tables (RLS still filters the rows).
-- These grants roll back with the transaction.
grant select on shops, pieces, search_logs to authenticated;

-- --- Seed (as the privileged editor role) -----------------------------------
-- Fixed UUIDs so the assertions can reference them.
--   shop A = 111…  shop B = 222…
--   worker A = aaa…  worker B = bbb…  owner = ccc…
insert into auth.users (instance_id, id, aud, role, email,
                        raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','authenticated','authenticated','rls-worker-a@example.com','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','authenticated','authenticated','rls-worker-b@example.com','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','cccccccc-cccc-cccc-cccc-cccccccccccc','authenticated','authenticated','rls-owner@example.com','{}','{}',now(),now());

insert into shops (id, name, owner_id, join_code) values
  ('11111111-1111-1111-1111-111111111111','RLS Test Shop A','cccccccc-cccc-cccc-cccc-cccccccccccc','RLSTSA'),
  ('22222222-2222-2222-2222-222222222222','RLS Test Shop B','cccccccc-cccc-cccc-cccc-cccccccccccc','RLSTSB');

insert into profiles (user_id, shop_id, display_name, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','Worker A','worker'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222','Worker B','worker'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','11111111-1111-1111-1111-111111111111','Owner Mom','admin');

insert into pieces (shop_id, created_by, photo_path, customer_name, item_count) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111/a.jpg','Cust A',1),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222/b.jpg','Cust B',1);

insert into storage.objects (bucket_id, name) values
  ('pottery-photos','11111111-1111-1111-1111-111111111111/a.jpg'),
  ('pottery-photos','22222222-2222-2222-2222-222222222222/b.jpg');

-- --- Become worker A --------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';

do $$
begin
  if (select count(*) from pieces) <> 1 then
    raise exception 'FAIL: worker A should see exactly 1 piece, saw %', (select count(*) from pieces);
  end if;
  if exists (select 1 from pieces where shop_id = '22222222-2222-2222-2222-222222222222') then
    raise exception 'FAIL: worker A can see shop B pieces';
  end if;
  if (select count(*) from shops) <> 1 then
    raise exception 'FAIL: worker A should see only their own shop row';
  end if;
  if (select count(*) from storage.objects
        where bucket_id = 'pottery-photos'
          and (storage.foldername(name))[1] = '22222222-2222-2222-2222-222222222222') <> 0 then
    raise exception 'FAIL: worker A can see shop B photos in storage';
  end if;
  raise notice 'PASS: worker A sees only shop A (pieces, shop row, photos)';
end $$;

do $$
begin
  perform admin_dashboard();
  raise exception 'FAIL: a worker was allowed to call admin_dashboard()';
exception
  when insufficient_privilege then
    raise notice 'PASS: worker A is blocked from admin_dashboard()';
end $$;

-- --- Become worker B --------------------------------------------------------
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';

do $$
begin
  if (select count(*) from pieces) <> 1 then
    raise exception 'FAIL: worker B should see exactly 1 piece, saw %', (select count(*) from pieces);
  end if;
  if exists (select 1 from pieces where shop_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL: worker B can see shop A pieces';
  end if;
  raise notice 'PASS: worker B sees only shop B';
end $$;

-- --- Become the owner (admin over both shops) -------------------------------
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';

do $$
declare
  d jsonb;
begin
  if (select count(*) from pieces) <> 2 then
    raise exception 'FAIL: owner should see both shops'' pieces (2), saw %', (select count(*) from pieces);
  end if;
  if (select count(*) from shops) <> 2 then
    raise exception 'FAIL: owner should see both shop rows';
  end if;
  if (select count(*) from storage.objects where bucket_id = 'pottery-photos') < 2 then
    raise exception 'FAIL: owner should see photos in both shop folders';
  end if;
  raise notice 'PASS: owner sees both shops (pieces, shop rows, photos)';

  d := admin_dashboard();
  if jsonb_array_length(d -> 'shops') <> 2 then
    raise exception 'FAIL: admin_dashboard() should report 2 shops, reported %', jsonb_array_length(d -> 'shops');
  end if;
  raise notice 'PASS: admin_dashboard() returns both shops for the owner';
end $$;

-- Done — undo everything.
rollback;

-- If you saw only PASS notices above and no error, per-shop isolation,
-- owner cross-shop access, and admin-only dashboard access all hold.
