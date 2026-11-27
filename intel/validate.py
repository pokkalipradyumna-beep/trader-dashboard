"""Phase 1: strict, auditable historical-data validation (requirement 2.3).

Flags problems; NEVER deletes or invents data. Fail-closed: a series is only
AVAILABLE_VALIDATED when it passes integrity AND freshness AND has enough bars.
Anything else is PARTIAL (usable with documented caveats) or
AWAITING_INSUFFICIENT. The caller maps fetch errors to UNSUPPORTED/DELISTED.
"""
import datetime as _dt

# Minimum history to consider a series "validated" for later optimisation. These
# are availability thresholds, not the (stricter) optimisation minimums (Phase 3).
MIN_DAILY = 180    # ~9 trading months
MIN_WEEKLY = 104   # ~2 years of weekly candles
STALE_DAILY_DAYS = 10   # EOD daily data older than this is stale
STALE_WEEKLY_DAYS = 20


def validate_history(bars, interval):
    issues = []
    n = len(bars or [])
    usable = [b for b in (bars or []) if b.get("close") is not None]
    checks = {"bars_total": n, "bars_usable": len(usable)}
    if not usable:
        return {"quality": "AWAITING_INSUFFICIENT", "bars": 0, "first_date": None,
                "last_date": None, "stale_days": None, "checks": checks,
                "issues": ["no usable candles returned"]}

    dates = [b["date"] for b in usable]
    checks["chronological"] = all(dates[i] < dates[i + 1] for i in range(len(dates) - 1))
    if not checks["chronological"]:
        issues.append("candles are not strictly chronological")
    dup = len(dates) - len(set(dates))
    checks["duplicate_dates"] = dup
    if dup:
        issues.append("%d duplicate timestamps" % dup)

    ohlc_bad = nonpos = 0
    for b in usable:
        o, h, l, c = b.get("open"), b.get("high"), b.get("low"), b.get("close")
        for x in (o, h, l, c):
            if x is not None and x <= 0:
                nonpos += 1
                break
        if None not in (o, h, l, c):
            if h < max(o, c) or l > min(o, c) or h < l:
                ohlc_bad += 1
    checks["ohlc_violations"] = ohlc_bad
    checks["nonpositive_prices"] = nonpos
    if ohlc_bad:
        issues.append("%d OHLC-relationship violations (flagged, not removed)" % ohlc_bad)
    if nonpos:
        issues.append("%d zero/negative prices" % nonpos)

    extreme = 0
    for i in range(1, len(usable)):
        pc, c = usable[i - 1]["close"], usable[i]["close"]
        if pc and c and abs(c / pc - 1) > 0.5:
            extreme += 1
    checks["extreme_moves_gt50pct"] = extreme
    if extreme:
        issues.append("%d single-candle moves >50%% — verify against splits/bonuses" % extreme)

    # gaps: count unusually large date spacing (calendar-day heuristic)
    gap_thresh = 20 if interval.startswith("1wk") else (40 if interval.startswith("1mo") else 6)
    gaps = 0
    for i in range(1, len(dates)):
        try:
            d0 = _dt.date.fromisoformat(dates[i - 1])
            d1 = _dt.date.fromisoformat(dates[i])
            if (d1 - d0).days > gap_thresh:
                gaps += 1
        except Exception:  # noqa: BLE001
            pass
    checks["large_gaps"] = gaps
    if gaps:
        issues.append("%d larger-than-expected date gaps" % gaps)

    last = dates[-1]
    try:
        stale_days = (_dt.date.today() - _dt.date.fromisoformat(last)).days
    except Exception:  # noqa: BLE001
        stale_days = None
    checks["stale_days"] = stale_days

    min_bars = MIN_WEEKLY if interval.startswith("1wk") else (MIN_WEEKLY if interval.startswith("1mo") else MIN_DAILY)
    enough = len(usable) >= min_bars
    checks["min_bars_required"] = min_bars
    checks["enough_bars"] = enough
    if not enough:
        issues.append("only %d usable bars (need %d) — insufficient for validation" % (len(usable), min_bars))

    stale_limit = STALE_WEEKLY_DAYS if (interval.startswith("1wk") or interval.startswith("1mo")) else STALE_DAILY_DAYS
    fresh = stale_days is not None and stale_days <= stale_limit
    if not fresh:
        issues.append("data is stale (last candle %s)" % last)

    integrity_ok = checks["chronological"] and dup == 0 and ohlc_bad == 0 and nonpos == 0
    if not enough:
        quality = "AWAITING_INSUFFICIENT"
    elif integrity_ok and fresh:
        quality = "AVAILABLE_VALIDATED"
    else:
        quality = "PARTIAL"

    return {"quality": quality, "bars": len(usable), "first_date": dates[0],
            "last_date": last, "stale_days": stale_days, "checks": checks, "issues": issues}
