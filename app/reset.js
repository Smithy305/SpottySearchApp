/* SpottySearch — password reset page (Phase 6)
   The recovery link in the email lands here; supabase-js picks the token out
   of the URL and signs the user in with a temporary "recovery" session. All
   we do is let them set a new password, then send them to the app. */
/* global supabase, SPOTTY_CONFIG */

"use strict";

// Read the URL *before* supabase-js tidies it away. A genuine recovery link
// carries either #...type=recovery (implicit flow) or ?code=... (PKCE).
// A dead link comes back with error=... / error_code=otp_expired instead.
const urlParams = new URLSearchParams(
  location.search.slice(1) + "&" + location.hash.replace(/^#/, "")
);
const linkError = urlParams.get("error_code") || urlParams.get("error");
const hasRecoveryToken = urlParams.get("type") === "recovery" || urlParams.has("code");

// app.js sets this flag when a recovery link landed on the main page instead
// (e.g. the redirect URL wasn't allow-listed) and forwards the user here.
let forwardedFromApp = false;
try {
  forwardedFromApp = sessionStorage.getItem("spotty-recovery") === "1";
  sessionStorage.removeItem("spotty-recovery");
} catch (_) { /* storage blocked — ignore */ }

const sb = supabase.createClient(SPOTTY_CONFIG.SUPABASE_URL, SPOTTY_CONFIG.SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);

async function init() {
  let decided = false;
  const decide = async (ok) => {
    if (decided) return;
    decided = true;
    $(ok ? "reset-view" : "invalid-view").classList.remove("hidden");
    if (ok) {
      // Show whose password is being changed — matters on the shared shop tablet.
      const { data: { user } } = await sb.auth.getUser();
      if (user?.email) $("reset-for").textContent = `For ${user.email}`;
    }
  };

  // Expired / already-used link: never fall through to an old logged-in
  // session on this device (that would reset the *wrong* person's password).
  if (linkError) return decide(false);

  sb.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") decide(true);
  });

  // Fallback in case the event fired before we subscribed. Only trust a
  // session if this page was actually opened from a recovery link.
  setTimeout(async () => {
    const { data: { session } } = await sb.auth.getSession();
    decide(!!session && (hasRecoveryToken || forwardedFromApp));
  }, 1500);
}

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("new-password").value;
  const pw2 = $("new-password2").value;
  const err = $("reset-error");
  err.textContent = "";

  if (pw !== pw2) {
    err.textContent = "Those passwords don't match — try again.";
    return;
  }

  $("reset-btn").disabled = true;
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    console.error(error);
    err.textContent = error.message.includes("different from the old")
      ? "That's the same as your old password — pick a new one."
      : "Couldn't set the password — the link may have expired. Request a new one.";
    $("reset-btn").disabled = false;
    return;
  }

  // The recovery session is a normal login, so the app opens straight in.
  $("reset-btn").textContent = "Password changed ✓";
  setTimeout(() => (location.href = "index.html"), 900);
});

init();
