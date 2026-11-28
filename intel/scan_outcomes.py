"""Phase 7 offline batch: forward outcome tracking for recommendation events.

Reads data/recommend_history.jsonl (never modified), fetches adjusted daily
bars for the symbols that still have unevaluated horizons, appends each
COMPLETED horizon result to data/outcome_events.jsonl (append-only), and
rewrites the single summary file data/outcomes.json.

Run from the repo root:
    python -m intel.scan_outcomes             # resume (only missing horizons)
    python -m intel.scan_outcomes --limit 5   # first N symbols (testing)
"""
import datetime as _dt
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel import outcomes as oc  # noqa: E402
from intel.datasource import YahooSource, _now_iso  # noqa: E402
from intel.store import JsonFileStore  # noqa: E402

DELAY = 1.0
RANGE = "1y"
METHODOLOGY_VERSION = "outcomes-v1.0"
LIMITATIONS = [
    "Forward outcomes of SIMULATED recommendations; not actual portfolio performance.",
    "Entry = adjusted close of the first session after the signal date (proxy for a next-session fill); intrabar fills not modelled.",
    "Costs, slippage and liquidity are NOT deducted in these returns.",
    "Only COMPLETED horizons are reported; a horizon still pending is never counted as a win or loss.",
    "Yahoo-only prices, ~15-min delayed, not independently verified.",
    "Survivorship: only currently listed universe symbols are tracked.",
    "Buckets below the minimum sample size are flagged and must not be interpreted.",
]


def _run_date():
    return _dt.datetime.now(_dt.timezone.utc).date().isoformat()


def main():
    args = sys.argv[1:]
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    store = JsonFileStore()
    source = YahooSource()
    run_date = _run_date()

    events = store.read_recommend_history()
    done = {(e.get("rec_id"), e.get("horizon")) for e in store.read_outcome_events()}
    settled = {}  # rec_id -> set of horizons with a final status (any status)
    for (rid, h) in done:
        settled.setdefault(rid, set()).add(h)
    by_symbol = {}
    for ev in events:
        if not ev.get("symbol") or not (ev.get("provenance") or {}).get("daily_last_date"):
            continue
        if set(oc.HORIZONS) <= settled.get(ev.get("id"), set()):
            continue  # fully settled, nothing more can change
        by_symbol.setdefault(ev["symbol"], []).append(ev)

    syms = sorted(by_symbol)
    if limit:
        syms = syms[:limit]
    print("Outcome tracking: %d events in history, %d symbols need evaluation, run_date=%s"
          % (len(events), len(syms), run_date))
    written = failed_fetch = 0
    for i, sym in enumerate(syms, 1):
        res = source.get_history(sym, "1d", RANGE)
        if not res.get("ok"):
            failed_fetch += 1
            print("  [%d/%d] %-16s fetch failed: %s" % (i, len(syms), sym, (res.get("error") or {}).get("code")))
            time.sleep(DELAY)
            continue
        bars = res.get("bars") or []
        has_adj = bool(res.get("has_adjclose"))
        for ev in by_symbol[sym]:
            for rec in oc.evaluate_event(ev, bars, run_date, has_adjclose=has_adj):
                key = (rec["rec_id"], rec["horizon"])
                if key in done:
                    continue
                rec.update({"evaluated_at": _now_iso(), "methodology_version": METHODOLOGY_VERSION,
                            "price_source": source.name})
                store.append_outcome_event(rec)
                done.add(key)
                written += 1
        print("  [%d/%d] %-16s bars=%d" % (i, len(syms), sym, len(bars)))
        time.sleep(DELAY)

    _write_summary(store, events, run_date, failed_fetch)
    print("\nDone. new_outcome_records=%d failed_fetches=%d" % (written, failed_fetch))
    print("storage:", store.usage())


def _write_summary(store, events, run_date, failed_fetch):
    recs = store.read_outcome_events()
    by_rec = {}
    for r in recs:
        by_rec.setdefault(r["rec_id"], {})[r["horizon"]] = r["status"]
    per_h = {}
    for h in oc.HORIZONS:
        evaluated = sum(1 for r in recs if r["horizon"] == h and r["status"] == "EVALUATED")
        no_adj = sum(1 for r in recs if r["horizon"] == h and r["status"] == "NO_ADJCLOSE")
        per_h[str(h)] = {"evaluated": evaluated, "no_adjclose": no_adj,
                         "awaiting": len(events) - evaluated - no_adj}
    actionable = [e for e in events if e.get("new_recommendation") in oc.ACTIONABLE]
    summary = {
        "generated_at": _now_iso(), "run_date": run_date,
        "methodology_version": METHODOLOGY_VERSION,
        "history_events": len(events),
        "actionable_events": len(actionable),
        "by_horizon": per_h,
        "fetch_failures_this_run": failed_fetch,
        "rows": oc.summarise(recs),
        "min_sample": oc.MIN_SAMPLE,
        "horizons_sessions": list(oc.HORIZONS),
        "limitations": LIMITATIONS,
    }
    store.put_outcomes(summary)


if __name__ == "__main__":
    main()
