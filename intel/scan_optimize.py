"""Phase 3 offline batch: walk-forward optimisation for the locked 201-stock
universe. Writes data/optimize.json.

Run from the repo root:
    python -m intel.scan_optimize            # resume
    python -m intel.scan_optimize --fresh     # recompute all
    python -m intel.scan_optimize --limit 10  # first N (testing)

Safeguards:
  * Deduplicated 201-stock universe; never added to or substituted.
  * Fetches daily 5y per stock (one request), validates, then runs the
    walk-forward optimiser (optimize.py) — out-of-sample, reliability-gated.
  * Rate-limited + retries; a transient failure preserves the last good result
    and records the failure separately (fail-closed). not_found -> UNSUPPORTED.
  * optimization_status is one of COMPLETED / INSUFFICIENT_EVIDENCE / FAILED /
    (UNSUPPORTED) — "data available" is never conflated with "optimised".
  * Writes atomically; resumable via optimize_state.json.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel import optimize as opt  # noqa: E402
from intel import validate  # noqa: E402
from intel.datasource import YahooSource, _now_iso  # noqa: E402
from intel.scan_universe import _load_universe  # noqa: E402
from intel.store import JsonFileStore  # noqa: E402

DELAY = 1.1
RETRIES = 4
BACKOFF = 1.8

OPT_STATUSES = ["NOT_RUN", "COMPLETED", "INSUFFICIENT_EVIDENCE", "FAILED", "UNSUPPORTED"]

LIMITATIONS = [
    "Walk-forward out-of-sample, but on a FIXED pre-registered config set; survivorship bias remains.",
    "Costs netted at 0.10%/side; real slippage, taxes (STT) and impact differ.",
    "Long-only, daily EOD only; intraday not optimised.",
    "Reliability-gated: COMPLETED needs >=15 OOS trades, >=3 folds, net-positive consistent expectancy; else INSUFFICIENT_EVIDENCE (a valid result).",
    "Confidence is evidence strength, NOT a calibrated probability. Past performance is NOT predictive.",
    "Yahoo data ~15-min delayed, partial NSE coverage, not independently verified.",
]
TECH_DEBT = [
    "No parameter search beyond the pre-registered set (would need stronger overfitting controls).",
    "Regime attribution uses a lightweight causal trend/volatility tag, not the full regime engine per bar.",
    "Calibration of confidence to realised hit-rates is future work.",
]


def _fetch(source, sym, interval, rng):
    last = None
    for attempt in range(RETRIES):
        r = source.get_history(sym, interval, rng)
        if r.get("ok"):
            return r
        last = r
        if (r.get("error") or {}).get("code") == "not_found":
            return r
        time.sleep(DELAY * (BACKOFF ** attempt))
    return last


def evaluate_symbol(source, sym, name):
    f = _fetch(source, sym, "1d", "5y")
    if not f or (not f.get("ok") and (f.get("error") or {}).get("code") == "not_found"):
        return {"symbol": sym, "name": name, "methodology_version": opt.METHODOLOGY_VERSION,
                "evaluated_at": _now_iso(), "optimization_status": "UNSUPPORTED",
                "reason": "symbol not found on provider — kept, not substituted.",
                "scan_ok": False}
    if not f.get("ok"):
        return None  # transient — caller preserves prior
    bars = f.get("bars") or []
    v = validate.validate_history(bars, "1d")
    rec = opt.evaluate(sym, name, bars, v["quality"])
    rec["provenance"] = {"provider": source.name, "source_symbol": f.get("source_symbol"),
                         "price_basis": f.get("price_basis"), "range": "5y",
                         "daily_validation": v["quality"]}
    rec["scan_ok"] = True
    return rec


def main():
    args = sys.argv[1:]
    fresh = "--fresh" in args
    limit = None
    if "--limit" in args:
        try:
            limit = int(args[args.index("--limit") + 1])
        except Exception:  # noqa: BLE001
            pass

    universe = _load_universe()
    if limit:
        universe = universe[:limit]
    store = JsonFileStore()
    source = YahooSource()
    prev = (store.get_optimize() or {}).get("stocks", {})
    state = (None if fresh else store.get_optimize_state()) or {"done": []}
    done = set(state.get("done", []))
    out = dict(prev) if not fresh else {}
    run_started = _now_iso()
    processed = 0

    print("Walk-forward optimisation for %d stocks%s ..." % (len(universe), " [resume]" if done else ""))
    for i, (sym, name) in enumerate(universe, 1):
        if sym in done and not fresh and sym in out:
            continue
        try:
            rec = evaluate_symbol(source, sym, name)
            if rec is None:  # transient failure
                if prev.get(sym) and prev[sym].get("optimization_status") not in (None, "UNSUPPORTED"):
                    rec = dict(prev[sym]); rec["scan_ok"] = False
                    rec["last_scan_note"] = "Transient fetch failure — kept last good optimisation."
                else:
                    rec = {"symbol": sym, "name": name, "optimization_status": "FAILED",
                           "reason": "fetch failed", "scan_ok": False,
                           "methodology_version": opt.METHODOLOGY_VERSION, "evaluated_at": _now_iso()}
        except Exception as e:  # noqa: BLE001 — never let one stock stop the run
            rec = prev.get(sym) or {"symbol": sym, "name": name}
            rec = dict(rec); rec["scan_ok"] = False
            rec["optimization_status"] = rec.get("optimization_status") or "FAILED"
            rec["last_scan_error"] = str(e)[:160]
        out[sym] = rec
        done.add(sym)
        processed += 1
        if processed % 10 == 0:
            store.put_optimize_state({"done": sorted(done), "updated_at": _now_iso()})
            store.put_optimize(_build(out, universe))
        print("  [%d/%d] %-16s %s" % (i, len(universe), sym, rec.get("optimization_status")))
        time.sleep(DELAY)

    store.put_optimize_state({"done": sorted(done), "updated_at": _now_iso()})
    store.put_optimize(_build(out, universe))
    print("\nDone. processed=%d  stocks=%d" % (processed, len(out)))
    print("storage:", store.usage())


def _counts(out):
    c = {s: 0 for s in OPT_STATUSES}
    for r in out.values():
        st = r.get("optimization_status", "NOT_RUN")
        c[st] = c.get(st, 0) + 1
    return c


def _config_leaderboard(out):
    """Among COMPLETED stocks, how often is each config the best-overall, and its
    mean OOS expectancy by regime — the 'which config works in which regime' view."""
    best_counts = {}
    regime_exp = {}
    for r in out.values():
        if r.get("optimization_status") != "COMPLETED":
            continue
        b = r.get("best_config_overall")
        if b:
            best_counts[b] = best_counts.get(b, 0) + 1
        for cid, v in (r.get("per_config") or {}).items():
            for reg, m in (v.get("by_regime") or {}).items():
                if m.get("expectancy_pct") is not None and (m.get("trades") or 0) >= 5:
                    regime_exp.setdefault(reg, {}).setdefault(cid, []).append(m["expectancy_pct"])
    regime_best = {}
    for reg, cfgs in regime_exp.items():
        means = {cid: round(sum(xs) / len(xs), 3) for cid, xs in cfgs.items()}
        regime_best[reg] = sorted(means.items(), key=lambda kv: kv[1], reverse=True)[:3]
    return {"best_config_counts": best_counts, "regime_top_configs": regime_best}


def _build(out, universe):
    counts = _counts(out)
    return {"generated_at": _now_iso(), "methodology_version": opt.METHODOLOGY_VERSION,
            "universe_size": len(universe),
            "optimized": counts.get("COMPLETED", 0),
            "insufficient_evidence": counts.get("INSUFFICIENT_EVIDENCE", 0),
            "counts": counts, "config_leaderboard": _config_leaderboard(out),
            "params": {"train": opt.TRAIN, "test": opt.TEST, "step": opt.STEP,
                       "min_oos_trades": opt.MIN_OOS_TRADES, "min_folds": opt.MIN_FOLDS,
                       "cost_per_side_pct": 0.10},
            "limitations": LIMITATIONS, "technical_debt": TECH_DEBT, "stocks": out}


if __name__ == "__main__":
    main()
