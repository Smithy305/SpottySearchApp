# Phase 3 setup — Square contacts + "ready to collect" emails

Prerequisite: Phase 2 live. About 45 minutes, mostly account setup.

How it works once live: every night, `enrich-square` matches each piece's
customer name against Square payments from the painting day and attaches the
email/phone the customer left at the till. When a worker taps **Fired ✓ ready**,
`notify-ready` emails the customer their photo and "ready to collect". One
email per piece, ever (`notified_at`).

## 1. Square access token (NOT the till login)

1. Go to [developer.squareup.com](https://developer.squareup.com) and sign in **with your mom's Square account**.
2. Create an app (name: SpottySearch) → in the app, open the **Production** tab.
3. Copy the **Production Access Token**. Treat it like a password — it can read all sales data.
4. Get the location id: in the same dashboard under Locations, or run:
   ```bash
   curl https://connect.squareup.com/v2/locations \
     -H "Authorization: Bearer YOUR_SQUARE_TOKEN" | grep '"id"'
   ```

## 2. Run the SQL

SQL Editor → paste `supabase/phase3.sql` → Run. Then link the shop to its location:

```sql
update shops set square_location_id = 'L........' where name = 'Spotty Pots';
```

## 3. Resend (email sending)

1. Sign up at [resend.com](https://resend.com) (free tier: 100 emails/day, 3,000/mo).
2. **Domains → Add domain** → `spottysearch.co.uk` → add the DNS records it shows (SPF + DKIM) at your registrar — same place you set up the site DNS. Wait for "Verified".
3. **API Keys → Create** → copy the `re_...` key.

## 4. Secrets

Dashboard → Edge Functions → Secrets, add:

- `SQUARE_ACCESS_TOKEN` = the production token from step 1
- `RESEND_API_KEY` = the `re_...` key
- `MAIL_FROM` = `Spotty Pots <ready@spottysearch.co.uk>`

(`CAPTION_SECRET` already exists from Phase 2 — both new functions reuse it.)

## 5. Deploy the functions

```bash
supabase functions deploy enrich-square --no-verify-jwt
supabase functions deploy notify-ready --no-verify-jwt
```

## 6. Triggers

**Instant email when marked fired** — Database → Webhooks → Create:
- Name `notify-on-update`, table `pieces`, event **Update** only
- Type: Supabase Edge Function → `notify-ready`
- Header `x-caption-secret` = your CAPTION_SECRET

**Nightly catch-up** — Dashboard → Integrations → **Cron** (enable it) → two jobs, type "Supabase Edge Function", with the same `x-caption-secret` header:
- `enrich-square` at `0 2 * * *` (2:00 am)
- `notify-ready` at `10 2 * * *` (2:10 am — mops up pieces whose contact arrived after firing)

## 7. Test end to end

1. Make a small Square sale to yourself and give your own email for the receipt.
2. Log a piece in the app under the same name you'd give at the till.
3. Run enrichment by hand:
   ```bash
   curl -X POST "https://nlqwchmezqefygecayfm.supabase.co/functions/v1/enrich-square" \
     -H "x-caption-secret: YOUR_CAPTION_SECRET" -d '{}'
   ```
   Check Table Editor → pieces: your test piece should now have `contact_email`.
4. On the search page, find the piece → **Fired ✓ ready** → the email should arrive within seconds, photo included.

## Expectations & troubleshooting

- **Coverage won't be 100%.** Square only has contact details when the customer chose a digital receipt or has a Square profile. Cash + paper receipt = nothing to attach; those customers just aren't auto-notified (the piece works normally otherwise). After a couple of weeks, check the hit rate:
  ```sql
  select count(*) filter (where contact_email is not null) as with_email, count(*) as total
  from pieces where created_at > now() - interval '14 days';
  ```
- **Wrong person matched?** The matcher only accepts a single unambiguous name hit in a ±1-day window, preferring exact full-name matches. If it ever misfires, clear it manually (`update pieces set contact_email = null, ... where id = ...`) and tell me — we can tighten the rules.
- **Emails in spam** — make sure the Resend domain shows Verified (SPF + DKIM), and send a few test emails first.
- **Logs** — Edge Functions → enrich-square / notify-ready → Logs show a per-piece summary for every run.

## Privacy note (worth doing)

You're now storing customer contact details. Two easy hygiene steps: add a line to the till/receipt area or booking page mentioning that contact details may be used to let customers know their pottery is ready, and periodically clear old data, e.g.:

```sql
delete from pieces where status = 'collected' and collected_at < now() - interval '6 months';
```

(We can automate that as a third cron job whenever you like.)
