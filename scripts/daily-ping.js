#!/usr/bin/env node
/* Sends today's workout + meals to Telegram. Run daily by GitHub Actions.
 * Requires env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 * Optional env: PT_START_DATE (YYYY-MM-DD), APP_URL (link back to the web app). */

const fs = require("fs");
const path = require("path");

const PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "plan.json"), "utf8"));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const START = process.env.PT_START_DATE || PLAN.meta.startDate;
const APP_URL = process.env.APP_URL || "";
const MODE = (process.env.PT_MODE || "gym").toLowerCase(); // "gym" or "home"

if (!TOKEN || !CHAT) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — skipping. Add them as repo secrets.");
  process.exit(0); // don't fail the workflow; just no-op
}

function midnight(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
const start = midnight(new Date(START + "T00:00:00"));
const now = midnight(new Date());
const dn = Math.floor((now - start) / 86400000); // 0-based
const week = Math.floor(dn / 7) + 1;
const weekday = (now.getDay() + 6) % 7; // Mon=0

function esc(s) { return String(s).replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

let text;
if (dn < 0) {
  text = `🏁 <b>Your 12-week shred starts in ${Math.abs(dn)} day(s)</b>\nGet your kit ready — first session on ${START}.`;
} else if (week > PLAN.meta.weeks) {
  text = `🏆 <b>12 weeks complete!</b>\nIncredible work, ${esc(PLAN.meta.athlete)}. Time for a final weigh-in and some photos. Reset your start date to run it again or move to maintenance.`;
} else {
  const phase = PLAN.phases.find((p) => week >= p.weekStart && week <= p.weekEnd) || PLAN.phases.at(-1);
  const day = phase.schedule[weekday];
  const meal = PLAN.meals[((dn % PLAN.meals.length) + PLAN.meals.length) % PLAN.meals.length];
  const quotes = [
    "Discipline beats motivation. Show up.",
    "You don't have to be extreme, just consistent.",
    "Small wins, every single day.",
    "Sweat now, shine later.",
    "Abs are built in the kitchen and earned in the gym.",
  ];
  const quote = quotes[dn % quotes.length];

  const exercises = (MODE === "home" && day.homeItems) ? day.homeItems : day.items;
  const modeTag = (MODE === "home" && day.homeItems) ? " 🏠 home" : "";
  const workout = exercises.map((i) => `• ${esc(i)}`).join("\n");
  const t = meal.totals;
  const meals = Object.entries(meal.items)
    .map(([k, v]) => `<b>${esc(k)}</b> (${v.kcal} kcal): ${esc(v.text)}`).join("\n");

  // tomorrow's prep-ahead heads-up (explicit prep + auto defrost for meat dinners)
  const tmrw = PLAN.meals[((dn + 1) % PLAN.meals.length + PLAN.meals.length) % PLAN.meals.length];
  const prepPairs = Object.entries(tmrw.items).filter(([, v]) => v.prep).map(([k, v]) => [k, v.prep]);
  const dinner = tmrw.items.Dinner;
  if (dinner && !dinner.prep) {
    const meat = /chicken|beef|pork|turkey|sausage|mince|lamb|gammon|ham/i.exec(dinner.text);
    if (meat) prepPairs.push(["Dinner", `Take the ${meat[0].toLowerCase()} out to defrost tonight if it's frozen.`]);
  }
  const prep = prepPairs.map(([k, v]) => `🌙 <b>${esc(k)}:</b> ${esc(v)}`).join("\n");
  const prepBlock = prep ? `\n\n🌙 <b>Prep tonight for tomorrow (${esc(tmrw.name)})</b>\n${prep}` : "";

  // quick preview of tomorrow's activity
  const tWeek = Math.floor((dn + 1) / 7) + 1;
  let tomorrowLine = "";
  if (tWeek <= PLAN.meta.weeks) {
    const tDate = new Date(now); tDate.setDate(tDate.getDate() + 1);
    const tWd = (tDate.getDay() + 6) % 7;
    const tPh = PLAN.phases.find((p) => tWeek >= p.weekStart && tWeek <= p.weekEnd) || PLAN.phases.at(-1);
    const tD = tPh.schedule[tWd];
    tomorrowLine = `\n\n🔜 <b>Tomorrow:</b> ${tD.emoji} ${esc(tD.name)} (${tD.type})`;
  }

  text =
    `${day.emoji} <b>Day ${dn + 1} · Week ${week}/12 — ${esc(phase.name)}</b>\n` +
    `<i>${esc(quote)}</i>\n\n` +
    `<b>${day.emoji} ${esc(day.name)}</b> (${day.type}${modeTag})\n${workout}\n\n` +
    `🍽 <b>Fuel — ${esc(meal.name)}</b>\n` +
    `📊 ${t.kcal} kcal · ${t.protein}g P · ${t.carbs}g C · ${t.fat}g F\n` +
    `🎯 Phase ${phase.id} aim ~${phase.calories} kcal — ${esc(phase.adjust)}\n${meals}\n\n` +
    `💧 8 glasses of water · 🚶 hit your steps` + prepBlock + tomorrowLine +
    (APP_URL ? `\n\n📲 Tick it all off: ${APP_URL}` : "");
}

const payload = JSON.stringify({
  chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true,
});

fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: payload,
}).then(async (r) => {
  const body = await r.text();
  if (!r.ok) { console.error("Telegram error", r.status, body); process.exit(1); }
  console.log("Sent daily ping for day", dn + 1);
}).catch((e) => { console.error("Request failed", e); process.exit(1); });
