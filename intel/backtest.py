"""Phase 3: long-only event backtester + a PRE-REGISTERED set of indicator
configurations. Pure stdlib, reusable by the walk-forward optimiser (optimize.py).

Honesty / method guarantees:
  * Long-only (Indian cash-delivery context; matches the quality-first approach).
  * NO look-ahead: a signal at completed bar t uses only closes[0..t]; the trade
    enters at that bar's close and exits at a later bar's close. Entry/exit prices
    are therefore known-at-decision-time.
  * Costs are charged on BOTH sides (COST_PER_SIDE) so results are net, not gross.
  * The config set is FIXED and declared up front (pre-registration) to limit the
    data-mining/overfitting that an open-ended parameter sweep would invite. This
    does not eliminate selection bias — the walk-forward layer (optimize.py) is
    what makes the reported performance out-of-sample.
  * This module computes trades/metrics only; it makes NO claim that past
    performance predicts the future.

Independent of the weekly EMA 9/21/50 trading engine (engine.py).
"""
from __future__ import annotations

from intel import indicators as ind

COST_PER_SIDE = 0.001   # 0.10% per side (entry and exit) -> ~0.20% round trip

# ---- signal builders: each returns a list `pos` of 0/1 "in-market" flags per
#      bar, decided on completed bar t (no look-ahead). The backtester turns the
#      0->1 / 1->0 transitions into trades entered/exited at that bar's close. ----

def _cross_pos(fast, slow):
    pos = [0] * len(fast)
    state = 0
    for i in range(len(fast)):
        if fast[i] is None or slow[i] is None:
            pos[i] = state
            continue
        if fast[i] > slow[i]:
            state = 1
        elif fast[i] < slow[i]:
            state = 0
        pos[i] = state
    return pos


def sig_ema_cross(bars, closes, fast_p, slow_p):
    return _cross_pos(ind.ema(closes, fast_p), ind.ema(closes, slow_p))


def sig_rsi_momentum(bars, closes, period=14, up=50, dn=50):
    r = ind.rsi(closes, period)
    pos = [0] * len(closes)
    state = 0
    for i in range(len(closes)):
        if r[i] is not None:
            if r[i] >= up:
                state = 1
            elif r[i] < dn:
                state = 0
        pos[i] = state
    return pos


def sig_macd(bars, closes):
    _, _, hist = ind.macd(closes)
    pos = [0] * len(closes)
    state = 0
    for i in range(len(closes)):
        if hist[i] is not None:
            state = 1 if hist[i] > 0 else 0
        pos[i] = state
    return pos


def sig_bollinger_breakout(bars, closes, period=20, mult=2.0):
    mid, up, lo, pb, bw = ind.bollinger(closes, period, mult)
    pos = [0] * len(closes)
    state = 0
    for i in range(len(closes)):
        if up[i] is not None and mid[i] is not None:
            if closes[i] > up[i]:
                state = 1
            elif closes[i] < mid[i]:
                state = 0
        pos[i] = state
    return pos


def sig_donchian(bars, closes, entry=20, exit_=10):
    highs = [b.get("high") for b in bars]
    lows = [b.get("low") for b in bars]
    pos = [0] * len(closes)
    state = 0
    for i in range(len(closes)):
        if i >= entry:
            win_h = [highs[j] for j in range(i - entry, i) if highs[j] is not None]
            win_l = [lows[j] for j in range(i - exit_, i) if lows[j] is not None]
            if win_h and closes[i] is not None and closes[i] >= max(win_h):
                state = 1
            elif win_l and closes[i] is not None and closes[i] <= min(win_l):
                state = 0
        pos[i] = state
    return pos


# Pre-registered configurations (id -> builder + params). Keep SMALL and fixed.
CONFIGS = {
    "ema_9_21":    lambda b, c: sig_ema_cross(b, c, 9, 21),
    "ema_20_50":   lambda b, c: sig_ema_cross(b, c, 20, 50),
    "ema_50_200":  lambda b, c: sig_ema_cross(b, c, 50, 200),
    "rsi_mom_14":  lambda b, c: sig_rsi_momentum(b, c, 14, 55, 45),
    "macd_12_26_9": lambda b, c: sig_macd(b, c),
    "bb_breakout_20": lambda b, c: sig_bollinger_breakout(b, c, 20, 2.0),
    "donchian_20_10": lambda b, c: sig_donchian(b, c, 20, 10),
}
CONFIG_LABELS = {
    "ema_9_21": "EMA 9/21 crossover", "ema_20_50": "EMA 20/50 crossover",
    "ema_50_200": "EMA 50/200 crossover", "rsi_mom_14": "RSI(14) momentum 45/55",
    "macd_12_26_9": "MACD 12/26/9", "bb_breakout_20": "Bollinger(20,2) breakout",
    "donchian_20_10": "Donchian 20/10 breakout",
}
CONFIG_IDS = list(CONFIGS.keys())


def run_config(bars, config_id, lo=0, hi=None, regime_tag=None):
    """Backtest one config over bars[lo:hi]. Returns metrics + the trade list.
    `regime_tag(i)` (optional) returns a (trend, vol) label at entry index i for
    per-regime attribution. All trades are closed at hi-1 if still open (marked)."""
    closes = [b.get("close") for b in bars]
    pos = CONFIGS[config_id](bars, closes)
    hi = len(bars) if hi is None else hi
    trades = []
    in_pos = False
    entry_px = entry_i = None
    for i in range(lo, hi):
        c = closes[i]
        if c is None or c <= 0:
            continue
        if not in_pos and pos[i] == 1 and (i == 0 or pos[i - 1] == 0):
            in_pos = True
            entry_px, entry_i = c, i
        elif in_pos and pos[i] == 0 and pos[i - 1] == 1:
            trades.append(_close_trade(bars, entry_px, entry_i, c, i, regime_tag, False))
            in_pos = False
    if in_pos and entry_px:  # force-close at window end (flagged open)
        last = hi - 1
        lc = closes[last]
        if lc:
            trades.append(_close_trade(bars, entry_px, entry_i, lc, last, regime_tag, True))
    return metrics(trades), trades


def _close_trade(bars, entry_px, entry_i, exit_px, exit_i, regime_tag, forced):
    gross = exit_px / entry_px - 1.0
    net = (exit_px * (1 - COST_PER_SIDE)) / (entry_px * (1 + COST_PER_SIDE)) - 1.0
    t = {"entry_date": bars[entry_i].get("date"), "exit_date": bars[exit_i].get("date"),
         "entry": round(entry_px, 2), "exit": round(exit_px, 2),
         "ret_pct": round(net * 100, 3), "gross_pct": round(gross * 100, 3),
         "bars_held": exit_i - entry_i, "forced_exit": forced}
    if regime_tag:
        tr, vol = regime_tag(entry_i)
        t["entry_trend"], t["entry_vol"] = tr, vol
    return t


def metrics(trades):
    n = len(trades)
    if not n:
        return {"trades": 0, "win_rate": None, "avg_ret_pct": None, "expectancy_pct": None,
                "profit_factor": None, "total_ret_pct": None, "max_drawdown_pct": None,
                "avg_bars_held": None}
    rets = [t["ret_pct"] for t in trades]
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r <= 0]
    gross_win = sum(wins)
    gross_loss = -sum(losses)
    # compounded equity curve for total return + drawdown
    eq = 1.0
    peak = 1.0
    maxdd = 0.0
    for r in rets:
        eq *= (1 + r / 100.0)
        peak = max(peak, eq)
        maxdd = max(maxdd, (peak - eq) / peak)
    return {"trades": n,
            "win_rate": round(100.0 * len(wins) / n, 1),
            "avg_ret_pct": round(sum(rets) / n, 3),
            "expectancy_pct": round(sum(rets) / n, 3),
            "profit_factor": (round(gross_win / gross_loss, 2) if gross_loss > 0 else None),
            "total_ret_pct": round((eq - 1) * 100, 2),
            "max_drawdown_pct": round(maxdd * 100, 2),
            "avg_bars_held": round(sum(t["bars_held"] for t in trades) / n, 1)}
