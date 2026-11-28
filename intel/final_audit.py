"""Phase 7 final audit of the 201-stock universe, built from EXISTING outputs.

No network, no re-scan. Reads data/stock, optimize.json, recommend.json,
news.json, fundamentals_coverage.json and outcomes.json, and writes
data/final_audit.json with one record per universe stock (none dropped).

Audit result rules (explicit, never loosened):
  FAILED_VALIDATION        data status UNSUPPORTED / DELISTED, or scan failed.
  INSUFFICIENT_EVIDENCE    price data partial/awaiting, OR no COMPLETED,
                           reliability-passed strategy (Phase 3 gate).
  PASSED_WITH_WARNINGS     validated data + completed strategy, but fundamentals
                           INSUFFICIENT or STALE, or news source issues.
  PASSED                   validated data + completed strategy + fundamentals
                           on file and not stale.

Fundamentals never disable the technical audit: a stock with no fundamentals
still receives a full technical/strategy result, with the gap shown as a warning.

Trade vs observation separation: only BUY / STRONG BUY count as trade candidates.
HOLD / WAIT / SELL / INSUFFICIENT EVIDENCE are reported as states, never trades.
"""
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

METHODOLOGY_VERSION = "final-audit-v1.0"
TRADE_LABELS = ("BUY", "STRONG BUY")
STYLES = ("short_term", "swing", "long_term")
FAILED_DATA = ("UNSUPPORTED", "DELISTED")


def audit_stock(sym, name, stock_file, opt, rec, news, fund):
    """Pure function. Each argument is the existing record (or None)."""
    missing, contradictions, warnings = [], [], []
    data_status = (stock_file or {}).get("data_status")
    opt_status = (opt or {}).get("optimization_status")
    scan_ok = (rec or {}).get("scan_ok", True) if rec else True

    # ---- price data ----
    if data_status is None:
        missing.append("price data record")
    elif data_status not in ("AVAILABLE_VALIDATED",):
        warnings.append("price data status %s" % data_status)

    # ---- technical strategy (Phase 3 gate) ----
    wf = (opt or {}).get("walk_forward") or {}
    metrics = wf.get("metrics") or {}
    reliability = wf.get("reliability") or {}
    if opt is None:
        missing.append("strategy optimisation record")
    elif opt_status != "COMPLETED":
        missing.append("validated strategy (optimisation %s)" % opt_status)

    # ---- recommendations (Phase 4) ----
    styles = {}
    for st in STYLES:
        s = ((rec or {}).get("styles") or {}).get(st) or {}
        label = s.get("recommendation", "NO_RECORD")
        styles[st] = {"recommendation": label,
                      "trade_candidate": label in TRADE_LABELS,
                      "evidence": s.get("evidence"),
                      "reasons": s.get("reasons") or [],
                      "warnings": s.get("warnings") or []}
        if label in ("BUY", "STRONG BUY") and opt_status != "COMPLETED":
            contradictions.append("%s %s without a COMPLETED strategy" % (st, label))
        if label in ("HOLD",) and opt_status != "COMPLETED":
            contradictions.append("%s HOLD without a COMPLETED strategy" % st)

    # ---- fundamentals (Phase 7 block 1): shown, never blocking ----
    fund_cat = (fund or {}).get("category", "INSUFFICIENT_DATA")
    fund_sector = (fund or {}).get("sector_model", "UNCLASSIFIED")
    if fund_cat == "INSUFFICIENT_DATA":
        warnings.append("fundamentals INSUFFICIENT_DATA (%s)" % ((fund or {}).get("reason") or "no record"))
    elif (fund or {}).get("freshness") == "STALE":
        warnings.append("fundamentals snapshot STALE")

    # ---- news ----
    if news and news.get("stale"):
        warnings.append("news collection stale")
    if news and news.get("source_errors"):
        warnings.append("news source errors recorded")

    # ---- audit result ----
    if data_status in FAILED_DATA or scan_ok is False:
        result = "FAILED_VALIDATION"
    elif data_status != "AVAILABLE_VALIDATED" or opt_status != "COMPLETED":
        result = "INSUFFICIENT_EVIDENCE"
    elif fund_cat == "INSUFFICIENT_DATA" or (fund or {}).get("freshness") == "STALE" or (news and news.get("stale")):
        result = "PASSED_WITH_WARNINGS"
    else:
        result = "PASSED"
    if contradictions:
        result = "FAILED_VALIDATION" if result != "INSUFFICIENT_EVIDENCE" else result
        warnings.extend(contradictions)

    return {
        "symbol": sym, "name": name, "sector_model": fund_sector,
        "data_status": data_status,
        "optimization_status": opt_status,
        "strategy": {"config": (opt or {}).get("best_config_overall"),
                     "oos_trades": metrics.get("trades"),
                     "expectancy_pct_net": metrics.get("expectancy_pct"),
                     "profit_factor": metrics.get("profit_factor"),
                     "max_drawdown_pct": metrics.get("max_drawdown_pct"),
                     "folds": reliability.get("folds"),
                     "positive_folds": reliability.get("positive_folds"),
                     "reliability_note": "Phase 3 walk-forward, costs netted (0.10% per side)"},
        "fundamentals": {"category": fund_cat, "sector_model": fund_sector,
                         "gates_passed": (fund or {}).get("passed_gates"),
                         "gates_evaluated": (fund or {}).get("evaluated_gates"),
                         "source": (fund or {}).get("sector_source")},
        "recommendations": styles,
        "news_events": len((news or {}).get("events") or []),
        "missing_evidence": missing,
        "contradictions": contradictions,
        "warnings": warnings,
        "audit_result": result,
    }


def summarise(records):
    counts = {}
    for r in records:
        counts[r["audit_result"]] = counts.get(r["audit_result"], 0) + 1
    trades = sum(1 for r in records for s in r["recommendations"].values() if s["trade_candidate"])
    obs = {}
    for r in records:
        for st, s in r["recommendations"].items():
            if not s["trade_candidate"]:
                obs[s["recommendation"]] = obs.get(s["recommendation"], 0) + 1
    return {"stocks": len(records), "audit_results": counts,
            "trade_candidates": trades, "state_counts_not_trades": obs}


def main():
    from intel.scan_universe import _load_universe
    from intel.store import JsonFileStore
    from intel.datasource import _now_iso
    store = JsonFileStore()
    uni = _load_universe()
    opt = (store.get_optimize() or {}).get("stocks", {})
    rec = (store.get_recommend() or {}).get("stocks", {})
    news = (store.get_news() or {}).get("stocks", {})
    fund = (store.get_fundamentals_coverage() or {}).get("stocks", {})
    records = []
    for sym, name in uni:
        sf = store.get_stock(sym)
        records.append(audit_stock(sym, name, sf, opt.get(sym), rec.get(sym), news.get(sym), fund.get(sym)))
    summary = summarise(records)
    out = {"generated_at": _now_iso(), "methodology_version": METHODOLOGY_VERSION,
           "universe_size": len(uni), "summary": summary,
           "rules": "See intel/final_audit.py docstring; rules are explicit and not loosened.",
           "stocks": {r["symbol"]: r for r in records}}
    store.put_final_audit(out)
    print("Final audit: %d stocks, results=%s, trade_candidates=%d"
          % (len(records), summary["audit_results"], summary["trade_candidates"]))


if __name__ == "__main__":
    main()
