// SpottySearch — search-pieces edge function (Phase 2)
//
// Two modes, one endpoint:
//   - With a description: embeds it (gte-small, same model as the captions)
//     and returns pieces ranked by similarity to caption + notes, with a
//     small boost when the notes share words with the description.
//   - Without a description: plain listing filtered by name/date/status,
//     newest first (e.g. "everything awaiting the kiln from last week").
//
// Deployed with JWT verification ON (the default): only logged-in workers
// can call it, and their row-level security scopes results to their shop.
//
// POST body: {
//   query?: string,           // description ("white mug with a caterpillar")
//   name?: string,            // customer name substring
//   from?: ISO date, to?: ISO date,
//   status?: 'awaiting' | 'ready' | 'collected' | 'not_collected' | 'any'
// }

import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "pottery-photos";
// Description searches are ranked, so only the top matches are useful.
// Listings (name/date/status only) return everything that matches the filters.
const MAX_SEMANTIC_RESULTS = 24;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const embedder = new Supabase.ai.Session("gte-small");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Client acting AS THE CALLING WORKER — their RLS applies everywhere below.
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );

  const body = await req.json().catch(() => ({}));
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const status = body.status ?? "not_collected"; // 'any' → no filter

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const fromDate = body.from ?? startOfDay.toISOString();
  const toDate = body.to ?? new Date(Date.now() + 86_400_000).toISOString();

  let matches: Record<string, unknown>[] = [];

  if (query) {
    // Semantic mode: rank by caption similarity.
    const embedding = await embedder.run(query, { mean_pool: true, normalize: true });
    const { data, error } = await db.rpc("match_pieces", {
      query_embedding: Array.from(embedding as Float32Array),
      from_date: fromDate,
      to_date: toDate,
      max_results: MAX_SEMANTIC_RESULTS,
      name_filter: name || null,
      status_filter: status === "any" ? null : status,
      query_text: query, // notes keyword boost (phase7.sql)
    });
    if (error) return json({ error: error.message }, 500);
    matches = data ?? [];
  } else {
    // Listing mode: filter only, newest first.
    let q = db
      .from("pieces")
      .select("id, photo_path, customer_name, item_count, caption, notes, status, created_at, created_by, ready_by, collected_by")
      .gte("created_at", fromDate)
      .lt("created_at", toDate)
      .order("created_at", { ascending: false });
    if (name) q = q.ilike("customer_name", `%${name}%`);
    if (status === "not_collected") q = q.neq("status", "collected");
    else if (status !== "any") q = q.eq("status", status);

    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);
    matches = data ?? [];
  }

  // Attach who logged / fired / handed over each piece.
  // No FK between pieces.*_by and profiles, so map the ids ourselves
  // (RLS lets a worker read same-shop profiles).
  const workerIds = [...new Set(
    matches.flatMap((m) => [m.created_by, m.ready_by, m.collected_by]).filter(Boolean),
  )] as string[];
  let names: Record<string, string> = {};
  if (workerIds.length) {
    const { data: profs } = await db
      .from("profiles")
      .select("user_id, display_name")
      .in("user_id", workerIds);
    names = Object.fromEntries((profs ?? []).map((p) => [p.user_id, p.display_name]));
  }
  matches = matches.map(({ created_by, ready_by, collected_by, ...m }) => ({
    ...m,
    logged_by: names[created_by as string] ?? null,
    ready_by_name: ready_by ? names[ready_by as string] ?? null : null,
    collected_by_name: collected_by ? names[collected_by as string] ?? null : null,
  }));

  // Signed thumbnail URLs (storage RLS already limits to the worker's shop).
  const paths = matches.map((m) => m.photo_path as string);
  const urls: Record<string, string> = {};
  if (paths.length) {
    const { data: signed } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
    (signed ?? []).forEach((s, i) => {
      if (s.signedUrl) urls[paths[i]] = s.signedUrl;
    });
  }

  const results = matches.map((m, i) => ({
    ...m,
    rank: i + 1,
    photo_url: urls[m.photo_path as string] ?? null,
  }));

  return json({ mode: query ? "semantic" : "listing", results });
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
