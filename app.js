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

function todayKey(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function getStartDate() {
  return LS.get("pt_startDate", null) || PLAN.meta.startDate;
}
function dayNumber() {
  const start = new Date(getStartDate() + "T00:00:00");
  const now = new Date(todayKey() + "T00:00:00");
  return Math.floor((now - start) / 86400000); // 0-based
}
function position() {
  const dn = dayNumber();
  const week = Math.floor(dn / 7) + 1;
  const weekday = ((new Date().getDay()) + 6) % 7; // Mon=0
  const phase = PLAN.phases.find((p) => week >= p.weekStart && week <= p.weekEnd) || PLAN.phases[PLAN.phases.length - 1];
  const beforeStart = dn < 0;
  const finished = week > PLAN.meta.weeks;
  return { dn, week, weekday, phase, beforeStart, finished };
}

/* ---------- TODAY ---------- */
function renderToday() {
  const pos = position();
  const key = todayKey();
  const checks = LS.get("pt_checks_" + key, { workout: {}, meals: {}, water: 0 });

  if (pos.beforeStart) {
    const days = Math.abs(pos.dn);
    return `<div class="card hero"><span class="phase-tag">Get ready</span>
      <h1>Starts in ${days} day${days === 1 ? "" : "s"}</h1>
      <p>Your 12-week shred begins ${getStartDate()}. Want to start today instead? Go to Settings → Start date.</p></div>`;
  }
  if (pos.finished) {
    return `<div class="card hero celebrate"><div class="big">🏆</div>
      <h1>12 weeks done!</h1><p>You finished the program. Log a final weigh-in on the Progress tab and take some photos — then either reset your start date to run it again, or move to a maintenance phase.</p></div>`;
  }

  const day = pos.phase.schedule[pos.weekday];
  const meal = PLAN.meals[pos.dn % PLAN.meals.length];
  const quote = QUOTES[pos.dn % QUOTES.length];

  // gym vs home variant
  const mode = LS.get("pt_mode", "gym");
  const useHome = mode === "home" && day.homeItems;
  const exercises = useHome ? day.homeItems : day.items;

  // workout checklist
  const workItems = exercises.map((t, i) => {
    const done = checks.workout[i];
    return `<li class="${done ? "done" : ""}" data-act="workout" data-i="${i}">
      <span class="checkbox">${done ? "✓" : ""}</span><span class="item-text">${t}</span></li>`;
  }).join("");

  // meals checklist
  const mealKeys = Object.keys(meal.items);
  const mealItems = mealKeys.map((k, i) => {
    const done = checks.meals[i];
    const m = meal.items[k];
    return `<li class="${done ? "done" : ""}" data-act="meals" data-i="${i}">
      <span class="checkbox">${done ? "✓" : ""}</span>
      <span class="item-text"><span class="meal-label">${k} · ${m.kcal} kcal · ${m.p}g P</span>${m.text}</span></li>`;
  }).join("");

  // water dots (target ~8 glasses)
  const waterDots = Array.from({ length: 8 }, (_, i) =>
    `<div class="water-dot ${i < checks.water ? "filled" : ""}" data-act="water" data-i="${i}">${i < checks.water ? "💧" : ""}</div>`
  ).join("");

  return `
  <div class="card hero">
    <span class="phase-tag">Phase ${pos.phase.id} · ${pos.phase.name}</span>
    <h1>${day.emoji} ${day.name}</h1>
    <p>Week ${pos.week} of 12 · ${day.day}</p>
    <div class="quote">"${quote}"</div>
  </div>

  <div class="card" data-workout-card>
    <div class="work-head">
      <span class="work-emoji">${day.emoji}</span>
      <div><h2 style="margin:0">${day.name}</h2>
      <span class="type-badge type-${day.type}">${day.type.toUpperCase()}</span></div>
    </div>
    ${day.homeItems ? `<div class="mode-toggle">
      <button type="button" class="mode-btn ${!useHome ? "active" : ""}" data-mode="gym" aria-pressed="${!useHome}">🏋️ Gym</button>
      <button type="button" class="mode-btn ${useHome ? "active" : ""}" data-mode="home" aria-pressed="${!!useHome}">🏠 Home</button>
    </div>` : ""}
    <ul class="checklist">${workItems}</ul>
  </div>

  <div class="card">
    <h2>🍽️ Today's Fuel</h2>
    <p class="sub">${meal.name} · tick each meal as you eat it</p>
    <div class="macros">
      <div class="macro"><div class="val">${meal.totals.kcal}</div><div class="lbl">kcal</div></div>
      <div class="macro"><div class="val">${meal.totals.protein}g</div><div class="lbl">protein</div></div>
      <div class="macro"><div class="val">${meal.totals.carbs}g</div><div class="lbl">carbs</div></div>
      <div class="macro"><div class="val">${meal.totals.fat}g</div><div class="lbl">fat</div></div>
    </div>
    <p class="note" style="margin:10px 0 0">🎯 Phase ${pos.phase.id} aim ~${pos.phase.calories} kcal · ${pos.phase.adjust}</p>
    <ul class="checklist">${mealItems}</ul>
  </div>

  <div class="card">
    <h2>💧 Water</h2>
    <p class="sub">Aim for 8 glasses (~2.5 L)</p>
    <div class="water-dots">${waterDots}</div>
  </div>

  <div class="card">
    <h2>⚖️ Quick weigh-in</h2>
    <p class="sub">Best first thing in the morning</p>
    <div class="tracker-row">
      <input class="field" id="quickWeight" type="number" step="0.1" inputmode="decimal" placeholder="kg" style="max-width:140px" />
      <button type="button" class="btn accent" id="logWeightBtn">Log</button>
    </div>
  </div>`;
}

/* ---------- PLAN ---------- */
function renderPlan() {
  let html = `<div class="card hero"><span class="phase-tag">The blueprint</span>
    <h1>12-Week Shred</h1><p>${PLAN.meta.goal}</p>
    <div class="pill-row">${PLAN.meta.dislikes.map(d => `<span class="tag">no ${d}</span>`).join("")}
      <span class="tag">low-impact</span></div>
    ${PLAN.meta.notes ? `<p class="quote" style="font-style:normal;font-size:13px;color:var(--muted)">🦶 ${PLAN.meta.notes}</p>` : ""}</div>`;

  PLAN.phases.forEach((p) => {
    html += `<div class="card">
      <div class="phase-head"><h2>Phase ${p.id}: ${p.name}</h2><small>Weeks ${p.weekStart}–${p.weekEnd}</small></div>
      <p class="sub">${p.tagline}</p>
      <p class="note">${p.focus}</p>
      <div class="macros" style="margin:12px 0">
        <div class="macro"><div class="val">${p.calories}</div><div class="lbl">kcal</div></div>
        <div class="macro"><div class="val">${p.protein}g</div><div class="lbl">protein</div></div>
        <div class="macro"><div class="val">${p.carbs}g</div><div class="lbl">carbs</div></div>
        <div class="macro"><div class="val">${p.fat}g</div><div class="lbl">fat</div></div>
      </div>
      <div class="week-row">
        ${p.schedule.map(d => `<div class="daychip"><div class="d">${d.day.slice(0,3)}</div>
          <div class="e">${d.emoji}</div><div class="n">${d.name}</div></div>`).join("")}
      </div>
    </div>`;
  });

  html += `<div class="card"><h2>🍽️ Meal rotation</h2><p class="sub">${PLAN.meals.length} days, looping · every meal's macros sum to the day total · no fish, beans only in the chilli</p>`;
  PLAN.meals.forEach((m, di) => {
    const t = m.totals;
    html += `<div class="section-label">Day ${di + 1} · ${m.name} — ${t.kcal} kcal · ${t.protein}P / ${t.carbs}C / ${t.fat}F</div>
      <ul class="checklist">${Object.keys(m.items).map(k => {
        const it = m.items[k];
        return `<li style="cursor:default"><span class="item-text"><span class="meal-label">${k} · ${it.kcal} kcal</span>${it.text}</span></li>`;
      }).join("")}</ul>`;
  });
  html += `</div>`;

  html += `<div class="card"><h2>🛒 Shopping list</h2>
    <p class="note">Your tickable list for the current week lives on the <b>Shop</b> tab — it auto-picks the right set (A or B) to match this week's meals.</p></div>`;

  html += `<div class="card"><h2>📋 Golden rules</h2><ul class="note" style="padding-left:18px;line-height:1.8">
    ${PLAN.meta.principles.map(r => `<li>${r}</li>`).join("")}</ul></div>`;
  return html;
}

/* ---------- SHOP ---------- */
function renderShop() {
  const lists = PLAN.shoppingLists || [];
  if (!lists.length) return `<div class="card"><p class="note">No shopping list available.</p></div>`;
  const pos = position();
  const wk = Math.max(1, Math.min(pos.week, PLAN.meta.weeks));
  const idx = (wk - 1) % lists.length;
  const sl = lists[idx];
  const next = lists[(idx + 1) % lists.length];
  const dayFrom = idx * 7 + 1, dayTo = idx * 7 + 7;
  const checks = LS.get("pt_shop_w" + wk, {});

  let total = 0, done = 0;
  sl.categories.forEach((c, ci) => c.items.forEach((_, ii) => { total++; if (checks["c" + ci + "i" + ii]) done++; }));
  const pct = total ? Math.round((done / total) * 100) : 0;

  const cats = sl.categories.map((cat, ci) => `
    <div class="section-label">${cat.name}</div>
    <ul class="checklist">${cat.items.map((it, ii) => {
      const on = checks["c" + ci + "i" + ii];
      return `<li class="${on ? "done" : ""}" data-act="shop" data-k="c${ci}i${ii}">
        <span class="checkbox" style="border-radius:6px">${on ? "✓" : ""}</span>
        <span class="item-text">${it}</span></li>`;
    }).join("")}</ul>`).join("");

  return `
  <div class="card hero">
    <span class="phase-tag">Week ${wk} · Set ${sl.week}</span>
    <h1>🛒 This week's shop</h1>
    <p>${sl.note}</p>
    <div class="progress-track" style="margin-top:12px"><div class="progress-fill" style="width:${pct}%"></div></div>
    <p class="quote" style="font-style:normal;font-size:13px;color:var(--muted)">${done} of ${total} ticked off${(done === total && total) ? " — all done! 🎉" : ""}</p>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0">Set ${sl.week} · days ${dayFrom}–${dayTo}</h2>
      <button type="button" class="btn" id="resetShopBtn" style="min-height:auto;padding:7px 12px">Reset</button>
    </div>
    ${cats}
  </div>

  <div class="card">
    <h2>⏭️ Next week — Set ${next.week}</h2>
    <p class="sub">A peek so you can plan ahead</p>
    ${next.categories.map(cat =>
      `<div class="section-label">${cat.name}</div>
       <ul class="checklist">${cat.items.map(i =>
        `<li style="cursor:default"><span class="checkbox" style="border-radius:6px"></span><span class="item-text">${i}</span></li>`).join("")}</ul>`).join("")}
  </div>`;
}

/* ---------- PROGRESS ---------- */
function renderProgress() {
  const weights = LS.get("pt_weights", []);
  const pos = position();
  const start = PLAN.meta.stats.weightKg;
  const latest = weights.length ? weights[weights.length - 1].kg : start;
  const lost = (start - latest).toFixed(1);

  // streak: count back consecutive days with any completion
  let streak = 0;
  for (let i = 0; i < 120; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const c = LS.get("pt_checks_" + todayKey(d), null);
    const any = c && (Object.values(c.workout || {}).some(Boolean) || Object.values(c.meals || {}).some(Boolean) || c.water > 0);
    if (any) streak++; else if (i > 0) break;
  }

  // completion across elapsed days
  let workoutsDone = 0;
  for (let i = 0; i <= Math.max(0, pos.dn); i++) {
    const d = new Date(getStartDate() + "T00:00:00"); d.setDate(d.getDate() + i);
    const c = LS.get("pt_checks_" + todayKey(d), null);
    if (c && Object.values(c.workout || {}).some(Boolean)) workoutsDone++;
  }

  const chart = weights.length >= 2 ? sparkline(weights.map(w => w.kg)) : `<p class="note">Log a few weigh-ins and your trend line appears here.</p>`;

  return `
  <div class="card hero"><span class="phase-tag">Your numbers</span><h1>Progress</h1>
    <p>Down <b style="color:var(--accent)">${lost} kg</b> since you started.</p></div>
  <div class="card"><div class="stat-grid">
    <div class="stat"><div class="big">${Math.max(0, pos.dn + (pos.beforeStart?0:1))}</div><div class="cap">days in</div></div>
    <div class="stat"><div class="big">🔥 ${streak}</div><div class="cap">day streak</div></div>
    <div class="stat"><div class="big">${workoutsDone}</div><div class="cap">workouts logged</div></div>
    <div class="stat"><div class="big">${latest}kg</div><div class="cap">latest weight</div></div>
  </div></div>
  <div class="card"><h2>⚖️ Weight trend</h2>${chart}
    <ul class="weight-list">${weights.slice().reverse().slice(0, 8).map(w =>
      `<li><span>${w.kg} kg</span><span>${w.date}</span></li>`).join("")}</ul>
    <div class="tracker-row" style="margin-top:12px">
      <input class="field" id="quickWeight" type="number" step="0.1" inputmode="decimal" placeholder="kg" style="max-width:140px" />
      <button type="button" class="btn accent" id="logWeightBtn">Log weigh-in</button>
    </div>
  </div>`;
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

/* ---------- SETTINGS ---------- */
function renderSettings() {
  return `
  <div class="card"><h2>⚙️ Settings</h2>
    <label class="field-label">Program start date</label>
    <input class="field" id="startDateInput" type="date" value="${getStartDate()}" />
    <button type="button" class="btn accent block" id="saveStartBtn" style="margin-top:10px">Save start date</button>
    <p class="note" style="margin-top:8px">Set this to the Monday you want week 1 to begin (or today to start now).</p>
  </div>

  <div class="card"><h2>📲 Daily reminders on Telegram</h2>
    <p class="note">A free GitHub Action sends you the day's workout + meals every morning. To switch it on:</p>
    <ol class="note" style="padding-left:18px;line-height:1.9">
      <li>In Telegram, message <code>@BotFather</code> → <code>/newbot</code> → copy the <b>token</b>.</li>
      <li>Message <code>@userinfobot</code> to get your <b>chat id</b>.</li>
      <li>In your GitHub repo → <b>Settings → Secrets → Actions</b>, add
        <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code>.</li>
      <li>That's it — you'll get a ping every morning at 7am.</li>
    </ol>
    <p class="note">Full instructions are in the repo's <code>README.md</code>.</p>
  </div>

  <div class="card"><h2>🗑️ Reset</h2>
    <button type="button" class="btn block" id="resetBtn">Clear all my data on this device</button>
    <p class="note" style="margin-top:8px">Removes check-ins, weigh-ins and start date from this phone only.</p>
  </div>

  <div class="card"><h2>🎯 Your numbers</h2>
    <p class="note">${PLAN.meta.athlete} · ${PLAN.meta.stats.age}y · ${PLAN.meta.stats.weightKg}kg / ${PLAN.meta.stats.heightCm}cm${PLAN.meta.maintenance ? ` · est. maintenance <b>~${PLAN.meta.maintenance.toLocaleString()} kcal</b>` : ""}.</p>
    ${PLAN.meta.calcNote ? `<p class="note" style="margin-top:6px">${PLAN.meta.calcNote}</p>` : ""}
  </div>

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
  card.querySelector("ul.checklist").innerHTML = exercises.map((t, i) => {
    const done = checks.workout[i];
    return `<li class="${done ? "done" : ""}" data-act="workout" data-i="${i}">
      <span class="checkbox">${done ? "✓" : ""}</span><span class="item-text">${t}</span></li>`;
  }).join("");
  card.querySelectorAll(".mode-btn").forEach((b) => {
    const on = (b.dataset.mode === "home") === useHome;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
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

  const li = e.target.closest("[data-act]");
  if (li && li.dataset.act === "shop") { haptic(8); toggleShop(li); return; }
  if (li) {
    const act = li.dataset.act, i = parseInt(li.dataset.i, 10);
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
      li.classList.toggle("done", on);    // surgical — no re-render, no scroll jump
      const cb = li.querySelector(".checkbox");
      if (cb) cb.textContent = on ? "✓" : "";
    }
    return;
  }
  if (e.target.id === "logWeightBtn") return logWeight();
  if (e.target.id === "saveStartBtn") {
    LS.set("pt_startDate", document.getElementById("startDateInput").value);
    CURRENT_TAB = "today"; setActiveTab(); navigate(); return;
  }
  if (e.target.id === "resetShopBtn") {
    LS.set("pt_shop_w" + Math.max(1, Math.min(position().week, PLAN.meta.weeks)), {});
    repaintKeepScroll(); return;
  }
  if (e.target.id === "resetBtn") {
    if (confirm("Clear all saved data on this device?")) {
      Object.keys(localStorage).filter(k => k.startsWith("pt_")).forEach(k => localStorage.removeItem(k));
      repaintKeepScroll();
    }
  }
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
  const hero = document.querySelector(".progress-fill");
  // refresh the little progress count without a full re-render
  const items = document.querySelectorAll('[data-act="shop"]');
  const done = document.querySelectorAll('[data-act="shop"].done').length;
  if (hero) hero.style.width = Math.round((done / items.length) * 100) + "%";
  const cnt = document.querySelector(".hero .quote");
  if (cnt) cnt.textContent = `${done} of ${items.length} ticked off${done === items.length ? " — all done! 🎉" : ""}`;
}

function updateWater(n) {
  const wrap = document.querySelector(".water-dots");
  if (!wrap) return;
  wrap.querySelectorAll(".water-dot").forEach((d, i) => {
    const filled = i < n;
    d.classList.toggle("filled", filled);
    d.textContent = filled ? "💧" : "";
  });
}

/* ---------- shell ---------- */
// render() repaints the current tab WITHOUT moving the scroll position.
function render() {
  const view = document.getElementById("view");
  if (CURRENT_TAB === "today") view.innerHTML = renderToday();
  else if (CURRENT_TAB === "plan") view.innerHTML = renderPlan();
  else if (CURRENT_TAB === "shop") view.innerHTML = renderShop();
  else if (CURRENT_TAB === "progress") view.innerHTML = renderProgress();
  else view.innerHTML = renderSettings();

  // header
  const pos = position();
  document.getElementById("phaseName").textContent =
    pos.beforeStart ? "Not started" : pos.finished ? "Complete 🏆" : `Phase ${pos.phase.id} · ${pos.phase.name}`;
  document.getElementById("dayPill").textContent =
    pos.beforeStart ? "Soon" : pos.finished ? "Done" : `Day ${pos.dn + 1} · Wk ${pos.week}`;
  const pct = Math.max(0, Math.min(100, ((pos.dn + 1) / (PLAN.meta.weeks * 7)) * 100));
  document.getElementById("overallProgress").style.width = pct + "%";
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
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
    if (CURRENT_TAB === t.dataset.tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    CURRENT_TAB = t.dataset.tab; setActiveTab(); navigate();
  }));
  const view = document.getElementById("view");
  view.addEventListener("click", onViewClick);
  view.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "quickWeight") { e.preventDefault(); logWeight(); }
  });
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
boot();
