# Trader Dashboard

A standalone, TradingView-style dashboard for the quality + weekly-EMA method
(short-term **9/21**, long-term **21/50**). Python standard library only — no
pip installs, no build step.

## Run

```bash
cd C:/Users/DELL/trader-dashboard
python server.py
```

Then open **http://localhost:8787** in a browser.

## Deploy to Vercel (Windows / PowerShell)

Front end **and** back end run on Vercel — the `public/` folder is served as a
static site and `api/index.py` runs the backend as a Python serverless function
(wired by `vercel.json`). Holdings / watchlist / alerts live in your browser
(localStorage), so it stays a private, single-user app with a stateless backend.

**One-time:** create free **GitHub** and **Vercel** accounts (sign into Vercel
"Continue with GitHub"). I can't sign up for you — that part is yours.

Then, fastest route (Vercel CLI, no Git needed):

```powershell
npm i -g vercel                 # one-time; needs Node.js (https://nodejs.org)
cd C:\Users\DELL\trader-dashboard
vercel login                    # opens the browser, log in with GitHub
vercel                          # first run: accept defaults -> preview URL
vercel --prod                   # publish the production URL
```

Confirm it works: open the URL, then `https://<your-app>.vercel.app/healthz`
should return `{"ok": true}`.

**Full walkthrough, the GitHub-import alternative, and troubleshooting are in
[DEPLOY.md](DEPLOY.md).**

## What it shows (S-1)

- Candlestick **weekly** chart with **EMA 9 / 21 / 50** overlaid and
  golden/death-cross **markers** on the candles (TradingView Lightweight Charts).
- A **Signal panel**: BUY / STRONG BUY / HOLD / SELL / WAIT, plus the
  9/21 (entry) and 21/50 (long-term trend) status in plain words.
- A **watchlist** with a verdict badge per stock; click to load.
- Symbol search (type `SUNPHARMA` or `SUNPHARMA.NS`; `.NS` is added if omitted).

## Honest limits

- Data is **Yahoo, delayed ~15 minutes** — a dev/demo feed, **not live**, and
  not licensed for redistribution. Labelled DELAYED in the header, never "Live".
- Signals read on the **last completed weekly candle** (weekly method), so they
  change on candle close, not tick-by-tick.
- **Research/education only. Not investment advice.**

## Roadmap (next milestones)

- **S-2** Fundamentals feed → quality scorecard (ROE/ROCE/growth/debt/promoter/valuation).
- **S-3** Scanner view (run the quality + 9/21/50 screen across a universe).
- **S-4** Holdings + exit monitor (death-cross alerts on your positions).
- **S-5** 5-model valuation panel.
- **S-6 (later)** real-time data via a licensed vendor + websocket streaming.
