# 🏋️ Ben's PT — 12-Week Shred

Your own personal trainer in your pocket: a free, installable web app + a daily
Telegram reminder, all hosted on GitHub for **£0**.

- **Goal:** get ripped in 12 weeks — lose fat, keep muscle, reveal definition
- **Built for:** 68 kg · 156 cm male
- **Diet:** high protein, **no fish**, **no beans** (except in chilli 😄)
- **Cost:** free (GitHub Pages + GitHub Actions)

---

## 📲 1. Get the app on your phone

The app lives at:

```
https://benwatson2000.github.io/personal-trainer/
```

**Turn on hosting (one time):**

1. Push this branch and merge it into `main` (or just point Pages at this branch).
2. Repo → **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Branch: `main` (or `claude/fitness-plan-tracking-app-eph981`), folder: `/ (root)` → **Save**.
5. Wait ~1 minute, then open the link above.

**Add it to your home screen** so it feels like a real app:

- **iPhone:** open the link in Safari → Share → **Add to Home Screen**.
- **Android:** open in Chrome → ⋮ menu → **Install app / Add to Home screen**.

It works offline and remembers your check-ins, water and weigh-ins on your device.

---

## 🔔 2. Daily reminders on Telegram (free)

Every morning a GitHub Action sends you the day's workout + meals. Setup takes ~3 minutes:

1. **Create a bot** — in Telegram, message [`@BotFather`](https://t.me/BotFather),
   send `/newbot`, follow the prompts, and copy the **bot token** it gives you.
2. **Find your chat id** — message [`@userinfobot`](https://t.me/userinfobot);
   it replies with your numeric **Id**.
3. **Start a chat with your new bot** (search its username and tap *Start*) so it's
   allowed to message you.
4. **Add the secrets** — repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `TELEGRAM_BOT_TOKEN` → the token from step 1
   - `TELEGRAM_CHAT_ID` → the id from step 2
5. **Test it now** — repo → **Actions → Daily PT Ping → Run workflow**. You should
   get a message within a few seconds.

After that it runs automatically at **06:00 UTC (~7am UK summer time)** daily.
Change the time or start date in `.github/workflows/daily-ping.yml`.

**Weekly shopping list** — a second action (`Weekly Shopping List`) sends the week's
shop to the same Telegram chat every **Sunday at ~5pm UK**, so you can prep ahead.
It uses the same two secrets — no extra setup. Run it any time from
**Actions → Weekly Shopping List → Run workflow**, or edit the day/time in
`.github/workflows/weekly-shopping.yml`.

> Prefer email instead of Telegram? Telegram is the simplest free option, but the
> ping script is just one file (`scripts/daily-ping.js`) — swap the `fetch` call for
> an email service (e.g. Resend/Mailgun free tier) and add those secrets.

---

## 🗓️ The Plan

A fat-loss cut that protects muscle: progressive lifting + cardio, high protein,
calories stepping down across three phases.

| Phase | Weeks | Training | Calories | Protein |
|------|-------|----------|----------|---------|
| 1 · Foundation | 1–4 | Full body 3× + easy cardio | 1900 | 160 g |
| 2 · Build & Burn | 5–8 | Upper/Lower 4× + intervals | 1800 | 160 g |
| 3 · Shred | 9–12 | Push/Pull/Legs + extra cardio | 1700 | 165 g |

**Golden rules**

- Hit your protein target *every* day — it's what keeps the muscle while you cut.
- 8,000–10,000 steps a day on top of workouts.
- Sleep 7–9 hours, drink ~2.5–3 L water.
- Weigh in each morning; judge progress on the **weekly average**, not single days.
- One flexible meal a week is fine — stay roughly within calories.

Full daily workouts and a 7-day meal rotation (no fish; beans only in the chilli)
live in [`data/plan.json`](data/plan.json) and render in the **Plan** tab of the app.

**Gym or home?** Every lifting day has a no-equipment variant (dumbbells / bands /
bodyweight). Tap the **🏋️ Gym / 🏠 Home** toggle on the Today screen — your choice is
remembered. For the daily Telegram ping, set `PT_MODE` to `gym` or `home` in
`.github/workflows/daily-ping.yml`.

> ⚕️ General fitness guidance, not medical advice. Check with a GP before starting a
> new program, especially if you have any health conditions.

---

## ✏️ Editing your plan

Everything is data-driven — edit **`data/plan.json`** and both the app and the daily
ping update automatically:

- `phases[].schedule` — the 7 daily workouts for each phase
- `meals` — the rotating meal days
- `phases[].calories / protein / carbs / fat` — your macro targets
- `meta.startDate` — default program start (you can also set it in the app's Settings)

## 🧩 What's in here

```
index.html              the web app shell
styles.css  app.js      UI + logic (no frameworks, no build step)
manifest.webmanifest    makes it installable (PWA)
sw.js                   offline caching
data/plan.json          the entire plan + shopping list (single source of truth)
scripts/daily-ping.js   builds + sends the daily Telegram message
scripts/shopping-list.js builds + sends the Sunday shopping list
.github/workflows/      the morning cron job + Sunday shopping cron
icons/                  app icons
```

Made to be tweaked. Lock in. 💪
