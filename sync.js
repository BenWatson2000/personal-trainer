/* Cloud sync (optional) — Supabase-backed backup & multi-device sync.
 *
 * The app is offline-first: localStorage stays the source of truth and everything
 * works signed-out, exactly as before. Signing in adds a background mirror of every
 * pt_* key to a per-user table (see supabase/schema.sql), so your data survives a
 * lost phone and follows you across devices.
 *
 * SETUP (one time, free): create a Supabase project, run supabase/schema.sql in its
 * SQL editor, then paste the project's URL + publishable key below. The publishable
 * key is safe to publish — row-level security means users can only ever read their
 * own rows. Leave these blank and the app remains 100% on-device.
 */
const SYNC_CONFIG = {
  url: "https://osbxbvnupeshqgfzvxtd.supabase.co",       // project root (no /rest/v1)
  key: "sb_publishable_K3OMbJUDlzDEc5KJ8erHKA_qDItNXI_", // Settings → API → publishable key (safe to publish)
  requireAccount: true,  // gate the whole app behind sign-in (first use needs a connection; offline after)
};

const SYNC = {
  status: (SYNC_CONFIG.url && SYNC_CONFIG.key) ? "starting" : "unconfigured",
  email: null, err: null,
  last: localStorage.getItem("ptsync_lastok") || null,
};
let sb = null, sbSession = null, flushTimer = null;
let OTP_EMAIL = null; // set once a code has been emailed → the sign-in UI switches to the code step

/* ---- storage interception: every pt_* write anywhere in the app lands in the
   dirty-queue. RAW.* bypasses the queue (used when applying remote state). ---- */
const RAW = {
  set: localStorage.setItem.bind(localStorage),
  rm: localStorage.removeItem.bind(localStorage),
};
const DIRTY = new Set(JSON.parse(localStorage.getItem("ptsync_dirty") || "[]"));
function saveDirty() { RAW.set("ptsync_dirty", JSON.stringify([...DIRTY])); }
localStorage.setItem = (k, v) => { RAW.set(k, v); if (k.indexOf("pt_") === 0) markDirty(k); };
localStorage.removeItem = (k) => { RAW.rm(k); if (k.indexOf("pt_") === 0) markDirty(k); };
function markDirty(k) {
  if (SYNC.status === "unconfigured") return;
  DIRTY.add(k); saveDirty();
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 700); // push almost immediately after a change
}

/* ---- boot ---- */
async function initSync() {
  // The UI audit runs fully offline & deterministic — never reach for the network there.
  if (typeof window !== "undefined" && window.__PT_NO_CLOUD) { SYNC.status = "unconfigured"; return; }
  if (SYNC.status === "unconfigured") return;
  try {
    // supabase-js is vendored (vendor/supabase-js.js, loaded before this script) — no CDN at runtime
    const lib = (typeof window !== "undefined" && window.supabase) || null;
    if (!lib || !lib.createClient) throw new Error("sync library not loaded");
    sb = lib.createClient(SYNC_CONFIG.url, SYNC_CONFIG.key);
    sb.auth.onAuthStateChange((event, session) => {
      sbSession = session;
      SYNC.email = session ? session.user.email : null;
      SYNC.status = session ? "ok" : "signedout";
      if (session) RAW.set("ptsync_account", session.user.email); // remember: this device has an account
      refreshSyncCard();
      if (typeof render === "function") render();                 // enter/leave the sign-in gate
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        const prevUid = localStorage.getItem("ptsync_uid");
        if (prevUid && prevUid !== session.user.id) switchAccount(); // different person — don't mix their data
        RAW.set("ptsync_uid", session.user.id);
        firstSyncOrPull();
      }
    });
  } catch (e) { console.error("[sync] init failed:", e.message || e); SYNC.status = "error"; SYNC.err = e.message || "couldn't start sync"; refreshSyncCard(); }
}

/* first session on this account → seed the cloud with everything local;
   otherwise pull whatever other devices have written since our last pull */
function queueAllLocal() {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.indexOf("pt_") === 0) DIRTY.add(k);
  }
  saveDirty();
}
// A different account signed in on this device: the previous user's local data must
// not leak into (or be uploaded to) the new account. Start clean; their cloud data
// pulls down right after (or, for a brand-new account, onboarding starts fresh).
function switchAccount() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.indexOf("pt_") === 0) RAW.rm(k);
  }
  DIRTY.clear(); saveDirty();
  RAW.rm("ptsync_last"); RAW.rm("ptsync_lastok"); SYNC.last = null;
  if (typeof PHOTOS !== "undefined" && typeof photoDel === "function") {
    (async () => { try { for (const p of PHOTOS) await photoDel(p.date); PHOTOS = []; } catch {} })();
  }
}
async function firstSyncOrPull() {
  try {
    const { count, error } = await sb.from("user_state").select("key", { count: "exact", head: true });
    if (error) throw error;
    if (!count) {                       // empty cloud (0 or null) → seed it with everything local
      queueAllLocal(); await flush();
    } else {
      await pull(); await flush();
    }
  } catch (e) {
    console.error("[sync] first sync failed:", e.message || e);
    SYNC.status = "error"; SYNC.err = e.message || String(e); refreshSyncCard();
  }
}

function jsonSafe(raw) { try { return JSON.parse(raw); } catch { return raw; } }

async function flush() {
  if (!sb || !sbSession || !navigator.onLine || !DIRTY.size) return;
  SYNC.status = "syncing"; refreshSyncCard();
  const keys = [...DIRTY];
  const rows = keys.map((k) => {
    const raw = localStorage.getItem(k);
    return { user_id: sbSession.user.id, key: k, value: raw == null ? null : jsonSafe(raw) };
  });
  const { error } = await sb.from("user_state").upsert(rows, { onConflict: "user_id,key" });
  if (error) {
    console.error("[sync] upload failed:", error.message || error, "— is supabase/schema.sql applied?");
    SYNC.status = "error"; SYNC.err = error.message;
  } else {
    console.info("[sync] uploaded " + keys.length + " item(s)");
    keys.forEach((k) => DIRTY.delete(k)); saveDirty();
    SYNC.status = "ok"; SYNC.err = null;
    SYNC.last = new Date().toISOString(); RAW.set("ptsync_lastok", SYNC.last);
  }
  refreshSyncCard();
}

async function pull() {
  if (!sb || !sbSession || !navigator.onLine) return;
  const since = localStorage.getItem("ptsync_last") || "1970-01-01T00:00:00Z";
  const { data, error } = await sb.from("user_state")
    .select("key,value,updated_at").gt("updated_at", since)
    .order("updated_at", { ascending: true }).limit(1000);
  if (error) { console.error("[sync] pull failed:", error.message || error); SYNC.status = "error"; SYNC.err = error.message; refreshSyncCard(); return; }
  let maxT = since, applied = 0;
  for (const r of data) {
    if (r.updated_at > maxT) maxT = r.updated_at;
    if (DIRTY.has(r.key)) continue;               // local unsent change wins
    if (r.value === null) RAW.rm(r.key);
    else RAW.set(r.key, typeof r.value === "string" ? r.value : JSON.stringify(r.value));
    applied++;
  }
  RAW.set("ptsync_last", maxT);
  if (applied && typeof buildBank === "function" && typeof render === "function") { buildBank(); render(); }
  if (SYNC.status !== "error") { SYNC.status = "ok"; refreshSyncCard(); }
}

/* ---- Settings card (app.js calls syncCardHtml() while rendering Settings) ---- */
function syncTimeStr() {
  if (!SYNC.last) return "";
  const d = new Date(SYNC.last);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " " +
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function syncCardInner() {
  if (SYNC.status === "unconfigured") return `
    <p class="note">Optional & free. Your data currently lives only on this device — cloud sync backs it up
    and follows you across devices. To enable it: create a free Supabase project, run
    <b>supabase/schema.sql</b>, and paste the project URL + publishable key into <b>sync.js</b> (see README).</p>`;
  if (SYNC.status === "starting") return `<p class="note">Starting sync…</p>`;
  // No live session → show the sign-in form, whatever the status (an error state
  // without a session must offer a way back in, not a dead "signed in" layout).
  if (!sbSession) return `
    <p class="sub">Sign in to back up your data and sync across devices. Everything keeps working offline.</p>
    ${signinFormHtml()}`;
  const state = SYNC.status === "syncing" ? "⏳ syncing…"
    : SYNC.status === "error" ? `⚠️ ${SYNC.err || "sync error"}`
    : `✅ synced${SYNC.last ? " · " + syncTimeStr() : ""}${DIRTY.size ? ` · ${DIRTY.size} pending` : ""}`;
  return `
    <p class="sub">Signed in as <b>${SYNC.email || "…"}</b></p>
    <p class="note" style="margin:0 0 10px">${state}</p>
    <div class="step-quick">
      <button type="button" class="btn" id="syncOut">Sign out</button>
    </div>
    <p class="note" style="margin-top:8px">Every change saves to your account automatically — nothing to press. Works offline and catches up when you're back online.</p>`;
}
function syncCardHtml() {
  return `<div class="card" id="syncCard"><h2>☁️ Cloud sync</h2><div id="syncBody">${syncCardInner()}</div></div>`;
}
// Shared two-step sign-in form (email → 6-digit code). Used by the auth gate, the
// onboarding sign-in card and the Settings cloud card, so all three behave identically.
function signinFormHtml() {
  if (OTP_EMAIL) {
    return `<div class="tracker-row">
        <input class="field" id="syncCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="sign-in code" />
        <button type="button" class="btn accent" id="syncVerify">Verify</button>
      </div>
      ${SYNC.err ? `<p class="note" style="color:var(--warn)">⚠️ ${SYNC.err}</p>` : ""}
      <p class="note" style="margin-top:8px">Enter the code we emailed to <b>${OTP_EMAIL}</b>.
        <button type="button" class="btn" id="syncChangeEmail" style="min-height:auto;padding:4px 9px;margin-left:4px">Use a different email</button></p>`;
  }
  return `<div class="tracker-row">
      <input class="field" id="syncEmail" type="email" inputmode="email" placeholder="you@email.com" />
      <button type="button" class="btn accent" id="syncSend">Send code</button>
    </div>
    ${SYNC.err ? `<p class="note" style="color:var(--warn)">⚠️ ${SYNC.err}</p>` : ""}
    <p class="note" style="margin-top:8px">We email you a sign-in code — no password. New here? The same code creates your account.</p>`;
}
// require-account gate: true only when accounts are enforced AND this device has never signed in.
// A device that has signed in once keeps working offline (session persists / the flag stays set).
function ptSyncRequiresAuth() {
  if (SYNC.status === "unconfigured") return false;         // offline audit / no backend configured
  if (!SYNC_CONFIG.requireAccount) return false;
  if (sbSession) return false;
  if (localStorage.getItem("ptsync_account")) return false; // already has an account on this device
  return true;
}
// The sign-in wall (app.js renders this from render() when ptSyncRequiresAuth() is true).
function authGateHtml() {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return `
  <div class="card hero"><span class="phase-tag">Exervo</span>
    <h1>Sign in to get started</h1>
    <p>Your plan, workouts and progress live in your private account and follow you across every device. One tap, no password.</p></div>
  <div class="card">
    <h2>☁️ Sign in or create your account</h2>
    ${signinFormHtml()}
    ${offline ? `<p class="note" style="color:var(--warn)">You're offline — you need a connection to sign in the first time.</p>` : ""}
    <p class="note" style="margin-top:8px">After you've signed in once on a device it keeps working offline.</p>
  </div>`;
}
// Sign-in entry point for the onboarding/welcome screen (app.js renderOnboarding):
// a returning user on a new device signs in here and their cloud data pulls down.
// Returns "" when cloud sync isn't configured — so the offline audit shows nothing.
function onboardSyncHtml() {
  if (SYNC.status === "unconfigured") return "";
  let inner;
  if (SYNC.status === "ok" || SYNC.status === "syncing") {
    inner = `<p class="note">✅ Signed in${SYNC.email ? " as <b>" + SYNC.email + "</b>" : ""}. Any data from your other devices appears automatically — otherwise just set up below.</p>`;
  } else {
    inner = signinFormHtml();
  }
  return `<div class="card" id="onboardSync"><h2>☁️ Already use Exervo?</h2>
    <p class="sub">Sign in to bring your data to this device — or set up fresh below.</p>${inner}</div>`;
}
function refreshSyncCard() {
  const el = document.getElementById("syncBody");
  if (el) el.innerHTML = syncCardInner();
  const ob = document.getElementById("onboardSync"); // keep the onboarding sign-in card live too
  if (ob) { const html = onboardSyncHtml(); if (html) ob.outerHTML = html; else ob.remove(); }
}
// app.js calls this from the "Clear all my data" flow: cloud session + cursors go too
function ptSyncOnReset() {
  DIRTY.clear(); saveDirty(); OTP_EMAIL = null;
  RAW.rm("ptsync_last"); RAW.rm("ptsync_lastok"); RAW.rm("ptsync_account"); SYNC.last = null;
  if (sb) { try { sb.auth.signOut({ scope: "local" }); } catch {} }
  sbSession = null; SYNC.email = null; SYNC.status = "signedout";
}

/* ---- wiring ---- */
async function sendCode() {
  const el = document.getElementById("syncEmail"); if (!el) return;
  const em = (el.value || "").trim();
  if (!em || em.indexOf("@") < 1) { if (typeof toast === "function") toast("Enter your email address"); return; }
  if (!sb) { if (typeof toast === "function") toast("Sync is still starting — try again in a moment"); return; }
  const { error } = await sb.auth.signInWithOtp({ email: em, options: { shouldCreateUser: true } });
  if (error) { SYNC.err = error.message; refreshSyncCard(); if (typeof render === "function") render(); if (typeof toast === "function") toast("⚠️ " + error.message); return; }
  OTP_EMAIL = em; SYNC.err = null;
  refreshSyncCard(); if (typeof render === "function") render();   // switch the UI to the code step
  if (typeof toast === "function") toast("📩 Code sent — check your email");
}
async function verifyCode() {
  const el = document.getElementById("syncCode"); if (!el) return;
  const code = (el.value || "").trim();
  if (!/^\d{4,10}$/.test(code)) { if (typeof toast === "function") toast("Enter the code from your email"); return; }
  if (!sb || !OTP_EMAIL) { if (typeof toast === "function") toast("Request a code first"); return; }
  // 'email' verifies a returning-user code; new signups need 'signup' — try both.
  let { error } = await sb.auth.verifyOtp({ email: OTP_EMAIL, token: code, type: "email" });
  if (error) { const r = await sb.auth.verifyOtp({ email: OTP_EMAIL, token: code, type: "signup" }); error = r.error; }
  if (error) { SYNC.err = error.message; refreshSyncCard(); if (typeof render === "function") render(); if (typeof toast === "function") toast("⚠️ " + error.message); return; }
  OTP_EMAIL = null; SYNC.err = null;   // success → onAuthStateChange fires SIGNED_IN → renders the app
}
document.addEventListener("click", async (e) => {
  if (e.target.id === "syncSend") return sendCode();
  if (e.target.id === "syncVerify") return verifyCode();
  if (e.target.id === "syncChangeEmail") { OTP_EMAIL = null; SYNC.err = null; refreshSyncCard(); if (typeof render === "function") render(); return; }
  if (e.target.id === "syncOut") {
    // Sign out must work even if the server round-trip fails (expired session, blip):
    // local-scope sign-out + explicit state reset, never relying on the event alone.
    RAW.rm("ptsync_account"); OTP_EMAIL = null;
    if (sb) { try { await sb.auth.signOut({ scope: "local" }); } catch (err) { console.error("[sync] sign-out:", err.message || err); } }
    sbSession = null; SYNC.email = null; SYNC.status = "signedout"; SYNC.err = null;
    refreshSyncCard(); if (typeof render === "function") render();  // straight to the sign-in gate
    if (typeof toast === "function") toast("Signed out");
  }
});
// Enter submits whichever sign-in step is showing
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "syncEmail") { e.preventDefault(); sendCode(); }
  else if (e.target.id === "syncCode") { e.preventDefault(); verifyCode(); }
});
window.addEventListener("online", () => { flush(); pull(); });          // reconnect → push queued + pull
document.addEventListener("visibilitychange", () => { if (!document.hidden) { flush(); pull(); } }); // refocus → same
initSync();
