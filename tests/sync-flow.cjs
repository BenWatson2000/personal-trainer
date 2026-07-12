/* Exervo — cloud data-flow test. Drives the REAL sync.js/app.js against a mock
   Supabase client (injected in place of the vendored lib) so we can assert the
   exact auth calls, upload payloads and pull application without live network. */
const fs = require("fs"), path = require("path"), http = require("http");
const { chromium } = require("playwright-core");
const ROOT = path.join(__dirname, "..");
function resolveChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pinned = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (fs.existsSync(pinned)) return pinned;
  try { return chromium.executablePath(); } catch { return pinned; }
}
const CHROME = resolveChrome();
const PORT = 8137;

// Mock supabase-js served in place of vendor/supabase-js.js. An in-memory user_state
// table + auth that records calls on window.__mock.
const MOCK = `
window.__mock = { log: [], store: [], session: null, otpEmail: null };
window.supabase = {
  createClient(url, key) {
    window.__mock.log.push(["createClient", url, key.slice(0,14)]);
    let authCb = null;
    const M = window.__mock;
    const fireInitial = () => setTimeout(() => authCb && authCb("INITIAL_SESSION", M.session), 0);
    return {
      auth: {
        onAuthStateChange(cb){ authCb = cb; fireInitial(); return { data:{ subscription:{ unsubscribe(){} } } }; },
        async signInWithOtp({ email, options }){ M.log.push(["signInWithOtp", email, options && options.shouldCreateUser]); M.otpEmail = email; return { data:{}, error:null }; },
        async verifyOtp({ email, token, type }){ M.log.push(["verifyOtp", email, token, type]);
          if (token === "99999999") return { data:{}, error:{ message:"Token has expired or is invalid" } }; // wrong-code path
          M.session = { user:{ id: M.forceUid || "user-AAA", email } };
          if (authCb) authCb("SIGNED_IN", M.session);
          return { data:{ session: M.session }, error:null }; },
        async signOut(opts){ M.log.push(["signOut", opts && opts.scope]); M.session = null; if (authCb) authCb("SIGNED_OUT", null); return { error:null }; },
        async getSession(){ return { data:{ session: M.session } }; },
      },
      from(table){
        const q = { head:false, filters:[] };
        const api = {
          select(cols, opts){ if (opts && opts.head) q.head = true; return api; },
          gt(col, val){ q.filters.push(["gt", col, val]); return api; },
          order(){ return api; }, limit(){ return api; },
          async upsert(rows){ M.log.push(["upsert", rows.length, rows.map(r=>r.key)]);
            for (const r of rows){ const i = M.store.findIndex(x => x.user_id===r.user_id && x.key===r.key);
              const row = { ...r, updated_at: new Date(Date.now()+M.store.length).toISOString() };
              if (i>=0) M.store[i]=row; else M.store.push(row); }
            return { error:null }; },
          then(resolve){
            if (q.head) return resolve({ count: M.store.length, error:null });
            let rows = M.store.slice();
            for (const f of q.filters) if (f[0]==="gt" && f[1]==="updated_at") rows = rows.filter(r => r.updated_at > f[2]);
            resolve({ data: rows.map(r => ({ key:r.key, value:r.value, updated_at:r.updated_at })), error:null });
          },
        };
        return api;
      },
    };
  }
};
`;

const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (f.endsWith("/")) f += "index.html";
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json" }[path.extname(f)] || "application/octet-stream", "cache-control":"no-store" });
    res.end(buf);
  });
}).listen(PORT);

let pass = 0, fail = 0;
const A = (cond, msg) => { if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.log("  ✗ FAIL — " + msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function newCtx(browser, seedRows) {
  const ctx = await browser.newContext({ viewport:{ width:390, height:844 } });
  await ctx.route("**/vendor/supabase-js.js*", (r) => r.fulfill({ contentType:"text/javascript", body: MOCK }));
  if (seedRows) await ctx.addInitScript((rows) => { window.__seedRows = rows; }, seedRows);
  // apply seed into the mock store right after it's defined
  await ctx.addInitScript(() => {
    const iv = setInterval(() => { if (window.__mock) { clearInterval(iv);
      if (window.__seedRows) window.__mock.store = window.__seedRows; } }, 5);
  });
  return ctx;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });

  // ============ FLOW 1: new user — gate → code → verify → onboarding → auto-upload ============
  console.log("\nFLOW 1 · New account: sign-in gate → code → onboarding → auto-upload");
  {
    const ctx = await newCtx(browser);
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type()==="error") errs.push(m.text().slice(0,120)); });
    await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:"domcontentloaded" });
    await sleep(700);
    A(/Sign in to get started/.test(await p.locator("#view").textContent()), "cold start shows the sign-in wall (require-account)");
    A(await p.locator("#syncEmail").count() === 1, "email step visible");

    await p.fill("#syncEmail", "ben@example.com");
    await p.click("#syncSend"); await sleep(300);
    const sentOtp = await p.evaluate(() => window.__mock.log.find(l => l[0]==="signInWithOtp"));
    A(sentOtp && sentOtp[1]==="ben@example.com" && sentOtp[2]===true, "Send code → signInWithOtp(email, shouldCreateUser:true)");
    A(await p.locator("#syncCode").count() === 1, "UI advanced to the code step");

    // wrong code first
    await p.fill("#syncCode", "99999999"); await p.click("#syncVerify"); await sleep(300);
    A(/expired or is invalid/i.test(await p.locator("#view").textContent()), "wrong code surfaces the server error, stays on code step");

    // correct code
    await p.fill("#syncCode", "12345678"); await p.click("#syncVerify"); await sleep(500);
    const verified = await p.evaluate(() => window.__mock.log.filter(l => l[0]==="verifyOtp").length);
    A(verified >= 2, "Verify → verifyOtp called (wrong + right)");
    A(!/Sign in to get started/.test(await p.locator("#view").textContent()), "session established → left the sign-in wall");
    A(await p.locator("#pfName").count() === 1, "new account (empty cloud) → onboarding form shown");
    A(await p.evaluate(() => localStorage.getItem("ptsync_account")==="ben@example.com"), "device remembered as having an account");
    A(await p.evaluate(() => localStorage.getItem("ptsync_uid")==="user-AAA"), "signed-in user id recorded");

    // complete onboarding → should auto-upload pt_profile
    await p.fill("#pfAge", "25"); await p.fill("#pfHeight", "156"); await p.fill("#pfWeight", "68");
    await p.selectOption("#pfGoal", "cut");
    await p.click("#completeOnboard"); await sleep(1200);
    A(await p.locator(".today-hero").count() === 1, "onboarding completes → lands on Today");
    const store1 = await p.evaluate(() => window.__mock.store.map(r => r.key));
    A(store1.includes("pt_profile"), "pt_profile auto-uploaded to user_state");
    A(store1.includes("pt_startDate"), "pt_startDate auto-uploaded");
    const profRow = await p.evaluate(() => window.__mock.store.find(r => r.key==="pt_profile"));
    A(profRow && profRow.value && profRow.value.goal === "cut" && profRow.value.weightKg === 68, "uploaded pt_profile value is the real object (jsonb), correct fields");
    A(profRow && profRow.user_id === "user-AAA", "row carries the authenticated user_id (RLS scoping)");

    // log water on Today → incremental auto-upload of pt_checks_*
    await p.locator('.next-strip .next-pill').first().click().catch(()=>{});
    await p.evaluate(() => { const d = new Date(); }); // noop
    // open daily log + add water
    const dailySummary = p.locator('details[data-panel="daily"] > summary');
    if (await dailySummary.count()) { await dailySummary.click(); await sleep(200);
      await p.click('[data-act="waterinc"]'); await sleep(1000);
      const checksRow = await p.evaluate(() => window.__mock.store.find(r => /^pt_checks_/.test(r.key)));
      A(!!checksRow, "ticking water auto-uploads a pt_checks_* row");
      A(checksRow && typeof checksRow.value === "object" && checksRow.value.water >= 1, "uploaded check value has water count (correct payload shape)");
    } else A(false, "daily-log panel present");

    A(errs.length === 0, "no console/page errors during the whole new-user flow" + (errs.length ? " — " + errs.slice(0,2).join(" | ") : ""));
    await ctx.close();
  }

  // ============ FLOW 2: returning user — cloud has data → pull applies it, skips onboarding ============
  console.log("\nFLOW 2 · Returning account: cloud data pulls down, no re-onboarding");
  {
    const seed = [
      { user_id:"user-AAA", key:"pt_profile", value:{ name:"Ben", sex:"male", age:25, heightCm:156, weightKg:67, activity:1.55, goal:"cut", surplus:300, dislikes:["fish"] }, updated_at:"2026-07-01T00:00:00.000Z" },
      { user_id:"user-AAA", key:"pt_startDate", value:"2026-06-22", updated_at:"2026-07-01T00:00:00.001Z" },
      { user_id:"user-AAA", key:"pt_weights", value:[{date:"2026-06-22",kg:68},{date:"2026-07-01",kg:67}], updated_at:"2026-07-01T00:00:00.002Z" },
    ];
    const ctx = await newCtx(browser, seed);
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", e => errs.push(e.message));
    await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:"domcontentloaded" });
    await sleep(700);
    await p.fill("#syncEmail", "ben@example.com"); await p.click("#syncSend"); await sleep(250);
    await p.fill("#syncCode", "12345678"); await p.click("#syncVerify"); await sleep(1500);
    A(await p.evaluate(() => localStorage.getItem("pt_profile")!==null), "pull wrote pt_profile into localStorage");
    A(await p.evaluate(() => JSON.parse(localStorage.getItem("pt_profile")).name==="Ben"), "pulled profile value is correct");
    A(await p.evaluate(() => JSON.parse(localStorage.getItem("pt_weights")).length===2), "pulled pt_weights array applied");
    A(await p.locator(".today-hero").count() === 1 && await p.locator("#pfName").count() === 0, "existing cloud data → straight to app, onboarding skipped");
    A(errs.length === 0, "no errors during returning-user pull");
    await ctx.close();
  }

  // ============ FLOW 3: sign-out returns to the gate ============
  console.log("\nFLOW 3 · Sign out → back to the sign-in wall");
  {
    const seed = [{ user_id:"user-AAA", key:"pt_profile", value:{ name:"Ben", age:25, heightCm:156, weightKg:67, goal:"cut", sex:"male", activity:1.55, surplus:300, dislikes:[] }, updated_at:"2026-07-01T00:00:00.000Z" },
      { user_id:"user-AAA", key:"pt_startDate", value:"2026-06-22", updated_at:"2026-07-01T00:00:00.001Z" }];
    const ctx = await newCtx(browser, seed);
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:"domcontentloaded" });
    await sleep(700);
    await p.fill("#syncEmail", "ben@example.com"); await p.click("#syncSend"); await sleep(250);
    await p.fill("#syncCode", "12345678"); await p.click("#syncVerify"); await sleep(1200);
    await p.click('[data-tab="settings"]'); await sleep(400);
    A(await p.locator("#syncOut").count() === 1, "Settings shows Sign out (signed-in card)");
    await p.click("#syncOut"); await sleep(700);
    A(/Sign in to get started/.test(await p.locator("#view").textContent()), "sign out → lands on the sign-in wall");
    A(await p.evaluate(() => localStorage.getItem("ptsync_account")===null), "device account flag cleared on sign out");
    const outCall = await p.evaluate(() => window.__mock.log.find(l => l[0]==="signOut"));
    A(outCall && outCall[1]==="local", "sign out used local scope (no fragile server round-trip)");
    await ctx.close();
  }

  // ============ FLOW 4: different account on same device wipes the previous user's data ============
  console.log("\nFLOW 4 · Account switch: previous user's local data is wiped, not merged");
  {
    const ctx = await newCtx(browser);
    const p = await ctx.newPage();
    // Seed a device that user-OLD previously used, but has NO live session (flag+uid+data only).
    // Guard so the seed runs once and isn't re-applied after the in-app reload.
    await p.addInitScript(() => {
      if (!localStorage.getItem("__seeded4")) {
        localStorage.setItem("ptsync_uid", "user-OLD");
        localStorage.setItem("ptsync_account", "old@example.com");
        localStorage.setItem("pt_profile", JSON.stringify({ name:"OldUser", sex:"male", age:40, heightCm:180, weightKg:90, activity:1.55, goal:"gain", surplus:300, dislikes:[] }));
        localStorage.setItem("pt_startDate", "2026-01-01");
        localStorage.setItem("pt_weights", JSON.stringify([{ date:"2026-01-01", kg:90 }]));
        localStorage.setItem("__seeded4", "1");
      }
    });
    await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil:"domcontentloaded" });
    await sleep(700);
    // Flag set + profile exists but NO live session (expired) → app opens offline for the old user.
    A(await p.locator(".today-hero").count() === 1, "device with stale account flag opens the app (offline-friendly)");
    await p.click('[data-tab="settings"]'); await sleep(400);
    // No session → Settings correctly shows the sign-in form (not a dead 'signed in' card)
    A(await p.locator("#syncEmail").count() === 1, "no-session device shows the sign-in form in Settings");
    // A DIFFERENT account now signs in on this device
    await p.evaluate(() => { window.__mock.forceUid = "user-NEW"; });
    await p.fill("#syncEmail", "new@example.com"); await p.click("#syncSend"); await sleep(250);
    await p.fill("#syncCode", "12345678"); await p.click("#syncVerify"); await sleep(1400);
    A(await p.evaluate(() => localStorage.getItem("ptsync_uid")==="user-NEW"), "new user id recorded after switch");
    A(await p.evaluate(() => { const v = localStorage.getItem("pt_profile"); return !v || JSON.parse(v).name!=="OldUser"; }), "previous user's pt_profile wiped on account switch");
    A(await p.evaluate(() => { const v = localStorage.getItem("pt_weights"); return v===null || JSON.parse(v).every(w=>w.kg!==90); }), "previous user's pt_weights wiped (no data bleed between accounts)");
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log(`\n==== data-flow: ${pass} passed, ${fail} failed ====`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log("FATAL", e.stack); server.close(); process.exit(1); });
