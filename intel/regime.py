"""Phase 2: explainable, rule-based Market Regime Engine.

Independent of the weekly EMA 9/21/50 trading engine (engine.py) — it does not
import or alter it. Classifies, PER HORIZON, three SEPARATE dimensions:

    trend     : BULLISH | BEARISH | SIDEWAYS | UNCERTAIN
    volatility: HIGH_VOLATILITY | LOW_VOLATILITY | NORMAL | UNCERTAIN
    reversal  : POTENTIAL_REVERSAL | NONE   (requires >=2 independent signals
                AGAINST the prevailing trend — never a single indicator cross)

A stock can be e.g. BULLISH + HIGH_VOLATILITY at once (trend != volatility).
`confidence` is an EVIDENCE-STRENGTH label (LOW/MODERATE/HIGH), explicitly NOT a
calibrated probability. Insufficient/stale/conflicting data -> UNCERTAIN with a
reason. Only COMPLETED candles are used (completed_bars) -> no look-ahead.

Versioned output (METHODOLOGY_VERSION) so Phase 3/4 can consume stable results.
"""
from __future__ import annotations

import datetime as _dt

from intel import indicators as ind

METHODOLOGY_VERSION = "regime-v1.0"

# ---- explicit thresholds (single source of truth) ----
ADX_TREND = 25.0          # >= strong trend
ADX_WEAK = 18.0           # <  no meaningful trend (range)
EMA_FLAT_PCT = 1.5        # |slow-EMA slope| below this (% over slope window) = flat
RSI_OB = 70.0
RSI_OS = 30.0
VOL_HIGH_PCTL = 0.80      # ATR%/bandwidth in top 20% of own 1y history = HIGH
VOL_LOW_PCTL = 0.20       # bottom 20% = LOW
SR_NEAR_PCT = 3.0         # within 3% of a pivot S/R = "near"
MIN_VOL_PCTL_HISTORY = 60  # need this many historical vol readings to bucket

# Horizon -> (interval, fast EMA, slow EMA, slope window, min completed bars)
HORIZONS = {
    "short_term": {"interval": "1d", "fast": 20, "slow": 50, "slope_win": 10, "min_bars": 70},
    "swing":      {"interval": "1d", "fast": 50, "slow": 200, "slope_win": 20, "min_bars": 210},
    "long_term":  {"interval": "1wk", "fast": 21, "slow": 50, "slope_win": 8, "min_bars": 55},
}


def completed_bars(bars, interval):
    """Drop the final, possibly-forming candle so classification uses only
    COMPLETED candles (no look-ahead). Daily: drop if dated today. Weekly: drop
    if in the current ISO week. Monthly: drop if in the current calendar month."""
    if not bars:
        return bars
    try:
        last = _dt.date.fromisoformat(bars[-1]["date"])
    except Exception:  # noqa: BLE001
        return bars
    today = _dt.date.today()
    if interval.startswith("1wk"):
        forming = last.isocalendar()[:2] == today.isocalendar()[:2]
    elif interval.startswith("1mo"):
        forming = (last.year, last.month) == (today.year, today.month)
    else:
        forming = last >= today
    return bars[:-1] if forming else bars


def _closes(bars):
    return [b.get("close") for b in bars]


def _evidence_level(agree, total):
    if total <= 0:
        return "LOW"
    frac = agree / total
    if frac >= 0.75:
        return "HIGH"
    if frac >= 0.5:
        return "MODERATE"
    return "LOW"


def classify_horizon(bars, cfg, data_status):
    """Classify one horizon. `bars` must already be the right interval's series
    (completed candles only). Returns the full per-horizon record."""
    interval = cfg["interval"]
    bars = completed_bars(bars, interval)
    # Yahoo can return trailing candles with null OHLC for the latest period;
    # strip any trailing bars whose close is None so `price` is always real.
    while bars and bars[-1].get("close") is None:
        bars = bars[:-1]
    n = len(bars)
    last_candle = bars[-1]["date"] if bars else None
    base = {"interval": interval, "last_candle": last_candle, "bars_used": n,
            "data_status": data_status}

    # Gate: data quality + sufficiency
    if data_status not in ("AVAILABLE_VALIDATED", "PARTIAL"):
        return dict(base, trend="UNCERTAIN", volatility="UNCERTAIN", reversal="NONE",
                    confidence="LOW", reasons=["data not validated (%s)" % data_status],
                    indicators={})
    if n < cfg["min_bars"]:
        return dict(base, trend="UNCERTAIN", volatility="UNCERTAIN", reversal="NONE",
                    confidence="LOW",
                    reasons=["insufficient completed candles: %d < %d" % (n, cfg["min_bars"])],
                    indicators={})

    closes = _closes(bars)
    price = closes[-1]
    if price is None:
        return dict(base, trend="UNCERTAIN", volatility="UNCERTAIN", reversal="NONE",
                    confidence="LOW", reasons=["latest completed close missing"], indicators={})
    fast = ind.ema(closes, cfg["fast"])
    slow = ind.ema(closes, cfg["slow"])
    adx_s, pdi_s, mdi_s = ind.adx(bars, 14)
    rsi_s = ind.rsi(closes, 14)
    _, _, hist = ind.macd(closes)
    atr_s = ind.atr(bars, 14)
    _, bb_up, bb_lo, bb_pb, bb_bw = ind.bollinger(closes, 20, 2.0)
    obv_s = ind.obv(bars)
    sr = ind.support_resistance(bars, price)

    f, s = fast[-1], slow[-1]
    adx_v, pdi_v, mdi_v = adx_s[-1], pdi_s[-1], mdi_s[-1]
    rsi_v = rsi_s[-1]
    hist_v = hist[-1]
    atr_v = atr_s[-1]
    slope = ind.slope_pct(slow, cfg["slope_win"])
    pb = bb_pb[-1]

    iv = {"price": _r(price), "ema_fast": _r(f), "ema_slow": _r(s),
          "ema_fast_period": cfg["fast"], "ema_slow_period": cfg["slow"],
          "adx": _r(adx_v), "plus_di": _r(pdi_v), "minus_di": _r(mdi_v),
          "rsi": _r(rsi_v), "macd_hist": _r(hist_v, 4), "atr": _r(atr_v),
          "atr_pct": _r(100.0 * atr_v / price, 3) if (atr_v and price) else None,
          "slow_ema_slope_pct": _r(slope, 3), "bb_pctb": _r(pb, 3),
          "hist_vol_annual_pct": _r(ind.hist_vol(closes, 20), 2),
          "support": _r(sr["support"]), "resistance": _r(sr["resistance"]),
          "support_dist_pct": _r(sr["support_dist_pct"], 2),
          "resistance_dist_pct": _r(sr["resistance_dist_pct"], 2)}

    # ---------- TREND (separate from volatility) ----------
    reasons = []
    up_struct = f is not None and s is not None and price > f > s
    dn_struct = f is not None and s is not None and price < f < s
    sloping_up = slope is not None and slope > EMA_FLAT_PCT
    sloping_dn = slope is not None and slope < -EMA_FLAT_PCT
    flat = slope is not None and abs(slope) <= EMA_FLAT_PCT
    trending = adx_v is not None and adx_v >= ADX_WEAK
    strong = adx_v is not None and adx_v >= ADX_TREND
    di_up = (pdi_v or 0) > (mdi_v or 0)
    macd_up = hist_v is not None and hist_v > 0

    strong_slope = slope is not None and abs(slope) > 2 * EMA_FLAT_PCT
    bull_votes = sum([up_struct, sloping_up, di_up, macd_up,
                      (rsi_v is not None and rsi_v >= 50)])
    bear_votes = sum([dn_struct, sloping_dn, (not di_up), (hist_v is not None and hist_v < 0),
                      (rsi_v is not None and rsi_v < 50)])

    # ADX gates trend-vs-range: weak ADX = no meaningful trend -> SIDEWAYS unless
    # there is a clearly strong EMA slope WITH matching price structure.
    if not trending:
        if strong_slope and sloping_up and up_struct:
            trend = "BULLISH"
            reasons.append("weak ADX %.0f but strong rising EMA%d slope %.1f%% with price>EMAs" % (
                adx_v or 0, cfg["slow"], slope))
        elif strong_slope and sloping_dn and dn_struct:
            trend = "BEARISH"
            reasons.append("weak ADX %.0f but strong falling EMA%d slope %.1f%% with price<EMAs" % (
                adx_v or 0, cfg["slow"], slope))
        else:
            trend = "SIDEWAYS"
            reasons.append("ADX %.0f below %.0f (no trend) + EMA%d slope %.1f%% -> ranging" % (
                adx_v or 0, ADX_WEAK, cfg["slow"], slope or 0))
    else:
        if (up_struct or (di_up and sloping_up)) and bull_votes > bear_votes:
            trend = "BULLISH"
            reasons.append("ADX %.0f trending, +DI>-DI, price/EMA structure up (bull %d/5)" % (
                adx_v or 0, bull_votes))
        elif (dn_struct or ((not di_up) and sloping_dn)) and bear_votes > bull_votes:
            trend = "BEARISH"
            reasons.append("ADX %.0f trending, -DI>+DI, price/EMA structure down (bear %d/5)" % (
                adx_v or 0, bear_votes))
        elif bull_votes >= 4 and bull_votes > bear_votes:
            trend = "BULLISH"
            reasons.append("ADX %.0f, majority bullish evidence (%d/5)" % (adx_v or 0, bull_votes))
        elif bear_votes >= 4 and bear_votes > bull_votes:
            trend = "BEARISH"
            reasons.append("ADX %.0f, majority bearish evidence (%d/5)" % (adx_v or 0, bear_votes))
        else:
            trend = "UNCERTAIN"
            reasons.append("trending (ADX %.0f) but structure conflicts (bull %d / bear %d)" % (
                adx_v or 0, bull_votes, bear_votes))

    if trend == "SIDEWAYS":
        agree = 3
    elif trend == "UNCERTAIN":
        agree = 2
    else:
        agree = max(bull_votes, bear_votes)
    # strong ADX lifts confidence for a directional call
    if trend in ("BULLISH", "BEARISH") and strong:
        agree = min(5, agree + 1)
    trend_conf = _evidence_level(agree, 5)

    # ---------- VOLATILITY (separate dimension) ----------
    atr_pct_series = [100.0 * atr_s[i] / closes[i]
                      for i in range(len(closes))
                      if atr_s[i] is not None and closes[i]]
    cur_atr_pct = 100.0 * atr_v / price if (atr_v and price) else None
    hist_series = atr_pct_series[:-1]
    pctl = ind.percentile_rank(hist_series, cur_atr_pct) if len(atr_pct_series) > MIN_VOL_PCTL_HISTORY else None
    # dispersion guard: if the stock's own ATR% history is near-constant, the
    # percentile is noise -> report NORMAL rather than a spurious HIGH/LOW.
    dispersion_ok = False
    if hist_series:
        sorted_h = sorted(hist_series)
        p10 = sorted_h[max(0, int(0.10 * len(sorted_h)) - 1)]
        p90 = sorted_h[min(len(sorted_h) - 1, int(0.90 * len(sorted_h)))]
        med = sorted_h[len(sorted_h) // 2]
        dispersion_ok = med > 0 and (p90 - p10) / med >= 0.15
    if pctl is None:
        volatility = "UNCERTAIN"
        vol_reason = "insufficient volatility history to bucket"
    elif not dispersion_ok:
        volatility = "NORMAL"
        vol_reason = "ATR%% history near-constant -> normal (no vol regime)"
    elif pctl >= VOL_HIGH_PCTL:
        volatility = "HIGH_VOLATILITY"
        vol_reason = "ATR%% in %.0fth pctl of own 1y history" % (pctl * 100)
    elif pctl <= VOL_LOW_PCTL:
        volatility = "LOW_VOLATILITY"
        vol_reason = "ATR%% in %.0fth pctl of own 1y history" % (pctl * 100)
    else:
        volatility = "NORMAL"
        vol_reason = "ATR%% in %.0fth pctl (mid-range)" % (pctl * 100)
    iv["atr_pct_percentile"] = _r(pctl, 3) if pctl is not None else None
    reasons.append(vol_reason)

    # ---------- REVERSAL (needs >=2 independent signals vs the prevailing trend) ----------
    rev_signals = []
    prevailing_up = trend == "BULLISH"
    prevailing_dn = trend == "BEARISH"
    # 1) RSI exiting an extreme opposite to trend
    if prevailing_up and rsi_v is not None and rsi_v >= RSI_OB:
        rev_signals.append("RSI overbought (%.0f) in uptrend" % rsi_v)
    if prevailing_dn and rsi_v is not None and rsi_v <= RSI_OS:
        rev_signals.append("RSI oversold (%.0f) in downtrend" % rsi_v)
    # 2) Bollinger pierce then close back inside (exhaustion)
    if pb is not None:
        if prevailing_up and pb >= 1.0:
            rev_signals.append("close at/above upper Bollinger band")
        if prevailing_dn and pb <= 0.0:
            rev_signals.append("close at/below lower Bollinger band")
    # 3) MACD histogram momentum flip against trend
    if hist_v is not None and len(hist) >= 2 and hist[-2] is not None:
        if prevailing_up and hist[-2] > 0 and hist_v < hist[-2]:
            rev_signals.append("MACD momentum weakening in uptrend")
        if prevailing_dn and hist[-2] < 0 and hist_v > hist[-2]:
            rev_signals.append("MACD momentum weakening in downtrend")
    # 4) ADX falling from a strong reading (trend exhaustion)
    if adx_v is not None and len(adx_s) >= 4 and adx_s[-4] is not None:
        if adx_s[-4] >= ADX_TREND and adx_v < adx_s[-4] - 3:
            rev_signals.append("ADX falling from strong (%.0f->%.0f)" % (adx_s[-4], adx_v))
    # 5) At a pivot S/R barrier aligned against the trend
    if prevailing_up and sr["resistance_dist_pct"] is not None and sr["resistance_dist_pct"] <= SR_NEAR_PCT:
        rev_signals.append("testing resistance %.1f%% away" % sr["resistance_dist_pct"])
    if prevailing_dn and sr["support_dist_pct"] is not None and sr["support_dist_pct"] <= SR_NEAR_PCT:
        rev_signals.append("testing support %.1f%% away" % sr["support_dist_pct"])

    if (prevailing_up or prevailing_dn) and len(rev_signals) >= 2:
        reversal = "POTENTIAL_REVERSAL"
        reasons.append("reversal watch: " + "; ".join(rev_signals))
    else:
        reversal = "NONE"
        if rev_signals:
            reasons.append("single reversal hint only (not enough): " + "; ".join(rev_signals))

    # volume context (flagged reliability)
    vol_ok = all(b.get("volume") for b in bars[-20:])
    obv_slope = ind.slope_pct([v for v in obv_s if v is not None], 10) if vol_ok else None
    iv["volume_reliable"] = bool(vol_ok)
    iv["obv_slope_pct"] = _r(obv_slope, 2) if obv_slope is not None else None

    return dict(base, trend=trend, volatility=volatility, reversal=reversal,
                confidence=trend_conf, reasons=reasons, indicators=iv)


def _r(x, nd=2):
    try:
        return round(float(x), nd)
    except (TypeError, ValueError):
        return None


def evaluate(symbol, name, daily_bars, weekly_bars, daily_status, weekly_status):
    """Full multi-horizon evaluation for one instrument. short_term/swing use
    daily bars; long_term uses weekly bars. Returns the stored record shape."""
    horizons = {}
    for hz, cfg in HORIZONS.items():
        if cfg["interval"] == "1wk":
            bars, status = weekly_bars, weekly_status
        else:
            bars, status = daily_bars, daily_status
        horizons[hz] = classify_horizon(bars or [], cfg, status)
    return {
        "symbol": symbol, "name": name,
        "methodology_version": METHODOLOGY_VERSION,
        "evaluated_at": _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat(),
        "horizons": horizons,
    }
