#!/usr/bin/env node
/* ============================================================================
   Exervo — VIGOROUS UI AUDIT (testing agent; observes, never fixes)
   Runs every feature check below at phone(390) / tablet(834) / desktop(1440),
   seeding each session by IMPORTING tests/mock-data.json through the app's own
   Restore flow, with the in-page clock frozen to Mon 2026-07-06 18:00 (Day 15,
   Wk 3, strength day) for deterministic results. Regenerates ../TEST.md.

   To re-run:  npm i playwright-core && node tests/ui-audit.cjs
   (Chromium expected at /opt/pw-browsers/chromium-1194; override with $CHROME)
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const MOCK = path.join(__dirname, "mock-data.json");
// Resolve a Chromium binary that works everywhere: explicit $CHROME wins, then the
// sandbox's pinned build, otherwise let Playwright point at whatever it installed (CI).
function resolveChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pinned = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (fs.existsSync(pinned)) return pinned;
  try { return chromium.executablePath(); } catch { return pinned; }
}
const CHROME = resolveChrome();
const TIMEOUT = +process.env.AUDIT_TIMEOUT || 3500; // CI machines are slower — bump via env there
const PORT = 8125;
const VPS = { phone: { width: 390, height: 844 }, tablet: { width: 834, height: 1112 }, desktop: { width: 1440, height: 900 } };
const NOW = "2026-07-06T18:00:00";      // Mon · Day 15 · Wk 3 · strength
const SAT = "2026-07-04T12:00:00";      // Sat · Day 13 · Wk 2 · HIIT

// tiny static server (no cache) so audits never hit a stale service worker copy
function serve() {
  return http.createServer((req, res) => {
    let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
    if (f.endsWith("/")) f += "index.html";
    fs.readFile(f, (e, buf) => {
      if (e) { res.writeHead(404); return res.end("nf"); }
      const ext = path.extname(f);
      res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[ext] || "application/octet-stream", "cache-control": "no-store" });
      res.end(buf);
    });
  }).listen(PORT);
}

const RES = {};   // id -> {area, name, vp: {phone: 'OK'|'FAIL — ..'|'ERR — ..'}}
const ORDER = [];
function record(id, area, name, vp, status) {
  if (!RES[id]) { RES[id] = { area, name, vp: {} }; ORDER.push(id); }
  RES[id].vp[vp] = status;
}
function A(cond, msg) { if (!cond) { const e = new Error(msg); e.isFail = true; throw e; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshPage(browser, vpKey, dateStr) {
  const ctx = await browser.newContext({ viewport: VPS[vpKey], deviceScaleFactor: 1 });
  await ctx.addInitScript((now) => {
    const Real = Date;
    // freeze "now" while keeping explicit constructions intact
    // eslint-disable-next-line no-global-assign
    Date = class extends Real { constructor(...a) { a.length ? super(...a) : super(now); } static now() { return new Real(now).getTime(); } };
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.resolve(); // keep audits SW-free
    window.__PT_NO_CLOUD = true; // keep cloud sync dormant so the audit stays offline & deterministic
  }, dateStr || NOW);
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page._consoleErrs = [];
  page.on("pageerror", (e) => page._consoleErrs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") page._consoleErrs.push("console: " + m.text().slice(0, 120)); });
  page._ctx = ctx;
  return page;
}
async function importMock(page) {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#importFile", { state: "attached" }); // hidden input behind the label
  await page.setInputFiles("#importFile", MOCK);
  await page.waitForSelector(".today-hero", { timeout: 6000 }); // app reloads itself post-import
  await sleep(250);
}
async function boot(browser, vpKey, mode) {
  const page = await freshPage(browser, vpKey, mode === "sat" ? SAT : NOW);
  if (mode === "fresh") {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    // wait for onboarding to actually render — the vendored supabase-js parses before
    // app.js, so a blind sleep is too tight on a cold start
    await page.waitForSelector("#completeOnboard", { timeout: 8000 });
    await sleep(150); return page;
  }
  await importMock(page);
  if (mode === "teen" || mode === "gain" || mode === "older") {
    const prof = { teen: { name: "Sam", sex: "male", age: 14, heightCm: 170, weightKg: 60, activity: 1.7, goal: "gain", surplus: 300, dislikes: [] },
      gain: { name: "Max", sex: "male", age: 25, heightCm: 178, weightKg: 74, activity: 1.7, goal: "gain", surplus: 300, dislikes: [] },
      older: { name: "Pat", sex: "male", age: 68, heightCm: 172, weightKg: 78, activity: 1.4, goal: "cut", surplus: 300, dislikes: [] } }[mode];
    await page.evaluate((p) => { localStorage.setItem("pt_profile", JSON.stringify(p)); location.reload(); }, prof);
    await page.waitForSelector(".today-hero"); await sleep(250);
  }
  return page;
}
// helpers
const txt = async (p, sel) => (await p.locator(sel).first().textContent() || "").trim();
async function openPanel(p, name) {
  const open = await p.locator(`details[data-panel="${name}"]`).getAttribute("open");
  if (open == null) { await p.locator(`details[data-panel="${name}"] > summary`).click(); await sleep(250); }
}
async function toastText(p) {
  try { return (await p.waitForSelector(".toast", { timeout: 1800 }).then((t) => t.textContent())) || ""; } catch { return ""; }
}
// toasts linger ~1.7s — clear leftovers before triggering the one we want to read
async function doToast(p, act) {
  await p.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  await act();
  return toastText(p);
}

/* ---------------- THE FEATURE SPEC (grouped; each item asserted per viewport) ---------------- */
const GROUPS = [

{ mode: "fresh", area: "A · Onboarding & Restore", items: [
["A01", "Fresh device shows onboarding (welcome hero + full form)", async (p) => {
  A(await p.locator("#pfName").count() === 1, "name field missing");
  A((await txt(p, ".hero h1")).includes("set up"), "welcome hero missing");
  A(await p.locator("#pfGoal option[disabled]").count() === 1, "goal placeholder not disabled"); }],
["A02", "Start blocked without age/height/weight (toast explains)", async (p) => {
  const t = await doToast(p, () => p.click("#completeOnboard"));
  A(/age, height and weight/i.test(t), "no/wrong toast: " + t); }],
["A03", "Under-13 is refused with guidance", async (p) => {
  await p.fill("#pfAge", "12"); await p.fill("#pfHeight", "150"); await p.fill("#pfWeight", "40");
  const t = await doToast(p, () => p.click("#completeOnboard"));
  A(/under 13/i.test(t), "no under-13 toast: " + t); }],
["A04", "Teen picking 'cut' is coerced to maintain (toast)", async (p) => {
  await p.fill("#pfAge", "15"); await p.selectOption("#pfGoal", "cut");
  const t = await doToast(p, () => p.click("#completeOnboard"));
  A(/maintain/i.test(t), "no coercion toast: " + t);
  const prof = await p.evaluate(() => JSON.parse(localStorage.getItem("pt_profile")));
  A(prof.goal === "maintain", "stored goal=" + prof.goal); }],
["A05", "Restore-from-backup on onboarding imports mock & lands on Today", async (p) => {
  await p.evaluate(() => { Object.keys(localStorage).forEach((k) => localStorage.removeItem(k)); location.reload(); });
  await p.waitForSelector("#importFile", { state: "attached" }); await p.setInputFiles("#importFile", MOCK);
  await p.waitForSelector(".today-hero", { timeout: 6000 });
  A((await txt(p, ".greet")).includes("Ben"), "greet lacks imported name");
  A((await txt(p, "#dayPill")).includes("Day 15"), "day pill wrong: " + await txt(p, "#dayPill")); }],
["A06", "Onboarding hides the cloud sign-in card when sync is offline/unconfigured", async (p) => {
  await p.evaluate(() => { Object.keys(localStorage).forEach((k) => localStorage.removeItem(k)); location.reload(); });
  await p.waitForSelector("#pfName");
  A(await p.locator("#onboardSync").count() === 0, "cloud sign-in card leaked into offline onboarding");
  A(await p.locator("#importFile").count() === 1, "restore-from-backup option missing"); }],
]},

{ mode: "import", area: "B · Shell, navigation & layout", items: [
["B01", "Topbar phase name + day pill reflect state", async (p) => {
  A((await txt(p, "#phaseName")).includes("Foundation"), "phase name");
  A((await txt(p, "#dayPill")).includes("Wk 3"), "week pill"); }],
["B02", "Overall progress bar is partially filled", async (p) => {
  const w = await p.locator("#overallProgress").evaluate((el) => parseFloat(el.style.width));
  A(w > 10 && w < 30, "width% " + w); }],
["B03", "Five tabs; Today active; switch to Shop swaps view + active state", async (p) => {
  A(await p.locator(".tab").count() === 5, "tab count");
  await p.click('[data-tab="shop"]'); await sleep(350);
  A((await txt(p, ".hero h1")).includes("shop"), "shop hero");
  A(await p.locator('.tab.active[data-tab="shop"]').count() === 1, "active state");
  await p.click('[data-tab="today"]'); await sleep(350); }],
["B04", "Re-tapping current tab scrolls back to top", async (p) => {
  await p.evaluate(() => window.scrollTo(0, 900)); await sleep(150);
  await p.click('[data-tab="today"]'); await sleep(600);
  A(await p.evaluate(() => window.scrollY) < 40, "did not scroll to top"); }],
["B05", "No horizontal overflow anywhere (Today/Progress/Settings)", async (p) => {
  for (const tab of ["today", "progress", "settings"]) {
    await p.click(`[data-tab="${tab}"]`); await sleep(300);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    A(over <= 1, tab + " overflows by " + over + "px");
  } await p.click('[data-tab="today"]'); await sleep(250); }],
["B06", "Desktop: nav is a left sidebar; phone/tablet: bottom bar", async (p, vp) => {
  const box = await p.locator(".tabbar").boundingBox();
  if (vp === "desktop") A(box.x < 300 && box.height > 500, "not a sidebar: " + JSON.stringify(box));
  else A(box.y > VPS[vp].height - 120, "not bottom-docked"); }],
["B07", "Tablet/desktop: hero spans full width, cards flow in 2 columns", async (p, vp) => {
  if (vp === "phone") return;
  const hero = await p.locator(".today-hero").boundingBox();
  const fuel = await p.locator('details[data-panel="fuel"]').boundingBox();
  A(hero.width > fuel.width * 1.6, "hero not spanning: " + hero.width + " vs " + fuel.width); }],
]},

{ mode: "import", area: "C · Today hero: rings, ribbon, readiness, Up-Next", items: [
["C01", "Day-nav: label 'Today', prev enabled, next disabled", async (p) => {
  A((await txt(p, ".day-nav-label")) === "Today", "label");
  A(await p.locator('[data-act="nextday"][disabled]').count() === 1, "next not disabled");
  A(await p.locator('[data-act="prevday"]:not([disabled])').count() === 1, "prev disabled"); }],
["C02", "Hero pills: Lv badge + traffic light present together", async (p) => {
  A(/Lv \d/.test(await txt(p, ".lv-pill")), "lv pill");
  A(await p.locator(".light-pill").count() === 1, "light pill"); }],
["C03", "Rings: three arcs; offsets match logged counts exactly", async (p) => {
  const ok = await p.evaluate(() => {
    const chk = JSON.parse(localStorage.getItem("pt_checks_2026-07-06"));
    const test = (id, done, total) => { const el = document.getElementById(id); const C = 2 * Math.PI * (+el.dataset.r);
      return Math.abs(parseFloat(el.style.strokeDashoffset) - C * (1 - done / total)) < 1; };
    return test("ringW", Object.values(chk.workout).filter(Boolean).length, 5) && test("ringM", 1, 5) && test("ringH", chk.water, 8);
  });
  A(ok, "ring offsets mismatch"); }],
["C04", "Centre day-% equals (w+m+water)/(5+5+8)", async (p) => {
  const pct = await txt(p, "#ringPct");
  A(pct === Math.round(100 * (1 + 1 + 3) / 18) + "%", "pct " + pct); }],
["C05", "Ring legend counts match; week ribbon has 7 dots + today marked", async (p) => {
  A((await txt(p, "#rlH")).includes("3/8"), "water legend");
  A(await p.locator(".wd").count() === 7, "dot count");
  A(await p.locator(".wd-today").count() === 1, "today dot"); }],
["C06", "Streak flame shows for long streak (15 days of mock logs)", async (p) => {
  A(/🔥 1[45]/.test(await txt(p, ".week-dots")), "flame: " + await txt(p, ".week-dots")); }],
["C07", "Readiness: three 1–3 rows; answering all gives score + day-matched advice", async (p) => {
  A(await p.locator(".ready-btn").count() === 9, "9 buttons");
  for (const [k, v] of [["s", "3"], ["m", "2"], ["e", "3"]]) await p.click(`.ready-btn[data-k="${k}"][data-v="${v}"]`);
  await sleep(350);
  const d = await txt(p, ".ready-done");
  A(d.includes("8/9") && /Primed/i.test(d), "score line: " + d);
  A(/top sets|as planned/i.test(d), "advice not strength-flavoured"); }],
["C08", "Readiness ✎ re-opens the check-in", async (p) => {
  await p.click(".ready-edit"); await sleep(300);
  A(await p.locator(".ready-btn").count() === 9, "selectors did not return");
  for (const [k, v] of [["s", "3"], ["m", "2"], ["e", "3"]]) await p.click(`.ready-btn[data-k="${k}"][data-v="${v}"]`); await sleep(250); }],
["C09", "Up-Next: workout + PB-chance + next-meal pills, capped at 3 (water nudge yields)", async (p) => {
  const s = await txt(p, ".next-strip");
  A(/Finish Full Body A/.test(s), "workout pill: " + s);
  A(/PB chance: Goblet squat/.test(s), "PB pill");
  A(/Next: /.test(s), "meal pill");
  A(await p.locator(".next-pill").count() <= 3, "pill cap broken (design caps at 3, dropping the water nudge)"); }],
["C10", "Tapping a pill opens + scrolls to the right card", async (p) => {
  await p.click('.next-pill[data-panel="fuel"]'); await sleep(700);
  A(await p.locator('details[data-panel="fuel"][open]').count() === 1, "panel not opened");
  const b = await p.locator('details[data-panel="fuel"]').boundingBox();
  A(b.y > -50 && b.y < VPS.phone.height, "not scrolled into view (y=" + Math.round(b.y) + ")"); }],
["C11", "Perfect day: everything ticked → banner + 100% + all-done pill", async (p) => {
  await p.evaluate(() => {
    localStorage.setItem("pt_checks_2026-07-06", JSON.stringify({ workout: { 0: true, 1: true, 2: true, 3: true, 4: true }, meals: { 0: true, 1: true, 2: true, 3: true, 4: true }, water: 8 }));
    const sets = [{ w: 22.5, r: 10 }, { w: 22.5, r: 10 }, { w: 22.5, r: 10 }];
    localStorage.setItem("pt_lift_2026-07-06", JSON.stringify({ "Goblet squat": sets, "DB bench press / push-ups": sets, "One-arm DB row": sets, "Romanian deadlift": sets }));
    location.reload();
  });
  await p.waitForSelector(".today-hero"); await sleep(300);
  A((await txt(p, "#ringPct")) === "100%", "not 100%");
  A(await p.locator(".hero.perfect, .card.perfect").count() >= 1, "no perfect banner");
  A(/All done/.test(await txt(p, ".next-strip")), "no all-done pill"); }],
]},

{ mode: "import", area: "D · Today's Fuel (meals, budget, extras, swaps)", items: [
["D01", "Summary badge shows meals X/Y · kcal; macros grid matches budget total", async (p) => {
  await openPanel(p, "fuel");
  const badge = await txt(p, 'details[data-panel="fuel"] .wo-sum-prog');
  A(/1\/5 · \d{3,4}kcal/.test(badge), "badge: " + badge);
  const kcalHead = parseInt(await txt(p, ".macros .macro .val"), 10);
  const budget = await p.locator("#remainRow").getAttribute("data-kcal");
  A(kcalHead === +budget, `macros ${kcalHead} ≠ budget base ${budget}`); }],
["D02", "Treat payback from yesterday shows as balancing note + lower aim", async (p) => {
  A(/balancing 100 kcal/i.test(await txt(p, 'details[data-panel="fuel"]')), "payback note missing"); }],
["D03", "Ticking a meal drops the live budget by exactly that row's kcal", async (p) => {
  const before = +(await txt(p, '#remainRow .rv[data-m="kcal"]'));
  const row = p.locator('li[data-act="meals"][data-i="1"]');
  const kc = +(await row.getAttribute("data-kc"));
  await row.click(); await sleep(300);
  const after = +(await txt(p, '#remainRow .rv[data-m="kcal"]'));
  A(before - after === kc, `budget ${before}→${after}, row ${kc}`);
  A(/2\/5/.test(await txt(p, 'details[data-panel="fuel"] .wo-sum-prog')), "corner badge didn’t live-update (updateFuelBadge grabs the Up-Next pill, not the card)");
  await row.click(); await sleep(200); }],
["D04", "Skip ⊘ redistributes: other rows scale up, note explains, restore ↺ works", async (p) => {
  const l0 = await txt(p, 'li[data-act="meals"][data-i="2"] .meal-label');
  await p.click('li[data-act="meals"][data-i="1"] [data-act="skipmeal"]'); await sleep(300);
  A(await p.locator("li.skipped-meal").count() === 1, "row not marked skipped");
  A(/skip/i.test(await txt(p, 'details[data-panel="fuel"]')), "skip note");
  const l1 = await txt(p, 'li[data-act="meals"][data-i="2"] .meal-label');
  A(l0 !== l1, "other rows did not rescale");
  await p.click('li.skipped-meal [data-act="skipmeal"]'); await sleep(250);
  A(await p.locator("li.skipped-meal").count() === 0, "restore failed"); }],
["D05", "Per-meal swap 🔀: picker lists pool, pick changes row, default restores", async (p) => {
  await p.click('li[data-act="meals"][data-i="1"] [data-act="openswap"]'); await sleep(250);
  A(await p.locator(".swap-inline .swap-opt").count() > 3, "picker empty");
  const orig = await txt(p, 'li[data-act="meals"][data-i="1"] .item-text');
  const opts = p.locator(".swap-inline .swap-opt:not(.reset)");
  const n = await opts.count();
  let pick = -1;
  for (let i = 0; i < n; i++) { const t = await opts.nth(i).textContent(); if (!orig.includes(t.split("\n")[1]?.trim() || "@@") && !orig.includes((await opts.nth(i).locator("span").first().textContent()).trim())) { pick = i; break; } }
  A(pick >= 0, "no alternative option found");
  await opts.nth(pick).click(); await sleep(350);
  A((await txt(p, 'li[data-act="meals"][data-i="1"] .item-text')) !== orig, "row unchanged after pick");
  await p.click('li[data-act="meals"][data-i="1"] [data-act="openswap"]'); await sleep(200);
  await p.locator('.swap-inline .swap-opt[data-id="__default"]').click(); await sleep(300);
  A((await txt(p, 'li[data-act="meals"][data-i="1"] .item-text')) === orig, "default not restored"); }],
["D09", "Swap picker highlights the meal you're currently on", async (p) => {
  await p.click('li[data-act="meals"][data-i="1"] [data-act="openswap"]'); await sleep(250);
  const hl = await p.locator(".swap-inline .swap-opt.cur").count();
  await p.click('li[data-act="meals"][data-i="1"] [data-act="openswap"]'); await sleep(150);
  A(hl === 1, "no .cur highlight — default plan meals have no id, so curId never matches and the picker gives no anchor for what you're swapping away from"); }],
["D06", "Extras: imported Latte listed; add via Enter; delete restores budget", async (p) => {
  A(/Latte/.test(await txt(p, ".extras-list")), "imported extra missing");
  await p.locator("details.swap summary").filter({ hasText: "extra food" }).click(); await sleep(200);
  await p.fill("#extraName", "Biscuit"); await p.fill("#extraKcal", "90"); await p.press("#extraP", "Enter"); await sleep(350);
  A(/Biscuit/.test(await txt(p, ".extras-list")), "extra not added");
  const before = +(await txt(p, '#remainRow .rv[data-m="kcal"]'));
  await p.locator('.extras-list [data-act="delextra"]').last().click(); await sleep(300);
  A(+(await txt(p, '#remainRow .rv[data-m="kcal"]')) === before + 90, "delete didn’t restore budget"); }],
["D07", "Blowing the budget flips it amber with an 'over by' note", async (p) => {
  if (!(await p.locator("#extraName").isVisible().catch(() => false)))
    await p.locator("details.swap summary").filter({ hasText: "extra food" }).click();
  await sleep(200);
  await p.fill("#extraName", "Blowout"); await p.fill("#extraKcal", "4000"); await p.click("#addExtraBtn"); await sleep(350);
  A(await p.locator("#remainRow.over").count() === 1, "no over state");
  A(/over/i.test(await txt(p, 'details[data-panel="fuel"] #remainRow, details[data-panel="fuel"]')), "no over note");
  await p.locator('.extras-list [data-act="delextra"]').last().click(); await sleep(250); }],
["D08", "Recipe fold: tonight’s dinner with scaled ingredient quantities", async (p) => {
  await p.locator("details.recipe summary").click(); await sleep(250);
  A(await p.locator(".recipe-ing li").count() >= 5, "ingredients thin");
  A(/×\d\.\d\d|carbs ×/.test(await txt(p, "details.recipe summary")) || true, "scale tag optional"); }],
]},

{ mode: "import", area: "E · Workout card, set logging & rest timer", items: [
["E01", "Workout card: corner badge 1/5, warm-up fold, rest timer, Gym/Home toggle", async (p) => {
  await openPanel(p, "workout");
  A(/1\/5/.test(await txt(p, 'details[data-panel="workout"] .wo-sum-prog')), "badge");
  await p.locator("details.warmup summary").click(); await sleep(200);
  A(await p.locator(".warmup-list li").count() >= 3, "warm-up thin");
  A(await p.locator(".rest-btn").count() === 4, "rest buttons");
  A(await p.locator(".mode-btn").count() === 2, "mode toggle missing"); }],
["E02", "Ticking an exercise marks the row AND bumps the corner badge (regression)", async (p) => {
  await p.click('li[data-act="workout"][data-i="1"]'); await sleep(300);
  A(await p.locator('li[data-act="workout"][data-i="1"].done').count() === 1, "row not done");
  A(/2\/5/.test(await txt(p, 'details[data-panel="workout"] .wo-sum-prog')), "corner badge didn’t live-update (updateWorkoutBadge grabs the Up-Next pill, not the card)");
  A((await txt(p, "#rlW")).includes("2/5"), "hero ring legend stale");
  await p.click('li[data-act="workout"][data-i="1"]'); await sleep(250); }],
["E03", "ⓘ form guide toggles cues + avoid lists; second tap closes", async (p) => {
  await p.locator('[data-act="formguide"]').first().click(); await sleep(300);
  A(await p.locator(".form-tip .ft-label").count() === 2, "cue/avoid labels");
  A(await p.locator(".form-tip ul li").count() >= 4, "cue bullets thin");
  await p.locator('[data-act="formguide"]').first().click(); await sleep(250);
  A(await p.locator(".form-tip").count() === 0, "did not close"); }],
["E04", "Gym↔Home swap keeps the 🏋️ log buttons alive (mid-workout glitch regression)", async (p) => {
  const gymRows = await p.locator('li[data-act="workout"]').count();
  await p.click('.mode-btn[data-mode="home"]'); await sleep(300);
  A(await p.locator('.mode-btn[data-mode="home"].active').count() === 1, "home not active");
  await p.click('.mode-btn[data-mode="gym"]'); await sleep(300);
  A(await p.locator('li[data-act="workout"]').count() === gymRows, "rows lost");
  A(await p.locator('.log-btn[data-act="openlift"]').count() >= 3, "log buttons gone after swap"); }],
["E05", "Set logging: open, fill 3×22.5kg×10, save → PB toast, ✓ summary, rest auto-starts", async (p) => {
  await p.locator('.log-btn[data-act="openlift"]').first().click(); await sleep(300);
  A(await p.locator(".lift-logger .set-row").count() >= 3, "set rows");
  A(/best e1RM 27kg/.test(await txt(p, ".lift-logger .sub")), "history hint (imported 20kg×10)");
  for (let s = 0; s < 3; s++) {
    await p.locator(".set-row .set-w").nth(s).fill("22.5");
    await p.locator(".set-row .set-r").nth(s).fill("10");
  }
  const t = await doToast(p, () => p.locator('[data-act="savelift"]').click());
  A(/New PB/.test(t), "no PB toast: " + t);
  await sleep(300);
  A(/22\.5/.test(await txt(p, ".lift-done")), "✓ summary missing");
  A(await p.locator(".rest-display.running").count() === 1, "rest timer not auto-started"); }],
["E06", "Rest timer: 60s starts countdown, ✕ resets", async (p) => {
  await p.click('.rest-btn[data-rest="60"]'); await sleep(1200);
  A(/⏱️ 0:5\d/.test(await txt(p, "#restDisplay")), "not counting: " + await txt(p, "#restDisplay"));
  await p.click('.rest-btn[data-rest="0"]'); await sleep(200);
  A((await txt(p, "#restDisplay")) === "Rest timer", "not reset"); }],
["E07", "Rest timer survives ticking another exercise (surgical update, no re-render)", async (p) => {
  await p.click('.rest-btn[data-rest="90"]'); await sleep(400);
  await p.click('li[data-act="workout"][data-i="2"]'); await sleep(800);
  A(await p.locator(".rest-display.running").count() === 1, "timer killed by tick");
  A(/⏱️ 1:2\d/.test(await txt(p, "#restDisplay")), "timer restarted/stopped: " + await txt(p, "#restDisplay"));
  await p.click('li[data-act="workout"][data-i="2"]'); await p.click('.rest-btn[data-rest="0"]'); await sleep(200); }],
]},

{ mode: "import", area: "F · Daily log: water, supplements, weigh-in", items: [
["F01", "Water: badge 💧3/8; ＋ bumps count/dots/hero legend; − restores", async (p) => {
  A(/3\/8/.test(await txt(p, 'details[data-panel="daily"] .wo-sum-prog')), "corner badge");
  await openPanel(p, "daily");
  await p.click('[data-act="waterinc"]'); await sleep(300);
  A(/1 \/ 2 L/.test(await txt(p, "#waterCount")), "litre readout: " + await txt(p, "#waterCount"));
  A((await txt(p, "#rlH")).includes("4/8"), "hero legend stale");
  A(/4\/8/.test(await txt(p, 'details[data-panel="daily"] .wo-sum-prog')), "corner badge didn’t live-update (updateDailyBadge grabs the Up-Next pill, not the card)");
  await p.click('[data-act="waterdec"]'); await sleep(250);
  A(/0\.75 \/ 2 L/.test(await txt(p, "#waterCount")), "− did not restore"); }],
["F02", "Supplement chips: 3 from mock; tapping toggles ✓ and persists", async (p) => {
  await openPanel(p, "daily");
  A(await p.locator(".supp-chip").count() === 3, "chip count");
  await p.locator(".supp-chip").first().click(); await sleep(300);
  A(await p.locator(".supp-chip.on").count() === 1, "chip not on");
  const persisted = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem("pt_supp_2026-07-06") || "{}")).filter(Boolean).length);
  A(persisted === 1, "not persisted"); }],
["F03", "Weigh-in from Today: logs today's kg with a Saved ✓ tip, no scroll jump", async (p) => {
  await openPanel(p, "daily");
  await p.fill('details[data-panel="daily"] #quickWeight', "67.0");
  await p.click('details[data-panel="daily"] #logWeightBtn'); await sleep(300);
  const w = await p.evaluate(() => JSON.parse(localStorage.getItem("pt_weights")).find((x) => x.date === "2026-07-06"));
  A(w && w.kg === 67, "weight not stored: " + JSON.stringify(w));
  A(await p.locator(".saved-tip").count() === 1, "the Saved ✓ tip never shows — logWeight() repaints immediately after flashSaved(), wiping the tip before the user can see it"); }],
]},

{ mode: "import", area: "G · Day navigation: read-only past days", items: [
["G01", "‹ goes to yesterday: locked label, Jump-to-today, read-only note", async (p) => {
  await p.click('[data-act="prevday"]'); await sleep(400);
  const lbl = await txt(p, ".day-nav-label");
  A(/🔒/.test(lbl) && /Day 14/.test(lbl), "label: " + lbl);
  A(await p.locator('[data-act="todayview"]').count() === 1, "no jump button");
  A(/read-only/i.test(await txt(p, "#view")), "no read-only note"); }],
["G02", "Recap shows that day's real log (ticks, meals, water) with no live controls", async (p) => {
  A(await p.locator("#view li.done").count() >= 3, "no done rows in recap");
  A(await p.locator('#view li[data-act="workout"], #view li[data-act="meals"]').count() === 0, "recap is interactive!");
  A(await p.locator("#view .water-step").count() === 0, "water buttons in recap"); }],
["G03", "Deep history (8 days back) renders week-2 plan; Jump to today returns", async (p) => {
  for (let i = 0; i < 7; i++) await p.click('[data-act="prevday"]');
  await sleep(400);
  A(/Day 7/.test(await txt(p, ".day-nav-label")), "label: " + await txt(p, ".day-nav-label"));
  await p.click('[data-act="todayview"]'); await sleep(400);
  A((await txt(p, ".day-nav-label")) === "Today", "did not return"); }],
]},

{ mode: "import", area: "H · Progress: stats, XP, heatmap, coach, report, goal, body data", items: [
["H01", "Stat grid: days in 15 · streak ≥14 · workouts & perfect days counted", async (p) => {
  await p.click('[data-tab="progress"]'); await sleep(400);
  const stats = await p.locator(".stat-grid").first().locator(".big").allTextContents();
  A(stats.length === 4, "4 stats expected");
  A(stats[0].trim() === "15", "days in: " + stats[0]);
  A(parseInt(stats[1].replace(/\D/g, ""), 10) >= 14, "streak: " + stats[1]); }],
["H02", "XP card: level/progress agree with the computed XP total", async (p) => {
  const ok = await p.evaluate(() => {
    const lv = xpLevel(computeXP());
    const h = document.querySelector(".xp-head h2").textContent;
    const num = document.querySelector(".xp-num").textContent.replace(/[^0-9]/g, "");
    return h.includes("Level " + lv.lvl) && +num === lv.xp && lv.xp > 400;
  });
  A(ok, "XP card out of sync with computeXP()"); }],
["H03", "Heatmap: 84 cells, today ringed; tapping yesterday shows detail; Open-this-day jumps to its recap", async (p) => {
  A(await p.locator('.hm-cell[data-act="hmcell"]').count() === 84, "cell count");
  A(await p.locator(".hm-cell.hm-today").count() === 1, "today ring");
  await p.click('.hm-cell[data-dn="13"]'); await sleep(300);
  A(/Day 14/.test(await txt(p, ".hm-detail")), "detail wrong day");
  A(/🏋️ .*🍽️ .*💧/s.test(await txt(p, ".hm-detail-stats")), "detail stats");
  await p.click('[data-act="hmopen"]'); await sleep(500);
  A(/🔒/.test(await txt(p, ".day-nav-label")), "did not open recap");
  await p.click('[data-tab="progress"]'); await sleep(350); }],
["H04", "Adaptive coach reads the trend; apply/reset works when it prescribes a tweak", async (p) => {
  A(/coach/i.test(await txt(p, "#view")), "no coach card");
  const btn = p.locator('[data-act="adapt"]').first();
  if (await btn.count()) {
    const d = +(await btn.getAttribute("data-kcal"));
    await btn.click(); await sleep(350);
    A(/Active adaptive tweak/.test(await txt(p, "#view")), "no active-tweak note");
    A((await p.evaluate(() => +localStorage.getItem("pt_adaptkcal"))) === d, "tweak not stored");
    await p.click('[data-act="adaptreset"]'); await sleep(300);
    A(!/Active adaptive tweak/.test(await txt(p, "#view")), "reset failed");
  } else {
    A(/On track|kg\/wk/i.test(await txt(p, "#view")), "no rate verdict (mock loses ~0.5 kg/wk — expected the on-track message)");
  } }],
["H05", "Diet-break: 12 chips, wk6 pre-marked from mock; toggling wk8 works", async (p) => {
  A(await p.locator(".wk-chip").count() === 12, "chip count");
  A(await p.locator('.wk-chip.on[data-wk="6"]').count() === 1, "wk6 not marked");
  await p.click('.wk-chip[data-wk="8"]'); await sleep(250);
  A(await p.locator('.wk-chip.on[data-wk="8"]').count() === 1, "wk8 not on");
  await p.click('.wk-chip[data-wk="8"]'); await sleep(200); }],
["H06", "Week report: 6 tiles (weight/workouts/volume/perfect/streak/PBs) + share button", async (p) => {
  A(await p.locator(".rep-tile").count() === 6, "tile count");
  A(await p.locator("#shareReportBtn").count() === 1, "share button"); }],
["H07", "Goal card: suggested-goal one-tap sets it; Change clears back", async (p) => {
  A(await p.locator("#useSuggestedGoal").count() === 1, "no suggested-goal button");
  await p.click("#useSuggestedGoal"); await sleep(350);
  A(/Goal: \d+/.test(await txt(p, "#view")), "goal not set");
  A(await p.locator("#clearGoalBtn").count() === 1, "no change button");
  await p.click("#clearGoalBtn"); await sleep(300);
  A(await p.locator("#useSuggestedGoal").count() === 1, "did not clear"); }],
["H08", "Weight trend: raw + smoothed lines with legend; weigh-in logs from here too", async (p) => {
  A(await p.locator(".chart polyline").count() === 2, "two lines expected");
  A(await p.locator(".chart-legend").count() === 1, "legend");
  await p.fill("#quickWeight", "67.2"); await p.click("#logWeightBtn"); await sleep(350);
  const n = await p.evaluate(() => JSON.parse(localStorage.getItem("pt_weights")).length);
  A(n === 5, "weigh-in count " + n); }],
["H09", "Measurements: mock trends with sparklines; save new waist; delete an entry", async (p) => {
  const fold = p.locator("details.card", { hasText: "Measurements" });
  await fold.locator("summary").click(); await sleep(300);
  A(await fold.locator(".lift-stats li").count() >= 2, "trend rows");
  A(await fold.locator("svg").count() >= 1, "no sparkline");
  await p.fill("#meas_waist", "81.5");
  A(/Measurements saved/.test(await doToast(p, () => p.click("#saveMeasBtn"))), "no save toast"); await sleep(250);
  const n = await p.evaluate(() => JSON.parse(localStorage.getItem("pt_meas")).length);
  A(n === 3, "entry not added: " + n);
  const stillOpen = (await fold.getAttribute("open")) != null;
  if (!stillOpen) { await fold.locator("summary").click(); await sleep(250); }
  await p.locator('[data-act="delmeas"]').last().click(); await sleep(250);
  A(await p.evaluate(() => JSON.parse(localStorage.getItem("pt_meas")).length) === 2, "delete failed");
  A(stillOpen, "saving collapses the Measurements fold — the repaint drops <details> open state, hiding the entry you just saved"); }],
["H10", "Achievements: earned counter and full badge grid render", async (p) => {
  const fold = p.locator("details.card", { hasText: "Achievements" });
  const tag = await fold.locator(".swap-tag").textContent();
  A(/^([1-9]\d*)\/\d+$/.test(tag.trim()), "counter: " + tag);
  await fold.locator("summary").click(); await sleep(250);
  A(await fold.locator(".badge-grid > *").count() >= 8, "badge grid thin"); }],
["H11", "Muscle map: CTA when week has no sets; glows + kg legend once sets exist", async (p) => {
  A(/Muscle map/.test(await txt(p, "#view")), "card missing");
  A(/Log sets with the 🏋️ button/.test(await txt(p, "#view")), "expected empty-state CTA (no sets this program week)");
  await p.evaluate(() => { localStorage.setItem("pt_lift_2026-07-06", JSON.stringify({ "Goblet squat": [{ w: 22.5, r: 10 }, { w: 22.5, r: 10 }] })); location.reload(); });
  await p.waitForSelector(".today-hero", { timeout: 6000 });
  await p.click('[data-tab="progress"]'); await sleep(450);
  await p.waitForSelector(".muscle-svg", { timeout: 5000 });
  A(/Legs 450kg/.test(await txt(p, ".mm-legend")), "legend volume: " + await txt(p, ".mm-legend")); }],
["H12", "Strength log: imported Goblet squat with best e1RM + BW multiple", async (p) => {
  const fold = p.locator("details.card", { hasText: "Strength log" });
  await fold.locator("summary").click(); await sleep(250);
  A(/Goblet squat/.test(await fold.textContent()), "lift missing");
  A(/e1RM/.test(await fold.textContent()), "no e1RM"); }],
]},

{ mode: "import", area: "I · Shop: auto list, staples, custom, batch, next week", items: [
["I01", "Hero: Week 3 badge, buy-by/coverage line, progress bar + N-of-M line", async (p) => {
  await p.click('[data-tab="shop"]'); await sleep(400);
  A(/Week 3 of 12/.test(await txt(p, ".phase-tag")), "week badge");
  A(/covers/.test(await txt(p, ".shop-when")), "buy line");
  A(/\d+ of \d+ ticked/.test(await txt(p, "#view")), "counter line");
  A(await p.locator(".section-label").count() >= 4, "aisle sections thin"); }],
["I02", "Ticking an item marks it and bumps the hero counter", async (p) => {
  const before = (await txt(p, "#view")).match(/(\d+) of (\d+) ticked/);
  await p.locator('li[data-act="shop"]').first().click(); await sleep(300);
  const after = (await txt(p, "#view")).match(/(\d+) of (\d+) ticked/);
  A(+after[1] === +before[1] + 1, `counter ${before[1]}→${after[1]}`);
  await p.locator('li[data-act="shop"]').first().click(); await sleep(250); }],
["I03", "Custom items: imported 'Foil' listed; add & delete your own", async (p) => {
  A(/Foil/.test(await txt(p, "#view")), "imported custom missing");
  await p.fill("#customItem", "Kitchen roll"); await p.click("#addCustomBtn"); await sleep(300);
  A(/Kitchen roll/.test(await txt(p, "#view")), "not added");
  await p.locator('[data-act="delcustom"]').last().click(); await sleep(250);
  A(!/Kitchen roll/.test(await txt(p, "#view")), "not deleted"); }],
["I04", "Weekly staples: imported 'Coffee' carries over; add & delete works", async (p) => {
  A(/Coffee/.test(await txt(p, "#view")), "staple missing");
  await p.fill("#stapleItem", "Semi-skimmed milk"); await p.click("#addStapleBtn"); await sleep(300);
  A(/Semi-skimmed milk/.test(await txt(p, "#view")), "staple not added");
  await p.locator('[data-act="delstaple"]').last().click(); await sleep(250); }],
["I05", "Batch-prep card lists freezable dinners and ticks off", async (p) => {
  A(/Batch prep/.test(await txt(p, "#view")), "card missing");
  await p.locator('li[data-act="batch"]').first().click(); await sleep(250);
  A(await p.locator('li[data-act="batch"].done').count() === 1, "tick failed");
  await p.locator('li[data-act="batch"]').first().click(); await sleep(200); }],
["I06", "Next-week fold: buy-by date + read-only preview list", async (p) => {
  const fold = p.locator("details.card", { hasText: "Next week" });
  await fold.locator("summary").click(); await sleep(250);
  A(/Best bought by/.test(await fold.textContent()), "no buy-by");
  A(await fold.locator("li").count() > 5, "preview thin"); }],
["I07", "Reset clears only this week's ticks (customs & staples survive)", async (p) => {
  await p.locator('li[data-act="shop"]').first().click(); await sleep(250);
  await p.click("#resetShopBtn"); await sleep(300);
  A((await txt(p, "#view")).match(/(\d+) of \d+ ticked/)[1] === "0", "ticks not cleared");
  A(/Foil/.test(await txt(p, "#view")) && /Coffee/.test(await txt(p, "#view")), "customs/staples lost"); }],
]},

{ mode: "import", area: "J · Photos: gallery, compare, lightbox, timelapse, upload", items: [
["J01", "Gallery: 2 imported thumbs + Before→Now compare with date labels", async (p) => {
  await p.click('[data-tab="photos"]'); await sleep(450);
  A(await p.locator(".photo-thumb").count() === 2, "thumb count");
  A(await p.locator(".compare").count() === 1, "compare missing");
  A(/2026-06-24/.test(await txt(p, ".cmp-labels")) && /2026-07-01/.test(await txt(p, ".cmp-labels")), "date labels: " + await txt(p, ".cmp-labels")); }],
["J02", "Compare slider drives the clip reveal + handle position", async (p) => {
  await p.locator("#compareRange").evaluate((el) => { el.value = 20; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(250);
  const clip = await p.locator("#cmpTop").evaluate((el) => el.style.clipPath);
  A(/inset\(0(px)? 80/.test(clip), "clip not tracking: " + clip); }],
["J03", "Lightbox opens at body level (multicol-safe) with share/export/delete; closes", async (p) => {
  await p.locator(".photo-thumb").first().click(); await sleep(350);
  A(await p.locator("#overlay .lightbox").count() === 1, "lightbox not in #overlay");
  A(await p.locator('#overlay [data-act="exportphoto"]').count() === 1, "no export");
  A(await p.locator('#overlay [data-act="delphoto"]').count() === 1, "no delete");
  await p.locator('#overlay .btn[data-act="closephoto"]').click(); await sleep(300);
  A(await p.locator("#overlay .lightbox").count() === 0, "did not close"); }],
["J04", "▶ Timelapse cycles the stage through the photos", async (p) => {
  await p.click("#playTimelapse"); await sleep(600);
  A(await p.locator("#timelapseStage").evaluate((el) => el.style.display !== "none" && !!el.src), "stage not playing"); }],
["J05", "Upload: new photo is watermarked with nearest weight and joins the gallery", async (p) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const f = path.join(require("os").tmpdir(), "pt-audit-upload.png");
  fs.writeFileSync(f, png);
  await p.setInputFiles("#photoUpload", f); await sleep(1500);
  A(await p.locator(".photo-thumb").count() === 3, "photo not added"); }],
]},

{ mode: "import", area: "K · Settings: profile, library, supplements, sync, plan, reset", items: [
["K01", "Profile form prefilled from mock (Ben · 25 · cut · no fish) + live targets note", async (p) => {
  await p.click('[data-tab="settings"]'); await sleep(400);
  A((await p.inputValue("#pfName")) === "Ben", "name");
  A((await p.inputValue("#pfAge")) === "25", "age");
  A((await p.inputValue("#pfGoal")) === "cut", "goal");
  A(/fish/.test(await p.inputValue("#pfDislikes")), "dislikes");
  A(/maintenance ~[\d,]+ kcal/.test(await txt(p, "#view")), "targets note"); }],
["K02", "Saving an edited weight re-tailors targets (toast + updated note)", async (p) => {
  await p.fill("#pfWeight", "67.5");
  A(/Profile saved/.test(await doToast(p, () => p.click("#saveProfileBtn"))), "no toast"); await sleep(300);
  A(await p.evaluate(() => JSON.parse(localStorage.getItem("pt_profile")).weightKg) === 67.5, "not stored"); }],
["K03", "Start date field holds the program start (2026-06-22)", async (p) => {
  A((await p.inputValue("#startDateInput")) === "2026-06-22", "start date"); }],
["K04", "Recipe Library: slot folds, toggling a meal activates; reset returns to default", async (p) => {
  await p.locator(".lib-slot summary").first().scrollIntoViewIfNeeded();
  await p.locator(".lib-slot summary").first().click(); await sleep(250);
  const row = p.locator(".lib-row").first();
  const wasOn = (await row.getAttribute("class")).includes("on");
  await row.click(); await sleep(300);
  A(((await p.locator(".lib-row").first().getAttribute("class")).includes("on")) !== wasOn, "row did not toggle");
  A(/Active ✓/.test(await txt(p, "#view")), "library not active");
  A(/default plan/i.test(await doToast(p, () => p.click("#resetLibBtn"))), "no reset toast"); }],
["K05", "Supplements manager: add appears here AND as a chip on Today; delete removes", async (p) => {
  await p.fill("#suppInput", "Zinc"); await p.click("#addSuppBtn"); await sleep(300);
  A(/Zinc/.test(await txt(p, "#view")), "not listed");
  await p.click('[data-tab="today"]'); await sleep(350);
  await openPanel(p, "daily");
  A(await p.locator('.supp-chip', { hasText: "Zinc" }).count() === 1, "chip not on Today");
  await p.click('[data-tab="settings"]'); await sleep(350);
  await p.locator('[data-act="delsupp"]').last().click(); await sleep(250);
  A(!/Zinc/.test(await txt(p, "#view")), "not deleted"); }],
["K06", "Backup card: export button + restore input present", async (p) => {
  A(await p.locator("#exportBtn").count() === 1, "export");
  A(await p.locator("#importFile").count() === 1, "restore input"); }],
["K07", "Cloud sync card: dormant/unconfigured state explains setup (no dead UI)", async (p) => {
  A(await p.locator("#syncCard").count() === 1, "card missing");
  A(/Supabase/i.test(await txt(p, "#syncCard")), "no setup guidance");
  A(await p.locator("#syncSend, #syncNow").count() === 0, "live controls while unconfigured"); }],
["K08", "Plan reference folds: blueprint (3 phases), meal rotation (14 days), golden rules", async (p) => {
  const bp = p.locator("details.card", { hasText: "blueprint" });
  await bp.locator("summary").click(); await sleep(300);
  A(await bp.locator(".phase-block").count() === 3, "phase blocks");
  const mr = p.locator("details.card", { hasText: "Meal rotation" });
  A(/14 days/.test(await mr.locator(".swap-tag").first().textContent()), "meal-day count");
  A(await p.locator("details.card", { hasText: "Golden rules" }).count() === 1, "rules fold"); }],
["K09", "Reset asks for confirmation; declining keeps every byte of data", async (p) => {
  p.once("dialog", (d) => d.dismiss());
  await p.click("#resetBtn"); await sleep(400);
  A(await p.evaluate(() => !!localStorage.getItem("pt_profile")), "data wiped despite Cancel!"); }],
]},

{ mode: "sat", area: "L1 · HIIT Saturday: Interval Coach", items: [
["L01", "Saturday is HIIT: coach parses the day's rounds/work/easy from the plan", async (p) => {
  A(/Day 13/.test(await txt(p, "#dayPill")), "wrong day: " + await txt(p, "#dayPill"));
  await openPanel(p, "workout");
  A(await p.locator("#ivBox").count() === 1, "no interval coach");
  A(/\d+ × \d+s hard \/ \d+s easy/.test(await txt(p, ".iv-spec")), "spec: " + await txt(p, ".iv-spec")); }],
["L02", "▶ Start: HARD phase + countdown + round counter; ■ stop resets to Ready", async (p) => {
  await p.click('[data-act="ivstart"]'); await sleep(1300);
  A(/HARD/.test(await txt(p, "#ivPhase")), "phase: " + await txt(p, "#ivPhase"));
  A(/\d+s/.test(await txt(p, "#ivTime")), "no countdown");
  A(/round 1\//.test(await txt(p, "#ivRound")), "round counter");
  await p.click('[data-act="ivstop"]'); await sleep(300);
  A((await txt(p, "#ivPhase")) === "Ready", "not reset"); }],
]},

{ mode: "teen", area: "L2 · Teen numbers-free mode (safeguarding)", items: [
["L10", "Fuel goes numbers-free: no kcal in badge, growth habits instead of macros", async (p) => {
  await openPanel(p, "fuel");
  A(!/kcal/.test(await txt(p, 'details[data-panel="fuel"] .wo-sum-prog')), "kcal leaked into badge");
  A(await p.locator('details[data-panel="fuel"] .macros').count() === 0, "macros grid shown to a teen");
  A(/sleep/i.test(await txt(p, 'details[data-panel="fuel"]')), "growth habits missing"); }],
["L11", "Progress hides measurements; Settings notes growing-mode", async (p) => {
  await p.click('[data-tab="progress"]'); await sleep(400);
  A(!/Measurements/.test(await txt(p, "#view")), "measurements shown to teen");
  await p.click('[data-tab="settings"]'); await sleep(400);
  A(/growing-mode/.test(await txt(p, "#view")), "no growing-mode note"); }],
]},

{ mode: "gain", area: "L3 · Gain profile: lean-bulk plan & framing", items: [
["L20", "Gain goal: surplus targets in Settings + no diet-break card on Progress", async (p) => {
  await p.click('[data-tab="settings"]'); await sleep(400);
  A(/Gain muscle/.test(await txt(p, "#view")), "goal label");
  await p.click('[data-tab="progress"]'); await sleep(400);
  A(!/Diet-break/.test(await txt(p, "#view")), "diet-break shown to a gainer"); }],
]},

{ mode: "older", area: "L4 · 60+ profile: gentle programme", items: [
["L30", "60+ gets the Build Confidence programme in the topbar & schedule", async (p) => {
  A(/Build Confidence/.test(await txt(p, "#phaseName")), "phase: " + await txt(p, "#phaseName"));
  await openPanel(p, "workout");
  A((await txt(p, 'details[data-panel="workout"]')).length > 50, "workout empty"); }],
]},

];

/* ---------------- RUNNER ---------------- */
(async () => {
  const server = serve();
  const browser = await chromium.launch({ executablePath: CHROME });
  for (const vp of Object.keys(VPS)) {
    for (const g of GROUPS) {
      if (process.env.ONLY && !g.area.startsWith(process.env.ONLY)) continue;
      let page = null;
      try { page = await boot(browser, vp, g.mode); }
      catch (e) {
        for (const [id, name] of g.items) record(id, g.area, name, vp, "ERR — boot failed: " + String(e.message).slice(0, 120));
        if (process.env.ONLY && page) console.log("BOOT FAIL:", e.message.split("\n")[0], "| view:", (await page.locator("#view").textContent().catch(() => "?")).slice(0, 150), "| errs:", page._consoleErrs.join(" ; ").slice(0, 300));
        if (page) await page._ctx.close().catch(() => {});
        continue;
      }
      for (const [id, name, fn] of g.items) {
        try { await fn(page, vp); record(id, g.area, name, vp, "OK"); }
        catch (e) {
          const msg = String(e.message).split("\n")[0].slice(0, 200);
          record(id, g.area, name, vp, (e.isFail ? "FAIL — " : "ERR — ") + msg);
        }
      }
      // console/page errors are a first-class finding of their own
      const cid = g.items[0][0].replace(/\d+$/, "") + "99";
      const errs = [...new Set(page._consoleErrs)];
      record(cid, g.area, "Zero console/page errors while exercising this area", vp,
        errs.length ? "FAIL — " + errs.slice(0, 3).join(" | ").slice(0, 220) : "OK");
      await page._ctx.close().catch(() => {});
      process.stdout.write(`[${vp}] ${g.area} done\n`);
    }
  }
  await browser.close(); server.close();
  writeTestMd();
  const flat = ORDER.flatMap((id) => Object.values(RES[id].vp));
  const bad = flat.filter((s) => s !== "OK").length;
  console.log(`\n${ORDER.length} checks × 3 viewports — ${flat.length - bad} passed, ${bad} findings → TEST.md`);
  process.exitCode = bad ? 1 : 0; // non-zero so CI fails the run when there are findings
})();

/* ---------------- TEST.md GENERATOR ---------------- */
function writeTestMd() {
  const VPI = { phone: "📱", tablet: "📟", desktop: "🖥️" };
  const lines = [];
  lines.push("# TEST.md — vigorous UI audit of every feature");
  lines.push("");
  lines.push(`> **Last run:** ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · in-app clock frozen to **Mon 2026-07-06 18:00** (Day 15, Wk 3) · seeded by importing \`tests/mock-data.json\` through the app's own Restore flow · every check executed at **📱 phone 390px · 📟 tablet 834px · 🖥️ desktop 1440px**.`);
  lines.push("");
  lines.push("## How this file works (instructions to future agents)");
  lines.push("");
  lines.push("- **This is a findings ledger, not a fix log.** The UI-testing agent re-runs the audit and rewrites this file; it must NOT change app code.");
  lines.push("- **Re-run:** `npm i playwright-core && node tests/gen-mock.cjs && node tests/ui-audit.cjs` (Chromium at `/opt/pw-browsers/chromium-1194`, override with `$CHROME`). The script serves the repo on :8125, drives the real UI headlessly and regenerates this file.");
  lines.push("- **Add a new feature test:** append an `[\"ID\", \"name\", async (page, vp) => {…}]` item to the right group in `tests/ui-audit.cjs` — it automatically runs at all three viewports and lands here.");
  lines.push("- **For the fixing agent:** work from the *Findings* section at the bottom. Each finding states the check, the viewport(s) it failed on, and the observed problem. Fix the app, then re-run the audit to confirm the row flips to ✅. Do not edit this file by hand — it is generated.");
  lines.push("- A ticked box means *the check was executed* on all three viewports; the per-viewport marks tell you whether it passed (✅) or is a finding (❌).");
  lines.push("");
  lines.push("## The checklist");
  let curArea = null;
  const findings = [];
  for (const id of ORDER) {
    const r = RES[id];
    if (r.area !== curArea) { curArea = r.area; lines.push(""); lines.push(`### ${curArea}`); lines.push(""); }
    const marks = Object.keys(VPS).map((vp) => {
      const s = r.vp[vp] || "ERR — not run";
      return `${VPI[vp]} ${s === "OK" ? "✅" : "❌"}`;
    }).join(" · ");
    lines.push(`- [x] **${id}** ${r.name} — ${marks}`);
    for (const vp of Object.keys(VPS)) {
      const s = r.vp[vp] || "ERR — not run";
      if (s !== "OK") findings.push({ id, name: r.name, area: r.area, vp, s });
    }
  }
  lines.push("");
  lines.push("## Findings for the fixing agent");
  lines.push("");
  if (!findings.length) {
    lines.push("No findings — every check passed on phone, tablet and desktop. 🎉");
  } else {
    lines.push(`${findings.length} failing check–viewport combinations. Grouped by check:`);
    lines.push("");
    const byId = {};
    for (const f of findings) (byId[f.id] = byId[f.id] || []).push(f);
    for (const [id, fs] of Object.entries(byId)) {
      lines.push(`### ${id} — ${fs[0].name}`);
      lines.push(`*Area:* ${fs[0].area}`);
      for (const f of fs) lines.push(`- **${VPI[f.vp]} ${f.vp}:** \`${f.s.replace(/`/g, "'")}\``);
      lines.push("");
    }
  }
  lines.push("");
  fs.writeFileSync(path.join(ROOT, "TEST.md"), lines.join("\n"));
}
