// SpottySearch — notify-ready edge function (Phase 3)
//
// Emails customers whose pottery is fired and ready to collect.
// Batch design: every run processes ALL eligible pieces
//   status = 'ready' AND notified_at IS NULL AND contact_email IS NOT NULL
// so it's safely triggered from two places:
//   - database webhook on pieces UPDATE (instant email when marked fired)
//   - nightly cron after enrich-square (catches contacts that arrived later)
// notified_at guarantees one email per piece, ever.
//
// Deploy with JWT verification OFF; protected by the CAPTION_SECRET header.
// Secrets needed: RESEND_API_KEY, MAIL_FROM (+ existing CAPTION_SECRET)
//   e.g. MAIL_FROM = "Spotty Pots <ready@spottysearch.co.uk>"

import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.headers.get("x-caption-secret") !== Deno.env.get("CAPTION_SECRET")) {
    return json({ error: "unauthorised" }, 401);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: pieces, error } = await db
    .from("pieces")
    .select("id, customer_name, contact_email, shops(name)")
    .eq("status", "ready")
    .is("notified_at", null)
    .not("contact_email", "is", null)
    .limit(50);
  if (error) return json({ error: error.message }, 500);

  const results: Record<string, string> = {};

  for (const piece of pieces ?? []) {
    try {
      // Mark BEFORE sending: a crash mid-loop must never double-email.
      // (Worst case is one missed email, visible in logs — preferable to spam.)
      const { error: markErr } = await db
        .from("pieces")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", piece.id)
        .is("notified_at", null);
      if (markErr) throw markErr;

      await sendEmail(piece);
      results[piece.id] = `emailed ${piece.contact_email}`;
    } catch (e) {
      results[piece.id] = `failed: ${(e as Error).message}`;
    }
  }

  return json({ processed: Object.keys(results).length, results });
});

async function sendEmail(piece: {
  customer_name: string;
  contact_email: string;
  shops: { name: string } | { name: string }[];
}) {
  const shopName = Array.isArray(piece.shops)
    ? piece.shops[0]?.name ?? "Spotty Pots"
    : piece.shops?.name ?? "Spotty Pots";

  const text =
    `Hi ${piece.customer_name},\n\n` +
    `Your ${shopName} creation is now ready to pick up!\n\n` +
    `All the best,\n` +
    `${shopName} Team`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: Deno.env.get("MAIL_FROM"),
      to: [piece.contact_email],
      subject: "Your pottery is ready to pick up!",
      text,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
