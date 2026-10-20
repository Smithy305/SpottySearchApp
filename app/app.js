/* SpottySearch worker app — Phase 1 (log a piece: photo + name + count) */
/* global supabase, SPOTTY_CONFIG, SpottyEdit */

"use strict";

const sb = supabase.createClient(SPOTTY_CONFIG.SUPABASE_URL, SPOTTY_CONFIG.SUPABASE_ANON_KEY);

const BUCKET = "pottery-photos";
const MAX_DIM = 1280;       // longest photo edge after resize
const JPEG_QUALITY = 0.85;

// ---------- tiny DOM helpers ----------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

// ---------- app state ----------
let profile = null;      // { user_id, shop_id, display_name }
let photoBlob = null;    // resized JPEG ready to upload
let itemCount = 1;

// ============================================================
// Auth
// ============================================================
async function init() {
  registerServiceWorker();

  const { data: { session } } = await sb.auth.getSession();
  if (session) await enterApp();
  else showLogin();

  sb.auth.onAuthStateChange((event, s) => {
    // A reset link that fell back to the main page (redirect URL not
    // allow-listed) would otherwise just log them in without a new password.
    if (event === "PASSWORD_RECOVERY") {
      try { sessionStorage.setItem("spotty-recovery", "1"); } catch (_) {}
      location.replace("reset.html");
      return;
    }
    if (!s) showLogin();
  });

  window.addEventListener("online", flushQueue);
}

function showLogin() {
  profile = null;
  hide($("log-view"));
  hide($("logout-btn"));
  hide($("search-link"));
  hide($("admin-link"));
  show($("login-view"));
}

// Login ↔ Register toggle
let registering = false;

$("auth-toggle").addEventListener("click", () => {
  registering = !registering;
  $("register-fields").classList.toggle("hidden", !registering);
  $("auth-title").textContent = registering ? "New worker" : "Worker login";
  $("login-btn").textContent = registering ? "Register" : "Log in";
  $("auth-toggle").textContent = registering
    ? "Already registered? Log in"
    : "New worker? Register here";
  $("login-error").textContent = "";
  $("register-name").required = registering;
  $("register-code").required = registering;
  $("login-password").autocomplete = registering ? "new-password" : "current-password";
  $("forgot-row").classList.toggle("hidden", registering); // reset link is a login thing
});

// ----- Forgot password -----
// Supabase emails a recovery link that lands on reset.html (must be listed in
// Auth → URL Configuration → Redirect URLs).
$("forgot-btn").addEventListener("click", async () => {
  const email = $("login-email").value.trim();
  if (!email) {
    $("login-error").textContent = "Type your email in the box above first, then tap Forgot password.";
    return;
  }
  $("forgot-btn").disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: new URL("reset.html", location.href).href,
  });
  $("forgot-btn").disabled = false;
  if (error) {
    // Supabase doesn't error for unknown emails, so this is a real failure
    // (usually the email rate limit, or the mail server not set up).
    console.error(error);
    $("login-error").textContent = error.status === 429
      ? "Too many reset emails just now — wait a minute and try again."
      : "Couldn't send the reset email right now — try again later or ask the owner.";
    return;
  }
  $("login-error").textContent = "";
  $("forgot-btn").textContent = "Reset link sent — check your email (and spam) ✓";
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  $("login-error").textContent = "";

  const email = $("login-email").value.trim();
  const password = $("login-password").value;

  if (!registering) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (error) {
      $("login-error").textContent = "Login failed — check email and password.";
      return;
    }
    await enterApp();
    return;
  }

  // ----- Registration -----
  const joinCode = $("register-code").value.trim().toUpperCase();
  const displayName = $("register-name").value.trim();

  const { data: codeOk } = await sb.rpc("check_join_code", { code: joinCode });
  if (!codeOk) {
    $("login-error").textContent = "That shop code isn't right — ask the owner for the current one.";
    btn.disabled = false;
    return;
  }

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName, join_code: joinCode } },
  });

  btn.disabled = false;
  if (error) {
    $("login-error").textContent = error.message.includes("already registered")
      ? "That email already has an account — log in instead."
      : "Registration failed — try again or ask the owner.";
    return;
  }

  if (data.session) {
    await enterApp(); // email confirmation disabled → straight in
  } else {
    $("auth-toggle").click(); // back to login mode
    $("login-error").textContent = "Almost done — click the confirmation link we emailed you, then log in.";
  }
});

$("logout-btn").addEventListener("click", () => sb.auth.signOut());

async function enterApp() {
  // Filter to our own row: workers can now read colleagues' profiles too.
  const { data: { user } } = await sb.auth.getUser();
  const { data, error } = await sb.from("profiles").select("*").eq("user_id", user?.id).single();
  if (error || !data) {
    $("login-error").textContent =
      "Logged in, but no worker profile is set up yet. Ask the admin to add you to a shop.";
    await sb.auth.signOut();
    return;
  }
  profile = data;
  $("welcome").textContent = `Hi ${profile.display_name} — log a new piece below.`;
  hide($("login-view"));
  show($("log-view"));
  show($("logout-btn"));
  show($("search-link"));
  if (profile.role === "admin") show($("admin-link"));
  resetForm();
  await flushQueue();
  await loadToday();
}

// ============================================================
// Photo capture + client-side resize
// ============================================================
// Camera (big button) or photo library (link below) both feed the same handler
$("photo-btn").addEventListener("click", () => $("photo-input").click());
$("library-btn").addEventListener("click", () => $("library-input").click());

$("photo-input").addEventListener("change", (e) => handlePhoto(e.target));
$("library-input").addEventListener("change", (e) => handlePhoto(e.target));

async function handlePhoto(input) {
  const file = input.files[0];
  if (!file) return;
  photoBlob = await resizeImage(file);
  $("photo-preview").src = URL.createObjectURL(photoBlob);
  show($("photo-preview"));
  hide($("photo-placeholder"));
  updateSaveState();
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not process photo"))),
        "image/jpeg",
        JPEG_QUALITY
      );
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ============================================================
// Form
// ============================================================
$("count-minus").addEventListener("click", () => setCount(itemCount - 1));
$("count-plus").addEventListener("click", () => setCount(itemCount + 1));
$("customer-name").addEventListener("input", updateSaveState);

function setCount(n) {
  itemCount = Math.min(100, Math.max(1, n));
  $("count-value").textContent = itemCount;
}

function updateSaveState() {
  $("save-btn").disabled = !(photoBlob && $("customer-name").value.trim());
}

function resetForm() {
  photoBlob = null;
  $("photo-input").value = "";
  $("library-input").value = "";
  $("piece-form").reset();
  hide($("photo-preview"));
  show($("photo-placeholder"));
  setCount(1);
  updateSaveState();
}

function setMsg(text, cls) {
  const el = $("form-msg");
  el.textContent = text;
  el.className = cls || "";
}

$("piece-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const entry = {
    blob: photoBlob,
    customer_name: $("customer-name").value.trim(),
    item_count: itemCount,
    notes: $("piece-notes").value.trim(),
    created_at: new Date().toISOString(),
  };

  $("save-btn").disabled = true;
  setMsg("Saving…");

  try {
    await uploadEntry(entry);
    setMsg("Saved ✓", "ok");
  } catch (err) {
    console.warn("Upload failed, queuing locally:", err);
    await queueAdd(entry);
    setMsg("No connection — saved on this phone, will upload automatically.", "ok");
    refreshQueueNote();
  }

  resetForm();
  await loadToday();
});

async function uploadEntry(entry) {
  const path = `${profile.shop_id}/${crypto.randomUUID()}.jpg`;

  const { error: upErr } = await sb.storage
    .from(BUCKET)
    .upload(path, entry.blob, { contentType: "image/jpeg" });
  if (upErr) throw upErr;

  const { error: insErr } = await sb.from("pieces").insert({
    shop_id: profile.shop_id,
    created_by: profile.user_id,
    photo_path: path,
    customer_name: entry.customer_name,
    item_count: entry.item_count,
    notes: entry.notes || null, // older queued entries have no notes
  });
  if (insErr) throw insErr;
}

// ============================================================
// Offline queue (IndexedDB) — entries upload when signal returns
// ============================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("spotty-queue", 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueAdd(entry) {
  const db = await openDB();
  await idbReq(db.transaction("entries", "readwrite").objectStore("entries").add(entry));
}

async function queueAll() {
  const db = await openDB();
  return idbReq(db.transaction("entries", "readonly").objectStore("entries").getAll());
}

async function queueRemove(id) {
  const db = await openDB();
  await idbReq(db.transaction("entries", "readwrite").objectStore("entries").delete(id));
}

async function flushQueue() {
  if (!profile || !navigator.onLine) return;
  const entries = await queueAll().catch(() => []);
  for (const entry of entries) {
    try {
      await uploadEntry(entry);
      await queueRemove(entry.id);
    } catch {
      break; // still offline or failing — try again later
    }
  }
  refreshQueueNote();
  if (entries.length) await loadToday();
}

async function refreshQueueNote() {
  const entries = await queueAll().catch(() => []);
  const note = $("queue-note");
  if (entries.length) {
    note.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"} waiting on this phone for signal.`;
    show(note);
  } else {
    hide(note);
  }
}

// ============================================================
// Today's pieces
// ============================================================
async function loadToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: pieces, error } = await sb
    .from("pieces")
    .select("id, photo_path, customer_name, item_count, notes, created_at")
    .gte("created_at", startOfDay.toISOString())
    .order("created_at", { ascending: false });

  if (error) return;

  $("today-count").textContent = pieces.length;
  $("today-hint").classList.toggle("hidden", !pieces.length);

  // Signed URLs for thumbnails (bucket is private)
  let urls = {};
  if (pieces.length) {
    const { data: signed } = await sb.storage
      .from(BUCKET)
      .createSignedUrls(pieces.map((p) => p.photo_path), 3600);
    (signed || []).forEach((s, i) => { if (s.signedUrl) urls[pieces[i].photo_path] = s.signedUrl; });
  }

  const list = $("today-list");
  list.replaceChildren();
  for (const p of pieces) {
    const li = document.createElement("li");
    li.className = "editable";
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `Edit entry for ${p.customer_name}`);
    const edit = () => SpottyEdit.open(sb, p.id, () => {
      setMsg("Entry updated ✓", "ok");
      loadToday();
    });
    li.addEventListener("click", edit);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") edit(); });

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = `Pottery for ${p.customer_name}`;
    if (urls[p.photo_path]) img.src = urls[p.photo_path];

    const info = document.createElement("div");
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = p.customer_name;
    const meta = document.createElement("div");
    meta.className = "meta";
    const time = new Date(p.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.textContent = `${p.item_count} item${p.item_count > 1 ? "s" : ""} · ${time}`;
    info.append(who, meta);
    if (p.notes) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = p.notes;
      info.append(note);
    }

    const pencil = document.createElement("span");
    pencil.className = "edit-hint";
    pencil.setAttribute("aria-hidden", "true");
    pencil.textContent = "✎";

    li.append(img, info, pencil);
    list.append(li);
  }
}

// ============================================================
// PWA service worker
// ============================================================
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
