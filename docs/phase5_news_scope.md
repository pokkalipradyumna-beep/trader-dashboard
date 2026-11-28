# Phase 5 — Company & News Intelligence: Scope Note

**Status:** SCOPE NOTE ONLY — no code written or modified.
**Goal:** add reliable, **facts-only** company intelligence to the TIS, attached to stocks and surfaced through the existing Phase-4 `news_factors` hook, **without** ever silently changing a recommendation.
**Hard rules honoured:** facts only (no LLM / AI summaries / sentiment / prediction); no paid APIs or new infrastructure; the weekly EMA 9/21/50 engine and Phase 1–4 recommendation logic are untouched; source URL + publication time + retrieval time + original headline/fact preserved; verified vs reported vs unavailable kept distinct.

> Grounded in the actual repo: existing `server.py:_news()` (Google News RSS, facts-only, live), Phase 1 `corporate_actions` (Yahoo splits/dividends), the `Store` abstraction, the offline-batch → committed-JSON → read-only-endpoint pattern, and the `news_factors:null` / `last_monitored:null` slots already written into every Phase-4 recommendation record.

---

## 1. Recommended sources & their limitations (tested, not assumed)

I tested each source from this environment (and, for Google News, from the live Vercel deployment). Results:

| Source | Test result | Verdict |
|---|---|---|
| **NSE** `/api/corporate-announcements` | `301`; NSE homepage `403` | **Blocked.** Akamai bot-protection + cookie/session wall + datacenter-IP blocking. **Not** usable for automated/serverless collection. |
| **BSE** `api.bseindia.com/.../AnnGetData` | `403` Access Denied (Akamai) | **Blocked.** Same class of protection. Not usable. |
| **Google News RSS** (`news.google.com/rss/search`) | `200`, 100 items; **200 + 8 items live on Vercel** | **Usable.** Already in production. Returns *reported* headlines (media), **not** official filings. |
| **Yahoo** chart `events=div,splits` | `200` | **Usable.** Structured splits & dividends — **already captured** in Phase 1 `corporate_actions`. |
| Company IR sites / official filing PDFs | behind the same NSE/BSE walls or per-company bespoke | **Not** practical to scrape reliably; out of scope. |

**Consequence (unavoidable, stated honestly):** there is **no freely, reliably accessible source of official structured NSE/BSE announcements** from this architecture. Phase 5 therefore builds on:
1. **Yahoo corporate actions** → *verified-by-provider*, structured facts (splits, dividends only).
2. **Google News RSS** per company → *reported* facts (headline, source, publication date, link) — explicitly labelled "reported," never "verified."
3. **NSE/BSE** → attempted **best-effort only**, expected to fail; results marked **UNAVAILABLE** gracefully, never presented as reliable. (No retries that hammer a blocking host.)

**Terms/limits:** Google News RSS is intended for personal/non-commercial use, is rate-limited, and returns redirect links; collection stays low-volume (offline batch, one query per stock, polite spacing — same as the existing `_news`). Yahoo is unofficial/undocumented and already used read-only. No paid tier, no new infra.

---

## 2. Data fields & storage structure

Reuse the `Store` abstraction (JSON now, DB-ready). One registry + append-only history (mirrors Phase 4):

- `data/news.json` — current intelligence per stock (recent window, deduplicated).
- `data/news_history.jsonl` — **append-only** retained events (never modified).
- `data/news_state.json` — resumable batch progress.

Per event:
```
{ id, symbol, name,
  category,            # §3
  materiality,         # HIGH | MEDIUM | LOW (§4)
  headline,            # ORIGINAL text, unmodified
  source,              # e.g. "Business Standard" / "yahoo-finance"
  origin,              # "google_news" | "yahoo_corporate_action"
  fact_type,           # "verified" (Yahoo structured) | "reported" (news headline) | "unavailable"
  url,                 # source link (preserved)
  published_at,        # publication timestamp (ISO, from source)
  retrieved_at,        # our fetch timestamp (ISO)
  dedup_hash,          # normalized(headline)+source+date
  details }            # structured extras for verified actions: {action, amount, ratio, ex_date}
```
`news.json` top level: `{ generated_at, methodology_version:"news-v1.0", universe_size, counts{by category, by materiality}, source_status{google_news, yahoo, nse, bse}, limitations[], technical_debt[], stocks{SYM:{events[], last_collected_at, stale, source_errors[]}} }`.

---

## 3. Intelligence categories (rule-based tagging of the FACT's topic — not sentiment)

Deterministic classification of each item by (a) Yahoo event type (structured) or (b) keyword/pattern match on the original headline:

| Category | Trigger (examples) |
|---|---|
| `RESULTS` | "results", "Q1/Q2/Q3/Q4", "net profit", "revenue", "earnings" |
| `DIVIDEND` | Yahoo dividend event; "dividend", "interim/final dividend" |
| `BONUS_SPLIT` | Yahoo split event; "bonus", "stock split", "face value" |
| `RIGHTS_BUYBACK` | "rights issue", "buyback", "tender offer" |
| `MA_DEMERGER` | "acquire/acquisition", "merger", "demerger", "stake sale", "takeover" |
| `PROMOTER_PLEDGE` | "pledge", "promoter stake", "encumbered", "shareholding change" |
| `MANAGEMENT` | "resigns", "appoints", "steps down", "CEO/CFO/MD/chairman" |
| `REGULATORY` | "SEBI", "penalty", "fine", "probe", "litigation", "show-cause", "ban", "default", "insolvency/NCLT" |
| `ORDER_BIZ` | "order win", "bags order", "contract", "LOI", "capacity", "plant", "cancellation" |
| `RATING` | "credit rating", "upgrade/downgrade" (rating-agency context) |
| `OTHER` | material exchange items not matching above |
| `MARKET_NOISE` | generic "share price", "target price", "stock to watch" (routine) |

Multiple keywords → highest-materiality category wins. Original headline is always shown so the user sees the raw fact.

---

## 4. Materiality classification (transparent, objective, no price-impact claims)

Materiality = **category of the development**, explicitly **not** a prediction of price movement or direction.

- **HIGH:** `RESULTS`, `MA_DEMERGER`, `RIGHTS_BUYBACK`, `PROMOTER_PLEDGE` (increase), `MANAGEMENT` (CEO/CFO/MD/chairman exit), `REGULATORY` (penalty/action/litigation/default/insolvency), `ORDER_BIZ` (large win/cancellation), `RATING` (downgrade).
- **MEDIUM:** `DIVIDEND`, `BONUS_SPLIT`, board-meeting notices, moderate `ORDER_BIZ`, non-promoter shareholding changes, `RATING` (affirmations/upgrades).
- **LOW:** `MARKET_NOISE`, investor presentations, conference/earnings-call schedules, routine informational updates.

Each item records **why** it was classified (the matched rule/keyword and category), e.g. *"HIGH — REGULATORY (matched 'SEBI','penalty')."* Examples:
- "XYZ Q2 net profit rises 18%" → `RESULTS`, **HIGH**.
- "XYZ declares ₹5 interim dividend" → `DIVIDEND`, **MEDIUM**.
- "XYZ CFO resigns" → `MANAGEMENT`, **HIGH**.
- "XYZ share price target raised by brokerage" → `MARKET_NOISE`, **LOW**.

No item asserts a resulting price move.

---

## 5. Stock-matching & deduplication

- **Matching:** reuse `_news_company(symbol)` (curated name from `fundamentals.json`/`symbols.json`) to query Google News with `"<Company>" ...`; Yahoo actions are symbol-native. Store under the exact locked symbol. Ambiguous/common names → conservative quoting (already done) + keep the source link for the user to verify. No cross-stock inference.
- **Deduplication:** `dedup_hash = sha1(normalize(headline) + source + published_date)`; identical items across runs collapse to one (first `retrieved_at` kept). Near-duplicate headlines from different outlets are kept separately (different source) but grouped by category in the UI.
- **Retention:** `news.json` keeps a recent window per stock (e.g. last ~20 items / 180 days); everything is also appended to `news_history.jsonl` for permanent, immutable retention.

---

## 6. Phase 4 integration behaviour (via the existing `news_factors` hook)

- The Phase-4 recommendation **label never changes** because of news. Phase 5 only **fills the `news_factors` slot** already present in each style record and adds **transparent context/warnings**.
- Proposed `news_factors` shape (filled at serve-time or in the recommend batch — **no change to decision logic**):
  ```
  news_factors: { as_of, high_count, medium_count,
                  recent_material: [ {category, materiality, headline, source, fact_type, published_at, url, why} ],
                  stale, source_status }
  ```
- UI: on a recommendation card, a HIGH-materiality item renders a **warning banner** — e.g. *"⚠ Material development (REGULATORY, reported by <source>, <date>): '<headline>' — review before acting."* It is **context only**; the badge (STRONG BUY/BUY/HOLD/WAIT/SELL/INSUFFICIENT) is unchanged, and the existing recommendation **history and provenance are untouched** (news is a separate store with its own provenance).
- Fact-type honesty carries through: a Google-News item is shown as **"reported"**, a Yahoo action as **"verified (provider)"**, and a blocked source as **"unavailable."** Nothing Yahoo/Google-sourced is ever called independently verified.

---

## 7. Technical design (smallest practical, architecture-compatible)

- `intel/news_rules.py` — pure, deterministic category + materiality rules (unit-testable; no network).
- `intel/scan_news.py` — offline batch over the 201 universe: Google News RSS (reuse `_news` parsing) + Yahoo corporate actions; classify, dedup, write `news.json` + append `news_history.jsonl`; resumable, rate-limited, fail-closed; records per-source `source_status` and `stale` flags.
- `store.py` — add `get/put_news`, `get/put_news_state`, `append_news_history`, `read_news_history` (mirror the Phase-4 additions).
- `server.py` (additive) — `GET /api/system/news/overview`, `GET /api/system/news/stock?symbol=`; and fill `news_factors` into the recommendation read (serve-time merge of `news.json`, so no re-batch coupling).
- `public/*` (additive) — a "Company intelligence" subsection on the stock page (categorised facts, materiality badges, source + timestamps, verified/reported/unavailable labels) and the recommendation-card warning banner; **manual indicator settings still never affect anything**.
- **Phase 6 ready:** the offline batch is schedulable as-is; append-only history + `last_collected_at`/`stale` support a background EOD refresh with no redesign.
- `vercel.json` already bundles `data/*.json` and `data/*.jsonl` (fixed in Phase 4), so `news.json`/`news_history.jsonl` will deploy.

---

## 8. Testing & data-quality requirements

- **Unit (no network):** classification + materiality rules (each category's trigger → expected label; ambiguous headline → conservative pick); dedup hash stability; verified/reported/unavailable labelling.
- **Collection:** source failure → `UNAVAILABLE` + `source_status` recorded, never a crash; stale flag when `last_collected_at` older than threshold.
- **Integration:** `news_factors` fills without altering any recommendation label; recommendation history/provenance byte-stable before/after a news run.
- **Regression:** weekly engine + Phases 1–4 outputs unchanged; existing `/api/news` behaviour preserved.
- **Immutability:** `news_history.jsonl` append-only; reruns add no duplicates.
- **UI:** categories/materiality/sources/timestamps render; verified vs reported vs unavailable visibly distinct; 0 console errors; no mobile overflow.

---

## 9. Implementation steps & estimated complexity

1. `intel/news_rules.py` — **LOW** (pure rules + tests).
2. `intel/scan_news.py` + `store.py` methods — **MEDIUM** (reuses `_news` + Yahoo + Store; dedup; fail-closed).
3. Serve-time `news_factors` merge + read-only endpoints — **LOW–MEDIUM**.
4. UI (intelligence subsection + rec warning banner) — **MEDIUM**.
5. Batch run on 201 + verification + deploy — **LOW**.

Overall **LOW–MEDIUM**. No new infrastructure, no paid services, no LLM.

---

## 10. Known limitations & unresolved decisions

**Limitations (honest):**
- **No official structured NSE/BSE filings** (both APIs blocked). Material events (M&A, pledges, regulatory, management) arrive only as **reported** news headlines, not verified filings — labelled accordingly.
- Keyword classification can mis-tag ambiguous headlines; mitigated by conservative rules + always showing the original headline; **no sentiment** is inferred.
- Google News RSS: non-commercial/rate-limited, redirect links, coverage varies by company; Yahoo is unofficial.
- Dedup across outlets is imperfect (same story, different wording/source).

**Decisions needing your approval:**
1. **Accept the sources?** Given NSE/BSE are blocked, proceed with **Yahoo (verified actions) + Google News (reported headlines)** as the facts-only sources, with everything clearly labelled — yes/no?
2. **NSE/BSE best-effort or skip?** Attempt them (expected to fail, marked UNAVAILABLE) or omit entirely to avoid pointless requests?
3. **Materiality thresholds** — accept the HIGH/MEDIUM/LOW rule set in §4, or adjust any category?
4. **Where warnings appear** — on the recommendation card (proposed) and/or a standalone "Company intelligence" section?
5. **Retention window & cadence** — recent window size (proposed ~20 items / 180 days) and collection frequency (manual now; scheduled in Phase 6)?

*No code will be written until you review and approve this scope.*
