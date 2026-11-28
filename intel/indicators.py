"""Phase 2: stdlib technical-indicator math, reusable by the regime engine now
and the Phase 3 optimisation engine later.

Design notes:
  * Pure Python / no third-party deps (serverless-safe).
  * Every function takes plain lists of floats (or OHLC dict bars) and returns
    a list aligned to the input (leading values are None until enough history),
    OR a scalar for the latest value — documented per function.
  * No look-ahead: value at index i uses only bars[0..i]. Callers pass ONLY
    completed candles (see regime.completed_bars).
  * Missing inputs (None) are skipped/propagated, never invented.

These are independent of the weekly EMA 9/21/50 trading engine (engine.py) and
do not import or modify it.
"""
from __future__ import annotations

import math


# ---------- basic series ----------
def sma(values, period):
    out = [None] * len(values)
    s = 0.0
    q = []
    for i, v in enumerate(values):
        if v is None:
            q.append(0.0)
        else:
            q.append(v)
        s += q[-1]
        if len(q) > period:
            s -= q[-period - 1]
        if i >= period - 1:
            out[i] = s / period
    return out


def ema(values, period):
    out = [None] * len(values)
    k = 2.0 / (period + 1)
    prev = None
    seed_sum = 0.0
    seeded = 0
    for i, v in enumerate(values):
        if v is None:
            out[i] = prev
            continue
        if prev is None:
            seed_sum += v
            seeded += 1
            if seeded == period:
                prev = seed_sum / period
                out[i] = prev
            continue
        prev = v * k + prev * (1 - k)
        out[i] = prev
    return out


def slope_pct(values, period):
    """Percent change of a series over `period` bars (latest vs period-ago),
    normalised to the earlier value. Returns scalar or None."""
    xs = [v for v in values if v is not None]
    if len(xs) <= period:
        return None
    a, b = xs[-period - 1], xs[-1]
    if not a:
        return None
    return (b / a - 1.0) * 100.0


# ---------- momentum ----------
def rsi(closes, period=14):
    """Wilder's RSI series (0..100). None until seeded."""
    out = [None] * len(closes)
    gains = losses = 0.0
    for i in range(1, len(closes)):
        if closes[i] is None or closes[i - 1] is None:
            continue
        ch = closes[i] - closes[i - 1]
        g = max(ch, 0.0)
        l = max(-ch, 0.0)
        if i <= period:
            gains += g
            losses += l
            if i == period:
                ag, al = gains / period, losses / period
                out[i] = 100.0 if al == 0 else 100.0 - 100.0 / (1 + ag / al)
                _ag, _al = ag, al
        else:
            _ag = (_ag * (period - 1) + g) / period
            _al = (_al * (period - 1) + l) / period
            out[i] = 100.0 if _al == 0 else 100.0 - 100.0 / (1 + _ag / _al)
    return out


def macd(closes, fast=12, slow=26, signal=9):
    """Return (macd_line, signal_line, hist) as aligned lists."""
    ef, es = ema(closes, fast), ema(closes, slow)
    line = [None if (a is None or b is None) else a - b for a, b in zip(ef, es)]
    sig = ema([0.0 if v is None else v for v in line], signal)
    # mask signal where macd line not yet available
    sig = [None if line[i] is None else sig[i] for i in range(len(line))]
    hist = [None if (line[i] is None or sig[i] is None) else line[i] - sig[i] for i in range(len(line))]
    return line, sig, hist


def roc(closes, period=12):
    out = [None] * len(closes)
    for i in range(period, len(closes)):
        a, b = closes[i - period], closes[i]
        if a and b:
            out[i] = (b / a - 1.0) * 100.0
    return out


# ---------- volatility ----------
def true_range(bars):
    out = [None] * len(bars)
    for i in range(len(bars)):
        h, l = bars[i].get("high"), bars[i].get("low")
        if h is None or l is None:
            continue
        if i == 0 or bars[i - 1].get("close") is None:
            out[i] = h - l
        else:
            pc = bars[i - 1]["close"]
            out[i] = max(h - l, abs(h - pc), abs(l - pc))
    return out


def atr(bars, period=14):
    """Wilder's ATR series."""
    tr = true_range(bars)
    out = [None] * len(bars)
    acc = 0.0
    cnt = 0
    prev = None
    for i, v in enumerate(tr):
        if v is None:
            continue
        if prev is None:
            acc += v
            cnt += 1
            if cnt == period:
                prev = acc / period
                out[i] = prev
            continue
        prev = (prev * (period - 1) + v) / period
        out[i] = prev
    return out


def adx(bars, period=14):
    """Wilder's ADX with +DI/-DI. Returns (adx, plus_di, minus_di) lists."""
    n = len(bars)
    adx_o = [None] * n
    pdi_o = [None] * n
    mdi_o = [None] * n
    tr = true_range(bars)
    plus_dm = [0.0] * n
    minus_dm = [0.0] * n
    for i in range(1, n):
        h, l = bars[i].get("high"), bars[i].get("low")
        ph, pl = bars[i - 1].get("high"), bars[i - 1].get("low")
        if None in (h, l, ph, pl):
            continue
        up, dn = h - ph, pl - l
        plus_dm[i] = up if (up > dn and up > 0) else 0.0
        minus_dm[i] = dn if (dn > up and dn > 0) else 0.0
    # Wilder smoothing
    str_ = pdm = mdm = 0.0
    dx_vals = []
    adx_prev = None
    seeded = False
    for i in range(1, n):
        if tr[i] is None:
            continue
        if i <= period:
            str_ += tr[i]
            pdm += plus_dm[i]
            mdm += minus_dm[i]
            if i == period:
                seeded = True
        else:
            str_ = str_ - str_ / period + tr[i]
            pdm = pdm - pdm / period + plus_dm[i]
            mdm = mdm - mdm / period + minus_dm[i]
        if not seeded or str_ == 0:
            continue
        pdi = 100.0 * pdm / str_
        mdi = 100.0 * mdm / str_
        pdi_o[i] = pdi
        mdi_o[i] = mdi
        denom = pdi + mdi
        dx = 0.0 if denom == 0 else 100.0 * abs(pdi - mdi) / denom
        dx_vals.append((i, dx))
        if adx_prev is None:
            if len(dx_vals) == period:
                adx_prev = sum(d for _, d in dx_vals) / period
                adx_o[i] = adx_prev
        else:
            adx_prev = (adx_prev * (period - 1) + dx) / period
            adx_o[i] = adx_prev
    return adx_o, pdi_o, mdi_o


def bollinger(closes, period=20, mult=2.0):
    """Return (mid, upper, lower, pct_b, bandwidth) latest-aligned lists."""
    mid = sma(closes, period)
    up = [None] * len(closes)
    lo = [None] * len(closes)
    pb = [None] * len(closes)
    bw = [None] * len(closes)
    for i in range(len(closes)):
        if i < period - 1:
            continue
        window = [c for c in closes[i - period + 1:i + 1] if c is not None]
        if len(window) < period or mid[i] is None:
            continue
        m = mid[i]
        var = sum((c - m) ** 2 for c in window) / period
        sd = math.sqrt(var)
        up[i] = m + mult * sd
        lo[i] = m - mult * sd
        rng = up[i] - lo[i]
        pb[i] = None if rng == 0 else (closes[i] - lo[i]) / rng
        bw[i] = None if m == 0 else rng / m
    return mid, up, lo, pb, bw


def hist_vol(closes, period=20):
    """Annualised historical volatility (%) from daily log returns. Scalar."""
    rets = []
    for i in range(1, len(closes)):
        a, b = closes[i - 1], closes[i]
        if a and b and a > 0 and b > 0:
            rets.append(math.log(b / a))
    rets = rets[-period:]
    if len(rets) < max(5, period // 2):
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var) * math.sqrt(252) * 100.0


def percentile_rank(series, value):
    """Fraction (0..1) of historical `series` values <= `value`. For regime
    volatility bucketing against a stock's OWN history (not cross-sectional)."""
    xs = [v for v in series if v is not None]
    if not xs or value is None:
        return None
    return sum(1 for v in xs if v <= value) / len(xs)


# ---------- volume / structure ----------
def obv(bars):
    out = [None] * len(bars)
    acc = 0.0
    started = False
    for i in range(1, len(bars)):
        c, pc = bars[i].get("close"), bars[i - 1].get("close")
        v = bars[i].get("volume")
        if None in (c, pc, v):
            out[i] = acc if started else None
            continue
        if c > pc:
            acc += v
        elif c < pc:
            acc -= v
        started = True
        out[i] = acc
    return out


def swing_points(bars, left=3, right=3):
    """Pivot highs/lows using a symmetric window (no look-ahead beyond the
    confirmed pivot: a pivot at i is only known after `right` more bars, which
    callers respect by reading pivots strictly before the latest bar).
    Returns (highs, lows) as lists of (index, price)."""
    highs, lows = [], []
    n = len(bars)
    for i in range(left, n - right):
        h = bars[i].get("high")
        l = bars[i].get("low")
        if h is None or l is None:
            continue
        hs = [bars[j].get("high") for j in range(i - left, i + right + 1)]
        ls = [bars[j].get("low") for j in range(i - left, i + right + 1)]
        if None in hs or None in ls:
            continue
        if h == max(hs) and hs.count(h) == 1:
            highs.append((i, h))
        if l == min(ls) and ls.count(l) == 1:
            lows.append((i, l))
    return highs, lows


def support_resistance(bars, price, left=3, right=3, lookback=120):
    """Nearest support (below) and resistance (above) from recent pivots.
    Returns {support, resistance, support_dist_pct, resistance_dist_pct}."""
    sub = bars[-lookback:] if lookback and len(bars) > lookback else bars
    highs, lows = swing_points(sub, left, right)
    res = [p for _, p in highs if price is not None and p >= price]
    sup = [p for _, p in lows if price is not None and p <= price]
    resistance = min(res) if res else None
    support = max(sup) if sup else None
    rd = None if (resistance is None or not price) else (resistance / price - 1.0) * 100.0
    sd = None if (support is None or not price) else (1.0 - support / price) * 100.0
    return {"support": support, "resistance": resistance,
            "support_dist_pct": sd, "resistance_dist_pct": rd}
