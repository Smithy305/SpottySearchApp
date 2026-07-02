# Phase 1 setup — get the logging app live

About 30 minutes, no credit card needed.

## 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) (free tier).
2. New project → name it `spottysearch`, pick a strong database password (save it), region **West EU (London)**.
3. Wait ~2 minutes for it to provision.

## 2. Run the schema

1. Dashboard → **SQL Editor** → New query.
2. Paste the whole of `supabase/schema.sql` → **Run**.
3. It creates the tables, security rules, photo bucket, and a "Spotty Pots" shop row.
4. Get the shop id — run: `select id, name from shops;` and copy the id.

## 3. Create worker accounts

**Easiest: self-registration with the shop code.** Run `supabase/registration.sql` in the SQL Editor, then get the code with `select name, join_code from shops;`. Give that 6-character code to workers — they tap "New worker? Register here" on the login screen and sign themselves up. Rotate the code any time a worker leaves (the SQL file shows how); existing accounts keep working.

Tip: Dashboard → Authentication → Sign In / Up → turn **off** "Confirm email" if you want workers logged in immediately after registering, with no confirmation-email step.

**Manual alternative** (still works, e.g. for the first admin account):

1. Dashboard → **Authentication** → **Users** → **Add user** → email + password. Tick "Auto confirm user".
2. Copy the new user's UUID, then in SQL Editor link them to the shop:

```sql
insert into profiles (user_id, shop_id, display_name)
values ('<user-uuid>', '<shop-uuid>', 'Worker name');
```

## 4. Configure the app

In `app/config.js`, fill in both values from Dashboard → **Settings** → **API**:
`SUPABASE_URL` (Project URL) and `SUPABASE_ANON_KEY` (anon public key). The anon key is safe to be public — row-level security is what protects the data.

## 5. Deploy the app folder

Any static host works; it must be HTTPS (required for the camera and PWA install). Easiest:

1. Sign up at [netlify.com](https://netlify.com) (free).
2. Drag-and-drop the `app/` folder onto the Netlify dashboard ("Deploy manually").
3. You get a URL like `https://spottysearch.netlify.app`. Rename the site in Site settings if you like.

To test locally first: `python3 -m http.server 8000` inside `app/`, then open http://localhost:8000 (localhost is allowed camera access without HTTPS).

## 6. Install on the workers' phones

1. Open the URL in the phone browser.
2. iPhone (Safari): Share → **Add to Home Screen**. Android (Chrome): menu → **Install app** / **Add to Home Screen**.
3. Log in once — the session sticks.

## 7. Try it

Photo → name → count → Save. The entry appears in "Today's pieces" and in Supabase under **Table Editor → pieces**. If the shop wifi drops, entries queue on the phone and upload when signal returns.

## Troubleshooting

- **"no worker profile is set up yet"** — step 3's `insert into profiles` is missing for that user.
- **Camera doesn't open** — the site isn't HTTPS, or camera permission was denied (check browser site settings).
- **Photos upload but list is empty** — check the phone's date/time; the list shows entries since local midnight.

When this works in the shop for a few days, we start Phase 2 (the search site).
