/* Ben's PT — 12 Week Shred. Pure front-end, data from data/plan.json, state in localStorage. */

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
const QUOTES = [
  "Discipline beats motivation. Show up.",
  "You don't have to be extreme, just consistent.",
  "The work you do today is the body you wear in 12 weeks.",
  "Small wins, every single day.",
  "Sweat now, shine later.",
  "Hard now or hard later — you choose.",
  "Abs are built in the kitchen and earned in the gym.",
  "One day or day one. Go.",
];

let PLAN = null;
let CURRENT_TAB = "today";
let PHOTOS = [];           // [{date, data(dataURL)}] loaded from IndexedDB
let COMPARE_T = 50;        // before/after slider position
let SWAP_SLOT = null;      // which meal slot's swap picker is open
let OPEN_LIFT = null;      // which exercise's set-logger is open
let VIEW_PHOTO = null;     // date of the photo open in the lightbox
let VIEW_OFFSET = 0;       // Today tab: 0 = today, negative = read-only past days
let OPEN_PANELS = {};      // Today: which collapsed-by-default cards the user has expanded
let OPEN_FORM = null;      // Today: which exercise's form-guide panel is open
let HM_SEL = null;         // Progress: selected consistency-heatmap day index

/* ---------- progress photos: IndexedDB (blobs are too big for localStorage) ---------- */
function idb() {
  return new Promise((res, rej) => {
    if (!("indexedDB" in self)) return rej(new Error("no idb"));
    const r = indexedDB.open("pt-photos", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("photos", { keyPath: "date" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function photosAll() {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const out = []; const c = db.transaction("photos").objectStore("photos").openCursor();
      c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out.sort((a, b) => a.date.localeCompare(b.date))); };
      c.onerror = () => res([]);
    });
  } catch { return []; }
}
async function photoPut(rec) { try { const db = await idb(); db.transaction("photos", "readwrite").objectStore("photos").put(rec); } catch {} }
async function photoDel(date) { try { const db = await idb(); db.transaction("photos", "readwrite").objectStore("photos").delete(date); } catch {} }

/* ---------- recipe library: build the plan from a per-slot pool you choose ---------- */
const SLOTS = [["Breakfast", "breakfast"], ["Lunch", "lunch"], ["Snack", "snack"], ["Dinner", "dinner"], ["Evening", "evening"]];
let BANK = null;
// foods to avoid: only from an explicit saved profile (the default/bundled user isn't filtered)
function dislikeList() { const p = LS.get("pt_profile", null); return (p && Array.isArray(p.dislikes)) ? p.dislikes.map((s) => String(s).trim()).filter(Boolean) : []; }
function dislikeRe() {
  const d = dislikeList(); if (!d.length) return null;
  return new RegExp("\\b(" + d.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i");
}
function itemDisliked(item, re) {
  if (!re || !item) return false;
  if (re.test(item.text || "")) return true;
  const r = item.recipe;
  return !!(r && r.ingredients && re.test(r.ingredients.join(" ")));
}
function buildBank() {
  if (!PLAN.mealBank) { BANK = null; return; }
  const re = dislikeRe();
  BANK = {};
  for (const [, k] of SLOTS) {
    const full = PLAN.mealBank[k] || [];
    let list = re ? full.filter((it) => !itemDisliked(it, re)) : full;
    if (!list.length) list = full; // never empty a slot
    const byId = {}; list.forEach(it => byId[it.id] = it);
    const lim = (PLAN.mealBank.limits && PLAN.mealBank.limits[k]) || [1, list.length];
    BANK[k] = { list, byId, min: Math.min(lim[0], list.length), max: Math.min(lim[1], list.length) };
  }
}
// default picks = the meals from the curated 14-day plan (capped at each slot's max)
function defaultLibrary() {
  const lib = {};
  for (const [label, k] of SLOTS) {
    const curated = new Set(PLAN.meals.map(m => m.items[label].text));
    let ids = BANK[k].list.filter(it => curated.has(it.text)).map(it => it.id);
    if (ids.length > BANK[k].max) ids = ids.slice(0, BANK[k].max);
    if (ids.length < BANK[k].min) ids = BANK[k].list.slice(0, BANK[k].min).map(it => it.id);
    lib[k] = ids;
  }
  return lib;
}
function currentLibrary() { return LS.get("pt_library", null) || defaultLibrary(); }
// returns a saved+valid library, or null to fall back to the curated plan
function getLibrary() {
  const lib = LS.get("pt_library", null);
  if (!lib || !BANK) return null;
  for (const [, k] of SLOTS) {
    const sel = (lib[k] || []).filter(id => BANK[k].byId[id]);
    if (sel.length < BANK[k].min) return null;
  }
  return lib;
}
// calendar date key for a given (effective) day index — for per-day overrides
function dateKeyForDn(dn) {
  const d = new Date(getStartDate() + "T00:00:00");
  d.setDate(d.getDate() + dn + LS.get("pt_shift", 0));
  return todayKey(d);
}
function mealTotals(items) {
  let kcal = 0, protein = 0;
  for (const v of Object.values(items)) { kcal += v.kcal; protein += v.p; }
  const fat = Math.round(0.28 * kcal / 9);
  return { kcal, protein, carbs: Math.round((kcal - 4 * protein - 9 * fat) / 4), fat };
}
// macros for an ad-hoc logged food (carbs/fat estimated from the non-protein calories)
function extraMacros(x) {
  const kcal = +x.kcal || 0, protein = +x.p || 0, np = Math.max(0, kcal - protein * 4);
  return { kcal, protein, carbs: Math.round(np * 0.55 / 4), fat: Math.round(np * 0.45 / 9) };
}
function extrasTotals(key) {
  return LS.get("pt_extra_" + key, []).reduce((a, x) => {
    const m = extraMacros(x); a.kcal += m.kcal; a.protein += m.protein; a.carbs += m.carbs; a.fat += m.fat; return a;
  }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}
// the meal for a given day index — assembled from your library, else the curated plan,
// then any per-slot swaps you made for that day applied on top
function dayMeal(dn) {
  const idx = ((dn % PLAN.meals.length) + PLAN.meals.length) % PLAN.meals.length;
  const lib = getLibrary();
  let base;
  if (!lib) {
    base = PLAN.meals[idx];
    const re = dislikeRe();
    if (re && BANK) { // swap any disliked slot in the curated meal for an acceptable bank pick
      const items = { ...base.items }; let changed = false;
      for (const [label, k] of SLOTS) {
        if (itemDisliked(items[label], re)) {
          const pool = BANK[k].list;
          if (pool.length) { items[label] = pool[((dn % pool.length) + pool.length) % pool.length]; changed = true; }
        }
      }
      if (changed) base = { name: base.name, totals: mealTotals(items), items };
    }
  } else {
    const items = {};
    for (const [label, k] of SLOTS) {
      const sel = lib[k].filter(id => BANK[k].byId[id]).map(id => BANK[k].byId[id]);
      items[label] = sel[((dn % sel.length) + sel.length) % sel.length];
    }
    base = { name: "Your mix", totals: mealTotals(items), items };
  }
  return applyMealOverrides(base, dateKeyForDn(dn));
}
// apply per-slot swaps stored for a given calendar day onto a base meal
function applyMealOverrides(base, dateKey) {
  const ov = BANK ? LS.get("pt_mealswap_" + dateKey, null) : null;
  if (!ov) return base;
  const items = { ...base.items }; let changed = false;
  for (const [label, k] of SLOTS) {
    const it = ov[label] && BANK[k].byId[ov[label]];
    if (it) { items[label] = it; changed = true; }
  }
  if (!changed) return base;
  return { name: base.name, totals: mealTotals(items), items };
}

function todayKey(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function getStartDate() {
  return LS.get("pt_startDate", null) || PLAN.meta.startDate;
}
function dayNumber() {
  const start = new Date(getStartDate() + "T00:00:00");
  const now = new Date(todayKey() + "T00:00:00");
  return Math.floor((now - start) / 86400000) - LS.get("pt_shift", 0); // 0-based, minus any reschedule
}
// day index (effective) for an arbitrary date — used by cheat-meal payback
function effDnForDate(dateStr) {
  const start = new Date(getStartDate() + "T00:00:00");
  return Math.floor((new Date(dateStr + "T00:00:00") - start) / 86400000) - LS.get("pt_shift", 0);
}
const CHEAT_SPREAD = 3; // days to balance an off-plan surplus over
function paybackForDay(dn) {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.indexOf("pt_cheat_") === 0) {
      const c = effDnForDate(key.slice(9)), surplus = LS.get(key, 0);
      if (dn > c && dn <= c + CHEAT_SPREAD) total += surplus / CHEAT_SPREAD;
    }
  }
  return Math.round(total);
}
function isDietBreak(week) { return LS.get("pt_dietbreaks", []).includes(week); }
function dailyAim(pos) {
  if (isDietBreak(pos.week)) return Math.round(currentMaintenance() / 10) * 10; // maintenance week
  const payback = getProfile().goal === "gain" ? 0 : paybackForDay(pos.dn); // gainers keep their surplus
  const floor = ageBand() === "older" ? 1200 : 1300; // relaxed so small/older people aren't over-fed
  return Math.max(floor, Math.round((adjustedAim(pos) - payback + LS.get("pt_adaptkcal", 0)) / 10) * 10);
}
// adaptive coach: read the recent weight trend and decide if the plan needs changing
function weeklyRate() {
  const w = LS.get("pt_weights", []);
  if (w.length < 2) return null;
  const last = w[w.length - 1];
  const cutoff = new Date(last.date + "T00:00:00"); cutoff.setDate(cutoff.getDate() - 16);
  let win = w.filter((x) => new Date(x.date + "T00:00:00") >= cutoff);
  if (win.length < 2) win = w.slice(-2);
  const a = win[0], b = win[win.length - 1];
  const days = (new Date(b.date) - new Date(a.date)) / 86400000;
  if (days < 4) return null;
  return (b.kg - a.kg) / (days / 7); // kg/week (negative = losing)
}
function adaptiveStatus() {
  const pos = position();
  const daysIn = Math.max(0, pos.dn + 1);
  const rate = weeklyRate();
  const goal = getProfile().goal;
  if (rate == null || daysIn < 7) return { state: "new", rate: null, goal };
  if (goal === "gain") {
    if (rate < 0.1) return { state: "stall", rate, goal };   // not gaining → add kcal
    if (rate > 0.6) return { state: "fast", rate, goal };    // gaining too fast → ease (fat)
    return { state: "good", rate, goal };
  }
  if (goal === "maintain") {
    if (Math.abs(rate) <= 0.25) return { state: "good", rate, goal };
    return { state: rate > 0 ? "fast" : "stall", rate, goal };
  }
  if (rate > -0.15) return { state: "stall", rate, goal };
  if (rate < -1.0) return { state: "fast", rate, goal };
  return { state: "good", rate, goal };
}

/* ---------- strength logging: weight x reps, e1RM, PBs, auto-progression ---------- */
function parseLift(item) {
  const parts = item.split(" — ");
  const name = parts[0].trim();
  const presc = (parts[1] || "").trim();
  const timed = /\d+\s*s\b|min\b|amrap/i.test(presc);
  const bad = /plank|dead bug|stretch|mobility|warm|walk|cycle|spin|rower|circuit|hold|finisher|side plank/i.test(name);
  const m = presc.match(/(\d+)\s*[x×]\s*(\d+)(?:\s*-\s*(\d+))?/i);
  return {
    name, presc,
    loggable: !!m && !timed && !bad,
    sets: m ? +m[1] : 0,
    repLow: m ? +m[2] : 0,
    repHigh: m ? (m[3] ? +m[3] : +m[2]) : 0,
  };
}
function e1rm(w, r) { return (w > 0 && r > 0) ? Math.round(w * (1 + r / 30)) : 0; }
function liftIncrement(name) { return /squat|deadlift|leg press|hip thrust|lunge|rdl/i.test(name) ? 5 : 2.5; }
function todayLift(name) { return (LS.get("pt_lift_" + todayKey(), {})[name]) || []; }
function lastLiftBefore(name, beforeDn) {
  for (let i = beforeDn - 1; i >= 0; i--) {
    const log = LS.get("pt_lift_" + dateKeyForDn(i), null);
    if (log && log[name] && log[name].length) return { dn: i, sets: log[name] };
  }
  return null;
}
function bestE1rm(name) {
  let best = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.indexOf("pt_lift_") === 0) (LS.get(k, {})[name] || []).forEach((s) => { best = Math.max(best, e1rm(s.w, s.r)); });
  }
  return best;
}
function setSummary(sets) { return sets.map((s) => (s.w ? s.w + "×" + s.r : "BW×" + s.r)).join(", "); }
function suggestLift(name, dn, repLow, repHigh) {
  const last = lastLiftBefore(name, dn);
  if (!last) return null;
  const topW = Math.max(0, ...last.sets.map((s) => s.w || 0));
  const allTop = last.sets.length > 0 && last.sets.every((s) => s.r >= repHigh && s.w > 0);
  if (allTop) return { w: topW + liftIncrement(name), reps: repLow, progress: true, last: setSummary(last.sets) };
  return { w: topW, reps: repHigh, progress: false, last: setSummary(last.sets) };
}
function allLiftNames() {
  const names = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.indexOf("pt_lift_") === 0) Object.keys(LS.get(k, {})).forEach((n) => names.add(n));
  }
  return [...names];
}
function weekVolume() {
  let vol = 0, sets = 0; const start = (Math.max(1, position().week) - 1) * 7;
  for (let d = 0; d < 7; d++) {
    const log = LS.get("pt_lift_" + dateKeyForDn(start + d), {});
    Object.values(log).forEach((arr) => arr.forEach((s) => { vol += (s.w || 0) * s.r; sets++; }));
  }
  return { vol: Math.round(vol), sets };
}
// e1RM series over time for one exercise (best set per day)
function liftSeries(name) {
  const pts = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.indexOf("pt_lift_") === 0) {
      const sets = LS.get(k, {})[name];
      if (sets && sets.length) { const best = Math.max(0, ...sets.map((s) => e1rm(s.w, s.r))); if (best > 0) pts.push({ date: k.slice(8), e: best }); }
    }
  }
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}
function miniSpark(vals, w = 130, h = 34) {
  if (vals.length < 2) return "";
  const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1, pad = 3;
  const pts = vals.map((v, i) => `${(pad + i / (vals.length - 1) * (w - 2 * pad)).toFixed(1)},${(pad + (1 - (v - min) / range) * (h - 2 * pad)).toFixed(1)}`);
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="mini-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline fill="none" stroke="${up ? "var(--accent)" : "#f87171"}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}"/></svg>`;
}
// map an exercise to a muscle group for volume balance
function muscleOf(n) {
  n = n.toLowerCase();
  if (/bench|chest|push-?up|incline.*press|floor press|\bfly\b|\bdip/.test(n)) return "Chest";
  if (/row|pulldown|pull-?up|face pull|lat /.test(n)) return "Back";
  if (/deadlift|rdl|romanian|hip thrust|glute|leg curl|nordic/.test(n)) return "Posterior";
  if (/shoulder press|overhead|lateral raise|pike/.test(n)) return "Shoulders";
  if (/curl|tricep|extension/.test(n)) return "Arms";
  if (/squat|leg press|lunge|split|sit-to-stand|wall sit/.test(n)) return "Legs";
  return "Other";
}
function weeklyMuscleVolume() {
  const m = {}; const start = (Math.max(1, position().week) - 1) * 7;
  for (let d = 0; d < 7; d++) {
    const log = LS.get("pt_lift_" + dateKeyForDn(start + d), {});
    for (const [n, sets] of Object.entries(log)) {
      const g = muscleOf(n), v = sets.reduce((s, x) => s + (x.w || 0) * x.r, 0);
      if (v > 0) m[g] = (m[g] || 0) + v;
    }
  }
  return m;
}
/* ---------- muscle map: a body that glows where you trained this week ---------- */
function muscleMapCard() {
  const mv = weeklyMuscleVolume();
  const vals = Object.values(mv);
  const max = vals.length ? Math.max(...vals) : 0;
  if (!max) return `<div class="card"><h2>🫀 Muscle map</h2>
    <p class="note">Log sets with the 🏋️ button on your exercises and this body lights up where you've trained this week.</p></div>`;
  const tone = (g) => { const v = mv[g] || 0; return v ? `rgba(52,211,153,${(0.2 + 0.75 * v / max).toFixed(2)})` : "rgba(255,255,255,.07)"; };
  const idle = "rgba(255,255,255,.07)", line = "#2a2f3a";
  const groups = ["Chest", "Back", "Shoulders", "Arms", "Legs", "Posterior"];
  const min = Math.min(...groups.map((g) => mv[g] || 0));
  const least = groups.filter((g) => (mv[g] || 0) === min);
  const svg = `<svg class="muscle-svg" viewBox="0 0 220 152" role="img" aria-label="Muscle groups trained this week">
    <!-- front figure -->
    <circle cx="55" cy="15" r="9" fill="${idle}" stroke="${line}"/>
    <ellipse cx="40" cy="31" rx="9" ry="6" fill="${tone("Shoulders")}" stroke="${line}"/>
    <ellipse cx="70" cy="31" rx="9" ry="6" fill="${tone("Shoulders")}" stroke="${line}"/>
    <rect x="44" y="28" width="22" height="15" rx="5" fill="${tone("Chest")}" stroke="${line}"/>
    <rect x="28" y="35" width="8" height="30" rx="4" fill="${tone("Arms")}" stroke="${line}"/>
    <rect x="74" y="35" width="8" height="30" rx="4" fill="${tone("Arms")}" stroke="${line}"/>
    <rect x="46" y="45" width="18" height="18" rx="4" fill="${idle}" stroke="${line}"/>
    <rect x="44" y="66" width="10" height="36" rx="5" fill="${tone("Legs")}" stroke="${line}"/>
    <rect x="56" y="66" width="10" height="36" rx="5" fill="${tone("Legs")}" stroke="${line}"/>
    <text x="55" y="122" class="muscle-lbl" text-anchor="middle">front</text>
    <!-- back figure -->
    <circle cx="165" cy="15" r="9" fill="${idle}" stroke="${line}"/>
    <rect x="148" y="26" width="34" height="24" rx="6" fill="${tone("Back")}" stroke="${line}"/>
    <rect x="138" y="35" width="8" height="30" rx="4" fill="${tone("Arms")}" stroke="${line}"/>
    <rect x="184" y="35" width="8" height="30" rx="4" fill="${tone("Arms")}" stroke="${line}"/>
    <rect x="150" y="53" width="30" height="13" rx="5" fill="${tone("Posterior")}" stroke="${line}"/>
    <rect x="153" y="69" width="10" height="33" rx="5" fill="${tone("Posterior")}" stroke="${line}"/>
    <rect x="167" y="69" width="10" height="33" rx="5" fill="${tone("Posterior")}" stroke="${line}"/>
    <text x="165" y="122" class="muscle-lbl" text-anchor="middle">back</text>
  </svg>`;
  const legend = groups.map((g) => `<span class="mm-chip" style="--mm:${tone(g)}"><i></i>${g}${mv[g] ? ` ${Math.round(mv[g]).toLocaleString()}kg` : ""}</span>`).join("");
  return `<div class="card"><h2>🫀 Muscle map <small style="color:var(--muted);font-weight:600">this week</small></h2>
    <div class="mm-row">${svg}<div class="mm-legend">${legend}</div></div>
    ${least.length && least.length < groups.length ? `<p class="note" style="margin-top:8px">💡 Least trained: <b>${least.join(", ")}</b> — worth some love next session.</p>` : ""}
  </div>`;
}
function liftLogger(lf, dn) {
  const logged = todayLift(lf.name);
  const sug = suggestLift(lf.name, dn, lf.repLow, lf.repHigh);
  const n = Math.max(lf.sets || 3, logged.length);
  let rows = "";
  for (let s = 0; s < n; s++) {
    const cur = logged[s] || {};
    rows += `<div class="set-row"><span class="set-n">Set ${s + 1}</span>
      <input class="field set-w" inputmode="decimal" placeholder="${sug && sug.w ? sug.w : "kg"}" value="${cur.w != null ? cur.w : ""}" />
      <span class="set-x">kg ×</span>
      <input class="field set-r" inputmode="numeric" placeholder="${sug ? sug.reps : lf.repHigh}" value="${cur.r != null ? cur.r : ""}" />
      <span class="set-x">reps</span></div>`;
  }
  const best = bestE1rm(lf.name);
  return `<li class="lift-logger"><div style="width:100%">
    <p class="log-title">⚖️ Enter weight (kg) &amp; reps for each set</p>
    <p class="sub" style="margin:0 0 10px">Target ${lf.presc}${best ? ` · best e1RM ${best}kg` : ""}${sug ? ` · last ${sug.last}` : ""}</p>
    <div class="set-rows">${rows}</div>
    <button type="button" class="btn accent block" data-act="savelift" data-name="${encodeURIComponent(lf.name)}" style="margin-top:10px">Save sets</button>
  </div></li>`;
}
function saveLift(name) {
  const wrap = document.querySelector(".lift-logger");
  if (!wrap) return;
  const sets = [...wrap.querySelectorAll(".set-row")].map((r) => ({
    w: parseFloat(r.querySelector(".set-w").value) || 0,
    r: parseInt(r.querySelector(".set-r").value, 10) || 0,
  })).filter((s) => s.r > 0);
  const prevBest = bestE1rm(name);
  const key = "pt_lift_" + todayKey(); const log = LS.get(key, {});
  if (sets.length) log[name] = sets; else delete log[name];
  LS.set(key, log);
  OPEN_LIFT = null;
  const newBest = Math.max(0, ...sets.map((s) => e1rm(s.w, s.r)));
  haptic(12);
  if (newBest > prevBest && newBest > 0) { toast("🏅 New PB! e1RM " + newBest + "kg"); }
  else if (sets.length) toast("Saved · " + setSummary(sets));
  repaintKeepScroll();
  if (sets.length) startRest(LS.get("pt_restsecs", 90)); // auto-start rest after logging
}
// training plan for the current profile: hypertrophy for gainers, gentle for 60+, else the bundled cut plan
function activePhases() {
  const tp = PLAN.trainingPlans || {};
  const p = getProfile();
  if (ageBand() === "older" && tp.older) return tp.older;
  if (p.goal === "gain" && tp.gain) return tp.gain;
  return PLAN.phases;
}
function phaseForWeek(phases, week) { return phases.find((p) => week >= p.weekStart && week <= p.weekEnd) || phases[phases.length - 1]; }
function position() {
  const dn = dayNumber();
  const week = Math.floor(dn / 7) + 1;
  const weekday = ((new Date().getDay()) + 6) % 7; // Mon=0
  const phase = phaseForWeek(activePhases(), Math.max(1, week));
  const beforeStart = dn < 0;
  const finished = week > PLAN.meta.weeks;
  return { dn, week, weekday, phase, beforeStart, finished };
}

// reveal day = the morning after the final day of week 12
function revealInfo() {
  const start = new Date(getStartDate() + "T00:00:00");
  const end = new Date(start); end.setDate(end.getDate() + PLAN.meta.weeks * 7 + LS.get("pt_shift", 0));
  const today = new Date(todayKey() + "T00:00:00");
  return { end, daysLeft: Math.round((end - today) / 86400000),
    endStr: end.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) };
}
// projected weight on reveal day from the logged trend (null if not enough data)
function projectAtEnd() {
  const w = LS.get("pt_weights", []);
  if (w.length < 2) return null;
  const first = w[0], last = w[w.length - 1];
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  if (days <= 0) return null;
  const ratePerDay = (last.kg - first.kg) / days;
  const toEnd = (revealInfo().end - new Date(todayKey() + "T00:00:00")) / 86400000;
  return +(last.kg + ratePerDay * toEnd).toFixed(1);
}
// auto-suggested goal weight, direction depends on the profile goal
function suggestedGoal() {
  const p = getProfile();
  const start = p.weightKg;
  const proj = projectAtEnd();
  if (p.goal === "gain") {
    const g = (proj != null && proj > start) ? proj : start + 0.3 * PLAN.meta.weeks; // ~+0.3kg/wk lean gain
    return Math.round(g);
  }
  if (p.goal === "maintain") return Math.round(start);
  const floor = Math.round(20 * Math.pow(p.heightCm / 100, 2)); // BMI ~20
  const g = (proj != null && proj < start) ? proj : Math.round(start * 0.91);
  return Math.max(floor, Math.round(g));
}
// scale g/ml quantities in a text string for a bigger/smaller portion
function scaleAmounts(text, factor) {
  if (!factor || Math.abs(factor - 1) < 0.02) return text;
  return text.replace(/(\d+(?:\.\d+)?)\s?(g|ml)\b/gi, (_, n, u) => Math.round(n * factor) + u);
}
// carb/fat-dense foods are the calorie levers we trim when scaling a day down —
// protein sources and veg/aromatics keep their amounts.
const SCALE_FOOD = /rice|pasta|spaghetti|noodle|potato|bread|toast|tortilla|wrap|pitta|naan|bagel|brioche|\bbun|\broll\b|oats|granola|couscous|mash|chips|wedges|crouton|\boil\b|butter|pesto|mayo|parmesan|coconut milk|cheese|honey|peanut butter|almond butter|\bjam\b|chocolate|\bnuts|cashew|almond|flapjack|cracker|oatcake|gravy|hummus|houmous|\bbbq/i;
// scale only carb/fat amounts by nf, leaving protein + veg amounts untouched (protein-protected trim)
function scaleFood(text, nf) {
  if (!nf || Math.abs(nf - 1) < 0.02) return text;
  return text.split(/(\s*\+\s*|,\s+|\bwith\b)/i).map((seg) => {
    if (/^\s*(\+|,|with)\s*$/i.test(seg) || !seg.trim()) return seg;   // separators
    if (!SCALE_FOOD.test(seg)) return seg;                             // only trim carb/fat foods
    return seg.replace(/(\d+(?:\.\d+)?)\s?(g|ml)\b/gi, (_, n, u) => Math.round(n * nf) + u);
  }).join("");
}
function recipeBlock(meal, pf = 1, nf = pf) {
  const d = meal.items.Dinner; if (!d || !d.recipe) return "";
  const r = d.recipe, title = d.text.split(" — ")[0];
  const up = pf > 1.02, down = nf < pf - 0.02;   // up = bigger portion, down = protein-protected trim
  const ing = r.ingredients.map((x) => down ? scaleFood(x, nf) : scaleAmounts(x, pf));
  const tag = up ? `×${pf.toFixed(2)}` : down ? `carbs ×${nf.toFixed(2)}` : "";
  const note = up ? `Quantities scaled ×${pf.toFixed(2)} for your bigger portion.`
    : down ? `Carb/fat amounts trimmed ×${nf.toFixed(2)} to hit your aim — protein kept full.` : "";
  return `<details class="recipe"><summary>📖 Tonight's recipe — ${title}${tag ? ` <span class="swap-tag">${tag}</span>` : ""}</summary>
    <div class="recipe-body">
      ${note ? `<p class="note" style="margin:0 0 6px">${note}</p>` : ""}
      <div class="section-label">Ingredients</div>
      <ul class="recipe-ing">${ing.map(x => `<li>${x}</li>`).join("")}</ul>
      <div class="section-label">Method</div>
      <ol class="recipe-steps">${r.steps.map(x => `<li>${x}</li>`).join("")}</ol>
    </div></details>`;
}

/* ---------- profile (multi-user: stats + goal, stored per device) ---------- */
const ACTIVITY = { sedentary: 1.4, light: 1.55, moderate: 1.7, active: 1.85 };
const GOALS = { cut: "Lose fat", maintain: "Maintain", gain: "Gain muscle" };
// default profile mirrors the bundled plan (so existing users are unchanged)
function defaultProfile() {
  const s = PLAN.meta.stats;
  const base = 10 * s.weightKg + 6.25 * s.heightCm - 5 * s.age + (s.sex === "female" ? -161 : 5);
  const af = (PLAN.meta.maintenance || base) / base;
  return { name: PLAN.meta.athlete, sex: s.sex || "male", age: s.age, heightCm: s.heightCm,
    weightKg: s.weightKg, activity: +af.toFixed(3), goal: "cut", surplus: 300,
    dislikes: (PLAN.meta.dislikes || []).slice() };
}
function getProfile() { const p = LS.get("pt_profile", null); return p ? { ...defaultProfile(), ...p } : defaultProfile(); }
function saveProfile(p) { LS.set("pt_profile", p); }
// fresh device (no profile, nothing logged) → show onboarding
function needsOnboarding() {
  if (LS.get("pt_profile", null)) return false;
  if (LS.get("pt_weights", []).length) return false;
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf("pt_checks_") === 0) return false; }
  return true;
}
// age bands drive how the app behaves: <13 unsupported, 13–17 numbers-free, 60+ tuned
function ageBand(p = getProfile()) {
  const a = parseInt(p.age, 10) || 30;
  if (a < 13) return "child";
  if (a < 18) return "teen";
  if (a >= 60) return "older";
  return "adult";
}
function numbersFree() { const b = ageBand(); return b === "teen" || b === "child"; } // hide calorie figures under 18
function trainingStyle() {
  const tp = PLAN.trainingPlans || {};
  if (ageBand() === "older" && tp.older) return "gentle full-body + balance";
  if (getProfile().goal === "gain" && tp.gain) return "hypertrophy / lean-gain";
  return "fat-loss + conditioning";
}
// daily protein target from bodyweight (older adults get a higher floor to preserve muscle)
function proteinTarget(p = getProfile()) {
  const band = ageBand(p);
  const perKg = band === "older" ? 1.6 : p.goal === "gain" ? 2.0 : 1.8;
  return Math.round(latestWeight() * perKg);
}

/* ---------- metabolism (TDEE auto-recalc) ---------- */
function bmr(w) { const p = getProfile(); return 10 * w + 6.25 * p.heightCm - 5 * p.age + (p.sex === "female" ? -161 : 5); }
function activityFactor() { return getProfile().activity || 1.5; }
function latestWeight() { const w = LS.get("pt_weights", []); return w.length ? w[w.length - 1].kg : getProfile().weightKg; }
function currentMaintenance() { return Math.round(bmr(latestWeight()) * activityFactor()); }
// daily kcal offset from maintenance by goal (cut keeps the phase-stepped deficit)
function goalDelta(pos) {
  const p = getProfile();
  if (p.goal === "gain") return +(p.surplus || 300);
  if (p.goal === "maintain") return 0;
  // cut: deficit from the bundled calorie phases (independent of which training plan is active)
  const calPhase = phaseForWeek(PLAN.phases, Math.max(1, pos.week));
  return -((PLAN.meta.maintenance || 2250) - calPhase.calories);
}
function adjustedAim(pos) { return Math.round((currentMaintenance() + goalDelta(pos)) / 10) * 10; }
const DEFAULT_SUPPS = ["Whey protein", "Creatine 5g", "Vitamin D"];
function getSupps() { return LS.get("pt_supps", DEFAULT_SUPPS); }

/* ---------- coaching: form guide, warm-up, readiness ---------- */
// form cues per movement pattern, matched against the exercise text
const FORM_GUIDE = [
  [/squat|sit-to-stand/i, ["Chest up, sit down between your hips", "Knees track over the toes", "Drive up through the whole foot"], ["Heels lifting off the floor", "Knees caving inwards"]],
  [/bench press|floor press|chest press/i, ["Squeeze shoulder blades back into the bench", "Lower to mid-chest with wrists stacked over elbows", "Feet planted for drive"], ["Elbows flared to 90°", "Bouncing the bar off your chest"]],
  [/push-?up|press-?up/i, ["Body one rigid line — squeeze glutes and abs", "Hands under shoulders, elbows ~45°", "Chest to an inch off the floor"], ["Hips sagging or piking", "Half reps"]],
  [/\brow\b/i, ["Pull the elbow back towards your hip", "Squeeze the shoulder blade at the top for 1s", "Spine stays long and neutral"], ["Shrugging the shoulder up", "Heaving with momentum"]],
  [/romanian|rdl\b/i, ["Push hips straight back, soft knees", "Weight stays close, sliding down the thighs", "Stop at a hamstring stretch, flat back"], ["Rounding the lower back", "Turning it into a squat"]],
  [/deadlift/i, ["Weight over mid-foot, brace hard before you pull", "Push the floor away — hips and shoulders rise together", "Lock out tall, don't lean back"], ["Jerking the weight off the floor", "Back rounding as you tire"]],
  [/shoulder press|overhead|arnold/i, ["Ribs down, glutes tight before you press", "Press up and slightly back to stack over shoulders", "Lower with control to chin level"], ["Arching the lower back", "Pressing out in front of you"]],
  [/pulldown|pull-?up/i, ["Lead with the chest, pull elbows down and back", "Bar/hands towards the collarbone", "Full stretch at the top of each rep"], ["Swinging or leaning way back", "Cutting the range short"]],
  [/hip thrust|glute bridge/i, ["Chin tucked, ribs down", "Drive through the heels, squeeze glutes hard 1s at the top", "Finish flat like a tabletop"], ["Hyperextending the lower back at the top"]],
  [/lunge|split squat|step-?up/i, ["Torso tall, front knee tracks over the toe", "Lower under control — don't drop", "Push through the front heel to stand"], ["Knee slamming the floor", "Bouncing off the back leg"]],
  [/leg press/i, ["Feet mid-platform, hip width", "Lower to ~90° knee bend or your comfortable depth", "Press without locking the knees hard"], ["Bum lifting off the pad (too deep)", "Ego-loading half reps"]],
  [/plank/i, ["Squeeze glutes and abs — one straight line ear to ankle", "Push the floor away through forearms", "Keep breathing"], ["Hips sagging or piking up", "Holding your breath"]],
  [/curl/i, ["Elbows pinned to your sides", "Squeeze at the top, lower slow (2–3s)", "Full range — arms straight at the bottom"], ["Swinging the hips to lift", "Half reps in the middle"]],
  [/tricep|pushdown|skull|extension\b/i, ["Elbows stay still — only the forearm moves", "Squeeze the lockout for 1s", "Control the way back"], ["Shoulders rolling forward to press", "Elbows drifting out"]],
  [/lateral raise/i, ["Lead with the elbows, slight bend", "Raise to shoulder height, no higher", "Tip the pinky slightly up, lower slow"], ["Shrugging the traps", "Swinging heavier than you can control"]],
  [/calf raise/i, ["Full stretch at the bottom", "Pause 1s at the very top", "Slow on the way down"], ["Bouncing out of the bottom"]],
  [/face pull|pull-?apart/i, ["Pull towards your eyebrows, thumbs pointing back", "Squeeze the rear delts and hold 1s"], ["Turning it into a heavy row"]],
  [/leg curl/i, ["Hips pressed down into the pad", "Slow 3s negative on every rep"], ["Hips lifting as you curl"]],
  [/dead bug/i, ["Lower back pressed flat into the floor throughout", "Opposite arm and leg, slow and controlled", "Exhale as you extend"], ["Back arching off the floor"]],
  [/bird-?dog/i, ["Hips stay level — imagine a drink balanced on your back", "Reach long, not high"], ["Rotating or twisting the torso"]],
  [/knee raise|leg raise/i, ["Curl the pelvis up at the top — don't just lift legs", "Lower slowly without arching"], ["Swinging for momentum"]],
  [/wall sit/i, ["Back flat against the wall, knees at ~90°", "Weight through the heels, hands off the thighs"], ["Resting hands on your legs"]],
  [/pallof/i, ["Press out and resist the twist — ribs down", "Slow out, slow back"], ["Leaning away from the anchor"]],
  [/crunch/i, ["Ribs towards hips, exhale hard at the top", "Chin off your chest"], ["Pulling on your neck"]],
  [/cycle|elliptical|zone 2|walk\b/i, ["Conversational pace — you can talk in full sentences", "Light grip, relaxed shoulders", "Smooth, even cadence"], ["Creeping into a pace you can't sustain"]],
];
function formTipFor(text) {
  for (const [re, cues, avoid] of FORM_GUIDE) if (re.test(text)) return { cues, avoid };
  return null;
}
// warm-up protocol generated for the day type
function warmupBlock(day) {
  if (day.type === "rest") return "";
  const body = day.type === "strength"
    ? `<ul class="warmup-list">
        <li>2–3 min easy cycle / brisk march to raise your pulse</li>
        <li>10 arm circles each way · 10 bodyweight squats · 10 hip hinges</li>
        <li>15 band pull-aparts (or 10 slow wall press-ups)</li>
        <li><b>First lift:</b> 2 ramp-up sets — ~50% × 8, then ~75% × 5 — before your working weight</li>
      </ul>`
    : day.type === "hiit"
    ? `<ul class="warmup-list">
        <li>5 min building from easy to moderate pace</li>
        <li>10 leg swings each side · 10 bodyweight squats</li>
        <li>2 × 15s at interval pace with full recovery before the first real rep</li>
      </ul>`
    : `<ul class="warmup-list">
        <li>Start the first 5 min noticeably easier than your target pace</li>
        <li>10 slow calf raises + ankle circles before you settle in</li>
      </ul>`;
  return `<details class="fold warmup"><summary>🔥 Warm-up first — 3–5 min</summary>
    <div class="fold-body">${body}
    <p class="note" style="margin:6px 0 0">A warm body lifts more and gets injured less. Never skip it on cold mornings.</p></div></details>`;
}
// morning readiness: sleep + soreness + energy (each 1–3) → tailored advice for the day
function readinessAdvice(score, dayType) {
  const low = {
    strength: "Go lighter today — same moves, one fewer set, leave 3 reps in the tank. Showing up still counts double on rough days.",
    cardio: "Keep it genuinely easy — shorter is fine. Move, don't push.",
    hiit: "Swap the intervals for 20 easy minutes — intensity needs fuel you don't have today.",
    rest: "Perfect timing for a rest day. Eat well, get to bed early tonight.",
  };
  const mid = {
    strength: "Train as planned — hit your target sets and stop 1–2 reps shy of failure.",
    cardio: "Steady as planned — settle into a rhythm you could hold all day.",
    hiit: "Do the session, but cap the last interval rather than emptying the tank.",
    rest: "Recover well — a short easy walk speeds it up.",
  };
  const high = {
    strength: "You're primed — chase the suggested top sets, and take the extra rep if it's there.",
    cardio: "Feeling good? Add 5–10 minutes at the same easy effort.",
    hiit: "Green light — attack the intervals, full quality on every rep.",
    rest: "Bank the energy — easy walk today, and tomorrow's session will fly.",
  };
  const band = score <= 4 ? low : score <= 7 ? mid : high;
  return band[dayType] || band.strength;
}
function readinessMeta(score) {
  return score <= 4 ? ["🪫", "Run down"] : score <= 7 ? ["🔋", "Steady"] : ["⚡", "Primed"];
}
// day-progress traffic light: expected completion ramps gently from ~10am so mornings
// aren't red. ONE curve, shared by renderToday and the surgical chip updates.
function trafficLight(frac) {
  const expected = Math.max(0, Math.min(0.9, (new Date().getHours() - 10) / 12));
  return frac >= expected ? "green" : frac >= expected * 0.6 ? "amber" : "red";
}

/* ---------- XP & levels (derived retroactively from everything already logged) ---------- */
const XP_RULES = "workout tick 5 · meal 3 · 2 L water day 10 · weigh-in 5 · exercise logged 8 · photo 15 · measurements 10";
function computeXP() {
  let xp = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k.indexOf("pt_checks_") === 0) {
      const c = LS.get(k, {});
      xp += Object.values(c.workout || {}).filter(Boolean).length * 5;
      xp += Object.values(c.meals || {}).filter(Boolean).length * 3;
      if ((c.water || 0) >= 8) xp += 10;
    } else if (k.indexOf("pt_lift_") === 0) {
      xp += Object.keys(LS.get(k, {})).length * 8;
    }
  }
  xp += LS.get("pt_weights", []).length * 5;
  xp += LS.get("pt_meas", []).length * 10;
  xp += PHOTOS.length * 15;
  return xp;
}
// level n starts at 100·n·(n−1)/2 XP (0, 100, 300, 600, 1000, …)
const LEVEL_NAMES = ["Rookie", "Starter", "Regular", "Grinder", "Committed", "Athlete", "Machine", "Beast", "Elite", "Legend"];
function xpLevel(xp) {
  let lvl = 1;
  while (100 * lvl * (lvl + 1) / 2 <= xp) lvl++;
  const base = 100 * (lvl - 1) * lvl / 2, next = 100 * lvl * (lvl + 1) / 2;
  return { lvl, name: LEVEL_NAMES[Math.min(lvl, LEVEL_NAMES.length) - 1], xp, next,
    pct: Math.max(0, Math.min(100, Math.round(((xp - base) / (next - base)) * 100))) };
}
function xpCard() {
  const lv = xpLevel(computeXP());
  const nextName = LEVEL_NAMES[Math.min(lv.lvl + 1, LEVEL_NAMES.length) - 1];
  return `<div class="card"><div class="xp-head"><h2 style="margin:0">🎖️ Level ${lv.lvl} — ${lv.name}</h2><span class="xp-num">${lv.xp.toLocaleString()} XP</span></div>
    <div class="progress-track" style="margin:12px 0 6px"><div class="progress-fill" style="width:${lv.pct}%"></div></div>
    <p class="sub">${(lv.next - lv.xp).toLocaleString()} XP to Level ${lv.lvl + 1} — ${nextName}</p>
    <p class="note">Everything you log earns XP: ${XP_RULES}.</p></div>`;
}

/* ---------- HIIT interval coach (parsed straight from the plan text) ---------- */
function parseInterval(items) {
  for (const t of items) {
    const m = /(\d+)\s*x\s*\((\d+)s\s*hard[^/]*\/\s*(\d+)s\s*easy/i.exec(t);
    if (m) return { rounds: +m[1], work: +m[2], easy: +m[3] };
  }
  return null;
}
// The ONE builder for today's workout rows (ticks, suggestions, log buttons, ⓘ form
// guides, inline logger). Used by renderToday AND the surgical Gym/Home swap — keep
// them identical by never duplicating this template.
function workoutRowsHtml(day, exercises, checks, dn) {
  return exercises.map((t, i) => {
    const done = checks.workout[i];
    const lf = day.type === "strength" ? parseLift(t) : { loggable: false };
    let suffix = "", logBtn = "", logger = "";
    if (lf.loggable) {
      const logged = todayLift(lf.name);
      const open = OPEN_LIFT === lf.name;
      if (logged.length) {
        const top = Math.max(0, ...logged.map((s) => e1rm(s.w, s.r)));
        suffix = `<span class="lift-done"> ✓ ${setSummary(logged)}${top ? ` · e1RM ${top}` : ""}</span>`;
      } else {
        const sug = suggestLift(lf.name, dn, lf.repLow, lf.repHigh);
        if (sug) suffix = `<span class="lift-sug"> · 🎯 ${sug.w ? sug.w + "kg" : "BW"} × ${sug.reps}${sug.progress ? " ⤴" : ""}</span>`;
      }
      const lbl = open ? "✕ Close" : logged.length ? `✎ Edit weights` : `🏋️ Log weight & reps`;
      logBtn = `<button type="button" class="log-btn ${open ? "open" : logged.length ? "logged" : ""}" data-act="openlift" data-name="${encodeURIComponent(lf.name)}">${lbl}</button>`;
      if (open) logger = liftLogger(lf, dn);
    }
    const tip = formTipFor(t);
    const infoBtn = tip ? `<button type="button" class="x-del info-btn ${OPEN_FORM === t ? "on" : ""}" data-act="formguide" data-name="${encodeURIComponent(t)}" title="Form guide" aria-label="Form guide">ⓘ</button>` : "";
    const formTip = (tip && OPEN_FORM === t) ? `<li class="form-tip"><div style="width:100%">
        <div class="ft-label">✅ Form cues</div>
        <ul>${tip.cues.map((c) => `<li>${c}</li>`).join("")}</ul>
        <div class="ft-label">⚠️ Avoid</div>
        <ul>${tip.avoid.map((c) => `<li>${c}</li>`).join("")}</ul>
      </div></li>` : "";
    return `<li class="${done ? "done" : ""} ${lf.loggable ? "wlog" : ""}" data-act="workout" data-i="${i}">
      <span class="checkbox">${done ? "✓" : ""}</span>
      <span class="item-text">${t}${suffix}</span>${infoBtn}${logBtn}</li>${formTip}${logger}`;
  }).join("");
}

/* ---------- TODAY ---------- */
// Prep-ahead notes for a meal: explicit prep fields + an auto defrost hint for meat dinners.
function prepNotes(meal) {
  const out = [];
  for (const [slot, v] of Object.entries(meal.items)) if (v.prep) out.push([slot, v.prep]);
  const d = meal.items.Dinner;
  if (d && !d.prep) {
    const meat = /chicken|beef|pork|turkey|sausage|mince|lamb|gammon|ham/i.exec(d.text);
    if (meat) out.push(["Dinner", `Take the ${meat[0].toLowerCase()} out to defrost tonight if it's frozen.`]);
  }
  return out;
}

// ---- day navigation (read-only past days) ----
function dayNav(pos) {
  const vdn = pos.dn + VIEW_OFFSET;
  const canBack = vdn > 0;            // don't browse before program day 1
  const canFwd = VIEW_OFFSET < 0;     // can't go past today
  const vkey = dateKeyForDn(vdn);
  const label = VIEW_OFFSET === 0
    ? "Today"
    : new Date(vkey + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `<div class="day-nav">
    <button type="button" class="day-nav-btn" data-act="prevday"${canBack ? "" : " disabled"} aria-label="Previous day">‹</button>
    <div class="day-nav-label">${VIEW_OFFSET !== 0 ? "🔒 " : ""}${label}${VIEW_OFFSET !== 0 ? ` · Day ${vdn + 1}` : ""}</div>
    <button type="button" class="day-nav-btn" data-act="nextday"${canFwd ? "" : " disabled"} aria-label="Next day">›</button>
    ${VIEW_OFFSET !== 0 ? `<button type="button" class="day-nav-today" data-act="todayview">Jump to today</button>` : ""}
  </div>`;
}

// Read-only recap of a past program day — no interactive controls, history is locked.
function renderDayRecap(pos) {
  const vdn = pos.dn + VIEW_OFFSET;
  const vkey = dateKeyForDn(vdn);
  const week = Math.floor(vdn / 7) + 1;
  const weekday = (new Date(vkey + "T00:00:00").getDay() + 6) % 7;
  const phase = phaseForWeek(activePhases(), Math.max(1, week));
  const day = phase.schedule[weekday];
  const checks = LS.get("pt_checks_" + vkey, { workout: {}, meals: {}, water: 0 });
  const dateStr = new Date(vkey + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  // workout that day (respect saved gym/home mode), with done state + any logged sets
  const mode = LS.get("pt_mode", "gym");
  const exercises = (mode === "home" && day.homeItems) ? day.homeItems : day.items;
  const liftLog = LS.get("pt_lift_" + vkey, {});
  const workItems = exercises.map((t, i) => {
    const done = checks.workout[i];
    const lf = day.type === "strength" ? parseLift(t) : { loggable: false };
    let suffix = "";
    if (lf.loggable && liftLog[lf.name] && liftLog[lf.name].length) {
      const sets = liftLog[lf.name];
      const top = Math.max(0, ...sets.map((s) => e1rm(s.w, s.r)));
      suffix = `<span class="lift-done"> ✓ ${setSummary(sets)}${top ? ` · e1RM ${top}` : ""}</span>`;
    }
    return `<li class="${done ? "done" : ""}" style="cursor:default">
      <span class="checkbox">${done ? "✓" : ""}</span>
      <span class="item-text">${t}${suffix}</span></li>`;
  }).join("");
  const wDone = exercises.filter((_, i) => checks.workout[i]).length;

  // meals that day (with the swaps that were applied), done/skipped state
  const swapIdx = LS.get("pt_swap_" + vkey, null);
  const swapped = swapIdx != null && swapIdx >= 0 && swapIdx < PLAN.meals.length;
  const meal = swapped ? applyMealOverrides(PLAN.meals[swapIdx], vkey) : dayMeal(vdn);
  const mealKeys = Object.keys(meal.items);
  const skipped = LS.get("pt_skip_" + vkey, {});
  const mealItems = mealKeys.map((k, i) => {
    const done = checks.meals[i];
    const m = meal.items[k];
    const isSkip = !!skipped[k];
    const label = isSkip ? `${k} · skipped` : `${k} · ${m.kcal} kcal · ${m.p}g P`;
    return `<li class="${done ? "done" : ""} ${isSkip ? "skipped-meal" : ""}" style="cursor:default">
      <span class="checkbox">${done ? "✓" : ""}</span>
      <span class="item-text"><span class="meal-label">${label}</span>${m.text}</span></li>`;
  }).join("");
  const mDone = mealKeys.filter((k, i) => checks.meals[i] || skipped[k]).length;

  // the rest of the day's log
  const supps = getSupps();
  const suppChecks = LS.get("pt_supp_" + vkey, {});
  const tookSupps = supps.filter((s) => suppChecks[s]);
  const wIn = LS.get("pt_weights", []).find((w) => w.date === vkey);
  const cheat = LS.get("pt_cheat_" + vkey, 0);
  const perfect = wDone === exercises.length && mDone === mealKeys.length && checks.water >= 8;
  const anyLogged = wDone || mDone || checks.water || tookSupps.length || wIn || cheat;

  return `
  <div class="card hero">
    <div class="hero-top">
      <span class="phase-tag">Phase ${phase.id} · ${phase.name}</span>
      <span class="light-pill">🔒 Locked</span>
    </div>
    <p class="greet">${dateStr}</p>
    <h1>${day.emoji} ${day.name}</h1>
    <p class="hero-meta">Week ${week}/12 · Day ${vdn + 1}${perfect ? " · 🎉 perfect day" : ""}</p>
    <div class="today-chips">
      <span class="chip ${wDone === exercises.length && exercises.length ? "on" : ""}">${day.type === "rest" ? "😴" : "🏋️"} ${wDone}/${exercises.length}</span>
      <span class="chip ${mDone === mealKeys.length ? "on" : ""}">🍽️ ${mDone}/${mealKeys.length}</span>
      <span class="chip ${checks.water >= 8 ? "on" : ""}">💧 ${checks.water}/8</span>
    </div>
  </div>

  ${!anyLogged ? `<div class="card"><p class="note" style="margin:0">📭 Nothing was logged on this day.</p></div>` : ""}

  <div class="card">
    <div class="work-head">
      <span class="work-emoji">${day.emoji}</span>
      <div><h2 style="margin:0">${day.name}</h2>
      <span class="type-badge type-${day.type}">${day.type.toUpperCase()}</span></div>
    </div>
    <ul class="checklist">${workItems}</ul>
  </div>

  <div class="card">
    <h2>🍽️ Fuel${swapped ? ' <span class="swap-tag">swapped</span>' : ""}</h2>
    <p class="sub">${meal.name} · ${meal.totals.kcal} kcal · ${meal.totals.protein}g P</p>
    <ul class="checklist">${mealItems}</ul>
  </div>

  <div class="card">
    <h2>📋 Day log</h2>
    <div class="log-sec"><div class="log-label">💧 Water · ${checks.water}/8</div></div>
    ${supps.length ? `<div class="log-sec"><div class="log-label">💊 Supplements</div>
      <div class="supp-chips">${supps.map((s) => `<span class="supp-chip ${suppChecks[s] ? "on" : ""}">${suppChecks[s] ? "✓ " : ""}${s}</span>`).join("")}</div></div>` : ""}
    <div class="log-sec"><div class="log-label">⚖️ Weigh-in</div>
      <p class="note" style="margin:0">${wIn ? `<b>${wIn.kg} kg</b>` : "— not logged"}</p></div>
    ${cheat ? `<div class="log-sec"><div class="log-label">🍔 Treat logged</div><p class="note" style="margin:0">+${cheat} kcal</p></div>` : ""}
    ${(() => { const r = LS.get("pt_ready_" + vkey, null); if (!r || !(r.s && r.m && r.e)) return "";
      const sc = r.s + r.m + r.e; const [emo, word] = readinessMeta(sc);
      return `<div class="log-sec"><div class="log-label">🌅 Readiness</div><p class="note" style="margin:0">${emo} ${word} · ${sc}/9</p></div>`; })()}
  </div>

  <p class="note" style="text-align:center;margin:4px 0 0">🔒 Past days are read-only — you can look back but not change them.</p>`;
}

function renderToday() {
  const pos = position();
  if (VIEW_OFFSET !== 0) return dayNav(pos) + renderDayRecap(pos);
  const key = todayKey();
  const checks = LS.get("pt_checks_" + key, { workout: {}, meals: {}, water: 0 });

  if (pos.beforeStart) {
    const days = Math.abs(pos.dn);
    return `<div class="card hero"><span class="phase-tag">Get ready</span>
      <h1>Starts in ${days} day${days === 1 ? "" : "s"}</h1>
      <p>Your 12-week shred begins ${getStartDate()}. Want to start today instead? Go to Settings → Start date.</p></div>`;
  }
  if (pos.finished) {
    return `${dayNav(pos)}<div class="card hero celebrate"><div class="big">🏆</div>
      <h1>12 weeks done!</h1><p>You finished the program. Log a final weigh-in on the Progress tab and take some photos — then either reset your start date to run it again, or move to a maintenance phase.</p></div>`;
  }

  const day = pos.phase.schedule[pos.weekday];
  const swapIdx = LS.get("pt_swap_" + key, null);
  const swapped = swapIdx != null && swapIdx >= 0 && swapIdx < PLAN.meals.length;
  const meal = swapped ? applyMealOverrides(PLAN.meals[swapIdx], key) : dayMeal(pos.dn);
  const quote = QUOTES[pos.dn % QUOTES.length];

  // gym vs home variant
  const mode = LS.get("pt_mode", "gym");
  const useHome = mode === "home" && day.homeItems;
  const exercises = useHome ? day.homeItems : day.items;

  // workout checklist (shared builder — also used by the surgical Gym/Home swap)
  const workItems = workoutRowsHtml(day, exercises, checks, pos.dn);

  // meals checklist — portions auto-scale so the day lands on today's calorie aim,
  // and a skipped meal redistributes its share across the rest.
  const mealKeys = Object.keys(meal.items);
  const skipped = LS.get("pt_skip_" + key, {});
  const anySkipped = mealKeys.some((k) => skipped[k]);
  const payback = paybackForDay(pos.dn);
  const aim = dailyAim(pos);
  const aimAdj = aim !== pos.phase.calories;
  // base macros across the non-skipped meals
  const remainBaseKcal = mealKeys.filter((k) => !skipped[k]).reduce((s, k) => s + meal.items[k].kcal, 0);
  const baseProtein = mealKeys.filter((k) => !skipped[k]).reduce((s, k) => s + meal.items[k].p, 0);
  const baseFat = Math.round(0.28 * remainBaseKcal / 9);
  const baseCarbs = Math.max(0, Math.round((remainBaseKcal - 4 * baseProtein - 9 * baseFat) / 4));
  // scale the day to today's aim, PROTECTING protein: when trimming calories, hold
  // protein full and take the cut from carbs/fat only. Scaling up (diet break / skip
  // redistribution) lifts everything together.
  const proteinKcal = baseProtein * 4;
  const baseNonProtein = Math.max(1, remainBaseKcal - proteinKcal);
  const scaleDown = remainBaseKcal > 0 && aim < remainBaseKcal;
  const pf = !scaleDown ? (remainBaseKcal > 0 ? Math.min(1.8, aim / remainBaseKcal) : 1) : 1;     // protein/overall factor
  const nf = !scaleDown ? pf : Math.max(0.2, Math.min(1, (aim - proteinKcal) / baseNonProtein));   // carb/fat factor
  const scaled = Math.abs(pf - 1) > 0.02 || Math.abs(nf - 1) > 0.02;
  // live (scaled) day totals for the macro card — protein held full when trimming
  const liveP = Math.round(baseProtein * pf);
  const liveFat = Math.round(baseFat * nf);
  const liveCarbs = Math.round(baseCarbs * nf);
  const liveTotals = { kcal: liveP * 4 + liveCarbs * 4 + liveFat * 9, protein: liveP, carbs: liveCarbs, fat: liveFat };
  const teen = numbersFree(); // 13–17: hide calorie/macro figures, keep the food + habits
  // split each meal's scaled non-protein calories into carbs/fat using the day ratio
  const npDayKcal = (liveCarbs * 4 + liveFat * 9) || 1;
  const carbShare = (liveCarbs * 4) / npDayKcal, fatShare = (liveFat * 9) / npDayKcal;
  const consumed = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const served = { kcal: 0, protein: 0, carbs: 0, fat: 0 }; // sum of the day's meals (the budget)
  const slotKeyOf = Object.fromEntries(SLOTS);
  const libNow = getLibrary();
  const mealItems = mealKeys.map((k, i) => {
    const done = checks.meals[i];
    const m = meal.items[k];
    const isSkip = !!skipped[k];
    const npK = Math.max(0, m.kcal - m.p * 4) * nf;
    const kc = isSkip ? 0 : Math.round(m.p * 4 * pf + npK);
    const pr = isSkip ? 0 : Math.round(m.p * pf);
    const cb = isSkip ? 0 : Math.round(npK * carbShare / 4);
    const ft = isSkip ? 0 : Math.round(npK * fatShare / 9);
    if (!isSkip) { served.kcal += kc; served.protein += pr; served.carbs += cb; served.fat += ft; }
    if (done && !isSkip) { consumed.kcal += kc; consumed.protein += pr; consumed.carbs += cb; consumed.fat += ft; }
    const label = isSkip ? `${k} · skipped`
      : teen ? `${k}${pf > 1.02 ? " · larger portion" : ""}`
      : `${k} · ${kc} kcal · ${pr}g P${pf > 1.02 ? ` · ×${pf.toFixed(1)}` : ""}`;
    let row = `<li class="${done ? "done" : ""} ${isSkip ? "skipped-meal" : ""}" data-act="meals" data-i="${i}" data-kc="${kc}" data-pr="${pr}" data-cb="${cb}" data-ft="${ft}">
      <span class="checkbox">${done ? "✓" : ""}</span>
      <span class="item-text"><span class="meal-label">${label}</span>${isSkip ? m.text : (scaleDown ? scaleFood(m.text, nf) : scaleAmounts(m.text, pf))}</span>
      <span class="meal-actions">
        <button type="button" class="x-del" data-act="openswap" data-slot="${encodeURIComponent(k)}" title="Swap this meal">${SWAP_SLOT === k ? "▲" : "🔀"}</button>
        <button type="button" class="x-del meal-skip" data-act="skipmeal" data-slot="${encodeURIComponent(k)}" title="${isSkip ? "Restore" : "Skip & redistribute"}">${isSkip ? "↺" : "⊘"}</button>
      </span></li>`;
    if (SWAP_SLOT === k && BANK) {
      const sk = slotKeyOf[k];
      const pool = libNow ? libNow[sk].map(id => BANK[sk].byId[id]).filter(Boolean) : BANK[sk].list;
      const curId = m.id;
      row += `<li class="swap-inline"><div class="swap-list">
        <button type="button" class="swap-opt reset" data-act="pickmeal" data-slot="${encodeURIComponent(k)}" data-id="__default">↩︎ Back to default</button>
        ${pool.map(o => `<button type="button" class="swap-opt ${o.id === curId ? "cur" : ""}" data-act="pickmeal" data-slot="${encodeURIComponent(k)}" data-id="${o.id}">
          <span>${o.text.split(" — ")[0]}</span><span class="swap-kcal">${o.kcal} kcal · ${o.p}g P</span></button>`).join("")}
      </div></li>`;
    }
    return row;
  }).join("");
  const skipNote = anySkipped
    ? `<p class="note" style="margin:6px 0 0;color:var(--accent-2)">⊘ Skipped ${mealKeys.filter(k => skipped[k]).join(", ")} — ${scaleDown ? `remaining portions trimmed, protein held at <b>${liveP}g</b>` : `portions bumped <b>×${pf.toFixed(2)}</b> on the rest`} to hit your ~${aim} kcal aim.</p>`
    : (scaled
      ? `<p class="note" style="margin:6px 0 0">🍽️ Portions scaled to your <b>~${aim} kcal</b> aim${scaleDown ? ` — protein kept full at <b>${liveP}g</b>, the trim comes off carbs & fat` : ""}${payback > 0 ? " (includes a recent treat payback)" : ""}.</p>`
      : "");

  // live "left to eat" budget — counts down as you tick meals + log extras (hidden in teen mode)
  const xt = extrasTotals(key);
  const eaten = { kcal: consumed.kcal + xt.kcal, protein: consumed.protein + xt.protein, carbs: consumed.carbs + xt.carbs, fat: consumed.fat + xt.fat };
  const over = eaten.kcal > served.kcal, allIn = eaten.kcal >= served.kcal;
  const remainRow = teen ? "" : `<div class="remain ${allIn ? "done" : ""} ${over ? "over" : ""}" id="remainRow"
      data-kcal="${served.kcal}" data-protein="${served.protein}" data-carbs="${served.carbs}" data-fat="${served.fat}"
      data-xkcal="${xt.kcal}" data-xprotein="${xt.protein}" data-xcarbs="${xt.carbs}" data-xfat="${xt.fat}">
    ${[["kcal", "kcal"], ["protein", "protein"], ["carbs", "carbs"], ["fat", "fat"]].map(([m, l]) =>
      `<div class="remain-cell"><span class="rv" data-m="${m}">${Math.max(0, served[m] - eaten[m])}</span><span class="rl">${l} left</span></div>`).join("")}
  </div>${over ? `<p class="note" style="margin:6px 0 0;color:var(--warn)">Over today's aim by ${eaten.kcal - served.kcal} kcal.</p>` : ""}`;

  // ad-hoc food logging (snacks/drinks beyond the plan) — counts against the budget
  const extras = LS.get("pt_extra_" + key, []);
  const extrasBlock = teen ? "" : `
    ${extras.length ? `<ul class="checklist extras-list">${extras.map((x, i) => `<li style="cursor:default" class="done">
      <span class="checkbox">✓</span>
      <span class="item-text"><span class="meal-label">Extra · ${(+x.kcal || 0)} kcal · ${(+x.p || 0)}g P</span>${x.name}</span>
      <button type="button" class="x-del" data-act="delextra" data-i="${i}">✕</button></li>`).join("")}</ul>` : ""}
    <details class="swap"><summary>➕ Log an extra food or snack</summary>
      <div class="fold-body">
        <input class="field" id="extraName" placeholder="What did you eat? (e.g. flat white, protein bar)" style="margin-bottom:8px" />
        <div class="tracker-row">
          <input class="field" id="extraKcal" type="number" inputmode="numeric" placeholder="kcal" style="max-width:90px" />
          <input class="field" id="extraP" type="number" inputmode="numeric" placeholder="protein g" style="max-width:110px" />
          <button type="button" class="btn accent" id="addExtraBtn">Add</button>
        </div>
        <p class="note" style="margin-top:6px">Counts against your “left to eat” above. Carbs &amp; fat are estimated from the calories.</p>
      </div></details>`;

  // water glasses (target ~8 × 250ml = 2L) — tap a glass to set your level
  const waterDots = Array.from({ length: 8 }, (_, i) =>
    `<div class="water-dot ${i < checks.water ? "filled" : ""}" data-act="water" data-i="${i}" aria-label="${i + 1} glasses">${i < checks.water ? "💧" : ""}</div>`
  ).join("");

  // time-aware greeting + date
  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const dateStr = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  // today at a glance — activity rings (workout · meals · water) + week ribbon
  const wDone = exercises.filter((_, i) => checks.workout[i]).length;
  const mDone = mealKeys.filter((k, i) => checks.meals[i] || skipped[k]).length;
  const ring = (k, r, color, done, total) => {
    const C = (2 * Math.PI * r).toFixed(1);
    const off = (C * (1 - Math.min(1, total ? done / total : 0))).toFixed(1);
    return `<circle class="ring-bg" cx="50" cy="50" r="${r}"/>
      <circle id="ring${k}" class="ring" data-r="${r}" cx="50" cy="50" r="${r}" stroke="${color}"
        stroke-dasharray="${C}" style="stroke-dashoffset:${off}"/>`;
  };
  const waterC = Math.min(checks.water, 8);
  const dayPct = Math.round(100 * (wDone + mDone + waterC) / (exercises.length + mealKeys.length + 8));
  const weekDots = Array.from({ length: 7 }, (_, i) => {
    const d = (pos.week - 1) * 7 + i;
    let cls = "wd-f";
    if (d <= pos.dn) {
      const c = LS.get("pt_checks_" + dateKeyForDn(d), null);
      const wq = c ? Object.values(c.workout || {}).filter(Boolean).length : 0;
      const mq = c ? Object.values(c.meals || {}).filter(Boolean).length : 0;
      cls = "wd-" + ((wq >= 1 ? 1 : 0) + (mq >= 3 ? 1 : 0) + ((c && c.water >= 8) ? 1 : 0));
    }
    return `<span class="wd ${cls} ${d === pos.dn ? "wd-today" : ""}"></span>`;
  }).join("");
  const chips = `<div class="hero-viz">
    <div class="rings-wrap">
      <svg class="rings" viewBox="0 0 100 100" aria-label="Day progress rings">
        ${ring("W", 42, "#f472b6", wDone, exercises.length)}
        ${ring("M", 32, "#34d399", mDone, mealKeys.length)}
        ${ring("H", 22, "#38bdf8", waterC, 8)}
      </svg>
      <div class="rings-pct"><b id="ringPct">${dayPct}%</b><span>day</span></div>
    </div>
    <div class="ring-side">
      <div class="rl"><i style="background:#f472b6"></i><span id="rlW">${day.type === "rest" ? "😴" : "🏋️"} ${wDone}/${exercises.length}</span></div>
      <div class="rl"><i style="background:#34d399"></i><span id="rlM">🍽️ ${mDone}/${mealKeys.length}</span></div>
      <div class="rl"><i style="background:#38bdf8"></i><span id="rlH">💧 ${waterC}/8</span></div>
      <div class="week-dots">${weekDots}<span class="wd-lbl">wk ${pos.week}</span></div>
    </div>
  </div>`;

  // "Up next" — the single smartest things to do right now, as tappable pills
  const nextBits = [];
  const nextMealIdx = mealKeys.findIndex((k, i) => !checks.meals[i] && !skipped[k]);
  if (day.type !== "rest" && wDone < exercises.length)
    nextBits.push(`<button type="button" class="next-pill" data-act="openpanel" data-panel="workout">🏋️ ${wDone ? "Finish" : "Start"} ${day.name} <b>${wDone}/${exercises.length}</b></button>`);
  if (nextMealIdx >= 0) {
    const nm = meal.items[mealKeys[nextMealIdx]];
    nextBits.push(`<button type="button" class="next-pill" data-act="openpanel" data-panel="fuel">🍽️ Next: ${mealKeys[nextMealIdx]}${teen ? "" : ` <b>${Math.round(nm.p * 4 * pf + Math.max(0, nm.kcal - nm.p * 4) * nf)} kcal</b>`}</button>`);
  }
  const expWater = Math.max(0, Math.min(8, Math.round((new Date().getHours() - 8) / 12 * 8)));
  if (waterC < expWater) nextBits.push(`<button type="button" class="next-pill" data-act="openpanel" data-panel="daily">💧 ${expWater - waterC} glass${expWater - waterC > 1 ? "es" : ""} behind pace</button>`);
  const nextStrip = nextBits.length
    ? `<div class="next-strip"><span class="next-lbl">UP NEXT</span>${nextBits.slice(0, 3).join("")}</div>`
    : `<div class="next-strip all-done"><span class="next-lbl">UP NEXT</span><span class="next-pill done-pill">🎉 All done — recover well</span></div>`;

  // tomorrow preview — activity + food (respects the current Gym/Home mode)
  const tDate = new Date(); tDate.setDate(tDate.getDate() + 1);
  const tWeekday = (tDate.getDay() + 6) % 7;
  const tWeek = Math.floor((pos.dn + 1) / 7) + 1;
  const tDayName = tDate.toLocaleDateString("en-GB", { weekday: "long" });
  const tmrw = dayMeal(pos.dn + 1);
  const tmrwPrep = prepNotes(tmrw);
  const prepLines = tmrwPrep.map(([k, v]) => `<div class="prep-line">🌙 <b>${k}:</b> ${v}</div>`).join("");

  let activityHtml;
  if (tWeek > PLAN.meta.weeks) {
    activityHtml = `<div class="tmrw-head">🏁 <b>That's your 12 weeks done!</b></div>`;
  } else {
    const tPhase = phaseForWeek(activePhases(), Math.max(1, tWeek));
    const tDay = tPhase.schedule[tWeekday];
    const tEx = (mode === "home" && tDay.homeItems) ? tDay.homeItems : tDay.items;
    activityHtml = `<div class="tmrw-head"><span class="work-emoji" style="font-size:20px">${tDay.emoji}</span>
        <b>${tDay.name}</b> <span class="type-badge type-${tDay.type}">${tDay.type.toUpperCase()}</span></div>
      <ul class="checklist preview">${tEx.map(t => `<li><span class="bullet">•</span><span class="item-text">${t}</span></li>`).join("")}</ul>`;
  }

  const tomorrowFold = `<details class="card fold ${prepLines ? "tomorrow-prep" : ""}">
    <summary>🌙 Tomorrow · ${tDayName}${prepLines ? ' <span class="swap-tag">prep</span>' : ""}</summary>
    <div class="fold-body">
      <div class="section-label">🏋️ Activity</div>
      ${activityHtml}
      <div class="section-label" style="margin-top:14px">🍽️ Food — ${tmrw.name} (${tmrw.totals.kcal} kcal)</div>
      ${prepLines
        ? `<p class="sub" style="margin:2px 0 0">Sort this tonight so you're ready:</p>${prepLines}`
        : `<p class="note">Nothing to prep ahead. Dinner: ${tmrw.items.Dinner.text}</p>`}
    </div>
  </details>`;

  // perfect day = workout + every meal + 8 water
  const perfect = wDone === exercises.length && mDone === mealKeys.length && checks.water >= 8;
  const perfectBanner = perfect ? `<div class="card hero perfect">
    <div class="confetti">${"🎉".repeat(1)}</div>
    <h1>🎉 Perfect day!</h1>
    <p>Workout done, every meal ticked, fully hydrated. This is exactly how 12 weeks of progress get built.</p>
  </div>` : "";

  // on-track traffic light, merged into the hero (time-aware so it's not red all morning)
  const totalTargets = exercises.length + mealKeys.length + 8;
  const doneTargets = wDone + mDone + Math.min(checks.water, 8);
  const frac = totalTargets ? doneTargets / totalTargets : 0;
  const light = trafficLight(frac);

  // cook once, eat twice — leftover-friendly dinner → tomorrow's lunch
  const dinnerText = meal.items.Dinner ? meal.items.Dinner.text : "";
  const leftoverOK = /chilli|bolognese|curry|cottage pie|meatballs|traybake|one-pot|chorizo|stir-fry|soup|pesto pasta|ragu|casserole|stew/i.test(dinnerText);
  const dinnerTitle = dinnerText.split(" — ")[0].split(" + ")[0];
  const cookTwice = leftoverOK ? `<p class="note" style="margin:6px 0 0;color:var(--accent-2)">🍳 Cook once, eat twice — make an extra portion of tonight's ${dinnerTitle} for tomorrow's lunch.</p>` : "";

  // rest timer (only on training days)
  const restTimer = (day.type !== "rest") ? `
    <div class="rest-timer">
      <span class="rest-display" id="restDisplay">Rest timer</span>
      <div class="rest-btns">
        <button type="button" class="btn rest-btn" data-rest="60">60s</button>
        <button type="button" class="btn rest-btn" data-rest="90">90s</button>
        <button type="button" class="btn rest-btn" data-rest="120">2m</button>
        <button type="button" class="btn rest-btn stop" data-rest="0">✕</button>
      </div>
    </div>` : "";

  // step suggestion (shown inside the activity card, no tracking)
  const stepHint = {
    strength: "🚶 NEAT target: ~7–8k easy steps across the day to keep fat loss ticking — low-impact, spread out so the foot's happy.",
    cardio: "🚶 Today's cardio is your movement — keep extra steps comfortable and pain-free.",
    hiit: "🚶 Intervals cover your output today — no need to chase steps; stay easy on the foot.",
    rest: "🚶 Optional: ~6–8k gentle steps or a short easy cycle if the foot feels good — otherwise just rest.",
  }[day.type] || "🚶 Keep moving little and often.";

  // supplements (compact chips, shown in the Daily log card)
  const supps = getSupps();
  const suppChecks = LS.get("pt_supp_" + key, {});
  const suppRow = supps.length ? `<div class="log-sec">
      <div class="log-label">💊 Supplements</div>
      <div class="supp-chips">${supps.map((s) => {
        const on = suppChecks[s];
        return `<button type="button" class="supp-chip ${on ? "on" : ""}" data-act="supp" data-name="${encodeURIComponent(s)}">${on ? "✓ " : ""}${s}</button>`;
      }).join("")}</div>
    </div>` : "";

  // meal swap picker
  // (Whole-day meal swapping was removed — the per-meal 🔀 swapper above is more granular.)
  // If an old whole-day swap is still stored, offer a one-tap reset so nothing gets stuck.
  const swapPicker = swapped
    ? `<button type="button" class="btn block" data-act="swap" data-i="-1" style="margin-top:10px">↩︎ Reset today's swapped meals to plan</button>`
    : "";

  // off-plan / cheat logging (inner fragment for the Adjust fold) — hidden in numbers-free teen mode
  const cheatToday = numbersFree() ? 0 : LS.get("pt_cheat_" + key, 0);
  const cheatInner = numbersFree() ? "" : `<div class="section-label">🍔 Eating out / treat</div>
    ${cheatToday
      ? `<p class="note">Logged <b>+${cheatToday} kcal</b> today, spread over the next ${CHEAT_SPREAD} days. <button type="button" class="btn" id="clearCheatBtn" style="min-height:auto;padding:6px 10px;margin-left:6px">Clear</button></p>`
      : `<div class="step-quick">
          <button type="button" class="btn" data-cheat="300">+300 treat</button>
          <button type="button" class="btn" data-cheat="600">+600 meal out</button>
          <button type="button" class="btn" data-cheat="1000">+1000 big day</button>
        </div>
        <div class="tracker-row" style="margin-top:8px">
          <input class="field" id="cheatInput" type="number" inputmode="numeric" placeholder="custom +kcal" style="max-width:150px" />
          <button type="button" class="btn accent" id="setCheatBtn">Log</button>
        </div>`}`;

  // reschedule (inner fragment)
  const shift = LS.get("pt_shift", 0);
  const reschedInner = `<div class="section-label" style="margin-top:14px">📅 Can't train today?</div>
    <div class="step-quick">
      <button type="button" class="btn" id="pushDayBtn">⏭ Push plan back a day</button>
      ${shift > 0 ? `<button type="button" class="btn" id="undoShiftBtn">Undo</button>` : ""}
    </div>
    ${shift > 0 ? `<p class="note" style="margin-top:8px">Pushed back <b>${shift} day${shift > 1 ? "s" : ""}</b> — finishing ${revealInfo().endStr}. <button type="button" class="btn" id="resetShiftBtn" style="min-height:auto;padding:5px 9px;margin-left:4px">Reset</button></p>` : ""}`;

  const adjustFold = `<details class="card fold"><summary>⚙️ Adjust today — ${numbersFree() ? "reschedule" : "eating out · reschedule"}${cheatToday ? ' <span class="swap-tag">+' + cheatToday + '</span>' : ""}${shift > 0 ? ' <span class="swap-tag">shifted</span>' : ""}</summary>
    <div class="fold-body">${cheatInner}${reschedInner}</div></details>`;

  const rv = revealInfo();

  // morning readiness check-in (sleep · soreness · energy) — lives in the hero
  const ready = LS.get("pt_ready_" + key, {});
  const readyDone = ready.s && ready.m && ready.e;
  const readyScore = (ready.s || 0) + (ready.m || 0) + (ready.e || 0);
  const rBtns = (k, labels) => labels.map((l, i) =>
    `<button type="button" class="ready-btn ${ready[k] === i + 1 ? "on" : ""}" data-act="ready" data-k="${k}" data-v="${i + 1}">${l}</button>`).join("");
  let readyBlock;
  if (readyDone) {
    const [emo, word] = readinessMeta(readyScore);
    readyBlock = `<div class="ready-done">${emo} <b>${word}</b> · ${readyScore}/9 — ${readinessAdvice(readyScore, day.type)}
      <button type="button" class="ready-edit" data-act="readyedit" aria-label="Redo check-in">✎</button></div>`;
  } else {
    readyBlock = `<div class="ready">
      <div class="ready-title">🌅 Morning check-in — how are you today?</div>
      <div class="ready-row"><span class="ready-lbl">😴 Sleep</span>${rBtns("s", ["Rough", "OK", "Great"])}</div>
      <div class="ready-row"><span class="ready-lbl">💪 Muscles</span>${rBtns("m", ["Sore", "OK", "Fresh"])}</div>
      <div class="ready-row"><span class="ready-lbl">⚡ Energy</span>${rBtns("e", ["Low", "OK", "High"])}</div>
    </div>`;
  }

  // XP level — retroactive from everything logged; celebrate crossing a threshold
  const lv = xpLevel(computeXP());
  const lastLvl = LS.get("pt_lastlvl", null);
  if (lastLvl == null) LS.set("pt_lastlvl", lv.lvl);
  else if (lv.lvl > lastLvl) { LS.set("pt_lastlvl", lv.lvl); haptic([80, 40, 80, 40, 160]); toast(`🎖️ Level up! Lv ${lv.lvl} — ${lv.name}`); }

  // guided interval timer on HIIT days (spec parsed straight from the plan text)
  const iv = day.type === "hiit" ? parseInterval(exercises) : null;
  const intervalCoach = iv ? `<div class="iv" id="ivBox" data-rounds="${iv.rounds}" data-work="${iv.work}" data-easy="${iv.easy}">
    <div class="iv-top"><span class="iv-title">⚡ Interval coach</span><span class="iv-spec">${iv.rounds} × ${iv.work}s hard / ${iv.easy}s easy</span></div>
    <div class="iv-stage"><span class="iv-phase" id="ivPhase">Ready</span><span class="iv-time" id="ivTime">--</span><span class="iv-round" id="ivRound"></span></div>
    <div class="iv-bar"><div class="iv-fill" id="ivFill"></div></div>
    <div class="step-quick" style="margin-top:10px">
      <button type="button" class="btn accent" data-act="ivstart">▶ Start intervals</button>
      <button type="button" class="btn" data-act="ivstop">✕ Stop</button>
    </div>
    <p class="note" style="margin:8px 0 0">Beeps + buzz on every change — hard means hard, easy means easy.</p>
  </div>` : "";

  // workout card — collapsed by default, expandable (stays open if you're mid-log)
  const workoutCard = `<details class="card fold workout-card" data-workout-card data-panel="workout"${OPEN_PANELS.workout || OPEN_LIFT || OPEN_FORM ? " open" : ""}>
    <summary>
      <span class="work-emoji">${day.emoji}</span>
      <span class="wo-sum-name">${day.name} <span class="type-badge type-${day.type}">${day.type.toUpperCase()}</span></span>
      <span class="wo-sum-prog ${wDone === exercises.length ? "on" : ""}">${day.type === "rest" ? "😴" : `${wDone}/${exercises.length}`}</span>
    </summary>
    <div class="fold-body">
      ${warmupBlock(day)}
      ${day.homeItems ? `<div class="mode-toggle">
        <button type="button" class="mode-btn ${!useHome ? "active" : ""}" data-mode="gym" aria-pressed="${!useHome}">🏋️ Gym</button>
        <button type="button" class="mode-btn ${useHome ? "active" : ""}" data-mode="home" aria-pressed="${!!useHome}">🏠 Home</button>
      </div>` : ""}
      <ul class="checklist">${workItems}</ul>
      ${intervalCoach}
      <p class="note" style="margin:10px 0 0">${stepHint}</p>
      ${restTimer}
      ${(day.type === "strength" && allLiftNames().length) ? `<button type="button" class="link-btn" data-act="gotostats" style="margin-top:12px">📊 View your strength stats — PBs, e1RM &amp; volume →</button>` : ""}
    </div>
  </details>`;

  return `
  ${dayNav(pos)}
  ${perfectBanner}
  <div class="card hero today-hero light-${light}">
    <div class="hero-top">
      <span class="phase-tag">Phase ${pos.phase.id} · ${pos.phase.name}</span>
      <span class="light-pill">${light === "green" ? "🟢 On track" : light === "amber" ? "🟡 Behind" : "🔴 Off pace"}</span>
    </div>
    <p class="greet">${greet}, ${getProfile().name || PLAN.meta.athlete} · ${dateStr}</p>
    <h1>${day.emoji} ${day.name}</h1>
    <p class="hero-meta">Week ${pos.week}/12 · Day ${pos.dn + 1} · 🏁 ${Math.max(0, rv.daysLeft)} to Reveal Day · 🎖️ Lv ${lv.lvl} ${lv.name}</p>
    ${chips}
    ${readyBlock}
    <div class="quote">"${quote}"</div>
  </div>

  ${nextStrip}

  <details class="card fold" data-panel="fuel"${OPEN_PANELS.fuel ? " open" : ""}>
    <summary>
      <span class="wo-sum-name">🍽️ Today's Fuel${swapped ? ' <span class="swap-tag">swapped</span>' : ""}</span>
      <span class="wo-sum-prog ${mDone === mealKeys.length ? "on" : ""}">${mDone}/${mealKeys.length}${teen ? "" : ` · ${served.kcal}kcal`}</span>
    </summary>
    <div class="fold-body">
    <p class="sub">${meal.name} · tick each meal as you eat it</p>
    ${teen ? `<div class="teen-fuel">
      <p>💪 You're still growing — eat to <b>fuel your training and growth</b>, not to a calorie number.</p>
      <ul>
        <li>Protein at every meal (eggs, chicken, dairy, yogurt, milk)</li>
        <li>Eat enough — go back for seconds if you're hungry, especially after training</li>
        <li>Plenty of water and 8–9 hours' sleep — that's when muscle is actually built</li>
        <li>Whole foods most of the time; treats are totally fine too</li>
      </ul></div>` : `<div class="macros">
      <div class="macro"><div class="val">${served.kcal}</div><div class="lbl">kcal</div></div>
      <div class="macro"><div class="val">${served.protein}g</div><div class="lbl">protein</div></div>
      <div class="macro"><div class="val">${served.carbs}g</div><div class="lbl">carbs</div></div>
      <div class="macro"><div class="val">${served.fat}g</div><div class="lbl">fat</div></div>
    </div>
    <p class="note" style="margin:10px 0 0">🎯 ${isDietBreak(pos.week) ? `<b style="color:var(--accent-2)">🏖️ Diet-break week</b> · portions set to ~${aim} kcal (maintenance) to recharge` : `Phase ${pos.phase.id} target <b>~${aim} kcal</b>${aimAdj ? ' <span class="swap-tag">recalc</span>' : ""} — portions above are scaled to match`}</p>
    ${payback > 0 ? `<p class="note" style="margin:6px 0 0;color:var(--warn)">⤵️ Includes balancing ${payback} kcal from a recent treat.</p>` : ""}
    ${skipNote}`}
    ${cookTwice}
    ${remainRow}
    <ul class="checklist">${mealItems}</ul>
    ${extrasBlock}
    ${recipeBlock(meal, skipped.Dinner ? 1 : pf, skipped.Dinner ? 1 : nf)}
    ${swapPicker}
    </div>
  </details>

  ${workoutCard}

  <details class="card fold" data-panel="daily"${OPEN_PANELS.daily ? " open" : ""}>
    <summary>
      <span class="wo-sum-name">📋 Daily log</span>
      <span class="wo-sum-prog ${checks.water >= 8 ? "on" : ""}">💧 ${checks.water}/8</span>
    </summary>
    <div class="fold-body">
    <div class="log-sec water-sec">
      <div class="log-label">💧 Water <span class="water-count" id="waterCount">${waterReadout(checks.water)}</span>
        <span class="water-vol" id="waterVol">${waterGlasses(checks.water)}</span></div>
      <div class="water-row">
        <button type="button" class="water-step" data-act="waterdec" aria-label="Remove a glass"${checks.water <= 0 ? " disabled" : ""}>−</button>
        <div class="water-dots">${waterDots}</div>
        <button type="button" class="water-step" data-act="waterinc" aria-label="Add a glass"${checks.water >= 8 ? " disabled" : ""}>＋</button>
      </div>
    </div>
    ${suppRow}
    <div class="log-sec">
      <div class="log-label">⚖️ Weigh-in</div>
      <div class="tracker-row">
        <input class="field" id="quickWeight" type="number" step="0.1" inputmode="decimal" placeholder="kg" style="max-width:140px" />
        <button type="button" class="btn accent" id="logWeightBtn">Log</button>
      </div>
    </div>
    </div>
  </details>

  ${tomorrowFold}

  ${adjustFold}`;
}

/* ---------- PLAN (reference, shown folded inside Settings) ---------- */
function renderPlanSection() {
  const phases = activePhases().map((p) => `
    <div class="phase-block">
      <div class="phase-head"><h3 style="margin:0">Phase ${p.id}: ${p.name}</h3><small>Weeks ${p.weekStart}–${p.weekEnd}</small></div>
      <p class="sub" style="margin:4px 0 0">${p.tagline}</p>
      <p class="note" style="margin:6px 0">${p.focus}</p>
      <div class="macros" style="margin:10px 0">
        <div class="macro"><div class="val">${p.calories}</div><div class="lbl">kcal</div></div>
        <div class="macro"><div class="val">${p.protein}g</div><div class="lbl">protein</div></div>
        <div class="macro"><div class="val">${p.carbs}g</div><div class="lbl">carbs</div></div>
        <div class="macro"><div class="val">${p.fat}g</div><div class="lbl">fat</div></div>
      </div>
      <div class="week-row">
        ${p.schedule.map(d => `<div class="daychip"><div class="d">${d.day.slice(0,3)}</div>
          <div class="e">${d.emoji}</div><div class="n">${d.name}</div></div>`).join("")}
      </div>
    </div>`).join("");

  const meals = PLAN.meals.map((m, di) => {
    const t = m.totals;
    return `<details class="fold meal-day" style="border:1px solid var(--line);border-radius:12px;margin-bottom:8px">
      <summary>
        <span class="meal-day-title"><b>Day ${di + 1}</b> · ${m.name}</span>
        <span class="meal-day-macro">${t.kcal} kcal · ${t.protein}g P</span>
      </summary>
      <div class="fold-body">
        <ul class="checklist">${Object.entries(m.items).map(([k, it]) =>
          `<li style="cursor:default"><span class="item-text"><span class="meal-label">${k} · ${it.kcal} kcal</span>${it.text}</span></li>`).join("")}</ul>
        ${recipeBlock(m)}
      </div>
    </details>`;
  }).join("");

  return `
  <details class="card fold"><summary>🗓️ The 12-week blueprint</summary>
    <div class="fold-body">
      <p class="sub">${PLAN.meta.goal}</p>
      <div class="pill-row" style="margin-bottom:10px">${PLAN.meta.dislikes.map(d => `<span class="tag">no ${d}</span>`).join("")}
        <span class="tag">low-impact</span></div>
      ${PLAN.meta.notes ? `<p class="note">🦶 ${PLAN.meta.notes}</p>` : ""}
      ${phases}
    </div>
  </details>

  <details class="card fold"><summary>🍽️ Meal rotation <span class="swap-tag">${PLAN.meals.length} days</span></summary>
    <div class="fold-body">
      <p class="sub">${PLAN.meals.length} days, looping · tap a day for meals + recipe · no fish, beans only in the chilli</p>
      ${meals}
    </div>
  </details>

  <details class="card fold"><summary>📋 Golden rules</summary>
    <div class="fold-body"><ul class="note" style="padding-left:18px;line-height:1.8;margin:0">
      ${PLAN.meta.principles.map(r => `<li>${r}</li>`).join("")}</ul></div>
  </details>`;
}

/* ---------- SHOP (auto-generated from the week's actual meals) ---------- */
const AISLES = ["🥩 Protein", "🧀 Dairy & chilled", "🍞 Carbs & grains", "🥦 Fruit & veg", "🫙 Store cupboard", "🍫 Snacks & extras"];
const INGREDIENTS = [
  ["Chicken breast", 0, "chicken"], ["Lean beef mince / steak", 0, "beef"], ["Turkey", 0, "turkey"],
  ["Pork", 0, "pork"], ["Sausages", 0, "sausage"], ["Gammon / ham", 0, "gammon|ham"], ["Bacon", 0, "bacon"],
  ["Chorizo (light)", 0, "chorizo"], ["Eggs", 0, "egg"], ["Beef jerky", 0, "jerky"],
  ["Whey / casein protein", 0, "whey|casein"], ["Protein bars / flapjack", 0, "protein bar|flapjack|protein yogurt"],
  ["Greek yogurt / skyr", 1, "greek yogurt|yogurt|skyr|parfait"], ["Cottage cheese", 1, "cottage cheese"],
  ["Cheese", 1, "cheddar|parmesan|cheese|babybel"], ["Cream cheese", 1, "cream cheese"], ["Milk", 1, "milk"],
  ["Rice", 2, "rice(?! cake)"], ["Rice cakes", 2, "rice cake"], ["Pasta / spaghetti", 2, "pasta|spaghetti"],
  ["Egg noodles", 2, "noodle"], ["Couscous", 2, "couscous"], ["Oats / porridge", 2, "oats|porridge"],
  ["Granola", 2, "granola"], ["Bread / toast", 2, "bread|toast"], ["Bagel", 2, "bagel"],
  ["Tortillas / wraps", 2, "tortilla|wrap|flatbread"], ["Pitta", 2, "pitta"], ["Naan", 2, "naan"],
  ["Rolls / buns", 2, "\\broll|bun|brioche"], ["Sweet potato", 2, "sweetpotato"], ["Potatoes", 2, "potato"],
  ["Crackers", 2, "cracker"], ["Oatcakes", 2, "oatcake"], ["Weetabix", 2, "weetabix"],
  ["Bananas", 3, "banana"], ["Apples", 3, "apple"], ["Berries", 3, "blueberr|raspberr|strawberr|berries"],
  ["Pineapple", 3, "pineapple"], ["Grapes", 3, "grape"], ["Kiwi", 3, "kiwi"], ["Spinach", 3, "spinach"],
  ["Broccoli", 3, "broccoli"], ["Peppers", 3, "pepper"], ["Onions", 3, "onion"],
  ["Tomatoes (fresh)", 3, "cherry tomato|fresh tomato"], ["Salad / slaw", 3, "salad|slaw"], ["Avocado", 3, "avocado"],
  ["Sweetcorn", 3, "sweetcorn|corn"], ["Peas", 3, "peas"], ["Carrot", 3, "carrot"],
  ["Garlic & ginger", 3, "garlic|ginger"], ["Mixed / stir-fry veg", 3, "mixed veg|stir-fry|green veg|veg\\b"],
  ["Kidney beans", 4, "bean"], ["Chopped tomatoes / passata", 4, "passata|chopped tomato|marinara|tomato sauce|tomatoes"],
  ["Pesto", 4, "pesto"], ["Salsa", 4, "salsa"], ["Soy / sriracha", 4, "soy|sriracha"],
  ["Curry paste / coconut", 4, "curry|coconut|tikka"], ["BBQ sauce", 4, "bbq"], ["Gravy / stock", 4, "gravy|stock"],
  ["Seasoning / spices", 4, "seasoning|paprika|cajun|shawarma|oregano|chilli"], ["Honey", 4, "honey"],
  ["Peanut / almond butter", 4, "peanut butter|almond butter"], ["Tzatziki", 4, "tzatziki"],
  ["Nuts (almonds / cashews)", 5, "almond|cashew|walnut|\\bnuts"], ["Dark chocolate", 5, "chocolate"],
].map(([label, aisle, re]) => ({ label, aisle, re: new RegExp(re), clean: label === "Potatoes" }));

function slug(s) { return "g_" + s.toLowerCase().replace(/[^a-z0-9]+/g, "_"); }
function weekIngredients(startDn) {
  const counts = new Map();
  for (let d = 0; d < 7; d++) {
    const meal = dayMeal(startDn + d);
    let hay = Object.values(meal.items).map(v => v.text).join(" | ").toLowerCase();
    const din = meal.items.Dinner;
    if (din && din.recipe) hay += " | " + din.recipe.ingredients.join(" ").toLowerCase();
    const hayNoSweet = hay.replace(/sweet potato/g, " ");
    for (const ent of INGREDIENTS) {
      if (ent.re.test(ent.clean ? hayNoSweet : hay)) {
        const c = counts.get(ent.label) || { aisle: ent.aisle, label: ent.label, n: 0 };
        c.n++; counts.set(ent.label, c);
      }
    }
  }
  return AISLES.map((name, ai) => ({ name, items: [...counts.values()].filter(x => x.aisle === ai) }))
    .filter(b => b.items.length);
}

function renderShop() {
  const pos = position();
  const wk = Math.max(1, Math.min(pos.week, PLAN.meta.weeks));
  const startDn = (wk - 1) * 7;
  const buckets = weekIngredients(startDn);
  const nextBuckets = weekIngredients(wk * 7);
  const checks = LS.get("pt_shop_w" + wk, {});
  const custom = LS.get("pt_shopcustom_w" + wk, []);
  const libActive = !!getLibrary();

  // recommended buy date: the day before this week starts, so the food's in for day 1
  const weekStart = new Date(dateKeyForDn(startDn) + "T00:00:00");
  const buyBy = new Date(weekStart); buyBy.setDate(buyBy.getDate() - 1);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const fmtFull = (d) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const fmtShort = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const today0 = new Date(todayKey() + "T00:00:00");
  const daysToBuy = Math.round((buyBy - today0) / 86400000);
  // upcoming buy date is actionable; once the week's underway just show the coverage range
  const buyHint = daysToBuy > 1 ? ` <span class="lib-macro">(in ${daysToBuy} days)</span>` : daysToBuy === 1 ? ` <span class="lib-macro">(tomorrow)</span>` : "";
  const buyLine = daysToBuy >= 0
    ? `🛒 Best bought by <b>${fmtFull(buyBy)}</b>${buyHint} · covers ${fmtShort(weekStart)}–${fmtShort(weekEnd)}`
    : `🗓️ This week · covers <b>${fmtShort(weekStart)}–${fmtShort(weekEnd)}</b>`;

  // batch-cookable dinners this week
  const batchMap = new Map();
  for (let d = 0; d < 7; d++) { const din = dayMeal(startDn + d).items.Dinner; if (din && din.batch) batchMap.set(din.text, din.text.split(" — ")[0].split(" + ")[0]); }
  const batchChecks = LS.get("pt_batch_w" + wk, {});
  const batchCard = batchMap.size ? `<div class="card">
    <h2>🧊 Batch prep</h2>
    <p class="sub">These freeze/reheat well — cook a big batch (e.g. Sunday) to save time</p>
    <ul class="checklist">${[...batchMap.values()].map((name, i) => {
      const k = "b" + i, on = batchChecks[k];
      return `<li class="${on ? "done" : ""}" data-act="batch" data-k="${k}">
        <span class="checkbox" style="border-radius:6px">${on ? "✓" : ""}</span><span class="item-text">Cook ahead: ${name}</span></li>`;
    }).join("")}</ul>
  </div>` : "";

  const staples = LS.get("pt_staples", []);

  let total = 0, done = 0;
  buckets.forEach(b => b.items.forEach(it => { total++; if (checks[slug(it.label)]) done++; }));
  custom.forEach((_, i) => { total++; if (checks["x" + i]) done++; });
  staples.forEach((_, i) => { total++; if (checks["s" + i]) done++; });
  const pct = total ? Math.round((done / total) * 100) : 0;

  const cats = buckets.map(b => `
    <div class="section-label">${b.name}</div>
    <ul class="checklist">${b.items.map(it => {
      const on = checks[slug(it.label)];
      return `<li class="${on ? "done" : ""}" data-act="shop" data-k="${slug(it.label)}">
        <span class="checkbox" style="border-radius:6px">${on ? "✓" : ""}</span>
        <span class="item-text">${it.label}${it.n > 1 ? `<span class="lib-macro"> · ${it.n} days</span>` : ""}</span></li>`;
    }).join("")}</ul>`).join("");

  const customList = custom.length ? `<div class="section-label">➕ My extras</div>
    <ul class="checklist">${custom.map((it, ii) => {
      const on = checks["x" + ii];
      return `<li class="${on ? "done" : ""}" data-act="shop" data-k="x${ii}">
        <span class="checkbox" style="border-radius:6px">${on ? "✓" : ""}</span>
        <span class="item-text">${it}</span>
        <button type="button" class="x-del" data-act="delcustom" data-i="${ii}">✕</button></li>`;
    }).join("")}</ul>` : "";

  const staplesCard = `<div class="card">
    <h2>🔁 Weekly staples</h2>
    <p class="sub">The things you buy every week — these carry over and appear on every list.</p>
    ${staples.length ? `<ul class="checklist">${staples.map((it, ii) => {
      const on = checks["s" + ii];
      return `<li class="${on ? "done" : ""}" data-act="shop" data-k="s${ii}">
        <span class="checkbox" style="border-radius:6px">${on ? "✓" : ""}</span>
        <span class="item-text">${it}</span>
        <button type="button" class="x-del" data-act="delstaple" data-i="${ii}">✕</button></li>`;
    }).join("")}</ul>` : `<p class="note">No staples yet — add milk, coffee, eggs… anything you restock every week.</p>`}
    <div class="tracker-row" style="margin-top:10px">
      <input class="field" id="stapleItem" placeholder="Add a weekly staple…" />
      <button type="button" class="btn accent" id="addStapleBtn">Add</button>
    </div>
  </div>`;

  return `
  <div class="card hero">
    <span class="phase-tag">Week ${wk} of ${PLAN.meta.weeks}</span>
    <h1>🛒 This week's shop</h1>
    <p>Auto-built from the meals in your plan this week${libActive ? " (your Recipe Library picks)" : ""}.</p>
    <p class="shop-when">${buyLine}</p>
    <div class="progress-track" style="margin-top:12px"><div class="progress-fill" style="width:${pct}%"></div></div>
    <p class="quote" style="font-style:normal;font-size:13px;color:var(--muted)">${done} of ${total} ticked off${(done === total && total) ? " — all done! 🎉" : ""}</p>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0">Your list</h2>
      <button type="button" class="btn" id="resetShopBtn" style="min-height:auto;padding:7px 12px">Reset</button>
    </div>
    ${cats || `<p class="note">No meals scheduled this week.</p>`}
    ${customList}
    <div class="tracker-row" style="margin-top:14px">
      <input class="field" id="customItem" placeholder="Add your own item…" />
      <button type="button" class="btn accent" id="addCustomBtn">Add</button>
    </div>
    <p class="note" style="margin-top:8px">Quantities depend on your portions — this is the what-to-buy list for the week.</p>
  </div>

  ${staplesCard}

  ${batchCard}

  <details class="card fold">
    <summary>⏭️ Next week — plan ahead</summary>
    <div class="fold-body">
    <p class="shop-when" style="margin-top:0">🗓️ Best bought by <b>${fmtFull(weekEnd)}</b> · covers ${fmtShort(new Date(weekEnd.getTime() + 86400000))}–${fmtShort(new Date(weekEnd.getTime() + 7 * 86400000))}</p>
    ${nextBuckets.map(b =>
      `<div class="section-label">${b.name}</div>
       <ul class="checklist">${b.items.map(it =>
        `<li style="cursor:default"><span class="checkbox" style="border-radius:6px"></span><span class="item-text">${it.label}</span></li>`).join("")}</ul>`).join("")}
    </div>
  </details>`;
}

/* ---------- PROGRESS ---------- */
function renderProgress() {
  const weights = LS.get("pt_weights", []);
  const pos = position();
  const prof = getProfile();
  const gainMode = prof.goal === "gain";
  const start = prof.weightKg;
  const latest = weights.length ? weights[weights.length - 1].kg : start;
  const delta = +(latest - start).toFixed(1);             // + = heavier than start
  const moved = +(gainMode ? delta : -delta).toFixed(1);  // progress toward goal (+ = good)
  const lost = moved;                                     // (kept name; = progress in goal direction)

  // current streak: count back consecutive days with any completion
  let streak = 0;
  for (let i = 0; i < 200; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const c = LS.get("pt_checks_" + todayKey(d), null);
    const any = c && (Object.values(c.workout || {}).some(Boolean) || Object.values(c.meals || {}).some(Boolean) || c.water > 0);
    if (any) streak++; else if (i > 0) break;
  }

  // single pass over elapsed days: workouts, perfect days, best streak, hydration
  let workoutsDone = 0, perfectDays = 0, anyWater8 = false; const active = [];
  for (let i = 0; i <= Math.max(0, pos.dn); i++) {
    const d = new Date(getStartDate() + "T00:00:00"); d.setDate(d.getDate() + i);
    const c = LS.get("pt_checks_" + todayKey(d), null);
    const wq = c ? Object.values(c.workout || {}).filter(Boolean).length : 0;
    const mq = c ? Object.values(c.meals || {}).filter(Boolean).length : 0;
    const water = c ? (c.water || 0) : 0;
    if (wq >= 1) workoutsDone++;
    if (water >= 8) anyWater8 = true;
    if (wq >= 3 && mq >= 5 && water >= 8) perfectDays++;
    active.push(!!(c && (wq || mq || water)));
  }
  let best = 0, run = 0; active.forEach(a => { run = a ? run + 1 : 0; best = Math.max(best, run); });

  const daysIn = Math.max(0, pos.dn + (pos.beforeStart ? 0 : 1));
  const smoothNow = weights.length ? smoothSeries(weights).slice(-1)[0] : null;
  const chart = weights.length >= 2 ? weightChart(weights) : `<p class="note">Log a few weigh-ins and your smoothed trend line appears here.</p>`;

  // weight goal + projection
  const goal = LS.get("pt_goal", null);
  let goalCard;
  if (goal == null) {
    const sg = suggestedGoal();
    goalCard = `<div class="card"><h2>🎯 Set a goal weight</h2>
      <p class="sub">We'll project when you'll hit it from your trend</p>
      <button type="button" class="btn accent block" id="useSuggestedGoal" style="margin:4px 0 10px">✨ Use suggested goal: ${sg} kg</button>
      <div class="tracker-row">
        <input class="field" id="goalWeight" type="number" step="0.1" inputmode="decimal" placeholder="or your own kg" value="${sg}" style="max-width:160px" />
        <button type="button" class="btn" id="saveGoalBtn">Set</button>
      </div>
      <p class="note" style="margin-top:8px">Suggested from your start weight, height and current trend — tweak it to whatever you're aiming for.</p></div>`;
  } else {
    const span = Math.abs(start - goal) || 1;
    const towards = gainMode ? (latest - start) : (start - latest); // progress toward goal
    const gp = Math.max(0, Math.min(100, Math.round((towards / span) * 100)));
    const reached = gainMode ? latest >= goal : latest <= goal;
    let proj = `<p class="note">Log a couple of weigh-ins and I'll project your finish date.</p>`;
    if (weights.length >= 2) {
      const first = weights[0], last = weights[weights.length - 1];
      const days = (new Date(last.date) - new Date(first.date)) / 86400000;
      const ratePerWeek = days > 0 ? (last.kg - first.kg) / (days / 7) : 0;
      const movingRight = gainMode ? ratePerWeek > 0.05 : ratePerWeek < -0.05;
      if (reached) proj = `<p class="note" style="color:var(--accent)">🎉 Goal reached — ${latest} kg. Time to set a new one${gainMode ? "" : " or move to maintenance"}.</p>`;
      else if (movingRight) {
        const weeksLeft = (goal - latest) / ratePerWeek;
        const eta = new Date(Date.now() + weeksLeft * 7 * 86400000);
        const etaStr = weeksLeft > 52 ? "over a year out at this pace" :
          "around " + eta.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        proj = `<p class="note">${gainMode ? "📈 Gaining" : "📉 Losing"} <b>${Math.abs(ratePerWeek).toFixed(2)} kg/week</b> → goal of <b>${goal} kg</b> ${etaStr} (~${Math.max(1, Math.round(weeksLeft))} wk).</p>`;
      } else proj = `<p class="note">Your trend is ${gainMode ? "flat or down — nudge the surplus up a touch" : "flat or up — tighten the deficit a touch"} to start moving toward ${goal} kg.</p>`;
    }
    goalCard = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">🎯 Goal: ${goal} kg</h2>
        <button type="button" class="btn" id="clearGoalBtn" style="min-height:auto;padding:7px 12px">Change</button></div>
      <div class="progress-track" style="margin:12px 0 6px"><div class="progress-fill" style="width:${gp}%"></div></div>
      <p class="sub">${start} kg → ${goal} kg · ${gp}% there (${delta >= 0 ? "+" : "−"}${Math.abs(delta)} kg so far)</p>
      ${proj}</div>`;
  }

  // achievements
  const A = [
    ["🏋️", "First rep", workoutsDone >= 1],
    ["💪", "10 workouts", workoutsDone >= 10],
    ["🏆", "25 workouts", workoutsDone >= 25],
    ["🔥", "3-day streak", best >= 3],
    ["🔥", "7-day streak", best >= 7],
    ["⚡", "14-day streak", best >= 14],
    ["💧", "Hydrated", anyWater8],
    ["✨", "Perfect day", perfectDays >= 1],
    ["🌟", "5 perfect days", perfectDays >= 5],
    ...(gainMode
      ? [["⚖️", "Up 1 kg", moved >= 1], ["📈", "Up 2 kg", moved >= 2], ["🥇", "Up 4 kg", moved >= 4]]
      : [["⚖️", "Down 1 kg", moved >= 1], ["📉", "Down 3 kg", moved >= 3], ["🥇", "Down 5 kg", moved >= 5]]),
    ["🗓️", "Halfway", daysIn >= 42],
    ["🎓", "Finisher", daysIn >= 84],
  ];
  const earned = A.filter(a => a[2]).length;
  const badges = A.map(([e, label, on]) =>
    `<div class="badge ${on ? "earned" : ""}"><div class="badge-e">${e}</div><div class="badge-l">${label}</div></div>`).join("");

  // adaptive coach (direction depends on goal)
  const ad = adaptiveStatus();
  const adapt = LS.get("pt_adaptkcal", 0);
  const todayAim = dailyAim(pos);
  const rateStr = ad.rate != null ? `${ad.rate >= 0 ? "+" : ""}${ad.rate.toFixed(2)} kg/wk` : "";
  let adBody;
  if (ad.state === "new") {
    adBody = `<p class="note">Log weigh-ins for a week or two and I'll read your trend and adjust your plan to your <b>actual</b> progress — not just the calendar.</p>`;
  } else if (ad.goal === "gain") {
    if (ad.state === "stall") {
      adBody = `<p class="note">⚠️ You're not gaining yet (<b>${rateStr}</b>). To grow muscle you need a small surplus:</p>
        <ul class="note" style="padding-left:18px;line-height:1.8">
          <li><b>Nutrition:</b> add ~150 kcal/day (mostly carbs + protein around training).</li>
          <li><b>Training:</b> keep adding a rep or a little load each week — progressive overload drives growth.</li>
        </ul>
        <button type="button" class="btn accent block" data-act="adapt" data-kcal="150">Apply +150 kcal/day</button>`;
    } else if (ad.state === "fast") {
      adBody = `<p class="note">🏃 You're gaining fast (<b>${rateStr}</b>) — ease back so more of it is muscle, not fat:</p>
        <ul class="note" style="padding-left:18px;line-height:1.8">
          <li><b>Nutrition:</b> trim ~150 kcal/day to a leaner gain (~0.25–0.5 kg/wk).</li>
          <li><b>Training:</b> keep lifting hard and progressing your main lifts.</li>
        </ul>
        <button type="button" class="btn accent block" data-act="adapt" data-kcal="-150">Apply −150 kcal/day</button>`;
    } else {
      adBody = `<p class="note">✅ Lean gaining nicely — <b>${rateStr}</b>. Keep eating in a small surplus and adding load to your lifts.</p>`;
    }
  } else if (ad.goal === "maintain") {
    if (ad.state === "good") adBody = `<p class="note">✅ Holding steady (<b>${rateStr}</b>) — maintenance is working. Keep training to build/keep muscle.</p>`;
    else adBody = `<p class="note">Your weight is drifting (<b>${rateStr}</b>). Nudge intake ${ad.rate > 0 ? "down" : "up"} ~100–150 kcal/day to hold maintenance.</p>
      <button type="button" class="btn accent block" data-act="adapt" data-kcal="${ad.rate > 0 ? -150 : 150}">Apply ${ad.rate > 0 ? "−" : "+"}150 kcal/day</button>`;
  } else if (ad.state === "stall") {
    adBody = `<p class="note">⚠️ Your weight's basically flat (<b>${rateStr}</b>). Time to change the stimulus:</p>
      <ul class="note" style="padding-left:18px;line-height:1.8">
        <li><b>Nutrition:</b> trim ~150 kcal/day to restart fat loss.</li>
        <li><b>Training:</b> progress your main lifts (+1 rep or +2.5 kg) and add one extra 25-min low-impact cardio this week.</li>
        <li><b>Check the basics:</b> sleep, hidden snacks, and weigh-in consistency — stalls usually hide there.</li>
      </ul>
      <button type="button" class="btn accent block" data-act="adapt" data-kcal="-150">Apply −150 kcal/day</button>`;
  } else if (ad.state === "fast") {
    adBody = `<p class="note">🏃 You're dropping fast (<b>${rateStr}</b>) — ease up so you keep muscle and energy:</p>
      <ul class="note" style="padding-left:18px;line-height:1.8">
        <li><b>Nutrition:</b> add ~150 kcal/day (mostly protein + carbs around training).</li>
        <li><b>Training:</b> keep lifting heavy to hold muscle; don't add more cardio.</li>
      </ul>
      <button type="button" class="btn accent block" data-act="adapt" data-kcal="150">Apply +150 kcal/day</button>`;
  } else {
    adBody = `<p class="note">✅ On track — losing <b>${Math.abs(ad.rate).toFixed(2)} kg/wk</b>. No changes needed; keep doing what you're doing.</p>`;
  }
  if (adapt !== 0) {
    adBody += `<p class="note" style="margin-top:10px">Active adaptive tweak: <b>${adapt > 0 ? "+" : ""}${adapt} kcal/day</b> → today's aim <b>${todayAim} kcal</b>. <button type="button" class="btn" data-act="adaptreset" style="min-height:auto;padding:5px 9px;margin-left:4px">Reset</button></p>`;
  }
  const teen = numbersFree();
  const older = ageBand() === "older";
  const pTarget = proteinTarget(prof);
  let adCard;
  if (teen) {
    // numbers-free coaching for 13–17
    adCard = `<div class="card"><h2>🧭 Your coach</h2>
      <p class="note">No calorie counting while you're growing — these are the things that actually move the needle:</p>
      <ul class="note" style="padding-left:18px;line-height:1.9">
        <li><b>Eat enough</b>, especially around training — hunger is a signal to eat more, not less.</li>
        <li><b>Protein every meal</b> (eggs, chicken, dairy, yogurt, milk) to build muscle.</li>
        <li><b>Train consistently</b> and add a rep or a little weight over time.</li>
        <li><b>Sleep 8–9 hours</b> — most growth happens then.</li>
      </ul></div>`;
  } else {
    adCard = `<div class="card"><h2>🧭 Adaptive coach</h2>${adBody}
      <details class="fold" style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
        <summary>🔥 Metabolism — maintenance ~${currentMaintenance().toLocaleString()} kcal</summary>
        <div class="fold-body">
          <div class="stat-grid">
            <div class="stat"><div class="big">${currentMaintenance().toLocaleString()}</div><div class="cap">maintenance now</div></div>
            <div class="stat"><div class="big">${pTarget}g</div><div class="cap">protein target/day</div></div>
          </div>
          <p class="note" style="margin-top:8px">Your calorie aim auto-recalculates from your live weight, so your ${prof.goal === "gain" ? "surplus" : prof.goal === "maintain" ? "maintenance" : "deficit"} stays on target as you progress. Today's aim: <b>${adjustedAim(pos).toLocaleString()} kcal</b>.</p>
          ${older ? `<p class="note" style="margin-top:6px">👴 Over 60: prioritise protein (~${pTarget}g, ~1.6g/kg) and keep resistance-training — it's the biggest lever for holding onto muscle and strength with age.</p>` : ""}
        </div>
      </details></div>`;
  }

  // diet-break scheduler — only relevant when cutting (a break = eat at maintenance)
  const breakCard = gainMode || prof.goal === "maintain" ? "" : `<div class="card"><h2>🏖️ Diet-break weeks</h2>
    <p class="note">On a diet-break week you eat at <b>maintenance (~${currentMaintenance().toLocaleString()} kcal)</b> instead of a deficit — it restores hormones, energy and willpower, and often restarts fat loss. Tap a week to schedule one.</p>
    <div class="week-chips" style="margin-top:10px">
      ${Array.from({ length: PLAN.meta.weeks }, (_, i) => i + 1).map((wk) =>
        `<button type="button" class="wk-chip ${isDietBreak(wk) ? "on" : ""} ${wk === pos.week ? "now" : ""}" data-act="dietbreak" data-wk="${wk}">${wk}</button>`).join("")}
    </div></div>`;

  const heroLine = Math.abs(delta) < 0.05
    ? `Logging from <b>${start} kg</b> — your trend shows here.`
    : `${moved >= 0 ? (gainMode ? "Up" : "Down") : (gainMode ? "Down" : "Up")} <b style="color:${moved >= 0 ? "var(--accent)" : "var(--warn)"}">${Math.abs(delta)} kg</b> since you started.`;

  return `
  <div class="card hero"><span class="phase-tag">Your numbers</span><h1>Progress</h1>
    <p>${heroLine}</p></div>
  <div class="card"><div class="stat-grid">
    <div class="stat"><div class="big">${daysIn}</div><div class="cap">days in</div></div>
    <div class="stat"><div class="big">🔥 ${streak}</div><div class="cap">day streak</div></div>
    <div class="stat"><div class="big">${workoutsDone}</div><div class="cap">workouts logged</div></div>
    <div class="stat"><div class="big">✨ ${perfectDays}</div><div class="cap">perfect days</div></div>
  </div></div>

  ${xpCard()}

  ${consistencyHeatmap(pos)}

  ${adCard}

  ${breakCard}

  ${renderReport()}

  ${goalCard}

  <div class="card"><h2>⚖️ Weight trend${smoothNow != null ? ` <small style="color:var(--muted);font-weight:600">trend ${smoothNow} kg</small>` : ""}</h2>${chart}
    <div class="tracker-row" style="margin-top:12px">
      <input class="field" id="quickWeight" type="number" step="0.1" inputmode="decimal" placeholder="kg" style="max-width:140px" />
      <button type="button" class="btn accent" id="logWeightBtn">Log weigh-in</button>
    </div>
  </div>

  ${renderMeasurements()}

  <details class="card fold">
    <summary>🏅 Achievements <span class="swap-tag">${earned}/${A.length}</span></summary>
    <div class="fold-body"><div class="badge-grid">${badges}</div></div>
  </details>

  ${muscleMapCard()}

  ${renderStrength()}`;
}

/* ---------- consistency heatmap (84 days, GitHub-style) ---------- */
function consistencyHeatmap(pos) {
  const total = PLAN.meta.weeks * 7;
  let cells = "";
  for (let dn = 0; dn < total; dn++) {
    const dk = dateKeyForDn(dn);
    let cls, title;
    if (dn > pos.dn) { cls = "hm-f"; title = dk; }
    else {
      const c = LS.get("pt_checks_" + dk, null);
      const wq = c ? Object.values(c.workout || {}).filter(Boolean).length : 0;
      const mq = c ? Object.values(c.meals || {}).filter(Boolean).length : 0;
      const water = c ? (c.water || 0) : 0;
      const lvl = (wq >= 1 ? 1 : 0) + (mq >= 3 ? 1 : 0) + (water >= 8 ? 1 : 0);
      cls = "hm-" + lvl;
      title = `${dk} · ${["nothing logged", "getting going", "good day", "perfect day"][lvl]}`;
    }
    if (dn === pos.dn) cls += " hm-today";
    if (dn === HM_SEL) cls += " hm-sel";
    cells += `<div class="hm-cell ${cls}" data-act="hmcell" data-dn="${dn}" title="${title}"></div>`;
  }
  return `<div class="card"><h2>📆 Consistency</h2>
    <p class="sub">Every day of the 12 weeks — workout, meals and water each deepen the colour · tap a day for detail</p>
    <div class="hm-wrap"><div class="hm-grid">${cells}</div></div>
    <div class="hm-legend"><span>W1</span><span class="hm-scale">Less <i class="hm-cell hm-0"></i><i class="hm-cell hm-1"></i><i class="hm-cell hm-2"></i><i class="hm-cell hm-3"></i> More</span><span>W12</span></div>
    ${hmDetail(pos)}
  </div>`;
}
// detail panel for the tapped heatmap day: past = what happened, future = what's planned
function hmDetail(pos) {
  if (HM_SEL == null) return "";
  const dn = HM_SEL, dk = dateKeyForDn(dn);
  const d = new Date(dk + "T00:00:00");
  const dateStr = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const week = Math.floor(dn / 7) + 1, weekday = (d.getDay() + 6) % 7;
  const day = phaseForWeek(activePhases(), Math.max(1, week)).schedule[weekday];
  if (dn > pos.dn) {
    return `<div class="hm-detail"><b>${dateStr}</b> · Day ${dn + 1} · upcoming<br>
      ${day.emoji} ${day.name} <span class="type-badge type-${day.type}">${day.type.toUpperCase()}</span></div>`;
  }
  const c = LS.get("pt_checks_" + dk, null) || { workout: {}, meals: {}, water: 0 };
  const mode = LS.get("pt_mode", "gym");
  const ex = (mode === "home" && day.homeItems) ? day.homeItems : day.items;
  const wq = Math.min(Object.values(c.workout || {}).filter(Boolean).length, ex.length);
  const mq = Object.values(c.meals || {}).filter(Boolean).length;
  const wIn = LS.get("pt_weights", []).find((w) => w.date === dk);
  const r = LS.get("pt_ready_" + dk, null);
  const ready = (r && r.s && r.m && r.e) ? ` · 🌅 ${r.s + r.m + r.e}/9` : "";
  return `<div class="hm-detail">
    <div><b>${dateStr}</b> · Day ${dn + 1} · ${day.emoji} ${day.name}</div>
    <div class="hm-detail-stats">🏋️ ${wq}/${ex.length} · 🍽️ ${mq}/${SLOTS.length} · 💧 ${c.water || 0}/8${wIn ? ` · ⚖️ ${wIn.kg}kg` : ""}${ready}</div>
    <button type="button" class="btn block" data-act="hmopen" data-dn="${dn}" style="margin-top:8px">📖 Open this day</button>
  </div>`;
}

/* ---------- body measurements (waist/chest/arm/thigh) ---------- */
const MEAS = [["waist", "Waist"], ["chest", "Chest"], ["arm", "Arm"], ["thigh", "Thigh"]];
function renderMeasurements() {
  if (numbersFree()) return ""; // not for the teen numbers-free mode
  const arr = LS.get("pt_meas", []);
  const rows = MEAS.map(([k, l]) => {
    const pts = arr.filter((x) => x[k] != null);
    if (!pts.length) return "";
    const first = pts[0][k], last = pts[pts.length - 1][k], d = +(last - first).toFixed(1);
    return `<li>
      <div class="lift-row-top"><span class="lift-name">${l}</span>${pts.length >= 2 ? miniSpark(pts.map((p) => p[k])) : ""}</div>
      <span class="lift-figs"><b>${last} cm</b>${pts.length >= 2 ? ` · ${d > 0 ? "+" : ""}${d} cm since ${pts[0].date.slice(5)}` : " · first entry"}</span></li>`;
  }).join("");
  const entries = arr.slice().reverse().slice(0, 6).map((e) => {
    const i = arr.indexOf(e);
    return `<li style="cursor:default"><span class="item-text"><span class="meal-label">${e.date}</span>${MEAS.filter(([k]) => e[k] != null).map(([k, l]) => `${l} ${e[k]}`).join(" · ")} cm</span>
      <button type="button" class="x-del" data-act="delmeas" data-i="${i}">✕</button></li>`;
  }).join("");
  return `<details class="card fold" ${!arr.length ? "" : ""}>
    <summary>📏 Measurements ${arr.length ? `<span class="swap-tag">${arr.length} logged</span>` : ""}</summary>
    <div class="fold-body">
      <p class="sub">The tape beats the scale during a recomp — measure relaxed, same spot, same time of day, every 1–2 weeks.</p>
      ${rows ? `<ul class="lift-stats">${rows}</ul>` : ""}
      <div class="meas-grid">
        ${MEAS.map(([k, l]) => `<div><label class="field-label">${l} (cm)</label><input class="field" id="meas_${k}" type="number" step="0.1" inputmode="decimal" placeholder="cm" /></div>`).join("")}
      </div>
      <button type="button" class="btn accent block" id="saveMeasBtn" style="margin-top:10px">Save measurements</button>
      ${entries ? `<div class="ft-label" style="margin-top:14px">Recent entries</div><ul class="checklist">${entries}</ul>` : ""}
    </div>
  </details>`;
}
function saveMeas() {
  const key = todayKey();
  const entry = { date: key }; let any = false;
  for (const [k] of MEAS) {
    const el = document.getElementById("meas_" + k); const v = parseFloat(el && el.value);
    if (v > 0) { entry[k] = v; any = true; }
  }
  if (!any) { toast("Enter at least one measurement"); return; }
  const arr = LS.get("pt_meas", []);
  const i = arr.findIndex((x) => x.date === key);
  if (i >= 0) arr[i] = { ...arr[i], ...entry }; else arr.push(entry);
  arr.sort((a, b) => a.date.localeCompare(b.date));
  LS.set("pt_meas", arr);
  haptic(8); toast("📏 Measurements saved"); repaintKeepScroll();
}
function delMeas(i) {
  const arr = LS.get("pt_meas", []); arr.splice(i, 1); LS.set("pt_meas", arr);
  haptic(6); repaintKeepScroll();
}

/* ---------- shareable weekly report ---------- */
function weeklyReport() {
  const pos = position();
  const wk = Math.max(1, Math.min(pos.week, PLAN.meta.weeks));
  const start = (wk - 1) * 7;
  const d0 = new Date(getStartDate() + "T00:00:00"); d0.setDate(d0.getDate() + start + LS.get("pt_shift", 0));
  const d6 = new Date(d0); d6.setDate(d6.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const phase = phaseForWeek(activePhases(), Math.max(1, wk));
  const weights = LS.get("pt_weights", []);
  const inWeek = weights.filter((w) => { const dn = effDnForDate(w.date); return dn >= start && dn <= start + 6; });
  let weightStr = "—", weightDelta = null;
  if (inWeek.length >= 2) { weightDelta = +(inWeek[inWeek.length - 1].kg - inWeek[0].kg).toFixed(1); weightStr = (weightDelta <= 0 ? "" : "+") + weightDelta + " kg"; }
  else if (inWeek.length === 1) weightStr = inWeek[0].kg + " kg";
  let workouts = 0, perfect = 0, mealTicks = 0, mealPoss = 0, water8 = 0;
  for (let d = 0; d < 7; d++) {
    const dn = start + d; if (dn > pos.dn) break;
    const c = LS.get("pt_checks_" + dateKeyForDn(dn), null);
    const wq = c ? Object.values(c.workout || {}).filter(Boolean).length : 0;
    const mq = c ? Object.values(c.meals || {}).filter(Boolean).length : 0;
    const wat = c ? (c.water || 0) : 0;
    if (wq >= 1) workouts++; if (wq >= 3 && mq >= 5 && wat >= 8) perfect++;
    mealTicks += mq; mealPoss += 5; if (wat >= 8) water8++;
  }
  const adherence = mealPoss ? Math.round(mealTicks / mealPoss * 100) : 0;
  const wv = weekVolume();
  const pbNames = [];
  for (const n of allLiftNames()) {
    const series = liftSeries(n); if (!series.length) continue;
    const best = Math.max(...series.map((p) => p.e));
    const bestPt = series.find((p) => p.e === best);
    if (bestPt && effDnForDate(bestPt.date) >= start && effDnForDate(bestPt.date) <= start + 6) pbNames.push(n);
  }
  let streak = 0;
  for (let i = 0; i < 200; i++) { const dd = new Date(); dd.setDate(dd.getDate() - i); const c = LS.get("pt_checks_" + todayKey(dd), null); const any = c && (Object.values(c.workout || {}).some(Boolean) || Object.values(c.meals || {}).some(Boolean) || c.water > 0); if (any) streak++; else if (i > 0) break; }
  const prof = getProfile();
  return { week: wk, range: fmt(d0) + "–" + fmt(d6), phase: phase.name, weightStr, weightDelta, workouts, perfect, adherence, water8, volume: wv.vol, sets: wv.sets, pbs: pbNames.length, pbNames, streak,
    overall: +(latestWeight() - prof.weightKg).toFixed(1), name: prof.name || PLAN.meta.athlete, goal: prof.goal, day: Math.max(0, pos.dn + 1) };
}
function renderReport() {
  const r = weeklyReport();
  const tiles = [["Weight", r.weightStr], ["Workouts", String(r.workouts)], ["Volume", r.volume.toLocaleString() + "kg"], ["Perfect", String(r.perfect)], ["Streak", "🔥 " + r.streak], ["New PBs", String(r.pbs)]];
  return `<div class="card">
    <h2>🗓️ Week ${r.week} report</h2>
    <p class="sub">${r.range} · ${r.phase}</p>
    <div class="rep-grid">${tiles.map((t) => `<div class="rep-tile"><div class="rep-cap">${t[0]}</div><div class="rep-val">${t[1]}</div></div>`).join("")}</div>
    ${r.pbNames.length ? `<p class="note" style="margin-top:8px">🏅 New PBs: <b>${r.pbNames.join(", ")}</b></p>` : ""}
    <button type="button" class="btn accent block" id="shareReportBtn" style="margin-top:10px">📤 Share my week</button>
  </div>`;
}
function reportCanvas(r) {
  const W = 1080, H = 1350, P = 64;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const x = cv.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#141b26"); g.addColorStop(1, "#0b0f15");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = "#34d399"; x.fillRect(0, 0, W, 14);
  const F = (w, s) => x.font = `${w} ${s}px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
  const progName = (r.goal === "gain" ? "12-WEEK BUILD" : r.goal === "maintain" ? "12-WEEK PLAN" : "12-WEEK SHRED");
  F(600, 32); x.fillStyle = "#9aa3b2"; x.fillText(`${(r.name || "MY").toUpperCase()}'S ${progName}`, P, 120);
  F(800, 84); x.fillStyle = "#eef1f6"; x.fillText("Week " + r.week + " Report", P, 208);
  F(400, 34); x.fillStyle = "#9aa3b2"; x.fillText(r.range + "   ·   " + r.phase, P, 260);
  const tiles = [["WEIGHT", r.weightStr], ["WORKOUTS", String(r.workouts)], ["VOLUME", r.volume.toLocaleString() + " kg"], ["PERFECT DAYS", String(r.perfect)], ["STREAK", "🔥 " + r.streak], ["NEW PBs", String(r.pbs)]];
  const gx = P, gy = 320, gw = (W - 2 * P - 32) / 2, gh = 198, gap = 32;
  const rr = (X, Y, Wd, Ht, rad) => { x.beginPath(); x.moveTo(X + rad, Y); x.arcTo(X + Wd, Y, X + Wd, Y + Ht, rad); x.arcTo(X + Wd, Y + Ht, X, Y + Ht, rad); x.arcTo(X, Y + Ht, X, Y, rad); x.arcTo(X, Y, X + Wd, Y, rad); x.closePath(); };
  tiles.forEach((t, i) => {
    const X = gx + (i % 2) * (gw + gap), Y = gy + (i / 2 | 0) * (gh + gap);
    x.fillStyle = "#1a212c"; rr(X, Y, gw, gh, 24); x.fill();
    F(700, 27); x.fillStyle = "#9aa3b2"; x.fillText(t[0], X + 34, Y + 56);
    F(800, 70); x.fillStyle = "#eef1f6"; x.fillText(t[1], X + 34, Y + 138);
  });
  const oy = gy + 3 * gh + 2 * gap + 76;
  // natural sign: + = heavier than start, − = lighter (reads correctly for every goal)
  F(800, 54); x.fillStyle = "#34d399"; x.fillText((r.overall > 0 ? "+" : r.overall < 0 ? "−" : "±") + Math.abs(r.overall) + " kg overall", P, oy);
  F(400, 34); x.fillStyle = "#9aa3b2"; x.fillText("Day " + r.day + " of 84   ·   " + r.adherence + "% nutrition adherence", P, oy + 52);
  if (r.pbNames.length) { F(700, 32); x.fillStyle = "#fbbf24"; x.fillText("🏅 " + r.pbNames.slice(0, 3).join(", "), P, oy + 112); }
  const tagline = r.goal === "gain" ? "My PT — build lean muscle 💪" : r.goal === "maintain" ? "My PT — stay strong 💪" : "My PT — get ripped in 12 weeks 💪";
  F(600, 30); x.fillStyle = "#9aa3b2"; x.fillText(tagline, P, H - 56);
  return cv;
}
function shareReport() {
  const r = weeklyReport();
  let cv;
  try { cv = reportCanvas(r); } catch { toast("Couldn't build the image"); return; }
  const text = `Week ${r.week} done 💪 ${r.weightStr} · ${r.workouts} workouts · ${r.volume.toLocaleString()}kg lifted${r.pbs ? ` · ${r.pbs} PB` : ""}`;
  cv.toBlob(async (blob) => {
    if (!blob) { toast("Couldn't build the image"); return; }
    const file = new File([blob], "week-" + r.week + "-report.png", { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }
    } catch { /* user cancelled or unsupported */ }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast("Report image saved");
  }, "image/png");
}

function renderStrength() {
  const names = allLiftNames();
  if (!names.length) return `<details class="card fold"><summary>💪 Strength log</summary>
    <div class="fold-body"><p class="note">Tap the 📊 next to any exercise on the Today screen to log your sets (weight × reps). Your PBs, estimated 1-rep maxes, ×bodyweight ratios, trend charts and weekly volume build up here — and the app suggests next session's load automatically.</p></div></details>`;
  const bw = latestWeight();
  const rows = names.map((n) => ({ n, best: bestE1rm(n), last: lastLiftBefore(n, dayNumber() + 1), series: liftSeries(n) })).sort((a, b) => b.best - a.best);
  const wv = weekVolume();
  // muscle balance
  const mv = weeklyMuscleVolume();
  const mTotal = Object.values(mv).reduce((s, v) => s + v, 0);
  const mOrder = ["Chest", "Back", "Shoulders", "Arms", "Legs", "Posterior", "Other"].filter((g) => mv[g]);
  const balance = mTotal ? `<div class="section-label" style="margin-top:14px">This week's volume by muscle group</div>
    ${mOrder.map((g) => `<div class="mbar-row"><span class="mbar-label">${g}</span>
      <span class="mbar-track"><span class="mbar-fill" style="width:${Math.round(mv[g] / mTotal * 100)}%"></span></span>
      <span class="mbar-val">${Math.round(mv[g] / mTotal * 100)}%</span></div>`).join("")}` : "";

  return `<details class="card fold"><summary>💪 Strength log <span class="swap-tag">${names.length} lifts</span></summary>
    <div class="fold-body">
      <p class="sub">Estimated 1-rep max (Epley) · ×bodyweight · trend</p>
      <ul class="lift-stats">${rows.map((r) => `<li>
        <div class="lift-row-top">
          <span class="lift-name">${r.n}</span>
          ${r.series.length >= 2 ? miniSpark(r.series.map((p) => p.e)) : ""}
        </div>
        <span class="lift-figs">${r.best ? `<b>${r.best}kg</b> e1RM${bw ? ` · ×${(r.best / bw).toFixed(2)} BW` : ""}` : "—"}${r.last ? ` · last ${setSummary(r.last.sets)}` : ""}</span></li>`).join("")}</ul>
      ${balance}
      <p class="note" style="margin-top:10px">This week: <b>${wv.vol.toLocaleString()} kg</b> total volume across ${wv.sets} sets.</p>
    </div></details>`;
}

/* ---------- backup & restore (all on-device data) ---------- */
function exportData() {
  const data = { v: 1, exported: new Date().toISOString(), ls: {}, photos: PHOTOS };
  Object.keys(localStorage).filter((k) => k.startsWith("pt_")).forEach((k) => data.ls[k] = localStorage.getItem(k));
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "my-pt-backup-" + todayKey() + ".json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast("Backup downloaded");
}
async function importData(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.ls) Object.entries(data.ls).forEach(([k, v]) => localStorage.setItem(k, v));
    if (Array.isArray(data.photos)) { for (const p of data.photos) await photoPut(p); }
    toast("Backup restored — reloading…");
    setTimeout(() => location.reload(), 800);
  } catch { toast("Couldn't read that backup file"); }
}

// Photos get their own tab now — a hero plus the photo card/lightbox.
function renderPhotosTab() {
  return `
  <div class="card hero"><span class="phase-tag">Transformation</span>
    <h1>📸 Progress photos</h1>
    <p>One a week is plenty. Each shot is stamped with your nearest weight and stored only on this device — swipe the compare slider to watch the change build up.</p></div>
  ${renderPhotos()}`;
}

function renderPhotos() {
  const has = PHOTOS.length;
  const compare = PHOTOS.length >= 2 ? (() => {
    const a = PHOTOS[0], b = PHOTOS[PHOTOS.length - 1];
    return `<div class="section-label" style="margin-top:14px">Before → Now</div>
      <div class="compare">
        <img src="${a.data}" alt="before" class="cmp-base" />
        <div class="cmp-top" id="cmpTop" style="clip-path: inset(0 ${100 - COMPARE_T}% 0 0)"><img src="${b.data}" alt="now" /></div>
        <div class="cmp-handle" style="left:${COMPARE_T}%"></div>
      </div>
      <input type="range" min="0" max="100" value="${COMPARE_T}" id="compareRange" class="cmp-range" />
      <div class="cmp-labels"><span>${a.date}</span><span>${b.date}</span></div>` ;
  })() : "";

  const thumbs = PHOTOS.map(p =>
    `<button type="button" class="photo-thumb" data-act="viewphoto" data-date="${p.date}">
      <img src="${p.data}" alt="${p.date}" /></button>`).join("");

  return `<div class="card"><h2>📸 Progress photos</h2>
    <p class="sub">Stored only on this device · tap a photo to view, share or delete</p>
    ${has ? `<div class="photo-grid" id="photoStage">${thumbs}</div>` : `<p class="note">Add a photo each week to build your transformation — each is stamped with your nearest weight.</p>`}
    ${compare}
    <div class="tracker-row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
      <label class="btn accent" for="photoCapture" style="cursor:pointer">📷 Take photo</label>
      <input id="photoCapture" type="file" accept="image/*" capture="environment" style="display:none" />
      <label class="btn" for="photoUpload" style="cursor:pointer">🖼️ Upload</label>
      <input id="photoUpload" type="file" accept="image/*" style="display:none" />
      ${PHOTOS.length >= 2 ? `<button type="button" class="btn" id="playTimelapse">▶ Timelapse</button>` : ""}
    </div>
    <img id="timelapseStage" class="timelapse-stage" style="display:none" />
  </div>
  ${photoOverlay()}`;
}

// 7-day trailing moving average of weigh-ins (smooths daily water-weight noise)
function smoothSeries(weights) {
  return weights.map((w) => {
    const t = new Date(w.date + "T00:00:00").getTime();
    const win = weights.filter((x) => { const dt = (t - new Date(x.date + "T00:00:00").getTime()) / 86400000; return dt >= 0 && dt < 7; });
    return +(win.reduce((s, x) => s + x.kg, 0) / win.length).toFixed(2);
  });
}
function weightChart(weights) {
  const w = 320, h = 140, pad = 10;
  const raw = weights.map((x) => x.kg), sm = smoothSeries(weights);
  const all = raw.concat(sm), min = Math.min(...all), max = Math.max(...all), range = (max - min) || 1;
  const X = (i) => pad + (i / (weights.length - 1)) * (w - 2 * pad);
  const Y = (v) => pad + (1 - (v - min) / range) * (h - 2 * pad);
  const rawPts = raw.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
  const smPts = sm.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline fill="none" stroke="#3a4150" stroke-width="2" points="${rawPts.join(" ")}" />
    ${rawPts.map(p => `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="2.5" fill="#6b7280"/>`).join("")}
    <polyline fill="none" stroke="#34d399" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${smPts.join(" ")}" />
  </svg>
  <div class="chart-legend"><span><span class="lg-dot raw"></span> scale</span><span><span class="lg-dot sm"></span> 7-day trend</span></div>`;
}
function sparkline(vals) {
  const w = 320, h = 140, pad = 10;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max - min) || 1;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline fill="none" stroke="#34d399" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}" />
    ${pts.map(p => `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="3" fill="#34d399"/>`).join("")}
  </svg>`;
}

/* ---------- profile form (onboarding + settings) ---------- */
function blankProfile() { return { name: "", sex: "male", age: "", heightCm: "", weightKg: "", activity: 1.55, goal: "", surplus: 300, dislikes: [] }; }
function profileFields(p) {
  const act = p.activity || 1.55;
  const presetMatch = Object.values(ACTIVITY).some((v) => Math.abs(v - act) < 0.005);
  const actKey = Object.keys(ACTIVITY).reduce((best, k) => Math.abs(ACTIVITY[k] - act) < Math.abs(ACTIVITY[best] - act) ? k : best, "light");
  const actOpt = (k, lbl) => `<option value="${k}" ${presetMatch && actKey === k ? "selected" : ""}>${lbl}</option>`;
  return `
    <label class="field-label">Name</label>
    <input class="field" id="pfName" value="${p.name || ""}" placeholder="Your name" />
    <div class="pf-row">
      <div><label class="field-label">Sex</label>
        <select class="field" id="pfSex">
          <option value="male" ${p.sex === "male" ? "selected" : ""}>Male</option>
          <option value="female" ${p.sex === "female" ? "selected" : ""}>Female</option>
        </select></div>
      <div><label class="field-label">Age</label>
        <input class="field" id="pfAge" type="number" inputmode="numeric" value="${p.age || ""}" placeholder="yrs" /></div>
    </div>
    <div class="pf-row">
      <div><label class="field-label">Height (cm)</label>
        <input class="field" id="pfHeight" type="number" inputmode="numeric" value="${p.heightCm || ""}" placeholder="cm" /></div>
      <div><label class="field-label">Weight (kg)</label>
        <input class="field" id="pfWeight" type="number" step="0.1" inputmode="decimal" value="${p.weightKg || ""}" placeholder="kg" /></div>
    </div>
    <label class="field-label">Activity level</label>
    <select class="field" id="pfActivity">
      ${!presetMatch ? `<option value="current" selected>Current (~${Math.round((bmrFor(p) * act))} kcal/day)</option>` : ""}
      ${actOpt("sedentary", "Sedentary — desk, little exercise")}
      ${actOpt("light", "Light — 1–3 sessions/wk")}
      ${actOpt("moderate", "Moderate — 3–5 sessions/wk")}
      ${actOpt("active", "Active — 6+ sessions/wk or active job")}
    </select>
    <label class="field-label">Goal</label>
    <select class="field" id="pfGoal">
      ${!p.goal ? `<option value="" selected disabled>Choose your goal…</option>` : ""}
      <option value="cut" ${p.goal === "cut" ? "selected" : ""}>Lose fat (cut)</option>
      <option value="maintain" ${p.goal === "maintain" ? "selected" : ""}>Maintain</option>
      <option value="gain" ${p.goal === "gain" ? "selected" : ""}>Gain muscle (lean bulk)</option>
    </select>
    <label class="field-label">Foods to avoid (optional)</label>
    <input class="field" id="pfDislikes" value="${(p.dislikes || []).join(", ")}" placeholder="e.g. fish, mushrooms" />`;
}
// BMR for an arbitrary profile object (used in the form before it's saved)
function bmrFor(p) { return 10 * (p.weightKg || 70) + 6.25 * (p.heightCm || 170) - 5 * (p.age || 30) + (p.sex === "female" ? -161 : 5); }
function readProfileForm() {
  const cur = getProfile();
  const g = document.getElementById("pfActivity").value;
  const activity = g === "current" ? cur.activity : (ACTIVITY[g] || cur.activity);
  const age = parseInt(document.getElementById("pfAge").value, 10) || cur.age;
  let goal = document.getElementById("pfGoal").value || "maintain";
  let coerced = false;
  if (age < 18 && goal === "cut") { goal = "maintain"; coerced = true; } // safeguarding: no cutting under 18
  const p = {
    name: (document.getElementById("pfName").value || "").trim() || cur.name,
    sex: document.getElementById("pfSex").value,
    age,
    heightCm: parseFloat(document.getElementById("pfHeight").value) || cur.heightCm,
    weightKg: parseFloat(document.getElementById("pfWeight").value) || cur.weightKg,
    activity, goal, surplus: cur.surplus || 300,
    dislikes: (document.getElementById("pfDislikes").value || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  saveProfile(p);
  if (coerced) toast("Under 18 — set to a healthy 'maintain' rather than cutting.");
  return p;
}
// under-13: not appropriate to hand calorie/training targets. Block the save.
function ageGuard() {
  const age = parseInt(document.getElementById("pfAge").value, 10);
  if (age && age < 13) { haptic(20); toast("This app isn't suitable under 13 — please ask a parent or coach."); return false; }
  return true;
}
function saveProfileSettings() { if (!ageGuard()) return; readProfileForm(); buildBank(); toast("Profile saved · targets updated"); haptic(8); navigate(); }
function completeOnboarding() {
  if (!ageGuard()) return;
  const age = parseInt(document.getElementById("pfAge").value, 10);
  const h = parseFloat(document.getElementById("pfHeight").value);
  const w = parseFloat(document.getElementById("pfWeight").value);
  if (!age || !h || !w) { toast("Add your age, height and weight first"); return; }
  if (!document.getElementById("pfGoal").value) { toast("Pick a goal to continue"); return; }
  const p = readProfileForm();
  buildBank(); // re-filter meals to the new dislikes
  if (!LS.get("pt_startDate", null)) LS.set("pt_startDate", todayKey()); // begin at Day 1 today
  haptic(12); toast(`You're all set, ${p.name || "let's go"} 💪`);
  CURRENT_TAB = "today"; setActiveTab(); navigate();
}
function renderOnboarding() {
  return `
  <div class="card hero"><span class="phase-tag">Welcome</span>
    <h1>Let's set up your plan</h1>
    <p>Everything stays on your device — no account, no sign-up. Tell me about you and your goal and I'll tailor your calorie targets, meals and coaching.</p></div>
  <div class="card">
    <h2>👤 About you</h2>
    ${profileFields(blankProfile())}
    <p class="note safeguard">⚠️ <b>Under 13:</b> this app isn't suitable — please come back when you're older or use it with a parent/coach. <b>13–17:</b> we drop the calorie numbers and focus on eating well, training and sleep to grow. <b>Under 18:</b> set this up with a parent or guardian.</p>
    <button type="button" class="btn accent block" id="completeOnboard" style="margin-top:14px">Start my plan →</button>
  </div>
  <div class="card"><p class="note">Already set up on another phone? Restore your backup instead:</p>
    <label class="btn block" for="importFile" style="cursor:pointer;text-align:center;margin-top:8px">⬆ Restore from backup</label>
    <input id="importFile" type="file" accept="application/json" style="display:none" />
  </div>`;
}

/* ---------- SETTINGS ---------- */
function renderLibrary() {
  if (!BANK) return "";
  const lib = currentLibrary();
  const active = LS.get("pt_library", null) != null;
  let html = `<div class="card"><h2>📚 Recipe Library</h2>
    <p class="sub">Pick the meals you actually like — your daily plan is built from these and rotated across the days. ${active ? '<b style="color:var(--accent)">Active ✓</b>' : "Using the default plan until you customise."}</p>`;
  for (const [label, k] of SLOTS) {
    const sel = new Set(lib[k]); const mn = BANK[k].min, mx = BANK[k].max;
    html += `<details class="lib-slot"><summary>${label}s — <b>${sel.size}</b>/${mx} <span class="sub">(min ${mn})</span></summary>
      <div class="lib-list">${BANK[k].list.map(it => `
        <div class="lib-row ${sel.has(it.id) ? "on" : ""}" data-act="lib" data-slot="${k}" data-id="${it.id}">
          <span class="checkbox" style="border-radius:6px">${sel.has(it.id) ? "✓" : ""}</span>
          <span class="item-text">${it.text}<span class="lib-macro"> · ${it.kcal} kcal · ${it.p}g P</span></span>
        </div>`).join("")}</div></details>`;
  }
  html += `<button type="button" class="btn block" id="resetLibBtn" style="margin-top:10px">↩︎ Reset to default plan</button></div>`;
  return html;
}

function renderSettings() {
  return `
  <div class="card"><h2>⚙️ Settings</h2>
    <label class="field-label">Program start date</label>
    <input class="field" id="startDateInput" type="date" value="${getStartDate()}" />
    <button type="button" class="btn accent block" id="saveStartBtn" style="margin-top:10px">Save start date</button>
    <p class="note" style="margin-top:8px">Set this to the Monday you want week 1 to begin (or today to start now).</p>
  </div>

  ${renderLibrary()}

  <div class="card"><h2>💊 Supplements</h2>
    <p class="sub">What you tick off daily on the Today screen</p>
    <ul class="checklist">${getSupps().map(s => `<li style="cursor:default">
      <span class="item-text">${s}</span>
      <button type="button" class="x-del" data-act="delsupp" data-name="${encodeURIComponent(s)}">✕</button></li>`).join("")}</ul>
    <div class="tracker-row" style="margin-top:10px">
      <input class="field" id="suppInput" placeholder="Add a supplement…" />
      <button type="button" class="btn accent" id="addSuppBtn">Add</button>
    </div>
  </div>

  <div class="card"><h2>💾 Backup &amp; restore</h2>
    <p class="note">All your data lives on this device. Export a backup file you can keep safe or move to a new phone — includes check-ins, weigh-ins, lift logs, library, photos and settings.</p>
    <div class="step-quick" style="margin-top:8px">
      <button type="button" class="btn accent" id="exportBtn">⬇ Export backup</button>
      <label class="btn" for="importFile" style="cursor:pointer">⬆ Restore</label>
      <input id="importFile" type="file" accept="application/json" style="display:none" />
    </div>
  </div>

  <div class="card"><h2>🗑️ Reset</h2>
    <button type="button" class="btn block" id="resetBtn">Clear all my data on this device</button>
    <p class="note" style="margin-top:8px">Removes check-ins, weigh-ins, photos, profile and start date from this phone only.</p>
  </div>

  ${(() => {
    const prof = getProfile();
    return `<div class="card"><h2>👤 Your profile</h2>
      <p class="sub">Used to tailor your calorie targets & coaching. Changing your weight or goal updates everything.</p>
      ${profileFields(prof)}
      <button type="button" class="btn accent block" id="saveProfileBtn" style="margin-top:12px">Save profile</button>
      <p class="note" style="margin-top:10px">${prof.name} · ${prof.sex} · ${prof.age}y · ${prof.heightCm}cm · goal <b>${GOALS[prof.goal] || prof.goal}</b> · training <b>${trainingStyle()}</b>${numbersFree() ? " · growing-mode (no calorie targets)" : ` · maintenance ~${currentMaintenance().toLocaleString()} kcal · today's aim ~${dailyAim(position()).toLocaleString()} kcal`}.</p>
    </div>`;
  })()}

  ${renderPlanSection()}

  <div class="card"><h2>ℹ️ About</h2>
    <p class="note">Everything is stored on your device — no account, no tracking. Add this page to your home screen for an app-like experience.</p>
  </div>`;
}

/* ---------- interactions ---------- */
function logWeight() {
  const el = document.getElementById("quickWeight");
  const kg = parseFloat(el.value);
  if (!kg || kg < 30 || kg > 250) { el.focus(); return; }
  const weights = LS.get("pt_weights", []);
  const key = todayKey();
  const existing = weights.findIndex(w => w.date === key);
  if (existing >= 0) weights[existing].kg = kg; else weights.push({ date: key, kg });
  LS.set("pt_weights", weights);
  haptic(8); el.blur();
  flashSaved(el);
  repaintKeepScroll();   // refresh stats/chart without snapping to top
}

function haptic(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch {} } }

function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 1700);
}

// toggle a meal in/out of your library, enforcing the slot's min/max
function libToggle(slot, id) {
  const lib = currentLibrary();
  const set = new Set(lib[slot]); const { min, max } = BANK[slot];
  if (set.has(id)) {
    if (set.size <= min) { haptic(20); toast(`Keep at least ${min} ${slot}${min > 1 ? "s" : ""}`); return; }
    set.delete(id);
  } else {
    if (set.size >= max) { haptic(20); toast(`Max ${max} ${slot}s — deselect one first`); return; }
    set.add(id);
  }
  lib[slot] = [...set]; LS.set("pt_library", lib); haptic(8);
  repaintKeepScroll();
}

// Repaint the current tab but keep the scroll exactly where it was (no jump).
function repaintKeepScroll() {
  const y = window.scrollY || window.pageYOffset || 0;
  render();
  window.scrollTo(0, y);
  requestAnimationFrame(() => window.scrollTo(0, y));
}

// Swap only the workout list + toggle state when Gym/Home is pressed — no full render.
function applyMode() {
  const pos = position();
  if (pos.beforeStart || pos.finished) return;
  const day = pos.phase.schedule[pos.weekday];
  const card = document.querySelector("[data-workout-card]");
  if (!card || !day.homeItems) return;
  const useHome = LS.get("pt_mode", "gym") === "home";
  const exercises = useHome ? day.homeItems : day.items;
  const checks = LS.get("pt_checks_" + todayKey(), { workout: {}, meals: {}, water: 0 });
  // full row template (log buttons, suggestions, ⓘ guides) — same builder as renderToday
  card.querySelector("ul.checklist").innerHTML = workoutRowsHtml(day, exercises, checks, pos.dn);
  card.querySelectorAll(".mode-btn").forEach((b) => {
    const on = (b.dataset.mode === "home") === useHome;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  updateWorkoutBadge();
}

function flashSaved(el) {
  const tip = document.createElement("span");
  tip.textContent = "Saved ✓"; tip.className = "saved-tip";
  el.parentElement.appendChild(tip);
  setTimeout(() => tip.remove(), 1400);
}

function onViewClick(e) {
  const modeBtn = e.target.closest("[data-mode]");
  if (modeBtn) { haptic(6); LS.set("pt_mode", modeBtn.dataset.mode); applyMode(); return; }

  const restBtn = e.target.closest("[data-rest]");
  if (restBtn) { startRest(+restBtn.dataset.rest); return; }
  const cheatBtn = e.target.closest("[data-cheat]");
  if (cheatBtn) { logCheat(+cheatBtn.dataset.cheat); return; }

  const tagged = e.target.closest("[data-act]");
  if (tagged && tagged.dataset.act === "prevday") { if (tagged.disabled) return; haptic(6); VIEW_OFFSET -= 1; navigate(); return; }
  if (tagged && tagged.dataset.act === "nextday") { if (tagged.disabled) return; haptic(6); VIEW_OFFSET = Math.min(0, VIEW_OFFSET + 1); navigate(); return; }
  if (tagged && tagged.dataset.act === "todayview") { haptic(8); VIEW_OFFSET = 0; navigate(); return; }
  if (tagged && tagged.dataset.act === "gotostats") { haptic(6); CURRENT_TAB = "progress"; VIEW_OFFSET = 0; setActiveTab(); navigate(); return; }
  if (tagged && tagged.dataset.act === "swap") { haptic(6); swapMeal(+tagged.dataset.i); return; }
  if (tagged && tagged.dataset.act === "delcustom") { haptic(6); delCustom(+tagged.dataset.i); return; }
  if (tagged && tagged.dataset.act === "delstaple") { haptic(6); delStaple(+tagged.dataset.i); return; }
  if (tagged && tagged.dataset.act === "delextra") { haptic(6); delExtra(+tagged.dataset.i); return; }
  if (tagged && tagged.dataset.act === "delmeas") { haptic(6); delMeas(+tagged.dataset.i); return; }
  if (tagged && tagged.dataset.act === "ready") {
    haptic(8); const k = todayKey(); const r = LS.get("pt_ready_" + k, {});
    r[tagged.dataset.k] = +tagged.dataset.v; LS.set("pt_ready_" + k, r);
    if (r.s && r.m && r.e) haptic([40, 30, 60]);
    repaintKeepScroll(); return;
  }
  if (tagged && tagged.dataset.act === "readyedit") { haptic(6); localStorage.removeItem("pt_ready_" + todayKey()); repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "formguide") { haptic(6); const n = decodeURIComponent(tagged.dataset.name); OPEN_FORM = OPEN_FORM === n ? null : n; repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "openpanel") {
    haptic(6); const p = tagged.dataset.panel;
    OPEN_PANELS[p] = true; repaintKeepScroll();
    requestAnimationFrame(() => { const el = document.querySelector(`[data-panel="${p}"]`); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); });
    return;
  }
  if (tagged && tagged.dataset.act === "ivstart") { startIntervals(); return; }
  if (tagged && tagged.dataset.act === "ivstop") { haptic(6); stopIntervals(true); return; }
  if (tagged && tagged.dataset.act === "hmcell") { haptic(6); const dn = +tagged.dataset.dn; HM_SEL = HM_SEL === dn ? null : dn; repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "hmopen") {
    haptic(8); const dn = +tagged.dataset.dn;
    VIEW_OFFSET = Math.min(0, dn - position().dn); HM_SEL = null;
    CURRENT_TAB = "today"; setActiveTab(); navigate(); return;
  }
  if (tagged && tagged.dataset.act === "delphoto") { haptic(6); delPhoto(tagged.dataset.date); return; }
  if (tagged && tagged.dataset.act === "viewphoto") { haptic(6); VIEW_PHOTO = tagged.dataset.date; repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "closephoto") { VIEW_PHOTO = null; repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "exportphoto") { haptic(8); exportPhoto(tagged.dataset.date); return; }
  if (tagged && tagged.dataset.act === "noop") return;
  if (tagged && tagged.dataset.act === "dietbreak") { haptic(8); const wk = +tagged.dataset.wk; const b = LS.get("pt_dietbreaks", []); const i = b.indexOf(wk); if (i >= 0) b.splice(i, 1); else b.push(wk); LS.set("pt_dietbreaks", b); repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "lib") { libToggle(tagged.dataset.slot, tagged.dataset.id); return; }
  if (tagged && tagged.dataset.act === "supp") { haptic(8); toggleSupp(decodeURIComponent(tagged.dataset.name), tagged); return; }
  if (tagged && tagged.dataset.act === "skipmeal") { haptic(6); toggleSkip(decodeURIComponent(tagged.dataset.slot)); return; }
  if (tagged && tagged.dataset.act === "openswap") { haptic(6); const s = decodeURIComponent(tagged.dataset.slot); SWAP_SLOT = SWAP_SLOT === s ? null : s; repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "pickmeal") { haptic(8); pickMeal(decodeURIComponent(tagged.dataset.slot), tagged.dataset.id); return; }
  if (tagged && tagged.dataset.act === "adapt") { haptic(8); LS.set("pt_adaptkcal", Math.max(-300, Math.min(300, LS.get("pt_adaptkcal", 0) + (+tagged.dataset.kcal)))); toast("Targets adjusted"); repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "adaptreset") { haptic(6); localStorage.removeItem("pt_adaptkcal"); repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "openlift") { haptic(6); const n = decodeURIComponent(tagged.dataset.name); OPEN_LIFT = OPEN_LIFT === n ? null : n; repaintKeepScroll(); return; }
  if (tagged && tagged.dataset.act === "savelift") { saveLift(decodeURIComponent(tagged.dataset.name)); return; }
  if (tagged && tagged.dataset.act === "delsupp") { haptic(6); delSupp(decodeURIComponent(tagged.dataset.name)); return; }
  if (tagged && tagged.dataset.act === "batch") { haptic(8); toggleBatch(tagged); return; }
  if (tagged && tagged.dataset.act === "shop") { haptic(8); toggleShop(tagged); return; }
  if (tagged && (tagged.dataset.act === "waterinc" || tagged.dataset.act === "waterdec")) {
    const key = todayKey();
    const checks = LS.get("pt_checks_" + key, { workout: {}, meals: {}, water: 0 });
    const delta = tagged.dataset.act === "waterinc" ? 1 : -1;
    checks.water = Math.max(0, Math.min(8, (checks.water || 0) + delta));
    LS.set("pt_checks_" + key, checks);
    haptic(8); updateWater(checks.water); updateTodayChips();
    if (CURRENT_TAB === "today" && isTodayPerfect() && !document.querySelector(".perfect")) { haptic([100, 50, 100, 50, 220]); repaintKeepScroll(); }
    return;
  }
  if (tagged && (tagged.dataset.act === "workout" || tagged.dataset.act === "meals" || tagged.dataset.act === "water")) {
    const act = tagged.dataset.act, i = parseInt(tagged.dataset.i, 10);
    const key = todayKey();
    const checks = LS.get("pt_checks_" + key, { workout: {}, meals: {}, water: 0 });
    haptic(8);
    if (act === "water") {
      checks.water = (i + 1 === checks.water) ? i : i + 1;
      LS.set("pt_checks_" + key, checks);
      updateWater(checks.water);          // surgical — keeps scroll position
    } else {
      checks[act][i] = !checks[act][i];
      LS.set("pt_checks_" + key, checks);
      const on = checks[act][i];
      tagged.classList.toggle("done", on);
      const cb = tagged.querySelector(".checkbox");
      if (cb) cb.textContent = on ? "✓" : "";
      if (act === "meals") { updateRemaining(); updateFuelBadge(); }   // live budget + card summary
      if (act === "workout") updateWorkoutBadge();
    }
    updateTodayChips();
    // celebrate the moment everything's complete
    if (CURRENT_TAB === "today" && isTodayPerfect() && !document.querySelector(".perfect")) {
      haptic([100, 50, 100, 50, 220]); repaintKeepScroll();
    }
    return;
  }
  if (e.target.id === "logWeightBtn") return logWeight();
  if (e.target.id === "saveGoalBtn") return saveGoal();
  if (e.target.id === "useSuggestedGoal") { LS.set("pt_goal", suggestedGoal()); haptic(8); repaintKeepScroll(); return; }
  if (e.target.id === "clearGoalBtn") { localStorage.removeItem("pt_goal"); repaintKeepScroll(); return; }
  if (e.target.id === "completeOnboard") return completeOnboarding();
  if (e.target.id === "saveProfileBtn") return saveProfileSettings();
  if (e.target.id === "addCustomBtn") return addCustom();
  if (e.target.id === "addStapleBtn") return addStaple();
  if (e.target.id === "addExtraBtn") return addExtra();
  if (e.target.id === "saveMeasBtn") return saveMeas();
  if (e.target.id === "addSuppBtn") return addSupp();
  if (e.target.id === "exportBtn") return exportData();
  if (e.target.id === "shareReportBtn") return shareReport();
  if (e.target.id === "setCheatBtn") return setCheatFromInput();
  if (e.target.id === "clearCheatBtn") { localStorage.removeItem("pt_cheat_" + todayKey()); haptic(8); repaintKeepScroll(); return; }
  if (e.target.id === "pushDayBtn") { LS.set("pt_shift", LS.get("pt_shift", 0) + 1); haptic(8); toast("Plan pushed back a day"); repaintKeepScroll(); return; }
  if (e.target.id === "undoShiftBtn") { LS.set("pt_shift", Math.max(0, LS.get("pt_shift", 0) - 1)); haptic(8); repaintKeepScroll(); return; }
  if (e.target.id === "resetShiftBtn") { localStorage.removeItem("pt_shift"); haptic(8); toast("Reschedule reset"); repaintKeepScroll(); return; }
  if (e.target.id === "resetLibBtn") { localStorage.removeItem("pt_library"); haptic(8); toast("Back to the default plan"); repaintKeepScroll(); return; }
  if (e.target.id === "playTimelapse") return playTimelapse();
  if (e.target.id === "saveStartBtn") {
    LS.set("pt_startDate", document.getElementById("startDateInput").value);
    CURRENT_TAB = "today"; setActiveTab(); navigate(); return;
  }
  if (e.target.id === "resetShopBtn") {
    const wk = Math.max(1, Math.min(position().week, PLAN.meta.weeks));
    LS.set("pt_shop_w" + wk, {});
    repaintKeepScroll(); return;
  }
  if (e.target.id === "resetBtn") {
    if (confirm("Clear all saved data on this device? This includes your photos.")) {
      Object.keys(localStorage).filter(k => k.startsWith("pt_")).forEach(k => localStorage.removeItem(k));
      (async () => { for (const p of PHOTOS) await photoDel(p.date); PHOTOS = []; repaintKeepScroll(); })();
    }
    return;
  }
}

/* ---------- new feature handlers ---------- */
function swapMeal(i) {
  const key = todayKey();
  if (i < 0) localStorage.removeItem("pt_swap_" + key); else LS.set("pt_swap_" + key, i);
  repaintKeepScroll();
}
/* supplements */
function toggleSkip(slot) {
  const key = "pt_skip_" + todayKey(); const s = LS.get(key, {});
  s[slot] = !s[slot]; if (!s[slot]) delete s[slot]; LS.set(key, s);
  repaintKeepScroll();
}
// swap a single meal slot for another option (from your library pool, or the full bank)
function pickMeal(slot, id) {
  const key = "pt_mealswap_" + todayKey(); const ov = LS.get(key, {});
  if (id === "__default") delete ov[slot]; else ov[slot] = id;
  LS.set(key, ov); SWAP_SLOT = null; repaintKeepScroll();
}
function toggleSupp(name, el) {
  const key = "pt_supp_" + todayKey(); const c = LS.get(key, {});
  c[name] = !c[name]; if (!c[name]) delete c[name]; LS.set(key, c);
  const on = !!c[name];
  el.classList.toggle("on", on);
  el.textContent = (on ? "✓ " : "") + name;
}
function addSupp() {
  const el = document.getElementById("suppInput"); const v = (el.value || "").trim();
  if (!v) { el.focus(); return; }
  const arr = getSupps().slice(); if (!arr.includes(v)) arr.push(v);
  LS.set("pt_supps", arr); haptic(8); repaintKeepScroll();
}
function delSupp(name) { LS.set("pt_supps", getSupps().filter(s => s !== name)); repaintKeepScroll(); }
/* cheat / eating-out balancing */
function logCheat(amount) {
  LS.set("pt_cheat_" + todayKey(), amount); haptic(8);
  toast(`Logged +${amount} kcal — balanced over ${CHEAT_SPREAD} days`); repaintKeepScroll();
}
function setCheatFromInput() {
  const el = document.getElementById("cheatInput"); const v = parseInt(el.value, 10);
  if (isNaN(v) || v <= 0) { el.focus(); return; }
  logCheat(v);
}
/* batch-prep ticks (Shop tab) */
function toggleBatch(li) {
  const wk = Math.max(1, Math.min(position().week, PLAN.meta.weeks));
  const key = "pt_batch_w" + wk; const map = LS.get(key, {}); const k = li.dataset.k;
  map[k] = !map[k]; if (!map[k]) delete map[k]; LS.set(key, map);
  const on = !!map[k]; li.classList.toggle("done", on);
  const cb = li.querySelector(".checkbox"); if (cb) cb.textContent = on ? "✓" : "";
}
function saveGoal() {
  const el = document.getElementById("goalWeight"); const kg = parseFloat(el.value);
  if (!kg || kg < 30 || kg > 250) { el.focus(); return; }
  LS.set("pt_goal", kg); haptic(8); repaintKeepScroll();
}
function addCustom() {
  const el = document.getElementById("customItem"); const v = (el.value || "").trim();
  if (!v) { el.focus(); return; }
  const wk = Math.max(1, Math.min(position().week, PLAN.meta.weeks));
  const arr = LS.get("pt_shopcustom_w" + wk, []); arr.push(v); LS.set("pt_shopcustom_w" + wk, arr);
  haptic(8); repaintKeepScroll();
}
function delCustom(i) {
  const wk = Math.max(1, Math.min(position().week, PLAN.meta.weeks));
  const arr = LS.get("pt_shopcustom_w" + wk, []); arr.splice(i, 1); LS.set("pt_shopcustom_w" + wk, arr);
  const ck = LS.get("pt_shop_w" + wk, {});
  Object.keys(ck).filter(k => k[0] === "x").forEach(k => delete ck[k]); // indices shift, clear custom ticks
  LS.set("pt_shop_w" + wk, ck);
  repaintKeepScroll();
}
// weekly staples persist across every week's list (pt_staples)
function addStaple() {
  const el = document.getElementById("stapleItem"); const v = (el.value || "").trim();
  if (!v) { el.focus(); return; }
  const arr = LS.get("pt_staples", []); arr.push(v); LS.set("pt_staples", arr);
  haptic(8); repaintKeepScroll();
}
// ad-hoc extra foods logged for today (count against the "left to eat" budget)
function addExtra() {
  const nameEl = document.getElementById("extraName"), kcalEl = document.getElementById("extraKcal"), pEl = document.getElementById("extraP");
  const name = (nameEl.value || "").trim(), kcal = parseInt(kcalEl.value, 10);
  if (!name) { nameEl.focus(); return; }
  if (!kcal || kcal <= 0) { kcalEl.focus(); return; }
  const key = todayKey();
  const arr = LS.get("pt_extra_" + key, []);
  arr.push({ name, kcal, p: parseInt(pEl.value, 10) || 0 });
  LS.set("pt_extra_" + key, arr);
  haptic(8); repaintKeepScroll();
}
function delExtra(i) {
  const key = todayKey();
  const arr = LS.get("pt_extra_" + key, []); arr.splice(i, 1); LS.set("pt_extra_" + key, arr);
  haptic(6); repaintKeepScroll();
}
function delStaple(i) {
  const arr = LS.get("pt_staples", []); arr.splice(i, 1); LS.set("pt_staples", arr);
  const wk = Math.max(1, Math.min(position().week, PLAN.meta.weeks));
  const ck = LS.get("pt_shop_w" + wk, {});
  Object.keys(ck).filter(k => k[0] === "s").forEach(k => delete ck[k]); // indices shift, clear staple ticks
  LS.set("pt_shop_w" + wk, ck);
  repaintKeepScroll();
}
/* ---------- progress photos ---------- */
// nearest logged bodyweight to a given date
function closestWeight(dateKey) {
  const w = LS.get("pt_weights", []); if (!w.length) return null;
  const t = new Date(dateKey + "T00:00:00").getTime();
  let best = null, bd = Infinity;
  for (const x of w) { const d = Math.abs(new Date(x.date + "T00:00:00").getTime() - t); if (d < bd) { bd = d; best = x.kg; } }
  return best;
}
// draw the weight+date watermark, bottom-left, scaled to the image
function drawWatermark(ctx, w, h, kg, dateKey) {
  const cap = (kg != null ? "~" + kg + " kg · " : "") + new Date(dateKey + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const fs = Math.max(18, Math.round(h * 0.04));
  ctx.font = `800 ${fs}px -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
  const tw = ctx.measureText(cap).width, pad = Math.round(h * 0.028);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(pad - 10, h - pad - fs - 16, tw + 30, fs + 24);
  ctx.fillStyle = "#34d399"; ctx.fillRect(pad - 10, h - pad - fs - 16, 6, fs + 24);
  ctx.fillStyle = "#fff"; ctx.fillText(cap, pad + 8, h - pad - 7);
}
function addPhotoFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      const max = 1000, scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0, w, h);
      const kg = closestWeight(todayKey());
      drawWatermark(ctx, w, h, kg, todayKey());
      await photoPut({ date: todayKey(), data: cv.toDataURL("image/jpeg", 0.8), kg, wm: true });
      PHOTOS = await photosAll();
      haptic(8); repaintKeepScroll();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
async function delPhoto(date) {
  if (!confirm("Delete this photo?")) return;
  VIEW_PHOTO = null;
  await photoDel(date); PHOTOS = await photosAll(); repaintKeepScroll();
}
async function exportPhoto(date) {
  const p = PHOTOS.find((x) => x.date === date); if (!p) return;
  try {
    const blob = await (await fetch(p.data)).blob();
    const file = new File([blob], "progress-" + date + ".jpg", { type: blob.type || "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: `Progress · ${p.kg != null ? "~" + p.kg + "kg · " : ""}${date}` }); return; }
  } catch { /* fall through to download */ }
  const a = document.createElement("a"); a.href = p.data; a.download = "progress-" + date + ".jpg"; a.click(); toast("Photo saved");
}
function photoOverlay() {
  if (!VIEW_PHOTO) return "";
  const p = PHOTOS.find((x) => x.date === VIEW_PHOTO); if (!p) return "";
  const kg = p.kg != null ? p.kg : closestWeight(p.date);
  const cap = (kg != null ? `~${kg} kg · ` : "") + p.date;
  return `<div class="lightbox" data-act="closephoto">
    <div class="lb-inner" data-act="noop">
      <img src="${p.data}" alt="${p.date}" />
      <div class="lb-bar"><span>${cap}</span>
        <span class="lb-actions">
          <button type="button" class="btn" data-act="exportphoto" data-date="${p.date}">📤</button>
          <button type="button" class="btn" data-act="delphoto" data-date="${p.date}">🗑</button>
          <button type="button" class="btn accent" data-act="closephoto">Done</button>
        </span></div>
    </div></div>`;
}
let TL_INT = null;
function playTimelapse() {
  const stage = document.getElementById("timelapseStage");
  if (!stage || PHOTOS.length < 2) return;
  clearInterval(TL_INT);
  stage.style.display = "block";
  let i = 0;
  const step = () => { stage.src = PHOTOS[i].data; i = (i + 1) % PHOTOS.length; };
  step();
  TL_INT = setInterval(() => {
    step();
    if (i === 0) { /* looped once */ }
  }, 450);
  // auto-stop after 2 full loops
  setTimeout(() => clearInterval(TL_INT), PHOTOS.length * 450 * 2 + 50);
}
function setCompare(v) {
  COMPARE_T = Math.max(0, Math.min(100, +v));
  const top = document.getElementById("cmpTop");
  const handle = document.querySelector(".cmp-handle");
  if (top) top.style.clipPath = `inset(0 ${100 - COMPARE_T}% 0 0)`;
  if (handle) handle.style.left = COMPARE_T + "%";
}

function updateTodayChips() {
  const pos = position(); if (pos.beforeStart || pos.finished) return;
  const day = pos.phase.schedule[pos.weekday];
  const ex = (LS.get("pt_mode", "gym") === "home" && day.homeItems) ? day.homeItems : day.items;
  const key = todayKey(); const c = LS.get("pt_checks_" + key, { workout: {}, meals: {}, water: 0 });
  const sw = LS.get("pt_swap_" + key, null);
  const meal = (sw != null && sw >= 0 && sw < PLAN.meals.length) ? PLAN.meals[sw] : dayMeal(pos.dn);
  const mKeys = Object.keys(meal.items);
  const wDone = ex.filter((_, i) => c.workout[i]).length;
  const sk = LS.get("pt_skip_" + key, {}); const mDone = mKeys.filter((k, i) => c.meals[i] || sk[k]).length;
  // animate the hero rings + legend (CSS transitions the dash offsets)
  const setRing = (k, done, total) => {
    const el = document.getElementById("ring" + k); if (!el) return;
    const C = 2 * Math.PI * (+el.dataset.r);
    el.style.strokeDashoffset = (C * (1 - Math.min(1, total ? done / total : 0))).toFixed(1);
  };
  const waterC = Math.min(c.water || 0, 8);
  setRing("W", wDone, ex.length); setRing("M", mDone, mKeys.length); setRing("H", waterC, 8);
  const pctEl = document.getElementById("ringPct");
  if (pctEl) pctEl.textContent = Math.round(100 * (wDone + mDone + waterC) / (ex.length + mKeys.length + 8)) + "%";
  const rlW = document.getElementById("rlW"); if (rlW) rlW.textContent = `${day.type === "rest" ? "😴" : "🏋️"} ${wDone}/${ex.length}`;
  const rlM = document.getElementById("rlM"); if (rlM) rlM.textContent = `🍽️ ${mDone}/${mKeys.length}`;
  const rlH = document.getElementById("rlH"); if (rlH) rlH.textContent = `💧 ${waterC}/8`;
  // live-update the hero status (traffic light merged into the hero)
  const hero = document.querySelector(".hero");
  const pill = hero && hero.querySelector(".light-pill");
  if (pill) {
    const total = ex.length + mKeys.length + 8, done = wDone + mDone + Math.min(c.water || 0, 8);
    const light = trafficLight(total ? done / total : 0);
    hero.classList.remove("light-green", "light-amber", "light-red");
    hero.classList.add("light-" + light);
    pill.textContent = light === "green" ? "🟢 On track" : light === "amber" ? "🟡 Behind" : "🔴 Off pace";
  }
  // (water readout is updated separately by updateWater — don't overwrite its litres spans here)
}
function isTodayPerfect() {
  const pos = position(); if (pos.beforeStart || pos.finished) return false;
  const day = pos.phase.schedule[pos.weekday];
  const ex = (LS.get("pt_mode", "gym") === "home" && day.homeItems) ? day.homeItems : day.items;
  const key = todayKey(); const c = LS.get("pt_checks_" + key, { workout: {}, meals: {}, water: 0 });
  const sw = LS.get("pt_swap_" + key, null);
  const meal = (sw != null && sw >= 0 && sw < PLAN.meals.length) ? PLAN.meals[sw] : dayMeal(pos.dn);
  const mKeys = Object.keys(meal.items);
  const wDone = ex.filter((_, i) => c.workout[i]).length;
  const sk = LS.get("pt_skip_" + key, {}); const mDone = mKeys.filter((k, i) => c.meals[i] || sk[k]).length;
  return wDone === ex.length && mDone === mKeys.length && c.water >= 8;
}

/* ---------- interval coach runtime ---------- */
let IV_INT = null;
function stopIntervals(reset) {
  clearInterval(IV_INT); IV_INT = null;
  if (!reset) return;
  const P = document.getElementById("ivPhase"), T = document.getElementById("ivTime"),
    R = document.getElementById("ivRound"), F = document.getElementById("ivFill");
  if (P) { P.textContent = "Ready"; P.className = "iv-phase"; }
  if (T) T.textContent = "--"; if (R) R.textContent = ""; if (F) F.style.width = "0%";
}
function startIntervals() {
  const box = document.getElementById("ivBox"); if (!box) return;
  clearInterval(REST_INT); // one timer at a time
  stopIntervals(false);
  const rounds = +box.dataset.rounds, work = +box.dataset.work, easy = +box.dataset.easy;
  let round = 1, phase = "work", left = work;
  const P = document.getElementById("ivPhase"), T = document.getElementById("ivTime"),
    R = document.getElementById("ivRound"), F = document.getElementById("ivFill");
  const paint = () => {
    P.textContent = phase === "work" ? "🔥 HARD" : "😮‍💨 EASY";
    P.className = "iv-phase " + phase;
    T.textContent = left + "s"; R.textContent = `round ${round}/${rounds}`;
    F.style.width = Math.round(100 * (1 - left / (phase === "work" ? work : easy))) + "%";
  };
  haptic([60, 40, 120]); beep(); paint();
  IV_INT = setInterval(() => {
    left--;
    if (left <= 0) {
      if (phase === "work") { phase = "easy"; left = easy; beep(); haptic(60); }
      else {
        round++;
        if (round > rounds) {
          clearInterval(IV_INT); IV_INT = null;
          P.textContent = "🎉 Done — great session!"; P.className = "iv-phase done";
          T.textContent = ""; R.textContent = ""; F.style.width = "100%";
          haptic([120, 60, 120, 60, 240]); beep(); setTimeout(beep, 300);
          return;
        }
        phase = "work"; left = work; beep(); setTimeout(beep, 180); haptic([60, 40, 120]);
      }
    }
    paint();
  }, 1000);
}

let REST_INT = null;
function startRest(sec) {
  const disp = document.getElementById("restDisplay"); if (!disp) return;
  clearInterval(REST_INT);
  if (sec <= 0) { disp.textContent = "Rest timer"; disp.className = "rest-display"; haptic(6); return; }
  let left = sec; haptic(10);
  disp.className = "rest-display running";
  const tick = () => { disp.textContent = `⏱️ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; };
  tick();
  REST_INT = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(REST_INT); disp.textContent = "✅ Go!"; disp.className = "rest-display ding"; haptic([120, 60, 120]); beep(); return; }
    tick();
  }, 1000);
}
function beep() {
  try {
    const A = new (window.AudioContext || window.webkitAudioContext)();
    const o = A.createOscillator(), g = A.createGain();
    o.connect(g); g.connect(A.destination); o.frequency.value = 880; o.start();
    g.gain.setValueAtTime(0.15, A.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, A.currentTime + 0.4);
    o.stop(A.currentTime + 0.4);
  } catch {}
}

// Tick a shopping item off — surgical update keyed to the current week, keeps scroll.
function toggleShop(li) {
  const wk = Math.max(1, Math.min(position().week, PLAN.meta.weeks));
  const lsKey = "pt_shop_w" + wk;
  const map = LS.get(lsKey, {});
  const k = li.dataset.k;
  map[k] = !map[k];
  if (!map[k]) delete map[k];
  LS.set(lsKey, map);
  const on = !!map[k];
  li.classList.toggle("done", on);
  const cb = li.querySelector(".checkbox");
  if (cb) cb.textContent = on ? "✓" : "";
  const hero = document.querySelector(".hero .progress-fill");
  // refresh the little progress count without a full re-render
  const items = document.querySelectorAll('[data-act="shop"]');
  const done = document.querySelectorAll('[data-act="shop"].done').length;
  if (hero) hero.style.width = Math.round((done / items.length) * 100) + "%";
  const cnt = document.querySelector(".hero .quote");
  if (cnt) cnt.textContent = `${done} of ${items.length} ticked off${done === items.length ? " — all done! 🎉" : ""}`;
}

// each glass = 250ml; target 8 = 2 L. Show "drunk / 2 L" so it maps to a bottle.
// recompute the "left to eat" budget from ticked meals (surgical, no full repaint)
function updateRemaining() {
  const row = document.getElementById("remainRow"); if (!row) return;
  const keys = ["kcal", "protein", "carbs", "fat"];
  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  document.querySelectorAll('#view li[data-act="meals"].done').forEach((li) => {
    sum.kcal += +li.dataset.kc || 0; sum.protein += +li.dataset.pr || 0;
    sum.carbs += +li.dataset.cb || 0; sum.fat += +li.dataset.ft || 0;
  });
  let allIn = true, over = false;
  row.querySelectorAll(".rv").forEach((el) => {
    const m = el.dataset.m, left = Math.round((+row.dataset[m] || 0) - sum[m] - (+row.dataset["x" + m] || 0));
    el.textContent = Math.max(0, left);
    if (m === "kcal") { allIn = left <= 0; over = left < 0; }
  });
  row.classList.toggle("done", allIn);
  row.classList.toggle("over", over);
}
function waterReadout(n) { return (Math.round(n * 25) / 100) + " / 2 L"; }
function waterGlasses(n) {
  const left = Math.round((8 - n) * 25) / 100;
  return (left <= 0 ? "🎉 target hit" : left + " L left") + " · " + n + "/8 glasses";
}
function updateWater(n) {
  const wrap = document.querySelector(".water-dots");
  if (wrap) wrap.querySelectorAll(".water-dot").forEach((d, i) => {
    const filled = i < n;
    d.classList.toggle("filled", filled);
    d.textContent = filled ? "💧" : "";
  });
  const cnt = document.getElementById("waterCount"); if (cnt) cnt.textContent = waterReadout(n);
  const vol = document.getElementById("waterVol"); if (vol) vol.textContent = waterGlasses(n);
  const dec = document.querySelector('[data-act="waterdec"]'); if (dec) dec.disabled = n <= 0;
  const inc = document.querySelector('[data-act="waterinc"]'); if (inc) inc.disabled = n >= 8;
  updateDailyBadge(n);
}
// refresh the collapsed-card summary counters after a surgical tick
function updateWorkoutBadge() {
  const card = document.querySelector('#view [data-panel="workout"]'); if (!card) return;
  const b = card.querySelector(".wo-sum-prog"); if (!b || b.textContent.indexOf("😴") >= 0) return;
  const rows = card.querySelectorAll('li[data-act="workout"]'), total = rows.length;
  let done = 0; rows.forEach((li) => { if (li.classList.contains("done")) done++; });
  b.textContent = `${done}/${total}`; b.classList.toggle("on", total > 0 && done >= total);
}
function updateFuelBadge() {
  const card = document.querySelector('#view [data-panel="fuel"]'); if (!card) return;
  const b = card.querySelector(".wo-sum-prog"); if (!b) return;
  const rows = card.querySelectorAll('li[data-act="meals"]'), total = rows.length;
  let done = 0; rows.forEach((li) => { if (li.classList.contains("done") || li.classList.contains("skipped-meal")) done++; });
  const rr = document.getElementById("remainRow");
  b.textContent = `${done}/${total}${rr ? ` · ${rr.dataset.kcal}kcal` : ""}`;
  b.classList.toggle("on", total > 0 && done >= total);
}
function updateDailyBadge(n) {
  const card = document.querySelector('#view [data-panel="daily"]'); if (!card) return;
  const b = card.querySelector(".wo-sum-prog"); if (!b) return;
  b.textContent = `💧 ${n}/8`; b.classList.toggle("on", n >= 8);
}

/* ---------- shell ---------- */
// render() repaints the current tab WITHOUT moving the scroll position.
function render() {
  clearInterval(REST_INT); clearInterval(TL_INT); clearInterval(IV_INT); // a repaint replaces those elements
  const view = document.getElementById("view");
  if (needsOnboarding()) {
    view.innerHTML = renderOnboarding();
    const pn = document.getElementById("phaseName"); if (pn) pn.textContent = "Welcome";
    const dp = document.getElementById("dayPill"); if (dp) dp.textContent = "Set up";
    const op = document.getElementById("overallProgress"); if (op) op.style.width = "0%";
    enhanceA11y();
    return;
  }
  if (CURRENT_TAB === "today") view.innerHTML = renderToday();
  else if (CURRENT_TAB === "shop") view.innerHTML = renderShop();
  else if (CURRENT_TAB === "progress") view.innerHTML = renderProgress();
  else if (CURRENT_TAB === "photos") view.innerHTML = renderPhotosTab();
  else view.innerHTML = renderSettings();

  // header
  const pos = position();
  document.getElementById("phaseName").textContent =
    pos.beforeStart ? "Not started" : pos.finished ? "Complete 🏆" : `Phase ${pos.phase.id} · ${pos.phase.name}`;
  document.getElementById("dayPill").textContent =
    pos.beforeStart ? "Soon" : pos.finished ? "Done" : `Day ${pos.dn + 1} · Wk ${pos.week}`;
  const pct = Math.max(0, Math.min(100, ((pos.dn + 1) / (PLAN.meta.weeks * 7)) * 100));
  document.getElementById("overallProgress").style.width = pct + "%";
  enhanceA11y();
}
// Make non-button interactive rows (checklists, water dots, library/shop items) keyboard-operable.
function enhanceA11y() {
  document.querySelectorAll("#view [data-act]").forEach((el) => {
    const t = el.tagName;
    if (t === "BUTTON" || t === "INPUT" || t === "A" || t === "SELECT") return;
    if (el.dataset.act === "noop" || el.dataset.act === "closephoto") return;
    if (el.dataset.act === "hmcell") return; // 84 tab stops would drown the tab order
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
  });
}
// navigate() is for tab switches: repaint, animate in, and return to top.
function navigate() {
  render();
  const v = document.getElementById("view");
  v.classList.remove("view-anim"); void v.offsetWidth; v.classList.add("view-anim");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function setActiveTab() {
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === CURRENT_TAB));
}

async function boot() {
  try {
    const res = await fetch("data/plan.json?v=" + Date.now());
    PLAN = await res.json();
  } catch (err) {
    document.getElementById("view").innerHTML = `<div class="card"><p>Couldn't load the plan. If you opened this file directly, view it via the hosted GitHub Pages link instead.</p></div>`;
    return;
  }
  buildBank();
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
    if (CURRENT_TAB === t.dataset.tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    CURRENT_TAB = t.dataset.tab; SWAP_SLOT = null; OPEN_LIFT = null; OPEN_FORM = null; VIEW_PHOTO = null; VIEW_OFFSET = 0; OPEN_PANELS = {}; HM_SEL = null; setActiveTab(); navigate();
  }));
  const view = document.getElementById("view");
  view.addEventListener("click", onViewClick);
  // remember which collapsed Today cards are expanded (toggle doesn't bubble → use capture)
  view.addEventListener("toggle", (e) => {
    if (e.target && e.target.matches && e.target.matches("details[data-panel]")) OPEN_PANELS[e.target.dataset.panel] = e.target.open;
  }, true);
  view.addEventListener("keydown", (e) => {
    // keyboard activation for non-button interactive rows (checklists, dots, lib/shop items)
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-act]") &&
        e.target.tagName !== "BUTTON" && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT") {
      e.preventDefault(); onViewClick(e); return;
    }
    if (e.key !== "Enter") return;
    if (e.target.id === "quickWeight") { e.preventDefault(); logWeight(); }
    else if (e.target.id === "goalWeight") { e.preventDefault(); saveGoal(); }
    else if (e.target.id === "customItem") { e.preventDefault(); addCustom(); }
    else if (e.target.id === "stapleItem") { e.preventDefault(); addStaple(); }
    else if (e.target.id === "extraName" || e.target.id === "extraKcal" || e.target.id === "extraP") { e.preventDefault(); addExtra(); }
    else if (e.target.id === "suppInput") { e.preventDefault(); addSupp(); }
    else if (e.target.id === "cheatInput") { e.preventDefault(); setCheatFromInput(); }
  });
  view.addEventListener("change", (e) => {
    if (e.target.id === "photoCapture" || e.target.id === "photoUpload") addPhotoFromFile(e.target.files && e.target.files[0]);
    if (e.target.id === "importFile") importData(e.target.files && e.target.files[0]);
  });
  view.addEventListener("input", (e) => {
    if (e.target.id === "compareRange") setCompare(e.target.value);
  });
  try { PHOTOS = await photosAll(); } catch { PHOTOS = []; }
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
boot();
