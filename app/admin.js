/* SpottySearch — owner dashboard (Phase 4)
   One RPC (admin_dashboard) returns every number; this renders it.
   Admin-only: the RPC itself rejects non-admins, and the page hides on refusal. */
/* global supabase, SPOTTY_CONFIG, Chart */

"use strict";

const sb = supabase.createClient(SPOTTY_CONFIG.SUPABASE_URL, SPOTTY_CONFIG.SUPABASE_ANON_KEY);
const BUCKET = "pottery-photos";
// Matches the promise in the customer emails: "we can only keep pieces for
// 2 months after your visit" (HOLD_MONTHS in notify-ready/send-chaser).
// A piece "needs chasing" once that collect-by date has passed.
const STALE_DAYS = 61; // ~2 months — keep in step with the email functions

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

const SHOP_COLORS = ["#2ab3ac", "#e23d38", "#f5a623", "#5b6ee1", "#7ac74f"];
let chart = null;
let myUserId = null;

// ---------- auth + admin gate ----------
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.href = "index.html"; return; }
  myUserId = session.user.id;

  // Filter to our own row: workers can now read colleagues' profiles too.
  const { data: profile } = await sb.from("profiles").select("role").eq("user_id", session.user.id).single();
  if (!profile || profile.role !== "admin") {
    show($("denied-view"));
    return;
  }
  show($("admin-view"));
  await loadDashboard();
}

$("logout-btn").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.href = "index.html";
});

// ---------- load + render ----------
async function loadDashboard() {
  setMsg("Loading…");
  const { data, error } = await sb.rpc("admin_dashboard", { stale_days: STALE_DAYS });
  if (error) {
    setMsg("Couldn't load the dashboard — try again.", "err");
    console.error(error);
    return;
  }
  setMsg("");
  renderShops(data.shops || []);
  renderSearch(data.searches || {});
  renderTrend(data.daily || [], data.shops || []);
  await renderSettings();
  await renderStale(data.stale || [], (data.shops || []).length > 1);
}

// ---------- shop settings: join code + email marketing line ----------
async function renderSettings() {
  // RLS returns the shops this admin can see (own shop + any owned shops).
  const { data: shops, error } = await sb
    .from("shops")
    .select("id, name, join_code, email_promo, email_promo_image")
    .order("name");
  if (error || !shops?.length) return;

  const root = $("shop-settings");
  root.replaceChildren();

  for (const s of shops) {
    const card = document.createElement("div");
    card.className = "settings-card";

    if (shops.length > 1) {
      const h = document.createElement("h3");
      h.textContent = s.name;
      card.append(h);
    }

    // Join code — what new workers type in when registering.
    const codeRow = document.createElement("p");
    codeRow.className = "join-row";
    codeRow.append("Worker join code: ");
    const code = document.createElement("strong");
    code.className = "join-code";
    code.textContent = s.join_code || "—";
    codeRow.append(code);
    card.append(codeRow);

    // Marketing line appended to every "ready to collect" email.
    const label = document.createElement("label");
    label.textContent = "Extra message in customer emails";
    const hint = document.createElement("p");
    hint.className = "muted small";
    hint.textContent =
      "Shown in every “ready to collect” email — e.g. a discount or upcoming event. Leave blank for none.";
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.maxLength = 500;
    ta.placeholder = "e.g. Enjoy £5 off at our next Paint & Prosecco Night on 18/07/2026!";
    ta.value = s.email_promo || "";

    const save = document.createElement("button");
    save.className = "btn btn-small";
    save.textContent = "Save";
    const saved = document.createElement("span");
    saved.className = "muted small";

    save.addEventListener("click", async () => {
      save.disabled = true;
      const { error: e } = await sb
        .from("shops")
        .update({ email_promo: ta.value.trim() || null })
        .eq("id", s.id);
      saved.textContent = e ? "Couldn't save — try again." : "Saved ✓";
      save.disabled = false;
      setTimeout(() => (saved.textContent = ""), 4000);
    });

    const row = document.createElement("div");
    row.className = "save-row";
    row.append(save, saved);

    card.append(label, hint, ta, row, promoImageUI(s, saved));
    root.append(card);
  }
  show($("settings-section"));
}

// Optional image shown under the marketing text in customer emails.
function promoImageUI(shop, saved) {
  const wrap = document.createElement("div");
  wrap.className = "promo-img-wrap";

  const label = document.createElement("label");
  label.textContent = "Image under the message (optional)";

  const preview = document.createElement("img");
  preview.className = "promo-img-preview";
  preview.alt = "Email marketing image";

  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/*";
  file.hidden = true;

  const pick = document.createElement("button");
  pick.className = "btn btn-small";
  const remove = document.createElement("button");
  remove.className = "btn btn-small btn-quiet";
  remove.textContent = "Remove";

  const setState = (path) => {
    shop.email_promo_image = path;
    pick.textContent = path ? "Replace image" : "Add image";
    remove.hidden = !path;
    preview.hidden = !path;
    if (path) preview.src = sb.storage.from("promo-images").getPublicUrl(path).data.publicUrl;
  };
  setState(shop.email_promo_image);

  pick.addEventListener("click", () => file.click());

  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    pick.disabled = true;
    saved.textContent = "Uploading…";
    try {
      const blob = await resizePromoImage(f); // keep emails light
      const path = `${shop.id}/promo-${Date.now()}.jpg`;
      const { error: upErr } = await sb.storage.from("promo-images")
        .upload(path, blob, { contentType: "image/jpeg" });
      if (upErr) throw upErr;
      const old = shop.email_promo_image;
      const { error: dbErr } = await sb.from("shops")
        .update({ email_promo_image: path }).eq("id", shop.id);
      if (dbErr) throw dbErr;
      if (old) await sb.storage.from("promo-images").remove([old]); // best-effort tidy-up
      setState(path);
      saved.textContent = "Saved ✓";
    } catch (e) {
      console.error(e);
      saved.textContent = "Upload failed — try again.";
    }
    pick.disabled = false;
    file.value = "";
    setTimeout(() => (saved.textContent = ""), 4000);
  });

  remove.addEventListener("click", async () => {
    remove.disabled = true;
    const old = shop.email_promo_image;
    const { error: e } = await sb.from("shops")
      .update({ email_promo_image: null }).eq("id", shop.id);
    if (!e && old) await sb.storage.from("promo-images").remove([old]);
    if (!e) setState(null);
    saved.textContent = e ? "Couldn't remove — try again." : "Removed ✓";
    remove.disabled = false;
    setTimeout(() => (saved.textContent = ""), 4000);
  });

  const btnRow = document.createElement("div");
  btnRow.className = "save-row";
  btnRow.append(pick, remove, file);

  wrap.append(label, preview, btnRow);
  return wrap;
}

// Downscale to email-friendly size (max 1200px wide, jpeg).
function resizePromoImage(f) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1200 / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("resize failed"))), "image/jpeg", 0.85);
    };
    img.onerror = () => reject(new Error("not an image"));
    img.src = URL.createObjectURL(f);
  });
}

function setMsg(text, cls) {
  const el = $("admin-msg");
  el.textContent = text;
  el.className = "muted " + (cls || "");
}

function tile(num, label, cls) {
  const t = document.createElement("div");
  t.className = "kpi" + (cls ? " " + cls : "");
  const n = document.createElement("div"); n.className = "num"; n.textContent = num;
  const l = document.createElement("div"); l.className = "lbl"; l.textContent = label;
  t.append(n, l);
  return t;
}

function renderShops(shops) {
  const root = $("shop-stats");
  root.replaceChildren();

  for (const s of shops) {
    const total = Number(s.logged_total) || 0;
    const collected = Number(s.collected) || 0;
    const withContact = Number(s.with_contact) || 0;

    const block = document.createElement("div");
    block.className = "admin-shop";

    const h = document.createElement("h2");
    h.textContent = s.shop_name;
    block.append(h);

    const grid = document.createElement("div");
    grid.className = "kpi-grid";
    grid.append(
      tile(s.logged_month, "logged this month"),
      tile(total, "logged all time"),
      tile(pct(collected, total) + "%", "collected"),
      tile(s.awaiting, "waiting for kiln"),
      tile(s.ready, "ready to collect"),
      tile(pct(withContact, total) + "%", "have contact details"),
      tile(s.stale_count, "past collect-by date", Number(s.stale_count) > 0 ? "warn" : ""),
    );
    block.append(grid);
    root.append(block);
  }
}

function renderSearch(s) {
  const total = Number(s.total) || 0;
  const ranked = Number(s.ranked) || 0;
  const top3 = Number(s.top3) || 0;
  const grid = $("search-kpis");
  grid.replaceChildren(
    tile(s.last_30 || 0, "searches (30 days)"),
    tile(total, "searches all time"),
    tile(ranked ? pct(top3, ranked) + "%" : "—", "found in top 3"),
  );
  show($("search-stats"));
}

function renderTrend(daily, shops) {
  if (typeof Chart === "undefined") return; // CDN blocked / offline — skip quietly
  show($("trend-section"));

  // Continuous 30-day axis ending today.
  const days = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const labels = days.map((d) =>
    new Date(d).toLocaleDateString([], { day: "numeric", month: "short" }));

  // counts[shopName][day] = n
  const names = shops.map((s) => s.shop_name);
  const counts = {};
  names.forEach((n) => (counts[n] = {}));
  for (const row of daily) {
    if (!counts[row.shop_name]) counts[row.shop_name] = {};
    counts[row.shop_name][row.day] = Number(row.n) || 0;
  }

  const datasets = names.map((name, i) => ({
    label: name,
    data: days.map((d) => counts[name]?.[d] || 0),
    backgroundColor: SHOP_COLORS[i % SHOP_COLORS.length],
    borderRadius: 3,
    stack: "pieces",
  }));

  if (chart) chart.destroy();
  chart = new Chart($("trend-chart"), {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: names.length > 1 } },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

async function renderStale(stale, showShop) {
  $("stale-count").textContent = stale.length;
  const sub = $("stale-sub");
  sub.textContent = stale.length
    ? "Pieces past their collect-by date (2 months after painting — the deadline in their emails) and still not collected."
    : "Nothing outstanding — every piece within its 2-month collection window. 🎉";

  const list = $("stale-list");
  list.replaceChildren();
  if (!stale.length) return;

  // Signed thumbnails (private bucket; owner policy covers all owned shops).
  let urls = {};
  const { data: signed } = await sb.storage
    .from(BUCKET)
    .createSignedUrls(stale.map((p) => p.photo_path), 3600);
  (signed || []).forEach((s, i) => { if (s.signedUrl) urls[stale[i].photo_path] = s.signedUrl; });

  for (const p of stale) {
    const li = document.createElement("li");
    li.className = "stale-item";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = `Pottery for ${p.customer_name}`;
    if (urls[p.photo_path]) img.src = urls[p.photo_path];

    const info = document.createElement("div");
    info.className = "stale-info";

    const who = document.createElement("div");
    who.className = "who";
    who.textContent = p.customer_name;

    const meta = document.createElement("div");
    meta.className = "meta";
    const painted = new Date(p.created_at).toLocaleDateString([], { day: "numeric", month: "short" });
    const bits = [`${p.days_waiting} days waiting`,
                  `${p.item_count} item${p.item_count > 1 ? "s" : ""}`,
                  `painted ${painted}`];
    if (showShop) bits.push(p.shop_name);
    meta.textContent = bits.join(" · ");

    const badge = document.createElement("span");
    badge.className = "badge " + (p.has_contact ? "badge-ok" : "badge-none");
    badge.textContent = p.has_contact ? "✉ has contact" : "no contact";

    info.append(who, meta, badge);

    // Chased before? Show when.
    if (p.chased_at) {
      const chased = document.createElement("span");
      chased.className = "badge badge-chased";
      chased.textContent = "chased " +
        new Date(p.chased_at).toLocaleDateString([], { day: "numeric", month: "short" });
      info.append(" ", chased);
    }

    const btns = document.createElement("div");
    btns.className = "stale-btns";

    // Chaser email — only possible when we have an email address.
    // (has_email comes from phase6's admin_dashboard; fall back to has_contact.)
    if (p.has_email ?? p.has_contact) {
      const chase = document.createElement("button");
      chase.className = "btn btn-small btn-chase";
      chase.textContent = p.chased_at ? "Chase again ✉" : "Send chaser ✉";
      chase.addEventListener("click", () => sendChaser(p, li, chase));
      btns.append(chase);
    }

    const btn = document.createElement("button");
    btn.className = "btn btn-small";
    btn.textContent = "Collected ✓";
    btn.addEventListener("click", () => markCollected(p.id, li, btn));
    btns.append(btn);

    li.append(img, info, btns);
    list.append(li);
  }
}

async function sendChaser(p, li, btn) {
  btn.disabled = true;
  btn.textContent = "Sending…";
  const { error } = await sb.functions.invoke("send-chaser", { body: { piece_id: p.id } });
  if (error) {
    console.error(error);
    btn.disabled = false;
    btn.textContent = "Retry chaser ✉";
    return;
  }
  btn.textContent = "Chaser sent ✓";
  // Refresh the "chased" badge.
  li.querySelector(".badge-chased")?.remove();
  const chased = Object.assign(document.createElement("span"), {
    className: "badge badge-chased",
    textContent: "chased " + new Date().toLocaleDateString([], { day: "numeric", month: "short" }),
  });
  li.querySelector(".stale-info").append(" ", chased);
}

async function markCollected(id, li, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  const { error } = await sb.from("pieces")
    .update({ status: "collected", collected_at: new Date().toISOString(), collected_by: myUserId })
    .eq("id", id);
  if (error) {
    btn.disabled = false;
    btn.textContent = "Retry";
    console.error(error);
    return;
  }
  li.classList.add("done");
  li.querySelector(".badge")?.remove();
  btn.replaceWith(Object.assign(document.createElement("span"),
    { className: "badge badge-ok", textContent: "collected ✓" }));
  const c = $("stale-count");
  c.textContent = Math.max(0, Number(c.textContent) - 1);
}

init();
