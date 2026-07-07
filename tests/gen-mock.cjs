// Generates tests/mock-data.json — a My PT backup file (Settings → Restore format)
// with 15 days of realistic history. The UI audit freezes the in-page clock to
// 2026-07-06T18:00 (Mon, Day 15, Wk 3, strength day) so this data is deterministic.
const fs = require("fs");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ls = {};
const S = (k, v) => ls[k] = JSON.stringify(v);
S("pt_profile", { name: "Ben", sex: "male", age: 25, heightCm: 156, weightKg: 68, activity: 1.466, goal: "cut", surplus: 300, dislikes: ["fish"] });
S("pt_startDate", "2026-06-22");
S("pt_lastlvl", 3);
S("pt_weights", [{ date: "2026-06-22", kg: 68 }, { date: "2026-06-26", kg: 67.7 }, { date: "2026-06-29", kg: 67.4 }, { date: "2026-07-04", kg: 67.1 }]);
for (let i = 0; i < 14; i++) {
  const d = new Date("2026-06-22T12:00:00"); d.setDate(d.getDate() + i);
  const k = d.toISOString().slice(0, 10);
  S("pt_checks_" + k, { workout: { 0: true, 1: true }, meals: { 0: true, 1: true, 2: true }, water: i % 2 ? 8 : 4 });
}
S("pt_checks_2026-07-06", { workout: { 0: true }, meals: { 0: true }, water: 3 }); // today, partial
S("pt_ready_2026-07-05", { s: 3, m: 2, e: 3 });
S("pt_lift_2026-06-29", { "Goblet squat": [{ w: 20, r: 10 }, { w: 20, r: 10 }, { w: 20, r: 10 }] });
S("pt_meas", [{ date: "2026-06-22", waist: 78, arm: 32 }, { date: "2026-07-04", waist: 77.2, arm: 32.3 }]);
S("pt_staples", ["Coffee"]);
S("pt_shopcustom_w3", ["Foil"]);
S("pt_dietbreaks", [6]);
S("pt_cheat_2026-07-05", 300);
S("pt_extra_2026-07-06", [{ name: "Latte", kcal: 150, p: 8 }]);
S("pt_supps", ["Whey protein", "Creatine 5g", "Vitamin D"]);
const photos = [
  { date: "2026-06-24", data: PNG, kg: 67.8, wm: true },
  { date: "2026-07-01", data: PNG, kg: 67.3, wm: true },
];
fs.writeFileSync(__dirname + "/mock-data.json", JSON.stringify({ v: 1, exported: "2026-07-06T18:00:00Z", ls, photos }));
console.log("mock-data.json written:", Object.keys(ls).length, "keys,", photos.length, "photos");
