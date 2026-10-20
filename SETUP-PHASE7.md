# Phase 7 setup — editing entries + notes (Oct 2026)

About 10 minutes. What's changing:

- **Edit any entry.** Fix a misspelt name, wrong item count, add a customer
  email, or undo a status (e.g. "Collected" tapped on the wrong pot).
  - **Log page:** tap any of *Today's pieces* (they now show a ✎).
  - **Search page:** tap a result → **Edit details ✎**. Collected pieces can
    now be opened too (for editing only).
  - The dialog shows when it was logged and when it was last edited;
    `edited_at` / `edited_by` record who made the last change.
- **Notes on every entry.** Optional free-text box (up to 500 characters) on
  the log form and in the edit dialog — "Birthday present for Nan", "wants
  the handle glazed", etc. Notes show on result cards and in today's list.
- **Notes are searchable.** The description search now matches on the
  photo caption *and* the notes, and pieces whose notes share words with
  the search get a small boost. A piece that hasn't been captioned yet can
  still be found by its notes.

Notes are for staff only — they never appear in customer emails.

## Deploy order matters

Run the SQL **before** deploying the app. The new app saves a `notes`
column; if it goes out first, every new entry fails to upload and sits in
the phone's offline queue until the SQL is run (nothing is lost, but it's
confusing).

## 1. Run the SQL

SQL Editor → paste `supabase/phase7.sql` → Run. (Safe to re-run.)
Adds `pieces.notes`, `edited_at`, `edited_by`, a notes search index, and
replaces `match_pieces` (new signature).

## 2. Deploy the edge functions

```bash
# NEW — saves edits. JWT verification stays ON (no --no-verify-jwt flag!):
# it runs as the logged-in worker, so they can only edit their shop's pieces.
supabase functions deploy update-piece

# Re-deploy — match_pieces changed, and search now returns notes:
supabase functions deploy search-pieces

# Re-deploy — new pieces get caption + notes embedded together:
supabase functions deploy caption-piece --no-verify-jwt
```

No new secrets. Existing pieces don't need re-processing (none have notes yet).

## 3. Deploy the app

Drag-and-drop the `app/` folder onto Netlify as usual. Ships `edit.js`
(new), the notes box, and the service-worker bump to `spotty-shell-v13`
so phones pick up the new files.

## 4. Test

1. Log a test piece with a note like "test note — purple giraffe". It
   shows in Today's pieces with the note underneath.
2. Tap it → change the name and item count → Save → list updates with
   "Entry updated ✓".
3. Wait ~10 s for the caption, then Search → description "giraffe" → the
   piece should come up near the top.
4. Tap the result → Edit details ✎ → change the note to "zebra" → Save.
   Search "zebra" → it's found (the embedding was refreshed on save).
5. Mark it Collected, then search with status "Collected" → open it →
   Edit details → set Status back to "Ready to collect" → it confirms
   first, then the chip changes.
6. Try 0 items or a 600-character note → a clear error, nothing saved.

## Notes / behaviour

- **Name corrections retry Square.** If a piece has no email/phone yet,
  fixing the name resets its Square-matching attempts, so the nightly
  enrichment tries again with the right spelling.
- **Adding an email by hand** means the 14-day "ready to collect" email
  will go to it at the next 10:00 run (if it hasn't been sent already).
  Changing an email after that email was sent doesn't re-send it.
- **Status changes in the editor** keep the who/when fields consistent:
  back to *Waiting for kiln* clears fired/collected info; *Collected* sets
  collected now / by you. The quick buttons in the search dialog still work
  as before.
- **Not editable:** the photo and the logged date (the date drives the
  email timer). To replace a photo, log the piece again.
- Ranking tweak: the notes keyword boost is `+0.08` in `phase7.sql`
  (search for `0.08`). Raise it if notes feel ignored, lower it if notes
  start to swamp the photo match.
