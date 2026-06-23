#!/usr/bin/env node
/* Sends the week's shopping list to Telegram. Run every Sunday by GitHub Actions
 * (and on demand via "Run workflow").
 * Requires env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 * Optional env: PT_START_DATE (YYYY-MM-DD) for the "week N" header. */

const fs = require("fs");
const path = require("path");

const PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "plan.json"), "utf8"));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const START = process.env.PT_START_DATE || PLAN.meta.startDate;

if (!TOKEN || !CHAT) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — skipping. Add them as repo secrets.");
  process.exit(0);
}

function esc(s) { return String(s).replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
function midnight(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

// Which week is the *upcoming* one? Sunday's shop is for the week that starts tomorrow.
const dn = Math.floor((midnight(new Date()) - midnight(new Date(START + "T00:00:00"))) / 86400000);
const upcomingWeek = Math.floor((dn + 1) / 7) + 1;
// 14-day meal rotation = 2 weeks of food, so the shopping list alternates A / B.
const lists = PLAN.shoppingLists || [];
const sl = lists[(Math.max(1, upcomingWeek) - 1) % lists.length] || lists[0];

let header;
if (dn < -1) header = `🛒 <b>Shopping list — Week 1 prep (set ${sl.week})</b>`;
else if (upcomingWeek > PLAN.meta.weeks) header = "🛒 <b>Shopping list</b>\n🏆 Final week — finish strong!";
else header = `🛒 <b>Shopping list — week ${upcomingWeek} of ${PLAN.meta.weeks} (set ${sl.week})</b>`;

const body = sl.categories.map((cat) =>
  `\n<b>${esc(cat.name)}</b>\n` + cat.items.map((i) => `☐ ${esc(i)}`).join("\n")
).join("\n");

const text = `${header}\n<i>${esc(sl.note)}</i>\n${body}\n\n📲 Full plan: https://benwatson2000.github.io/personal-trainer/`;

fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
}).then(async (r) => {
  const out = await r.text();
  if (!r.ok) { console.error("Telegram error", r.status, out); process.exit(1); }
  console.log("Sent shopping list for week", upcomingWeek);
}).catch((e) => { console.error("Request failed", e); process.exit(1); });
