"""Phase 2 offline batch: compute the Market Regime Engine output for the locked
201-stock universe, plus the market-wide (Nifty 50) context.

Run from the repo root:
    python -m intel.scan_regime            # resume
    python -m intel.scan_regime --fresh     # recompute all
    python -m intel.scan_regime --limit 10  # first N (testing)

Design / safeguards:
  * Independent of the weekly EMA 9/21/50 engine (engine.py) — read-only reuse of
    the data source only.
  * Uses the deduplicated 201-stock universe (Phase 1 correction).
  * Freshly fetches daily (2y) + weekly (6y) per stock, validates the series,
    then classifies with regime.py using COMPLETED candles only (no look-ahead).
  * Rate-limited (DELAY) + retries; a transient fetch failure preserves the last
    good regime record and logs the failure separately (fail-closed).
  * Sector regime is UNAVAILABLE in this phase (no sector-constituent data) and
    is reported as a limitation, not inferred from one stock (technical debt).
  * Writes data/regime.json atomically.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel import regime, validate  # noqa: E402
from intel.datasource import YahooSource, _now_iso  # noqa: E402
from intel.scan_universe import _load_universe  # noqa: E402 — deduped loader
from intel.store import JsonFileStore  # noqa: E402

DELAY = 0.7
RETRIES = 4
BACKOFF = 1.8
MARKET_SYMBOL = "^NSEI"      # Nifty 50 index (market-wide context)
MARKET_NAME = "Nifty 50"

TECH_DEBT = [
    "Sector regime not computed: no sector-constituent mapping in this phase "
    "(Phase 5/6). Reported as UNAVAILABLE, never inferred from one stock.",
    "Per-stock corporate-action 'reconciled' flag and raw/adjusted dual-series "
    "storage deferred to the next full data re-scan (Phase 1 record churn avoided now).",
    "Confidence is an evidence-strength label, NOT a statistically calibrated "
    "probability; calibration is future work (Phase 3 backtesting).",
    "Intraday regime unsupported: no validated intraday history (EOD only).",
]

LIMITATIONS = [
    "Market-wide regime uses Nifty 50 (^NSEI) only; breadth/advance-decline not included.",
    "Sector regime UNAVAILABLE this phase (no sector constituents) — not inferred from a single stock.",
    "Classifications are rule-based and explainable; they are NOT predictions and are not accuracy-validated.",
    "Yahoo data is ~15-min delayed, partial NSE coverage, not independently verified.",
    "Only completed candles are used; the latest forming candle is excluded (no look-ahead).",
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


def _series_status(fetched):
    """Validate a freshly fetched series -> (bars, status)."""
    if not fetched or not fetched.get("ok"):
        return [], "AWAITING_INSUFFICIENT"
    bars = fetched.get("bars") or []
    interval = fetched.get("interval") or "1d"
    v = validate.validate_history(bars, interval)
    return bars, v["quality"]


def evaluate_symbol(source, sym, name):
    daily = _fetch(source, sym, "1d", "2y")
    time.sleep(DELAY)
    weekly = _fetch(source, sym, "1wk", "6y")
    d_err = (daily.get("error") or {}).get("code") if daily else None
    w_err = (weekly.get("error") or {}).get("code") if weekly else None
    if d_err == "not_found" and w_err == "not_found":
        return {"symbol": sym, "name": name, "methodology_version": regime.METHODOLOGY_VERSION,
                "evaluated_at": _now_iso(), "unsupported": True,
                "horizons": {}, "note": "Symbol not found on provider — kept, not substituted.",
                "scan_ok": False}
    db, ds = _series_status(daily)
    wb, ws = _series_status(weekly)
    rec = regime.evaluate(sym, name, db, wb, ds, ws)
    rec["provenance"] = {"provider": source.name,
                         "daily": {"status": ds, "bars": len(db), "range": "2y"},
                         "weekly": {"status": ws, "bars": len(wb), "range": "6y"}}
    rec["scan_ok"] = bool((daily or {}).get("ok") and (weekly or {}).get("ok"))
    return rec


def market_context(source):
    rec = evaluate_symbol(source, MARKET_SYMBOL, MARKET_NAME)
    summary = {}
    for hz, h in (rec.get("horizons") or {}).items():
        summary[hz] = {"trend": h.get("trend"), "volatility": h.get("volatility"),
                       "reversal": h.get("reversal"), "confidence": h.get("confidence"),
                       "last_candle": h.get("last_candle")}
    return {"symbol": MARKET_SYMBOL, "name": MARKET_NAME,
            "available": not rec.get("unsupported") and bool(summary),
            "horizons": summary,
            "note": "Nifty 50 index regime; breadth not included." if summary
                    else "Market index data unavailable this run."}


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

    prev = (store.get_regime() or {}).get("stocks", {})
    state = (None if fresh else store.get_regime_state()) or {"done": []}
    done = set(state.get("done", []))
    out = dict(prev) if not fresh else {}
    run_started = _now_iso()
    processed = 0

    print("Market context: fetching %s ..." % MARKET_SYMBOL)
    market = market_context(source)
    print("  market short/swing/long:",
          {k: v["trend"] for k, v in (market.get("horizons") or {}).items()})

    print("Evaluating regime for %d stocks%s ..." % (len(universe), " [resume]" if done else ""))
    for i, (sym, name) in enumerate(universe, 1):
        if sym in done and not fresh and sym in out:
            continue
        try:
            rec = evaluate_symbol(source, sym, name)
            if not rec.get("scan_ok") and prev.get(sym, {}).get("horizons"):
                # transient failure AND we have real prior data -> keep last good
                kept = dict(prev[sym])
                kept["last_scan_at"] = _now_iso()
                kept["scan_ok"] = False
                kept["last_scan_note"] = "Transient fetch failure — kept last good regime."
                rec = kept
        except Exception as e:  # noqa: BLE001 — never let one stock stop the run
            rec = prev.get(sym) or {"symbol": sym, "name": name, "horizons": {}}
            rec = dict(rec)
            rec["scan_ok"] = False
            rec["last_scan_error"] = str(e)[:160]
        out[sym] = rec
        done.add(sym)
        processed += 1
        # periodic atomic checkpoint so a crash keeps progress (less frequent
        # writes reduce Windows lock contention on the data dir)
        if processed % 10 == 0:
            store.put_regime_state({"done": sorted(done), "updated_at": _now_iso()})
            store.put_regime(_build(out, market, universe))
        top = (rec.get("horizons", {}).get("swing") or {})
        print("  [%d/%d] %-16s %s/%s%s" % (i, len(universe), sym,
              top.get("trend", "?"), top.get("volatility", "?"),
              "" if rec.get("scan_ok", True) else "  (scan issue)"))
        time.sleep(DELAY)

    store.put_regime_state({"done": sorted(done), "updated_at": _now_iso()})
    store.put_regime(_build(out, market, universe))
    print("\nDone. processed=%d  stocks=%d" % (processed, len(out)))
    print("storage:", store.usage())


def _tally(out):
    dims = {"trend": {}, "volatility": {}, "reversal": {}}
    for rec in out.values():
        sw = (rec.get("horizons", {}) or {}).get("swing") or {}
        for d in dims:
            v = sw.get(d, "UNCERTAIN" if d != "reversal" else "NONE")
            dims[d][v] = dims[d].get(v, 0) + 1
    return dims


def _build(out, market, universe):
    names = {s: n for s, n in universe}
    evaluated = sum(1 for r in out.values() if r.get("horizons"))
    insufficient = [s for s, r in out.items()
                    if all(h.get("trend") == "UNCERTAIN"
                           for h in (r.get("horizons") or {"x": {"trend": "UNCERTAIN"}}).values())]
    return {
        "generated_at": _now_iso(),
        "methodology_version": regime.METHODOLOGY_VERSION,
        "universe_size": len(universe),
        "evaluated": evaluated,
        "insufficient_or_uncertain": len(insufficient),
        "swing_tally": _tally(out),
        "market": market,
        "sector": {"available": False,
                   "note": "Sector regime not computed this phase (no sector constituents)."},
        "limitations": LIMITATIONS,
        "technical_debt": TECH_DEBT,
        "stocks": out,
    }


if __name__ == "__main__":
    main()
