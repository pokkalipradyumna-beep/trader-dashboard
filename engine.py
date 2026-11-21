#!/usr/bin/env python3
"""Trader Dashboard - signals + chart engine. Standard library only.

Chart candles follow the selected timeframe (D/W/M) WITH volume; EMA 9/21/50
overlay on that timeframe. The method's SIGNAL/verdict is ALWAYS weekly
(short-term 9/21 entry + long-term 21/50 trend). Cross markers show on the
weekly timeframe only.
"""
import datetime as _dt
import json
import ssl
import time
import urllib.error
import urllib.request

# TLS context: the machine's system trust store (which, unlike certifi's Mozilla
# bundle, contains any antivirus/corporate interception root this network uses).
# Certificate-chain and hostname verification stay fully ON. We only clear
# VERIFY_X509_STRICT -- Python 3.13 enabled it by default, and it rejects this
# machine's (trusted) interception root for a formatting technicality
# (basicConstraints not marked critical). Clearing it restores the long-standing
# pre-3.13 default; it does NOT disable verification. (Owner-approved.)
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.verify_flags &= ~ssl.VERIFY_X509_STRICT

UA = "Mozilla/5.0 (TraderDashboard)"
_CACHE = {}
_TTL = 300
TF = {"W": ("1wk", "2y"), "D": ("1d", "6mo"), "M": ("1mo", "5y")}


class FeedError(Exception):
    """Base for data-feed problems, carrying an HTTP status + machine code."""
    code = "error"
    status = 502


class NotFoundError(FeedError):
    """Symbol isn't on the feed (delisted / renamed / typo)."""
    code = "not_found"
    status = 404


class FeedDownError(FeedError):
    """Can't reach the feed (network / TLS / 5xx)."""
    code = "feed_down"
    status = 503


class NoDataError(FeedError):
    """Symbol resolved but returned no usable candles."""
    code = "no_data"
    status = 422


def ema(values, period):
    out = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    k = 2.0 / (period + 1)
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def _yahoo_url(sym, rng, interval):
    s = sym.upper()
    head, dot, tail = s.rpartition(".")
    s = (head.replace(".", "-") + "." + tail) if (dot and tail.isalpha() and len(tail) >= 2) else s.replace(".", "-")
    return "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=%s" % (s, rng, interval)


def fetch_candles(symbol, interval="1wk", rng="2y"):
    req = urllib.request.Request(_yahoo_url(symbol, rng, interval), headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25, context=_SSL_CTX) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Yahoo answers 404 for a symbol it doesn't have (delisted/renamed/typo);
        # other HTTP codes mean the feed itself is unhappy.
        if e.code in (404, 400):
            raise NotFoundError("%s isn't on the data feed — it may be delisted, renamed, or mistyped." % symbol)
        raise FeedDownError("The data feed returned an error (HTTP %s). Try again shortly." % e.code)
    except urllib.error.URLError as e:
        raise FeedDownError("Can't reach the data feed right now (%s)." % getattr(e, "reason", e))
    except (TimeoutError, OSError) as e:  # noqa: BLE001
        raise FeedDownError("Can't reach the data feed right now (%s)." % e)
    res = (data.get("chart") or {}).get("result") or []
    if not res:
        err = ((data.get("chart") or {}).get("error") or {})
        if (err.get("code") or "").lower() in ("not found", "no data found, symbol may be delisted"):
            raise NotFoundError("%s isn't on the data feed — it may be delisted or renamed." % symbol)
        raise NoDataError("No price data available for %s right now." % symbol)
    r = res[0]
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    o, h, lo, c, v = q.get("open"), q.get("high"), q.get("low"), q.get("close"), q.get("volume")
    bars = []
    for i, t in enumerate(ts):
        ov, hv, lov, cv = o[i], h[i], lo[i], c[i]
        # Require a clean, positive OHLC. A null open/high/low (Yahoo sometimes
        # returns these even when close is present) makes a malformed candle that
        # distorts the chart's autoscale, so drop the bar.
        if None in (ov, hv, lov, cv) or min(ov, hv, lov, cv) <= 0 or hv < lov:
            continue
        d = _dt.datetime.utcfromtimestamp(t).date().isoformat()
        bars.append({"time": d, "open": ov, "high": hv, "low": lov,
                     "close": cv, "volume": v[i] or 0})
    if not bars:
        raise NoDataError("No usable price data for %s right now." % symbol)
    # Yahoo often appends a duplicate "live" candle for the current week/month:
    # the in-progress period appears twice — once at its proper start timestamp
    # and once at the latest trading day (a few days later). Merge a trailing
    # within-period duplicate into the proper period candle, otherwise the two
    # look like separate periods and week-over-week change reads ~0, the chart
    # shows a doubled last candle, and the weekly EMA/signal inputs are skewed.
    if interval in ("1wk", "1mo") and len(bars) >= 2:
        thresh = 6 if interval == "1wk" else 25  # normal spacing is ~7 / ~30 days
        merged = [bars[0]]
        for b in bars[1:]:
            gap = (_dt.date.fromisoformat(b["time"]) - _dt.date.fromisoformat(merged[-1]["time"])).days
            if gap < thresh:
                p = merged[-1]
                p["close"] = b["close"]
                p["high"] = max(p["high"], b["high"])
                p["low"] = min(p["low"], b["low"])
                p["volume"] = b["volume"] or p["volume"]
            else:
                merged.append(b)
        bars = merged
    meta = r.get("meta") or {}
    return {"currency": meta.get("currency", "INR"),
            "price": meta.get("regularMarketPrice"),
            "as_of": meta.get("regularMarketTime"), "bars": bars}


def _series(bars, vals):
    return [{"time": bars[i]["time"], "value": round(vals[i], 2)}
            for i in range(len(bars)) if vals[i] is not None]


def _crosses(bars, fast, slow, label):
    m = []
    for i in range(1, len(bars)):
        if None in (fast[i], slow[i], fast[i - 1], slow[i - 1]):
            continue
        if fast[i] >= slow[i] and fast[i - 1] < slow[i - 1]:
            m.append({"time": bars[i]["time"], "position": "belowBar", "color": "#15b870",
                      "shape": "arrowUp", "text": label + " ▲"})
        elif fast[i] < slow[i] and fast[i - 1] >= slow[i - 1]:
            m.append({"time": bars[i]["time"], "position": "aboveBar", "color": "#f04444",
                      "shape": "arrowDown", "text": label + " ▼"})
    return m


def _pair(e_fast, e_slow, i):
    if None in (e_fast[i], e_slow[i], e_fast[i - 1], e_slow[i - 1]):
        return None
    return {"fast": round(e_fast[i], 2), "slow": round(e_slow[i], 2),
            "fresh_bull": e_fast[i] >= e_slow[i] and e_fast[i - 1] < e_slow[i - 1],
            "fresh_bear": e_fast[i] < e_slow[i] and e_fast[i - 1] >= e_slow[i - 1],
            "regime": "above" if e_fast[i] >= e_slow[i] else "below"}


def _weekly_signal(bars):
    """9/21 + 21/50 on the last COMPLETED weekly candle, plus the verdict."""
    closes = [float(b["close"]) for b in bars]
    if len(closes) < 22:
        return None, None, None, {"action": "WAIT", "headline": "Not enough weekly data"}
    e9, e21, e50 = ema(closes, 9), ema(closes, 21), ema(closes, 50)
    i = len(bars) - 1
    today = _dt.date.today().isocalendar()[:2]
    if _dt.date.fromisoformat(bars[i]["time"]).isocalendar()[:2] == today and i > 0:
        i -= 1
    s, lt = _pair(e9, e21, i), _pair(e21, e50, i)
    if s is None:
        action, head = "WAIT", "Not enough data"
    elif s["fresh_bull"]:
        strong = lt and lt["regime"] == "above"
        action, head = "BUY", ("STRONG BUY - fresh 9/21 cross inside a long-term uptrend" if strong
                               else "BUY (caution) - 9/21 cross but long-term 21/50 still down")
    elif s["fresh_bear"]:
        action, head = "SELL", "SELL - fresh 9/21 death cross this week"
    elif s["regime"] == "above":
        action, head = "HOLD", "HOLD - 9/21 uptrend intact (no fresh cross)"
    else:
        action, head = "WAIT", "WAIT - 9/21 below, downtrend (no buy signal)"
    return s, lt, bars[i]["time"], {"action": action, "headline": head}


def compute(symbol, tf="W", use_cache=True):
    key = (symbol.upper(), tf)
    now = time.time()
    if use_cache:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _TTL:
            return hit[1]
    result = _compute(symbol, tf)
    _CACHE[key] = (now, result)
    return result


def _rsi_last(closes, period=14):
    if len(closes) <= period:
        return None
    gain = loss = 0.0
    for i in range(1, period + 1):
        ch = closes[i] - closes[i - 1]
        if ch >= 0:
            gain += ch
        else:
            loss -= ch
    ag, al = gain / period, loss / period
    r = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(period + 1, len(closes)):
        ch = closes[i] - closes[i - 1]
        ag = (ag * (period - 1) + (ch if ch > 0 else 0)) / period
        al = (al * (period - 1) + (-ch if ch < 0 else 0)) / period
        r = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return r


def _macd_hist_last(closes, fast=12, slow=26, sig=9):
    ef, es = ema(closes, fast), ema(closes, slow)
    macd = [(ef[i] - es[i]) if (ef[i] is not None and es[i] is not None) else None for i in range(len(closes))]
    first = next((i for i, v in enumerate(macd) if v is not None), None)
    if first is None:
        return None
    se = ema([(v if v is not None else 0.0) for v in macd[first:]], sig)
    signal = [None] * len(closes)
    for i, v in enumerate(se):
        if v is not None:
            signal[first + i] = v
    if macd[-1] is None or signal[-1] is None:
        return None
    return macd[-1] - signal[-1]


def confluence(s9, s21, closes):
    """Fuse the weekly method (9/21 + 21/50) with RSI + MACD into one tally."""
    votes = []
    if s9:
        votes.append({"name": "9/21", "core": True, "bull": s9.get("regime") == "above"})
    if s21:
        votes.append({"name": "21/50", "core": True, "bull": s21.get("regime") == "above"})
    r = _rsi_last(closes, 14)
    if r is not None:
        votes.append({"name": "RSI", "core": False, "bull": r > 50})
    h = _macd_hist_last(closes)
    if h is not None:
        votes.append({"name": "MACD", "core": False, "bull": h >= 0})
    total = len(votes)
    if total == 0:
        return None
    bull = sum(1 for v in votes if v["bull"])
    side = "bullish" if bull > total - bull else "bearish" if bull < total - bull else "mixed"
    return {"bull": bull, "total": total, "side": side, "votes": votes}


def _compute(symbol, tf):
    interval, rng = TF.get(tf, TF["W"])
    disp = fetch_candles(symbol, interval, rng)
    bars = disp["bars"]
    closes = [float(b["close"]) for b in bars]
    e9, e21, e50 = ema(closes, 9), ema(closes, 21), ema(closes, 50)
    # weekly signal: reuse display bars if already weekly, else fetch weekly
    wk_bars = bars if tf == "W" else fetch_candles(symbol, "1wk", "2y")["bars"]
    s9, s21, last_week, verdict = _weekly_signal(wk_bars)
    conf = confluence(s9, s21, [float(b["close"]) for b in wk_bars])
    markers = (_crosses(bars, e9, e21, "9/21") + _crosses(bars, e21, e50, "21/50")) if tf == "W" else []
    prev_close = bars[-2]["close"] if len(bars) >= 2 else None
    return {
        "confluence": conf,
        "symbol": symbol.upper(), "tf": tf, "currency": disp["currency"],
        "price": disp["price"] if tf != "W" else disp["price"],
        "as_of": disp.get("as_of"),
        "last_close": bars[-1]["close"] if bars else None, "prev_close": prev_close,
        "last_week": last_week,
        "candles": [{"time": b["time"], "open": round(b["open"], 2), "high": round(b["high"], 2),
                     "low": round(b["low"], 2), "close": round(b["close"], 2),
                     "volume": int(b["volume"] or 0)} for b in bars],
        "ema9": _series(bars, e9), "ema21": _series(bars, e21), "ema50": _series(bars, e50),
        "markers": markers, "signal_9_21": s9, "signal_21_50": s21, "verdict": verdict,
    }


_QCACHE = {}
_QTTL = 15  # short cache so polling reflects the latest (delayed) quote without hammering


def quote(symbol):
    """Lightweight latest price for live polling (no candles/EMAs/signals)."""
    key = symbol.upper()
    now = time.time()
    hit = _QCACHE.get(key)
    if hit and now - hit[0] < _QTTL:
        return hit[1]
    d = fetch_candles(symbol, "1d", "5d")
    bars = d["bars"]
    q = {"price": d.get("price") or (bars[-1]["close"] if bars else None),
         "prev_close": bars[-2]["close"] if len(bars) >= 2 else None,
         "as_of": d.get("as_of")}
    _QCACHE[key] = (now, q)
    return q


if __name__ == "__main__":
    import sys
    r = compute(sys.argv[1] if len(sys.argv) > 1 else "RELIANCE.NS")
    print(r["symbol"], r["verdict"]["action"], "-", r["verdict"]["headline"])
