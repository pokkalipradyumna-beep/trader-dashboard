"""Phase 7 — recommendation outcome tracking (pure logic, no I/O).

Evaluates each append-only recommendation event forward in time, at fixed
session horizons. Rules (chosen to avoid look-ahead and to be conservative):

  * SIGNAL date  = provenance.daily_last_date (the last completed candle the
                   recommendation actually used).
  * ENTRY        = the first session strictly AFTER the signal date (the
                   earliest session a user could have acted on). Price = its
                   ADJUSTED close (split/bonus/dividend-consistent proxy for a
                   next-session fill; intrabar fills are NOT modelled).
  * EXIT at h    = the adjusted close h sessions after the entry session.
  * Only COMPLETED sessions are used: a bar counts only if its date is strictly
    before the evaluation run date (today's session is never used).
  * A horizon is evaluated only when all of its sessions exist. Incomplete
    horizons are NOT reported as wins or losses.
  * MFE / MAE use adjusted closes over the window (intrabar extremes not used).
  * stop / target hits use UNADJUSTED high/low against the price levels stored
    at signal time (levels are never rescaled). Only events that carry a stop
    or target are checked; others report null.
  * Events with no adjusted close (has_adjclose false) are reported as
    NO_ADJCLOSE, never silently filled from unadjusted prices.

Nothing here writes files. Recommendation history is never modified.
"""

HORIZONS = (5, 10, 20, 60)
ACTIONABLE = ("STRONG BUY", "BUY")
MIN_SAMPLE = 30  # below this a bucket is reported as insufficient sample


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def evaluate_event(event, bars, run_date, has_adjclose=True, horizons=HORIZONS):
    """Return a list of outcome records (one per COMPLETED horizon).

    event: a recommend_history event dict.
    bars:  list of {date, high, low, close, adjclose} sorted ascending by date.
    run_date: ISO date (YYYY-MM-DD) of the evaluation run.
    """
    signal = ((event.get("provenance") or {}).get("daily_last_date"))
    base = {"rec_id": event.get("id"), "symbol": event.get("symbol"),
            "style": event.get("style"), "label": event.get("new_recommendation"),
            "signal_date": signal, "run_date": run_date,
            "stop": _num(event.get("stop")), "target": _num(event.get("target"))}
    if not signal:
        return []  # cannot place the event in time: skip, never guess
    if not has_adjclose:
        return [dict(base, horizon=h, status="NO_ADJCLOSE") for h in horizons]

    # completed sessions only, strictly after the signal, strictly before run date
    usable = [b for b in bars if b.get("date") and b["date"] < run_date]
    after = [i for i, b in enumerate(usable) if b["date"] > signal]
    if not after:
        return []  # no session after the signal yet
    e = after[0]
    entry = usable[e]
    entry_px = _num(entry.get("adjclose"))
    if entry_px is None or entry_px <= 0:
        return [dict(base, horizon=h, status="NO_ADJCLOSE") for h in horizons]

    out = []
    for h in horizons:
        if e + h >= len(usable):
            continue  # horizon not yet complete: not reported as win or loss
        window = usable[e:e + h + 1]
        closes = [_num(b.get("adjclose")) for b in window]
        if any(c is None for c in closes):
            out.append(dict(base, horizon=h, status="NO_ADJCLOSE"))
            continue
        exit_b = usable[e + h]
        exit_px = closes[-1]
        rets = [c / entry_px - 1.0 for c in closes]
        stop_hit = target_hit = None
        if base["stop"] is not None or base["target"] is not None:
            stop_hit = target_hit = False
            for b in window[1:]:  # from the session after entry
                lo, hi = _num(b.get("low")), _num(b.get("high"))
                if base["stop"] is not None and lo is not None and lo <= base["stop"]:
                    stop_hit = True
                if base["target"] is not None and hi is not None and hi >= base["target"]:
                    target_hit = True
        out.append(dict(base, horizon=h, status="EVALUATED",
                        entry_date=entry["date"], entry_adjclose=round(entry_px, 4),
                        exit_date=exit_b["date"], exit_adjclose=round(exit_px, 4),
                        return_pct=round((exit_px / entry_px - 1.0) * 100, 4),
                        mfe_pct=round(max(rets[1:]) * 100, 4) if h > 0 else 0.0,
                        mae_pct=round(min(rets[1:]) * 100, 4) if h > 0 else 0.0,
                        stop_hit=stop_hit, target_hit=target_hit))
    return out


def summarise(records):
    """Aggregate EVALUATED records per (label, style, horizon). Sample size is
    always shown; buckets below MIN_SAMPLE are flagged, not interpreted."""
    buckets = {}
    for r in records:
        if r.get("status") != "EVALUATED":
            continue
        k = (r["label"], r["style"], r["horizon"])
        buckets.setdefault(k, []).append(r)
    rows = []
    for (label, style, h), rs in sorted(buckets.items()):
        rets = [x["return_pct"] for x in rs]
        wins = [x for x in rets if x > 0]
        losses = [x for x in rets if x < 0]
        pf = (round(sum(wins) / abs(sum(losses)), 3) if losses else None)
        rows.append({
            "label": label, "style": style, "horizon_sessions": h, "n": len(rs),
            "sufficient_sample": len(rs) >= MIN_SAMPLE,
            "mean_return_pct": round(sum(rets) / len(rets), 4),
            "win_rate_pct": round(100.0 * len(wins) / len(rets), 2),
            "avg_win_pct": round(sum(wins) / len(wins), 4) if wins else None,
            "avg_loss_pct": round(sum(losses) / len(losses), 4) if losses else None,
            "profit_factor": pf,
            "mean_mfe_pct": round(sum(x["mfe_pct"] for x in rs) / len(rs), 4),
            "mean_mae_pct": round(sum(x["mae_pct"] for x in rs) / len(rs), 4),
        })
    return rows
