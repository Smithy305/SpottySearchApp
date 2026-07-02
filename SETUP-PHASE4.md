# Phase 4 setup — multi-shop, owner dashboard, retention & backups

Prerequisite: Phases 1–3 live. About 30 minutes, mostly clicking around the
Supabase dashboard. Nothing here changes how workers use the app.

What Phase 4 adds:

- **Owner role** so your mom can oversee more than one shop, while each worker
  stays locked to their own shop (that isolation is now tested, end to end).
- **Owner dashboard** (`admin.html`) — per-shop stats, a 30-day logging chart,
  Square contact coverage, search success rate, and a "needs chasing" list of
  pieces left uncollected over 4 weeks (with a one-tap *Collected ✓*).
- **GDPR retention** — a nightly job that anonymises personal details 6 months
  after a piece is collected, while keeping the photo + caption as training data.
- **Backups** — a free nightly off-site database dump via GitHub Actions.

---

## 1. Run the SQL

SQL Editor → paste `supabase/phase4.sql` → Run.

It adds shop ownership, the owner-only RLS policies, the `admin_dashboard()`
function, the `anonymise_old_pieces()` retention function, and schedules the
nightly retention job with **pg_cron**.

If the `create extension pg_cron` / `cron.schedule` lines error, enable the
extension first: **Database → Extensions → search "pg_cron" → enable**, then
re-run the file (it's safe to re-run).

## 2. Make your mom the owner/admin (and add shop #2 when ready)

Find her user id: **Authentication → Users**, or `select user_id, display_name from profiles;`

```sql
-- Make her an admin and the owner of the existing shop:
update profiles set role = 'admin' where user_id = '<mom-user-uuid>';
update shops    set owner_id = '<mom-user-uuid>' where name like 'Spotty Pots%';
```

Log out and back in on her phone — an **Admin** link appears in the top bar.

**Adding the second shop later** (the bottom of `phase4.sql` has this ready to
uncomment):

```sql
insert into shops (name) values ('Spotty Pots — <branch name>');
update shops set owner_id = '<mom-user-uuid>' where name like 'Spotty Pots%';   -- owns both
update shops set join_code = upper(substr(md5(random()::text),1,6)) where join_code is null;
select name, join_code from shops;   -- give each shop's staff their own code
```

Workers register with their shop's join code (same flow as today); that code is
what scopes them. The dashboard then shows both shops side by side.

## 3. Verify the per-shop isolation

**Automated:** SQL Editor → paste `supabase/test_rls.sql` → Run. It creates two
throwaway shops/workers/owner, *becomes* each one, checks who can see what, and
rolls everything back. You should see only `PASS:` notices and no error.

**Manual (worth doing once):** open the live site in two browsers, log in as a
worker from each shop, and confirm neither can see the other's pieces — and that
your mom (admin) sees both on the dashboard.

## 4. Deploy the updated app

The app gained `admin.html` + `admin.js`, and the service worker cache is bumped
to `spotty-shell-v6`. Deploy the `app/` folder to Netlify as usual. (Reminder
from before: app deploys and edge-function deploys are separate; this change is
app-only.)

## 5. Retention job (already scheduled by step 1)

Runs nightly at 03:30 UTC. For any piece collected over 6 months ago it sets
`customer_name = 'Anonymised'` and clears `contact_email`, `contact_phone`,
`square_customer_id`; the photo, caption and embedding stay. `search_logs` hold
only pottery descriptions, so they're untouched.

- **Run it now / test:** `select anonymise_old_pieces();` (returns the number of
  rows scrubbed).
- **Try a shorter window without waiting 6 months:**
  `select anonymise_old_pieces(interval '1 minute');` on a collected test piece.
- **Check the schedule:** `select jobname, schedule from cron.job;`
- Add a short line near the till/booking page noting contact details may be used
  to let customers know their pottery is ready — that plus this job covers the
  GDPR basics.

## 6. Nightly backups (GitHub Actions)

The workflow lives at `.github/workflows/backup.yml`. It needs the project on
GitHub and one secret.

1. If the project isn't on GitHub yet: create a **private** repo and push this
   folder to it.
2. Supabase → **Project Settings → Database → Connection string → URI**, choose
   the **Direct connection** (port 5432). Copy it and append `?sslmode=require`.
3. GitHub repo → **Settings → Secrets and variables → Actions → New repository
   secret**:
   - Name: `SUPABASE_DB_URL`
   - Value: the URI from step 2 (it contains the DB password — keep the repo private).
4. **Actions** tab → *Nightly DB backup* → **Run workflow** to test. When it
   finishes, the gzipped dump is under the run's **Artifacts** (kept 30 days).
   After that it runs itself every night at 03:00 UTC.

To restore: download an artifact, then
`gunzip -c spottysearch-*.sql.gz | psql "<SUPABASE_DB_URL>"`.

> Photos live in Supabase Storage, not the database, so this dump covers all the
> records and metadata but not the image files themselves. The photos already
> sit in Supabase's storage; if you want them backed up off-site too, tell me and
> I'll add a step that syncs the `pottery-photos` bucket.

## Troubleshooting

- **Admin link doesn't show** — the profile `role` must be `admin`; log out/in
  after changing it.
- **Dashboard says "Not authorised"** — same cause; `admin_dashboard()` only
  answers admins.
- **Dashboard shows one shop, expected two** — set `owner_id` to mom's user id on
  *both* shop rows (step 2).
- **Backup job fails immediately** — the `SUPABASE_DB_URL` secret is missing or
  wrong; use the Direct connection URI with `?sslmode=require`.
