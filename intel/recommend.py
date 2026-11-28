"""Phase 4: Independent Recommendation Engine (recommend-v1.0).

Implements the approved rev-2 contract (docs/phase4_recommendation_spec.md).
Pure decision logic: given a stock's Phase 1/2/3 records + fresh completed daily
bars (+ an optional weekly-engine context for the signal panel), produce a
per-style recommendation. It NEVER modifies the weekly EMA 9/21/50 engine; it
reads that engine's verdict only to DISPLAY agreement/disagreement.

Honesty guarantees enforced here:
  * Fail-closed: any failed eligibility prerequisite -> INSUFFICIENT_EVIDENCE.
  * Config-specific reliability (E9): the SELECTED config is re-validated on its
    own walk-forward folds — stock-level reliability is not assumed to prove it.
  * Deterministic rule order (spec 5A); high-volatility can never be STRONG BUY.
  * Evidence is a transparency tier, NOT a probability; provenance / independent
    verification / corporate-action verification are kept SEPARATE from it.
  * Costs reported in three distinct buckets, never double-counted.
"""
from __future__ import annotations

import datetime as _dt
import json
import os

from intel import backtest as bt
from intel import indicators as ind
from intel import regime as rg

METHODOLOGY_VERSION = "recommend-v1.0"

# ---- approved parameters (Decisions 2,3,5) ----
MAX_RISK_PCT = 0.01          # 1% max risk per trade
MAX_POSITION_PCT = 0.20      # 20% max allocation
ATR_K = {"short_term": 2.0, "swing": 2.0, "long_term": 3.0}
ATR_K_HIGHVOL_ADD = 0.5
K_CEILING = {"short_term": 4.0, "swing": 4.0, "long_term": 6.0}
RR_STRONG = 2.0
RR_BUY = 1.5
FRESHNESS_SESSIONS = 5
HIST_COST_PER_SIDE_PCT = bt.COST_PER_SIDE * 100   # 0.10 (bucket A, already in P3 metrics)
EST_LIVE_COST_PCT = 0.15     # bucket B: brokerage+STT+exchange/SEBI+stamp+GST (delivery, estimate)
SLIPPAGE_PCT = 0.20          # bucket C: live fill vs close (0.1-0.3 range, midpoint)
EXAMPLE_CAPITAL = 100000     # for the worked sizing example (UI uses user capital)

# style -> candidate config group (Decision 1)
STYLE_CONFIGS = {
    "short_term": ["ema_9_21", "rsi_mom_14", "macd_12_26_9"],
    "swing": ["ema_20_50", "bb_breakout_20", "donchian_20_10"],
    "long_term": ["ema_50_200", "ema_20_50"],
}

# config-level walk-forward (reuse P3 fold scheme, read from optimize params)
DEFAULT_WF = {"train": 252, "test": 126, "step": 126, "min_oos_trades": 15, "min_folds": 3}
MIN_POSITIVE_FOLD_FRAC = 0.50

_HOLIDAYS = None


def _load_holidays():
    global _HOLIDAYS
    if _HOLIDAYS is None:
        _HOLIDAYS = set()
        here = os.path.dirname(os.path.abspath(__file__))
        for p in (os.path.join(os.path.dirname(here), "data", "nse_holidays.json"),
                  os.path.join(here, "data", "nse_holidays.json")):
            try:
                with open(p, encoding="utf-8") as f:
                    d = json.load(f)
                for k, v in d.items():
                    if k.isdigit():
                        _HOLIDAYS.update(v)
                break
            except Exception:  # noqa: BLE001
                continue
    return _HOLIDAYS


def session_age(last_date, today=None):
    """Trading-session age (spec 6.6): NSE sessions strictly after `last_date`
    up to and including `today`, excluding weekends and NSE holidays."""
    try:
        d0 = _dt.date.fromisoformat(last_date)
    except Exception:  # noqa: BLE001
        return None
    today = today or _dt.date.today()
    hol = _load_holidays()
    age = 0
    d = d0 + _dt.timedelta(days=1)
    while d <= today:
        if d.weekday() < 5 and d.isoformat() not in hol:
            age += 1
        d += _dt.timedelta(days=1)
    return age


def _now_iso():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def _insufficient(style, failed, extra=None):
    rec = {"recommendation": "INSUFFICIENT_EVIDENCE", "eligibility": {"passed": False, "failed": failed},
           "evidence": "LOW", "reasons": ["Critical prerequisite failed: " + "; ".join(failed)],
           "warnings": []}
    if extra:
        rec.update(extra)
    return rec


def _config_walk_forward(bars, cfg_id, wf):
    """Re-validate ONE config on its own rolling folds (spec 4 step 4 -> E9)."""
    n = len(bars)
    train, test, step = wf["train"], wf["test"], wf["step"]
    trades, folds, pos_folds = [], 0, 0
    start = 0
    while start + train + test <= n:
        te_lo, te_hi = start + train, min(start + train + test, n)
        m, tr = bt.run_config(bars, cfg_id, te_lo, te_hi)
        trades.extend(tr)
        folds += 1
        if (m["total_ret_pct"] or 0) > 0:
            pos_folds += 1
        start += step
    m = bt.metrics(trades)
    pff = round(pos_folds / folds, 2) if folds else 0.0
    passed = (m["trades"] >= wf["min_oos_trades"] and folds >= wf["min_folds"]
              and pff >= MIN_POSITIVE_FOLD_FRAC and (m["expectancy_pct"] or 0) > 0
              and (m["profit_factor"] or 0) > 1.0)
    return {"oos_trades": m["trades"], "folds": folds, "positive_fold_frac": pff,
            "expectancy_pct": m["expectancy_pct"], "profit_factor": m["profit_factor"],
            "passed": passed}


def _select_config(style, regime_trend, p3, bars, wf):
    """Spec 4: shortlist style configs reliable in P3, rank by current-regime
    OOS, then re-validate the selected config on its own folds (E9). Returns
    (config_id, config_reliability, regime_suitable) or (None, None, None)."""
    per = (p3 or {}).get("per_config") or {}
    group = STYLE_CONFIGS[style]
    shortlist = []
    for cid in group:
        v = per.get(cid)
        if not v:
            continue
        oos = v.get("oos") or {}
        if (oos.get("trades") or 0) >= 15 and (oos.get("expectancy_pct") or 0) > 0 and (oos.get("profit_factor") or 0) > 1.0:
            byreg = (v.get("by_regime") or {}).get(regime_trend) or {}
            reg_exp = byreg.get("expectancy_pct") if (byreg.get("trades") or 0) >= 5 else None
            shortlist.append((cid, oos.get("expectancy_pct"), reg_exp))
    if not shortlist:
        return None, None, None
    # rank: regime-positive first (by regime expectancy), else by overall OOS expectancy
    regime_ok = [s for s in shortlist if s[2] is not None and s[2] > 0]
    if regime_ok:
        ranked = sorted(regime_ok, key=lambda s: s[2], reverse=True)
        regime_suitable = True
    else:
        ranked = sorted(shortlist, key=lambda s: (s[1] or -1e9), reverse=True)
        regime_suitable = False
    for cid, _, _ in ranked:
        cr = _config_walk_forward(bars, cid, wf)
        if cr["passed"]:
            return cid, cr, regime_suitable
    return None, None, regime_suitable


def _signal_state(bars, cfg_id):
    closes = [b.get("close") for b in bars]
    pos = bt.CONFIGS[cfg_id](bars, closes)
    sig_now = pos[-1] if pos else 0
    fresh_entry = len(pos) >= 2 and pos[-1] == 1 and pos[-2] == 0
    fresh_exit = len(pos) >= 2 and pos[-1] == 0 and pos[-2] == 1
    return sig_now, bool(fresh_entry), bool(fresh_exit)


def _risk_block(style, bars, regime_vol):
    closes = [b.get("close") for b in bars]
    price = closes[-1]
    atr = ind.atr(bars, 14)[-1]
    if not price or not atr:
        return None
    k = ATR_K[style] + (ATR_K_HIGHVOL_ADD if regime_vol == "HIGH_VOLATILITY" else 0.0)
    stop = price - k * atr
    risk = price - stop
    sr = ind.support_resistance(bars, price)
    resistance = sr.get("resistance")
    return {"price": round(price, 2), "atr": round(atr, 2), "k": k,
            "stop": round(stop, 2), "risk": round(risk, 2),
            "resistance": round(resistance, 2) if resistance else None,
            "support": round(sr.get("support"), 2) if sr.get("support") else None}


def _target_rr(style, rb, class_gate):
    """Spec 6.4: resistance target -> synthetic measured-move (ceiling-capped)
    -> else no_target. Returns (target, rr, no_target)."""
    price, risk, atr = rb["price"], rb["risk"], rb["atr"]
    if risk <= 0:
        return None, None, True
    resistance = rb["resistance"]
    if resistance and resistance > price and (resistance - price) / risk >= 1.0:
        rr = (resistance - price) / risk
        if rr >= class_gate:
            return round(resistance, 2), round(rr, 2), False
    # synthetic measured-move target at the class gate, capped by k_ceiling*ATR
    synth = price + class_gate * risk
    ceiling = price + K_CEILING[style] * atr
    if synth <= ceiling:
        return round(synth, 2), round(class_gate, 2), False
    return None, None, True


def _position_sizing(rb, capital=EXAMPLE_CAPITAL):
    price, risk = rb["price"], rb["risk"]
    if risk <= 0 or price <= 0:
        return {"shares": 0, "note": "no valid risk unit"}
    shares_by_risk = int((MAX_RISK_PCT * capital) // risk)
    shares_by_alloc = int((MAX_POSITION_PCT * capital) // price)
    shares = min(shares_by_risk, shares_by_alloc)
    binding = "risk" if shares_by_risk <= shares_by_alloc else "allocation"
    return {"capital_example": capital, "shares_by_risk": shares_by_risk,
            "shares_by_alloc": shares_by_alloc, "shares": shares, "binding_limit": binding,
            "position_value": round(shares * price, 2),
            "actual_risk": round(shares * risk, 2),
            "actual_risk_pct": round(100 * shares * risk / capital, 3) if capital else None,
            "actual_alloc_pct": round(100 * shares * price / capital, 2) if capital else None,
            "formula": "shares = min( floor(1%*capital / (entry-stop)), floor(20%*capital / entry) )"}


def _evidence(cr, regime_suitable, regime_vol, regime_trend, agree_count, data_fresh):
    """Spec 7 tiers (statistical only; verification kept separate)."""
    high_vol = regime_vol == "HIGH_VOLATILITY"
    uncertain = regime_trend == "UNCERTAIN"
    high = (cr["passed"] and (cr["profit_factor"] or 0) >= 1.5 and cr["positive_fold_frac"] >= 0.67
            and cr["oos_trades"] >= 30 and regime_suitable and data_fresh and agree_count >= 2
            and not high_vol and not uncertain)
    if high:
        return "HIGH"
    moderate = cr["passed"] and data_fresh and (regime_suitable or agree_count >= 2)
    if moderate:
        return "MODERATE"
    return "LOW"


def _agreement(cfg_bullish, regime_trend, weekly_action):
    """How many of {config, regime, weekly-engine} point bullish/long-supportive."""
    votes = 0
    if cfg_bullish:
        votes += 1
    if regime_trend == "BULLISH":
        votes += 1
    if weekly_action in ("BUY",):
        votes += 1
    return votes


def evaluate_style(style, p1, p2, p3, bars, weekly_ctx, wf):
    regime = ((p2 or {}).get("horizons") or {}).get(style) or {}
    regime_trend = regime.get("trend")
    regime_vol = regime.get("volatility")
    regime_rev = regime.get("reversal")

    # ---- 5A step 1: eligibility (fail-closed, terminal) ----
    failed = []
    if (p1 or {}).get("data_status") != "AVAILABLE_VALIDATED":
        failed.append("E1 data not AVAILABLE_VALIDATED (%s)" % (p1 or {}).get("data_status"))
    last_date = bars[-1]["date"] if bars else (p1 or {}).get("daily", {}).get("last_date")
    sage = session_age(last_date) if last_date else None
    data_fresh = sage is not None and sage <= FRESHNESS_SESSIONS
    if not data_fresh:
        failed.append("E2 stale: session_age=%s > %d" % (sage, FRESHNESS_SESSIONS))
    if (p3 or {}).get("optimization_status") != "COMPLETED":
        failed.append("E3 optimisation not COMPLETED (%s)" % (p3 or {}).get("optimization_status"))
    rel = ((p3 or {}).get("walk_forward") or {}).get("reliability") or {}
    if not rel.get("passed"):
        failed.append("E4 stock walk-forward not passed")
    if not regime_trend:
        failed.append("E8 no regime for this style")
    if len(bars) < wf["train"] + 2 * wf["test"]:
        failed.append("E10 insufficient daily bars for live signal/validation")
    if failed:
        return _insufficient(style, failed,
                             {"regime": {"trend": regime_trend, "volatility": regime_vol, "reversal": regime_rev},
                              "data_freshness": {"daily_last_date": last_date, "session_age": sage, "fresh": data_fresh}})

    # ---- E9: select + config-level walk-forward ----
    cfg_id, cr, regime_suitable = _select_config(style, regime_trend, p3, bars, wf)
    if not cfg_id:
        return _insufficient(style, ["E9 no style config passes its own walk-forward"],
                             {"regime": {"trend": regime_trend, "volatility": regime_vol, "reversal": regime_rev},
                              "data_freshness": {"daily_last_date": last_date, "session_age": sage, "fresh": data_fresh}})

    # ---- 5A step 2: live facts ----
    sig_now, fresh_entry, fresh_exit = _signal_state(bars, cfg_id)
    rb = _risk_block(style, bars, regime_vol)
    if rb is None:
        return _insufficient(style, ["E10 cannot compute price/ATR"], None)
    class_gate = RR_STRONG  # evaluate best-case target first; BUY gate re-checked below
    target, rr, no_target = _target_rr(style, rb, RR_BUY)   # at least BUY gate must be met to be buyable
    sizing = _position_sizing(rb)

    cfg_label = (((p3 or {}).get("per_config") or {}).get(cfg_id) or {}).get("label", cfg_id)
    weekly_action = (weekly_ctx or {}).get("weekly_action")
    qual = (weekly_ctx or {}).get("quality")        # PASS/NEAR/FAIL or None
    val = (weekly_ctx or {}).get("valuation")        # CHEAP/FAIR/EXPENSIVE or None
    cfg_bullish = sig_now == 1
    agree = _agreement(cfg_bullish, regime_trend, weekly_action)

    reasons, warnings = [], []
    reasons.append("Config %s passed its own walk-forward (OOS trades %d, PF %s, pos-folds %.0f%%)."
                   % (cfg_label, cr["oos_trades"], cr["profit_factor"], cr["positive_fold_frac"] * 100))
    if not regime_suitable:
        warnings.append("Selected config not validated in the current %s regime." % regime_trend)

    # ---- 5A step 3: base classification ----
    if fresh_exit or (regime_trend == "BEARISH" and sig_now == 0):
        rec = "SELL"
        reasons.append("Exit/avoid: config exited long" if fresh_exit else "Bearish regime, no long position.")
    elif fresh_entry and not no_target:
        rec = "BUY"   # may be upgraded to STRONG below; capped later
        reasons.append("Fresh new long entry with reward:risk %.2f (target %s, stop %s)." % (rr, target, rb["stop"]))
    elif sig_now == 1 and not fresh_entry:
        rec = "HOLD"
        reasons.append("Existing long position remains valid (no fresh entry).")
    elif fresh_entry and no_target:
        rec = "WAIT"
        warnings.append("Fresh entry but no defensible target / reward-risk — not buyable.")
        reasons.append("No defensible target (resistance too close/below or beyond ATR ceiling).")
    else:
        rec = "WAIT"
        reasons.append("No actionable long setup.")

    # candidate STRONG upgrade (new entry, bullish, reliable-in-bullish, RR>=2, no reversal)
    strong_target, strong_rr, strong_no = _target_rr(style, rb, RR_STRONG)
    strong_ok = (rec == "BUY" and regime_trend == "BULLISH" and regime_suitable
                 and regime_rev == "NONE" and not strong_no and strong_rr is not None and strong_rr >= RR_STRONG)
    if strong_ok:
        rec = "STRONG BUY"
        target, rr = strong_target, strong_rr

    # ---- 5A step 4: evidence ----
    evidence = _evidence(cr, regime_suitable, regime_vol, regime_trend, agree, data_fresh)

    # ---- 5A step 5: volatility risk adjustment already in rb (k). Re-check RR gate ----
    if rec in ("BUY", "STRONG BUY"):
        gate = RR_STRONG if rec == "STRONG BUY" else RR_BUY
        if rr is None or rr < gate:
            rec = "WAIT"
            warnings.append("Reward:risk below %.1f after volatility-adjusted stop." % gate)
    if regime_vol == "HIGH_VOLATILITY":
        warnings.append("High volatility — wider stop, reduce size.")

    # ---- 5A step 6: reversal downgrade (one step; a new-entry BUY -> WAIT, not
    #      HOLD, because HOLD means an EXISTING position) ----
    if regime_rev == "POTENTIAL_REVERSAL":
        if rec == "STRONG BUY":
            rec = "BUY"
            warnings.append("Potential reversal — downgraded from STRONG BUY.")
        elif rec == "BUY":
            rec = "WAIT"
            warnings.append("Potential reversal flagged — do not initiate a new long yet.")
        elif rec == "HOLD":
            warnings.append("Potential reversal against the existing position — watch the stop.")

    # ---- 5A step 7: fundamental / valuation conflict cap ----
    if qual == "FAIL":
        warnings.append("Fails fundamental quality (weekly-engine) — capped at BUY, shown not overridden.")
    if val == "EXPENSIVE":
        warnings.append("Looks expensive on valuation (weekly-engine) — capped at BUY.")
    if (qual == "FAIL" or val == "EXPENSIVE") and rec == "STRONG BUY":
        rec = "BUY"

    # ---- 5A step 8: evidence gate (final) ----
    if rec == "STRONG BUY" and evidence != "HIGH":
        rec = "BUY"
    if rec == "BUY" and evidence == "LOW":
        rec = "HOLD" if sig_now == 1 else "WAIT"
        warnings.append("Evidence only LOW — not an actionable new buy.")

    buyable = rec in ("BUY", "STRONG BUY")
    return {
        "recommendation": rec,
        "eligibility": {"passed": True, "failed": []},
        "config_used": {"id": cfg_id, "label": cfg_label},
        "config_reliability": cr,
        "regime": {"trend": regime_trend, "volatility": regime_vol, "reversal": regime_rev,
                   "confidence": regime.get("confidence"), "suitable": regime_suitable},
        "signal": {"sig_now": sig_now, "fresh_entry": fresh_entry, "fresh_exit": fresh_exit},
        "entry_ref": rb["price"] if buyable else None,
        "stop": rb["stop"] if buyable else None,
        "target": target if buyable else None,
        "rr": rr if buyable else None,
        "no_target": no_target,
        "atr": rb["atr"], "support": rb["support"], "resistance": rb["resistance"],
        "position_sizing": _position_sizing(rb) if buyable else None,
        "costs": {"historical_per_side_pct": HIST_COST_PER_SIDE_PCT,
                  "est_live_pct": EST_LIVE_COST_PCT, "slippage_pct": SLIPPAGE_PCT,
                  "note": "Historical cost already inside Phase-3 OOS metrics; live & slippage are separate forward estimates."},
        "evidence": evidence,
        "evidence_components": {"config_reliable": cr["passed"], "regime_suitable": regime_suitable,
                                "systems_agree": agree, "data_fresh": data_fresh,
                                "high_volatility": regime_vol == "HIGH_VOLATILITY"},
        "data_freshness": {"daily_last_date": last_date, "session_age": sage, "fresh": data_fresh},
        "reasons": reasons, "warnings": warnings,
        "news_factors": None, "last_monitored": None,
    }


def evaluate(symbol, name, p1, p2, p3, bars, weekly_ctx=None, wf=None):
    wf = wf or dict(DEFAULT_WF, **{k: (p3 or {}).get("params", {}).get(k, DEFAULT_WF[k])
                                   for k in ("train", "test", "step", "min_oos_trades", "min_folds")})
    bars = rg.completed_bars(bars or [], "1d")
    while bars and bars[-1].get("close") is None:
        bars = bars[:-1]
    styles = {}
    for style in ("short_term", "swing", "long_term"):
        try:
            styles[style] = evaluate_style(style, p1, p2, p3, bars, weekly_ctx, wf)
        except Exception as e:  # noqa: BLE001 — never let one style break the record
            styles[style] = _insufficient(style, ["internal error: %s" % str(e)[:120]])

    wk = weekly_ctx or {}
    signal_panel = {
        "optimized_config": {s: styles[s].get("config_used") for s in styles},
        "regime": {s: (styles[s].get("regime") or {}).get("trend") for s in styles},
        "fundamentals": wk.get("quality"), "valuation": wk.get("valuation"),
        "weekly_engine": {"action": wk.get("weekly_action"), "headline": wk.get("weekly_headline")},
        "agreement_note": "The weekly EMA 9/21/50 engine is shown independently; it is never merged or overridden.",
    }
    return {
        "symbol": symbol, "name": name, "methodology_version": METHODOLOGY_VERSION,
        "evaluated_at": _now_iso(),
        "provenance": {"provider": (p1 or {}).get("provenance", {}).get("provider"),
                       "data_ts": (p1 or {}).get("provenance", {}).get("data_ts"),
                       "daily_last_date": bars[-1]["date"] if bars else None,
                       "regime_methodology": (p2 or {}).get("methodology_version"),
                       "optimize_methodology": (p3 or {}).get("methodology_version")},
        "verification": {"independent_source_checked": False, "corporate_action_verified": False,
                         "note": "Yahoo-only data; NOT independently verified. Kept separate from evidence strength."},
        "styles": styles, "signal_panel": signal_panel,
    }
