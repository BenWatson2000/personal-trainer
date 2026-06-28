# 🏋️ Ben's PT — 12-Week Shred

Your own personal trainer in your pocket: a free, installable web app, hosted on
GitHub Pages for **£0**. No account, no tracking — everything lives on your device.

- **Goal:** get ripped in 12 weeks — lose fat, keep muscle, reveal definition
- **Built for:** 25 yr · 68 kg · 156 cm male
- **Diet:** high protein, **no fish**, **no beans** (except in chilli 😄)
- **Foot-friendly:** adapted for posterior tibial tendinitis (right foot)

---

## 📲 Get the app on your phone

The app lives at:

```
https://benwatson2000.github.io/personal-trainer/
```

**Turn on hosting (one time):** Repo → **Settings → Pages** → **Deploy from a branch**
→ Branch `main`, folder `/ (root)` → **Save**. Wait ~1 minute, then open the link.

**Add it to your home screen** so it feels like a real app:

- **iPhone:** open the link in Safari → Share → **Add to Home Screen**.
- **Android:** open in Chrome → ⋮ menu → **Install app / Add to Home screen**.

It works offline and remembers everything on your device.

---

## ✨ What's in the app

- **Today** — workout (with rest timer, Gym/Home toggle, set logging), meals (with
  recipes & per-meal swap), water, supplements, tomorrow preview, a Reveal-Day
  countdown, and **back/forward day navigation** to review past days (read-only).
- **Shop** — a weekly shopping list **auto-built from your meals**, with batch-prep,
  custom items and **carry-over weekly staples**.
- **Progress** — adaptive coach (+ metabolism/TDEE), diet-break scheduler, weekly
  report card, weight trend, goal + ETA, achievements and the strength log.
- **Photos** — your own tab: progress photos with weight watermark, before/after
  compare slider and timelapse.
- **Settings** — **your profile** (stats + goal), start date, **Recipe Library**
  (pick your meals), supplements, backup/restore, and the full 12-week plan
  reference (blueprint + recipes).

### Works for more than one person

On a fresh device the app opens a quick **setup** (name, sex, age, height,
weight, activity, goal — **lose fat / maintain / gain muscle** — and any foods to
avoid). Everything — calorie targets, meal portions and the adaptive coach —
then tailors to that person and goal. Since data is per-device, just share the
link and each person sets themselves up on their own phone.

**Goal-specific training:** gainers get a **hypertrophy / lean-gain** block
(Upper-Lower → Push-Pull-Legs), 60+ gets a **gentle full-body + balance**
programme, and everyone else keeps the fat-loss plan — picked automatically from
your profile.

**Age-aware & safe:** best for ~16–65, but it adapts at the edges — **under 13**
isn't supported (it'll say so), **13–17** runs in a *numbers-free* mode (no
calorie targets — just eat-well/train/sleep habits, with workouts, photos and
streaks), **under-18s** are kept to *maintain/gain* (never a cut), and **60+**
gets a bodyweight-based protein target and a relaxed calorie floor.

**Flexible by design:** log an eating-out **treat** and it balances the next few
days; **miss a day** and push the whole plan back without losing a session.

---

## 🗓️ The Plan

A fat-loss cut that protects muscle: progressive lifting + low-impact cardio, high
protein, calories stepping down across three phases.

| Phase | Weeks | Training | Calorie aim | Protein |
|------|-------|----------|----------|---------|
| 1 · Foundation | 1–4 | Full body 3× + easy cardio | ~1850 | 160 g |
| 2 · Build & Burn | 5–8 | Upper/Lower 4× + intervals | ~1750 | 160 g |
| 3 · Shred | 9–12 | Push/Pull/Legs + extra cardio | ~1650 | 165 g |

The **meals are the source of truth** (~1850 kcal/day). Each phase shows its aim plus
a one-line *adjust* to step calories down — and the aim auto-recalculates as your
weight drops, to hold the deficit. Protein never gets cut.

**🦶 Foot-friendly:** no running or jumping, low-impact cardio (cycling/elliptical),
and leg work uses bilateral/seated/supported moves (leg press, wall sit, glute
bridge, seated leg curl) instead of lunges, split squats and calf raises.

> ⚕️ General fitness guidance, not medical advice. Posterior tibial tendinitis can
> worsen if loaded through pain — get it assessed by a GP or physio, and stop any
> movement that aggravates it.

---

## ✏️ Editing your plan

Everything is data-driven — edit **`data/plan.json`** and the app updates:

- `phases[].schedule` — the 7 daily workouts (gym + `homeItems`) for each phase
- `meals` — the 14-day curated rotation; `mealBank` — the full pool for the Recipe Library
- `phases[].calories / protein / carbs / fat` — macro targets
- `meta.startDate` — default program start (also settable in the app)

## 🧩 What's in here

```
index.html              the web app shell
styles.css  app.js      UI + logic (no frameworks, no build step)
manifest.webmanifest    makes it installable (PWA)
sw.js                   offline caching (network-first app shell)
data/plan.json          the entire plan + meal bank (single source of truth)
icons/                  app icons
```

Made to be tweaked. Lock in. 💪
