# Deploying Trader Dashboard to Vercel (your private app)

Front end **and** back end run on **Vercel**:

- **Frontend** → the `public/` folder, served as a static site by Vercel.
- **Backend** → `api/index.py`, a Vercel **Python serverless function** that reuses
  the exact same code as the local server (routed by `vercel.json`).
- **Your holdings, watchlist, alerts and settings all live in your own browser**
  (localStorage) — nothing is stored server-side, so it's a private, single-user
  app and the serverless backend stays stateless. The server only *computes*
  (prices, signals, exit verdicts) from the list your browser sends it.

Data is still **Yahoo, ~15-min delayed** ("Delayed · not advice" in the UI). Keep
the URL unlisted. Real-time would be Path B (a licensed broker feed) later.

---

## Step 1 — Create the two free accounts (you do this; I can't sign up for you)

1. **GitHub** → https://github.com/signup  (verify your email).
2. **Vercel** → https://vercel.com/signup → **"Continue with GitHub"** (links them).

That's the only part I can't do. Everything after, I'll drive.

## Step 2 — Get the code to Vercel  (pick ONE)

### Option A — Vercel CLI (fastest, no Git needed)
```powershell
npm i -g vercel          # one-time (needs Node.js: https://nodejs.org)
cd C:\Users\DELL\trader-dashboard
vercel login             # opens the browser, log in with GitHub
vercel                   # first run: accept defaults, it links & deploys a preview
vercel --prod            # publish the production URL
```
`vercel` auto-detects `public/` (static) + `api/` (Python function) + `vercel.json`.
No build command needed.

### Option B — GitHub + Vercel dashboard (auto-deploys on every change)
```powershell
cd C:\Users\DELL\trader-dashboard
git init
git add .
git commit -m "Trader Dashboard"
git branch -M main
git remote add origin https://github.com/<you>/trader-dashboard.git
git push -u origin main
```
> If `git push` asks for a password, use a **Personal Access Token** (GitHub →
> Settings → Developer settings → Tokens), or use **GitHub Desktop** to push.

Then: https://vercel.com → **Add New… → Project** → import the repo → **Deploy**.
Vercel reads `vercel.json` and deploys both the static site and the Python API.

## Step 3 — Confirm it works

- Open the Vercel URL → the Home page loads and scans your universe.
- `https://<your-app>.vercel.app/healthz` → `{"ok": true}` (the backend is live).
- Add a holding on the Dashboard, refresh the page → it's still there (it's in
  your browser).

---

## Good to know

- **Single user / per-device.** Because holdings/watchlist/alerts live in the
  browser, they're tied to *this* browser+device. Open it elsewhere and you start
  fresh (that's the "just for me" design). To clear everything: browser devtools →
  Application → Local Storage → delete the keys.
- **Free tier.** Vercel Hobby is free and fine for one person. The universe scan
  runs in parallel (~1–5s), well inside Vercel's function timeout.
- **First deploy hiccups.** Serverless migrations sometimes need one tweak (a
  Python import path or a data file not bundling). If the first deploy errors,
  send me the Vercel build/function log and I'll fix it fast.

---

## Alternative hosts (if you ever want them)

The repo also ships a **`Dockerfile`** + **`render.yaml`**, so the *stateful*
version (holdings saved on the server) can run on **Render / Railway / Fly.io** as
one always-on service. Not needed for the Vercel setup above.

## Going real-time later (Path B)

Open a free broker data API (Dhan / Upstox / Angel One) or a paid feed (Zerodha
Kite, TrueData); the data layer gets rewritten to stream real-time ticks over a
websocket. The method, signals, screener and UI stay the same.
