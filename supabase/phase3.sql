-- SpottySearch — Phase 3 SQL (Square enrichment + ready notifications)
-- Run in the Supabase SQL Editor. Safe to re-run.

-- Square linkage + notification bookkeeping.
alter table pieces add column if not exists square_customer_id text;
alter table pieces add column if not exists enrich_attempts int not null default 0;
alter table pieces add column if not exists notified_at timestamptz;

-- Fill in the shop's Square location (Square developer dashboard → Locations,
-- or GET /v2/locations — see SETUP-PHASE3.md):
--   update shops set square_location_id = 'L........' where name = 'Spotty Pots';
