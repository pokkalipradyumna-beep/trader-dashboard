"""Phase 7 batch: predictive outlooks for the 201-stock universe, from EXISTING
outputs only (no network, no re-scan). Writes data/outlook.json.

Fault tolerance: if the regime output is missing/empty, each stock still gets an
explicit INSUFFICIENT EVIDENCE outlook rather than a crash, and the previous
data/outlook.json is left in place only if this run produces nothing.

Run from the repo root:
    python -m intel.scan_outlook
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel import outlook as ol  # noqa: E402
from intel.scan_universe import _load_universe  # noqa: E402
from intel.store import JsonFileStore  # noqa: E402
from intel.datasource import _now_iso  # noqa: E402


def main():
    store = JsonFileStore()
    universe = _load_universe()
    regime = (store.get_regime() or {}).get("stocks", {})
    opt = (store.get_optimize() or {}).get("stocks", {})
    rec = (store.get_recommend() or {}).get("stocks", {})
    fund = (store.get_fundamentals_coverage() or {}).get("stocks", {})
    news = (store.get_news() or {}).get("stocks", {})
    now = _now_iso()

    records = {}
    for sym, name in universe:
        records[sym] = ol.build_stock(sym, name, regime.get(sym), opt.get(sym),
                                      rec.get(sym), fund.get(sym), news.get(sym), now)
    summary = ol.summarise(records)
    out = {"generated_at": now, "methodology_version": ol.METHODOLOGY_VERSION,
           "universe_size": len(universe),
           "upstream": {"regime_available": bool(regime), "optimize_available": bool(opt),
                        "recommend_available": bool(rec), "fundamentals_available": bool(fund)},
           "summary": summary,
           "limitations": [
               "Directional outlook only; no probability or price target.",
               "Predictive accuracy is NOT validated (outcome tracking postponed).",
               "Long-term outlook strength is capped where fundamentals are INSUFFICIENT_DATA.",
               "Reuses regime/optimize/recommend/fundamentals/news; not independently re-derived.",
           ],
           "stocks": records}
    # Guard: if regime was entirely missing, do not overwrite a prior good file.
    if not regime and store.get_outlook():
        print("Regime output missing; keeping previous outlook.json (not overwritten).")
        return
    store.put_outlook(out)
    sc = summary["direction_counts"]["swing"]
    print("Outlook: %d stocks, swing directions=%s" % (len(records), sc))


if __name__ == "__main__":
    main()
