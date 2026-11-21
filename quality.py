#!/usr/bin/env python3
"""Trader Dashboard - quality scorer (S-2). Standard library only.

Reads fundamentals.json and scores a stock against the method's gates, split
into two honest groups:
  - BUSINESS QUALITY: ROE, ROCE, revenue & profit growth, debt, free cash flow
  - VALUATION & OWNERSHIP: P/E, P/B, promoter holding
Banks are scored on bank metrics (ROE, NPA, deposits, NIM, P/B) instead.
Data is a curated, periodically-updated file (NOT live) with an as_of date.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
_DATA = None


def _load():
    global _DATA
    if _DATA is None:
        with open(os.path.join(HERE, "fundamentals.json"), encoding="utf-8") as f:
            _DATA = json.load(f)
    return _DATA


def _gate(name, value, ok, thresh, unit=""):
    return {"name": name, "value": value, "pass": bool(ok), "thresh": thresh, "unit": unit}


def score(symbol):
    data = _load()
    f = (data.get("companies") or {}).get(symbol.upper())
    meta = {"as_of": data.get("as_of"), "source": data.get("source")}
    if not f:
        return {"available": False, "note": "No fundamentals on file for " + symbol, **meta}
    if f.get("type") == "bank":
        return _bank(symbol, f, meta)
    return _nonbank(symbol, f, meta)


def _bucket(passed, total, near=1):
    if passed == total:
        return "PASS"
    if passed >= total - near:
        return "NEAR"
    return "FAIL"


def _nonbank(sym, f, meta):
    q = [
        _gate("ROE", f.get("roe"), (f.get("roe") or 0) >= 15, ">=15", "%"),
        _gate("ROCE", f.get("roce"), (f.get("roce") or 0) >= 15, ">=15", "%"),
        _gate("Revenue growth 3y", f.get("rev_cagr"), (f.get("rev_cagr") or -99) >= 10, ">=10", "%"),
        _gate("Profit growth 3y", f.get("profit_cagr"), (f.get("profit_cagr") or -99) >= 10, ">=10", "%"),
        _gate("Debt / Equity", f.get("de"), (f.get("de") if f.get("de") is not None else 99) <= 1.0, "<=1.0", ""),
    ]
    if "fcf_positive" in f:
        q.append(_gate("Free cash flow", "positive" if f["fcf_positive"] else "negative",
                       f["fcf_positive"], ">0", ""))
    v = [
        _gate("P/E", f.get("pe"), (f.get("pe") if f.get("pe") is not None else 999) <= 35, "<=35", ""),
        _gate("P/B", f.get("pb"), (f.get("pb") if f.get("pb") is not None else 999) <= 6, "<=6", ""),
        _gate("Promoter holding", f.get("promoter"), (f.get("promoter") or 0) >= 50, ">=50", "%"),
    ]
    qp = sum(x["pass"] for x in q)
    vp = sum(x["pass"] for x in v)
    valuation = "CHEAP" if vp == len(v) else ("FAIR" if vp >= len(v) - 1 else "EXPENSIVE")
    return {"available": True, "type": "non-bank", "name": f.get("name", sym),
            "quality_gates": q, "value_gates": v,
            "quality": _bucket(qp, len(q)), "quality_passed": qp, "quality_total": len(q),
            "valuation": valuation, "value_passed": vp, "value_total": len(v),
            "flag": f.get("flag"), **meta}


def _bank(sym, f, meta):
    q = [
        _gate("ROE", f.get("roe"), (f.get("roe") or 0) >= 15, ">=15", "%"),
        _gate("Gross NPA", f.get("gnpa"), (f.get("gnpa") if f.get("gnpa") is not None else 99) <= 3, "<=3", "%"),
        _gate("Net NPA", f.get("nnpa"), (f.get("nnpa") if f.get("nnpa") is not None else 99) <= 1, "<=1", "%"),
        _gate("Deposit growth 3y", f.get("deposit_growth"), (f.get("deposit_growth") or 0) >= 10, ">=10", "%"),
    ]
    if f.get("nim") is not None:
        q.append(_gate("Net Interest Margin", f.get("nim"), (f.get("nim") or 0) >= 3, ">=3", "%"))
    v = [_gate("P/B", f.get("pb"), (f.get("pb") if f.get("pb") is not None else 999) <= 3.5, "<=3.5", "")]
    qp = sum(x["pass"] for x in q)
    vp = sum(x["pass"] for x in v)
    valuation = "CHEAP" if vp == len(v) else "EXPENSIVE"
    return {"available": True, "type": "bank", "name": f.get("name", sym),
            "quality_gates": q, "value_gates": v,
            "quality": _bucket(qp, len(q)), "quality_passed": qp, "quality_total": len(q),
            "valuation": valuation, "value_passed": vp, "value_total": len(v),
            "note": "Bank metrics (ROE/NPA/deposits/NIM/P-B); non-bank gates don't apply.",
            **meta}
