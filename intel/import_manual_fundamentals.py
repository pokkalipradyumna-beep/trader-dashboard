"""Phase 7: import MANUAL fundamental rows for stocks not covered by fundamentals.json.

Input : data/manual/fundamentals_template.csv (or --csv PATH), filled by hand.
Output: data/manual/fundamentals_extra.json (rewritten each run; derived).

Writes NEVER touch fundamentals.json: quality.py and holdings.py read that file,
and changing it would alter existing holdings / weekly-engine output.

A row is accepted only if it has ALL of:
  * a symbol in the locked universe that is NOT already in fundamentals.json,
  * a valid sector_model (one of fundamentals.SECTOR_MODELS),
  * source_name or source_url, period, and retrieved_on (YYYY-MM-DD).
Blank metric cells stay missing (never zero). A non-numeric or out-of-range cell
is rejected individually and reported, and the rest of the row is kept.
Rows with no metric values are reported as NOT_FILLED, not as failures.

Run:  python -m intel.import_manual_fundamentals [--csv PATH]
"""
import csv
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel import fundamentals as fd  # noqa: E402
from intel.datasource import _now_iso  # noqa: E402
from intel.scan_universe import _load_universe  # noqa: E402

DEFAULT_CSV = os.path.join(ROOT, "data", "manual", "fundamentals_template.csv")
OUT = os.path.join(ROOT, "data", "manual", "fundamentals_extra.json")
METRIC_KEYS = [k for k in fd.METRICS]
META = ["name", "sector_model", "source_name", "source_url", "period", "retrieved_on"]


def _parse_cell(key, raw):
    """Return (value, error). Blank -> (None, None)."""
    raw = (raw or "").strip()
    if raw == "":
        return None, None
    if key == "fcf_positive":
        low = raw.lower()
        if low in ("true", "yes", "1"):
            return True, None
        if low in ("false", "no", "0"):
            return False, None
        return None, "not a boolean (use true/false)"
    try:
        v = float(raw)
    except ValueError:
        return None, "not numeric"
    if v.is_integer() and key not in ("pe", "pb", "de"):
        v = int(v)
    status, note = fd._validate(key, v)
    if status != "PLAUSIBLE":
        return None, "%s (%s)" % (status, note)
    return v, None


def _valid_date(s):
    try:
        dt.date.fromisoformat(s)
        return True
    except (TypeError, ValueError):
        return False


def import_rows(rows, universe_syms, primary_syms):
    """rows: list of dict (csv rows). Returns (companies, rejected, not_filled)."""
    companies, rejected, not_filled = {}, [], []
    for line_no, row in enumerate(rows, start=2):
        sym = (row.get("symbol") or "").strip().upper()
        if not sym:
            continue
        if sym not in universe_syms:
            rejected.append({"line": line_no, "symbol": sym, "reason": "not in locked universe"})
            continue
        if sym in primary_syms:
            rejected.append({"line": line_no, "symbol": sym,
                             "reason": "already in fundamentals.json (not overridden here)"})
            continue
        values, cell_errors = {}, []
        for key in METRIC_KEYS:
            v, err = _parse_cell(key, row.get(key))
            if err:
                cell_errors.append({"metric": key, "reason": err})
            elif v is not None:
                values[key] = v
        if not values and not cell_errors:
            not_filled.append(sym)
            continue
        problems = []
        sector = (row.get("sector_model") or "").strip()
        if sector not in fd.SECTOR_MODELS:
            problems.append("sector_model must be one of %s" % ", ".join(sorted(fd.SECTOR_MODELS)))
        if not (row.get("source_name") or "").strip() and not (row.get("source_url") or "").strip():
            problems.append("source_name or source_url required")
        if not (row.get("period") or "").strip():
            problems.append("period required")
        if not _valid_date((row.get("retrieved_on") or "").strip()):
            problems.append("retrieved_on must be YYYY-MM-DD")
        if problems:
            rejected.append({"line": line_no, "symbol": sym, "reason": "; ".join(problems),
                             "cell_errors": cell_errors})
            continue
        rec = {"name": (row.get("name") or "").strip(), "type": sector}
        rec.update(values)
        rec["_source"] = {"source_name": (row.get("source_name") or "").strip(),
                          "source_url": (row.get("source_url") or "").strip(),
                          "period": row["period"].strip(),
                          "retrieved_on": row["retrieved_on"].strip()}
        if cell_errors:
            rec["_cell_errors"] = cell_errors
        companies[sym] = rec
    return companies, rejected, not_filled


def main():
    args = sys.argv[1:]
    path = args[args.index("--csv") + 1] if "--csv" in args else DEFAULT_CSV
    with open(os.path.join(ROOT, "fundamentals.json"), encoding="utf-8") as f:
        primary = set((json.load(f).get("companies") or {}).keys())
    universe = {s for s, _ in _load_universe()}
    with open(path, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    companies, rejected, not_filled = import_rows(rows, universe, primary)
    out = {"generated_at": _now_iso(), "source_file": os.path.relpath(path, ROOT),
           "rows_read": len(rows), "accepted": len(companies),
           "not_filled": len(not_filled), "rejected": rejected, "companies": companies,
           "note": "Manual rows. Each value's source, period and retrieval date are per row. "
                   "Not independently verified."}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    os.replace(tmp, OUT)
    print("Manual import: rows=%d accepted=%d not_filled=%d rejected=%d"
          % (len(rows), len(companies), len(not_filled), len(rejected)))


if __name__ == "__main__":
    main()
