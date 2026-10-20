// SpottySearch — update-piece edge function (Phase 7)
//
// Edits a logged piece: fix a misspelt name, wrong item count, add/edit the
// note, add/correct the customer email, or undo a status (e.g. tapped
// "Collected" on the wrong pot).
//
// Why a function rather than a plain table update from the app: when the
// note changes, the search embedding (caption + notes) must be recomputed,
// and that model only runs server-side.
//
// Deployed with JWT verification ON (the default — no --no-verify-jwt):
// runs AS THE CALLING WORKER, so row-level security decides which pieces
// they may edit (their own shop's; owners: their shops').
//
// POST body: {
//   id: uuid,                       // required
//   customer_name?: string,         // 1–80 chars
//   item_count?: number,            // 1–100
//   notes?: string | null,          // ≤ 500 chars; "" clears it
//   contact_email?: string | null,  // "" clears it
//   status?: 'awaiting' | 'ready' | 'collected'
// }
// Returns { piece } — the updated row.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_NAME = 80;
const MAX_NOTES = 500;
const STATUSES = ["awaiting", "ready", "collected"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const embedder = new Supabase.ai.Session("gte-small");

// Must match caption-piece/index.ts exactly, so edited and fresh pieces
// are embedded the same way.
function embedText(caption: string, notes: string | null) {
  return notes ? `${caption}\nNotes: ${notes}` : caption;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );

  const { data: { user } } = await db.auth.getUser();
  if (!user) return json({ error: "not logged in" }, 401);

  const body = await req.json().catch(() => ({}));
  if (typeof body.id !== "string") return json({ error: "id required" }, 400);

  // Current row — RLS returns nothing if this worker can't see it.
  const { data: cur, error: curErr } = await db
    .from("pieces")
    .select("id, customer_name, item_count, notes, caption, status, contact_email, contact_phone, ready_at, ready_by, collected_at, collected_by")
    .eq("id", body.id)
    .maybeSingle();
  if (curErr) return json({ error: curErr.message }, 500);
  if (!cur) return json({ error: "piece not found" }, 404);

  const patch: Record<string, unknown> = {};
  const now = new Date().toISOString();

  // --- customer name ---
  if (body.customer_name !== undefined) {
    const name = String(body.customer_name).trim().replace(/\s+/g, " ");
    if (!name || name.length > MAX_NAME) return json({ error: `Name must be 1–${MAX_NAME} characters.` }, 400);
    if (name !== cur.customer_name) {
      patch.customer_name = name;
      // Square matching is by name: with the corrected spelling, give the
      // nightly enrichment a fresh set of tries (only if no contact yet).
      if (!cur.contact_email && !cur.contact_phone) patch.enrich_attempts = 0;
    }
  }

  // --- item count ---
  if (body.item_count !== undefined) {
    const n = Number(body.item_count);
    if (!Number.isInteger(n) || n < 1 || n > 100) return json({ error: "Items must be 1–100." }, 400);
    if (n !== cur.item_count) patch.item_count = n;
  }

  // --- notes ---
  let notesChanged = false;
  if (body.notes !== undefined) {
    const notes = body.notes === null ? null : String(body.notes).trim() || null;
    if (notes && notes.length > MAX_NOTES) return json({ error: `Notes must be ${MAX_NOTES} characters or fewer.` }, 400);
    if (notes !== cur.notes) {
      patch.notes = notes;
      notesChanged = true;
    }
  }

  // --- customer email ---
  if (body.contact_email !== undefined) {
    const email = body.contact_email === null ? null : String(body.contact_email).trim().toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email doesn't look right." }, 400);
    if (email !== cur.contact_email) patch.contact_email = email;
  }

  // --- status (keeps the who/when columns consistent) ---
  if (body.status !== undefined && body.status !== cur.status) {
    if (!STATUSES.includes(body.status)) return json({ error: "bad status" }, 400);
    patch.status = body.status;
    if (body.status === "awaiting") {
      Object.assign(patch, { ready_at: null, ready_by: null, collected_at: null, collected_by: null });
    } else if (body.status === "ready") {
      Object.assign(patch, { collected_at: null, collected_by: null });
      if (!cur.ready_at) Object.assign(patch, { ready_at: now, ready_by: user.id });
    } else {
      Object.assign(patch, { collected_at: now, collected_by: user.id });
    }
  }

  if (!Object.keys(patch).length) return json({ piece: cur, unchanged: true });

  // Notes are part of what search matches on → refresh the embedding.
  // (No caption yet? caption-piece will fold the notes in when it runs.)
  if (notesChanged && cur.caption) {
    const emb = await embedder.run(embedText(cur.caption, patch.notes as string | null), {
      mean_pool: true,
      normalize: true,
    });
    patch.embedding = Array.from(emb as Float32Array);
  }

  patch.edited_at = now;
  patch.edited_by = user.id;

  const { data: updated, error: upErr } = await db
    .from("pieces")
    .update(patch)
    .eq("id", cur.id)
    .select("id, photo_path, customer_name, item_count, notes, status, contact_email, created_at, edited_at, ready_by, collected_by")
    .maybeSingle();
  if (upErr) return json({ error: upErr.message }, 500);
  if (!updated) return json({ error: "not allowed to edit this piece" }, 403);

  return json({ piece: updated });
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
