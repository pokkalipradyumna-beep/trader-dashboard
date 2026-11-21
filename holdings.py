#!/usr/bin/env python3
"""Trader Dashboard - holdings + exit monitor (S-4). Standard library only.

Reads holdings.json, values each position at the delayed price, and gives the
SELL-side verdict from the weekly 9/21 EMA (death cross = exit), with the
21/50 long-term trend as context. The BUY side is screen/scanner; this is the
exit discipline on what you already hold. A signal, not an order.
"""
import json
import os

import engine
import quality

HERE = os.path.dirname(os.path.abspath(__file__))
HFILE = os.path.join(HERE, "holdings.json")


def _load():
    if os.path.isfile(HFILE):
        with open(HFILE, encoding="utf-8") as f:
            return json.load(f)
    return {"holdings": []}


def _save(d):
    with open(HFILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
        f.write("\n")


def _exit_verdict(s9, s21):
    if not s9:
        return "NODATA", "no completed weekly signal"
    ltn = (" · long-term 21/50 " + s21["regime"]) if s21 else ""
    if s9.get("fresh_bear"):
        return "SELL", "9/21 death cross this week — exit now" + ltn
    if s9.get("regime") == "below":
        return "EXIT", "9/21 below — trend down; exit if still held" + ltn
    if s9.get("fresh_bull"):
        return "HOLD", "fresh 9/21 golden cross — trend just turned up" + ltn
    return "HOLD", "9/21 above — trend intact" + ltn


def compute_all(items=None):
    # items: a list of {ticker, qty, buy_price} (the browser sends this on Vercel /
    # any stateless host). When None, fall back to the local holdings.json file.
    rows = items if items is not None else _load().get("holdings", [])
    out, tot_val, tot_inv = [], 0.0, 0.0
    for h in rows:
        sym = (h.get("ticker") or "").strip().upper()
        if not sym:
            continue
        try:
            qty = float(h.get("qty") or 1)
        except (TypeError, ValueError):
            qty = 1.0
        buy = h.get("buy_price")
        try:
            buy = float(buy) if buy not in (None, "") else None
        except (TypeError, ValueError):
            buy = None
        try:
            r = engine.compute(sym)
            price = r["price"]
            code, note = _exit_verdict(r.get("signal_9_21"), r.get("signal_21_50"))
            val = (price or 0) * qty
            inv = (buy or 0) * qty
            tot_val += val
            tot_inv += inv
            out.append({"symbol": sym, "name": quality.score(sym).get("name") or sym,
                        "qty": qty, "buy_price": buy, "price": price,
                        "value": round(val, 2),
                        "pl_pct": round((price - buy) / buy * 100, 1) if (buy and price) else None,
                        "pl_abs": round(val - inv, 2) if (buy and price) else None,
                        "code": code, "note": note,
                        "s9": (r.get("signal_9_21") or {}).get("regime"),
                        "s21": (r.get("signal_21_50") or {}).get("regime")})
        except Exception as exc:  # noqa: BLE001
            out.append({"symbol": sym, "name": sym, "qty": qty, "buy_price": buy,
                        "code": "ERROR", "note": str(exc)})
    return {"holdings": out,
            "total_value": round(tot_val, 2), "total_invested": round(tot_inv, 2),
            "total_pl": round(tot_val - tot_inv, 2),
            "total_pl_pct": round((tot_val - tot_inv) / tot_inv * 100, 1) if tot_inv else None,
            "any_exit": any(x.get("code") in ("SELL", "EXIT") for x in out)}


def add(ticker, qty=1, buy_price=None):
    d = _load()
    sym = ticker.upper()
    hs = [x for x in d.get("holdings", []) if x["ticker"].upper() != sym]
    hs.append({"ticker": sym, "qty": qty, "buy_price": buy_price})
    d["holdings"] = hs
    _save(d)


def remove(ticker):
    d = _load()
    d["holdings"] = [x for x in d.get("holdings", []) if x["ticker"].upper() != ticker.upper()]
    _save(d)
