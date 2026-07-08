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
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 2500);
}

/* ---- boot ---- */
async function initSync() {
  // The UI audit runs fully offline & deterministic — never reach for the network there.
  if (typeof window !== "undefined" && window.__PT_NO_CLOUD) { SYNC.status = "unconfigured"; return; }
  if (SYNC.status === "unconfigured") return;
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    sb = createClient(SYNC_CONFIG.url, SYNC_CONFIG.key);
    sb.auth.onAuthStateChange((event, session) => {
      sbSession = session;
      SYNC.email = session ? session.user.email : null;
      SYNC.status = session ? "ok" : "signedout";
      if (session) RAW.set("ptsync_account", session.user.email); // remember: this device has an account
      refreshSyncCard();
      if (typeof render === "function") render();                 // enter/leave the sign-in gate
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) firstSyncOrPull();
    });
  } catch (e) { SYNC.status = "error"; SYNC.err = "Couldn't load sync library (offline?)"; refreshSyncCard(); }
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
  if (SYNC.status === "signedout") return `
    <p class="sub">Sign in to back up your data and sync across devices. Everything keeps working offline.</p>
    <div class="tracker-row">
      <input class="field" id="syncEmail" type="email" inputmode="email" placeholder="you@email.com" />
      <button type="button" class="btn accent" id="syncSend">Send link</button>
    </div>
    <p class="note" style="margin-top:8px">We email you a magic sign-in link — no password. Your data is only ever visible to you.</p>`;
  const state = SYNC.status === "syncing" ? "⏳ syncing…"
    : SYNC.status === "error" ? `⚠️ ${SYNC.err || "sync error"}`
    : `✅ synced${SYNC.last ? " · " + syncTimeStr() : ""}${DIRTY.size ? ` · ${DIRTY.size} pending` : ""}`;
  return `
    <p class="sub">Signed in as <b>${SYNC.email || "…"}</b></p>
    <p class="note" style="margin:0 0 10px">${state}</p>
    <div class="step-quick">
      <button type="button" class="btn accent" id="syncNow">⟳ Sync now</button>
      <button type="button" class="btn" id="syncOut">Sign out</button>
    </div>
    <p class="note" style="margin-top:8px">Every change mirrors to your private cloud backup a few seconds after you make it.</p>`;
}
function syncCardHtml() {
  return `<div class="card" id="syncCard"><h2>☁️ Cloud sync</h2><div id="syncBody">${syncCardInner()}</div></div>`;
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
  <div class="card hero"><span class="phase-tag">My PT</span>
    <h1>Sign in to get started</h1>
    <p>Your plan, workouts and progress live in your private account and follow you across every device. One tap, no password.</p></div>
  <div class="card">
    <h2>☁️ Sign in or create your account</h2>
    <div class="tracker-row">
      <input class="field" id="syncEmail" type="email" inputmode="email" placeholder="you@email.com" />
      <button type="button" class="btn accent" id="syncSend">Send link</button>
    </div>
    ${SYNC.status === "error" ? `<p class="note" style="color:var(--warn)">⚠️ ${SYNC.err || "sync error"}</p>` : ""}
    ${offline ? `<p class="note" style="color:var(--warn)">You're offline — you need a connection to sign in the first time.</p>` : ""}
    <p class="note" style="margin-top:8px">We email you a one-tap sign-in link. New here? The same link creates your account and confirms your email — no password to remember. After you've signed in once on a device it keeps working offline.</p>
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
    inner = `<div class="tracker-row">
        <input class="field" id="syncEmail" type="email" inputmode="email" placeholder="you@email.com" />
        <button type="button" class="btn accent" id="syncSend">Send sign-in link</button>
      </div>
      ${SYNC.status === "error" ? `<p class="note" style="color:var(--warn)">⚠️ ${SYNC.err || "sync error"}</p>` : ""}
      <p class="note" style="margin-top:8px">One tap, no password — clicking the emailed link brings your profile, workouts and history to this device.</p>`;
  }
  return `<div class="card" id="onboardSync"><h2>☁️ Already use My PT?</h2>
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
  DIRTY.clear(); saveDirty();
  RAW.rm("ptsync_last"); RAW.rm("ptsync_lastok"); RAW.rm("ptsync_account"); SYNC.last = null;
  if (sb) sb.auth.signOut();
}

/* ---- wiring ---- */
document.addEventListener("click", async (e) => {
  if (e.target.id === "syncSend") {
    const em = (document.getElementById("syncEmail").value || "").trim();
    if (!em || em.indexOf("@") < 1) { if (typeof toast === "function") toast("Enter your email address"); return; }
    if (!sb) { if (typeof toast === "function") toast("Sync is still starting — try again in a moment"); return; }
    const { error } = await sb.auth.signInWithOtp({ email: em, options: { emailRedirectTo: location.href.split("#")[0] } });
    if (typeof toast === "function") toast(error ? "⚠️ " + error.message : "📩 Check your email for the sign-in link");
  }
  if (e.target.id === "syncNow") { await pull(); queueAllLocal(); await flush(); if (typeof toast === "function") toast(SYNC.status === "ok" ? "☁️ Synced" : "⚠️ " + (SYNC.err || "sync error")); }
  if (e.target.id === "syncOut") { RAW.rm("ptsync_account"); sb.auth.signOut(); if (typeof toast === "function") toast("Signed out"); } // onAuthStateChange re-renders → sign-in gate
});
window.addEventListener("online", () => { flush(); pull(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) pull(); });
initSync();
