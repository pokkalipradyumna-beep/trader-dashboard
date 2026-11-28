"""Phase 5: deterministic, facts-only classification of company intelligence.

Pure functions, NO network, NO LLM, NO sentiment, NO prediction. Classifies the
TOPIC of a factual item (headline text or a structured provider event) into a
category and a rule-based materiality level, and records exactly WHICH rule
matched and WHY. A keyword match is a rule-assigned significance, NOT proof the
event is genuinely material — callers must present it as such.

Source classifications (never upgraded without evidence):
  OFFICIAL_VERIFIED  - from an official exchange/company filing (none available now)
  PROVIDER_SOURCED   - structured data from a data provider (Yahoo splits/dividends)
  REPORTED           - a media report/headline (Google News), not a confirmed fact
  UNAVAILABLE        - the official source could not be reached
"""
from __future__ import annotations

import re

METHODOLOGY_VERSION = "news-v1.0"

OFFICIAL_VERIFIED = "OFFICIAL_VERIFIED"
PROVIDER_SOURCED = "PROVIDER_SOURCED"
REPORTED = "REPORTED"
UNAVAILABLE = "UNAVAILABLE"
SOURCE_CLASSES = [OFFICIAL_VERIFIED, PROVIDER_SOURCED, REPORTED, UNAVAILABLE]

# Category -> (keyword patterns, base materiality). Order matters: the first
# category (by this list order = priority) whose pattern matches wins when
# several match. Patterns are whole-word, case-insensitive.
CATEGORY_RULES = [
    ("REGULATORY", "HIGH", [
        r"sebi", r"penalt(y|ies)", r"\bfine[sd]?\b", r"probe", r"investigation",
        r"litigation", r"lawsuit", r"show[- ]cause", r"\bban\b", r"\braid\b",
        r"insolvency", r"\bnclt\b", r"default(s|ed)?", r"fraud", r"money laundering", r"\bed\b probe"]),
    ("MA_DEMERGER", "HIGH", [
        r"acquir(e|es|ed|ing|ition)", r"\bmerger\b", r"\bmerge[sd]?\b", r"demerger",
        r"takeover", r"stake sale", r"buys? stake", r"amalgamation", r"open offer"]),
    ("RESULTS", "HIGH", [
        r"\bq[1-4]\b", r"quarterly results?", r"annual results?", r"net profit",
        r"\bprofit (rise|rises|jump|jumps|fall|falls|drop|drops|decline)", r"\brevenue\b",
        r"\bearnings\b", r"\bebitda\b", r"results? (beat|miss|preview)"]),
    ("RIGHTS_BUYBACK", "HIGH", [
        r"rights issue", r"buy ?back", r"tender offer", r"\bqip\b", r"preferential (issue|allotment)"]),
    ("PROMOTER_PLEDGE", "HIGH", [
        r"pledge[sd]?", r"encumber", r"promoter (stake|holding|sell|sold|buy|bought)",
        r"promoter[s]? (raise|increase|cut|reduce)"]),
    ("MANAGEMENT", "HIGH", [
        r"resign(s|ed|ation)?", r"steps? down", r"\bceo\b", r"\bcfo\b", r"\bmd\b",
        r"managing director", r"chairman", r"appoint(s|ed|ment)?", r"\bquits?\b"]),
    ("RATING", "HIGH", [
        r"credit rating", r"rating (upgrade|downgrade|cut|raised|lowered)",
        r"\b(crisil|icra|care ratings|moody'?s|s&p|fitch)\b"]),
    ("ORDER_BIZ", "HIGH", [
        r"order win", r"wins? (order|contract)", r"bags? (order|contract|deal)",
        r"\bloi\b", r"letter of intent", r"order cancell", r"new plant", r"capacity expansion",
        r"commission(s|ed|ing)? (plant|unit|facility)"]),
    ("RIGHTS_BUYBACK", "MEDIUM", [r"\bbonus\b"]),   # bonus handled below too
    ("DIVIDEND", "MEDIUM", [r"dividend", r"interim dividend", r"final dividend", r"record date"]),
    ("BONUS_SPLIT", "MEDIUM", [r"\bbonus (issue|share)", r"stock split", r"\bsplit\b", r"face value"]),
    ("BOARD_MEETING", "MEDIUM", [r"board meeting", r"board to (meet|consider)", r"agm\b", r"\begm\b"]),
    ("SHAREHOLDING", "MEDIUM", [r"shareholding", r"\bstake\b", r"block deal", r"bulk deal"]),
    ("MARKET_NOISE", "LOW", [
        r"share price", r"target price", r"stock to watch", r"buy or sell", r"technical",
        r"multibagger", r"52[- ]week", r"\brally\b", r"\bsurge[sd]?\b", r"\bslump[sd]?\b",
        r"brokerage", r"analyst[s]?", r"\bupgrade[sd]?\b", r"\bdowngrade[sd]?\b"]),
]

_COMPILED = [(cat, mat, [re.compile(p, re.I) for p in pats]) for cat, mat, pats in CATEGORY_RULES]

# "Large"/distinctive signals bumping ORDER_BIZ / RESULTS to HIGH already set HIGH.
MATERIALITY_ORDER = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}


def classify_headline(text):
    """Return a classification dict for a reported headline. If nothing matches,
    category OTHER / materiality LOW. Records matched keyword and a plain why."""
    text = text or ""
    for cat, mat, pats in _COMPILED:
        for rx in pats:
            m = rx.search(text)
            if m:
                return {"category": cat, "materiality": mat,
                        "matched_keyword": m.group(0),
                        "why": "Rule-assigned %s: headline matched '%s' -> category %s. "
                               "This is the rule's significance, NOT independently established materiality."
                               % (mat, m.group(0), cat)}
    return {"category": "OTHER", "materiality": "LOW", "matched_keyword": None,
            "why": "No category keyword matched; treated as routine/other (LOW). Not independently assessed."}


def classify_corporate_action(action_type, detail=None):
    """Structured Yahoo action -> deterministic category/materiality (facts, but
    PROVIDER_SOURCED, not officially verified)."""
    if action_type == "dividend":
        return {"category": "DIVIDEND", "materiality": "MEDIUM",
                "matched_keyword": "yahoo:dividend",
                "why": "Provider-sourced dividend event (Yahoo). MEDIUM by rule; not officially verified."}
    if action_type == "split":
        return {"category": "BONUS_SPLIT", "materiality": "MEDIUM",
                "matched_keyword": "yahoo:split",
                "why": "Provider-sourced stock-split event (Yahoo). MEDIUM by rule; not officially verified."}
    return {"category": "OTHER", "materiality": "LOW", "matched_keyword": None,
            "why": "Unrecognised provider event."}


def matches_company(headline, company_name, symbol):
    """Deterministic stock-matching: attach ONLY if a distinctive company token
    (>=4 chars) or the full name appears in the headline. Returns (ok, reason).
    Conservative: ambiguous/short names do not auto-attach."""
    if not headline or not company_name:
        return False, "missing headline or company name"
    h = headline.lower()
    name = company_name.lower()
    if name in h:
        return True, "full company name present in headline"
    # distinctive tokens: words >=4 chars, excluding generic corporate words
    generic = {"india", "limited", "ltd", "industries", "company", "corporation",
               "corp", "enterprises", "finance", "financial", "bank", "motors",
               "steel", "power", "energy", "cement", "pharma", "technologies",
               "services", "international", "and", "the"}
    toks = [t for t in re.split(r"[^a-z0-9]+", name) if len(t) >= 4 and t not in generic]
    for t in toks:
        if re.search(r"\b" + re.escape(t) + r"\b", h):
            return True, "distinctive token '%s' present in headline" % t
    return False, "no distinctive company token in headline (ambiguous — not attached)"
