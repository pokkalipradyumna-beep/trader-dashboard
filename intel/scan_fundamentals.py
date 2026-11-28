"""Phase 7 batch: fundamental coverage + analysis for the 201-stock universe.

Reads fundamentals.json (read-only) and writes data/fundamentals_coverage.json.
No network access. Run from the repo root:
    python -m intel.scan_fundamentals
"""
import json
import os
import sys
import datetime as _dt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel import fundamentals as fd  # noqa: E402
from intel.scan_universe import _load_universe  # noqa: E402
from intel.store import JsonFileStore  # noqa: E402
from intel.datasource import _now_iso  # noqa: E402


def main():
    universe = _load_universe()
    with open(os.path.join(ROOT, "fundamentals.json"), encoding="utf-8") as f:
        doc = json.load(f)
    extra = None
    extra_path = os.path.join(ROOT, "data", "manual", "fundamentals_extra.json")
    if os.path.exists(extra_path):
        with open(extra_path, encoding="utf-8") as f:
            extra = json.load(f)
    records = fd.build(universe, doc, extra_doc=extra)
    summary = fd.summarise(records, len(universe))
    out = {"generated_at": _now_iso(), "methodology_version": fd.METHODOLOGY_VERSION,
           "source": doc.get("source"), "source_as_of": doc.get("as_of"),
           "manual_extension": (extra or {}).get("source_file"),
           "freshness_days_threshold": fd.FRESH_DAYS, "min_evaluated_gates": fd.MIN_EVALUATED,
           "sector_notes": fd.SECTOR_NOTE,
           "limitations": [
               "Single manual source (screener.in snapshot); not live and not independently verified.",
               "Reporting period of each value is not recorded in the source; only the snapshot date (as_of).",
               "No ROA, EPS growth, interest coverage, operating cash flow, EV/EBITDA, book value, pledge or order book in the source.",
               "Sector is classified only for stocks in the manual file; the rest are UNCLASSIFIED.",
               "Thresholds are the existing quality.py gates, not sector-calibrated.",
           ],
           "summary": summary, "stocks": records}
    store = JsonFileStore()
    store.put_fundamentals_coverage(out)
    cats = summary["categories"]
    print("Fundamental coverage: %d stocks, %d with a source record, categories=%s"
          % (summary["stocks_audited"], summary["with_fundamentals_on_file"], cats))


if __name__ == "__main__":
    main()
