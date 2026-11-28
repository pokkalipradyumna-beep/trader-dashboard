"""Phase 7 — Predictive Outlook Engine (pure logic, no network, no re-scan).

Produces an evidence-based DIRECTIONAL outlook for each stock at three horizons
(short_term, swing, long_term), by REUSING already-computed intelligence:

  regime.json      -> per-horizon technical indicators + stock regime
  optimize.json    -> walk-forward strategy reliability (Phase 3)
  recommend.json   -> the independent recommendation label (Phase 4)
  fundamentals_coverage.json -> fundamental context (Phase 7)
  news.json        -> recent company events (Phase 5, with display materiality)
  stock/<sym>.json -> data status / freshness

No numeric probability or price target is produced (historical outcome
validation is postponed). Output is a direction + an explicit evidence-strength
classification, with the supporting and contradicting evidence listed so the
conclusion is reproducible from the inputs.

Directions:  BULLISH, MODERATELY BULLISH, NEUTRAL, MODERATELY BEARISH,
             BEARISH, INSUFFICIENT EVIDENCE.
Evidence strength: HIGH, MODERATE, LOW, INSUFFICIENT.
"""
METHODOLOGY_VERSION = "outlook-v1.0"
HORIZONS = ("short_term", "swing", "long_term")
HORIZON_LABEL = {"short_term": "Short-term", "swing": "Swing", "long_term": "Long-term"}


def _n(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _item(factor, stance, detail):
    # stance: "bullish" | "bearish" | "neutral" | "risk"
    return {"factor": factor, "stance": stance, "detail": detail}


def _technical_evidence(h):
    """Build evidence items from one regime horizon's indicators. Only uses
    values that exist (never invents)."""
    iv = h.get("indicators") or {}
    out = []
    price = _n(iv.get("price"))
    ef, es = _n(iv.get("ema_fast")), _n(iv.get("ema_slow"))
    efp, esp = iv.get("ema_fast_period"), iv.get("ema_slow_period")

    # Regime trend (the engine's own classification) is the anchor.
    trend = h.get("trend")
    if trend == "BULLISH":
        out.append(_item("Stock regime", "bullish", "Regime classified BULLISH for this horizon."))
    elif trend == "BEARISH":
        out.append(_item("Stock regime", "bearish", "Regime classified BEARISH for this horizon."))
    elif trend == "SIDEWAYS":
        out.append(_item("Stock regime", "neutral", "Regime classified SIDEWAYS (no clear trend)."))
    elif trend == "UNCERTAIN":
        out.append(_item("Stock regime", "neutral", "Regime UNCERTAIN — trend not established."))

    # EMA alignment.
    if price is not None and ef is not None and es is not None:
        if price > ef > es:
            out.append(_item("EMA alignment", "bullish",
                             "Price above EMA%s and EMA%s, fast above slow (uptrend stack)." % (efp, esp)))
        elif price < ef < es:
            out.append(_item("EMA alignment", "bearish",
                             "Price below EMA%s and EMA%s, fast below slow (downtrend stack)." % (efp, esp)))
        else:
            out.append(_item("EMA alignment", "neutral",
                             "EMAs not cleanly stacked (price %s vs EMA%s %s / EMA%s %s)."
                             % (price, efp, round(ef, 2), esp, round(es, 2))))

    # ADX / DI — trend strength and direction.
    adx = _n(iv.get("adx"))
    pdi, mdi = _n(iv.get("plus_di")), _n(iv.get("minus_di"))
    if adx is not None:
        if adx >= 25 and pdi is not None and mdi is not None:
            if pdi > mdi:
                out.append(_item("Trend strength (ADX)", "bullish",
                                 "ADX %.0f (strong), +DI above -DI." % adx))
            else:
                out.append(_item("Trend strength (ADX)", "bearish",
                                 "ADX %.0f (strong), -DI above +DI." % adx))
        elif adx < 20:
            out.append(_item("Trend strength (ADX)", "neutral",
                             "ADX %.0f — weak/No clear trend." % adx))

    # RSI momentum.
    rsi = _n(iv.get("rsi"))
    if rsi is not None:
        if rsi >= 70:
            out.append(_item("Momentum (RSI)", "risk", "RSI %.0f — overbought; pullback risk." % rsi))
        elif rsi <= 30:
            out.append(_item("Momentum (RSI)", "risk", "RSI %.0f — oversold; bounce possible but weak trend." % rsi))
        elif rsi >= 55:
            out.append(_item("Momentum (RSI)", "bullish", "RSI %.0f — positive momentum." % rsi))
        elif rsi <= 45:
            out.append(_item("Momentum (RSI)", "bearish", "RSI %.0f — negative momentum." % rsi))

    # MACD histogram.
    mh = _n(iv.get("macd_hist"))
    if mh is not None:
        if mh > 0:
            out.append(_item("MACD", "bullish", "MACD histogram positive (%.2f)." % mh))
        elif mh < 0:
            out.append(_item("MACD", "bearish", "MACD histogram negative (%.2f)." % mh))

    # Volume confirmation (only when the engine marked volume reliable).
    if iv.get("volume_reliable"):
        obv = _n(iv.get("obv_slope_pct"))
        if obv is not None:
            if obv > 5:
                out.append(_item("Volume (OBV)", "bullish", "OBV slope +%.0f%% — accumulation." % obv))
            elif obv < -5:
                out.append(_item("Volume (OBV)", "bearish", "OBV slope %.0f%% — distribution." % obv))

    # Volatility and reversal are risks, not direction.
    if h.get("volatility") == "HIGH_VOLATILITY":
        ap = _n(iv.get("atr_pct"))
        out.append(_item("Volatility", "risk",
                         "High volatility%s — wider stops, less reliable signals."
                         % ("" if ap is None else " (ATR %.1f%%)" % ap)))
    if h.get("reversal") == "POTENTIAL_REVERSAL":
        out.append(_item("Reversal", "risk", "Engine flags a potential reversal."))
    return out


def _direction(items):
    score = 0
    bull = bear = 0
    for it in items:
        if it["stance"] == "bullish":
            score += 1
            bull += 1
        elif it["stance"] == "bearish":
            score -= 1
            bear += 1
    directional = bull + bear
    if directional == 0:
        return "NEUTRAL", score, bull, bear
    if score >= 3 and bull >= bear + 2:
        return "BULLISH", score, bull, bear
    if score <= -3 and bear >= bull + 2:
        return "BEARISH", score, bull, bear
    if score >= 1:
        return "MODERATELY BULLISH", score, bull, bear
    if score <= -1:
        return "MODERATELY BEARISH", score, bull, bear
    return "NEUTRAL", score, bull, bear


def _invalidation(direction, h):
    """Only levels the engine already computed; never invented."""
    iv = h.get("indicators") or {}
    es, esp = _n(iv.get("ema_slow")), iv.get("ema_slow_period")
    sup, res = _n(iv.get("support")), _n(iv.get("resistance"))
    out = []
    if direction in ("BULLISH", "MODERATELY BULLISH"):
        if es is not None:
            out.append("A close below EMA%s (~%s) would weaken the uptrend." % (esp, round(es, 2)))
        if sup is not None:
            out.append("A break below support (~%s) invalidates the bullish view." % round(sup, 2))
    elif direction in ("BEARISH", "MODERATELY BEARISH"):
        if es is not None:
            out.append("A close above EMA%s (~%s) would weaken the downtrend." % (esp, round(es, 2)))
        if res is not None:
            out.append("A break above resistance (~%s) invalidates the bearish view." % round(res, 2))
    else:
        if res is not None:
            out.append("A sustained break above resistance (~%s) would turn the view up." % round(res, 2))
        if sup is not None:
            out.append("A sustained break below support (~%s) would turn the view down." % round(sup, 2))
    return out


def _evidence_strength(horizon, h, items, opt, fund, direction):
    """Classify HIGH / MODERATE / LOW / INSUFFICIENT with an explicit reason list."""
    reasons = []
    if not h or h.get("data_status") != "AVAILABLE_VALIDATED":
        return "INSUFFICIENT", ["Price data not validated for this horizon."]
    conf = (h.get("confidence") or "LOW").upper()
    level = {"HIGH": 3, "MODERATE": 2, "MEDIUM": 2, "LOW": 1}.get(conf, 1)
    reasons.append("Regime confidence: %s." % conf)

    bull = sum(1 for i in items if i["stance"] == "bullish")
    bear = sum(1 for i in items if i["stance"] == "bearish")
    if bull and bear and min(bull, bear) / max(bull, bear) >= 0.5:
        level -= 1
        reasons.append("Indicators conflict (%d bullish vs %d bearish)." % (bull, bear))
    elif max(bull, bear) >= 3:
        level += 1
        reasons.append("Indicators broadly agree (%d vs %d)." % (bull, bear))

    opt_status = (opt or {}).get("optimization_status")
    if horizon in ("swing", "long_term"):
        if opt_status == "COMPLETED":
            level += 1
            reasons.append("Stock has a walk-forward validated strategy.")
        else:
            level -= 1
            reasons.append("No validated strategy (optimisation %s)." % (opt_status or "absent"))

    if horizon == "long_term":
        fcat = (fund or {}).get("category", "INSUFFICIENT_DATA")
        if fcat == "INSUFFICIENT_DATA":
            level = min(level, 1)
            reasons.append("Fundamentals INSUFFICIENT_DATA — long-term strength capped at LOW.")
        elif (fund or {}).get("freshness") == "STALE":
            level -= 1
            reasons.append("Fundamental snapshot is STALE.")
        else:
            reasons.append("Fundamental category: %s." % fcat)

    if h.get("volatility") == "HIGH_VOLATILITY":
        level -= 1
        reasons.append("High volatility reduces reliability.")
    if h.get("reversal") == "POTENTIAL_REVERSAL":
        reasons.append("Potential reversal flagged.")

    level = max(1, min(3, level))
    return {3: "HIGH", 2: "MODERATE", 1: "LOW"}[level], reasons


def outlook_for_horizon(horizon, regime_stock, opt, rec, fund, direction_only=False):
    h = ((regime_stock or {}).get("horizons") or {}).get(horizon)
    base = {"horizon": horizon, "label": HORIZON_LABEL[horizon]}
    if not h:
        return dict(base, direction="INSUFFICIENT EVIDENCE", evidence_strength="INSUFFICIENT",
                    supporting=[], contradicting=[], risks=[], invalidation=[],
                    evidence_reasons=["No regime analysis for this horizon."],
                    last_candle=None, data_status=(regime_stock or {}).get("data_status"))
    items = _technical_evidence(h)
    direction, score, bull, bear = _direction(items)
    strength, reasons = _evidence_strength(horizon, h, items, opt, fund, direction)

    # Long-term fundamental context — shown, and able to temper the direction.
    fund_ctx = None
    if horizon == "long_term":
        fcat = (fund or {}).get("category", "INSUFFICIENT_DATA")
        fund_ctx = {"category": fcat, "sector_model": (fund or {}).get("sector_model"),
                    "gates_passed": (fund or {}).get("passed_gates"),
                    "gates_evaluated": (fund or {}).get("evaluated_gates"),
                    "note": None}
        if fcat == "INSUFFICIENT_DATA":
            fund_ctx["note"] = "No verified fundamentals — long-term conclusion rests on technicals only."
        elif fcat in ("WEAK", "CRITICAL") and direction in ("BULLISH", "MODERATELY BULLISH"):
            items.append(_item("Fundamentals", "risk",
                               "Weak fundamentals (%s) temper a bullish long-term view." % fcat))
        elif fcat in ("EXCELLENT", "GOOD") and direction in ("BEARISH", "MODERATELY BEARISH"):
            items.append(_item("Fundamentals", "neutral",
                               "Strong fundamentals (%s) may cushion the downtrend." % fcat))

    supporting = [i for i in items if (
        (direction.endswith("BULLISH") and i["stance"] == "bullish") or
        (direction.endswith("BEARISH") and i["stance"] == "bearish") or
        (direction == "NEUTRAL" and i["stance"] == "neutral"))]
    contradicting = [i for i in items if (
        (direction.endswith("BULLISH") and i["stance"] == "bearish") or
        (direction.endswith("BEARISH") and i["stance"] == "bullish"))]
    risks = [i for i in items if i["stance"] == "risk"]

    style_rec = ((rec or {}).get("styles") or {}).get(horizon) or {}
    return dict(base, direction=direction, evidence_strength=strength,
                supporting=supporting, contradicting=contradicting, risks=risks,
                invalidation=_invalidation(direction, h),
                evidence_reasons=reasons,
                recommendation=style_rec.get("recommendation"),
                fundamental_context=fund_ctx,
                indicators={k: v for k, v in (h.get("indicators") or {}).items()
                            if k in ("price", "ema_fast", "ema_slow", "ema_fast_period",
                                     "ema_slow_period", "adx", "rsi", "macd_hist", "atr_pct",
                                     "support", "resistance")},
                last_candle=h.get("last_candle"), data_status=h.get("data_status"),
                interval=h.get("interval"))


def build_stock(sym, name, regime_stock, opt, rec, fund, news, now_iso):
    horizons = {hz: outlook_for_horizon(hz, regime_stock, opt, rec, fund) for hz in HORIZONS}
    # data limitations surfaced once per stock
    limits = []
    if not regime_stock or not (regime_stock.get("horizons")):
        limits.append("No regime analysis on file — outlook is INSUFFICIENT EVIDENCE.")
    if (fund or {}).get("category", "INSUFFICIENT_DATA") == "INSUFFICIENT_DATA":
        limits.append("No verified fundamentals (fundamental coverage is 24/201).")
    if (opt or {}).get("optimization_status") != "COMPLETED":
        limits.append("No walk-forward validated strategy for this stock.")
    news_events = (news or {}).get("events") or []
    return {
        "symbol": sym, "name": name, "generated_at": now_iso,
        "methodology_version": METHODOLOGY_VERSION,
        "data_status": (regime_stock or {}).get("data_status"),
        "last_candle": ((regime_stock or {}).get("horizons", {}).get("swing") or {}).get("last_candle"),
        "horizons": horizons,
        "news_recent": len(news_events),
        "data_limitations": limits,
        "disclaimer": "Evidence-based directional outlook, NOT a probability or price target. "
                      "Predictive accuracy is not validated (outcome tracking postponed).",
    }


def summarise(records):
    by_dir = {hz: {} for hz in HORIZONS}
    by_strength = {hz: {} for hz in HORIZONS}
    for r in records.values():
        for hz, o in r["horizons"].items():
            by_dir[hz][o["direction"]] = by_dir[hz].get(o["direction"], 0) + 1
            by_strength[hz][o["evidence_strength"]] = by_strength[hz].get(o["evidence_strength"], 0) + 1
    return {"stocks": len(records), "direction_counts": by_dir, "evidence_strength_counts": by_strength}
