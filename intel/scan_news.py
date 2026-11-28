"""Phase 5 offline batch: collect facts-only company intelligence for the locked
201-stock universe, classify it deterministically, and write data/news.json with
an append-only data/news_history.jsonl.

Run from the repo root:
    python -m intel.scan_news            # resume
    python -m intel.scan_news --fresh     # recompute active set
    python -m intel.scan_news --limit 10  # first N (testing)

Sources (approved):
  * Yahoo corporate actions (dividends/splits) -> PROVIDER_SOURCED.
  * Google News RSS headlines                  -> REPORTED.
  * NSE/BSE official filings                    -> UNAVAILABLE (NOT attempted).
No LLM, no sentiment, no paid APIs, no scraping workarounds. The weekly engine
and Phase 1-4 logic are untouched (this writes a separate store).
"""
import datetime as _dt
import hashlib
import html as _html
import os
import re
import sys
import time
import urllib.parse as _up
import urllib.request as _ur
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import engine  # read-only: UA, _SSL_CTX, _yahoo_url  # noqa: E402
from intel import news_rules as nr  # noqa: E402
from intel.datasource import _now_iso  # noqa: E402
from intel.scan_universe import _load_universe  # noqa: E402
from intel.store import JsonFileStore  # noqa: E402

DELAY = 1.0
ACTIVE_LIMIT = 20          # events displayed per stock
LOW_ACTIVE_CAP = 6         # max routine LOW/market-commentary items shown (not retained)
ACTIVE_WINDOW_DAYS = 180   # active retrieval window (history is immutable)
STALE_HOURS = 36
_TAG_RE = re.compile(r"<[^>]+>")

LIMITATIONS = [
    "Official NSE/BSE announcement APIs are blocked for automated access -> OFFICIAL_VERIFIED is UNAVAILABLE.",
    "Google News items are REPORTED (media), not confirmed company facts; headlines are not verified announcements.",
    "Yahoo dividend/split events are PROVIDER_SOURCED, not independently/officially verified.",
    "Deterministic keyword categorisation can mis-tag ambiguous headlines; the original headline is always shown.",
    "Materiality is a rule-assigned significance, NOT proof an event is genuinely material or a price-move prediction.",
    "Ambiguous stock matches are not auto-attached; display is capped at %d events / %d-day window." % (ACTIVE_LIMIT, ACTIVE_WINDOW_DAYS),
    "Immutable history retains MATERIAL events (HIGH/MEDIUM + provider actions); routine LOW market commentary is best-effort active context only, not permanently retained (bounds repo growth).",
]


def _curated_name(sym):
    try:
        import quality
        comp = (quality._load().get("companies") or {}).get(sym.upper())
        if comp and comp.get("name"):
            return comp["name"]
    except Exception:  # noqa: BLE001
        pass
    return None


def _universe_names():
    names = {}
    for sym, nm in _load_universe():
        names[sym] = _curated_name(sym) or nm
    return names


def _hash(*parts):
    return hashlib.sha1("|".join(str(p or "") for p in parts).encode("utf-8")).hexdigest()[:16]


def _yahoo_actions(sym):
    """PROVIDER_SOURCED dividend/split events from Yahoo. Returns (events, ok)."""
    url = engine._yahoo_url(sym, "2y", "1d") + "&events=div,splits"
    try:
        req = _ur.Request(url, headers={"User-Agent": engine.UA})
        with _ur.urlopen(req, timeout=20, context=engine._SSL_CTX) as resp:
            import json as _json
            data = _json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return [], False
    res = (data.get("chart") or {}).get("result") or []
    if not res:
        return [], False
    ev = (res[0].get("events") or {})
    out = []
    for d in (ev.get("dividends") or {}).values():
        ts = d.get("date")
        date = _dt.datetime.utcfromtimestamp(int(ts)).date().isoformat() if ts else None
        cls = nr.classify_corporate_action("dividend")
        out.append(_event(sym, "yahoo-finance", nr.PROVIDER_SOURCED,
                          "Dividend of %s (ex-date %s)" % (d.get("amount"), date),
                          None, date, cls, {"action": "dividend", "amount": d.get("amount"), "ex_date": date},
                          match_reason="provider symbol-native"))
    for s in (ev.get("splits") or {}).values():
        ts = s.get("date")
        date = _dt.datetime.utcfromtimestamp(int(ts)).date().isoformat() if ts else None
        ratio = s.get("splitRatio") or ("%s:%s" % (s.get("numerator"), s.get("denominator")))
        cls = nr.classify_corporate_action("split")
        out.append(_event(sym, "yahoo-finance", nr.PROVIDER_SOURCED,
                          "Stock split %s (date %s)" % (ratio, date),
                          None, date, cls, {"action": "split", "ratio": ratio, "ex_date": date},
                          match_reason="provider symbol-native"))
    return out, True


def _google_news(sym, name):
    """REPORTED headlines. Returns (events, ok). Conservative stock-matching."""
    q = _up.quote('"%s" share price' % name)
    url = "https://news.google.com/rss/search?q=%s&hl=en-IN&gl=IN&ceid=IN:en" % q
    try:
        req = _ur.Request(url, headers={"User-Agent": engine.UA})
        with _ur.urlopen(req, timeout=15, context=engine._SSL_CTX) as resp:
            raw = resp.read().decode("utf-8", "replace")
        root = ET.fromstring(raw)
    except Exception:  # noqa: BLE001
        return [], False
    out = []
    from email.utils import parsedate_to_datetime as _pdt
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        if not title or not link:
            continue
        src_el = it.find("source")
        source = (src_el.text or "").strip() if src_el is not None else ""
        if not source and " - " in title:
            source = title.rsplit(" - ", 1)[1].strip()
        if source and title.endswith(" - " + source):
            title = title[: -(len(source) + 3)].strip()
        title = _html.unescape(title)
        ok, reason = nr.matches_company(title, name, sym)
        if not ok:
            continue  # ambiguous -> NOT attached (conservative)
        pub = (it.findtext("pubDate") or "").strip()
        try:
            iso = _pdt(pub).astimezone().isoformat()
        except Exception:  # noqa: BLE001
            iso = None
        cls = nr.classify_headline(title)
        out.append(_event(sym, source or "Google News", nr.REPORTED, title,
                          link, iso, cls, None, match_reason=reason))
        if len(out) >= 15:
            break
    return out, True


def _event(sym, source, source_class, text, url, published_at, cls, details, match_reason):
    return {"id": _hash(sym, text, source, published_at),
            "symbol": sym, "source": source, "source_class": source_class,
            "category": cls["category"], "materiality": cls["materiality"],
            "matched_keyword": cls["matched_keyword"], "why": cls["why"],
            "headline": text, "url": url,
            "published_at": published_at, "retrieved_at": _now_iso(),
            "details": details, "match_reason": match_reason,
            "dedup_hash": _hash(_norm(text), source, (published_at or "")[:10])}


def _norm(t):
    return re.sub(r"\s+", " ", (t or "").lower()).strip()


def collect_stock(sym, name, hist_hashes, store):
    acts, y_ok = _yahoo_actions(sym)
    time.sleep(DELAY)
    news, g_ok = _google_news(sym, name)
    events = acts + news
    # dedup within this run
    seen, deduped = set(), []
    for e in events:
        if e["dedup_hash"] in seen:
            continue
        seen.add(e["dedup_hash"])
        deduped.append(e)
    # append genuinely-new events to immutable history — ONLY material ones
    # (HIGH/MEDIUM) or provider-sourced corporate actions. Routine LOW market
    # commentary is best-effort active context, not permanently retained (keeps
    # the immutable history meaningful and bounds repository growth).
    def _retain(e):
        return e["materiality"] in ("HIGH", "MEDIUM") or e["source_class"] == nr.PROVIDER_SOURCED
    new_count = 0
    for e in deduped:
        if _retain(e) and e["dedup_hash"] not in hist_hashes:
            store.append_news_history(e)
            hist_hashes.add(e["dedup_hash"])
            new_count += 1
    # active set: within window, newest first. Keep ALL material events; cap the
    # low-materiality commentary, then cap total at ACTIVE_LIMIT.
    cutoff = (_dt.date.today() - _dt.timedelta(days=ACTIVE_WINDOW_DAYS)).isoformat()
    inwin = [e for e in deduped if (e["published_at"] or e["retrieved_at"])[:10] >= cutoff]
    inwin.sort(key=lambda e: (e["published_at"] or e["retrieved_at"] or ""), reverse=True)
    material = [e for e in inwin if _retain(e)]
    low = [e for e in inwin if not _retain(e)][:LOW_ACTIVE_CAP]
    active = sorted(material + low,
                    key=lambda e: (e["published_at"] or e["retrieved_at"] or ""), reverse=True)[:ACTIVE_LIMIT]
    source_status = {
        "yahoo": nr.PROVIDER_SOURCED if y_ok else nr.UNAVAILABLE,
        "google_news": nr.REPORTED if g_ok else nr.UNAVAILABLE,
        "nse": nr.UNAVAILABLE, "bse": nr.UNAVAILABLE,
    }
    return {"symbol": sym, "name": name, "events": active,
            "last_collected_at": _now_iso(), "stale": False,
            "source_status": source_status,
            "source_errors": ([] if y_ok else ["yahoo fetch failed"]) + ([] if g_ok else ["google news fetch failed"]),
            "new_history_events": new_count}, (y_ok or g_ok)


def main():
    args = sys.argv[1:]
    fresh = "--fresh" in args
    limit = None
    if "--limit" in args:
        try:
            limit = int(args[args.index("--limit") + 1])
        except Exception:  # noqa: BLE001
            pass

    universe = _load_universe()
    if limit:
        universe = universe[:limit]
    names = _universe_names()
    store = JsonFileStore()
    hist_hashes = store.news_history_hashes()
    prev = (store.get_news() or {}).get("stocks", {})
    state = (None if fresh else store.get_news_state()) or {"done": []}
    done = set(state.get("done", []))
    out = dict(prev) if not fresh else {}
    processed = 0

    print("News collection for %d stocks%s ..." % (len(universe), " [resume]" if done else ""))
    for i, (sym, _nm) in enumerate(universe, 1):
        if sym in done and not fresh and sym in out:
            continue
        name = names.get(sym, _nm)
        try:
            rec, ok = collect_stock(sym, name, hist_hashes, store)
            if not ok and prev.get(sym):
                rec = dict(prev[sym]); rec["stale"] = True
                rec["last_scan_note"] = "Collection failed — kept last active set."
        except Exception as e:  # noqa: BLE001
            rec = prev.get(sym) or {"symbol": sym, "name": name, "events": [],
                                    "source_status": {"yahoo": nr.UNAVAILABLE, "google_news": nr.UNAVAILABLE,
                                                      "nse": nr.UNAVAILABLE, "bse": nr.UNAVAILABLE}}
            rec = dict(rec); rec["stale"] = True; rec["last_scan_error"] = str(e)[:160]
        out[sym] = rec
        done.add(sym); processed += 1
        if processed % 10 == 0:
            store.put_news_state({"done": sorted(done), "updated_at": _now_iso()})
            store.put_news(_build(out, universe))
        print("  [%d/%d] %-16s %d active (+%d new)" % (i, len(universe), sym,
              len(rec.get("events", [])), rec.get("new_history_events", 0)))
        time.sleep(DELAY)

    store.put_news_state({"done": sorted(done), "updated_at": _now_iso()})
    store.put_news(_build(out, universe))
    print("\nDone. processed=%d  stocks=%d" % (processed, len(out)))
    print("storage:", store.usage())


def _build(out, universe):
    by_cat, by_mat, by_src = {}, {}, {}
    total = 0
    for r in out.values():
        for e in r.get("events", []):
            total += 1
            by_cat[e["category"]] = by_cat.get(e["category"], 0) + 1
            by_mat[e["materiality"]] = by_mat.get(e["materiality"], 0) + 1
            by_src[e["source_class"]] = by_src.get(e["source_class"], 0) + 1
    return {"generated_at": _now_iso(), "methodology_version": nr.METHODOLOGY_VERSION,
            "universe_size": len(universe), "active_events": total,
            "counts": {"by_category": by_cat, "by_materiality": by_mat, "by_source_class": by_src},
            "source_status": {"yahoo": "PROVIDER_SOURCED", "google_news": "REPORTED",
                              "nse": "UNAVAILABLE", "bse": "UNAVAILABLE"},
            "limits": {"active_per_stock": ACTIVE_LIMIT, "active_window_days": ACTIVE_WINDOW_DAYS},
            "limitations": LIMITATIONS, "stocks": out}


if __name__ == "__main__":
    main()
