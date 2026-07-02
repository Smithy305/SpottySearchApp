/* SpottySearch — owner dashboard (Phase 4)
   One RPC (admin_dashboard) returns every number; this renders it.
   Admin-only: the RPC itself rejects non-admins, and the page hides on refusal. */
/* global supabase, SPOTTY_CONFIG, Chart */

"use strict";

const sb = supabase.createClient(SPOTTY_CONFIG.SUPABASE_URL, SPOTTY_CONFIG.SUPABASE_ANON_KEY);
const BUCKET = "pottery-photos";
const STALE_DAYS = 28; // 4 weeks — keep in step with PLAN/admin_dashboard default

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

const SHOP_COLORS = ["#2ab3ac", "#e23d38", "#f5a623", "#5b6ee1", "#7ac74f"];
let chart = null;

// ---------- auth + admin gate ----------
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.href = "index.html"; return; }

  const { data: profile } = await sb.from("profiles").select("role").single();
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
  await renderStale(data.stale || [], (data.shops || []).length > 1);
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
      tile(s.stale_count, "uncollected > 4 wks", Number(s.stale_count) > 0 ? "warn" : ""),
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
    ? "Pieces painted over 4 weeks ago and still not collected."
    : "Nothing outstanding — every piece older than 4 weeks has been collected. 🎉";

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

    const btn = document.createElement("button");
    btn.className = "btn btn-small";
    btn.textContent = "Collected ✓";
    btn.addEventListener("click", () => markCollected(p.id, li, btn));

    li.append(img, info, btn);
    list.append(li);
  }
}

async function markCollected(id, li, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  const { error } = await sb.from("pieces")
    .update({ status: "collected", collected_at: new Date().toISOString() })
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
