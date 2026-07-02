# SpottySearch — Build Plan

Replace the WhatsApp workflow at Spotty Pots with two things:

1. **Logging app (PWA)** — workers photograph a painted piece, enter customer name + item count. Date logged automatically.
2. **Search site** — when a customer collects, the worker types their description ("white mug with a caterpillar"), gets photos from that day ranked by match, marks the piece as collected. Each confirmed pick becomes labelled training data.

Principle: KISS. One form, one search box.

---

## Architecture

```
Worker phone (PWA)                    Front-of-house (search site)
  photo + name + count                  description query
        │                                     │
        ▼                                     ▼
┌─────────────────────── Supabase ───────────────────────┐
│  Auth (workers, per-shop)                               │
│  Storage (photos)                                       │
│  Postgres + pgvector (pieces, embeddings, shops, users) │
│  Edge Functions:                                        │
│    on upload → caption photo (vision API)               │
│              → embed caption → store vector             │
│    on search → embed query → cosine rank                │
│    nightly   → Square API: match name+date → contact    │
└─────────────────────────────────────────────────────────┘
```

**Why this shape:**

- **PWA, not Electron.** Electron is desktop-only. A PWA is one HTML/CSS/JS codebase that runs on both iPhone and Android, gets camera access through the browser, installs to the home screen, and needs no app store.
- **Supabase** gives auth, Postgres, file storage, and pgvector (vector similarity search) in one free-tier-friendly service. Row-level security handles the per-shop isolation for shop #2 later.
- **Caption search won your evaluation** (recall@3 0.80 vs 0.65, median rank 1 vs 2). So production uses the caption route: caption once at upload, embed, and search is then just text-vs-text — no GPU server. A vision API call (e.g. Claude Haiku / GPT-4o-mini) replaces local Qwen-VL; reuse your existing captioning prompt. Cost ≈ fractions of a penny per photo.
- **CLIP route** is dropped for v1; score fusion can come later if caption search ever struggles.

## Data model

```sql
shops    id, name, square_location_id, created_at
profiles user_id (auth), shop_id, display_name, role
pieces   id, shop_id, created_by (user_id),
         photo_url, customer_name, item_count,
         caption (text), embedding vector(384),
         contact_email, contact_phone,        -- from Square, nullable
         status ('awaiting' | 'collected'),
         created_at, collected_at
search_logs  id, shop_id, query_text, selected_piece_id,
             result_rank, created_at          -- labelled data
```

Covers everything requested: picture, item count, name, date, shopID, userID, email/phone — plus status and the labelled-data log.

## Worker logging app (PWA)

- Login (Supabase email/password per worker; their profile carries shop_id).
- One screen: camera capture → name field → item count stepper → Save.
- Photo is resized client-side (~1280px) before upload to keep storage and caption costs down.
- Offline tolerance: if signal is poor in the shop, queue the entry locally and retry.
- On save, an edge function captions the photo and stores the embedding. Worker never waits on this — it's async.

## Search site (HTML/CSS/JS)

- Same login system; results scoped to the worker's shop.
- Defaults to **today's** pieces with status 'awaiting'; date picker to widen.
- Query → embed → pgvector cosine similarity → photo grid, best match first.
- Worker taps the right photo → confirm screen → marks 'collected', logs (query, piece, rank) to `search_logs`.
- Styling: Spotty Pots blue/red as accents on a clean neutral base — related, but its own thing.

## Square enrichment

**Do not use the till login.** Square has a developer dashboard (developer.squareup.com) — log in there with the same account, create an app, and use its **access token**. Safer and revocable.

- Nightly (or on-demand) job pulls the day's Payments/Orders + Customers for the shop's `square_location_id`.
- Fuzzy-match customer name (case/spelling tolerant) within ±1 day of the photo → attach email/phone to the piece.
- Unmatched pieces just stay null — enrichment is best-effort, never blocking. Ambiguous matches (two Sarahs same day) are skipped rather than guessed.
- First step when ready: verify mom's credentials in the developer dashboard and check the till actually stores customer contact details (it only does if receipts are emailed/texted or a customer profile is created).

## Phases

**Phase 1 — Logging MVP (start here).**
Supabase project, schema, auth; PWA with photo + name + count; entries visible in a plain list. *Done when a worker can log a piece from their phone and you can see it in the database.* This already beats WhatsApp.

**Phase 2 — Search.**
Caption + embedding edge function (port your Qwen prompt to the vision API; sentence embedding equivalent to all-MiniLM); search page with ranked grid; collected flow + search_logs. *Done when a described pot from today appears top-3 — your benchmark says expect ~80%.*

**Phase 3 — Square.**
Developer token, nightly matcher, contact fields shown on the piece record. *Done when a logged piece picks up an email/phone automatically.*

**Phase 4 — Polish & shop #2.**
Per-shop row-level security verified end-to-end, second shop row, admin view for mom (uncollected pieces older than X weeks), backups.

## Costs (rough)

Supabase free tier to start (~£20/mo if photos grow); vision API captions well under £1/mo at café volume; domain ~£10/yr. No GPU, no app store fees.

## Risks / open questions

- **Square data may be sparse** — contacts only exist when customers opt into digital receipts. Check real data before building Phase 3.
- **Cluttered photos** polluted captions in your eval (one piece fell to rank 26). Mitigate at the source: the app shows a framing guide ("fill the frame with the pottery"), and the caption prompt says to ignore background.
- **Same-name collisions** on busy days — date filter + photo grid makes this a non-issue in practice.
- **GDPR**: storing names/emails/phones means a simple retention rule, e.g. delete or anonymise entries N months after collection.
