# Phase 6 setup — feedback round 2 (July 2026)

About 10 minutes. What's changing:

- **Emails now carry the shop logo** (`best_logo.jpeg`) and a lot more polka
  dots at the top and bottom — mom's request.
- **Needs chasing now matches the emails** — a piece appears there once its
  collect-by date has passed (2 months after painting, the same "we can only
  keep pieces for 2 months" promise the customer was emailed). It used to be
  a flat 4 weeks.
- **Chaser button** — each item in Needs chasing with an email address gets a
  "Send chaser ✉" button that emails the customer a friendly reminder and
  records when it was sent (so it shows "chased 6 Jul" afterwards).
- **Search dialog buttons fixed** — the Back / Fired / Collected buttons now
  stack full-width so labels never wrap oddly.
- **Forgot password** — a link on the login page emails a reset link that
  lands on the new `reset.html` page.

## 1. Run the SQL

SQL Editor → paste `supabase/phase6.sql` → Run. (Safe to re-run.)
Adds `pieces.chased_at` and updates `admin_dashboard` (2-month stale window).

## 2. Deploy the edge functions

```bash
# NEW — chaser emails. JWT verification stays ON (no --no-verify-jwt flag!):
# only a logged-in admin can trigger it.
supabase functions deploy send-chaser

# Re-deploy — picks up the logo + extra spots:
supabase functions deploy notify-ready --no-verify-jwt
```

No new secrets: send-chaser reuses `RESEND_API_KEY` and `MAIL_FROM`.

## 3. Password reset setup (Dashboard)

**3a. Send auth emails through Resend (important).** Supabase's built-in
mailer only delivers to the email addresses of people on your Supabase team
and only a couple per hour — so a shop worker asking for a reset link would
never get it. Point Supabase at the Resend account you already use:

Authentication → Emails → **SMTP Settings** → Enable custom SMTP:

| Field | Value |
|---|---|
| Sender email | `ready@spottysearch.co.uk` (any address on your verified domain) |
| Sender name | `Spotty Pots` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | your Resend API key (same one as `RESEND_API_KEY`) |

Then Authentication → Rate Limits → check "emails per hour" is something
sensible like 30 (it starts low).

**3b. Allow the reset page.** Authentication → URL Configuration:

- **Site URL** should be `https://spottysearch.co.uk`
- **Redirect URLs** → add:

```
https://spottysearch.co.uk/**
```

(The `**` covers `reset.html` and any future pages. If the app lives at a
different address, use that instead. If this is wrong the link falls back to
the Site URL — the app now spots that and forwards to the reset page anyway.)

## 4. Deploy the app

Drag-and-drop the `app/` folder onto Netlify as usual. This ships
`reset.html`, `reset.js`, the dialog fix, the admin changes, **and** the logo
— the emails load it from `https://spottysearch.co.uk/icons/best_logo.jpeg`,
so it must be deployed *before* the next batch of emails goes out. If the app
URL is ever different, update `LOGO_URL` in **both**
`supabase/functions/notify-ready/index.ts` and
`supabase/functions/send-chaser/index.ts` and redeploy them.

## 5. Test

1. Open `https://spottysearch.co.uk/icons/best_logo.jpeg` and
   `https://spottysearch.co.uk/icons/email-dots.png` in a browser — the round
   logo and the polka-dot strip should both load.
2. Log out → "Forgot password?" → enter your email → follow the emailed link
   → the page says "For <your email>" → set a new password → the app opens
   (you're logged in). Log out and back in with the new password to be sure.
   Also try a worker's email that is *not* on your Supabase team — that's
   the case the SMTP step fixes.
3. Admin page → Needs chasing → pick a piece with "✉ has contact" → Send
   chaser → check the customer inbox (use a test piece with your own email!)
   → the item now shows "chased <today>".
4. Search page → tap a result → the three dialog buttons are stacked
   full-width: Collected ✓ / Fired & ready ✓ / Back.

## Notes

- The chaser wording adapts: before the 2-month deadline it says "please
  collect by <date>"; after it, "the collect-by date has passed — pop in soon
  or reply and we'll keep it safe a little longer".
- Chasing is manual and per-piece on purpose — mom decides who gets nudged.
  "Chase again ✉" appears if a piece was already chased.
- Password-reset emails go through Resend (step 3a). The wording can be
  branded under Authentication → Emails → Templates → Reset Password.
- Reset links only work once and expire after an hour; an old or reused link
  shows the "Link expired" page rather than letting anyone change the
  password of whoever is already logged in on that device.
