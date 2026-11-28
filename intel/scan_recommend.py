"""Phase 4 offline batch: generate per-style recommendations for the locked
201-stock universe. Writes data/recommend.json and appends change events to the
append-only data/recommend_history.jsonl (Correction 4 — never modifies prior
records).

Run from the repo root:
    python -m intel.scan_recommend            # resume
    python -m intel.scan_recommend --fresh     # recompute all
    python -m intel.scan_recommend --limit 10  # first N (testing)

Inputs per stock: Phase 1 (data/stock), Phase 2 (data/regime.json), Phase 3
(data/optimize.json), fresh daily 5y bars (live signal + config re-validation),
and the weekly EMA 9/21/50 engine's verdict/quality/valuation (read-only, for
the signal panel + conflict caps — the engine is never modified).
"""
import os
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel import recommend as rc  # noqa: E402
from intel import validate  # noqa: E402
from intel.datasource import YahooSource, _now_iso  # noqa: E402
from intel.scan_universe import _load_universe  # noqa: E402
from intel.store import JsonFileStore  # noqa: E402

DELAY = 1.2
RETRIES = 4
BACKOFF = 1.8
STYLES = ("short_term", "swing", "long_term")

LIMITATIONS = [
    "Recommendations are informational, NOT investment advice; no accuracy or probability is claimed.",
    "Long-only; SELL means EXIT/AVOID, never a short. Intraday unsupported.",
    "Long-term is daily-derived from Phase 3 (no weekly-native optimisation yet).",
    "Backtested/last-close entry is not a guaranteed live fill; live costs & slippage are separate estimates.",
    "Yahoo-only data, ~15-min delayed, partial NSE, NOT independently verified (kept separate from evidence).",
    "Only AVAILABLE_VALIDATED + fresh (<=5 trading sessions) + config-level-reliable stocks get an actionable call.",
]
TECH_DEBT = [
    "NSE holiday list is bundled and must be kept current (affects session-age by at most ~1).",
    "Config-level reliability re-uses the same price history (out-of-sample, not an independent dataset).",
    "Evidence tiers are not statistically calibrated; calibration is future work.",
    "Estimated live cost (0.15%) and slippage (0.20%) are generic assumptions, not per-broker.",
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


def _weekly_ctx(sym):
    """Read-only weekly EMA 9/21/50 engine output for the signal panel + caps."""
    try:
        import engine
        import quality as qmod
        import valuation as vmod
        d = engine.compute(sym, "W")
        q = qmod.score(sym)
        f = (qmod._load().get("companies") or {}).get(sym.upper())
        val = vmod.value(f, d.get("price")) if f else {"applicable": False}
        return {"weekly_action": (d.get("verdict") or {}).get("action"),
                "weekly_headline": (d.get("verdict") or {}).get("headline"),
                "quality": q.get("quality") if q and q.get("available") else None,
                "valuation": q.get("valuation") if q and q.get("available") else None}
    except Exception:  # noqa: BLE001 — weekly context is optional; never block a rec
        return {}


def evaluate_symbol(source, sym, name, store):
    p1 = store.get_stock(sym)
    p2 = (store.get_regime() or {}).get("stocks", {}).get(sym)
    p3 = (store.get_optimize() or {}).get("stocks", {}).get(sym)
    f = _fetch(source, sym, "1d", "5y")
    if not f or (not f.get("ok") and (f.get("error") or {}).get("code") == "not_found"):
        return {"symbol": sym, "name": name, "methodology_version": rc.METHODOLOGY_VERSION,
                "evaluated_at": _now_iso(), "unsupported": True, "styles": {}, "scan_ok": False,
                "note": "symbol not found on provider — kept, not substituted."}
    if not f.get("ok"):
        return None  # transient — caller preserves prior
    bars = f.get("bars") or []
    v = validate.validate_history(bars, "1d")
    # Phase 4 eligibility (E1) uses Phase 1's committed status; if P1 missing, synthesise from fetch
    if not p1:
        p1 = {"data_status": v["quality"], "daily": {"last_date": v["last_date"]},
              "provenance": {"provider": source.name}}
    rec = rc.evaluate(sym, name, p1, p2, p3, bars, _weekly_ctx(sym))
    rec["scan_ok"] = True
    return rec


# cache the regime/optimize registries once per run (read many times)
_REG = {"regime": None, "optimize": None}


def _preload(store):
    _REG["regime"] = store.get_regime() or {"stocks": {}}
    _REG["optimize"] = store.get_optimize() or {"stocks": {}}


def _p2(sym):
    return (_REG["regime"].get("stocks") or {}).get(sym)


def _p3(sym):
    return (_REG["optimize"].get("stocks") or {}).get(sym)


def evaluate_symbol_fast(source, sym, name, store):
    """Same as evaluate_symbol but uses preloaded P2/P3 registries."""
    p1 = store.get_stock(sym)
    f = _fetch(source, sym, "1d", "5y")
    if not f or (not f.get("ok") and (f.get("error") or {}).get("code") == "not_found"):
        return {"symbol": sym, "name": name, "methodology_version": rc.METHODOLOGY_VERSION,
                "evaluated_at": _now_iso(), "unsupported": True, "styles": {}, "scan_ok": False,
                "note": "symbol not found on provider — kept, not substituted."}
    if not f.get("ok"):
        return None
    bars = f.get("bars") or []
    v = validate.validate_history(bars, "1d")
    if not p1:
        p1 = {"data_status": v["quality"], "daily": {"last_date": v["last_date"]},
              "provenance": {"provider": source.name}}
    rec = rc.evaluate(sym, name, p1, _p2(sym), _p3(sym), bars, _weekly_ctx(sym))
    rec["scan_ok"] = True
    return rec


def _diff_and_log(store, sym, name, prev_rec, new_rec):
    """Append an append-only history event for each style whose recommendation
    changed (Correction 4). Never modifies an existing record."""
    prev_styles = (prev_rec or {}).get("styles", {})
    for style, s in (new_rec.get("styles") or {}).items():
        new_label = s.get("recommendation")
        old_label = (prev_styles.get(style) or {}).get("recommendation")
        if new_label == old_label:
            continue
        store.append_recommend_history({
            "id": uuid.uuid4().hex[:12], "event": "recommendation", "ts": _now_iso(),
            "symbol": sym, "name": name, "style": style,
            "prev_recommendation": old_label, "new_recommendation": new_label,
            "config_used": s.get("config_used"), "config_reliability": s.get("config_reliability"),
            "regime": s.get("regime"), "evidence": s.get("evidence"),
            "entry_ref": s.get("entry_ref"), "stop": s.get("stop"), "target": s.get("target"), "rr": s.get("rr"),
            "costs": s.get("costs"),
            "provenance": new_rec.get("provenance"), "verification": new_rec.get("verification"),
            "reasons": s.get("reasons"), "warnings": s.get("warnings"),
            "methodology_version": rc.METHODOLOGY_VERSION,
        })


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
    _preload(store)
    prev = (store.get_recommend() or {}).get("stocks", {})
    state = (None if fresh else store.get_recommend_state()) or {"done": []}
    done = set(state.get("done", []))
    out = dict(prev) if not fresh else {}
    run_started = _now_iso()
    processed = 0

    print("Recommendation batch for %d stocks%s ..." % (len(universe), " [resume]" if done else ""))
    for i, (sym, name) in enumerate(universe, 1):
        if sym in done and not fresh and sym in out:
            continue
        try:
            rec = evaluate_symbol_fast(source, sym, name, store)
            if rec is None:  # transient failure
                if prev.get(sym) and prev[sym].get("styles"):
                    rec = dict(prev[sym]); rec["scan_ok"] = False
                    rec["last_scan_note"] = "Transient fetch failure — kept last good recommendation."
                else:
                    rec = {"symbol": sym, "name": name, "methodology_version": rc.METHODOLOGY_VERSION,
                           "evaluated_at": _now_iso(), "styles": {}, "scan_ok": False,
                           "note": "fetch failed"}
            else:
                _diff_and_log(store, sym, name, prev.get(sym), rec)
        except Exception as e:  # noqa: BLE001
            rec = prev.get(sym) or {"symbol": sym, "name": name, "styles": {}}
            rec = dict(rec); rec["scan_ok"] = False; rec["last_scan_error"] = str(e)[:160]
        out[sym] = rec
        done.add(sym)
        processed += 1
        if processed % 10 == 0:
            store.put_recommend_state({"done": sorted(done), "updated_at": _now_iso()})
            store.put_recommend(_build(out, universe))
        top = (rec.get("styles", {}).get("swing") or {}).get("recommendation", "?")
        print("  [%d/%d] %-16s swing=%s%s" % (i, len(universe), sym, top,
              "" if rec.get("scan_ok", True) else "  (scan issue)"))
        time.sleep(DELAY)

    store.put_recommend_state({"done": sorted(done), "updated_at": _now_iso()})
    store.put_recommend(_build(out, universe))
    print("\nDone. processed=%d  stocks=%d" % (processed, len(out)))
    print("storage:", store.usage())


def _counts(out):
    labels = ["STRONG BUY", "BUY", "HOLD", "WAIT", "SELL", "INSUFFICIENT_EVIDENCE"]
    counts = {s: {l: 0 for l in labels} for s in STYLES}
    for r in out.values():
        for style in STYLES:
            lab = (r.get("styles", {}).get(style) or {}).get("recommendation", "INSUFFICIENT_EVIDENCE")
            counts[style][lab] = counts[style].get(lab, 0) + 1
    return counts


def _build(out, universe):
    return {"generated_at": _now_iso(), "methodology_version": rc.METHODOLOGY_VERSION,
            "universe_size": len(universe), "counts": _counts(out),
            "params": {"risk_pct": 1, "max_position_pct": 20, "atr_k_short_swing": 2,
                       "atr_k_long": 3, "atr_k_highvol_add": 0.5, "rr_strong": rc.RR_STRONG,
                       "rr_buy": rc.RR_BUY, "freshness_sessions": rc.FRESHNESS_SESSIONS,
                       "hist_cost_per_side_pct": rc.HIST_COST_PER_SIDE_PCT,
                       "est_live_pct": rc.EST_LIVE_COST_PCT, "slippage_pct": rc.SLIPPAGE_PCT},
            "limitations": LIMITATIONS, "technical_debt": TECH_DEBT, "stocks": out}


if __name__ == "__main__":
    main()
