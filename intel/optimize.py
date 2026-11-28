"""Phase 3: walk-forward Individual Stock Optimisation Engine.

Answers, per stock, OUT-OF-SAMPLE and reliability-gated:
  * Which pre-registered indicator configuration (backtest.CONFIGS) has performed
    best, and how each config performs broken down BY market regime (reusing the
    Phase 2 regime labels, computed causally at each trade's entry).
  * The honest performance of ADAPTIVELY picking the best in-sample config each
    fold and trading it out-of-sample.

Method (optimize-v1.0):
  * Rolling walk-forward: in each fold, choose the best config on the TRAIN window
    (in-sample), then trade it on the following TEST window (out-of-sample). Only
    OOS trades are scored -> the headline numbers are not in-sample/overfit.
  * No look-ahead: indicators are causal; a trade is entered on a completed bar.
  * Reliability gate: enough OOS trades AND folds AND consistent, net-positive
    expectancy -> COMPLETED; otherwise INSUFFICIENT_EVIDENCE (a VALID result).
    Fetch/data failure -> FAILED. Default is NOT_RUN.
  * Costs are netted (backtest.COST_PER_SIDE). Confidence is an evidence-strength
    label, NOT a calibrated probability. Past performance is not predictive.

Independent of the weekly EMA 9/21/50 engine. Consumes the regime thresholds but
not its stored snapshot (regime is recomputed causally at each entry).
"""
from __future__ import annotations

import datetime as _dt

from intel import backtest as bt
from intel import indicators as ind
from intel import regime as rg

METHODOLOGY_VERSION = "optimize-v1.0"

TRAIN = 252          # ~1y in-sample
TEST = 126           # ~6mo out-of-sample
STEP = 126           # roll forward 6mo
MIN_BARS = TRAIN + 2 * TEST     # need at least ~2 OOS folds of history
MIN_TRAIN_TRADES = 3            # a config must have traded in-sample to be eligible

# reliability thresholds (explicit)
MIN_OOS_TRADES = 15
MIN_FOLDS = 3
MIN_POSITIVE_FOLD_FRAC = 0.5


def _regime_tagger(bars):
    """Return tag(i) -> (trend, volatility) computed causally from bars[0..i]."""
    closes = [b.get("close") for b in bars]
    ema_f = ind.ema(closes, 20)
    ema_s = ind.ema(closes, 50)
    adx_s, pdi, mdi = ind.adx(bars, 14)
    atr_s = ind.atr(bars, 14)
    atr_pct = [None] * len(bars)
    for i in range(len(bars)):
        if atr_s[i] is not None and closes[i]:
            atr_pct[i] = 100.0 * atr_s[i] / closes[i]

    def tag(i):
        f, s, a = ema_f[i], ema_s[i], adx_s[i]
        price = closes[i]
        trend = "UNCERTAIN"
        if None not in (f, s, price) and a is not None:
            if a < rg.ADX_WEAK:
                trend = "SIDEWAYS"
            elif price > f > s and (pdi[i] or 0) >= (mdi[i] or 0):
                trend = "BULLISH"
            elif price < f < s and (mdi[i] or 0) > (pdi[i] or 0):
                trend = "BEARISH"
            else:
                trend = "UNCERTAIN"
        vol = "UNCERTAIN"
        hist = [atr_pct[j] for j in range(max(0, i - 252), i) if atr_pct[j] is not None]
        if atr_pct[i] is not None and len(hist) > 60:
            p = ind.percentile_rank(hist, atr_pct[i])
            srt = sorted(hist)
            med = srt[len(srt) // 2]
            p10 = srt[max(0, int(0.1 * len(srt)) - 1)]
            p90 = srt[min(len(srt) - 1, int(0.9 * len(srt)))]
            if med > 0 and (p90 - p10) / med < 0.15:
                vol = "NORMAL"
            elif p >= rg.VOL_HIGH_PCTL:
                vol = "HIGH_VOLATILITY"
            elif p <= rg.VOL_LOW_PCTL:
                vol = "LOW_VOLATILITY"
            else:
                vol = "NORMAL"
        return trend, vol
    return tag


def _score_insample(m):
    """Rank in-sample configs: expectancy weighted by trade count, penalise if too
    few trades. Deliberately simple and monotone (no fitting of the scorer)."""
    if not m or not m["trades"] or m["trades"] < MIN_TRAIN_TRADES:
        return -1e9
    exp = m["expectancy_pct"] or 0.0
    return exp * (m["trades"] ** 0.5)


def evaluate(symbol, name, bars, data_status):
    base = {"symbol": symbol, "name": name, "methodology_version": METHODOLOGY_VERSION,
            "evaluated_at": _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()}
    n = len(bars or [])
    usable = sum(1 for b in (bars or []) if b.get("close") is not None)
    base["data"] = {"daily_bars": usable, "status": data_status,
                    "train": TRAIN, "test": TEST, "step": STEP}
    if data_status not in ("AVAILABLE_VALIDATED", "PARTIAL"):
        return dict(base, optimization_status="INSUFFICIENT_EVIDENCE",
                    reason="data not validated (%s)" % data_status, confidence="LOW")
    if usable < MIN_BARS:
        return dict(base, optimization_status="INSUFFICIENT_EVIDENCE",
                    reason="only %d usable bars (need %d)" % (usable, MIN_BARS), confidence="LOW")

    tag = _regime_tagger(bars)

    # ---- walk-forward folds ----
    folds = []
    adaptive_trades = []
    start = 0
    while start + TRAIN + TEST <= n:
        tr_lo, tr_hi = start, start + TRAIN
        te_lo, te_hi = tr_hi, min(tr_hi + TEST, n)
        # choose best config in-sample
        best_id, best_score = None, -1e18
        for cid in bt.CONFIG_IDS:
            m, _ = bt.run_config(bars, cid, tr_lo, tr_hi)
            sc = _score_insample(m)
            if sc > best_score:
                best_score, best_id = sc, cid
        # trade chosen config out-of-sample
        om, otrades = bt.run_config(bars, best_id, te_lo, te_hi, regime_tag=tag)
        adaptive_trades.extend(otrades)
        folds.append({"train": [bars[tr_lo]["date"], bars[tr_hi - 1]["date"]],
                      "test": [bars[te_lo]["date"], bars[te_hi - 1]["date"]],
                      "chosen_config": best_id, "oos_trades": om["trades"],
                      "oos_total_ret_pct": om["total_ret_pct"]})
        start += STEP

    wf_metrics = bt.metrics(adaptive_trades)
    pos_folds = sum(1 for f in folds if (f["oos_total_ret_pct"] or 0) > 0)
    nfolds = len(folds)
    checks = {
        "folds": nfolds, "min_folds": MIN_FOLDS,
        "oos_trades": wf_metrics["trades"], "min_oos_trades": MIN_OOS_TRADES,
        "positive_folds": pos_folds, "positive_fold_frac": round(pos_folds / nfolds, 2) if nfolds else 0,
        "expectancy_pct": wf_metrics["expectancy_pct"],
        "profit_factor": wf_metrics["profit_factor"],
    }
    passed = (nfolds >= MIN_FOLDS and wf_metrics["trades"] >= MIN_OOS_TRADES
              and (wf_metrics["expectancy_pct"] or 0) > 0
              and (wf_metrics["profit_factor"] or 0) > 1.0
              and checks["positive_fold_frac"] >= MIN_POSITIVE_FOLD_FRAC)
    checks["passed"] = passed

    # ---- per-config OOS performance + per-regime attribution ----
    per_config = {}
    for cid in bt.CONFIG_IDS:
        all_tr = []
        s2 = 0
        while s2 + TRAIN + TEST <= n:
            te_lo, te_hi = s2 + TRAIN, min(s2 + TRAIN + TEST, n)
            _, tr = bt.run_config(bars, cid, te_lo, te_hi, regime_tag=tag)
            all_tr.extend(tr)
            s2 += STEP
        by_regime = {}
        for reg in ("BULLISH", "BEARISH", "SIDEWAYS", "UNCERTAIN"):
            sub = [t for t in all_tr if t.get("entry_trend") == reg]
            if sub:
                by_regime[reg] = bt.metrics(sub)
        per_config[cid] = {"label": bt.CONFIG_LABELS[cid], "oos": bt.metrics(all_tr),
                           "by_regime": by_regime}

    # best config overall by OOS expectancy with a trade-count floor
    eligible = [(cid, v["oos"]) for cid, v in per_config.items()
                if (v["oos"]["trades"] or 0) >= MIN_OOS_TRADES and v["oos"]["expectancy_pct"] is not None]
    best_overall = max(eligible, key=lambda kv: kv[1]["expectancy_pct"])[0] if eligible else None

    status = "COMPLETED" if passed else "INSUFFICIENT_EVIDENCE"
    conf = "HIGH" if (passed and wf_metrics["trades"] >= 2 * MIN_OOS_TRADES and checks["positive_fold_frac"] >= 0.67) \
        else ("MODERATE" if passed else "LOW")
    reason = ("walk-forward OOS reliable" if passed
              else "insufficient/inconsistent OOS evidence (see reliability checks)")
    return dict(base, optimization_status=status, reason=reason, confidence=conf,
                walk_forward={"metrics": wf_metrics, "reliability": checks, "folds": folds},
                best_config_overall=best_overall, per_config=per_config,
                limitations=[
                    "Out-of-sample but pre-registered configs only; survivorship bias remains.",
                    "Costs netted at %.2f%%/side; real fills/slippage/taxes differ." % (bt.COST_PER_SIDE * 100),
                    "Long-only, daily EOD; intraday not optimised. Past performance is not predictive.",
                ])
