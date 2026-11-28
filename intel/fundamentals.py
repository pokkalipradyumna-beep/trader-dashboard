"""Phase 7 — fundamental data coverage and analysis (pure logic, no network).

Source of record: the existing curated file fundamentals.json (screener.in,
manual, dated `as_of`). It is READ ONLY here. quality.py is NOT used and NOT
modified: its gates treat a missing value as a failure, which this module
deliberately does not do.

Principles (from the Phase 7 brief):
  * A missing value is NOT_AVAILABLE. It is never filled with zero.
  * Every value carries source, as_of (retrieval/reporting date), age in days,
    freshness and a validation status.
  * A metric is only scored where it is applicable to the sector model.
  * A stock with too few evaluated metrics is INSUFFICIENT_DATA, never a
    strong score by default.
  * Sector UNCLASSIFIED stocks get no sector rules and are INSUFFICIENT_DATA.
"""
import datetime as _dt

METHODOLOGY_VERSION = "fundamentals-v1.0"
FRESH_DAYS = 100          # a quarterly-results snapshot older than this is STALE
MIN_EVALUATED = 5         # below this, the stock is INSUFFICIENT_DATA

# Metric catalogue. `key` = field in fundamentals.json; `rule` = (op, threshold).
# Thresholds are the existing gates from quality.py (documented, not tuned).
METRICS = {
    "roe":           {"label": "ROE (%)", "rule": (">=", 15), "range": (-100, 200)},
    "roce":          {"label": "ROCE (%)", "rule": (">=", 15), "range": (-100, 200)},
    "roa":           {"label": "ROA (%)", "rule": None, "range": (-50, 100)},
    "rev_cagr":      {"label": "Revenue CAGR 3y (%)", "rule": (">=", 10), "range": (-100, 300)},
    "profit_cagr":   {"label": "Net profit CAGR 3y (%)", "rule": (">=", 10), "range": (-100, 500)},
    "eps_cagr":      {"label": "EPS CAGR (%)", "rule": None, "range": (-100, 500)},
    "de":            {"label": "Debt / Equity (x)", "rule": ("<=", 1.0), "range": (0, 10)},
    "interest_cov":  {"label": "Interest coverage (x)", "rule": None, "range": (-100, 1000)},
    "fcf_positive":  {"label": "Free cash flow positive", "rule": ("==", True), "range": None},
    "ocf_cr":        {"label": "Operating cash flow (Rs cr)", "rule": None, "range": None},
    "fcf_cr":        {"label": "Free cash flow (Rs cr)", "rule": None, "range": None},
    "pe":            {"label": "P/E (x)", "rule": ("<=", 35), "range": (0, 500)},
    "pb":            {"label": "P/B (x)", "rule": ("<=", 6), "range": (0, 50)},
    "ps":            {"label": "P/S (x)", "rule": None, "range": (0, 100)},
    "ev_ebitda":     {"label": "EV/EBITDA (x)", "rule": None, "range": (0, 200)},
    "book_value":    {"label": "Book value per share", "rule": None, "range": (0, 100000)},
    "promoter":      {"label": "Promoter holding (%)", "rule": (">=", 50), "range": (0, 100)},
    "pledge":        {"label": "Promoter pledge (%)", "rule": None, "range": (0, 100)},
    "order_book_cr": {"label": "Order book (Rs cr)", "rule": None, "range": (0, 10000000)},
    "gnpa":          {"label": "Gross NPA (%)", "rule": ("<=", 3), "range": (0, 30)},
    "nnpa":          {"label": "Net NPA (%)", "rule": ("<=", 1), "range": (0, 15)},
    "nim":           {"label": "Net interest margin (%)", "rule": (">=", 3), "range": (-5, 15)},
    "deposit_growth": {"label": "Deposit growth 3y (%)", "rule": (">=", 10), "range": (-100, 300)},
    "car":           {"label": "Capital adequacy (%)", "rule": None, "range": (0, 60)},
}

# Sector models: which metrics apply. Anything not listed is NOT APPLICABLE.
NONBANK_CORE = ["roe", "roce", "rev_cagr", "profit_cagr", "de", "fcf_positive", "pe", "pb", "promoter"]
SECTOR_MODELS = {
    "bank": ["roe", "gnpa", "nnpa", "nim", "deposit_growth", "pb", "car", "promoter"],
    "pharma": NONBANK_CORE + ["ev_ebitda"],
    "auto": NONBANK_CORE,
    "it": NONBANK_CORE + ["ev_ebitda"],
    "mining": NONBANK_CORE,
    "conglomerate": NONBANK_CORE,
    "oil": NONBANK_CORE,
    "hospital": NONBANK_CORE + ["ev_ebitda"],
    "capgoods": NONBANK_CORE + ["order_book_cr"],
    "power": NONBANK_CORE,
    "metals": NONBANK_CORE,
}
# Sector model used for the metric-coverage report (any manual type).
SECTOR_NOTE = {
    "capgoods": "Order book applies (execution visibility); not yet supplied in source.",
    "power": "Capacity/utilisation/tariff metrics are not in the source; generic metrics only.",
    "bank": "Non-bank gates do NOT apply to banks (no D/E, no ROCE).",
}


def _age_days(as_of, today):
    try:
        d0 = _dt.date.fromisoformat(as_of)
    except (TypeError, ValueError):
        return None
    return (today - d0).days


def _validate(key, value):
    """Return (validation_status, note). Out-of-range values are never scored."""
    if value is None:
        return "NOT_AVAILABLE", None
    if key == "fcf_positive":
        return ("PLAUSIBLE", None) if isinstance(value, bool) else ("INVALID", "not boolean")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "INVALID", "not numeric"
    lo, hi = METRICS[key]["range"] or (None, None)
    if lo is not None and not (lo <= value <= hi):
        return "OUT_OF_RANGE", "outside plausible %s..%s" % (lo, hi)
    return "PLAUSIBLE", None


def _test(key, value):
    rule = METRICS[key]["rule"]
    if rule is None:
        return None
    op, thr = rule
    if op == "==":
        return value == thr
    return value >= thr if op == ">=" else value <= thr


def analyse_stock(symbol, rec, as_of, today):
    """rec = fundamentals.json company record (or None). Returns a coverage record."""
    sector = (rec or {}).get("type") if rec else None
    model = sector if sector in SECTOR_MODELS else "UNCLASSIFIED"
    applicable = SECTOR_MODELS.get(model, [])
    age = _age_days(as_of, today) if rec else None
    fresh = ("UNKNOWN" if age is None else ("FRESH" if age <= FRESH_DAYS else "STALE"))

    metrics = {}
    for key in METRICS:
        if rec is None:
            value = None
        else:
            value = rec.get(key)
        status, note = _validate(key, value)
        if rec is None and key in applicable:
            status = "NO_SOURCE"
        applies = key in applicable
        m = {"applies": applies, "value": value,
             "source": (rec and "fundamentals.json (screener.in, manual)") or None,
             "as_of": as_of if rec else None, "age_days": age if rec else None,
             "freshness": fresh if rec else "NO_SOURCE",
             "validation": status, "note": note}
        if not applies and value is not None:
            m["note"] = "Reported but not applicable to sector model %s" % model
        metrics[key] = m

    evaluated, passed, failed, factors_pos, factors_neg = [], [], [], [], []
    for key in applicable:
        m = metrics[key]
        if m["validation"] != "PLAUSIBLE":
            continue  # missing / invalid / out-of-range values are never scored
        ok = _test(key, m["value"])
        if ok is None:
            continue  # metric has no scoring threshold: reported, not scored
        evaluated.append(key)
        label = METRICS[key]["label"]
        if ok:
            passed.append(key)
            factors_pos.append("%s meets gate" % label)
        else:
            failed.append(key)
            factors_neg.append("%s fails gate" % label)

    n_app = len(applicable)
    n_eval = len(evaluated)
    if model == "UNCLASSIFIED" or rec is None:
        category = "INSUFFICIENT_DATA"
        reason = "Sector unclassified; no sector rules applied" if model == "UNCLASSIFIED" else "No fundamentals on file"
    elif n_eval < MIN_EVALUATED:
        category, reason = "INSUFFICIENT_DATA", "Only %d of %d applicable gates evaluable (min %d)" % (n_eval, n_app, MIN_EVALUATED)
    else:
        ratio = len(passed) / n_eval
        if ratio >= 0.9:
            category = "EXCELLENT"
        elif ratio >= 0.7:
            category = "GOOD"
        elif ratio >= 0.5:
            category = "NEUTRAL"
        elif ratio >= 0.3:
            category = "WEAK"
        else:
            category = "CRITICAL"
        reason = "%d of %d evaluated gates passed" % (len(passed), n_eval)
        if fresh == "STALE":
            reason += "; source snapshot is STALE (age %s days)" % age
            if category == "EXCELLENT":
                category = "GOOD"  # a stale snapshot cannot support the top grade

    return {
        "symbol": symbol, "sector_model": model, "sector_source":
            ("manual classification in fundamentals.json" if sector else "none"),
        "as_of": as_of if rec else None, "freshness": fresh if rec else "NO_SOURCE",
        "age_days": age if rec else None,
        "applicable_metrics": n_app, "evaluated_gates": n_eval,
        "passed_gates": len(passed), "failed_gates": len(failed),
        "metric_coverage_pct": round(100.0 * sum(1 for k in applicable if metrics[k]["value"] is not None) / n_app, 1) if n_app else 0.0,
        "category": category, "reason": reason,
        "positive_factors": factors_pos, "negative_factors": factors_neg,
        "metrics": metrics,
    }


def build(universe, fundamentals_doc, today=None):
    """universe: list of (symbol, name). fundamentals_doc: parsed fundamentals.json."""
    today = today or _dt.datetime.now(_dt.timezone.utc).date()
    as_of = (fundamentals_doc or {}).get("as_of")
    companies = (fundamentals_doc or {}).get("companies") or {}
    records = {}
    for sym, name in universe:
        rec = companies.get(sym)
        r = analyse_stock(sym, rec, as_of, today)
        r["name"] = name
        records[sym] = r
    return records


def summarise(records, universe_size):
    """Coverage statistics over the whole universe (never extrapolated)."""
    n = len(records)
    per_metric = {}
    for key, meta in METRICS.items():
        applicable = sum(1 for r in records.values() if r["metrics"][key]["applies"])
        reported = sum(1 for r in records.values()
                       if r["metrics"][key]["applies"] and r["metrics"][key]["value"] is not None)
        valid = sum(1 for r in records.values()
                    if r["metrics"][key]["applies"] and r["metrics"][key]["validation"] == "PLAUSIBLE"
                    and r["metrics"][key]["value"] is not None)
        per_metric[key] = {"label": meta["label"], "stocks_where_applicable": applicable,
                           "reported": reported, "validated": valid,
                           "reported_pct_of_applicable": round(100.0 * reported / applicable, 1) if applicable else None,
                           "reported_pct_of_universe": round(100.0 * reported / n, 1) if n else 0.0}
    cats = {}
    sectors = {}
    for r in records.values():
        cats[r["category"]] = cats.get(r["category"], 0) + 1
        sectors[r["sector_model"]] = sectors.get(r["sector_model"], 0) + 1
    return {"universe_size": universe_size, "stocks_audited": n,
            "with_fundamentals_on_file": sum(1 for r in records.values() if r["sector_source"] != "none"),
            "categories": cats, "sector_models": sectors, "metric_coverage": per_metric}
