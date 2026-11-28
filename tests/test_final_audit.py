"""Tests for the Phase 7 final audit rules and the orchestrator failure guard."""
import os
import sys
import tempfile
import unittest
import json
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from intel import final_audit as fa  # noqa: E402

OK_STOCK = {"data_status": "AVAILABLE_VALIDATED"}
DONE = {"optimization_status": "COMPLETED", "walk_forward": {"metrics": {"trades": 20}}}
FUND_OK = {"category": "GOOD", "sector_model": "pharma", "freshness": "FRESH"}


def rec(label="HOLD"):
    return {"scan_ok": True, "styles": {s: {"recommendation": label, "reasons": []} for s in fa.STYLES}}


class AuditRules(unittest.TestCase):
    def test_passed_when_validated_completed_and_fundamentals_present(self):
        r = fa.audit_stock("A.NS", "a", OK_STOCK, dict(DONE), rec(), None, FUND_OK)
        self.assertEqual(r["audit_result"], "PASSED")

    def test_missing_fundamentals_warns_but_keeps_technical_audit(self):
        r = fa.audit_stock("A.NS", "a", OK_STOCK, dict(DONE), rec(), None, None)
        self.assertEqual(r["audit_result"], "PASSED_WITH_WARNINGS")
        self.assertTrue(any("fundamentals" in w for w in r["warnings"]))
        self.assertEqual(r["strategy"]["oos_trades"], 20)  # technical result still present

    def test_unsupported_data_fails_validation(self):
        r = fa.audit_stock("X.NS", "x", {"data_status": "UNSUPPORTED"}, None, rec(), None, None)
        self.assertEqual(r["audit_result"], "FAILED_VALIDATION")

    def test_no_completed_strategy_is_insufficient_evidence(self):
        r = fa.audit_stock("A.NS", "a", OK_STOCK, {"optimization_status": "INSUFFICIENT_EVIDENCE"},
                           rec(), None, FUND_OK)
        self.assertEqual(r["audit_result"], "INSUFFICIENT_EVIDENCE")
        self.assertTrue(any("validated strategy" in m for m in r["missing_evidence"]))

    def test_buy_without_completed_strategy_is_contradiction(self):
        r = fa.audit_stock("A.NS", "a", OK_STOCK, {"optimization_status": "INSUFFICIENT_EVIDENCE"},
                           rec("BUY"), None, FUND_OK)
        self.assertTrue(r["contradictions"])
        self.assertEqual(r["audit_result"], "INSUFFICIENT_EVIDENCE")

    def test_only_buy_and_strong_buy_are_trade_candidates(self):
        r = fa.audit_stock("A.NS", "a", OK_STOCK, dict(DONE), rec("HOLD"), None, FUND_OK)
        self.assertFalse(any(s["trade_candidate"] for s in r["recommendations"].values()))
        r2 = fa.audit_stock("A.NS", "a", OK_STOCK, dict(DONE), rec("STRONG BUY"), None, FUND_OK)
        self.assertTrue(all(s["trade_candidate"] for s in r2["recommendations"].values()))

    def test_summary_separates_trades_from_states(self):
        recs = [fa.audit_stock("A.NS", "a", OK_STOCK, dict(DONE), rec("HOLD"), None, FUND_OK)]
        s = fa.summarise(recs)
        self.assertEqual(s["trade_candidates"], 0)
        self.assertEqual(s["state_counts_not_trades"]["HOLD"], 3)


class OrchestratorFailureGuard(unittest.TestCase):
    """Uses a temp store and fake jobs; never touches the real data directory."""

    def _run(self, fail, mode):
        from intel import orchestrate as o
        from intel import store as st
        tmp = tempfile.mkdtemp()
        real_store, real_run = o.JsonFileStore, o.run_job
        o.JsonFileStore = lambda root=None: st.JsonFileStore(tmp)
        calls = []

        def fake(job):
            calls.append(job)
            ok = job not in fail
            return {"job": job, "status": "SUCCESS" if ok else "FAILED", "started_at": "t",
                    "finished_at": "t", "duration_s": 1.0, "error": None if ok else "exit 1",
                    "output_tail": ""}
        o.run_job = fake
        old = sys.argv
        sys.argv = ["x", "--mode", mode]
        try:
            rc = o.main()
        finally:
            sys.argv = old
            o.JsonFileStore, o.run_job = real_store, real_run
        with open(os.path.join(tmp, "health.json"), encoding="utf-8") as f:
            health = json.load(f)
        shutil.rmtree(tmp, ignore_errors=True)
        return rc, calls, health

    def test_regime_failure_skips_recommend_and_fails_run(self):
        rc, calls, h = self._run({"regime"}, "daily")
        self.assertNotIn("recommend", calls)
        self.assertIn("news", calls)
        self.assertEqual(rc, 1)
        self.assertEqual(h["jobs"]["recommend"]["last_status"], "SKIPPED")
        self.assertEqual(h["overall"], "DEGRADED")

    def test_all_success_daily_is_ok(self):
        rc, calls, h = self._run(set(), "daily")
        self.assertEqual(calls, ["regime", "recommend", "news", "outcomes", "outlook", "commodities"])
        self.assertEqual(rc, 0)
        self.assertEqual(h["overall"], "OK")


if __name__ == "__main__":
    unittest.main()
