"""Tests for manual fundamentals import + merge (run: python -m unittest discover -s tests -v)."""
import datetime as dt
import hashlib
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from intel import import_manual_fundamentals as imp  # noqa: E402
from intel import fundamentals as fd  # noqa: E402

TODAY = dt.date(2026, 11, 28)
UNIVERSE = {"NEW1.NS", "NEW2.NS", "OLD.NS", "BLANK.NS"}
PRIMARY = {"OLD.NS"}
GOOD = {"symbol": "NEW1.NS", "name": "New One", "sector_model": "auto", "roe": "18", "roce": "20",
        "rev_cagr": "12", "profit_cagr": "11", "de": "0.3", "fcf_positive": "true", "pe": "22",
        "pb": "3.5", "promoter": "55", "source_name": "Company annual report", "source_url": "",
        "period": "FY2026", "retrieved_on": "2026-11-20"}


def row(**kw):
    r = dict(GOOD)
    r.update(kw)
    return r


class ImportRules(unittest.TestCase):
    def test_good_row_accepted_with_provenance(self):
        comp, rej, nf = imp.import_rows([row()], UNIVERSE, PRIMARY)
        self.assertIn("NEW1.NS", comp)
        self.assertEqual(comp["NEW1.NS"]["_source"]["period"], "FY2026")
        self.assertEqual(comp["NEW1.NS"]["roe"], 18)
        self.assertEqual(rej, [])

    def test_primary_file_symbol_never_overridden(self):
        comp, rej, _ = imp.import_rows([row(symbol="OLD.NS")], UNIVERSE, PRIMARY)
        self.assertNotIn("OLD.NS", comp)
        self.assertIn("already in fundamentals.json", rej[0]["reason"])

    def test_symbol_outside_universe_rejected(self):
        comp, rej, _ = imp.import_rows([row(symbol="FAKE.NS")], UNIVERSE, PRIMARY)
        self.assertEqual(comp, {})
        self.assertEqual(rej[0]["reason"], "not in locked universe")

    def test_missing_sector_rejected(self):
        comp, rej, _ = imp.import_rows([row(sector_model="")], UNIVERSE, PRIMARY)
        self.assertNotIn("NEW1.NS", comp)
        self.assertIn("sector_model", rej[0]["reason"])

    def test_missing_source_or_period_or_date_rejected(self):
        for kw in ({"source_name": "", "source_url": ""}, {"period": ""}, {"retrieved_on": "28/11/2026"}):
            comp, rej, _ = imp.import_rows([row(**kw)], UNIVERSE, PRIMARY)
            self.assertEqual(comp, {}, kw)
            self.assertEqual(len(rej), 1, kw)

    def test_out_of_range_cell_rejected_row_kept(self):
        comp, rej, _ = imp.import_rows([row(roe="5000")], UNIVERSE, PRIMARY)
        self.assertIn("NEW1.NS", comp)
        self.assertNotIn("roe", comp["NEW1.NS"])
        self.assertEqual(comp["NEW1.NS"]["_cell_errors"][0]["metric"], "roe")

    def test_non_numeric_cell_is_error_not_zero(self):
        comp, _, _ = imp.import_rows([row(de="n/a")], UNIVERSE, PRIMARY)
        self.assertNotIn("de", comp["NEW1.NS"])

    def test_blank_row_is_not_filled_not_rejected(self):
        blank = {"symbol": "BLANK.NS", "name": "x"}
        comp, rej, nf = imp.import_rows([blank], UNIVERSE, PRIMARY)
        self.assertEqual(comp, {})
        self.assertEqual(rej, [])
        self.assertEqual(nf, ["BLANK.NS"])


class MergeIntoCoverage(unittest.TestCase):
    def test_manual_row_scored_with_its_own_source_and_period(self):
        comp, _, _ = imp.import_rows([row()], UNIVERSE, PRIMARY)
        extra = {"companies": comp}
        recs = fd.build([("NEW1.NS", "New One")], {"as_of": "2026-11-19", "companies": {}}, TODAY, extra_doc=extra)
        r = recs["NEW1.NS"]
        self.assertEqual(r["as_of"], "2026-11-20")
        self.assertEqual(r["period"], "FY2026")
        self.assertIn("manual row", r["metrics"]["roe"]["source"])
        self.assertEqual(r["sector_model"], "auto")
        self.assertNotEqual(r["category"], "INSUFFICIENT_DATA")

    def test_primary_wins_over_manual(self):
        comp, _, _ = imp.import_rows([row(symbol="NEW1.NS")], UNIVERSE, set())
        primary = {"as_of": "2026-11-19", "companies": {"NEW1.NS": {"type": "bank", "roe": 10}}}
        recs = fd.build([("NEW1.NS", "x")], primary, TODAY, extra_doc={"companies": comp})
        self.assertEqual(recs["NEW1.NS"]["sector_model"], "bank")

    def test_importer_never_writes_fundamentals_json(self):
        path = os.path.join(ROOT, "fundamentals.json")
        with open(path, "rb") as f:
            before = hashlib.sha256(f.read()).hexdigest()
        comp, _, _ = imp.import_rows([row()], UNIVERSE, PRIMARY)  # pure function, no I/O
        with open(path, "rb") as f:
            after = hashlib.sha256(f.read()).hexdigest()
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
