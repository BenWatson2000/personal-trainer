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

// reveal day = the morning after the final day of week 12
function revealInfo() {
  const start = new Date(getStartDate() + "T00:00:00");
  const end = new Date(start); end.setDate(end.getDate() + PLAN.meta.weeks * 7);
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
// auto-suggested goal: projected end if trending down, else a ~9% cut; floored at BMI ~20
function suggestedGoal() {
  const start = PLAN.meta.stats.weightKg;
  const floor = Math.round(20 * Math.pow(PLAN.meta.stats.heightCm / 100, 2));
  const proj = projectAtEnd();
  const g = (proj != null && proj < start) ? proj : Math.round(start * 0.91);
  return Math.max(floor, Math.round(g));
}
function recipeBlock(meal) {
  const d = meal.items.Dinner; if (!d || !d.recipe) return "";
  const r = d.recipe, title = d.text.split(" — ")[0];
  return `<details class="recipe"><summary>📖 Tonight's recipe — ${title}</summary>
    <div class="recipe-body">
      <div class="section-label">Ingredients</div>
      <ul class="recipe-ing">${r.ingredients.map(x => `<li>${x}</li>`).join("")}</ul>
      <div class="section-label">Method</div>
      <ol class="recipe-steps">${r.steps.map(x => `<li>${x}</li>`).join("")}</ol>
    </div></details>`;
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
  const baseIdx = pos.dn % PLAN.meals.length;
  const swapIdx = LS.get("pt_swap_" + key, null);
  const mealIdx = (swapIdx != null && swapIdx >= 0 && swapIdx < PLAN.meals.length) ? swapIdx : baseIdx;
  const swapped = mealIdx !== baseIdx;
  const meal = PLAN.meals[mealIdx];
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

  // time-aware greeting + date
  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const dateStr = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  // today at a glance
  const wDone = exercises.filter((_, i) => checks.workout[i]).length;
  const mDone = mealKeys.filter((_, i) => checks.meals[i]).length;
  const chips = `<div class="today-chips">
    <span class="chip ${wDone === exercises.length ? "on" : ""}">${day.type === "rest" ? "😴" : "🏋️"} ${wDone}/${exercises.length}</span>
    <span class="chip ${mDone === mealKeys.length ? "on" : ""}">🍽️ ${mDone}/${mealKeys.length}</span>
    <span class="chip ${checks.water >= 8 ? "on" : ""}">💧 ${checks.water}/8</span>
  </div>`;

  // tomorrow preview — activity + food (respects the current Gym/Home mode)
  const tDate = new Date(); tDate.setDate(tDate.getDate() + 1);
  const tWeekday = (tDate.getDay() + 6) % 7;
  const tWeek = Math.floor((pos.dn + 1) / 7) + 1;
  const tDayName = tDate.toLocaleDateString("en-GB", { weekday: "long" });
  const tmrw = PLAN.meals[(pos.dn + 1) % PLAN.meals.length];
  const tmrwPrep = prepNotes(tmrw);
  const prepLines = tmrwPrep.map(([k, v]) => `<div class="prep-line">🌙 <b>${k}:</b> ${v}</div>`).join("");

  let activityHtml;
  if (tWeek > PLAN.meta.weeks) {
    activityHtml = `<div class="tmrw-head">🏁 <b>That's your 12 weeks done!</b></div>`;
  } else {
    const tPhase = PLAN.phases.find(p => tWeek >= p.weekStart && tWeek <= p.weekEnd) || PLAN.phases[PLAN.phases.length - 1];
    const tDay = tPhase.schedule[tWeekday];
    const tEx = (mode === "home" && tDay.homeItems) ? tDay.homeItems : tDay.items;
    activityHtml = `<div class="tmrw-head"><span class="work-emoji" style="font-size:20px">${tDay.emoji}</span>
        <b>${tDay.name}</b> <span class="type-badge type-${tDay.type}">${tDay.type.toUpperCase()}</span></div>
      <ul class="checklist preview">${tEx.map(t => `<li><span class="bullet">•</span><span class="item-text">${t}</span></li>`).join("")}</ul>`;
  }

  const tomorrowCard = `<div class="card ${prepLines ? "tomorrow-prep" : ""}">
    <h2>🌙 Tomorrow · ${tDayName}</h2>
    <div class="section-label">🏋️ Activity</div>
    ${activityHtml}
    <div class="section-label" style="margin-top:14px">🍽️ Food — ${tmrw.name} (${tmrw.totals.kcal} kcal)</div>
    ${prepLines
      ? `<p class="sub" style="margin:2px 0 0">Sort this tonight so you're ready:</p>${prepLines}`
      : `<p class="note">Nothing to prep ahead. Dinner: ${tmrw.items.Dinner.text}</p>`}
  </div>`;

  // perfect day = workout + every meal + 8 water
  const perfect = wDone === exercises.length && mDone === mealKeys.length && checks.water >= 8;
  const perfectBanner = perfect ? `<div class="card hero perfect">
    <div class="confetti">${"🎉".repeat(1)}</div>
    <h1>🎉 Perfect day!</h1>
    <p>Workout done, every meal ticked, fully hydrated. This is exactly how 12 weeks of progress get built.</p>
  </div>` : "";

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

  // meal swap picker
  const swapPicker = `<details class="swap"><summary>🔀 ${swapped ? "Swapped — change or reset" : "Not feeling it? Swap today's meal"}</summary>
    <div class="swap-list">
      ${swapped ? `<button type="button" class="swap-opt reset" data-act="swap" data-i="${baseIdx}">↩︎ Reset to today's default (Day ${baseIdx + 1})</button>` : ""}
      ${PLAN.meals.map((m, i) => `<button type="button" class="swap-opt ${i === mealIdx ? "cur" : ""}" data-act="swap" data-i="${i}">
        <span>Day ${i + 1} · ${m.name}</span><span class="swap-kcal">${m.totals.kcal} kcal</span></button>`).join("")}
    </div></details>`;

  // reveal-day countdown
  const rv = revealInfo();
  const proj = projectAtEnd();
  const revealCard = `<div class="card reveal">
    <div class="reveal-num">${Math.max(0, rv.daysLeft)}</div>
    <div class="reveal-txt"><b>days to Reveal Day</b><br><span class="sub">${rv.endStr}${proj != null ? ` · on pace for ~${proj} kg` : ""}</span></div>
  </div>`;

  return `
  ${perfectBanner}
  <div class="card hero">
    <span class="phase-tag">Phase ${pos.phase.id} · ${pos.phase.name}</span>
    <p class="greet">${greet}, ${PLAN.meta.athlete} · ${dateStr}</p>
    <h1>${day.emoji} ${day.name}</h1>
    <p>Week ${pos.week} of 12 · Day ${pos.dn + 1}</p>
    ${chips}
    <div class="quote">"${quote}"</div>
  </div>

  ${revealCard}

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
    ${restTimer}
  </div>

  <div class="card">
    <h2>🍽️ Today's Fuel${swapped ? ' <span class="swap-tag">swapped</span>' : ""}</h2>
    <p class="sub">${meal.name} · tick each meal as you eat it</p>
    <div class="macros">
      <div class="macro"><div class="val">${meal.totals.kcal}</div><div class="lbl">kcal</div></div>
      <div class="macro"><div class="val">${meal.totals.protein}g</div><div class="lbl">protein</div></div>
      <div class="macro"><div class="val">${meal.totals.carbs}g</div><div class="lbl">carbs</div></div>
      <div class="macro"><div class="val">${meal.totals.fat}g</div><div class="lbl">fat</div></div>
    </div>
    <p class="note" style="margin:10px 0 0">🎯 Phase ${pos.phase.id} aim ~${pos.phase.calories} kcal · ${pos.phase.adjust}</p>
    <ul class="checklist">${mealItems}</ul>
    ${recipeBlock(meal)}
    ${swapPicker}
  </div>

  ${tomorrowCard}

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
      }).join("")}</ul>${recipeBlock(m)}`;
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

  // custom user-added items for this week
  const custom = LS.get("pt_shopcustom_w" + wk, []);
  const customList = custom.length ? `<div class="section-label">➕ My extras</div>
    <ul class="checklist">${custom.map((it, ii) => {
      const on = checks["x" + ii];
      return `<li class="${on ? "done" : ""}" data-act="shop" data-k="x${ii}">
        <span class="checkbox" style="border-radius:6px">${on ? "✓" : ""}</span>
        <span class="item-text">${it}</span>
        <button type="button" class="x-del" data-act="delcustom" data-i="${ii}">✕</button></li>`;
    }).join("")}</ul>` : "";

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
    ${customList}
    <div class="tracker-row" style="margin-top:14px">
      <input class="field" id="customItem" placeholder="Add your own item…" />
      <button type="button" class="btn accent" id="addCustomBtn">Add</button>
    </div>
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
  const lost = +(start - latest).toFixed(1);

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
  const chart = weights.length >= 2 ? sparkline(weights.map(w => w.kg)) : `<p class="note">Log a few weigh-ins and your trend line appears here.</p>`;

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
    const span = (start - goal) || 1;
    const gp = Math.max(0, Math.min(100, Math.round(((start - latest) / span) * 100)));
    let proj = `<p class="note">Log a couple of weigh-ins trending down and I'll project your finish date.</p>`;
    if (weights.length >= 2) {
      const first = weights[0], last = weights[weights.length - 1];
      const days = (new Date(last.date) - new Date(first.date)) / 86400000;
      const ratePerWeek = days > 0 ? (last.kg - first.kg) / (days / 7) : 0;
      if (latest <= goal) proj = `<p class="note" style="color:var(--accent)">🎉 Goal reached — ${latest} kg. Time to set a new one or move to maintenance.</p>`;
      else if (ratePerWeek < -0.05) {
        const weeksLeft = (goal - latest) / ratePerWeek;
        const eta = new Date(Date.now() + weeksLeft * 7 * 86400000);
        const etaStr = weeksLeft > 52 ? "over a year out at this pace" :
          "around " + eta.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        proj = `<p class="note">📉 Losing <b>${Math.abs(ratePerWeek).toFixed(2)} kg/week</b> → goal of <b>${goal} kg</b> ${etaStr} (~${Math.max(1, Math.round(weeksLeft))} wk).</p>`;
      } else proj = `<p class="note">Your trend is flat or up — tighten the deficit a touch (see Phase aim) to start moving toward ${goal} kg.</p>`;
    }
    goalCard = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">🎯 Goal: ${goal} kg</h2>
        <button type="button" class="btn" id="clearGoalBtn" style="min-height:auto;padding:7px 12px">Change</button></div>
      <div class="progress-track" style="margin:12px 0 6px"><div class="progress-fill" style="width:${gp}%"></div></div>
      <p class="sub">${start} kg → ${goal} kg · ${gp}% there (${lost >= 0 ? "-" : "+"}${Math.abs(lost)} kg so far)</p>
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
    ["⚖️", "Down 1 kg", lost >= 1],
    ["📉", "Down 3 kg", lost >= 3],
    ["🥇", "Down 5 kg", lost >= 5],
    ["🗓️", "Halfway", daysIn >= 42],
    ["🎓", "Finisher", daysIn >= 84],
  ];
  const earned = A.filter(a => a[2]).length;
  const badges = A.map(([e, label, on]) =>
    `<div class="badge ${on ? "earned" : ""}"><div class="badge-e">${e}</div><div class="badge-l">${label}</div></div>`).join("");

  return `
  <div class="card hero"><span class="phase-tag">Your numbers</span><h1>Progress</h1>
    <p>Down <b style="color:var(--accent)">${lost} kg</b> since you started.</p></div>
  <div class="card"><div class="stat-grid">
    <div class="stat"><div class="big">${daysIn}</div><div class="cap">days in</div></div>
    <div class="stat"><div class="big">🔥 ${streak}</div><div class="cap">day streak</div></div>
    <div class="stat"><div class="big">${workoutsDone}</div><div class="cap">workouts logged</div></div>
    <div class="stat"><div class="big">✨ ${perfectDays}</div><div class="cap">perfect days</div></div>
  </div></div>

  ${goalCard}

  <div class="card"><h2>⚖️ Weight trend</h2>${chart}
    <ul class="weight-list">${weights.slice().reverse().slice(0, 8).map(w =>
      `<li><span>${w.kg} kg</span><span>${w.date}</span></li>`).join("")}</ul>
    <div class="tracker-row" style="margin-top:12px">
      <input class="field" id="quickWeight" type="number" step="0.1" inputmode="decimal" placeholder="kg" style="max-width:140px" />
      <button type="button" class="btn accent" id="logWeightBtn">Log weigh-in</button>
    </div>
  </div>

  <div class="card"><h2>🏅 Achievements <small style="color:var(--muted);font-weight:600">${earned}/${A.length}</small></h2>
    <div class="badge-grid">${badges}</div>
  </div>

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
    `<div class="photo-thumb"><img src="${p.data}" alt="${p.date}" />
      <span class="photo-date">${p.date.slice(5)}</span>
      <button type="button" class="photo-del" data-act="delphoto" data-date="${p.date}">✕</button></div>`).join("");

  return `<div class="card"><h2>📸 Progress photos</h2>
    <p class="sub">Stored only on this device · the scale lies, photos don't</p>
    ${has ? `<div class="photo-grid" id="photoStage">${thumbs}</div>` : `<p class="note">Add a photo each week to build your transformation.</p>`}
    ${compare}
    <div class="tracker-row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
      <label class="btn accent" for="photoInput" style="cursor:pointer">📷 Add photo</label>
      <input id="photoInput" type="file" accept="image/*" capture="environment" style="display:none" />
      ${PHOTOS.length >= 2 ? `<button type="button" class="btn" id="playTimelapse">▶ Play timelapse</button>` : ""}
    </div>
    <img id="timelapseStage" class="timelapse-stage" style="display:none" />
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

  const restBtn = e.target.closest("[data-rest]");
  if (restBtn) { startRest(+restBtn.dataset.rest); return; }

  const tagged = e.target.closest("[data-act]");
  if (tagged && tagged.dataset.act === "swap") { haptic(6); swapMeal(+tagged.dataset.i); return; }
  if (tagged && tagged.dataset.act === "delcustom") { haptic(6); delCustom(+tagged.dataset.i); return; }
  if (tagged && tagged.dataset.act === "delphoto") { haptic(6); delPhoto(tagged.dataset.date); return; }
  if (tagged && tagged.dataset.act === "shop") { haptic(8); toggleShop(tagged); return; }
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
  if (e.target.id === "addCustomBtn") return addCustom();
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
    if (confirm("Clear all saved data on this device?")) {
      Object.keys(localStorage).filter(k => k.startsWith("pt_")).forEach(k => localStorage.removeItem(k));
      repaintKeepScroll();
    }
  }
}

/* ---------- new feature handlers ---------- */
function swapMeal(i) {
  const key = todayKey();
  const base = position().dn % PLAN.meals.length;
  if (i === base) localStorage.removeItem("pt_swap_" + key); else LS.set("pt_swap_" + key, i);
  repaintKeepScroll();
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
/* ---------- progress photos ---------- */
function addPhotoFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      // downscale to max 800px long edge, JPEG ~0.7, to keep storage sane
      const max = 800, scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      const data = cv.toDataURL("image/jpeg", 0.7);
      await photoPut({ date: todayKey(), data });
      PHOTOS = await photosAll();
      haptic(8); repaintKeepScroll();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
async function delPhoto(date) {
  if (!confirm("Delete this photo?")) return;
  await photoDel(date); PHOTOS = await photosAll(); repaintKeepScroll();
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
  const baseIdx = pos.dn % PLAN.meals.length, sw = LS.get("pt_swap_" + key, null);
  const mealIdx = (sw != null && sw >= 0 && sw < PLAN.meals.length) ? sw : baseIdx;
  const mKeys = Object.keys(PLAN.meals[mealIdx].items);
  const wDone = ex.filter((_, i) => c.workout[i]).length;
  const mDone = mKeys.filter((_, i) => c.meals[i]).length;
  const chips = document.querySelectorAll(".today-chips .chip");
  if (chips.length === 3) {
    chips[0].classList.toggle("on", wDone === ex.length); chips[0].textContent = `${day.type === "rest" ? "😴" : "🏋️"} ${wDone}/${ex.length}`;
    chips[1].classList.toggle("on", mDone === mKeys.length); chips[1].textContent = `🍽️ ${mDone}/${mKeys.length}`;
    chips[2].classList.toggle("on", c.water >= 8); chips[2].textContent = `💧 ${c.water}/8`;
  }
}
function isTodayPerfect() {
  const pos = position(); if (pos.beforeStart || pos.finished) return false;
  const day = pos.phase.schedule[pos.weekday];
  const ex = (LS.get("pt_mode", "gym") === "home" && day.homeItems) ? day.homeItems : day.items;
  const key = todayKey(); const c = LS.get("pt_checks_" + key, { workout: {}, meals: {}, water: 0 });
  const baseIdx = pos.dn % PLAN.meals.length, sw = LS.get("pt_swap_" + key, null);
  const mealIdx = (sw != null && sw >= 0 && sw < PLAN.meals.length) ? sw : baseIdx;
  const mKeys = Object.keys(PLAN.meals[mealIdx].items);
  const wDone = ex.filter((_, i) => c.workout[i]).length;
  const mDone = mKeys.filter((_, i) => c.meals[i]).length;
  return wDone === ex.length && mDone === mKeys.length && c.water >= 8;
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
  clearInterval(REST_INT); clearInterval(TL_INT); // a repaint replaces those elements
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
    if (e.key !== "Enter") return;
    if (e.target.id === "quickWeight") { e.preventDefault(); logWeight(); }
    else if (e.target.id === "goalWeight") { e.preventDefault(); saveGoal(); }
    else if (e.target.id === "customItem") { e.preventDefault(); addCustom(); }
  });
  view.addEventListener("change", (e) => {
    if (e.target.id === "photoInput") addPhotoFromFile(e.target.files && e.target.files[0]);
  });
  view.addEventListener("input", (e) => {
    if (e.target.id === "compareRange") setCompare(e.target.value);
  });
  try { PHOTOS = await photosAll(); } catch { PHOTOS = []; }
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
boot();
