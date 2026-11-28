# Phase 4 — Independent Recommendation Engine: Technical Specification

**Status:** FINAL IMPLEMENTATION CONTRACT — specification only, no code written, nothing deployed.
**Version:** rev-2 (approved) · proposed engine id `recommend-v1.0`
**Approval:** all 7 decisions approved; all 9 required corrections incorporated (see the confirmation list at the end). This revision supersedes the draft and is the contract for implementation.
**Scope:** Design Phase 4 only. Phases 1–3 are completed and are reused, not redesigned.
**Prime directives honoured:** fail-closed (INSUFFICIENT_EVIDENCE is valid); never force a recommendation; no accuracy/probability claims; the weekly EMA 9/21/50 engine is never modified or merged; no paid services/LLM; locked 201-stock universe; "data available ≠ recommended." Provenance, independent-source verification and corporate-action verification are kept **visibly distinct** from statistical evidence strength; Yahoo-only data is never described as independently verified.

> Everything under “EXISTS” below was read directly from the repository. Everything under “PROPOSED” is new Phase 4 design awaiting approval.

---

## 1. Existing Phase 1–3 interfaces & data schemas used (EXISTS — verified in repo)

Phase 4 is a pure **consumer** of these. It adds no field to, and changes no behaviour of, any of them.

### 1.1 Phase 1 — data quality (`data/stock/<SYM>.json`, `/api/system/stock`)
```
symbol, name, exchange,
data_status: AVAILABLE_VALIDATED | PARTIAL | AWAITING_INSUFFICIENT | UNSUPPORTED | DELISTED
optimization_status, recommendation_status      # placeholders already present ("NOT_RUN"/"NONE")
provenance { provider, source_symbol, retrieved_at, price_basis, currency, data_ts, instrument, provider_note }
daily  { quality, bars, first_date, last_date, stale_days, checks{...}, issues[] }
weekly { quality, bars, first_date, last_date, stale_days, checks{...}, issues[] }
corporate_actions { splits, dividends, has_adjclose, note }
verification { independent_source_checked:false, note }
last_scan_ok, last_scan_error
```
Used by Phase 4: `data_status`, `daily.stale_days`, `daily.last_date`, `weekly.*`, `verification`, `corporate_actions`.

### 1.2 Phase 2 — market regime (`data/regime.json`, `/api/system/regime/stock`)
```
methodology_version: regime-v1.0
market { available, name, horizons{ short_term, swing, long_term }{ trend, volatility, reversal, confidence, last_candle } }
sector { available:false, note }
stocks[SYM] {
  horizons { short_term | swing | long_term } {
    interval, last_candle, bars_used, data_status,
    trend:      BULLISH | BEARISH | SIDEWAYS | UNCERTAIN
    volatility: HIGH_VOLATILITY | LOW_VOLATILITY | NORMAL | UNCERTAIN
    reversal:   POTENTIAL_REVERSAL | NONE
    confidence: LOW | MODERATE | HIGH
    reasons[],
    indicators { price, ema_fast, ema_slow, ema_fast_period, ema_slow_period,
                 adx, plus_di, minus_di, rsi, macd_hist, atr, atr_pct,
                 slow_ema_slope_pct, bb_pctb, hist_vol_annual_pct,
                 support, resistance, support_dist_pct, resistance_dist_pct,
                 atr_pct_percentile, volume_reliable, obv_slope_pct }
  }
}
```
Used by Phase 4: per-style `trend/volatility/reversal/confidence`, `indicators.atr`, `indicators.price`, `support/resistance`, `market.horizons` for market context.

### 1.3 Phase 3 — optimisation (`data/optimize.json`, `/api/system/optimize/stock`)
```
methodology_version: optimize-v1.0
params { train:252, test:126, step:126, min_oos_trades:15, min_folds:3, cost_per_side_pct:0.1 }
config_leaderboard { best_config_counts{}, regime_top_configs{ REGIME:[[config_id, oos_expectancy],...] } }
stocks[SYM] {
  optimization_status: COMPLETED | INSUFFICIENT_EVIDENCE | FAILED | UNSUPPORTED
  reason, confidence,
  best_config_overall,
  walk_forward {
    metrics{ trades, win_rate, avg_ret_pct, expectancy_pct, profit_factor, total_ret_pct, max_drawdown_pct, avg_bars_held }
    reliability{ folds, min_folds, oos_trades, min_oos_trades, positive_folds, positive_fold_frac, expectancy_pct, profit_factor, passed }
    folds[]{ train, test, chosen_config, oos_trades, oos_total_ret_pct }
  }
  per_config{ <config_id>{ label, oos{...metrics}, by_regime{ BULLISH|BEARISH|SIDEWAYS|UNCERTAIN{...metrics} } } }
}
```
Pre-registered configs (EXISTS, `intel/backtest.py`): `ema_9_21, ema_20_50, ema_50_200, rsi_mom_14, macd_12_26_9, bb_breakout_20, donchian_20_10`. Cost model: 0.10%/side, long-only, causal signals.

### 1.4 Weekly EMA 9/21/50 engine (EXISTS — `engine.py`, `/api/stock`) — INDEPENDENT, read-only
```
verdict { action: BUY | HOLD | WAIT | SELL, headline }   # "STRONG BUY ..." headline when fresh 9/21 cross inside 21/50 uptrend
signal_9_21 { fast, slow, fresh_bull, fresh_bear, regime:above|below }
signal_21_50 { ... }
quality { available, quality:PASS|NEAR|FAIL, valuation:CHEAP|FAIR|EXPENSIVE, quality_gates[], value_gates[], flag, as_of, name, type }
valuation { applicable, intrinsic, upside_pct, models[], used, flag, note }
price, last_close, prev_close, last_week
```
Phase 4 reads `verdict`, `quality`, `valuation` **only to display agreement/disagreement**. It never calls into or edits the engine. Decision on the last COMPLETED weekly candle is the engine's own; Phase 4 does not re-implement it.

**Gap identified (important):** Phase 3 optimises on **daily** data and produces **one** `best_config_overall` per stock plus every config’s OOS/by-regime metrics. It does **not** emit a separate optimised config per trading style. Phase 4 must therefore *select* a style-appropriate config from the existing `per_config` block (§4), and long-term recommendations are **daily-derived** (documented limitation, §14).

---

## 2. Recommendation architecture & data flow (PROPOSED)

Same shape as Phases 2–3: an **offline batch** computes results into a committed JSON file; the serverless app serves them **read-only**; the UI renders them. No heavy work in the request path. No new infrastructure, no paid services.

```
          ┌── data/stock/<SYM>.json      (Phase 1: data_status, freshness)
          ├── data/regime.json           (Phase 2: per-style regime + indicators)
 inputs ──┤── data/optimize.json         (Phase 3: reliability + per_config + by_regime)
          └── (fresh daily bars, fetched) (live signal state + current price/ATR for entry/stop)

   intel/recommend.py      pure decision logic  ->  per-style Recommendation records
   intel/scan_recommend.py offline batch (resumable, rate-limited, fail-closed)
                           writes data/recommend.json  + appends data/recommend_history.jsonl

   server.py  (ADDITIVE)   GET /api/system/recommend[/overview]
                           GET /api/system/recommend/stock?symbol=
   public/*   (ADDITIVE)   "System recommendation" panel on each stock page

   engine.py / quality.py / valuation.py / holdings.py / symbols.json / fundamentals.json : UNCHANGED
```

**New modules (proposed):** `intel/recommend.py`, `intel/scan_recommend.py`.
**New data:** `data/recommend.json`, `data/recommend_state.json`, `data/recommend_history.jsonl`.
**Reused:** `intel/backtest.py` (to recompute the chosen config’s *current* signal), `intel/indicators.py` (ATR etc.), `intel/datasource.py`, `intel/validate.py`, `intel/store.py`.

Why re-fetch daily bars in the batch: Phase 3 stored *metrics*, not the config’s **current** in/out signal or today’s price/ATR. The batch recomputes the chosen config’s latest signal (reusing `backtest.CONFIGS`) on fresh, validated daily bars — causal, completed candles only.

---

## 3. Recommendation eligibility (PROPOSED — evaluated per stock, per style)

A style produces an actionable recommendation only if **all** critical prerequisites pass; otherwise `INSUFFICIENT_EVIDENCE` with explicit reasons. The Phase-3 baseline (71 reliable / 128 insufficient) is **not** automatic eligibility — each style is re-checked, and the *selected configuration* is re-validated at config level (E9, §4). **Correction 3:** only `AVAILABLE_VALIDATED` data is actionable; `PARTIAL`, stale or otherwise insufficient data → `INSUFFICIENT_EVIDENCE` (no LOW-evidence concession).

| # | Prerequisite | Source | Threshold | Fail → |
|---|---|---|---|---|
| E1 | Data **structurally validated** | P1 `data_status` | **exactly `AVAILABLE_VALIDATED`** (PARTIAL/AWAITING/UNSUPPORTED/DELISTED all fail) | INSUFFICIENT |
| E2 | Data fresh | P1 `daily.last_date` → **trading-session age** (§6.6) | ≤ **5 NSE trading sessions** | INSUFFICIENT (stale) |
| E3 | Optimisation completed | P3 `optimization_status` | `COMPLETED` | INSUFFICIENT |
| E4 | Stock walk-forward passed | P3 `walk_forward.reliability.passed` | `true` | INSUFFICIENT |
| E5 | Stock min OOS trades | P3 `reliability.oos_trades` | ≥ 15 (= P3 `min_oos_trades`) | INSUFFICIENT |
| E6 | Stock walk-forward stability | P3 `reliability.positive_fold_frac` | ≥ 0.50 | INSUFFICIENT |
| E7 | Stock net-positive edge | P3 `reliability.expectancy_pct` & `profit_factor` | expectancy > 0 AND PF > 1.0 | INSUFFICIENT |
| E8 | Valid regime for the style | P2 `horizons[style].trend` | present; `UNCERTAIN` allowed but caps evidence ≤ MODERATE | (caps, not fail) |
| **E9** | **Selected config passes its OWN walk-forward** | P4 config-level walk-forward (§4) | config: oos_trades ≥ 15 AND folds ≥ 3 AND positive_fold_frac ≥ 0.50 AND expectancy > 0 AND PF > 1.0 | INSUFFICIENT |
| E10 | Live signal computable | fresh daily bars | fetch ok + validated | INSUFFICIENT (data) |

E3–E7 are **stock-level** gates reused verbatim from Phase 3 (no second, conflicting bar). **E9 is the new config-level gate (Correction 1):** stock-level reliability does **not** prove the *selected* configuration reliable, so Phase 4 validates the chosen config on its own folds (§4). Independent-source verification and corporate-action verification are reported **separately** (§7, §11) and are **not** eligibility gates and **not** part of evidence strength (Correction 9).

---

## 4. Trading styles → Phase 3 config selection (PROPOSED)

Phase 3 gives every config’s OOS performance **and** its performance **by regime**. Phase 4 maps each style to a candidate group and selects the config that is (a) in the group, (b) reliable, and (c) best **in the current regime** (the system’s core thesis: use the config that has worked in conditions like now).

| Style | Horizon (P2) | Candidate configs | Typical hold |
|---|---|---|---|
| Short-term | `short_term` | `ema_9_21`, `rsi_mom_14`, `macd_12_26_9` | days–weeks |
| Swing | `swing` | `ema_20_50`, `bb_breakout_20`, `donchian_20_10` | weeks–months |
| Long-term | `long_term` | `ema_50_200`, `ema_20_50` | months+ (daily-derived — see §14) |

**Selection rule per style (Correction 1 — config-specific, exact procedure):**

1. **Shortlist** candidate configs (from the style’s group) that are reliable at the aggregate OOS level in Phase 3: `per_config[c].oos.trades ≥ 15` AND `expectancy_pct > 0` AND `profit_factor > 1`.
2. **Rank** the shortlist by `per_config[c].by_regime[current_regime].expectancy_pct`, requiring that bucket to be **positive** and have `trades ≥ 5`. Highest wins. (This is the thesis: use the config that has worked in conditions like now.)
3. If no shortlisted config is positive-and-sufficient *in the current regime*, rank instead by aggregate `oos.expectancy_pct`, and mark `regime_suitable = false` (this will cap evidence — §7, §6-order).
4. **Config-level walk-forward re-validation (the binding E9 gate).** Phase 3 stores only the *adaptively-chosen* config per fold, not every config’s per-fold series — so stock-level `reliability` does not by itself prove the *selected* config reliable. Phase 4’s batch therefore recomputes, for the **selected config only**, its own walk-forward using the **identical fold scheme** (`TRAIN=252, TEST=126, STEP=126` — read from `optimize.json.params`, never hard-coded) on the fresh validated daily bars: apply the config to each rolling TEST window, collect OOS trades, and compute
   `config_reliability { folds, oos_trades, positive_fold_frac, expectancy_pct, profit_factor, passed }`.
   `passed` ⇔ `oos_trades ≥ 15 AND folds ≥ 3 AND positive_fold_frac ≥ 0.50 AND expectancy_pct > 0 AND profit_factor > 1.0`.
5. **Gate (E9):** if the selected config’s `config_reliability.passed` is false → the style is `INSUFFICIENT_EVIDENCE` (reason names the failing check). Try the next-ranked shortlisted config before giving up; if none passes, the style is INSUFFICIENT_EVIDENCE.
6. The chosen config, its `config_reliability`, and its `by_regime[current_regime]` metrics are stored on the recommendation record and shown in the UI, so reliability is always **config-specific and auditable**, never inherited from the stock.

Intraday: **not supported** (no validated intraday history, no execution model). Never derived from EOD data.

---

## 5. Recommendation classifications (PROPOSED — exact, per style)

Inputs per style after eligibility passes: `cfg` (chosen config), `sig_now` (cfg in-market 1/0 on last completed daily bar), `fresh_entry` (0→1 this bar), `fresh_exit` (1→0 this bar), `regime`/`vol`/`reversal` (P2 for the style’s horizon), `rr` and a **defensible target** (§6.4), `evidence` (§7). Long-only universe.

**Correction 2 — unambiguous, non-overlapping semantics.** The only distinction between the BUY family and HOLD is **new entry vs existing position**: BUY/STRONG BUY require a **fresh new entry** (`fresh_entry = true`); HOLD requires the strategy to be **already in-market** with no fresh entry. No “entered within last N bars” fuzz, no overlap.

| Class | Meaning | Conditions (ALL, after the §5A order) | Invalidation |
|---|---|---|---|
| **INSUFFICIENT_EVIDENCE** | Critical prerequisite fails | any of E1–E10 fails (terminal — nothing else runs) | prereqs restored on next scan |
| **STRONG BUY** | Particularly strong **new** entry | `fresh_entry` · regime = `BULLISH` · cfg positive-in-BULLISH (§4) · `reversal = NONE` · **defensible target, `rr ≥ 2.0`** · evidence = `HIGH` | stop hit · cfg exits · regime leaves BULLISH · reversal appears |
| **BUY** | Eligible **new** entry | `fresh_entry` · regime ∈ {BULLISH, SIDEWAYS, UNCERTAIN} with cfg reliable there · **defensible target, `rr ≥ 1.5`** · evidence ≥ `MODERATE` · (not STRONG) | stop hit · cfg exits · regime turns BEARISH |
| **HOLD** | **Existing** position remains valid | `sig_now = 1` AND `fresh_entry = false` AND stop not hit AND cfg has not exited | cfg exits · stop hit · regime turns BEARISH |
| **SELL** | **Exit** position / **avoid** initiating | `fresh_exit` (cfg just exited long) OR (regime = `BEARISH` AND `sig_now = 0`) | cfg re-enters long in a supportive regime |
| **WAIT** | No actionable setup | `sig_now = 0` AND `fresh_entry = false` AND not a SELL/avoid case | a qualifying `fresh_entry` appears |

**No-target rule (Correction 5):** if no **defensible target / RR** is available (§6.4), the result **cannot** be STRONG BUY or BUY — it becomes **WAIT** (if flat) or **HOLD** (if `sig_now = 1`), reason “no defensible target / reward-risk.”

Cap/downgrade rules are applied in the strict order of **§5A** (not ad-hoc). No arbitrary point score decides the class — each class is a boolean rule over measurable, sourced inputs.

## 5A. Rule application order (Correction 6 — deterministic, contradictions resolved)

Applied strictly top-to-bottom; the first terminal step wins:

1. **Eligibility (E1–E10).** Any failure ⇒ `INSUFFICIENT_EVIDENCE` naming the failed prerequisite. **Terminal.**
2. **Live facts:** `sig_now / fresh_entry / fresh_exit` (selected cfg, last completed bar); stop, target, `rr`, sizing (§6). No defensible target/RR ⇒ `no_target = true`.
3. **Base class (§5)** from signal state + regime + `rr` (a `no_target` setup is not buyable).
4. **Evidence tier (§7)** — including the volatility component: `HIGH_VOLATILITY` caps evidence at `MODERATE`; `UNCERTAIN` regime caps at `MODERATE`; non-regime-suitable config caps at `LOW`. (PARTIAL data cannot reach here — E1.)
5. **Volatility risk adjustment:** widen stop (`k += 0.5`), recompute sizing/`rr`; if `rr` now falls below the class gate ⇒ apply the no-target downgrade.
6. **Reversal:** `POTENTIAL_REVERSAL` against the position ⇒ one step down (STRONG BUY→BUY, BUY→HOLD/WAIT) + warning.
7. **Fundamental/valuation conflict (§8):** quality `FAIL` or valuation `EXPENSIVE` ⇒ cap at **BUY** (never STRONG) + warning.
8. **Evidence gate (final):** STRONG BUY **requires** `HIGH`; if < HIGH ⇒ STRONG BUY → **BUY**. BUY **requires** ≥ `MODERATE`; if `LOW` ⇒ BUY → **WAIT** (flat) / **HOLD** (`sig_now=1`).

**Contradiction resolved (STRONG BUY vs HIGH volatility):** step 4 caps evidence at MODERATE in high volatility and step 8 requires HIGH for STRONG BUY, so a high-volatility stock **can never be STRONG BUY** — it is capped at BUY. Intentional and documented.

---

## 6. Entry, exit & risk management (PROPOSED — India-realistic)

All prices from fresh validated daily bars; `ATR` from P2 indicators (`atr`, 14-period). **A backtested/last-close entry is not a guaranteed live fill** — stated on every record.

**6.1 Entry & exit.** Entry reference = last completed close; suggested action = limit near last close (±0.3% tolerance); record flags `executable_not_guaranteed: true`. Exit = the chosen config’s own exit rule (opposite EMA cross, close below BB mid, Donchian low) or stop/target, whichever first.

**6.2 Stop-loss.** `risk = entry − stop`, `stop = entry − k·ATR`; `k = 2.0` (short/swing), `k = 3.0` (long-term); `HIGH_VOLATILITY → k += 0.5` (applied in §5A step 5). ATR from P2 `indicators.atr` (14-period).

**6.3 Trailing stop.** Once unrealised ≥ `1·ATR`, move stop to breakeven; thereafter chandelier `max(high_since_entry) − k·ATR`.

**6.4 Target selection & reward:risk (Correction 5 — fully specified).** `risk = entry − stop` (must be > 0). Target is chosen in this order:
1. **Pivot resistance (P2 `resistance`)** if it is **above entry** AND `(resistance − entry)/risk ≥ class_gate` (2.0 for STRONG, 1.5 for BUY) ⇒ `target = resistance`, `rr = (resistance − entry)/risk`.
2. Else **synthetic measured-move target** `target = entry + class_gate·risk`, accepted **only if** it is defensible: `target ≤ entry + ceiling`, where `ceiling = k_ceiling·ATR`, `k_ceiling = 4` (short/swing) / `6` (long-term). Then `rr = class_gate`.
3. If resistance is **missing, ≤ entry, or too close** (case 1 fails) **and** the synthetic target breaches the ceiling (case 2 fails), **or** `risk ≤ 0` ⇒ **no defensible target** ⇒ `no_target = true` ⇒ **not BUY/STRONG BUY** (→ WAIT if flat, HOLD if `sig_now=1`; §5).
4. **RR gates:** STRONG BUY `rr ≥ 2.0`; BUY `rr ≥ 1.5`; `rr < 1.0` is never a buy.

**6.5 Position sizing (Correction 5 — both limits; output only, never places orders).** Two independent caps, the **more restrictive wins**:
```
shares_by_risk  = floor( (max_risk_pct · capital) / (entry − stop) )      # 1% max risk
shares_by_alloc = floor( (max_position_pct · capital) / entry )           # 20% allocation cap
shares          = min(shares_by_risk, shares_by_alloc)                    # whole shares (cash delivery)
position_value  = shares · entry
actual_risk     = shares · (entry − stop)        # ≤ 1% of capital by construction
actual_alloc    = position_value / capital       # ≤ 20% by construction
```
`max_risk_pct = 1%`, `max_position_pct = 20%`. Capital is **user-entered**; the engine shows the **formula + a worked example**, no order placement, no brokerage. If `shares = 0` at the entered capital, the record says so (position too small to meet the risk unit).

**6.6 Freshness = trading-session age (Correction 7).** Data age is measured in **NSE trading sessions**, not calendar days. `session_age` = count of NSE trading sessions strictly after `daily.last_date` up to and including the current session, where sessions exclude Saturdays, Sundays and NSE trading holidays (from a maintained NSE holiday list bundled with the app; keeping it current is logged as tech-debt, §14). Fresh ⇔ `session_age ≤ 5`. Example: data to Friday, evaluated the next Tuesday with Monday a holiday ⇒ age = 1 session (Tuesday), fresh. P1’s calendar `stale_days` is shown for reference but the **gate uses `session_age`**.

**6.7 Costs — three separate buckets, never double-counted (Correction 8).**
| Bucket | What | Where it applies | Double-count guard |
|---|---|---|---|
| **A. Historical backtest cost** | 0.10%/side | **Already inside** Phase 3 OOS metrics (`expectancy_pct`, `profit_factor`, `total_ret_pct`) and the config-level re-validation (§4) uses the same `backtest.COST_PER_SIDE` | Historical figures are shown **as-is**; Phase 4 does **not** re-subtract any cost from them |
| **B. Estimated live transaction cost** | brokerage + STT + exchange/SEBI + stamp duty + GST (delivery) | A **separate forward estimate** attached to the *suggested* trade only | Never subtracted from bucket-A numbers |
| **C. Slippage allowance** | 0.1–0.3% | Separate, on the suggested trade only (live fill ≠ close) | Never subtracted from bucket-A numbers |
The UI labels these distinctly: “historical net (incl. 0.10%/side)” vs “estimated live costs (B)” vs “slippage allowance (C).” No expense is counted twice.

**6.8 Invalidation of an existing recommendation.** stop hit · config exits long · regime flips against the position · data fails the `session_age ≤ 5` gate · a new optimisation scan changes `optimization_status` away from `COMPLETED` or the config’s `config_reliability.passed` turns false · evidence drops below the class floor. Each invalidation is written as a **new append-only history event** (§9) — the prior record is never altered.

---

## 7. Evidence & confidence (PROPOSED — tiered, rule-based, NOT a probability)

Evidence is a **checklist tier**, explicitly *not* a calibrated probability of profit. It is computed **only** from *statistical* out-of-sample strength and structural data quality. **Correction 9:** independent-source verification and corporate-action verification are **NOT** components of evidence — they are separate provenance facts (always `independent_source_checked:false` for Yahoo-only data) reported in their own block (§9/§11). Evidence strength never implies the data was independently verified.

Statistical components (all sourced):
1. **Config-level** OOS reliability (P4 `config_reliability.passed`, `profit_factor`, `expectancy_pct` — §4, the *selected* config, not the stock)
2. Config walk-forward stability (P4 `config_reliability.positive_fold_frac`)
3. Config trade count (P4 `config_reliability.oos_trades`)
4. Regime suitability (chosen cfg positive & reliable **in the current P2 regime**)
5. System agreement (cfg signal vs P2 trend vs weekly engine — §8)
6. **Structural** data quality only (P1 `data_status = AVAILABLE_VALIDATED` + `session_age ≤ 5`) — **not** independent/CA verification
7. Recency (P2 `last_candle`, `session_age`)

| Tier | Requires (ALL) |
|---|---|
| **HIGH** | config_reliability.passed · PF ≥ 1.5 · positive_fold_frac ≥ 0.67 · oos_trades ≥ 30 (2×min) · regime-suitable (comp. 4) · data `AVAILABLE_VALIDATED` & `session_age ≤ 5` · ≥ 2 of 3 systems agree · **`vol ≠ HIGH_VOLATILITY` and regime ≠ UNCERTAIN** |
| **MODERATE** | config_reliability.passed · data validated & fresh · (regime-suitable OR systems mostly agree) · not HIGH. **`HIGH_VOLATILITY` or `UNCERTAIN` regime caps here.** |
| **LOW** | eligible but fails MODERATE (e.g. config not validated in current regime) |

Always printed with the record: “Evidence strength is a transparency measure, not a probability of success; it is not statistically calibrated or independently validated. Data is Yahoo-only and **not** independently verified.”

---

## 8. Conflicting-signal handling (PROPOSED — transparent, never silent)

Phase 4’s decision is driven by the **optimised config + regime + reliability** (the TIS core). Four *other* systems are shown alongside as corroboration/disagreement and may **cap** (never silently flip) the result:

| System | Source | Effect on recommendation |
|---|---|---|
| Optimised config signal | P3 cfg (recomputed live) | Primary driver |
| Market regime | P2 trend/vol/reversal | Gates eligibility, caps/downgrades (§5) |
| Fundamental quality | weekly engine `quality.quality` (PASS/NEAR/FAIL) | FAIL caps at BUY + warning (never blocks a reliable technical setup, but flagged) |
| Valuation | weekly engine `quality.valuation` (CHEAP/FAIR/EXPENSIVE) | EXPENSIVE caps STRONG→BUY + warning |
| Weekly EMA 9/21/50 engine | `verdict.action` | **Displayed as agreement/disagreement only** — never merged, never overrides, never overridden |

A **Signal panel** in the UI lists each system’s current read and an explicit “systems agree / disagree” line. If the weekly engine says `BUY` and the TIS says `WAIT` (or vice-versa), **both are shown with their reasons**; neither is hidden. The two engines remain fully independent codepaths.

---

## 9. Recommendation history & performance evaluation (PROPOSED)

**Correction 4 — immutable, append-only; outcomes are separate events.** `data/recommend_history.jsonl` is strictly append-only; **an existing record is never modified** (no in-place `outcome` field is ever filled). Two event kinds share the log, each with a stable `id`:

**(a) `recommendation` event** — written when a (stock, style) recommendation **changes**:
```
{ id, event:"recommendation", ts, symbol, style,
  prev_recommendation, new_recommendation,
  config_used, config_reliability {oos_trades,folds,positive_fold_frac,expectancy_pct,profit_factor},
  regime {trend,volatility,reversal}, evidence,
  indicators {price, atr, rsi, adx, support, resistance},
  entry_ref, stop, target, rr, position_sizing {risk_pct,max_position_pct},
  costs {historical_per_side_pct, est_live_pct, slippage_pct},     # the three separate buckets (§6.7)
  provenance {provider, daily_last_date, regime_last_candle, optimize_generated_at, data_ts},
  verification {independent_source_checked:false, corporate_action_verified:false, note},  # kept distinct from evidence (§7, Corr. 9)
  reasons[], warnings[], methodology_version }
```

**(b) `outcome` event** — written later by the evaluator (Phase 6), as a **new** line that **references** the recommendation it grades by its `id`, never editing it:
```
{ id, event:"outcome", ts_evaluated, ref_id, symbol, style,
  horizon_sessions, first_hit:"stop"|"target"|"exit"|"none", realised_ret_pct, mae_pct, mfe_pct,
  eval_window {from_date, to_date}, methodology_version }
```
**No look-ahead:** an `outcome` event uses **only** bars dated strictly **after** the referenced recommendation’s `ts`/`daily_last_date`; it never sees data that was unavailable at decision time (unit-tested with a cut-off, §13).

**Separation of cadences:** optimisation (`data/optimize.json`) and recommendations (`data/recommend.json` + this log) are **separate files updated independently** — re-optimising never rewrites the history log, and refreshing recommendations never touches optimisation output.

---

## 10. API design (PROPOSED — additive, read-only, matches existing pattern)
```
GET /api/system/recommend/overview
    -> { generated, generated_at, methodology_version, universe_size,
         counts{ STRONG_BUY, BUY, HOLD, WAIT, SELL, INSUFFICIENT_EVIDENCE } per style,
         params{ risk_pct:1, max_position_pct:20, atr_k_short_swing:2, atr_k_long:3, atr_k_highvol_add:0.5,
                 rr_strong:2.0, rr_buy:1.5, freshness_sessions:5, hist_cost_per_side_pct:0.10 },
         limitations[], technical_debt[] }

GET /api/system/recommend/stock?symbol=SYM
    -> { generated, methodology_version, stock {
           symbol, name, evaluated_at,
           styles { short_term | swing | long_term {
             recommendation, eligibility{passed, failed[]}, config_used{id,label},
             config_reliability{oos_trades,folds,positive_fold_frac,expectancy_pct,profit_factor,passed},  # Corr. 1
             regime{trend,volatility,reversal,confidence}, signal{sig_now,fresh_entry,fresh_exit},
             entry_ref, stop, target, rr, no_target,
             position_sizing{formula, example, shares_by_risk, shares_by_alloc, binding_limit},            # Corr. 5
             costs{historical_per_side_pct, est_live_pct, slippage_pct},                                   # Corr. 8 (3 buckets)
             evidence, evidence_components{...}, reasons[], warnings[],
             data_freshness{daily_last_date, session_age, fresh},                                          # Corr. 7
             news_factors:null, last_monitored:null   # Phase 5/6 forward-compat placeholders
           } },
           provenance{ provider, data_ts, daily_last_date, regime_last_candle, optimize_generated_at },    # Corr. 9: distinct block
           verification{ independent_source_checked:false, corporate_action_verified:false, note },        # Corr. 9: distinct from evidence
           signal_panel{ optimized_config, regime, fundamentals, valuation, weekly_engine, agreement },
           history_tail[ last N events per style ] } }
```
Guarded like the existing `/api/system/*` reads (returns `{generated:false, message}` before the batch has run). Phase 3/4 consumers read these without touching the frontend.

---

## 11. UI design (PROPOSED — "View System Recommendation" on each stock page)

A new detail-page section (same design language as the Regime/Backtest sections), **separate** from the live chart and manual indicators:

- **Per-style cards** (Short-term / Swing / Long-term): current recommendation badge · trading style · chosen optimised config **with its own config-level reliability** (Corr. 1) · market regime · entry/exit · stop-loss & risk:reward (and a clear note when `no_target` ⇒ not buyable, Corr. 5) · position-sizing example showing **which limit binds** (1% risk vs 20% alloc) · evidence tier · **trading-session** data freshness (Corr. 7) · warnings.
- **Costs shown in three distinct labels (Corr. 8):** “historical net (incl. 0.10%/side)” · “estimated live costs” · “slippage allowance” — never combined, never double-counted.
- **Provenance & verification block, kept separate from evidence (Corr. 9):** provider, data timestamps, and `independent_source_checked:false` / `corporate_action_verified:false` with the plain note that data is Yahoo-only and **not** independently verified. This block is visually distinct from the statistical evidence tier and never implies verification.
- **Signal panel:** optimised config, regime, fundamentals, valuation, and the **weekly EMA 9/21/50 verdict** side-by-side with an explicit agree/disagree line — the weekly engine is shown, never merged or overridden.
- **Previous changes:** the history tail (recommendation + outcome events) for this stock — read-only, immutable (Corr. 4).
- **Hard rule:** the manual chart indicator settings (localStorage `emaCfg/rsiCfg/macdCfg/...`) **never** affect the system recommendation — it is computed server-side from committed data only. A visible note states this.
- INSUFFICIENT_EVIDENCE renders the honest fail-closed message with the specific failed prerequisite(s), not a blank or a forced call.

---

## 12. Failure & recovery handling (PROPOSED)
- Fetch failure for a stock → preserve its last good recommendation, flag `scan_ok:false`, log separately (fail-closed; same pattern as Phases 2–3).
- Missing/!COMPLETED Phase 3 input, missing regime, or stale data → `INSUFFICIENT_EVIDENCE` with reason (never a crash, never a guess).
- Atomic writes (`store._atomic_write`, already hardened for Windows locks); resumable via `recommend_state.json`.
- Serverless endpoint guarded → the app never breaks if `data/recommend.json` is absent.
- History is append-only; a failed run never rewrites prior history.

---

## 13. Testing & acceptance criteria (PROPOSED)
**Unit (synthetic inputs → expected label):** each class path (STRONG BUY / BUY / HOLD / WAIT / SELL / INSUFFICIENT) with the §5A order applied; eligibility gating (each of E1–E10 fails → INSUFFICIENT with that reason, including E1 rejecting PARTIAL and E2 on `session_age`); **config-level walk-forward re-validation** (E9) — selected config fails its own folds → INSUFFICIENT even when the stock is COMPLETED (Corr. 1); style→config selection incl. regime fallback and next-ranked retry; **target selection** all three branches incl. `no_target` ⇒ not buyable (Corr. 5); **dual-limit sizing** — assert the binding limit (risk vs alloc) and `actual_risk ≤ 1%`, `actual_alloc ≤ 20%` (Corr. 5); **rule-order determinism** incl. high-vol capping STRONG→BUY (Corr. 6); evidence tier excludes verification (Corr. 9); cost buckets never double-count (Corr. 8); trading-session freshness across a weekend+holiday (Corr. 7).
**Integration:** run on the real 201-universe batch; verify counts, that every INSUFFICIENT names a prerequisite, and that no COMPLETED+eligible stock is silently skipped.
**Immutability (Corr. 4):** writing a new recommendation/outcome never edits a prior line; outcome events reference by `id`.
**No-look-ahead:** history outcome evaluator uses only post-`ts` bars (unit-tested with a cut-off).
**Regression:** `engine.py/quality.py/valuation.py/holdings.py/fundamentals.json/symbols.json` byte-identical; weekly verdicts unchanged; Phases 2 & 3 endpoints still correct.
**UI:** renders per-style cards + signal panel; INSUFFICIENT shows fail-closed message; manual indicator changes do not alter the recommendation; 0 console errors; no mobile overflow.
**Acceptance:** every stock gets a defensible per-style result or INSUFFICIENT_EVIDENCE with reasons; no accuracy/probability claims anywhere; weekly engine provably untouched; live deployment verified.

---

## 14. Known limitations & assumptions (PROPOSED — stated honestly)
- **Phase 3 is daily-only** → long-term recommendations are **daily-derived** (EMA 50/200 on daily), not weekly-native optimisation (approved with disclosure, Decision 1). Candidate future work: a weekly-native Phase 3 pass.
- **Config-level reliability** (E9) is recomputed by Phase 4 on the selected config using Phase 3’s fold scheme, because Phase 3 does not store every config’s per-fold series. This is out-of-sample but still on the same price history; it is not an independent dataset.
- **NSE trading calendar** for `session_age` depends on a bundled holiday list that must be kept current (tech-debt). A missing future holiday would overstate freshness by at most a session or two.
- Backtested/last-close entry ≠ guaranteed live fill; **estimated live costs (bucket B)** and **slippage (bucket C)** are forward estimates, separate from historical backtest cost (bucket A), never double-counted (§6.7).
- Long-only; no shorting/F&O. SELL = exit/avoid, not a short.
- Survivorship bias (Phase 1); Yahoo data ~15-min delayed, partial NSE, **not independently verified** (provenance/verification kept distinct from evidence, §7/§11).
- Evidence tiers are transparency measures, **not** calibrated probabilities. Past OOS performance is **not** predictive.
- Sector regime unavailable (Phase 2). Fundamentals/valuation come from the curated weekly-engine set only (not all 201 stocks have them) — absence is shown, never inferred.
- Recommendations are informational, **not** investment advice.

---

## 15. Compatibility with Phases 5, 6, 7 (PROPOSED — interfaces only, no implementation now)
- **Phase 5 (Company & News):** each style record carries a `news_factors: null` slot; a future hook `apply_news(context)` can downgrade/annotate without changing the core engine. No news/sentiment/LLM is built now.
- **Phase 6 (Monitoring & Scheduling):** `last_monitored: null` slot + the append-only history enable a scheduled EOD refresh and the outcome-evaluation pass. No scheduler built now.
- **Phase 7 (Integration & Verification):** the read-only `/api/system/recommend*` surface + versioned records give Phase 7 a stable contract to verify end-to-end. `recommendation_status` (already a P1 field) can be rolled up into the coverage counts.

---

## Worked hypothetical examples (illustrative — not live calls)

**A. Reliable bullish setup → STRONG BUY (short-term).** P1 `AVAILABLE_VALIDATED`, `session_age 1`; P3 COMPLETED; selected short-term config `ema_9_21` passes its **own** walk-forward (config_reliability: oos_trades 32, folds 7, positive_fold_frac 0.71, PF 1.8) and is positive-in-BULLISH (+6.1%); P2 short_term BULLISH / NORMAL vol / reversal NONE; `fresh_entry` today; risk = 4% (2·ATR), resistance 9% above → `rr 2.1`; weekly engine `BUY`, quality PASS. §5A: eligible → base STRONG BUY → evidence HIGH (vol normal) → no caps → **STRONG BUY**, all systems agree.

**B. Not optimised → INSUFFICIENT_EVIDENCE (all styles).** P3 `optimization_status = INSUFFICIENT_EVIDENCE`. E3/E4 fail → every style INSUFFICIENT_EVIDENCE, reason “no reliable out-of-sample strategy (walk-forward not passed).” No recommendation forced.

**B2. Stock COMPLETED but selected config fails its own folds → INSUFFICIENT (that style).** Stock passes E3–E7, but the style’s best candidate config, re-validated on its own folds, has positive_fold_frac 0.33 → **E9 fails** → that style INSUFFICIENT_EVIDENCE (“selected config not reliable on its own walk-forward”), even though the stock is COMPLETED. (Correction 1 in action.)

**C. Reliable but wrong regime → WAIT (swing), evidence LOW.** P3 COMPLETED; swing config reliable overall but `by_regime.BEARISH` negative/<5 trades; P2 swing BEARISH; `sig_now = 0`. Regime fallback ⇒ not regime-suitable ⇒ evidence LOW; base class WAIT. **WAIT** — “strategy not validated in the current bearish regime; no long setup.”

**D. Technical BUY vs fundamentals/valuation conflict → BUY (capped) + warning.** `fresh_entry`, regime BULLISH, `rr 1.8` → base BUY; weekly-engine `quality = FAIL`, `valuation = EXPENSIVE`, `verdict = HOLD`. §5A step 7 caps at **BUY** (never STRONG), evidence MODERATE, warnings list all three; signal panel shows the disagreement. Weekly engine shown, not overridden.

**E. No defensible target → WAIT (Correction 5).** `fresh_entry`, regime BULLISH, config reliable; but nearest resistance is only 1.2% above entry while risk is 4% (`rr 0.3`), and the synthetic `entry + 2·risk` target breaches the `4·ATR` ceiling. `no_target = true` ⇒ cannot be BUY/STRONG → **WAIT**, reason “no defensible target / reward-risk.”

**F. Strong setup but high volatility → BUY, not STRONG (Correction 6).** Everything for STRONG BUY holds except `vol = HIGH_VOLATILITY`. §5A step 4 caps evidence at MODERATE; stop widened (`k 2.5`) still gives `rr 1.7`; step 8 denies STRONG (needs HIGH) → **BUY**, evidence MODERATE, warning “high volatility — size reduced, wider stop.”

---

## Confirmation — all 7 decisions approved & all 9 corrections incorporated

**Approved decisions (recorded as the contract):**
1. Style→config mapping approved; **long-term daily-derived with explicit disclosure** (§4, §14).
2. Risk params: 1% max risk, 20% max allocation, ATR k=2 (short/swing)/3 (long) +0.5 high-vol, RR 2.0 (STRONG)/1.5 (BUY) (§6.2, §6.4).
3. Max data age **5 trading sessions** (§3 E2, §6.6).
4. SELL = **EXIT/AVOID**, never a short (§5).
5. 0.10%/side historical + statutory charges + 0.1–0.3% slippage, **no double-counting** (§6.7).
6. Formula-based sizing on user-entered capital, **no order placement** (§6.5, §11).
7. Offline batch + committed JSON + read-only APIs + fresh daily-bar retrieval (§2, §10).

**Required corrections incorporated:**
1. **Config-specific reliability** — selected config re-validated on its own walk-forward folds (E9, §4); stock-level reliability no longer assumed to prove the config.
2. **Unambiguous recommendations** — BUY/STRONG BUY = new entry only; HOLD = existing position valid; no overlap (§5) + deterministic order (§5A).
3. **Data quality** — only `AVAILABLE_VALIDATED` is actionable; PARTIAL/stale → INSUFFICIENT; verification kept distinct from structural validation (§3 E1, §7, §11).
4. **Immutable history** — records never modified; outcomes are separate append-only events referencing by `id` (§9).
5. **Risk/reward** — full target-selection procedure incl. missing/too-close/below-entry fallback and the no-target→not-buyable rule; dual-limit sizing (1% risk **and** 20% cap, more-restrictive wins) (§6.4, §6.5).
6. **Rule priority** — exact §5A order; high-vol vs STRONG-BUY contradiction resolved (high-vol caps evidence→MODERATE→cannot be STRONG).
7. **Freshness** — trading-session age with documented weekend/holiday handling (§6.6).
8. **Costs** — three separate buckets (historical / estimated live / slippage), never double-counted (§6.7).
9. **Transparency** — provenance, independent-source verification and corporate-action verification kept separate from statistical evidence; Yahoo-only never called independently verified (§7, §9, §11).

This revised `docs/phase4_recommendation_spec.md` is the **final Phase 4 implementation contract**. No code has been written. Awaiting approval to implement.
