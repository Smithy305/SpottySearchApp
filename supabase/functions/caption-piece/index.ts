// SpottySearch — caption-piece edge function (Phase 2)
//
// Captions a pottery photo with Claude Haiku, embeds the caption with
// Supabase's built-in gte-small model (384 dims), and saves both to the row.
//
// Called two ways:
//   1. Database webhook on INSERT into pieces  → body: { record: { id } }
//   2. Manually with an empty body             → backfills up to 10 uncaptioned pieces
//
// Deploy with JWT verification OFF; the CAPTION_SECRET header is the auth.
// Secrets needed (Dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY, CAPTION_SECRET

import { createClient } from "jsr:@supabase/supabase-js@2";

// Same prompt that won the prototype evaluation, plus the background fix.
const CAPTION_PROMPT =
  "List every distinct pottery item in this image. For each, give its colour, " +
  "form (mug, plate, bowl, figurine, etc.) and any patterns or designs, " +
  "one short sentence per item. If any words or names are painted on a piece, " +
  "quote them exactly. Ignore the background completely — describe only " +
  "hand-painted pottery, not shelves, tables, paints or other objects.";

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const BUCKET = "pottery-photos";

const embedder = new Supabase.ai.Session("gte-small");

// What gets embedded for search: the caption plus any worker note (Phase 7).
// Must match update-piece/index.ts exactly.
function embedText(caption: string, notes: string | null) {
  return notes ? `${caption}\nNotes: ${notes}` : caption;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-caption-secret") !== Deno.env.get("CAPTION_SECRET")) {
    return json({ error: "unauthorised" }, 401);
  }

  // Service-role client: this runs server-side, bypassing RLS by design.
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Which pieces to process?
  const body = await req.json().catch(() => ({}));
  const pieceId = body?.record?.id ?? body?.piece_id ?? null;

  let query = db.from("pieces").select("id, photo_path, notes").is("caption", null);
  query = pieceId ? query.eq("id", pieceId) : query.limit(10);
  const { data: pieces, error } = await query;
  if (error) return json({ error: error.message }, 500);

  const results: Record<string, string> = {};
  for (const piece of pieces ?? []) {
    try {
      const caption = await captionPhoto(db, piece.photo_path);
      const embedding = await embedder.run(embedText(caption, piece.notes), {
        mean_pool: true,
        normalize: true,
      });
      const { error: upErr } = await db
        .from("pieces")
        .update({ caption, embedding: Array.from(embedding as Float32Array) })
        .eq("id", piece.id);
      results[piece.id] = upErr ? `update failed: ${upErr.message}` : "ok";
    } catch (e) {
      results[piece.id] = `failed: ${(e as Error).message}`;
    }
  }

  return json({ processed: Object.keys(results).length, results });
});

async function captionPhoto(db: ReturnType<typeof createClient>, path: string) {
  const { data: blob, error } = await db.storage.from(BUCKET).download(path);
  if (error || !blob) throw new Error(`photo download failed: ${error?.message}`);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(binary);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: b64 },
          },
          { type: "text", text: CAPTION_PROMPT },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const msg = await res.json();
  const caption = msg.content?.[0]?.text?.trim();
  if (!caption) throw new Error("empty caption");
  return caption;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
