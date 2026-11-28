"""Commodities batch: fetch each catalog instrument, reuse the regime engine for
technicals, build a technical recommendation + outlook + macro factors, and write
data/commodities.json. No stock fundamentals. Separate from the 201-stock run.

Resumable/fault-tolerant: one failed instrument never stops the run, and if the
whole run yields nothing the previous commodities.json is kept.

Run from the repo root:
    python -m intel.scan_commodities
"""
import datetime as _dt
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel import commodities as cm  # noqa: E402
from intel import scan_regime as sr  # noqa: E402 (reuse evaluate_symbol = regime engine)
from intel.datasource import YahooSource, _now_iso  # noqa: E402
from intel.store import JsonFileStore  # noqa: E402

DELAY = 0.6


def _snapshot(source, sym):
    """Latest price, previous close, % change, last session date, staleness."""
    r = source.get_history(sym, "1d", "1mo")
    if not r.get("ok"):
        return {"available": False, "error": (r.get("error") or {}).get("code")}
    bars = [b for b in (r.get("bars") or []) if isinstance(b.get("close"), (int, float))]
    if not bars:
        return {"available": False, "error": "no_valid_close"}
    last = bars[-1]
    prev = bars[-2] if len(bars) > 1 else None
    price = last["close"]
    pc = prev["close"] if prev else None
    chg_pct = round((price / pc - 1) * 100, 2) if pc else None
    try:
        age_days = (_dt.date.today() - _dt.date.fromisoformat(last["date"])).days
    except Exception:  # noqa: BLE001
        age_days = None
    stale = age_days is not None and age_days > cm.STALE_DAYS
    return {"available": True, "price": price, "previous_close": pc,
            "change_pct": chg_pct, "last_session": last["date"],
            "age_days": age_days, "stale": stale,
            "market_status": "STALE" if stale else "last completed session",
            "retrieved_at": _now_iso(), "source": source.name, "bars": bars}


def _ema(vals, period):
    if len(vals) < period:
        return None
    k = 2.0 / (period + 1)
    e = sum(vals[:period]) / period
    for v in vals[period:]:
        e = v * k + e * (1 - k)
    return e


def _ref_trend(source, sym):
    """Robust, self-contained trend for a MACRO REFERENCE only (DXY/INR/copper):
    EMA50 vs EMA200 stack on clean daily closes. Deliberately does NOT call the
    shared regime/indicators path (which can choke on reference series with gaps),
    so it never risks the stock engine. Returns BULLISH/BEARISH/NEUTRAL or None."""
    try:
        r = source.get_history(sym, "1d", "2y")
        if not r.get("ok"):
            return None
        closes = [b["close"] for b in (r.get("bars") or [])
                  if isinstance(b.get("close"), (int, float))]
        if len(closes) < 60:
            return None
        price = closes[-1]
        ef = _ema(closes, 50)
        es = _ema(closes, 200) or _ema(closes, 50)
        if ef is None or es is None:
            return None
        if price > ef > es:
            return "BULLISH"
        if price < ef < es:
            return "BEARISH"
        return "NEUTRAL"
    except Exception:  # noqa: BLE001
        return None


def main():
    source = YahooSource()
    store = JsonFileStore()
    now = _now_iso()

    # Macro reference trends (free data only).
    dxy = _ref_trend(source, "DX-Y.NYB"); time.sleep(DELAY)
    inr = _ref_trend(source, "INR=X"); time.sleep(DELAY)
    copper = _ref_trend(source, "HG=F"); time.sleep(DELAY)
    print("Macro refs: DXY=%s USD/INR=%s Copper=%s" % (dxy, inr, copper))

    records, failed = {}, 0
    for i, item in enumerate(cm.CATALOG, 1):
        sym = item["symbol"]
        try:
            snap = _snapshot(source, sym)
            time.sleep(DELAY)
            regime_rec = sr.evaluate_symbol(source, sym, item["name"])
            time.sleep(DELAY)
            rec = cm.build_commodity(item, regime_rec, snap.get("bars"), dxy, inr, copper, now)
            rec["snapshot"] = {k: v for k, v in snap.items() if k != "bars"}
            records[sym] = rec
            sw = rec["horizons"]["swing"]
            print("  [%d/%d] %-14s %-10s swing=%s/%s rec=%s" % (
                i, len(cm.CATALOG), sym, item["kind"],
                sw["direction"], sw["evidence_strength"], sw["recommendation"]))
        except Exception as e:  # noqa: BLE001 — one instrument never stops the run
            failed += 1
            print("  [%d/%d] %-14s FAILED: %s" % (i, len(cm.CATALOG), sym, str(e)[:120]))
        time.sleep(DELAY)

    if not records and store.get_commodities():
        print("No commodities retrieved this run; keeping previous commodities.json.")
        return
    summary = cm.summarise(records)
    out = {"generated_at": now, "methodology_version": cm.METHODOLOGY_VERSION,
           "instrument_count": len(records), "fetch_failures": failed,
           "macro_refs": {"usd_index_trend": dxy, "usd_inr_trend": inr, "copper_trend": copper},
           "summary": summary,
           "limitations": [
               "Technical/regime analysis only; commodity fundamentals (inventories, OPEC+, rates) "
               "are not in the free feed and are shown as context, not signals.",
               "Prices are Yahoo delayed data, not independently verified; futures are USD, ETFs INR.",
               "ETF tracking error / premium-discount needs daily NAV (no free feed) — not computed.",
               "No probability or price target; predictive accuracy is not validated.",
           ],
           "commodities": records}
    store.put_commodities(out)
    print("\nDone. instruments=%d failed=%d swing recs=%s"
          % (len(records), failed, summary["recommendation_counts"]["swing"]))


if __name__ == "__main__":
    main()
