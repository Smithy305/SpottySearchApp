// SpottySearch — send-chaser edge function (Phase 6)
//
// Sends a one-off "your pottery is still waiting" reminder for a single
// piece, triggered by the owner from the admin page's Needs chasing list.
//
// Deployed with JWT verification ON (the default): only logged-in users can
// call it. Everything runs as the CALLING user — their row-level security
// decides which pieces they can see and update — plus an explicit admin-role
// check, so ordinary workers can't send emails.
//
// POST body: { piece_id: string }
// Secrets needed: RESEND_API_KEY, MAIL_FROM (already set for notify-ready).

import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Brand palette + assets — keep in step with notify-ready/index.ts.
const TEAL = "#2ab3ac";
const RED = "#e23d38";
const BANNER_URL =
  "https://www.spottypots.co.uk/wp-content/uploads/2021/02/spottyArtboard-1-1024x350.png";
const LOGO_URL = "https://spottysearch.co.uk/icons/best_logo.jpeg";
// Polka-dot strip matching the app's topbar (red dots on teal). An image, not
// text dots: text ● characters leak into the inbox preview snippet.
const DOTS_URL = "https://spottysearch.co.uk/icons/email-dots.png";
const WEBSITE = "https://www.spottypots.co.uk";
const HOLD_MONTHS = 2; // same promise as the ready email
// Where customers should write back (the send address may not receive mail).
const CONTACT_EMAIL = "monica@spottypots.co.uk";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Client acting AS THE CALLER — RLS applies to every query below.
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );

  const { data: { user } } = await db.auth.getUser();
  if (!user) return json({ error: "unauthorised" }, 401);

  // Only admins (the owner) may chase customers.
  const { data: profile } = await db
    .from("profiles").select("role").eq("user_id", user.id).single();
  if (profile?.role !== "admin") return json({ error: "admins only" }, 403);

  const body = await req.json().catch(() => ({}));
  const pieceId = typeof body.piece_id === "string" ? body.piece_id : null;
  if (!pieceId) return json({ error: "piece_id required" }, 400);

  // RLS: returns nothing unless the piece is in a shop this admin can see.
  const { data: piece, error } = await db
    .from("pieces")
    .select("id, customer_name, contact_email, created_at, status, shops(name)")
    .eq("id", pieceId)
    .single();
  if (error || !piece) return json({ error: "piece not found" }, 404);
  if (piece.status === "collected") return json({ error: "already collected" }, 400);
  if (!piece.contact_email) return json({ error: "no contact email" }, 400);

  try {
    await sendChaser(piece);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }

  // Record it (through the caller's RLS again).
  const chasedAt = new Date().toISOString();
  const { error: markErr } = await db
    .from("pieces").update({ chased_at: chasedAt }).eq("id", pieceId);
  if (markErr) return json({ error: "email sent but couldn't record it: " + markErr.message }, 500);

  return json({ ok: true, chased_at: chasedAt });
});

type ShopInfo = { name: string };

async function sendChaser(piece: {
  customer_name: string;
  contact_email: string;
  created_at: string;
  shops: ShopInfo | ShopInfo[];
}) {
  const shop = Array.isArray(piece.shops) ? piece.shops[0] : piece.shops;
  const shopName = shop?.name ?? "Spotty Pots";
  const name = escapeHtml(piece.customer_name);

  const painted = new Date(piece.created_at).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });
  const collectBy = new Date(piece.created_at);
  collectBy.setMonth(collectBy.getMonth() + HOLD_MONTHS);
  const collectByStr = collectBy.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const overdue = collectBy.getTime() < Date.now();

  const deadlineText = overdue
    ? `Its collect-by date (${collectByStr}) has now passed — please pop in soon, ` +
      `or email ${CONTACT_EMAIL} and we'll happily keep it safe a little longer.`
    : `Please collect it by ${collectByStr} — we can only keep pieces for ` +
      `${HOLD_MONTHS} months after your visit.`;

  const text =
    `Hi ${piece.customer_name},\n\n` +
    `Just a friendly nudge from ${shopName} — the pottery you painted on ` +
    `${painted} is fired, glazed and still waiting for you at the shop!\n\n` +
    `${deadlineText}\n\n` +
    `All the best,\n${shopName} Team\n${WEBSITE}`;

  // Table-based layout + inline styles: renders in Outlook/Gmail/Apple Mail.
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f1ec;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0"
             style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;
                    font-family:Georgia,'Times New Roman',serif;color:#333333;">
        <tr>
          <td align="center" style="background:${TEAL};padding:24px 30px 6px;">
            <img src="${BANNER_URL}" width="300" alt="${escapeHtml(shopName)}"
                 style="display:block;max-width:100%;height:auto;" />
          </td>
        </tr>
        <tr>
          <td style="background:${TEAL};padding:8px 0 0;">
            <img src="${DOTS_URL}" width="600" alt=""
                 style="display:block;width:100%;height:auto;" />
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px 8px;">
            <h1 style="margin:0 0 16px;font-size:24px;color:${TEAL};">Your pottery misses you! 🏺</h1>
            <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">Hi ${name},</p>
            <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">
              Just a friendly nudge — the piece you painted at ${escapeHtml(shopName)}
              on <strong>${painted}</strong> is fired, glazed and still waiting for you
              at the shop.
            </p>
            <p style="margin:0 0 18px;font-size:16px;line-height:1.5;">
              ${overdue
                ? `Its collect-by date (<strong style="color:${RED};">${collectByStr}</strong>) has now
                   passed — please pop in soon, or email
                   <a href="mailto:${CONTACT_EMAIL}" style="color:${TEAL};">${CONTACT_EMAIL}</a>
                   and we'll happily keep it safe a little longer.`
                : `Please collect it by <strong style="color:${RED};">${collectByStr}</strong> —
                   we can only keep pieces for ${HOLD_MONTHS} months after your visit.`}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 36px 16px;">
            <p style="margin:0;font-size:16px;line-height:1.5;">
              See you soon,<br /><strong>The ${escapeHtml(shopName)} Team</strong>
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 36px 26px;">
            <img src="${LOGO_URL}" width="110" height="110" alt="${escapeHtml(shopName)} logo"
                 style="display:block;width:110px;height:110px;border-radius:50%;" />
          </td>
        </tr>
        <tr>
          <td style="background:${TEAL};">
            <img src="${DOTS_URL}" width="600" alt=""
                 style="display:block;width:100%;height:auto;" />
          </td>
        </tr>
        <tr>
          <td align="center" style="background:${TEAL};padding:2px 20px 14px;">
            <a href="${WEBSITE}" style="color:#ffffff;font-size:13px;font-family:Georgia,serif;">spottypots.co.uk</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: Deno.env.get("MAIL_FROM"),
      to: [piece.contact_email],
      reply_to: CONTACT_EMAIL, // hitting Reply goes to Monica, not the send-only address
      subject: `Your ${shopName} pottery is still waiting for you! 🏺`,
      text,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
