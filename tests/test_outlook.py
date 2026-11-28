"""Tests for the Predictive Outlook Engine (run via discover)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from intel import outlook as ol  # noqa: E402


def horizon(trend="BULLISH", vol="NORMAL", rev="NONE", conf="HIGH", **iv):
    base = {"price": 110, "ema_fast": 105, "ema_slow": 100, "ema_fast_period": 9,
            "ema_slow_period": 21, "adx": 30, "plus_di": 25, "minus_di": 10,
            "rsi": 60, "macd_hist": 1.5, "support": 98, "resistance": 120,
            "volume_reliable": True, "obv_slope_pct": 10, "atr_pct": 2.0}
    base.update(iv)
    return {"trend": trend, "volatility": vol, "reversal": rev, "confidence": conf,
            "data_status": "AVAILABLE_VALIDATED", "last_candle": "2026-11-27",
            "interval": "1d", "indicators": base}


def regime(h=None):
    return {"data_status": "AVAILABLE_VALIDATED", "horizons": {"short_term": h or horizon(),
            "swing": h or horizon(), "long_term": h or horizon()}}


class Direction(unittest.TestCase):
    def test_aligned_bullish_is_bullish(self):
        o = ol.outlook_for_horizon("swing", regime(), {"optimization_status": "COMPLETED"}, {}, None)
        self.assertEqual(o["direction"], "BULLISH")
        self.assertTrue(o["supporting"])
        self.assertEqual(o["contradicting"], [])

    def test_aligned_bearish_is_bearish(self):
        h = horizon(trend="BEARISH", price=90, ema_fast=95, ema_slow=100, plus_di=10,
                    minus_di=25, rsi=40, macd_hist=-1.5, obv_slope_pct=-10)
        o = ol.outlook_for_horizon("swing", regime(h), {"optimization_status": "COMPLETED"}, {}, None)
        self.assertEqual(o["direction"], "BEARISH")

    def test_conflicting_is_neutral_or_moderate(self):
        h = horizon(trend="SIDEWAYS", price=100, ema_fast=100, ema_slow=100, adx=15,
                    rsi=50, macd_hist=0.0, obv_slope_pct=0)
        o = ol.outlook_for_horizon("swing", regime(h), {}, {}, None)
        self.assertIn(o["direction"], ("NEUTRAL", "MODERATELY BULLISH", "MODERATELY BEARISH"))

    def test_missing_horizon_is_insufficient(self):
        o = ol.outlook_for_horizon("swing", {"data_status": "UNSUPPORTED", "horizons": {}}, None, None, None)
        self.assertEqual(o["direction"], "INSUFFICIENT EVIDENCE")
        self.assertEqual(o["evidence_strength"], "INSUFFICIENT")


class EvidenceStrength(unittest.TestCase):
    def test_longterm_without_fundamentals_capped_low(self):
        o = ol.outlook_for_horizon("long_term", regime(), {"optimization_status": "COMPLETED"},
                                   {}, {"category": "INSUFFICIENT_DATA"})
        self.assertEqual(o["evidence_strength"], "LOW")
        self.assertTrue(any("INSUFFICIENT_DATA" in r for r in o["evidence_reasons"]))

    def test_longterm_with_strong_fundamentals_can_be_high(self):
        o = ol.outlook_for_horizon("long_term", regime(), {"optimization_status": "COMPLETED"},
                                   {}, {"category": "EXCELLENT", "freshness": "FRESH"})
        self.assertEqual(o["evidence_strength"], "HIGH")

    def test_swing_without_strategy_dampened(self):
        strong = ol.outlook_for_horizon("swing", regime(), {"optimization_status": "COMPLETED"}, {}, None)
        weak = ol.outlook_for_horizon("swing", regime(), {"optimization_status": "INSUFFICIENT_EVIDENCE"}, {}, None)
        order = {"INSUFFICIENT": 0, "LOW": 1, "MODERATE": 2, "HIGH": 3}
        self.assertGreaterEqual(order[strong["evidence_strength"]], order[weak["evidence_strength"]])

    def test_high_volatility_adds_risk_and_dampens(self):
        o = ol.outlook_for_horizon("swing", regime(horizon(vol="HIGH_VOLATILITY")),
                                   {"optimization_status": "COMPLETED"}, {}, None)
        self.assertTrue(any(i["stance"] == "risk" for i in o["risks"]))


class OutputContract(unittest.TestCase):
    def test_no_probability_or_target_fields(self):
        o = ol.outlook_for_horizon("swing", regime(), {"optimization_status": "COMPLETED"}, {}, None)
        blob = str(o).lower()
        self.assertNotIn("probability", blob)
        self.assertNotIn("% chance", blob)
        self.assertNotIn("target price", blob)

    def test_invalidation_only_from_existing_levels(self):
        h = horizon(support=None, resistance=None, ema_slow=None)
        o = ol.outlook_for_horizon("swing", regime(h), {"optimization_status": "COMPLETED"}, {}, None)
        self.assertEqual(o["invalidation"], [])  # nothing invented

    def test_build_stock_covers_three_horizons(self):
        r = ol.build_stock("X.NS", "x", regime(), {"optimization_status": "COMPLETED"},
                           {}, {"category": "GOOD", "freshness": "FRESH"}, {"events": []}, "2026-11-28T00:00:00+00:00")
        self.assertEqual(set(r["horizons"]), set(ol.HORIZONS))
        self.assertIn("disclaimer", r)


if __name__ == "__main__":
    unittest.main()
