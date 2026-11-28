"""Commodities Intelligence — catalog + recommendation + macro factors.

Kept SEPARATE from the 201-stock system (its own catalog, its own data file),
but reuses the SAME technical/regime engine (intel.regime) and the SAME
directional-outlook logic (intel.outlook) so standards match. Stock fundamentals
are NEVER applied to commodities — their drivers are different and are surfaced
as qualitative macro factors only where free data exists.

Pure logic here; fetching/orchestration lives in intel.scan_commodities.
"""
from intel import outlook as ol  # reuse technical evidence + direction + invalidation

METHODOLOGY_VERSION = "commodities-v1.0"
HORIZONS = ("short_term", "swing", "long_term")

# ---- Catalog --------------------------------------------------------------
# kind: metal | energy | agri | etf.  For ETFs: `tracks` names the underlying,
# `currency` INR (NSE). `macro` lists the free, reliable factors we actually use.
CATALOG = [
    {"symbol": "GC=F", "name": "Gold", "kind": "metal", "unit": "USD / troy oz",
     "currency": "USD", "macro": ["usd_index", "real_rates_note"]},
    {"symbol": "SI=F", "name": "Silver", "kind": "metal", "unit": "USD / troy oz",
     "currency": "USD", "macro": ["usd_index", "industrial_demand"]},
    {"symbol": "HG=F", "name": "Copper", "kind": "metal", "unit": "USD / lb",
     "currency": "USD", "macro": ["industrial_demand"]},
    {"symbol": "PL=F", "name": "Platinum", "kind": "metal", "unit": "USD / troy oz",
     "currency": "USD", "macro": ["usd_index", "industrial_demand"]},
    {"symbol": "PA=F", "name": "Palladium", "kind": "metal", "unit": "USD / troy oz",
     "currency": "USD", "macro": ["industrial_demand"]},
    {"symbol": "CL=F", "name": "WTI Crude Oil", "kind": "energy", "unit": "USD / barrel",
     "currency": "USD", "macro": ["supply_demand_note"]},
    {"symbol": "BZ=F", "name": "Brent Crude Oil", "kind": "energy", "unit": "USD / barrel",
     "currency": "USD", "macro": ["supply_demand_note"]},
    {"symbol": "NG=F", "name": "Natural Gas", "kind": "energy", "unit": "USD / MMBtu",
     "currency": "USD", "macro": ["supply_demand_note"]},
    {"symbol": "ZW=F", "name": "Wheat", "kind": "agri", "unit": "US cents / bushel",
     "currency": "USX", "macro": ["supply_demand_note"]},
    # Indian ETFs (NSE, INR) — analysed on their OWN price, never copied from spot.
    {"symbol": "GOLDBEES.NS", "name": "Nippon India Gold ETF", "kind": "etf",
     "unit": "INR / unit", "currency": "INR", "tracks": "Gold", "macro": ["usd_inr"]},
    {"symbol": "TATAGOLD.NS", "name": "Tata Gold ETF", "kind": "etf",
     "unit": "INR / unit", "currency": "INR", "tracks": "Gold", "macro": ["usd_inr"]},
    {"symbol": "GOLDIETF.NS", "name": "ICICI Prudential Gold ETF", "kind": "etf",
     "unit": "INR / unit", "currency": "INR", "tracks": "Gold", "macro": ["usd_inr"]},
    {"symbol": "HDFCGOLD.NS", "name": "HDFC Gold ETF", "kind": "etf",
     "unit": "INR / unit", "currency": "INR", "tracks": "Gold", "macro": ["usd_inr"]},
    {"symbol": "SILVERBEES.NS", "name": "Nippon India Silver ETF", "kind": "etf",
     "unit": "INR / unit", "currency": "INR", "tracks": "Silver", "macro": ["usd_inr", "industrial_demand"]},
    {"symbol": "SILVERIETF.NS", "name": "ICICI Prudential Silver ETF", "kind": "etf",
     "unit": "INR / unit", "currency": "INR", "tracks": "Silver", "macro": ["usd_inr", "industrial_demand"]},
]
# Macro reference instruments (fetched for factors, not shown as tradeable).
MACRO_REFS = [{"symbol": "DX-Y.NYB", "name": "US Dollar Index"},
              {"symbol": "INR=X", "name": "USD / INR"}]

STALE_DAYS = 5  # a last completed candle older than this is flagged STALE


def recommendation_from(direction, strength, rsi):
    """Map a horizon outlook to BUY / HOLD / WAIT / SELL / INSUFFICIENT EVIDENCE.
    Technical only (no fundamentals). Conservative and explainable."""
    if direction == "INSUFFICIENT EVIDENCE" or strength == "INSUFFICIENT":
        return "INSUFFICIENT EVIDENCE", "No validated price data for this horizon."
    overbought = isinstance(rsi, (int, float)) and rsi >= 70
    oversold = isinstance(rsi, (int, float)) and rsi <= 30
    if direction in ("BULLISH", "MODERATELY BULLISH"):
        if overbought:
            return "HOLD", "Uptrend intact but momentum overbought (RSI %.0f) — no fresh low-risk entry." % rsi
        return "BUY", "Uptrend with confirming momentum and no overbought extreme."
    if direction in ("BEARISH", "MODERATELY BEARISH"):
        if oversold:
            return "WAIT", "Downtrend but oversold (RSI %.0f) — avoid chasing; wait for stabilisation." % rsi
        return "SELL", "Downtrend / breakdown — exit or avoid longs (not a short instruction)."
    return "WAIT", "No clear directional setup (neutral/sideways)."


def macro_factors(item, dxy_trend, inr_trend, copper_trend):
    """Qualitative factors from FREE data only; honest about what is unavailable."""
    out = []
    macro = item.get("macro", [])
    if "usd_index" in macro and dxy_trend:
        stance = "headwind" if dxy_trend == "BULLISH" else ("tailwind" if dxy_trend == "BEARISH" else "neutral")
        out.append({"factor": "US dollar (DXY)", "stance": stance,
                    "detail": "Dollar Index trend is %s — a %s for %s (they usually move inversely to the USD)."
                              % (dxy_trend, stance, item["name"])})
    if "real_rates_note" in macro:
        out.append({"factor": "Real rates / inflation", "stance": "context",
                    "detail": "Rising real rates pressure gold; falling rates/high inflation support it. "
                              "No free real-rate series is wired in, so this is context, not a signal."})
    if "industrial_demand" in macro and copper_trend:
        out.append({"factor": "Industrial demand (copper proxy)", "stance":
                    "supportive" if copper_trend == "BULLISH" else ("weak" if copper_trend == "BEARISH" else "neutral"),
                    "detail": "Copper trend (%s) is used as a free proxy for industrial demand." % copper_trend})
    if "usd_inr" in macro and inr_trend:
        out.append({"factor": "USD/INR", "stance": "context",
                    "detail": "A weaker rupee (USD/INR %s) lifts the INR price of imported gold/silver, "
                              "independent of the metal's USD move." % inr_trend})
    if "supply_demand_note" in macro:
        out.append({"factor": "Supply / demand", "stance": "context",
                    "detail": "Inventories, OPEC+ decisions and weather drive this market but are not in the "
                              "free price feed — the outlook here is TECHNICAL only. Treat fundamentals separately."})
    return out


def etf_context(item, bars):
    """ETF-specific: liquidity from volume; tracking error flagged as unavailable
    (needs NAV, which has no free feed). Never copies the underlying's call."""
    if item.get("kind") != "etf":
        return None
    vols = [b.get("volume") for b in (bars or []) if isinstance(b.get("volume"), (int, float))]
    recent = vols[-20:] if vols else []
    avg_vol = round(sum(recent) / len(recent)) if recent else None
    liq = None
    if avg_vol is not None:
        liq = "good" if avg_vol >= 100000 else ("moderate" if avg_vol >= 20000 else "thin")
    return {"tracks": item.get("tracks"),
            "avg_daily_volume_20d": avg_vol, "liquidity": liq,
            "tracking_error": None,
            "note": "Analysed on the ETF's OWN price (not the spot metal's call). "
                    "Premium/discount and tracking error need daily NAV, which has no free feed — "
                    "not computed.%s" % (" Thin volume: wider spreads likely." if liq == "thin" else "")}


def build_commodity(item, regime_rec, bars, dxy_trend, inr_trend, copper_trend, now_iso):
    """Assemble one commodity's intelligence record from reused regime output."""
    unsupported = regime_rec.get("unsupported") or not (regime_rec.get("horizons"))
    horizons = {}
    for hz in HORIZONS:
        o = ol.outlook_for_horizon(hz, regime_rec, None, None, None)  # no stock opt/rec/fund
        # The reused engine caps long-term at LOW for missing fundamentals and the
        # missing strategy; reword those stock-centric reasons for a commodity.
        o["evidence_reasons"] = [
            ("No fundamental basis for commodities — long-term is technical-only, strength capped at LOW."
             if "INSUFFICIENT_DATA" in r else
             "No per-instrument walk-forward strategy — this uses the regime engine directly."
             if "No validated strategy" in r else r)
            for r in o.get("evidence_reasons", [])]
        o.pop("fundamental_context", None)  # not applicable to commodities
        rsi = (o.get("indicators") or {}).get("rsi")
        rec, why = recommendation_from(o["direction"], o["evidence_strength"], rsi)
        o["recommendation"] = rec
        o["recommendation_reason"] = why
        horizons[hz] = o
    last_candle = ((regime_rec.get("horizons", {}).get("swing") or {}).get("last_candle"))
    return {
        "symbol": item["symbol"], "name": item["name"], "kind": item["kind"],
        "unit": item["unit"], "currency": item["currency"],
        "tracks": item.get("tracks"),
        "generated_at": now_iso, "methodology_version": METHODOLOGY_VERSION,
        "unsupported": bool(unsupported),
        "last_candle": last_candle,
        "horizons": horizons,
        "macro_factors": macro_factors(item, dxy_trend, inr_trend, copper_trend),
        "etf_context": etf_context(item, bars),
        "disclaimer": "Technical, evidence-based outlook — NOT advice, NOT a probability or price target. "
                      "Commodity fundamentals (inventories, rates) are shown as context only where free data exists.",
    }


def summarise(records):
    by_rec = {hz: {} for hz in HORIZONS}
    for r in records.values():
        for hz, o in r["horizons"].items():
            lab = o.get("recommendation", "INSUFFICIENT EVIDENCE")
            by_rec[hz][lab] = by_rec[hz].get(lab, 0) + 1
    return {"instruments": len(records), "recommendation_counts": by_rec}
