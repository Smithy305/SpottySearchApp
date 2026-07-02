/* SpottySearch — search page (Phase 2)
   Search by description and/or customer name and/or date.
   Lifecycle: awaiting (painted) → ready (fired) → collected. */
/* global supabase, SPOTTY_CONFIG */

"use strict";

const sb = supabase.createClient(SPOTTY_CONFIG.SUPABASE_URL, SPOTTY_CONFIG.SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  awaiting: "waiting for kiln",
  ready: "ready to collect",
  collected: "collected",
};

let profile = null;
let lastQuery = ""; // description used for the current results (labelled-data logging)
let selected = null;

// ---------- auth gate (same session as the logging app) ----------
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.href = "index.html"; // log in there first
    return;
  }
  const { data } = await sb.from("profiles").select("*").single();
  profile = data;
  if (profile?.role === "admin") $("admin-link").classList.remove("hidden");
  $("search-view").classList.remove("hidden");
}

$("logout-btn").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.href = "index.html";
});

// ---------- search ----------
$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  lastQuery = $("query-input").value.trim();

  $("search-btn").disabled = true;
  setMsg("Searching…");

  const days = $("date-range").value;
  const body = {
    query: lastQuery,
    name: $("name-input").value.trim(),
    status: $("status-filter").value,
    to: new Date(Date.now() + 86400000).toISOString(),
  };
  if (days === "all") {
    body.from = new Date(0).toISOString();
  } else {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - Number(days));
    body.from = from.toISOString();
  }

  try {
    const { data, error } = await sb.functions.invoke("search-pieces", { body });
    if (error) throw error;
    renderResults(data.results || []);
    setMsg(data.results?.length ? "" : "No matches — try different words or widen the filters.");
  } catch (err) {
    console.error(err);
    setMsg("Search failed — check connection and try again.", "err");
  }
  $("search-btn").disabled = false;
});

function setMsg(text, cls) {
  const el = $("search-msg");
  el.textContent = text;
  el.className = cls || "";
}

function renderResults(results) {
  const list = $("results");
  list.replaceChildren();

  for (const r of results) {
    const li = document.createElement("li");
    li.className = "result-card status-" + r.status;
    li.tabIndex = 0;
    li.setAttribute("role", "button");

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = `Pottery for ${r.customer_name}`;
    if (r.photo_url) img.src = r.photo_url;

    const info = document.createElement("div");
    info.className = "card-info";

    const who = document.createElement("div");
    who.className = "who";
    who.textContent = r.customer_name;

    const meta = document.createElement("div");
    meta.className = "meta";
    const date = new Date(r.created_at).toLocaleDateString([], { day: "numeric", month: "short" });
    const sim = typeof r.similarity === "number" ? ` · ${Math.round(r.similarity * 100)}%` : "";
    meta.textContent = `#${r.rank}${sim} · ${r.item_count} item${r.item_count > 1 ? "s" : ""} · ${date}`;

    const chip = document.createElement("span");
    chip.className = "status-chip chip-" + r.status;
    chip.textContent = STATUS_LABEL[r.status] ?? r.status;

    info.append(who, meta, chip);
    li.append(img, info);

    const pick = () => openActions(r, li);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });

    list.append(li);
  }
}

// ---------- piece actions ----------
function openActions(r, card) {
  if (r.status === "collected") return;
  selected = { ...r, card };
  $("confirm-photo").src = r.photo_url || "";
  $("confirm-text").textContent =
    `${r.customer_name} — ${r.item_count} item${r.item_count > 1 ? "s" : ""}, currently ${STATUS_LABEL[r.status]}.`;
  // Fired button only makes sense for pieces still awaiting the kiln.
  $("confirm-fired").classList.toggle("hidden", r.status !== "awaiting");
  $("confirm-dialog").showModal();
}

$("confirm-cancel").addEventListener("click", () => $("confirm-dialog").close());
$("confirm-fired").addEventListener("click", () => applyStatus("ready"));
$("confirm-collect").addEventListener("click", () => applyStatus("collected"));

async function applyStatus(newStatus) {
  const patch = { status: newStatus };
  if (newStatus === "ready") patch.ready_at = new Date().toISOString();
  if (newStatus === "collected") patch.collected_at = new Date().toISOString();

  const { error } = await sb.from("pieces").update(patch).eq("id", selected.id);

  if (error) {
    setMsg("Could not update — try again.", "err");
  } else {
    // If a description found this piece, save the labelled (query → image) pair.
    if (lastQuery) {
      await sb.from("search_logs").insert({
        shop_id: profile.shop_id,
        query_text: lastQuery,
        selected_piece_id: selected.id,
        result_rank: selected.rank,
      });
    }
    setMsg(`${selected.customer_name} — marked ${STATUS_LABEL[newStatus]} ✓`, "ok");
    selected.status = newStatus;
    updateCard(selected.card, newStatus);
  }
  $("confirm-dialog").close();
}

function updateCard(card, newStatus) {
  card.className = "result-card status-" + newStatus;
  const chip = card.querySelector(".status-chip");
  chip.className = "status-chip chip-" + newStatus;
  chip.textContent = STATUS_LABEL[newStatus];
}

init();
