# Phase 2 setup — description search

Prerequisite: Phase 1 live and logging pieces. About 30 minutes.

## 1. Run the Phase 2 SQL

Supabase Dashboard → SQL Editor → paste all of `supabase/phase2.sql` → Run.
(Adds the similarity-search function and a vector index.)

## 2. Get an Anthropic API key

1. Sign up at [console.anthropic.com](https://console.anthropic.com), add ~£5 of credit (will last months at café volume).
2. Create an API key (starts `sk-ant-`).

## 3. Deploy the two edge functions

Easiest is the [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase` on a Mac):

```bash
cd SpottySearch          # the folder containing supabase/
supabase login
supabase link --project-ref nlqwchmezqefygecayfm
supabase functions deploy search-pieces
supabase functions deploy caption-piece --no-verify-jwt
```

The `--no-verify-jwt` flag on caption-piece matters — it's called by a database webhook, not by logged-in workers, and is protected by a secret instead (next step).

(Alternative: Dashboard → Edge Functions → Deploy a new function → paste each `index.ts` via the inline editor. Untick "Verify JWT" for caption-piece only.)

## 4. Set the secrets

Dashboard → Edge Functions → Secrets (or Settings → Edge Functions):

- `ANTHROPIC_API_KEY` = your `sk-ant-...` key
- `CAPTION_SECRET` = any long random string (e.g. run `openssl rand -hex 24`). Save it — you need it twice more below.

## 5. Auto-caption new photos (database webhook)

Dashboard → Database → Webhooks → Create a new hook:

- Name: `caption-on-insert`
- Table: `pieces`, Events: **Insert** only
- Type: **Supabase Edge Function** → `caption-piece`
- HTTP Headers: add `x-caption-secret` = your CAPTION_SECRET value
- Timeout: 5000 ms is fine — the function keeps running after the webhook returns

## 6. Backfill existing photos

Caption everything already logged (processes 10 per call — repeat until `processed: 0`):

```bash
curl -X POST "https://nlqwchmezqefygecayfm.supabase.co/functions/v1/caption-piece" \
  -H "x-caption-secret: YOUR_CAPTION_SECRET" \
  -H "content-type: application/json" -d '{}'
```

## 7. Redeploy the app folder

Drag-and-drop `app/` onto the Netlify site again (it now includes `search.html`). On the till / front-of-house device, open **spottysearch.co.uk/search.html**, log in once, bookmark it.

## 8. Try it

1. Log a test piece in the app.
2. Wait ~10 seconds (caption + embedding happen in the background).
3. On the search page, describe it — or just search by customer name or date with the description left blank. It should appear ranked #1 (blue border).
4. Tap it → **Fired ✓ ready** when it comes out of the kiln (this sets `ready_at`, which Phase 3 will use to trigger the "your pottery is ready" text/email), then **Collected ✓** when picked up.
5. Check Supabase Table Editor: `pieces.status` updates, and description searches that end in a tap add a row to `search_logs` — that's your labelled data accumulating.

Pieces flow `awaiting` (painted) → `ready` (fired) → `collected`. The kiln-unload workflow: search with no description, date "Last week", status "Waiting for kiln" — then tap through the batch marking each as fired.

## Troubleshooting

- **Search returns nothing** — pieces logged before the webhook existed have no caption yet: run the backfill (step 6). Also check the date filter.
- **"Search failed"** — check Edge Functions → search-pieces → Logs in the dashboard.
- **Captions not appearing** — Edge Functions → caption-piece → Logs; usually a missing/typoed secret or no Anthropic credit.
- **Quality check** — `select customer_name, caption from pieces order by created_at desc limit 10;` — captions should mention colours, forms, and any painted words, and ignore the background.

Your prototype's benchmark suggests the right pot lands in the top 3 about 80% of the time; with the date filter narrowing to one day's pieces, in practice it should feel near-perfect. The `search_logs` table quietly builds the labelled dataset for evaluating (and later improving) the ranking.
