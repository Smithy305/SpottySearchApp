-- SpottySearch — worker self-registration via shop join code
-- Run in the Supabase SQL Editor. Safe to re-run.
--
-- Flow: a new worker registers in the app with a 6-character shop code.
-- The trigger below validates the code and creates their profile in the
-- right shop. No code → no account.

-- 1. Every shop gets a join code.
alter table shops add column if not exists join_code text;

update shops
set join_code = upper(substr(md5(random()::text), 1, 6))
where join_code is null;

alter table shops alter column join_code set not null;
create unique index if not exists shops_join_code_idx on shops (join_code);

-- See the code to give to workers:        select name, join_code from shops;
-- Rotate it (e.g. after a worker leaves):
--   update shops set join_code = upper(substr(md5(random()::text), 1, 6))
--   where name = 'Spotty Pots' returning join_code;

-- 2. Friendly pre-check used by the registration form (anonymous users may
--    call this; it reveals only whether a code is valid, never shop data).
create or replace function check_join_code(code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from shops where join_code = upper(trim(code)))
$$;

grant execute on function check_join_code(text) to anon, authenticated;

-- 3. The enforcement: on signup, create the worker's profile from the code.
--    Users created from the dashboard (no join_code metadata) are skipped,
--    so the manual flow from SETUP.md still works.
create or replace function handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  code text := new.raw_user_meta_data ->> 'join_code';
  target_shop uuid;
begin
  if code is null or trim(code) = '' then
    return new; -- dashboard-created user; profile added manually
  end if;

  select id into target_shop from shops where join_code = upper(trim(code));
  if target_shop is null then
    raise exception 'Invalid shop code';
  end if;

  insert into profiles (user_id, shop_id, display_name)
  values (
    new.id,
    target_shop,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(new.email, '@', 1)
    )
  );
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
