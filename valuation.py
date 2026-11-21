#!/usr/bin/env python3
"""Trader Dashboard - 5-model intrinsic value (S-5). Standard library only.

P/E, DCF, Graham, ROE/residual, EV/EBITDA -> weighted intrinsic value and
upside/downside vs the current price. Money fields are in crore, share count in
crore, so a per-share value is equity_cr / shares_cr. Missing-input models are
SKIPPED (not guessed). Forward inputs (growth, WACC, target multiples) are
explicit assumptions, surfaced to the UI. Not a price target; not advice.
"""


def _pe(eps, g, target_pe, ke, horizon=3):
    if not eps or eps <= 0 or g is None or not target_pe:
        return None
    val = eps * (1 + g) ** horizon * target_pe
    if ke and ke > -1:
        val /= (1 + ke) ** horizon
    return val


def _graham(eps, g, bvps):
    vals = []
    if eps and eps > 0 and g is not None:
        vals.append(eps * (8.5 + 2 * g * 100) * 4.4 / 7.5)  # revised Graham (Y=7.5%)
    if eps and eps > 0 and bvps and bvps > 0:
        vals.append((22.5 * eps * bvps) ** 0.5)             # Graham Number
    return sum(vals) / len(vals) if vals else None


def _roe(roe, g, ke, bvps):
    if not roe or not bvps or bvps <= 0 or ke <= g:
        return None
    return (roe - g) / (ke - g) * bvps                       # justified P/B x BVPS


def _dcf(fcf, g, wacc, tg, years, net_debt, shares_cr):
    if not fcf or fcf <= 0 or not shares_cr or wacc <= tg:
        return None
    pv, f = 0.0, fcf
    for _ in range(years):
        f *= (1 + g)
        pv += f / (1 + wacc) ** (_ + 1)
    pv += (f * (1 + tg) / (wacc - tg)) / (1 + wacc) ** years
    return (pv - (net_debt or 0)) / shares_cr


def _ev_ebitda(ebitda, mult, net_debt, shares_cr):
    if not ebitda or not shares_cr:
        return None
    return (mult * ebitda - (net_debt or 0)) / shares_cr


def value(f, price):
    """f = a fundamentals.json entry; price = current price."""
    if f.get("type") == "bank":
        return {"applicable": False,
                "note": "5-model intrinsic value doesn't fit banks — judge on P/B (in the quality card)."}
    pe, pb = f.get("pe"), f.get("pb")
    roe = (f.get("roe") or 0) / 100.0
    eps = price / pe if (pe and price) else None
    bvps = price / pb if (pb and price) else None
    g = max(0.0, min((f.get("profit_cagr") or 0), 15)) / 100.0   # cap 15%, floor 0
    ke, wacc, tg, years = 0.12, 0.12, 0.05, 10
    target_pe = min(pe or 28, 28)
    shares, nd = f.get("shares_cr"), f.get("net_debt_cr")

    models = [
        ("P/E", _pe(eps, g, target_pe, ke)),
        ("DCF", _dcf(f.get("fcf_cr"), g, wacc, tg, years, nd, shares)),
        ("Graham", _graham(eps, g, bvps)),
        ("ROE/residual", _roe(roe, tg, ke, bvps)),
        ("EV/EBITDA", _ev_ebitda(f.get("ebitda_cr"), 14, nd, shares)),
    ]
    vals = [v for _, v in models if v is not None]
    intrinsic = sum(vals) / len(vals) if vals else None
    upside = (intrinsic - price) / price * 100 if (intrinsic and price) else None
    return {"applicable": True,
            "models": [{"name": n, "value": round(v, 2) if v is not None else None} for n, v in models],
            "used": len(vals),
            "intrinsic": round(intrinsic, 2) if intrinsic is not None else None,
            "price": price,
            "upside_pct": round(upside, 1) if upside is not None else None,
            "flag": f.get("flag"),
            "assumptions": {"growth_pct": round(g * 100, 1), "wacc_pct": 12,
                            "terminal_pct": 5, "target_pe": round(target_pe, 1)}}
