# Phase 5 setup — shop feedback round (July 2026)

Everything from the two feedback rounds in one deploy. About 15 minutes.

What's changing:

- **Emails are now timer-based** — customers get the "ready to collect" email 2 weeks after their photo was taken, no need to mark pieces fired first. Marking Fired in the app still works, it just doesn't send anything.
- **Branded emails** — Spotty Pots teal/red, logo, a "collect by" deadline (2 months after the visit), and an optional marketing line your mom edits herself.
- **Search shows who did what** — who logged each piece, and who marked it fired/collected (in the status chip, e.g. "collected · Meg").
- **Start/end date pickers** replace the "last N days" dropdown.
- **Admin page** — new Shop settings section: the worker join code and the email marketing text.

## 1. Email branding

Nothing to do — the email uses the Spotty Pots banner straight from
`spottypots.co.uk` (the same image as the website header), so there's no
file to add. Just don't delete/rename that image in WordPress
(`wp-content/uploads/2021/02/spottyArtboard-1-1024x350.png`); if the site
is ever rebuilt, update `BANNER_URL` in
`supabase/functions/notify-ready/index.ts` and redeploy.

## 2. Run the SQL

SQL Editor → paste `supabase/phase5.sql` → Run. (Safe to re-run.)

## 3. Redeploy BOTH edge functions

`match_pieces`' return type changed, so search-pieces must go out with the SQL — same lesson as the stale-cache bug:

```bash
supabase functions deploy search-pieces
supabase functions deploy notify-ready --no-verify-jwt
```

## 4. Webhook + cron changes (Dashboard)

1. Database → Webhooks → **delete** `notify-on-update` (emails no longer fire on status change).
2. Integrations → Cron → change the `notify-ready` job to `0 10 * * *` (10:00 am — emails used to go at 2:10 am). Leave `enrich-square` at `0 2 * * *`.

## 5. Deploy the app

Push `app/` to Netlify as usual (service worker cache is bumped to v8, so phones pick it up on next open).

## 6. Test

1. **Search page**: results should show "by NAME" on each card; mark one fired — the chip should read "ready to collect · YOU". Try the from/to date boxes (blank = any date).
2. **Admin page**: Shop settings shows the join code; type a marketing line → Save. It lands in `shops.email_promo`. Optionally **Add image** below it — it's resized in the browser, stored in the public `promo-images` bucket, and shown under the text in emails. Remove deletes it. Blank text + no image = the email simply has no marketing section.
3. **Email**: backdate a test piece and trigger by hand:
   ```sql
   update pieces set created_at = now() - interval '15 days' where id = '<piece-id>';
   ```
   ```bash
   curl -X POST "https://nlqwchmezqefygecayfm.supabase.co/functions/v1/notify-ready" \
     -H "x-caption-secret: YOUR_CAPTION_SECRET" -d '{}'
   ```
   Check the email: banner header, "collect by" date 2 months after the (backdated) visit, and your marketing line in the red-edged box.

## Notes

- The collect-by deadline in the email is **2 months after the visit**, matching the shop's hold policy. It's computed per piece, so backdated test pieces show an earlier deadline — that's correct.
- The marketing line is per shop (shop #2 gets its own when it exists) and plain text — anything typed is shown as-is, no links/HTML.
- The email still says "ready" purely on the 2-week timer. If the kiln ever runs late, pause by disabling the cron job temporarily.
