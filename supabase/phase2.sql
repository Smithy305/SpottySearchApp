-- SpottySearch — Phase 2 SQL
-- Run in the Supabase SQL Editor after schema.sql. Safe to re-run.

-- Piece lifecycle: awaiting (painted) → ready (fired in kiln) → collected.
-- ready_at is the Phase 3 trigger point for the "your pottery is ready" text/email.
alter table pieces drop constraint if exists pieces_status_check;
alter table pieces add constraint pieces_status_check
  check (status in ('awaiting', 'ready', 'collected'));
alter table pieces add column if not exists ready_at timestamptz;

-- Clean up the earlier signature if it was deployed.
drop function if exists match_pieces(vector, timestamptz, timestamptz, int, boolean);

-- Similarity search. SECURITY INVOKER (the default) means the caller's
-- row-level security applies, so results are automatically scoped to the
-- worker's own shop.
--   name_filter:   optional substring match on customer name
--   status_filter: 'awaiting' | 'ready' | 'collected' | 'not_collected' | null (any)
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
  similarity float
)
language sql stable
as $$
  select
    p.id, p.photo_path, p.customer_name, p.item_count, p.caption,
    p.status, p.created_at,
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

-- Vector index. Overkill at café volume (search is instant without it),
-- but harmless and future-proof.
create index if not exists pieces_embedding_idx
  on pieces using hnsw (embedding vector_cosine_ops);
