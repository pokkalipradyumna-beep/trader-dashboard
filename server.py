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
            if u.path == "/api/scan":
                syms = [s.strip() for s in (qs.get("symbols") or [""])[0].split(",") if s.strip()]
                companies = quality._load().get("companies") or {}
                out = _scan_many([(s, companies.get(s.upper()), None, False) for s in syms])
                self._send(200, json.dumps({"results": out}))
                return
            if u.path == "/api/scanner":
                data = quality._load()
                companies = data.get("companies") or {}
                tasks = [(s, f, None, False) for s, f in companies.items()]
                tasks += [(s, None, nm, True) for s, nm in _EXTRA.items() if s not in companies]
                rows = _scan_many(tasks)
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
