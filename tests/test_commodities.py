"""Tests for the Commodities Intelligence engine (run via discover)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from intel import commodities as cm  # noqa: E402


def horizon(trend="BULLISH", conf="HIGH", rsi=60, **iv):
    base = {"price": 110, "ema_fast": 105, "ema_slow": 100, "ema_fast_period": 20,
            "ema_slow_period": 50, "adx": 30, "plus_di": 25, "minus_di": 10,
            "rsi": rsi, "macd_hist": 1.5, "support": 98, "resistance": 120,
            "volume_reliable": False}
    base.update(iv)
    return {"trend": trend, "volatility": "NORMAL", "reversal": "NONE", "confidence": conf,
            "data_status": "AVAILABLE_VALIDATED", "last_candle": "2026-11-27",
            "interval": "1d", "indicators": base}


def regime(h=None):
    h = h or horizon()
    return {"data_status": "AVAILABLE_VALIDATED",
            "horizons": {"short_term": h, "swing": h, "long_term": h}}


class Recommendation(unittest.TestCase):
    def test_uptrend_not_overbought_is_buy(self):
        self.assertEqual(cm.recommendation_from("BULLISH", "HIGH", 60)[0], "BUY")

    def test_uptrend_overbought_is_hold(self):
        self.assertEqual(cm.recommendation_from("BULLISH", "HIGH", 75)[0], "HOLD")

    def test_downtrend_is_sell(self):
        self.assertEqual(cm.recommendation_from("BEARISH", "MODERATE", 45)[0], "SELL")

    def test_downtrend_oversold_is_wait(self):
        self.assertEqual(cm.recommendation_from("BEARISH", "LOW", 25)[0], "WAIT")

    def test_neutral_is_wait(self):
        self.assertEqual(cm.recommendation_from("NEUTRAL", "LOW", 50)[0], "WAIT")

    def test_insufficient_passes_through(self):
        self.assertEqual(cm.recommendation_from("INSUFFICIENT EVIDENCE", "INSUFFICIENT", None)[0],
                         "INSUFFICIENT EVIDENCE")


class MacroFactors(unittest.TestCase):
    def test_gold_gets_dollar_headwind_when_dxy_bullish(self):
        item = next(c for c in cm.CATALOG if c["symbol"] == "GC=F")
        f = cm.macro_factors(item, "BULLISH", None, None)
        dxy = [x for x in f if "dollar" in x["factor"].lower()]
        self.assertTrue(dxy and dxy[0]["stance"] == "headwind")

    def test_crude_has_supply_demand_context_not_signal(self):
        item = next(c for c in cm.CATALOG if c["symbol"] == "CL=F")
        f = cm.macro_factors(item, "BULLISH", None, None)
        self.assertTrue(any("Supply" in x["factor"] and x["stance"] == "context" for x in f))

    def test_no_stock_fundamentals_applied(self):
        # macro factors never contain ROE/ROCE/P-E style stock metrics
        item = next(c for c in cm.CATALOG if c["symbol"] == "SI=F")
        blob = str(cm.macro_factors(item, "BEARISH", "NEUTRAL", "BULLISH")).lower()
        for t in ("roe", "roce", "p/e", "promoter", "debt/equity"):
            self.assertNotIn(t, blob)


class ETFContext(unittest.TestCase):
    def test_etf_context_liquidity_and_tracking_note(self):
        item = next(c for c in cm.CATALOG if c["symbol"] == "GOLDBEES.NS")
        bars = [{"volume": 500000} for _ in range(25)]
        ctx = cm.etf_context(item, bars)
        self.assertEqual(ctx["tracks"], "Gold")
        self.assertEqual(ctx["liquidity"], "good")
        self.assertIsNone(ctx["tracking_error"])
        self.assertIn("OWN price", ctx["note"])

    def test_non_etf_has_no_etf_context(self):
        item = next(c for c in cm.CATALOG if c["symbol"] == "GC=F")
        self.assertIsNone(cm.etf_context(item, []))


class BuildRecord(unittest.TestCase):
    def test_build_covers_three_horizons_and_no_fundamentals(self):
        item = next(c for c in cm.CATALOG if c["symbol"] == "SILVERBEES.NS")
        rec = cm.build_commodity(item, regime(), [{"volume": 200000}] * 25,
                                 "BULLISH", "NEUTRAL", "BULLISH", "2026-11-28T00:00:00+00:00")
        self.assertEqual(set(rec["horizons"]), set(cm.HORIZONS))
        self.assertNotIn("fundamental_context", rec["horizons"]["long_term"])
        self.assertIsNotNone(rec["etf_context"])
        self.assertEqual(rec["horizons"]["swing"]["recommendation"], "BUY")

    def test_unsupported_regime_marks_insufficient(self):
        item = next(c for c in cm.CATALOG if c["symbol"] == "GC=F")
        rec = cm.build_commodity(item, {"unsupported": True, "horizons": {}}, None,
                                 None, None, None, "2026-11-28T00:00:00+00:00")
        self.assertTrue(rec["unsupported"])
        self.assertEqual(rec["horizons"]["swing"]["recommendation"], "INSUFFICIENT EVIDENCE")


if __name__ == "__main__":
    unittest.main()
