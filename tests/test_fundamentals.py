"""Unit tests for intel.fundamentals (run: python -m unittest discover -s tests -v)."""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from intel import fundamentals as fd  # noqa: E402

TODAY = dt.date(2026, 11, 28)
GOOD_NONBANK = {"type": "pharma", "roe": 20, "roce": 22, "rev_cagr": 12, "profit_cagr": 14,
                "de": 0.1, "fcf_positive": True, "pe": 25, "pb": 4, "promoter": 60}


class FundamentalRules(unittest.TestCase):
    def test_missing_value_is_not_zero_and_not_scored(self):
        rec = dict(GOOD_NONBANK); del rec["roe"]
        r = fd.analyse_stock("X.NS", rec, "2026-11-19", TODAY)
        self.assertIsNone(r["metrics"]["roe"]["value"])
        self.assertEqual(r["metrics"]["roe"]["validation"], "NOT_AVAILABLE")
        self.assertNotIn("ROE (%)", " ".join(r["positive_factors"] + r["negative_factors"]))
        self.assertEqual(r["evaluated_gates"], 8)  # 9 applicable, ROE missing

    def test_unclassified_is_insufficient_and_unscored(self):
        r = fd.analyse_stock("Y.NS", None, None, TODAY)
        self.assertEqual(r["category"], "INSUFFICIENT_DATA")
        self.assertEqual(r["evaluated_gates"], 0)
        self.assertEqual(r["sector_model"], "UNCLASSIFIED")

    def test_bank_does_not_get_nonbank_gates(self):
        bank = {"type": "bank", "roe": 17, "gnpa": 2, "nnpa": 0.5, "nim": 3.9,
                "deposit_growth": 14, "pb": 2.5, "de": 9.0, "roce": 1.0}
        r = fd.analyse_stock("B.NS", bank, "2026-11-19", TODAY)
        self.assertFalse(r["metrics"]["roce"]["applies"])
        self.assertFalse(r["metrics"]["de"]["applies"])
        self.assertTrue(r["metrics"]["gnpa"]["applies"])
        self.assertEqual(r["passed_gates"], r["evaluated_gates"])  # all bank gates pass

    def test_out_of_range_value_not_scored(self):
        rec = dict(GOOD_NONBANK, roe=5000)
        r = fd.analyse_stock("Z.NS", rec, "2026-11-19", TODAY)
        self.assertEqual(r["metrics"]["roe"]["validation"], "OUT_OF_RANGE")
        self.assertEqual(r["evaluated_gates"], 8)

    def test_stale_snapshot_cannot_be_excellent(self):
        old = fd.analyse_stock("S.NS", dict(GOOD_NONBANK), "2026-01-01", TODAY)
        self.assertEqual(old["freshness"], "STALE")
        self.assertNotEqual(old["category"], "EXCELLENT")

    def test_fresh_all_pass_is_excellent(self):
        r = fd.analyse_stock("G.NS", dict(GOOD_NONBANK), "2026-11-19", TODAY)
        self.assertEqual(r["freshness"], "FRESH")
        self.assertEqual(r["category"], "EXCELLENT")

    def test_too_few_evaluable_gates_is_insufficient(self):
        rec = {"type": "auto", "roe": 20, "promoter": 60}  # 2 gates only
        r = fd.analyse_stock("F.NS", rec, "2026-11-19", TODAY)
        self.assertEqual(r["category"], "INSUFFICIENT_DATA")

    def test_non_boolean_fcf_is_invalid(self):
        rec = dict(GOOD_NONBANK, fcf_positive="yes")
        r = fd.analyse_stock("V.NS", rec, "2026-11-19", TODAY)
        self.assertEqual(r["metrics"]["fcf_positive"]["validation"], "INVALID")

    def test_summary_counts_add_up(self):
        universe = [("A.NS", "a"), ("B.NS", "b")]
        recs = fd.build(universe, {"as_of": "2026-11-19", "companies": {"A.NS": dict(GOOD_NONBANK)}}, TODAY)
        s = fd.summarise(recs, 2)
        self.assertEqual(s["stocks_audited"], 2)
        self.assertEqual(sum(s["categories"].values()), 2)
        self.assertEqual(s["with_fundamentals_on_file"], 1)


if __name__ == "__main__":
    unittest.main()
