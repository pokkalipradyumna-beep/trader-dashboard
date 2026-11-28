"""Tests for the Phase 7 display-layer materiality review (run via discover)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from intel import news_rules as nr  # noqa: E402


class MaterialityReview(unittest.TestCase):
    def test_media_reported_results_capped_at_medium(self):
        d, note = nr.review_materiality("RESULTS", "HIGH", nr.REPORTED, "Company posts record Q2 profit")
        self.assertEqual(d, "MEDIUM")
        self.assertIsNotNone(note)

    def test_preview_headline_capped_at_medium(self):
        d, _ = nr.review_materiality("RESULTS", "HIGH", nr.REPORTED,
                                     "TCS shares jump 3% ahead of Q2 results; what to expect?")
        self.assertEqual(d, "MEDIUM")

    def test_non_results_categories_untouched(self):
        d, note = nr.review_materiality("REGULATORY", "HIGH", nr.REPORTED, "SEBI penalises firm")
        self.assertEqual((d, note), ("HIGH", None))

    def test_raw_materiality_never_changed_in_place(self):
        stocks = {"X.NS": {"events": [{"category": "RESULTS", "materiality": "HIGH",
                                       "source_class": nr.REPORTED, "headline": "Q3 results"}]}}
        nr.apply_display_review(stocks)
        e = stocks["X.NS"]["events"][0]
        self.assertEqual(e["materiality"], "HIGH")
        self.assertEqual(e["materiality_display"], "MEDIUM")


if __name__ == "__main__":
    unittest.main()
