"""Unit tests for intel.outcomes (run: python -m unittest discover -s tests -v)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from intel import outcomes as oc  # noqa: E402


def bars_from(start_day, n, base=100.0, step=1.0):
    """n consecutive business-day bars starting at ISO start_day (no holidays)."""
    import datetime as dt
    d0 = dt.date.fromisoformat(start_day)
    out, d, i = [], d0, 0
    while len(out) < n:
        if d.weekday() < 5:
            px = base + step * i
            out.append({"date": d.isoformat(), "open": px, "high": px + 1,
                        "low": px - 1, "close": px, "adjclose": px})
            i += 1
        d += dt.timedelta(days=1)
    return out


def ev(signal="2026-11-27", label="HOLD", stop=None, target=None, style="swing"):
    return {"id": "r1", "symbol": "X.NS", "style": style, "new_recommendation": label,
            "stop": stop, "target": target, "provenance": {"daily_last_date": signal}}


class OutcomeRules(unittest.TestCase):
    def test_entry_is_first_session_after_signal(self):
        bars = bars_from("2026-11-23", 20)  # Mon 23 Nov ..
        recs = oc.evaluate_event(ev("2026-11-27"), bars, "2026-12-28")
        r5 = [r for r in recs if r["horizon"] == 5][0]
        self.assertEqual(r5["entry_date"], "2026-11-30")  # first session after Fri 27 Nov

    def test_return_uses_adjusted_close_entry_to_exit(self):
        bars = bars_from("2026-11-23", 30)
        r = [x for x in oc.evaluate_event(ev("2026-11-27"), bars, "2026-12-28") if x["horizon"] == 5][0]
        entry = r["entry_adjclose"]
        exit_ = r["exit_adjclose"]
        self.assertAlmostEqual(r["return_pct"], round((exit_ / entry - 1) * 100, 4), places=4)
        self.assertEqual(r["exit_date"], "2026-12-07")  # 5 sessions after 30 Nov

    def test_pending_horizon_not_reported(self):
        # entry = 30 Nov (index 5); 12 bars -> 5-session exit exists, 10-session does not
        bars = bars_from("2026-11-23", 12)
        recs = oc.evaluate_event(ev("2026-11-27"), bars, "2026-12-28")
        horizons = {r["horizon"] for r in recs}
        self.assertIn(5, horizons)
        self.assertNotIn(10, horizons)
        self.assertNotIn(20, horizons)
        self.assertNotIn(60, horizons)

    def test_today_session_never_used(self):
        bars = bars_from("2026-11-23", 30)
        run = "2026-12-07"  # bars dated on/after run date must be excluded
        recs = oc.evaluate_event(ev("2026-11-27"), bars, run)
        for r in recs:
            self.assertLess(r["exit_date"], run)

    def test_no_look_ahead_future_bars_do_not_change_earlier_horizon(self):
        base_bars = bars_from("2026-11-23", 30)
        a = [x for x in oc.evaluate_event(ev("2026-11-27"), base_bars, "2026-12-28") if x["horizon"] == 5][0]
        mutated = [dict(b) for b in base_bars]
        for b in mutated[12:]:  # change prices AFTER the 5-session exit window
            b["adjclose"] = b["adjclose"] * 3
        b2 = [x for x in oc.evaluate_event(ev("2026-11-27"), mutated, "2026-12-28") if x["horizon"] == 5][0]
        self.assertEqual(a["return_pct"], b2["return_pct"])

    def test_missing_adjclose_is_flagged_not_filled(self):
        bars = bars_from("2026-11-23", 30)
        recs = oc.evaluate_event(ev("2026-11-27"), bars, "2026-12-28", has_adjclose=False)
        self.assertTrue(all(r["status"] == "NO_ADJCLOSE" for r in recs))

    def test_stop_hit_uses_unadjusted_low(self):
        bars = bars_from("2026-11-23", 30, base=100.0, step=0.0)  # flat 100, low 99
        bars[8]["low"] = 90.0  # a dip inside the 5-session window
        r = [x for x in oc.evaluate_event(ev("2026-11-27", label="BUY", stop=95.0),
                                          bars, "2026-12-28") if x["horizon"] == 5][0]
        self.assertTrue(r["stop_hit"])
        self.assertFalse(r["target_hit"])

    def test_no_stop_or_target_reports_null(self):
        bars = bars_from("2026-11-23", 30)
        r = [x for x in oc.evaluate_event(ev("2026-11-27"), bars, "2026-12-28") if x["horizon"] == 5][0]
        self.assertIsNone(r["stop_hit"])
        self.assertIsNone(r["target_hit"])

    def test_event_without_signal_date_is_skipped(self):
        e = ev("2026-11-27")
        e["provenance"] = {}
        self.assertEqual(oc.evaluate_event(e, bars_from("2026-11-23", 30), "2026-12-28"), [])


class Summary(unittest.TestCase):
    def _rec(self, label, ret, h=5):
        return {"status": "EVALUATED", "label": label, "style": "swing", "horizon": h,
                "return_pct": ret, "mfe_pct": ret + 1, "mae_pct": min(ret, 0) - 1}

    def test_small_sample_flagged(self):
        out = oc.summarise([self._rec("BUY", 1.0)])
        self.assertEqual(out["trade_stats"][0]["n_trades"], 1)
        self.assertFalse(out["trade_stats"][0]["sufficient_sample"])

    def test_pending_and_no_adj_excluded(self):
        recs = [{"status": "NO_ADJCLOSE", "label": "BUY", "style": "swing", "horizon": 5},
                {"status": "PENDING", "label": "HOLD", "style": "swing", "horizon": 5}]
        out = oc.summarise(recs)
        self.assertEqual(out["trade_stats"], [])
        self.assertEqual(out["observations"], [])

    def test_buy_gets_trade_stats_with_win_rate_and_profit_factor(self):
        out = oc.summarise([self._rec("BUY", 4.0), self._rec("BUY", -2.0)])
        row = out["trade_stats"][0]
        self.assertEqual(row["win_rate_pct"], 50.0)
        self.assertEqual(row["profit_factor"], 2.0)
        self.assertEqual(out["observations"], [])

    def test_hold_wait_sell_insufficient_never_get_win_rate_or_pf(self):
        recs = [self._rec(l, r) for l in ("HOLD", "WAIT", "SELL", "INSUFFICIENT_EVIDENCE")
                for r in (3.0, -3.0)]
        out = oc.summarise(recs)
        self.assertEqual(out["trade_stats"], [])
        self.assertEqual(len(out["observations"]), 4)
        for row in out["observations"]:
            self.assertNotIn("win_rate_pct", row)
            self.assertNotIn("profit_factor", row)
            self.assertIn("NOT a simulated trade", row["note"])


if __name__ == "__main__":
    unittest.main()
