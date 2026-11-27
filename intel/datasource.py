"""Phase 1: pluggable market-data source with full provenance.

`DataSource` is the interface; `YahooSource` is the only implementation now. It
reuses engine.py's READ-ONLY constants (SSL context, UA, URL builder) — it does
NOT modify or call the weekly signal engine. Every fetch returns its provenance
so any number is traceable (requirement 2.2). Missing values are preserved as
None and never invented (requirement 2.2 / fail-closed).
"""
import datetime as _dt
import json
import urllib.error
import urllib.request

import engine  # read-only reuse: _SSL_CTX, UA, _yahoo_url


def _now_iso():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


class DataSource:
    """Interface. Implementations fetch raw series + provenance; they never
    classify quality (that is validate.py) or invent data."""
    name = "base"

    def get_history(self, symbol, interval="1d", rng="2y"):
        raise NotImplementedError


class YahooSource(DataSource):
    name = "yahoo-finance-chart"
    provider_note = ("Yahoo Finance chart API — ~15-min delayed, not licensed for "
                     "redistribution; coverage of NSE is partial and symbol-dependent.")

    def get_history(self, symbol, interval="1d", rng="2y"):
        """Return {ok, error, provenance, meta, bars, has_adjclose, splits,
        dividends}. `close` is UNADJUSTED (Yahoo chart close); `adjclose` is the
        provider's adjusted series when available — its correctness per corporate
        action is NOT assumed and is flagged downstream (requirement 2.3)."""
        src = engine._yahoo_url(symbol, rng, interval)
        src_symbol = src.split("/chart/")[-1].split("?")[0]
        url = src + "&events=div,splits"
        prov = {"provider": self.name, "symbol": symbol, "source_symbol": src_symbol,
                "interval": interval, "range": rng, "retrieved_at": _now_iso(),
                "price_basis": "unadjusted (Yahoo chart close); adjclose supplied separately when available"}
        try:
            req = urllib.request.Request(url, headers={"User-Agent": engine.UA})
            with urllib.request.urlopen(req, timeout=25, context=engine._SSL_CTX) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            code = "not_found" if e.code in (400, 404) else "feed_down"
            return dict(prov, ok=False, error={"code": code, "http": e.code, "message": str(e)})
        except Exception as e:  # noqa: BLE001 — network/TLS/parse: treat as feed down
            return dict(prov, ok=False, error={"code": "feed_down", "message": str(e)[:160]})

        chart = data.get("chart") or {}
        if chart.get("error"):
            err = chart["error"] or {}
            msg = (err.get("description") or err.get("code") or "").lower()
            code = "not_found" if ("not found" in msg or "delisted" in msg or "no data" in msg) else "feed_down"
            return dict(prov, ok=False, error={"code": code, "message": str(chart["error"])[:160]})
        res = chart.get("result") or []
        if not res:
            return dict(prov, ok=False, error={"code": "no_data", "message": "empty result"})
        r = res[0]
        meta = r.get("meta") or {}
        ts = r.get("timestamp") or []
        q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
        adj_list = (r.get("indicators") or {}).get("adjclose") or []
        adjclose = adj_list[0].get("adjclose") if (adj_list and adj_list[0]) else None
        o, h, l, c, v = q.get("open"), q.get("high"), q.get("low"), q.get("close"), q.get("volume")
        bars = []
        for i, t in enumerate(ts):
            bars.append({
                "t": int(t), "date": _dt.datetime.utcfromtimestamp(int(t)).date().isoformat(),
                "open": _g(o, i), "high": _g(h, i), "low": _g(l, i),
                "close": _g(c, i), "adjclose": _g(adjclose, i), "volume": _g(v, i),
            })
        ev = r.get("events") or {}
        splits = [s for s in (ev.get("splits") or {}).values()]
        divs = [d for d in (ev.get("dividends") or {}).values()]
        return dict(prov, ok=True, error=None,
                    meta={"currency": meta.get("currency"),
                          "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
                          "data_ts": meta.get("regularMarketTime"),
                          "timezone": meta.get("timezone"),
                          "instrument": meta.get("instrumentType")},
                    has_adjclose=adjclose is not None, bars=bars, splits=splits, dividends=divs)


def _g(arr, i):
    try:
        return arr[i]
    except (TypeError, IndexError):
        return None
