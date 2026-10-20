-- SpottySearch — Phase 7 SQL (Oct 2026): editable entries + notes
-- Run in the Supabase SQL Editor after phase6.sql. Safe to re-run.
--
-- What this adds:
--   1. pieces.notes — free-text note/description per entry (max 500 chars).
--   2. pieces.edited_at / edited_by — who last corrected an entry.
--   3. Length checks on customer_name / notes (the app also enforces these).
--   4. match_pieces: returns notes, and pieces whose NOTES share words with
--      the description get a small ranking boost (on top of the notes being
--      folded into the embedding by the edge functions). Pieces not yet
--      captioned can now be found by their notes alone.
--
-- ⚠ match_pieces' signature changes, so after running this you MUST redeploy
--   search-pieces (and the other functions — see SETUP-PHASE7.md).
-- ⚠ Run this BEFORE deploying the app: the app now saves a notes column.

-- 1–2. Columns ------------------------------------------------------------------
alter table pieces add column if not exists notes     text;
alter table pieces add column if not exists edited_at timestamptz;
alter table pieces add column if not exists edited_by uuid references auth.users (id);

-- 3. Sanity checks (NOT VALID = enforced for new writes, old rows untouched) -----
alter table pieces drop constraint if exists pieces_notes_len;
alter table pieces add constraint pieces_notes_len
  check (notes is null or char_length(notes) <= 500) not valid;

alter table pieces drop constraint if exists pieces_customer_name_len;
alter table pieces add constraint pieces_customer_name_len
  check (char_length(btrim(customer_name)) between 1 and 80) not valid;

-- Full-text index for the notes keyword boost.
create index if not exists pieces_notes_fts_idx
  on pieces using gin (to_tsvector('english', coalesce(notes, '')));

-- 4. match_pieces with notes ---------------------------------------------------------
drop function if exists match_pieces(vector, timestamptz, timestamptz, int, text, text);
drop function if exists match_pieces(vector, timestamptz, timestamptz, int, text, text, text);

create or replace function match_pieces(
  query_embedding vector(384),
  from_date timestamptz,
  to_date   timestamptz,
  max_results int default 12,
  name_filter text default null,
  status_filter text default 'not_collected',
  query_text text default null   -- the raw description, for the notes keyword boost
)
returns table (
  id uuid,
  photo_path text,
  customer_name text,
  item_count int,
  caption text,
  notes text,
  status text,
  created_at timestamptz,
  created_by uuid,
  ready_by uuid,
  collected_by uuid,
  similarity float
)
language sql stable
as $$
  with q as (
    -- Any-word match: plainto_tsquery ANDs the words, so turn & into |.
    -- (A description of only stop-words gives an empty query → no boost.)
    select case when coalesce(btrim(query_text), '') = '' then null
           else nullif(
             replace(plainto_tsquery('english', query_text)::text, ' & ', ' | '),
             ''
           )::tsquery end as tsq
  ),
  scored as (
    select
      p.*,
      case when p.embedding is null then 0
           else 1 - (p.embedding <=> query_embedding) end as sim,
      (q.tsq is not null
        and to_tsvector('english', coalesce(p.notes, '')) @@ q.tsq) as note_hit
    from pieces p, q
    where p.created_at >= from_date
      and p.created_at <  to_date
      and (name_filter is null or p.customer_name ilike '%' || name_filter || '%')
      and (
        status_filter is null
        or (status_filter = 'not_collected' and p.status <> 'collected')
        or p.status = status_filter
      )
  )
  select
    s.id, s.photo_path, s.customer_name, s.item_count, s.caption, s.notes,
    s.status, s.created_at, s.created_by, s.ready_by, s.collected_by,
    s.sim as similarity
  from scored s
  where s.embedding is not null or s.note_hit
  -- Notes keyword hit = +0.08, roughly the gap between a good and a so-so
  -- caption match with gte-small. Tweak here if notes dominate / vanish.
  order by s.sim + case when s.note_hit then 0.08 else 0 end desc
  limit max_results
$$;
