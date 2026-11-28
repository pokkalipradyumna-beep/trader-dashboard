#!/usr/bin/env python3
"""Trader Dashboard backend (S-1). Standard-library http.server only.

Serves the web UI and a JSON API:
  GET /api/stock?symbol=RELIANCE.NS   -> candles + EMA 9/21/50 + markers + verdict
  GET /api/scan?symbols=A.NS,B.NS     -> quick verdict per symbol (for the watchlist)
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import engine
import holdings
import quality
import valuation

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "public")
# PORT + HOST come from the environment so this runs on any host (Render/Railway/
# Fly/Docker set $PORT; 0.0.0.0 binds all interfaces, localhost still works).
PORT = int(os.environ.get("PORT", "8787"))
HOST = os.environ.get("HOST", "0.0.0.0")
CTYPES = {".html": "text/html; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".svg": "image/svg+xml", ".ico": "image/x-icon"}


def _category(verdict, q):
    """Combine momentum + quality into a ranked category (lower rank = better)."""
    action = verdict["action"]
    strong = verdict["headline"].startswith("STRONG")
    ql = q.get("quality") if q.get("available") else None
    if action == "BUY":
        if ql == "FAIL":
            return "CHART-ONLY", 3
        if strong and ql in ("PASS", "NEAR"):
            return "STRONG BUY", 1
        return "BUY", 2
    if action == "SELL":
        return "SELL", 6
    if action == "HOLD":
        return "HOLD", 4
    return "WAIT", 5


def _scan_row(sym, f):
    """Full rich row (used by /api/scanner and /api/scan): price, signal, quality,
    valuation, confluence, weekly change + sparkline."""
    r = engine.compute(sym)
    q = quality.score(sym)
    val = valuation.value(f, r["price"]) if f else {"applicable": False}
    cat, rank = _category(r["verdict"], q)
    return {"symbol": sym, "name": q.get("name") or sym,
            "price": r["price"], "action": r["verdict"]["action"],
            "headline": r["verdict"]["headline"],
            "strong": r["verdict"]["headline"].startswith("STRONG"),
            "s9": (r["signal_9_21"] or {}).get("regime"),
            "s21": (r["signal_21_50"] or {}).get("regime"),
            "quality": q.get("quality") if q.get("available") else None,
            "valuation": q.get("valuation") if q.get("available") else None,
            "upside": val.get("upside_pct") if val.get("applicable") else None,
            "upside_flag": bool(val.get("flag")) if val.get("applicable") else False,
            "confluence": r.get("confluence"),
            "chg1w": (round((r["last_close"] - r["prev_close"]) / r["prev_close"] * 100, 2)
                      if (r.get("last_close") and r.get("prev_close")) else None),
            "spark": [round(c["close"], 2) for c in (r.get("candles") or [])[-16:]],
            "category": cat, "rank": rank}


def _scan_one(task):
    """One (symbol, fundamentals, name-override, is-penny) -> a rich row (or an
    error row, or None to drop an unavailable penny extra)."""
    sym, f, name, penny = task
    try:
        row = _scan_row(sym, f)
        if name:
            row["name"] = name
        if penny:
            row["penny"] = True
        return row
    except Exception as exc:  # noqa: BLE001
        if penny:
            return None  # skip an unavailable penny/extra quietly
        return {"symbol": sym, "name": name or sym, "action": "ERROR",
                "category": "ERROR", "rank": 99, "quality": None, "valuation": None,
                "note": str(exc), "ecode": getattr(exc, "code", "server_error")}


def _scan_many(tasks, workers=12):
    """Fetch/score many symbols concurrently so the universe scan takes a few
    seconds (not ~15s sequentially) and fits serverless timeouts."""
    if not tasks:
        return []
    with ThreadPoolExecutor(max_workers=min(workers, len(tasks))) as ex:
        return [r for r in ex.map(_scan_one, tasks) if r is not None]


# Low-priced / penny stocks shown on Home for price-range coverage. They are NOT
# in fundamentals.json on purpose: no fabricated metrics, so they scan chart-and-
# signal only (price + weekly 9/21·21/50 + confluence + sparkline) and read
# "not rated" on quality — the honest outcome for the quality-first method.
_EXTRA = {
    "IDEA.NS": "Vodafone Idea", "JPPOWER.NS": "Jaiprakash Power", "RPOWER.NS": "Reliance Power",
    "YESBANK.NS": "Yes Bank", "TRIDENT.NS": "Trident", "SUZLON.NS": "Suzlon Energy",
    "IOB.NS": "Indian Overseas Bank", "SJVN.NS": "SJVN", "NHPC.NS": "NHPC",
    "IRFC.NS": "IRFC", "PNB.NS": "Punjab National Bank",
}


_UNIVERSE_CACHE = None


def _universe():
    """Every ticker the app knows (public/symbols.json) with a display name, so the
    scanner covers the FULL universe — not just the 24 curated fundamentals names.
    Non-curated names scan chart-and-signal only (quality 'not rated'); nothing is
    fabricated. Cached in-process (the file is static)."""
    global _UNIVERSE_CACHE
    if _UNIVERSE_CACHE is None:
        _UNIVERSE_CACHE = []
        # Try a few locations: public/ (local + bundled), the module dir, and the
        # cwd — serverless bundlers lay files out differently, so be defensive.
        for p in (os.path.join(WEB, "symbols.json"),
                  os.path.join(HERE, "symbols.json"),
                  os.path.join(HERE, "public", "symbols.json"),
                  "symbols.json", os.path.join("public", "symbols.json")):
            try:
                with open(p, encoding="utf-8") as fh:
                    _UNIVERSE_CACHE = [(d["t"], d.get("n") or d["t"])
                                       for d in json.load(fh) if d.get("t")]
                if _UNIVERSE_CACHE:
                    break
            except Exception:  # noqa: BLE001 — try the next candidate path
                continue
    return _UNIVERSE_CACHE


def _intraday(symbol, interval="15m", rng="5d"):
    """Delayed intraday candles for the trading-perspectives feature. SEPARATE from
    the weekly engine: it keeps full unix timestamps (engine.fetch_candles collapses
    to date-only, which is correct for W/D/M but loses the time of day). Reuses the
    engine's Yahoo URL builder + SSL context only; it changes no engine function and
    never touches the weekly 9/21·21/50 signal logic. Data is Yahoo ~15-min delayed."""
    import urllib.request as _ur, urllib.error as _ue
    req = _ur.Request(engine._yahoo_url(symbol, rng, interval), headers={"User-Agent": engine.UA})
    try:
        with _ur.urlopen(req, timeout=20, context=engine._SSL_CTX) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except _ue.HTTPError as e:
        if e.code in (404, 400):
            raise engine.NotFoundError("%s isn't on the data feed." % symbol)
        raise engine.FeedDownError("The data feed returned an error (HTTP %s)." % e.code)
    except Exception as e:  # noqa: BLE001
        raise engine.FeedDownError("Can't reach the data feed right now (%s)." % e)
    res = (data.get("chart") or {}).get("result") or []
    if not res:
        raise engine.NoDataError("No intraday data available for %s right now." % symbol)
    r = res[0]
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    o, h, lo, c, v = q.get("open"), q.get("high"), q.get("low"), q.get("close"), q.get("volume")
    bars = []
    for i, t in enumerate(ts):
        ov, hv, lov, cv = o[i], h[i], lo[i], c[i]
        if None in (ov, hv, lov, cv) or min(ov, hv, lov, cv) <= 0 or hv < lov:
            continue
        bars.append({"time": int(t), "open": ov, "high": hv, "low": lov, "close": cv, "volume": v[i] or 0})
    if not bars:
        raise engine.NoDataError("No usable intraday data for %s right now." % symbol)
    meta = r.get("meta") or {}
    return {"currency": meta.get("currency", "INR"), "as_of": meta.get("regularMarketTime"),
            "interval": interval, "bars": bars}


def _news_company(symbol):
    """Best human name for a symbol, for the news query. Reads the curated
    fundamentals name, then the _EXTRA low-priced list, else strips the
    exchange suffix. Never fabricates — just the display name."""
    sym = symbol.upper()
    f = (quality._load().get("companies") or {}).get(sym)
    if f and f.get("name"):
        return f["name"]
    if sym in _EXTRA:
        return _EXTRA[sym]
    return sym.split(".")[0].replace("-", " ").title()


_TAG_RE = __import__("re").compile(r"<[^>]+>")


def _news(symbol):
    """Latest headlines for a company from Google News RSS. FACTS ONLY —
    headline, source, date, link, snippet — no sentiment or impact label
    (reliable sentiment needs an NLP service this app doesn't run, so we
    don't fake one). Fully separate from the weekly engine. On any failure
    it returns an empty list with a note instead of breaking the page."""
    import urllib.request as _ur, urllib.parse as _up
    import html as _html
    from email.utils import parsedate_to_datetime as _pdt
    name = _news_company(symbol)
    # "<Company> share" biases Google News toward market coverage of the stock.
    q = _up.quote('"%s" share price' % name)
    url = ("https://news.google.com/rss/search?q=%s&hl=en-IN&gl=IN&ceid=IN:en" % q)
    req = _ur.Request(url, headers={"User-Agent": engine.UA})
    try:
        with _ur.urlopen(req, timeout=15, context=engine._SSL_CTX) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 — news is best-effort, never fatal
        return {"company": name, "items": [], "note": "News feed is unavailable right now.",
                "error": str(e)[:120]}
    try:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(raw)
    except Exception:  # noqa: BLE001
        return {"company": name, "items": [], "note": "Couldn't read the news feed right now."}
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        if not title or not link:
            continue
        src_el = it.find("source")
        source = (src_el.text or "").strip() if src_el is not None else ""
        # Google formats titles as "Headline - Source"; split the source off.
        if not source and " - " in title:
            source = title.rsplit(" - ", 1)[1].strip()
        if source and title.endswith(" - " + source):
            title = title[: -(len(source) + 3)].strip()
        pub = (it.findtext("pubDate") or "").strip()
        iso = None
        try:
            iso = _pdt(pub).astimezone().isoformat()
        except Exception:  # noqa: BLE001
            iso = None
        desc = it.findtext("description") or ""
        snippet = _html.unescape(_TAG_RE.sub(" ", desc)).strip()
        snippet = " ".join(snippet.split())
        # Google's description is often just a repeat of the headline + source list.
        if snippet[:60].lower() == title[:60].lower():
            snippet = ""
        items.append({"title": _html.unescape(title), "source": source,
                      "date": iso, "pub": pub, "link": link,
                      "snippet": snippet[:240]})
        if len(items) >= 8:
            break
    note = None if items else "No recent news found for this company."
    return {"company": name, "items": items, "note": note}


# ---- Short-term screener (Phase C) ------------------------------------------
# A SEPARATE screener on the DAILY timeframe for short-term (days–weeks) setups.
# It does NOT touch the weekly 9/21·21/50 engine or its BUY/SELL signals — it
# reuses only engine.ema / engine._rsi_last / engine.fetch_candles (pure math +
# fetch). There is deliberately NO intraday screener: honest intraday needs
# real-time data the delayed Yahoo feed can't provide. Daily data here is Yahoo
# ~15-min delayed end-of-day, labelled as such. Only real setups with enough
# data are returned — never a recommendation without sufficient analysis.
def _st_one(task):
    sym, f = task
    try:
        bars = engine.fetch_candles(sym, interval="1d", rng="6mo").get("bars") or []
    except Exception:  # noqa: BLE001 — a thin/failed name is simply skipped
        return None
    closes = [b["close"] for b in bars if b.get("close") is not None]
    # Need enough daily history for a trustworthy EMA21 + RSI read.
    if len(closes) < 40:
        return None
    e9, e21 = engine.ema(closes, 9), engine.ema(closes, 21)
    if e9[-1] is None or e21[-1] is None:
        return None
    rsi = engine._rsi_last(closes, 14)
    price = closes[-1]
    up = e9[-1] > e21[-1]
    # Fresh daily bullish cross in the last 5 sessions?
    fresh = False
    for i in range(max(1, len(closes) - 5), len(closes)):
        if e9[i] is not None and e21[i] is not None and e9[i - 1] is not None and e21[i - 1] is not None:
            if e9[i - 1] <= e21[i - 1] and e9[i] > e21[i]:
                fresh = True
                break
    lows = [b["low"] for b in bars[-20:] if b.get("low") is not None]
    highs = [b["high"] for b in bars[-20:] if b.get("high") is not None]
    support = min(lows) if lows else None
    resistance = max(highs) if highs else None
    chg1d = round((closes[-1] - closes[-2]) / closes[-2] * 100, 2) if len(closes) >= 2 and closes[-2] else None
    overbought = rsi is not None and rsi >= 72
    # ---- Decide whether this is a real short-term setup (else drop it) ----
    setup = score = None
    reasons, risks = [], []
    if fresh and price > e9[-1] and not overbought:
        setup, score = "Fresh breakout", 1
        reasons = ["Daily 9-EMA just crossed above the 21-EMA (fresh momentum turn).",
                   "Price is holding above the 9-day EMA."]
    elif up and price >= e21[-1] and (rsi is None or (45 <= rsi <= 68)):
        setup, score = "Uptrend continuation", 2
        reasons = ["Daily trend is up (9-EMA above 21-EMA).",
                   "Price is above the 21-day EMA — structure intact."]
    else:
        return None  # not a clean short-term candidate — don't recommend it
    if rsi is not None:
        reasons.append("Daily RSI %d (%s)." % (round(rsi),
                       "strong" if rsi >= 60 else "healthy" if rsi >= 50 else "recovering"))
    # Honest, setup-specific risks + a stop idea.
    risks.append("Uses end-of-day data that's ~15-min delayed — not for precise day timing.")
    if resistance and price and resistance > price * 1.002:
        risks.append("Overhead resistance near ₹%s — can stall there." % round(resistance, 2))
    risks.append("Invalidated on a daily close back below the 21-EMA (₹%s) — natural stop." % round(e21[-1], 2))
    if rsi is not None and rsi >= 68:
        risks.append("RSI is getting stretched (%d) — chasing adds risk." % round(rsi))
    name = (f.get("name") if f else None) or _news_company(sym)
    return {"symbol": sym, "name": name, "price": round(price, 2), "setup": setup, "score": score,
            "ema9": round(e9[-1], 2), "ema21": round(e21[-1], 2),
            "rsi": round(rsi, 1) if rsi is not None else None,
            "support": round(support, 2) if support else None,
            "resistance": round(resistance, 2) if resistance else None,
            "stop": round(e21[-1], 2), "chg1d": chg1d,
            "reasons": reasons, "risks": risks,
            "spark": [round(c, 2) for c in closes[-16:]]}


def _shortterm():
    companies = quality._load().get("companies") or {}
    tasks = [(s, f) for s, f in companies.items()]
    tasks += [(s, None) for s in _EXTRA if s not in companies]
    with ThreadPoolExecutor(max_workers=min(12, max(1, len(tasks)))) as ex:
        rows = [r for r in ex.map(_st_one, tasks) if r is not None]
    rows.sort(key=lambda x: (x["score"], -(x["rsi"] or 0), x["symbol"]))
    return rows


# ---- Intraday snapshot (delayed, ILLUSTRATIVE ONLY) -------------------------
# A clearly-labelled DELAYED 15-minute momentum snapshot of the universe. This
# is NOT a live intraday screener and NOT for live entries/exits: Yahoo data is
# ~15-min delayed and unlicensed for live intraday, so this is context only.
# Reuses _intraday (full-timestamp 15m bars) + engine.ema / engine._rsi_last.
# It does NOT touch the weekly engine or any BUY/SELL signal.
def _intraday_one(task):
    sym, f = task
    try:
        d = _intraday(sym, "15m", "5d")
    except Exception:  # noqa: BLE001 — a thin/failed name is skipped
        return None
    bars = d.get("bars") or []
    closes = [b["close"] for b in bars if b.get("close") is not None]
    if len(closes) < 40:   # need enough 15m history for a trustworthy read
        return None
    e9, e21 = engine.ema(closes, 9), engine.ema(closes, 21)
    if e9[-1] is None or e21[-1] is None:
        return None
    rsi = engine._rsi_last(closes, 14)
    price = closes[-1]
    up = e9[-1] > e21[-1]
    if not up:
        return None  # only surface names leaning UP on the delayed 15m trend
    fresh = False
    for i in range(max(1, len(closes) - 8), len(closes)):
        if None not in (e9[i], e21[i], e9[i - 1], e21[i - 1]) and e9[i - 1] <= e21[i - 1] and e9[i] > e21[i]:
            fresh = True
            break
    reasons = ["15-minute 9-EMA is above the 21-EMA — the delayed intraday trend leans up."]
    if fresh:
        reasons.append("A fresh 15-minute 9/21 cross in the last ~2 hours of data.")
    if rsi is not None:
        reasons.append("15-minute RSI %d." % round(rsi))
    name = (f.get("name") if f else None) or _news_company(sym)
    return {"symbol": sym, "name": name, "price": round(price, 2),
            "ema9": round(e9[-1], 2), "ema21": round(e21[-1], 2),
            "rsi": round(rsi, 1) if rsi is not None else None,
            "fresh": fresh, "as_of": d.get("as_of"), "reasons": reasons,
            "spark": [round(c, 2) for c in closes[-16:]]}


def _intraday_scan():
    companies = quality._load().get("companies") or {}
    tasks = [(s, f) for s, f in companies.items()]
    tasks += [(s, None) for s in _EXTRA if s not in companies]
    with ThreadPoolExecutor(max_workers=min(12, max(1, len(tasks)))) as ex:
        rows = [r for r in ex.map(_intraday_one, tasks) if r is not None]
    rows.sort(key=lambda x: (0 if x["fresh"] else 1, -(x["rsi"] or 0), x["symbol"]))
    as_of = max((r["as_of"] for r in rows if r.get("as_of")), default=None)
    return {"illustrative": True, "delayed": True, "as_of": as_of, "results": rows}


_SYS_STORE = None


def _system_store():
    """Lazy, read-only handle to the intelligence Store. Guarded so the app
    never breaks if the intel package / data files aren't present yet."""
    global _SYS_STORE
    if _SYS_STORE is None:
        try:
            from intel.store import JsonFileStore
            _SYS_STORE = JsonFileStore()
        except Exception:  # noqa: BLE001
            _SYS_STORE = False
    return _SYS_STORE or None


def _system_read(path, qs):
    """Read-only Trader-Intelligence endpoints (Phase 1). Serve the committed
    coverage registry; never compute heavy work in the request path."""
    store = _system_store()
    if path == "/api/system/universe" or path == "/api/system/overview":
        uni = store.get_universe() if store else None
        if not uni:
            return {"generated": False,
                    "message": "Coverage scan has not been generated yet. Run the offline scanner (python -m intel.scan_universe).",
                    "counts": None, "stocks": []}
        if path == "/api/system/overview":
            return {"generated": True, "generated_at": uni.get("generated_at"),
                    "universe_size": uni.get("universe_size"), "source": uni.get("source"),
                    "provider": uni.get("provider"), "counts": uni.get("counts"),
                    "limitations": uni.get("limitations")}
        return uni
    if path == "/api/system/stock":
        sym = (qs.get("symbol") or [""])[0]
        if not sym:
            return {"error": "missing symbol"}
        rec = store.get_stock(sym) if store else None
        return rec or {"symbol": sym, "generated": False,
                       "message": "No data-quality record yet for this stock."}
    # ---- Phase 2: Market Regime Engine (read-only, Phase 3/4 consume these) ----
    if path == "/api/system/regime" or path == "/api/system/regime/overview":
        reg = store.get_regime() if store else None
        if not reg:
            return {"generated": False,
                    "message": "Regime scan not generated yet. Run python -m intel.scan_regime."}
        if path == "/api/system/regime/overview":
            return {"generated": True, "generated_at": reg.get("generated_at"),
                    "methodology_version": reg.get("methodology_version"),
                    "universe_size": reg.get("universe_size"), "evaluated": reg.get("evaluated"),
                    "insufficient_or_uncertain": reg.get("insufficient_or_uncertain"),
                    "swing_tally": reg.get("swing_tally"), "market": reg.get("market"),
                    "sector": reg.get("sector"), "limitations": reg.get("limitations"),
                    "technical_debt": reg.get("technical_debt")}
        # full registry WITHOUT the heavy per-stock map (keep payload small)
        light = {k: v for k, v in reg.items() if k != "stocks"}
        light["generated"] = True
        light["symbols"] = sorted((reg.get("stocks") or {}).keys())
        return light
    if path == "/api/system/regime/stock":
        sym = (qs.get("symbol") or [""])[0]
        if not sym:
            return {"error": "missing symbol"}
        reg = store.get_regime() if store else None
        rec = (reg or {}).get("stocks", {}).get(sym.upper()) if reg else None
        if rec:
            return {"generated": True, "methodology_version": (reg or {}).get("methodology_version"),
                    "market": (reg or {}).get("market"), "stock": rec}
        return {"symbol": sym, "generated": False,
                "message": "No regime record yet for this stock."}
    # ---- Phase 3: Optimisation Engine (read-only; Phase 4 consumes these) ----
    if path == "/api/system/optimize" or path == "/api/system/optimize/overview":
        op = store.get_optimize() if store else None
        if not op:
            return {"generated": False,
                    "message": "Optimisation not generated yet. Run python -m intel.scan_optimize."}
        if path == "/api/system/optimize/overview":
            return {"generated": True, "generated_at": op.get("generated_at"),
                    "methodology_version": op.get("methodology_version"),
                    "universe_size": op.get("universe_size"), "optimized": op.get("optimized"),
                    "insufficient_evidence": op.get("insufficient_evidence"),
                    "counts": op.get("counts"), "config_leaderboard": op.get("config_leaderboard"),
                    "params": op.get("params"), "limitations": op.get("limitations"),
                    "technical_debt": op.get("technical_debt")}
        light = {k: v for k, v in op.items() if k != "stocks"}
        light["generated"] = True
        light["symbols"] = sorted((op.get("stocks") or {}).keys())
        return light
    if path == "/api/system/optimize/stock":
        sym = (qs.get("symbol") or [""])[0]
        if not sym:
            return {"error": "missing symbol"}
        op = store.get_optimize() if store else None
        rec = (op or {}).get("stocks", {}).get(sym.upper()) if op else None
        if rec:
            return {"generated": True, "methodology_version": (op or {}).get("methodology_version"),
                    "params": (op or {}).get("params"), "stock": rec}
        return {"symbol": sym, "generated": False,
                "message": "No optimisation record yet for this stock."}
    return {"error": "unknown system endpoint"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass

    def do_POST(self):
        u = urlparse(self.path)
        # On Vercel the function is reached via a rewrite that carries the real
        # request path in __vpath; locally __vpath is absent and u.path is used.
        u = u._replace(path=(parse_qs(u.query).get("__vpath") or [u.path])[0])
        try:
            if u.path == "/api/holdings":
                n = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(n) or b"{}")
                if isinstance(body.get("holdings"), list):
                    # Stateless: the browser owns the holdings list and sends it to
                    # be valued/scored (works on Vercel and any stateless host).
                    self._send(200, json.dumps(holdings.compute_all(body["holdings"])))
                    return
                # Legacy local-file mode (add/remove against holdings.json).
                act = body.get("action")
                if act == "add" and body.get("ticker"):
                    bp = body.get("buy_price")
                    holdings.add(body["ticker"], float(body.get("qty") or 1),
                                 float(bp) if bp not in (None, "") else None)
                elif act == "remove" and body.get("ticker"):
                    holdings.remove(body["ticker"])
                self._send(200, json.dumps(holdings.compute_all()))
                return
            self._send(404, json.dumps({"error": "not found"}))
        except engine.FeedError as fe:
            self._send(fe.status, json.dumps({"error": fe.code, "message": str(fe)}))
        except Exception as exc:  # noqa: BLE001
            self._send(500, json.dumps({"error": "server_error", "message": str(exc)}))

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        # On Vercel the function is reached via a rewrite that carries the real
        # request path in __vpath; locally __vpath is absent and u.path is used.
        u = u._replace(path=(qs.get("__vpath") or [u.path])[0])
        try:
            if u.path in ("/healthz", "/api/health"):
                self._send(200, json.dumps({"ok": True}))
                return
            if u.path == "/api/stock":
                sym = (qs.get("symbol") or ["RELIANCE.NS"])[0]
                tf = (qs.get("tf") or ["W"])[0].upper()
                if tf not in ("W", "D", "M"):
                    tf = "W"
                d = engine.compute(sym, tf)
                d["quality"] = quality.score(sym)
                f = (quality._load().get("companies") or {}).get(sym.upper())
                d["valuation"] = (valuation.value(f, d["price"]) if f
                                  else {"applicable": False, "note": "No fundamentals on file."})
                self._send(200, json.dumps(d))
                return
            if u.path == "/api/intraday":
                sym = (qs.get("symbol") or ["RELIANCE.NS"])[0]
                iv = (qs.get("interval") or ["15m"])[0]
                if iv not in ("5m", "15m", "30m", "60m"):
                    iv = "15m"
                rng = "5d" if iv in ("5m", "15m") else "1mo"
                self._send(200, json.dumps(_intraday(sym, iv, rng)))
                return
            if u.path == "/api/news":
                sym = (qs.get("symbol") or ["RELIANCE.NS"])[0]
                self._send(200, json.dumps(_news(sym)))
                return
            if u.path == "/api/shortterm":
                self._send(200, json.dumps({"as_of_delayed": True, "results": _shortterm()}))
                return
            if u.path == "/api/intradayscan":
                self._send(200, json.dumps(_intraday_scan()))
                return
            if u.path.startswith("/api/system/"):
                self._send(200, json.dumps(_system_read(u.path, qs)))
                return
            if u.path == "/api/scan":
                syms = [s.strip() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()]
                companies = quality._load().get("companies") or {}
                out = _scan_many([(s, companies.get(s.upper()), None, False) for s in syms])
                self._send(200, json.dumps({"results": out}))
                return
            if u.path == "/api/scanner":
                data = quality._load()
                companies = data.get("companies") or {}
                seen = set(s.upper() for s in companies)
                # Curated names (with fundamentals) first, then the penny extras,
                # then the rest of the known universe — all deduped. Non-curated
                # names are chart-only (quality 'not rated'); they skip quietly if
                # delisted/renamed (the True flag = skip-on-error, not "penny").
                tasks = [(s, f, None, False) for s, f in companies.items()]
                for s, nm in _EXTRA.items():
                    if s.upper() not in seen:
                        tasks.append((s, None, nm, True)); seen.add(s.upper())
                for s, nm in _universe():
                    if s.upper() not in seen:
                        tasks.append((s, None, nm, True)); seen.add(s.upper())
                rows = _scan_many(tasks, workers=16)
                _vr = {"CHEAP": 0, "FAIR": 1, "EXPENSIVE": 2}
                rows.sort(key=lambda x: (x.get("rank", 99), _vr.get(x.get("valuation"), 3), x["symbol"]))
                self._send(200, json.dumps({"as_of": data.get("as_of"), "results": rows}))
                return
            if u.path == "/api/quote":
                syms = [s.strip() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()]
                out = {}
                for s in syms[:50]:
                    try:
                        out[s.upper()] = engine.quote(s)
                    except engine.FeedError as fe:
                        out[s.upper()] = {"error": fe.code}
                    except Exception as exc:  # noqa: BLE001
                        out[s.upper()] = {"error": "server_error", "message": str(exc)}
                self._send(200, json.dumps({"quotes": out}))
                return
            if u.path == "/api/holdings":
                self._send(200, json.dumps(holdings.compute_all()))
                return
            # static files
            rel = u.path.lstrip("/") or "index.html"
            fp = os.path.normpath(os.path.join(WEB, rel))
            if fp.startswith(WEB) and os.path.isfile(fp):
                with open(fp, "rb") as f:
                    self._send(200, f.read(), CTYPES.get(os.path.splitext(fp)[1], "text/plain"))
                return
            self._send(404, json.dumps({"error": "not found"}))
        except engine.FeedError as fe:
            self._send(fe.status, json.dumps({"error": fe.code, "message": str(fe)}))
        except Exception as exc:  # noqa: BLE001
            self._send(500, json.dumps({"error": "server_error", "message": str(exc)}))


if __name__ == "__main__":
    print("Trader Dashboard listening on %s:%d" % (HOST, PORT), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
