// SpottySearch — notify-ready edge function (Phase 3)
//
// Emails customers 2 weeks after their pottery was photographed (logged).
// Timer-based (shop's request, July 2026): does NOT wait for a worker to mark
// the piece fired — by two weeks everything has been through the kiln.
// Batch design: every run processes ALL eligible pieces
//   created_at <= now() - 14 days AND status <> 'collected'
//   AND notified_at IS NULL AND contact_email IS NOT NULL
// Triggered by the nightly cron only (no UPDATE webhook any more).
// notified_at guarantees one email per piece, ever.
//
// Deploy with JWT verification OFF; protected by the CAPTION_SECRET header.
// Secrets needed: RESEND_API_KEY, MAIL_FROM (+ existing CAPTION_SECRET)
//   e.g. MAIL_FROM = "Spotty Pots <ready@spottysearch.co.uk>"

import { createClient } from "jsr:@supabase/supabase-js@2";

// Email goes out this many days after the piece was photographed.
const NOTIFY_AFTER_DAYS = 14;

Deno.serve(async (req) => {
  if (req.headers.get("x-caption-secret") !== Deno.env.get("CAPTION_SECRET")) {
    return json({ error: "unauthorised" }, 401);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const cutoff = new Date(Date.now() - NOTIFY_AFTER_DAYS * 86_400_000).toISOString();

  const { data: pieces, error } = await db
    .from("pieces")
    .select("id, customer_name, contact_email, created_at, shops(name, email_promo, email_promo_image)")
    .lte("created_at", cutoff)
    .neq("status", "collected")
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

// Brand palette (Spotty Pots): teal + red. The banner is served from the
// shop's own website, so there's nothing extra to host.
const TEAL = "#2ab3ac";
const RED = "#e23d38";
const BANNER_URL =
  "https://www.spottypots.co.uk/wp-content/uploads/2021/02/spottyArtboard-1-1024x350.png";
// The round shop logo, served from the app's own Netlify deploy
// (app/icons/best_logo.jpeg ships with the site). If the app URL ever
// changes, update this and redeploy.
const LOGO_URL = "https://spottysearch.co.uk/icons/best_logo.jpeg";
// Polka-dot strip matching the app's topbar (red dots on teal). An image, not
// text dots: text ● characters leak into the inbox preview snippet.
const DOTS_URL = "https://spottysearch.co.uk/icons/email-dots.png";
const WEBSITE = "https://www.spottypots.co.uk";
const HOLD_MONTHS = 2; // pieces are kept this long after the visit

type ShopInfo = {
  name: string;
  email_promo: string | null;
  email_promo_image: string | null;
};

async function sendEmail(piece: {
  customer_name: string;
  contact_email: string;
  created_at: string;
  shops: ShopInfo | ShopInfo[];
}) {
  const shop = Array.isArray(piece.shops) ? piece.shops[0] : piece.shops;
  const shopName = shop?.name ?? "Spotty Pots";
  const promo = (shop?.email_promo ?? "").trim();
  // Public bucket → plain URL any email client can load. Empty if none set.
  const promoImg = shop?.email_promo_image
    ? `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/promo-images/${shop.email_promo_image}`
    : "";

  // Collect-by deadline: HOLD_MONTHS after the painting visit.
  const collectBy = new Date(piece.created_at);
  collectBy.setMonth(collectBy.getMonth() + HOLD_MONTHS);
  const collectByStr = collectBy.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const name = escapeHtml(piece.customer_name);

  const text =
    `Hi ${piece.customer_name},\n\n` +
    `Your ${shopName} creation has been glazed, fired and is ready to pick up!\n\n` +
    `Please collect it by ${collectByStr} — we can only keep pieces for ` +
    `${HOLD_MONTHS} months after your visit.\n\n` +
    (promo ? `${promo}\n\n` : "") +
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
          <!-- The banner is white script on transparency — needs the teal behind it. -->
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
            <h1 style="margin:0 0 16px;font-size:24px;color:${TEAL};">Your pottery is ready! 🎉</h1>
            <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">Hi ${name},</p>
            <p style="margin:0 0 14px;font-size:16px;line-height:1.5;">
              Your ${escapeHtml(shopName)} creation has been glazed, fired and is
              waiting for you at the shop.
            </p>
            <p style="margin:0 0 18px;font-size:16px;line-height:1.5;">
              Please collect it by <strong style="color:${RED};">${collectByStr}</strong> —
              we can only keep pieces for ${HOLD_MONTHS} months after your visit.
            </p>
          </td>
        </tr>
        ${promo ? `<tr>
          <td style="padding:0 36px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="background:#fdf0ef;border-left:4px solid ${RED};border-radius:8px;
                             padding:14px 18px;font-size:15px;line-height:1.5;">
                ${escapeHtml(promo)}
              </td></tr>
            </table>
          </td>
        </tr>` : ""}
        ${promoImg ? `<tr>
          <td style="padding:6px 36px 8px;">
            <img src="${promoImg}" width="528" alt=""
                 style="display:block;width:100%;max-width:528px;height:auto;border-radius:10px;" />
          </td>
        </tr>` : ""}
        <tr>
          <td style="padding:8px 36px 16px;">
            <p style="margin:0;font-size:16px;line-height:1.5;">
              See you soon,<br /><strong>The ${escapeHtml(shopName)} Team</strong>
            </p>
          </td>
        </tr>
        <tr>
          <!-- The round shop logo — the white square blends into the white card. -->
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
      // Customers WILL hit Reply; send those to Monica, not the send-only address.
      reply_to: "monica@spottypots.co.uk",
      subject: `Your ${shopName} pottery is ready to collect! 🎨`,
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
    headers: { "content-type": "application/json" },
  });
}
