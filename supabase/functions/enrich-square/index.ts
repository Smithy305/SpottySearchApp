// SpottySearch — enrich-square edge function (Phase 3)
//
// Best-effort: attaches an email/phone from Square to logged pieces by
// matching the customer name against Square payments made around the time
// the piece was painted. Ambiguous matches (two Sarahs that day) are
// skipped, never guessed. Pieces are retried a few times (contact details
// can land in Square after the photo was taken), then left alone.
//
// Deploy with JWT verification OFF; protected by the CAPTION_SECRET header.
// Secrets needed: SQUARE_ACCESS_TOKEN (+ existing CAPTION_SECRET)
//
// Run nightly by cron, or manually: POST with empty body {}.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SQUARE_BASE = "https://connect.squareup.com";
const SQUARE_VERSION = "2024-10-17";
const MAX_ATTEMPTS = 5;     // nightly tries per piece before giving up
const BATCH = 25;

Deno.serve(async (req) => {
  if (req.headers.get("x-caption-secret") !== Deno.env.get("CAPTION_SECRET")) {
    return json({ error: "unauthorised" }, 401);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Shops that are linked to Square.
  const { data: shops, error: shopErr } = await db
    .from("shops")
    .select("id, square_location_id")
    .not("square_location_id", "is", null);
  if (shopErr) return json({ error: shopErr.message }, 500);

  const summary: Record<string, string> = {};

  for (const shop of shops ?? []) {
    // Pieces still needing contact details.
    const { data: pieces } = await db
      .from("pieces")
      .select("id, customer_name, created_at, enrich_attempts")
      .eq("shop_id", shop.id)
      .is("contact_email", null)
      .is("contact_phone", null)
      .lt("enrich_attempts", MAX_ATTEMPTS)
      .order("created_at", { ascending: false })
      .limit(BATCH);

    for (const piece of pieces ?? []) {
      try {
        const match = await findSquareContact(
          shop.square_location_id,
          piece.customer_name,
          new Date(piece.created_at),
        );
        if (match) {
          await db.from("pieces").update({
            contact_email: match.email,
            contact_phone: match.phone,
            square_customer_id: match.customerId,
            enrich_attempts: piece.enrich_attempts + 1,
          }).eq("id", piece.id);
          summary[piece.id] = `matched ${match.matchedName}`;
        } else {
          await db.from("pieces").update({
            enrich_attempts: piece.enrich_attempts + 1,
          }).eq("id", piece.id);
          summary[piece.id] = "no unambiguous match";
        }
      } catch (e) {
        summary[piece.id] = `error: ${(e as Error).message}`;
      }
    }
  }

  return json({ processed: Object.keys(summary).length, summary });
});

// ---------- Square ----------

async function square(path: string) {
  const res = await fetch(`${SQUARE_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${Deno.env.get("SQUARE_ACCESS_TOKEN")}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Square ${res.status}: ${await res.text()}`);
  return res.json();
}

interface Contact {
  customerId: string;
  matchedName: string;
  email: string | null;
  phone: string | null;
}

async function findSquareContact(
  locationId: string,
  customerName: string,
  paintedAt: Date,
): Promise<Contact | null> {
  // Payments from 2h before the photo to end of next day (they pay before or
  // after painting; collection-day payments of the same person also help).
  const begin = new Date(paintedAt.getTime() - 2 * 3600_000).toISOString();
  const end = new Date(paintedAt.getTime() + 36 * 3600_000).toISOString();

  const payments = await square(
    `/v2/payments?location_id=${locationId}` +
    `&begin_time=${encodeURIComponent(begin)}&end_time=${encodeURIComponent(end)}&limit=100`,
  );

  // Candidate contacts from that window's payments.
  const seen = new Set<string>();
  const candidates: Contact[] = [];
  for (const p of payments.payments ?? []) {
    if (!p.customer_id || seen.has(p.customer_id)) continue;
    seen.add(p.customer_id);
    try {
      const { customer } = await square(`/v2/customers/${p.customer_id}`);
      const name = [customer.given_name, customer.family_name]
        .filter(Boolean).join(" ").trim();
      const email = customer.email_address ?? p.buyer_email_address ?? null;
      const phone = customer.phone_number ?? null;
      if (name && (email || phone)) {
        candidates.push({ customerId: p.customer_id, matchedName: name, email, phone });
      }
    } catch {
      // customer record gone or instant profile without details — skip
    }
  }

  return pickUnambiguous(customerName, candidates);
}

// Tolerant, but only ever returns a SINGLE confident match.
function pickUnambiguous(target: string, candidates: Contact[]): Contact | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const t = norm(target);
  if (!t) return null;

  // 1. Full-name match.
  let hits = candidates.filter((c) => norm(c.matchedName) === t);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null;

  // 2. First-name match (workers usually log just "Sarah"), unique only.
  const first = t.split(/\s+/)[0];
  hits = candidates.filter((c) => norm(c.matchedName).split(/\s+/)[0] === first);
  if (hits.length === 1) return hits[0];

  // 3. Either name contains the other (handles "Sarah W" vs "Sarah Williams").
  hits = candidates.filter((c) => {
    const n = norm(c.matchedName);
    return n.includes(t) || t.includes(n);
  });
  return hits.length === 1 ? hits[0] : null;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
