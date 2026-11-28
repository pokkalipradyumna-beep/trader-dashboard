"""Phase 1 offline batch: scan the LOCKED symbols.json universe, validate each
stock's historical data quality, and write the coverage registry.

Run manually from the repo root:
    python -m intel.scan_universe            # resume (skip already-scanned)
    python -m intel.scan_universe --fresh     # ignore prior scan state
    python -m intel.scan_universe --limit 20  # first N (testing)

Safeguards:
  * Universe is the EXACT symbols.json set — never added to or substituted.
  * Retries + delay + resumable progress; a transient (feed_down) failure does
    NOT downgrade a previously-good stock — the last successful record is kept
    and the new failure is recorded separately (fail-closed, 2.6).
  * universe.json is written atomically at the end, so a crash leaves the prior
    good file intact.
  * Generates NO optimisation or recommendation results.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel.datasource import YahooSource, _now_iso  # noqa: E402
from intel.store import JsonFileStore  # noqa: E402
from intel import validate  # noqa: E402

DELAY = 0.4        # polite spacing between stocks (rate-limit aware)
RETRIES = 3
BACKOFF = 1.6

DATA_STATUSES = ["AVAILABLE_VALIDATED", "PARTIAL", "AWAITING_INSUFFICIENT", "UNSUPPORTED", "DELISTED"]
OPT_STATUSES = ["NOT_RUN", "COMPLETED", "INSUFFICIENT_EVIDENCE", "FAILED"]
REC_STATUSES = ["NONE", "AVAILABLE", "INSUFFICIENT_EVIDENCE"]

LIMITATIONS = [
    "Universe is the locked symbols.json set (~200) — NOT the full NSE. Coverage is not complete.",
    "Data provider is Yahoo Finance only: ~15-min delayed, partial NSE coverage, not independently verified.",
    "Survivorship bias: only currently-listed stocks are present; delisted/renamed histories are not available, so any future backtest will read optimistically.",
    "Adjusted-price (adjclose) availability is recorded, but its correctness for every corporate action is NOT assumed.",
    "Intraday is unsupported/experimental — no intraday historical data is validated here.",
    "'Data available' is not 'fully analysed': optimisation and recommendations are separate statuses (NOT_RUN / NONE in this phase).",
]


def _load_universe():
    """Locked symbols.json, DEDUPLICATED to unique tickers (Phase 1 correction).

    symbols.json contains a literal duplicate (HINDUNILVR.NS x2); we keep ALL
    unique stocks (first occurrence wins) and never add/remove a real stock, so
    counts reflect the true 201-stock universe instead of double-counting.
    """
    for p in (os.path.join(ROOT, "symbols.json"), os.path.join(ROOT, "public", "symbols.json")):
        try:
            with open(p, encoding="utf-8") as f:
                rows = json.load(f)
            out, seen = [], set()
            for d in rows:
                t = d.get("t")
                if not t or t.upper() in seen:
                    continue
                seen.add(t.upper())
                out.append((t, d.get("n") or t))
            return out
        except Exception:  # noqa: BLE001
            continue
    raise SystemExit("symbols.json not found")


def _exchange(sym):
    s = sym.upper()
    return "NSE" if s.endswith(".NS") else "BSE" if s.endswith(".BO") else "unknown"


def _fetch(source, sym, interval, rng):
    last = None
    for attempt in range(RETRIES):
        r = source.get_history(sym, interval, rng)
        if r.get("ok"):
            return r
        last = r
        if (r.get("error") or {}).get("code") == "not_found":
            return r  # permanent — don't retry
        time.sleep(DELAY * (BACKOFF ** attempt))
    return last


def _combine_status(daily_q, weekly_q):
    if weekly_q == "AVAILABLE_VALIDATED" and daily_q == "AVAILABLE_VALIDATED":
        return "AVAILABLE_VALIDATED"
    if "AVAILABLE_VALIDATED" in (daily_q, weekly_q) or "PARTIAL" in (daily_q, weekly_q):
        return "PARTIAL"
    return "AWAITING_INSUFFICIENT"


def scan_stock(source, sym, name, prev):
    exch = _exchange(sym)
    daily = _fetch(source, sym, "1d", "1y")
    time.sleep(DELAY)
    weekly = _fetch(source, sym, "1wk", "5y")

    ok = bool(daily.get("ok")) and bool(weekly.get("ok"))
    # Permanent "not found" on BOTH -> UNSUPPORTED (record, never substitute).
    d_err = (daily.get("error") or {}).get("code")
    w_err = (weekly.get("error") or {}).get("code")
    if d_err == "not_found" and w_err == "not_found":
        rec = {"symbol": sym, "name": name, "exchange": exch, "data_status": "UNSUPPORTED",
               "optimization_status": "NOT_RUN", "recommendation_status": "NONE",
               "daily": None, "weekly": None, "corporate_actions": None,
               "provenance": {"provider": source.name, "source_symbol": daily.get("source_symbol"),
                              "retrieved_at": _now_iso(), "provider_note": source.provider_note},
               "limitations": ["Symbol not found on the provider (renamed/delisted/unavailable) — kept, not substituted."],
               "verification": {"independent_source_checked": False,
                                "note": "No independent source verified in Phase 1."},
               "last_scan_at": _now_iso(), "last_scan_ok": False,
               "last_scan_error": {"daily": daily.get("error"), "weekly": weekly.get("error")}}
        return rec

    # Transient feed failure (couldn't fetch, not a 'not found'): preserve the
    # last successful record and record the new failure separately (fail-closed).
    if not ok and prev and prev.get("data_status") not in (None, "UNSUPPORTED"):
        kept = dict(prev)
        kept["last_scan_at"] = _now_iso()
        kept["last_scan_ok"] = False
        kept["last_scan_error"] = {"daily": daily.get("error"), "weekly": weekly.get("error"),
                                   "note": "Transient fetch failure — kept last successful data."}
        return kept

    dv = validate.validate_history(daily.get("bars") if daily.get("ok") else [], "1d")
    wv = validate.validate_history(weekly.get("bars") if weekly.get("ok") else [], "1wk")
    data_status = _combine_status(dv["quality"], wv["quality"]) if ok else "AWAITING_INSUFFICIENT"

    meta = (weekly.get("meta") if weekly.get("ok") else daily.get("meta")) or {}
    ca = {"splits": len((weekly.get("splits") or []) or (daily.get("splits") or [])),
          "dividends": len((weekly.get("dividends") or []) or (daily.get("dividends") or [])),
          "has_adjclose": bool(daily.get("has_adjclose") or weekly.get("has_adjclose")),
          "note": "Corporate actions from the provider; adjusted-price correctness per action is not assumed."}

    return {
        "symbol": sym, "name": name, "exchange": exch, "data_status": data_status,
        "optimization_status": "NOT_RUN", "recommendation_status": "NONE",
        "provenance": {"provider": source.name, "source_symbol": daily.get("source_symbol"),
                       "retrieved_at": _now_iso(), "price_basis": daily.get("price_basis"),
                       "currency": meta.get("currency"), "exchange_name": meta.get("exchange"),
                       "data_ts": meta.get("data_ts"), "instrument": meta.get("instrument"),
                       "provider_note": source.provider_note},
        "daily": dv, "weekly": wv, "corporate_actions": ca,
        "limitations": (["adjusted-price series unavailable — splits/bonuses may distort history"] if not ca["has_adjclose"] else [])
                       + (wv["issues"][:3] if wv["issues"] else []),
        "verification": {"independent_source_checked": False,
                         "note": "No independent source verified in Phase 1; provider is Yahoo only."},
        "last_scan_at": _now_iso(), "last_scan_ok": ok,
        "last_scan_error": None if ok else {"daily": daily.get("error"), "weekly": weekly.get("error")},
    }


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
    state = (None if fresh else store.get_scan_state()) or {"done": [], "started_at": _now_iso()}
    done = set(state.get("done", []))
    run_started = _now_iso()
    processed = 0

    print("Scanning %d stocks (locked universe)%s ..." % (len(universe), " [resume]" if done else ""))
    for i, (sym, name) in enumerate(universe, 1):
        if sym in done and not fresh:
            continue
        prev = store.get_stock(sym)
        try:
            rec = scan_stock(YahooSource(), sym, name, prev)
        except Exception as e:  # noqa: BLE001 — never let one stock stop the run
            rec = (prev or {"symbol": sym, "name": name, "exchange": _exchange(sym)})
            rec = dict(rec); rec["last_scan_at"] = _now_iso(); rec["last_scan_ok"] = False
            rec["last_scan_error"] = {"code": "scan_exception", "message": str(e)[:160]}
            if "data_status" not in rec:
                rec["data_status"] = "AWAITING_INSUFFICIENT"
            rec.setdefault("optimization_status", "NOT_RUN"); rec.setdefault("recommendation_status", "NONE")
        store.put_stock(sym, rec)
        done.add(sym); processed += 1
        store.put_scan_state({"done": sorted(done), "started_at": state.get("started_at"), "updated_at": _now_iso()})
        print("  [%d/%d] %-16s %s%s" % (i, len(universe), sym, rec.get("data_status"),
              "" if rec.get("last_scan_ok") else "  (scan issue)"))
        time.sleep(DELAY)

    # Build the summary registry atomically from all stored per-stock records.
    stocks, counts = [], {"data": {s: 0 for s in DATA_STATUSES},
                          "optimization": {s: 0 for s in OPT_STATUSES},
                          "recommendation": {s: 0 for s in REC_STATUSES}}
    for sym, name in _load_universe():
        r = store.get_stock(sym)
        if not r:
            counts["data"]["AWAITING_INSUFFICIENT"] += 1
            stocks.append({"symbol": sym, "name": name, "exchange": _exchange(sym),
                           "data_status": "AWAITING_INSUFFICIENT", "optimization_status": "NOT_RUN",
                           "recommendation_status": "NONE", "bars_daily": 0, "bars_weekly": 0,
                           "last_data_date": None, "issues": 0})
            continue
        ds = r.get("data_status", "AWAITING_INSUFFICIENT")
        counts["data"][ds] = counts["data"].get(ds, 0) + 1
        counts["optimization"][r.get("optimization_status", "NOT_RUN")] += 1
        counts["recommendation"][r.get("recommendation_status", "NONE")] += 1
        dv, wv = r.get("daily") or {}, r.get("weekly") or {}
        stocks.append({"symbol": sym, "name": name, "exchange": r.get("exchange"),
                       "data_status": ds, "optimization_status": r.get("optimization_status", "NOT_RUN"),
                       "recommendation_status": r.get("recommendation_status", "NONE"),
                       "bars_daily": dv.get("bars", 0), "bars_weekly": wv.get("bars", 0),
                       "last_data_date": wv.get("last_date") or dv.get("last_date"),
                       "stale_days": wv.get("stale_days"),
                       "issues": len((dv.get("issues") or [])) + len((wv.get("issues") or [])),
                       "scan_ok": r.get("last_scan_ok", True)})

    summary = {"generated_at": _now_iso(), "universe_size": len(stocks),
               "source": "symbols.json (locked)", "provider": YahooSource.name,
               "counts": counts, "limitations": LIMITATIONS, "stocks": stocks}
    store.put_universe(summary)
    store.append_run({"run_started": run_started, "finished_at": _now_iso(),
                      "processed": processed, "universe_size": len(stocks), "counts": counts,
                      "storage": store.usage()})
    print("\nDone. processed=%d  data-counts=%s" % (processed, counts["data"]))
    print("storage:", store.usage())


if __name__ == "__main__":
    main()
