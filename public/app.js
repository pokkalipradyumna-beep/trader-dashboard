/* Trader - R-1 (3-page app: Home / Search / Dashboard) */
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const CAT_BADGE = { "STRONG BUY": "STRONG", "BUY": "BUY", "CHART-ONLY": "warn",
  "HOLD": "HOLD", "WAIT": "WAIT", "SELL": "SELL", "ERROR": "ERROR" };

/* ---------- settings + watchlist (R-7, localStorage) ---------- */
function getSettings() {
  try { return Object.assign({ defaultTf: "W", autoScan: true }, JSON.parse(localStorage.getItem("settings") || "{}")); }
  catch (e) { return { defaultTf: "W", autoScan: true }; }
}
function saveSettings(s) { try { localStorage.setItem("settings", JSON.stringify(s)); } catch (e) {} }
function getWatch() { try { return JSON.parse(localStorage.getItem("watch") || "[]"); } catch (e) { return []; } }
function saveWatch(a) { try { localStorage.setItem("watch", JSON.stringify(a)); } catch (e) {} }
function isWatched(t) { return getWatch().some((w) => w.t === t); }
function toggleWatch(t, n) {
  let a = getWatch();
  if (a.some((w) => w.t === t)) a = a.filter((w) => w.t !== t);
  else a.push({ t: t, n: n || t });
  saveWatch(a);
  return isWatched(t);
}

/* ---------- loading helpers (A1) ---------- */
function skelCards(n) {
  const one = `<div class="skcard">
    <div class="skrow"><div style="flex:1"><div class="skel l sk-w55"></div><div class="skel s sk-w30" style="margin-top:8px"></div></div><div class="skel skbadge"></div></div>
    <div class="skrow" style="margin-top:14px;justify-content:flex-start;gap:6px"><div class="skel skpill"></div><div class="skel skpill"></div></div>
    <div class="skel m sk-w70" style="margin-top:14px"></div>
    <div class="skel m sk-w40" style="margin-top:7px"></div></div>`;
  return one.repeat(n);
}
function skelWatch(n) {
  const one = `<div class="skwcard"><div style="flex:1"><div class="skel m sk-w55"></div><div class="skel s sk-w20" style="margin-top:7px"></div></div><div class="skel skbadge"></div></div>`;
  return one.repeat(n);
}
async function withBtnLoading(btn, label, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML, dis = btn.disabled;
  btn.disabled = true; btn.classList.add("loading");
  btn.innerHTML = '<span class="spinner"></span> ' + (label || "");
  try { return await fn(); }
  finally { btn.innerHTML = html; btn.disabled = dis; btn.classList.remove("loading"); }
}
function stateBox(o) {
  return `<div class="statebox"><div class="sb-ic">${o.icon}</div>
    <div class="sb-t">${o.title}</div><div class="sb-m">${o.msg}</div>
    ${o.retry ? '<button class="btn sm sb-retry">↻ Retry</button>' : (o.cta || "")}</div>`;
}
function renderState(el, o, retryFn) {
  el.innerHTML = stateBox(o);
  const rb = el.querySelector(".sb-retry");
  if (rb && retryFn) rb.addEventListener("click", retryFn);
}

/* ---------- routing ---------- */
let chart, candle, vol, l9, l21, l50, markersPrim, chartReady = false;
let currentSym = null, currentTf = getSettings().defaultTf, lastCandle = null, emaAt = {}, lastStockData = null;
const lastv = (a) => (a && a.length ? a[a.length - 1].value : null);
const PAGE_TITLES = { home: "Markets", dashboard: "Portfolio", search: "Search", watchlist: "Watchlist", screeners: "Screener", alerts: "Alerts", reports: "Reports", journal: "Journal", compare: "Compare", settings: "Settings" };
function showPage(name) {
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name));
  document.querySelectorAll(".navlink,.side-link").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  document.title = (name === "search" && currentSym) ? currentSym.replace(".NS", "") + " · Trader"
    : (PAGE_TITLES[name] ? PAGE_TITLES[name] + " · Trader" : "Trader");
  if (name === "search" && !chartReady) initChart();
  if (name === "home") loadHome();
  if (name === "dashboard") loadHoldings();
  if (name === "watchlist") loadWatchlist();
  if (name === "screeners") loadScreeners();
  if (name === "alerts") loadAlerts();
  if (name === "reports") loadReports();
  if (name === "journal") loadJournal();
  if (name === "compare") loadCompare();
  if (name === "settings") renderSettingsPage();
  if (name === "search" && chartReady && chart) setTimeout(fitChart, 30);
}
document.querySelectorAll(".navlink,.side-link").forEach((b) =>
  b.addEventListener("click", () => showPage(b.dataset.page)));

/* ---------- chart + configurable EMAs (R-4) ---------- */
const EMA_COLORS = ["#eab308", "#3b82f6", "#f97316"];
let currentCandles = [];
let emaConfig = (() => {
  try { const s = localStorage.getItem("emaCfg"); if (s) return JSON.parse(s); } catch (e) {}
  return [{ on: true, period: 9 }, { on: true, period: 21 }, { on: true, period: 50 }];
})();
function saveEmaCfg() { try { localStorage.setItem("emaCfg", JSON.stringify(emaConfig)); } catch (e) {} }
// RSI indicator (B2) — opt-in, lives in its own sub-pane
const RSI_COLOR = "#a78bfa";
let rsiSeries = null, rsiAt = null;
let rsiCfg = (() => {
  try { const s = localStorage.getItem("rsiCfg"); if (s) return JSON.parse(s); } catch (e) {}
  return { on: false, period: 14 };
})();
function saveRsiCfg() { try { localStorage.setItem("rsiCfg", JSON.stringify(rsiCfg)); } catch (e) {} }
function rsiState(v) {
  if (v == null) return null;
  return { value: v, state: v >= 70 ? "overbought" : v <= 30 ? "oversold" : "" };
}
// MACD indicator (B3)
const MACD_COLORS = { macd: "#3b82f6", signal: "#f97316", up: "rgba(21,184,112,.55)", down: "rgba(240,68,68,.55)" };
let macdLine = null, macdSignal = null, macdHist = null, macdPane = null, macdAt = null;
let rsiPane = null;
let macdCfg = (() => {
  try { const s = localStorage.getItem("macdCfg"); if (s) return JSON.parse(s); } catch (e) {}
  return { on: false, fast: 12, slow: 26, signal: 9 };
})();
function saveMacdCfg() { try { localStorage.setItem("macdCfg", JSON.stringify(macdCfg)); } catch (e) {} }
function restretch() { if (chart) chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1)); }
// Bollinger Bands + Supertrend (B4) — price-pane overlays
let bbSeries = null, stSeries = null;
let bbCfg = (() => { try { const s = localStorage.getItem("bbCfg"); if (s) return JSON.parse(s); } catch (e) {} return { on: false, period: 20, mult: 2 }; })();
let stCfg = (() => { try { const s = localStorage.getItem("stCfg"); if (s) return JSON.parse(s); } catch (e) {} return { on: false, period: 10, mult: 3 }; })();
function saveBbCfg() { try { localStorage.setItem("bbCfg", JSON.stringify(bbCfg)); } catch (e) {} }
function saveStCfg() { try { localStorage.setItem("stCfg", JSON.stringify(stCfg)); } catch (e) {} }

/* ===================== Indicator profiles (Phase 1) =====================
   A registry + per-trading-style profile system layered ON TOP of the live
   cfg vars above (emaConfig/rsiCfg/macdCfg/bbCfg/stCfg + volume). Those stay
   the single source the chart reads, so every existing apply/legend/detail
   reader keeps working. Profiles just swap values into them and re-apply.
   NOTHING here touches the weekly engine or the BUY/SELL signals — these are
   chart overlays + display only. */
let volCfg = { on: true };
function applyVolume() { if (vol) { try { vol.applyOptions({ visible: !!volCfg.on }); } catch (e) {} } }
// Phase 2 indicator configs + series/pane refs (overlays on pane 0; ADX/ATR get sub-panes)
let smaCfg = { on: false, period: 50 }, donCfg = { on: false, period: 20 },
  ichiCfg = { on: false, conv: 9, base: 26, span: 52 }, kelCfg = { on: false, period: 20, mult: 2 },
  adxCfg = { on: false, period: 14 }, atrCfg = { on: false, period: 14 };
let smaSeries = null, donSeries = null, ichiSeries = null, kelSeries = null,
  adxSeries = null, adxPane = null, atrSeries = null, atrPane = null;
// Phase 3 configs + refs (Momentum: Stoch RSI, CCI; Volume: OBV, VWAP, Anchored VWAP, Volume Profile)
let stochCfg = { on: false, period: 14, smooth: 3 }, cciCfg = { on: false, period: 20 }, obvCfg = { on: false },
  vwapCfg = { on: false }, avwapCfg = { on: false, back: 60 }, vpCfg = { on: false, period: 120, bins: 24 };
let stochSeries = null, stochPane = null, cciSeries = null, cciPane = null, obvSeries = null, obvPane = null,
  vwapSeries = null, avwapSeries = null, vpLines = [];
// Phase 4 configs + refs (Support/Resistance price-line overlays)
let pivotCfg = { on: false }, fibCfg = { on: false, period: 120 }, srCfg = { on: false, period: 120, strength: 3 };
let pivotLines = [], fibLines = [], srLines = [];
let taCfg = (() => { try { const s = localStorage.getItem("taCfg"); if (s) return JSON.parse(s); } catch (e) {} return { on: false }; })();
function saveTaCfg() { try { localStorage.setItem("taCfg", JSON.stringify(taCfg)); } catch (e) {} }

// Registry: drives the settings panel + documents category/placement/params.
const IND_REGISTRY = [
  { id: "ema", cat: "Trend", place: "overlay", kind: "ema" },
  { id: "st", cat: "Trend", place: "overlay", label: "Supertrend", swatch: "linear-gradient(90deg,#15b870,#f04444)",
    params: [{ k: "period", lbl: "len", min: 2, max: 100 }, { k: "mult", lbl: "×", min: 1, max: 10, float: true }] },
  { id: "rsi", cat: "Momentum", place: "panel", label: "RSI", swatch: RSI_COLOR,
    params: [{ k: "period", lbl: "len", min: 2, max: 100 }] },
  { id: "macd", cat: "Momentum", place: "panel", label: "MACD", swatch: MACD_COLORS.macd,
    params: [{ k: "fast", lbl: "fast", min: 2, max: 100 }, { k: "slow", lbl: "slow", min: 3, max: 200 }, { k: "signal", lbl: "sig", min: 1, max: 100 }] },
  { id: "bb", cat: "Volatility", place: "overlay", label: "Bollinger", swatch: "#94a3b8",
    params: [{ k: "period", lbl: "len", min: 2, max: 100 }, { k: "mult", lbl: "×", min: 0.5, max: 6, float: true }] },
  { id: "volume", cat: "Volume", place: "panel", label: "Volume", swatch: "#64748b", params: [] },
  { id: "sma", cat: "Trend", place: "overlay", label: "SMA", swatch: "#cbd5e1", params: [{ k: "period", lbl: "len", min: 2, max: 400 }] },
  { id: "don", cat: "Trend", place: "overlay", label: "Donchian", swatch: "#22d3ee", params: [{ k: "period", lbl: "len", min: 2, max: 200 }] },
  { id: "ichi", cat: "Trend", place: "overlay", label: "Ichimoku", swatch: "#3b82f6", params: [{ k: "conv", lbl: "conv", min: 2, max: 60 }, { k: "base", lbl: "base", min: 2, max: 120 }, { k: "span", lbl: "span", min: 2, max: 240 }] },
  { id: "adx", cat: "Trend", place: "panel", label: "ADX", swatch: "#eab308", params: [{ k: "period", lbl: "len", min: 2, max: 100 }] },
  { id: "kel", cat: "Volatility", place: "overlay", label: "Keltner", swatch: "#f472b6", params: [{ k: "period", lbl: "len", min: 2, max: 100 }, { k: "mult", lbl: "×", min: 0.5, max: 6, float: true }] },
  { id: "atr", cat: "Volatility", place: "panel", label: "ATR", swatch: "#f59e0b", params: [{ k: "period", lbl: "len", min: 2, max: 100 }] },
  { id: "stoch", cat: "Momentum", place: "panel", label: "Stoch RSI", swatch: "#c084fc", params: [{ k: "period", lbl: "len", min: 2, max: 100 }, { k: "smooth", lbl: "K/D", min: 1, max: 20 }] },
  { id: "cci", cat: "Momentum", place: "panel", label: "CCI", swatch: "#f59e0b", params: [{ k: "period", lbl: "len", min: 2, max: 100 }] },
  { id: "obv", cat: "Volume", place: "panel", label: "OBV", swatch: "#38bdf8", params: [] },
  { id: "vwap", cat: "Volume", place: "overlay", label: "VWAP", swatch: "#facc15", params: [], note: "Cumulative VWAP from the start of the loaded data. True session VWAP is intraday-only (needs real-time data this app doesn't have)." },
  { id: "avwap", cat: "Volume", place: "overlay", label: "Anchored VWAP", swatch: "#fb923c", params: [{ k: "back", lbl: "bars", min: 5, max: 500 }], note: "Cumulative VWAP anchored N bars back." },
  { id: "vprofile", cat: "Volume", place: "overlay", label: "Volume Profile", swatch: "#94a3b8", params: [{ k: "period", lbl: "look", min: 20, max: 500 }, { k: "bins", lbl: "bins", min: 6, max: 60 }], note: "Approximate — POC + value area (VAH/VAL) from candle volume, not tick data." },
  { id: "pivot", cat: "Support/Resistance", place: "overlay", label: "Pivot Points", swatch: "#e2e8f0", params: [], note: "Classic floor pivots (P + R1–R3 / S1–S3) from the previous period's range." },
  { id: "fib", cat: "Support/Resistance", place: "overlay", label: "Fibonacci", swatch: "#eab358", params: [{ k: "period", lbl: "look", min: 20, max: 500 }], note: "Retracement levels between the swing high and low over the lookback." },
  { id: "sr", cat: "Support/Resistance", place: "overlay", label: "Auto S/R zones", swatch: "#94a3b8", params: [{ k: "period", lbl: "look", min: 20, max: 500 }, { k: "strength", lbl: "str", min: 1, max: 10 }], note: "Automatic support/resistance from recent swing highs & lows." },
];
const IND_CATS = ["Trend", "Momentum", "Volatility", "Volume", "Support/Resistance"];
// Live-cfg accessors (getters, because profile-switch REASSIGNS these vars).
const LIVECFG = { ema: () => emaConfig, st: () => stCfg, rsi: () => rsiCfg, macd: () => macdCfg, bb: () => bbCfg, volume: () => volCfg,
  sma: () => smaCfg, don: () => donCfg, ichi: () => ichiCfg, kel: () => kelCfg, adx: () => adxCfg, atr: () => atrCfg,
  stoch: () => stochCfg, cci: () => cciCfg, obv: () => obvCfg, vwap: () => vwapCfg, avwap: () => avwapCfg, vprofile: () => vpCfg,
  pivot: () => pivotCfg, fib: () => fibCfg, sr: () => srCfg };
const SAVECFG = { ema: saveEmaCfg, st: saveStCfg, rsi: saveRsiCfg, macd: saveMacdCfg, bb: saveBbCfg, volume: () => {},
  sma: () => {}, don: () => {}, ichi: () => {}, kel: () => {}, adx: () => {}, atr: () => {},
  stoch: () => {}, cci: () => {}, obv: () => {}, vwap: () => {}, avwap: () => {}, vprofile: () => {},
  pivot: () => {}, fib: () => {}, sr: () => {} };
const APPLYCFG = { ema: () => applyEMAs(), st: () => applySupertrend(), rsi: () => applyRSI(), macd: () => applyMACD(), bb: () => applyBollinger(), volume: () => applyVolume(),
  sma: () => applySMA(), don: () => applyDonchian(), ichi: () => applyIchimoku(), kel: () => applyKeltner(), adx: () => applyADX(), atr: () => applyATR(),
  stoch: () => applyStochRSI(), cci: () => applyCCI(), obv: () => applyOBV(), vwap: () => applyVWAP(), avwap: () => applyAnchoredVWAP(), vprofile: () => applyVolumeProfile(),
  pivot: () => applyPivots(), fib: () => applyFib(), sr: () => applyAutoSR() };
const _clone = (o) => JSON.parse(JSON.stringify(o));

// Built-in style profiles. EMA display periods differ per style, but the SIGNAL
// is always the server-side weekly 9/21·21/50 — unaffected by what's displayed.
const IND_BUILTINS = {
  intraday: { name: "Intraday", cfg: { ema: [{ on: true, period: 9 }, { on: true, period: 21 }, { on: false, period: 50 }], rsi: { on: true, period: 14 }, macd: { on: true, fast: 12, slow: 26, signal: 9 }, bb: { on: false, period: 20, mult: 2 }, st: { on: true, period: 10, mult: 3 }, volume: { on: true }, sma: { on: false, period: 50 }, don: { on: false, period: 20 }, ichi: { on: false, conv: 9, base: 26, span: 52 }, kel: { on: false, period: 20, mult: 2 }, adx: { on: false, period: 14 }, atr: { on: false, period: 14 }, stoch: { on: false, period: 14, smooth: 3 }, cci: { on: false, period: 20 }, obv: { on: false }, vwap: { on: false }, avwap: { on: false, back: 60 }, vprofile: { on: false, period: 120, bins: 24 }, pivot: { on: false }, fib: { on: false, period: 120 }, sr: { on: false, period: 120, strength: 3 } } },
  short: { name: "Short-term", cfg: { ema: [{ on: true, period: 9 }, { on: true, period: 21 }, { on: true, period: 50 }], rsi: { on: true, period: 14 }, macd: { on: true, fast: 12, slow: 26, signal: 9 }, bb: { on: false, period: 20, mult: 2 }, st: { on: false, period: 10, mult: 3 }, volume: { on: true }, sma: { on: false, period: 50 }, don: { on: false, period: 20 }, ichi: { on: false, conv: 9, base: 26, span: 52 }, kel: { on: false, period: 20, mult: 2 }, adx: { on: false, period: 14 }, atr: { on: false, period: 14 }, stoch: { on: false, period: 14, smooth: 3 }, cci: { on: false, period: 20 }, obv: { on: false }, vwap: { on: false }, avwap: { on: false, back: 60 }, vprofile: { on: false, period: 120, bins: 24 }, pivot: { on: false }, fib: { on: false, period: 120 }, sr: { on: false, period: 120, strength: 3 } } },
  swing: { name: "Swing trading", cfg: { ema: [{ on: true, period: 9 }, { on: true, period: 21 }, { on: true, period: 50 }], rsi: { on: true, period: 14 }, macd: { on: true, fast: 12, slow: 26, signal: 9 }, bb: { on: true, period: 20, mult: 2 }, st: { on: true, period: 10, mult: 3 }, volume: { on: true }, sma: { on: false, period: 50 }, don: { on: false, period: 20 }, ichi: { on: false, conv: 9, base: 26, span: 52 }, kel: { on: false, period: 20, mult: 2 }, adx: { on: false, period: 14 }, atr: { on: false, period: 14 }, stoch: { on: false, period: 14, smooth: 3 }, cci: { on: false, period: 20 }, obv: { on: false }, vwap: { on: false }, avwap: { on: false, back: 60 }, vprofile: { on: false, period: 120, bins: 24 }, pivot: { on: false }, fib: { on: false, period: 120 }, sr: { on: false, period: 120, strength: 3 } } },
  long: { name: "Long-term", cfg: { ema: [{ on: true, period: 50 }, { on: true, period: 100 }, { on: true, period: 200 }], rsi: { on: false, period: 14 }, macd: { on: false, fast: 12, slow: 26, signal: 9 }, bb: { on: false, period: 20, mult: 2 }, st: { on: false, period: 10, mult: 3 }, volume: { on: true }, sma: { on: false, period: 50 }, don: { on: false, period: 20 }, ichi: { on: false, conv: 9, base: 26, span: 52 }, kel: { on: false, period: 20, mult: 2 }, adx: { on: false, period: 14 }, atr: { on: false, period: 14 }, stoch: { on: false, period: 14, smooth: 3 }, cci: { on: false, period: 20 }, obv: { on: false }, vwap: { on: false }, avwap: { on: false, back: 60 }, vprofile: { on: false, period: 120, bins: 24 }, pivot: { on: false }, fib: { on: false, period: 120 }, sr: { on: false, period: 120, strength: 3 } } },
};
const IND_BUILTIN_IDS = ["intraday", "short", "swing", "long"];

function _cfgFromLive() {
  return { ema: emaConfig.map((e) => ({ on: !!e.on, period: e.period })),
    rsi: _clone(rsiCfg), macd: _clone(macdCfg), bb: _clone(bbCfg), st: _clone(stCfg), volume: _clone(volCfg),
    sma: _clone(smaCfg), don: _clone(donCfg), ichi: _clone(ichiCfg), kel: _clone(kelCfg), adx: _clone(adxCfg), atr: _clone(atrCfg),
    stoch: _clone(stochCfg), cci: _clone(cciCfg), obv: _clone(obvCfg), vwap: _clone(vwapCfg), avwap: _clone(avwapCfg), vprofile: _clone(vpCfg),
    pivot: _clone(pivotCfg), fib: _clone(fibCfg), sr: _clone(srCfg) };
}
function _mergeCfg(cfg) {
  const base = _clone(IND_BUILTINS.short.cfg);
  if (!cfg) return base;
  const out = _clone(base);
  if (Array.isArray(cfg.ema)) out.ema = cfg.ema.slice(0, 3).map((e, i) => ({ on: !!(e && e.on), period: (e && e.period) || base.ema[i].period }));
  ["rsi", "macd", "bb", "st", "volume", "sma", "don", "ichi", "kel", "adx", "atr", "stoch", "cci", "obv", "vwap", "avwap", "vprofile", "pivot", "fib", "sr"].forEach((k) => { if (cfg[k]) out[k] = Object.assign({}, base[k], cfg[k]); });
  return out;
}
function _liveFromCfg(cfg) {
  const c = _mergeCfg(cfg);
  emaConfig = c.ema.map((e) => ({ on: !!e.on, period: e.period }));
  rsiCfg = _clone(c.rsi); macdCfg = _clone(c.macd); bbCfg = _clone(c.bb); stCfg = _clone(c.st); volCfg = _clone(c.volume);
  smaCfg = _clone(c.sma); donCfg = _clone(c.don); ichiCfg = _clone(c.ichi); kelCfg = _clone(c.kel); adxCfg = _clone(c.adx); atrCfg = _clone(c.atr);
  stochCfg = _clone(c.stoch); cciCfg = _clone(c.cci); obvCfg = _clone(c.obv); vwapCfg = _clone(c.vwap); avwapCfg = _clone(c.avwap); vpCfg = _clone(c.vprofile);
  pivotCfg = _clone(c.pivot); fibCfg = _clone(c.fib); srCfg = _clone(c.sr);
  saveEmaCfg(); saveRsiCfg(); saveMacdCfg(); saveBbCfg(); saveStCfg(); // keep legacy keys synced for other readers
}
function _applyActiveToChart() {
  if (!chart || !chartReady) return;
  applyEMAs(); applyRSI(); applyMACD(); applyBollinger(); applySupertrend(); applyVolume();
  applySMA(); applyDonchian(); applyIchimoku(); applyKeltner(); applyADX(); applyATR();
  applyStochRSI(); applyCCI(); applyOBV(); applyVWAP(); applyAnchoredVWAP(); applyVolumeProfile();
  applyPivots(); applyFib(); applyAutoSR(); renderTASummary();
  setTimeout(fitChart, 40);
}

let INDSTORE = (() => {
  // Load saved profiles, or MIGRATE: build the 4 built-ins + a "My setup"
  // profile seeded from the user's CURRENT live settings (lossless) and make
  // it active, so nothing they've configured changes after this update.
  try {
    const s = localStorage.getItem("indProfiles");
    if (s) { const p = JSON.parse(s); if (p && p.profiles && p.active && p.order) return p; }
  } catch (e) {}
  const profiles = {};
  IND_BUILTIN_IDS.forEach((id) => { profiles[id] = { name: IND_BUILTINS[id].name, builtin: true, cfg: _clone(IND_BUILTINS[id].cfg) }; });
  profiles.mysetup = { name: "My setup", builtin: false, cfg: _cfgFromLive() };
  return { active: "mysetup", order: IND_BUILTIN_IDS.concat(["mysetup"]), profiles };
})();
function saveIndStore() { try { localStorage.setItem("indProfiles", JSON.stringify(INDSTORE)); } catch (e) {} }
function _activeProfile() { return INDSTORE.profiles[INDSTORE.active] || INDSTORE.profiles[INDSTORE.order[0]]; }
function _getActiveCfg() { const p = _activeProfile(); return _mergeCfg(p && p.cfg); }
function _syncActiveFromLive() { const p = _activeProfile(); if (p) { p.cfg = _cfgFromLive(); saveIndStore(); } }

// At boot: make the live cfg vars reflect the active profile (restores the
// selected profile across refreshes). No chart needed yet — renderChart applies.
_liveFromCfg(_getActiveCfg());
saveIndStore(); // persist the migrated/loaded store immediately (so it survives even if the panel is never opened)
function applyBollinger() {
  const LC = LightweightCharts;
  if (bbCfg.on && chart) {
    if (!bbSeries) {
      const mk = (c, dash) => chart.addSeries(LC.LineSeries, { color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: dash ? LC.LineStyle.Dashed : LC.LineStyle.Solid, crosshairMarkerVisible: false }, 0);
      bbSeries = { up: mk("#64748b", true), mid: mk("#94a3b8", false), lo: mk("#64748b", true) };
    }
    const b = computeBollinger(currentCandles.map((c) => c.close), bbCfg.period, bbCfg.mult);
    const set = (s, arr) => s.setData(currentCandles.map((c, j) => (arr[j] != null ? { time: c.time, value: Math.round(arr[j] * 100) / 100 } : null)).filter(Boolean));
    set(bbSeries.up, b.up); set(bbSeries.mid, b.mid); set(bbSeries.lo, b.lo);
  } else if (bbSeries) {
    Object.values(bbSeries).forEach((s) => { try { chart.removeSeries(s); } catch (e) {} });
    bbSeries = null;
  }
}
function applySupertrend() {
  const LC = LightweightCharts;
  if (stCfg.on && chart) {
    if (!stSeries) {
      stSeries = {
        up: chart.addSeries(LC.LineSeries, { color: "#15b870", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, 0),
        dn: chart.addSeries(LC.LineSeries, { color: "#f04444", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, 0),
      };
    }
    const { st, dir } = computeSupertrend(currentCandles, stCfg.period, stCfg.mult);
    const upD = [], dnD = [];
    currentCandles.forEach((c, j) => {
      if (st[j] == null) { upD.push({ time: c.time }); dnD.push({ time: c.time }); return; }
      const pt = { time: c.time, value: Math.round(st[j] * 100) / 100 };
      if (dir[j] === 1) { upD.push(pt); dnD.push({ time: c.time }); }
      else { dnD.push(pt); upD.push({ time: c.time }); }
    });
    stSeries.up.setData(upD); stSeries.dn.setData(dnD);
  } else if (stSeries) {
    try { chart.removeSeries(stSeries.up); chart.removeSeries(stSeries.dn); } catch (e) {}
    stSeries = null;
  }
}
/* ---- Phase 2 draw functions (overlays on pane 0; ADX/ATR in sub-panes) ---- */
const _ovLine = (col, dash, w) => chart.addSeries(LightweightCharts.LineSeries, { color: col, lineWidth: w || 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, lineStyle: dash ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid }, 0);
const _setLine = (s, arr) => s.setData(currentCandles.map((c, j) => (arr[j] != null ? { time: c.time, value: Math.round(arr[j] * 100) / 100 } : null)).filter(Boolean));
function applySMA() {
  if (smaCfg.on && chart) {
    if (!smaSeries) smaSeries = _ovLine("#cbd5e1", false, 2);
    _setLine(smaSeries, computeSMA(currentCandles.map((c) => c.close), smaCfg.period));
  } else if (smaSeries) { try { chart.removeSeries(smaSeries); } catch (e) {} smaSeries = null; }
}
function applyDonchian() {
  if (donCfg.on && chart) {
    if (!donSeries) { donSeries = { up: _ovLine("#22d3ee", false), mid: _ovLine("#0891b2", true), lo: _ovLine("#22d3ee", false) }; }
    const d = computeDonchian(currentCandles, donCfg.period);
    _setLine(donSeries.up, d.up); _setLine(donSeries.mid, d.mid); _setLine(donSeries.lo, d.lo);
  } else if (donSeries) { Object.values(donSeries).forEach((s) => { try { chart.removeSeries(s); } catch (e) {} }); donSeries = null; }
}
function applyKeltner() {
  if (kelCfg.on && chart) {
    if (!kelSeries) { kelSeries = { up: _ovLine("#f472b6", true), mid: _ovLine("#f472b6", false), lo: _ovLine("#f472b6", true) }; }
    const k = computeKeltner(currentCandles, kelCfg.period, kelCfg.mult);
    _setLine(kelSeries.up, k.up); _setLine(kelSeries.mid, k.mid); _setLine(kelSeries.lo, k.lo);
  } else if (kelSeries) { Object.values(kelSeries).forEach((s) => { try { chart.removeSeries(s); } catch (e) {} }); kelSeries = null; }
}
function applyIchimoku() {
  if (ichiCfg.on && chart) {
    if (!ichiSeries) { ichiSeries = { tenkan: _ovLine("#3b82f6", false), kijun: _ovLine("#ef4444", false), spanA: _ovLine("#15b870", false), spanB: _ovLine("#f59e0b", false), chikou: _ovLine("#a78bfa", true) }; }
    const C = currentCandles, ic = computeIchimoku(C, ichiCfg.conv, ichiCfg.base, ichiCfg.span);
    _setLine(ichiSeries.tenkan, ic.tenkan); _setLine(ichiSeries.kijun, ic.kijun);
    _setLine(ichiSeries.spanA, ic.spanA); _setLine(ichiSeries.spanB, ic.spanB);
    const sh = ichiCfg.base, chi = [];
    for (let i = 0; i < C.length; i++) { if (ic.chikou[i] == null) continue; const ti = i - sh; if (ti >= 0) chi.push({ time: C[ti].time, value: Math.round(ic.chikou[i] * 100) / 100 }); }
    ichiSeries.chikou.setData(chi);
  } else if (ichiSeries) { Object.values(ichiSeries).forEach((s) => { try { chart.removeSeries(s); } catch (e) {} }); ichiSeries = null; }
}
function applyADX() {
  const LC = LightweightCharts;
  if (adxCfg.on && chart) {
    if (!adxSeries) {
      adxPane = chart.addPane(); const pi = adxPane.paneIndex();
      adxSeries = {
        adx: chart.addSeries(LC.LineSeries, { color: "#eab308", lineWidth: 2, priceScaleId: "adx", priceLineVisible: false, lastValueVisible: true }, pi),
        plus: chart.addSeries(LC.LineSeries, { color: "#15b870", lineWidth: 1, priceScaleId: "adx", priceLineVisible: false, lastValueVisible: false }, pi),
        minus: chart.addSeries(LC.LineSeries, { color: "#f04444", lineWidth: 1, priceScaleId: "adx", priceLineVisible: false, lastValueVisible: false }, pi),
      };
      adxSeries.adx.createPriceLine({ price: 25, color: "#ffffff22", lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "25" });
      restretch();
    }
    const a = computeADX(currentCandles, adxCfg.period);
    const mk = (arr) => currentCandles.map((c, j) => (arr[j] != null ? { time: c.time, value: Math.round(arr[j] * 10) / 10 } : null)).filter(Boolean);
    adxSeries.adx.setData(mk(a.adx)); adxSeries.plus.setData(mk(a.plusDI)); adxSeries.minus.setData(mk(a.minusDI));
  } else if (adxSeries) {
    [adxSeries.adx, adxSeries.plus, adxSeries.minus].forEach((s) => { try { chart.removeSeries(s); } catch (e) {} });
    adxSeries = null; if (adxPane) { try { chart.removePane(adxPane.paneIndex()); } catch (e) {} adxPane = null; } restretch();
  }
}
function applyATR() {
  const LC = LightweightCharts;
  if (atrCfg.on && chart) {
    if (!atrSeries) {
      atrPane = chart.addPane();
      atrSeries = chart.addSeries(LC.LineSeries, { color: "#f59e0b", lineWidth: 2, priceScaleId: "atr", priceLineVisible: false, lastValueVisible: true }, atrPane.paneIndex());
      restretch();
    }
    const a = computeATR(currentCandles, atrCfg.period);
    atrSeries.setData(currentCandles.map((c, j) => (a[j] != null ? { time: c.time, value: Math.round(a[j] * 100) / 100 } : null)).filter(Boolean));
  } else if (atrSeries) {
    try { chart.removeSeries(atrSeries); } catch (e) {}
    atrSeries = null; if (atrPane) { try { chart.removePane(atrPane.paneIndex()); } catch (e) {} atrPane = null; } restretch();
  }
}
/* ---- Phase 3 draw functions ---- */
function applyStochRSI() {
  const LC = LightweightCharts;
  if (stochCfg.on && chart) {
    if (!stochSeries) {
      stochPane = chart.addPane(); const pi = stochPane.paneIndex();
      stochSeries = {
        k: chart.addSeries(LC.LineSeries, { color: "#c084fc", lineWidth: 2, priceScaleId: "stoch", priceLineVisible: false, lastValueVisible: true, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }, pi),
        d: chart.addSeries(LC.LineSeries, { color: "#f472b6", lineWidth: 1, priceScaleId: "stoch", priceLineVisible: false, lastValueVisible: false }, pi),
      };
      [80, 20].forEach((lvl) => stochSeries.k.createPriceLine({ price: lvl, color: lvl === 80 ? "#f0444466" : "#15b87066", lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: String(lvl) }));
      restretch();
    }
    const s = computeStochRSI(currentCandles.map((c) => c.close), stochCfg.period, stochCfg.smooth);
    const mk = (arr) => currentCandles.map((c, j) => (arr[j] != null ? { time: c.time, value: Math.round(arr[j] * 10) / 10 } : null)).filter(Boolean);
    stochSeries.k.setData(mk(s.k)); stochSeries.d.setData(mk(s.d));
  } else if (stochSeries) {
    [stochSeries.k, stochSeries.d].forEach((s) => { try { chart.removeSeries(s); } catch (e) {} });
    stochSeries = null; if (stochPane) { try { chart.removePane(stochPane.paneIndex()); } catch (e) {} stochPane = null; } restretch();
  }
}
function applyCCI() {
  const LC = LightweightCharts;
  if (cciCfg.on && chart) {
    if (!cciSeries) {
      cciPane = chart.addPane();
      cciSeries = chart.addSeries(LC.LineSeries, { color: "#f59e0b", lineWidth: 2, priceScaleId: "cci", priceLineVisible: false, lastValueVisible: true }, cciPane.paneIndex());
      [100, 0, -100].forEach((lvl) => cciSeries.createPriceLine({ price: lvl, color: lvl === 0 ? "#ffffff22" : "#ffffff22", lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: String(lvl) }));
      restretch();
    }
    const a = computeCCI(currentCandles, cciCfg.period);
    cciSeries.setData(currentCandles.map((c, j) => (a[j] != null ? { time: c.time, value: Math.round(a[j] * 10) / 10 } : null)).filter(Boolean));
  } else if (cciSeries) {
    try { chart.removeSeries(cciSeries); } catch (e) {}
    cciSeries = null; if (cciPane) { try { chart.removePane(cciPane.paneIndex()); } catch (e) {} cciPane = null; } restretch();
  }
}
function applyOBV() {
  const LC = LightweightCharts;
  if (obvCfg.on && chart) {
    if (!obvSeries) {
      obvPane = chart.addPane();
      obvSeries = chart.addSeries(LC.LineSeries, { color: "#38bdf8", lineWidth: 2, priceScaleId: "obv", priceLineVisible: false, lastValueVisible: true }, obvPane.paneIndex());
      restretch();
    }
    const a = computeOBV(currentCandles);
    obvSeries.setData(currentCandles.map((c, j) => (a[j] != null ? { time: c.time, value: Math.round(a[j]) } : null)).filter(Boolean));
  } else if (obvSeries) {
    try { chart.removeSeries(obvSeries); } catch (e) {}
    obvSeries = null; if (obvPane) { try { chart.removePane(obvPane.paneIndex()); } catch (e) {} obvPane = null; } restretch();
  }
}
function applyVWAP() {
  if (vwapCfg.on && chart) {
    if (!vwapSeries) vwapSeries = _ovLine("#facc15", false, 2);
    _setLine(vwapSeries, computeVWAP(currentCandles, 0));
  } else if (vwapSeries) { try { chart.removeSeries(vwapSeries); } catch (e) {} vwapSeries = null; }
}
function applyAnchoredVWAP() {
  if (avwapCfg.on && chart) {
    if (!avwapSeries) avwapSeries = _ovLine("#fb923c", false, 2);
    const from = Math.max(0, currentCandles.length - (avwapCfg.back || 60));
    _setLine(avwapSeries, computeVWAP(currentCandles, from));
  } else if (avwapSeries) { try { chart.removeSeries(avwapSeries); } catch (e) {} avwapSeries = null; }
}
function applyVolumeProfile() {
  const LC = LightweightCharts;
  vpLines.forEach((pl) => { try { candle.removePriceLine(pl); } catch (e) {} });
  vpLines = [];
  if (vpCfg.on && chart && candle) {
    const vp = computeVolumeProfile(currentCandles, vpCfg.period, vpCfg.bins);
    if (vp) {
      const add = (price, color, title) => vpLines.push(candle.createPriceLine({ price: Math.round(price * 100) / 100, color, lineStyle: LC.LineStyle.Dashed, lineWidth: title === "POC" ? 2 : 1, axisLabelVisible: true, title }));
      add(vp.poc, "#94a3b8", "POC"); add(vp.vah, "#64748b", "VAH"); add(vp.val, "#64748b", "VAL");
    }
  }
}
/* ---- Phase 4 draw functions (S/R price lines on the candle series) ---- */
function _clearLines(arr) { arr.forEach((pl) => { try { candle.removePriceLine(pl); } catch (e) {} }); return []; }
function applyPivots() {
  const LC = LightweightCharts;
  pivotLines = _clearLines(pivotLines);
  if (pivotCfg.on && chart && candle) {
    const p = computePivots(currentCandles);
    if (p) {
      const add = (price, color, title, w) => pivotLines.push(candle.createPriceLine({ price: Math.round(price * 100) / 100, color, lineStyle: LC.LineStyle.Dashed, lineWidth: w || 1, axisLabelVisible: true, title }));
      add(p.P, "#e2e8f0", "P", 2);
      add(p.R1, "#f0444488", "R1"); add(p.R2, "#f0444488", "R2"); add(p.R3, "#f0444455", "R3");
      add(p.S1, "#15b87088", "S1"); add(p.S2, "#15b87088", "S2"); add(p.S3, "#15b87055", "S3");
    }
  }
}
function applyFib() {
  const LC = LightweightCharts;
  fibLines = _clearLines(fibLines);
  if (fibCfg.on && chart && candle) {
    const f = computeFib(currentCandles, fibCfg.period);
    if (f) f.forEach((lv) => fibLines.push(candle.createPriceLine({ price: Math.round(lv.price * 100) / 100, color: "#eab35877", lineStyle: LC.LineStyle.Dashed, lineWidth: (lv.r === 0 || lv.r === 1) ? 2 : 1, axisLabelVisible: true, title: (lv.r * 100).toFixed(1).replace(/\.0$/, "") + "%" })));
  }
}
function applyAutoSR() {
  const LC = LightweightCharts;
  srLines = _clearLines(srLines);
  if (srCfg.on && chart && candle) {
    const levels = computeAutoSR(currentCandles, srCfg.period, srCfg.strength, 6);
    levels.forEach((lv) => srLines.push(candle.createPriceLine({ price: Math.round(lv.price * 100) / 100, color: lv.type === "res" ? "#f0444466" : "#15b87066", lineStyle: LC.LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true, title: lv.type === "res" ? "R" : "S" })));
  }
}
/* ---- Phase 4: optional plain-English technical-analysis summary ----
   Reads the ENABLED indicators and describes what they currently show.
   Descriptive only — no predictions, no guarantees. Never changes the
   weekly BUY/SELL verdict (says so explicitly). Respects the display tf. */
function _enabled(id) { return LIVECFG[id] && LIVECFG[id]().on; }
function _lastNonNull(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; }
function technicalSummary() {
  const C = currentCandles, d = lastStockData;
  if (!C || C.length < 10) return '<div class="note">Not enough data on this timeframe for a summary.</div>';
  const closes = C.map((c) => c.close), px = closes[closes.length - 1];
  const tf = { W: "weekly", D: "daily", M: "monthly" }[currentTf] || "selected";
  const rows = [];
  const push = (label, text) => { if (text) rows.push(`<div class="ta-row"><span class="ta-k">${label}</span><span class="ta-v">${text}</span></div>`); };

  // ---- Trend direction ----
  const tparts = [];
  if (d && d.signal_9_21) tparts.push("weekly 9/21 is " + (d.signal_9_21.regime === "above" ? "<b>up</b>" : "<b>down</b>"));
  if (d && d.signal_21_50) tparts.push("the 21/50 longer trend is " + (d.signal_21_50.regime === "above" ? "up" : "down"));
  if (_enabled("ema")) { const e9 = _lastNonNull(computeEMA(closes, emaConfig[0].period)), e21 = _lastNonNull(computeEMA(closes, emaConfig[1].period)); if (e9 != null && e21 != null) tparts.push("on the " + tf + " chart the fast EMA is " + (e9 >= e21 ? "above" : "below") + " the slow EMA"); }
  if (_enabled("st")) { const s = computeSupertrend(C, stCfg.period, stCfg.mult); const dir = _lastNonNull(s.dir); if (dir != null) tparts.push("Supertrend is " + (dir === 1 ? "green (up)" : "red (down)")); }
  if (_enabled("adx")) { const a = _lastNonNull(computeADX(C, adxCfg.period).adx); if (a != null) tparts.push("ADX " + Math.round(a) + " — " + (a < 20 ? "weak/!trending" : a < 25 ? "a trend may be building" : a < 40 ? "a healthy trend" : "a strong trend")); }
  push("Trend", tparts.length ? tparts.join("; ") + "." : "—");

  // ---- Momentum strength ----
  const mparts = [];
  if (_enabled("rsi")) { const r = _lastNonNull(computeRSI(closes, rsiCfg.period)); if (r != null) mparts.push("RSI " + Math.round(r) + " (" + (r >= 70 ? "overbought" : r <= 30 ? "oversold" : r >= 55 ? "firm" : r <= 45 ? "soft" : "neutral") + ")"); }
  if (_enabled("macd")) { const m = computeMACD(closes, macdCfg.fast, macdCfg.slow, macdCfg.signal); const h = _lastNonNull(m.hist); if (h != null) mparts.push("MACD histogram is " + (h >= 0 ? "positive (bullish)" : "negative (bearish)")); }
  if (_enabled("stoch")) { const k = _lastNonNull(computeStochRSI(closes, stochCfg.period, stochCfg.smooth).k); if (k != null) mparts.push("Stoch RSI " + Math.round(k) + (k >= 80 ? " (overbought)" : k <= 20 ? " (oversold)" : "")); }
  if (_enabled("cci")) { const c = _lastNonNull(computeCCI(C, cciCfg.period)); if (c != null) mparts.push("CCI " + Math.round(c) + (c > 100 ? " (strong)" : c < -100 ? " (weak)" : "")); }
  push("Momentum", mparts.length ? mparts.join("; ") + "." : "No momentum indicators selected.");

  // ---- Volume confirmation ----
  const vparts = [];
  if (_enabled("obv")) { const o = computeOBV(C); const last = _lastNonNull(o), back = o[Math.max(0, o.length - 11)]; if (last != null && back != null) vparts.push("OBV is " + (last > back ? "rising — volume supports the move" : last < back ? "falling — volume isn't confirming" : "flat")); }
  if (_enabled("vwap")) { const w = _lastNonNull(computeVWAP(C, 0)); if (w != null) vparts.push("price is " + (px >= w ? "above" : "below") + " the cumulative VWAP"); }
  if (_enabled("volume") && C.length > 20) { let s = 0; for (let i = C.length - 20; i < C.length; i++) s += (C[i].volume || 0); const avg = s / 20, lastV = C[C.length - 1].volume || 0; vparts.push("the latest bar's volume is " + (lastV > avg * 1.3 ? "above" : lastV < avg * 0.7 ? "below" : "near") + " its 20-bar average"); }
  push("Volume", vparts.length ? vparts.join("; ") + "." : "No volume indicators selected.");

  // ---- Volatility ----
  const volparts = [];
  if (_enabled("atr")) { const a = _lastNonNull(computeATR(C, atrCfg.period)); if (a != null && px) volparts.push("ATR is about " + (a / px * 100).toFixed(1) + "% of price (typical bar range)"); }
  if (_enabled("bb")) { const b = computeBollinger(closes, bbCfg.period, bbCfg.mult); const u = _lastNonNull(b.up), l = _lastNonNull(b.lo), m = _lastNonNull(b.mid); if (u != null && l != null && m) volparts.push("Bollinger bands are " + ((u - l) / m * 100).toFixed(1) + "% wide (" + (px >= u ? "price at upper band" : px <= l ? "price at lower band" : "price mid-band") + ")"); }
  push("Volatility", volparts.length ? volparts.join("; ") + "." : "No volatility indicators selected.");

  // ---- Support & resistance (from selected S/R tools, else recent swings) ----
  let levels = [];
  if (_enabled("sr")) levels = computeAutoSR(C, srCfg.period, srCfg.strength, 8).map((l) => l.price);
  if (_enabled("pivot")) { const p = computePivots(C); if (p) levels.push(p.R1, p.R2, p.S1, p.S2, p.P); }
  if (_enabled("fib")) { const f = computeFib(C, fibCfg.period); if (f) f.forEach((x) => levels.push(x.price)); }
  if (_enabled("vprofile")) { const vp = computeVolumeProfile(C, vpCfg.period, vpCfg.bins); if (vp) levels.push(vp.poc, vp.vah, vp.val); }
  if (!levels.length) levels = computeAutoSR(C, 120, 3, 8).map((l) => l.price); // fallback so this aspect is always covered
  const res = levels.filter((p) => p > px).sort((a, b) => a - b)[0];
  const sup = levels.filter((p) => p < px).sort((a, b) => b - a)[0];
  push("Support / resistance", (sup ? "Nearest support ≈ ₹" + fmt(Math.round(sup * 100) / 100) : "No clear support below") + " · " + (res ? "nearest resistance ≈ ₹" + fmt(Math.round(res * 100) / 100) : "no clear resistance above") + ".");

  // ---- Bullish / bearish signals ----
  const sigs = [];
  if (d && d.signal_9_21 && d.signal_9_21.fresh_bull) sigs.push("a fresh weekly 9/21 bullish cross");
  if (d && d.signal_9_21 && d.signal_9_21.fresh_bear) sigs.push("a fresh weekly 9/21 bearish cross");
  if (_enabled("macd")) { const m = computeMACD(closes, macdCfg.fast, macdCfg.slow, macdCfg.signal); const n = closes.length - 1; if (m.macd[n] != null && m.signal[n] != null && m.macd[n - 1] != null && m.signal[n - 1] != null) { if (m.macd[n] >= m.signal[n] && m.macd[n - 1] < m.signal[n - 1]) sigs.push("a MACD bullish cross"); if (m.macd[n] < m.signal[n] && m.macd[n - 1] >= m.signal[n - 1]) sigs.push("a MACD bearish cross"); } }
  push("Signals", sigs.length ? "Recent: " + sigs.join(", ") + "." : "No fresh crossover signals right now.");

  // ---- Entry / exit areas to watch ----
  const zone = (sup && res)
    ? "Support near ₹" + fmt(Math.round(sup * 100) / 100) + " is an area some traders watch for lower-risk entries, while a move and hold above ₹" + fmt(Math.round(res * 100) / 100) + " would clear the nearest resistance. These are areas to watch, not instructions."
    : "Watch how price reacts around the nearest levels above and below.";
  push("Entry / exit areas", zone);

  return `<div class="ta-list">${rows.join("")}</div>
    <div class="ta-foot">This describes what your <b>selected indicators</b> currently show on the ${tf} chart — it is <b>not a prediction, a guarantee, or advice</b>, and it never changes your weekly BUY/SELL signal. Data is ~15-min delayed.</div>`;
}
function wireDetailSubnav() {
  const nav = document.querySelector(".d-subnav");
  if (!nav) return;
  const btns = [...nav.querySelectorAll("button[data-anchor]")];
  btns.forEach((b) => b.addEventListener("click", () => {
    const el = document.getElementById(b.dataset.anchor);
    if (!el) return;
    const se = document.scrollingElement || document.documentElement;
    const top = Math.max(0, el.getBoundingClientRect().top + se.scrollTop - 108);
    se.scrollTop = top; // direct (CSS scroll-behavior:smooth animates it where supported)
    btns.forEach((x) => x.classList.toggle("active", x === b));
  }));
  // highlight the section currently in view
  const secs = btns.map((b) => document.getElementById(b.dataset.anchor)).filter(Boolean);
  if ("IntersectionObserver" in window && secs.length) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          const id = en.target.id;
          btns.forEach((b) => b.classList.toggle("active", b.dataset.anchor === id));
        }
      });
    }, { rootMargin: "-120px 0px -60% 0px", threshold: 0 });
    secs.forEach((s) => obs.observe(s));
  }
}
function renderTASummary() {
  const wrap = document.getElementById("taSummaryWrap");
  if (!wrap) return;
  if (!taCfg.on) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<section class="d-sec"><h2 class="d-h"><span class="d-num">★</span>Technical analysis summary <span style="color:var(--faint);font-weight:400;font-size:13px">· your selected indicators</span></h2>
      <div class="ta-box">${technicalSummary()}</div></section>`;
}
function computeEMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0; for (let i = 0; i < period; i++) seed += closes[i]; seed /= period;
  out[period - 1] = seed; let prev = seed;
  for (let i = period; i < closes.length; i++) { prev = closes[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
// --- indicator compute layer (client-side, feeds future RSI/MACD panes: B2/B3) ---
function computeRSI(closes, period) {
  period = period || 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgL = (avgL * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}
function computeMACD(closes, fast, slow, sig) {
  fast = fast || 12; slow = slow || 26; sig = sig || 9;
  const ef = computeEMA(closes, fast), es = computeEMA(closes, slow);
  const macd = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const signal = new Array(closes.length).fill(null);
  const first = macd.findIndex((v) => v != null);
  if (first >= 0) {
    const se = computeEMA(macd.slice(first).map((v) => (v == null ? 0 : v)), sig);
    for (let i = 0; i < se.length; i++) if (se[i] != null) signal[first + i] = se[i];
  }
  const hist = closes.map((_, i) => (macd[i] != null && signal[i] != null) ? macd[i] - signal[i] : null);
  return { macd, signal, hist };
}
function computeBollinger(closes, period, mult) {
  period = period || 20; mult = mult || 2;
  const mid = new Array(closes.length).fill(null), up = new Array(closes.length).fill(null), lo = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const m = sum / period;
    let v = 0; for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    mid[i] = m; up[i] = m + mult * sd; lo[i] = m - mult * sd;
  }
  return { mid, up, lo };
}
function computeSupertrend(candles, period, mult) {
  period = period || 10; mult = mult || 3;
  const n = candles.length, atr = new Array(n).fill(null), tr = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const pc = i > 0 ? candles[i - 1].close : candles[i].close;
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - pc), Math.abs(candles[i].low - pc));
  }
  if (n > period) {
    let a = 0; for (let i = 0; i < period; i++) a += tr[i]; a /= period; atr[period - 1] = a;
    for (let i = period; i < n; i++) { a = (a * (period - 1) + tr[i]) / period; atr[i] = a; }
  }
  const st = new Array(n).fill(null), dir = new Array(n).fill(null);
  let fUpper = null, fLower = null, trend = 1;
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const bU = hl2 + mult * atr[i], bL = hl2 - mult * atr[i];
    const pc = i > 0 ? candles[i - 1].close : candles[i].close;
    fUpper = (fUpper == null || bU < fUpper || pc > fUpper) ? bU : fUpper;
    fLower = (fLower == null || bL > fLower || pc < fLower) ? bL : fLower;
    if (trend === 1 && candles[i].close < fLower) trend = -1;
    else if (trend === -1 && candles[i].close > fUpper) trend = 1;
    st[i] = trend === 1 ? fLower : fUpper; dir[i] = trend;
  }
  return { st, dir };
}
/* ---- Phase 2 indicator math (client-side, from the candles already fetched) ---- */
function computeSMA(closes, period) {
  period = period || 50;
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) { sum += closes[i]; if (i >= period) sum -= closes[i - period]; if (i >= period - 1) out[i] = sum / period; }
  return out;
}
function computeDonchian(candles, period) {
  period = period || 20;
  const n = candles.length, up = new Array(n).fill(null), lo = new Array(n).fill(null), mid = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - period + 1; j <= i; j++) { if (candles[j].high > h) h = candles[j].high; if (candles[j].low < l) l = candles[j].low; }
    up[i] = h; lo[i] = l; mid[i] = (h + l) / 2;
  }
  return { up, lo, mid };
}
function computeATR(candles, period) {
  period = period || 14;
  const n = candles.length, tr = new Array(n).fill(null), atr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const pc = i > 0 ? candles[i - 1].close : candles[i].close;
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - pc), Math.abs(candles[i].low - pc));
  }
  if (n > period) {
    let a = 0; for (let i = 1; i <= period; i++) a += tr[i]; a /= period; atr[period] = a;
    for (let i = period + 1; i < n; i++) { a = (a * (period - 1) + tr[i]) / period; atr[i] = a; }
  }
  return atr;
}
function computeKeltner(candles, period, mult) {
  period = period || 20; mult = mult || 2;
  const mid = computeEMA(candles.map((c) => c.close), period), atr = computeATR(candles, period);
  const up = new Array(candles.length).fill(null), lo = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) { if (mid[i] != null && atr[i] != null) { up[i] = mid[i] + mult * atr[i]; lo[i] = mid[i] - mult * atr[i]; } }
  return { up, mid, lo };
}
function computeADX(candles, period) {
  period = period || 14;
  const n = candles.length, tr = new Array(n).fill(0), pDM = new Array(n).fill(0), mDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high, dn = candles[i - 1].low - candles[i].low;
    pDM[i] = (up > dn && up > 0) ? up : 0; mDM[i] = (dn > up && dn > 0) ? dn : 0;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - pc), Math.abs(candles[i].low - pc));
  }
  const adx = new Array(n).fill(null), plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
  if (n <= 2 * period) return { adx, plusDI, minusDI };
  let str = 0, spdm = 0, smdm = 0;
  for (let i = 1; i <= period; i++) { str += tr[i]; spdm += pDM[i]; smdm += mDM[i]; }
  for (let i = period + 1; i < n; i++) {
    str = str - str / period + tr[i]; spdm = spdm - spdm / period + pDM[i]; smdm = smdm - smdm / period + mDM[i];
    const pDI = str === 0 ? 0 : 100 * spdm / str, mDI = str === 0 ? 0 : 100 * smdm / str;
    plusDI[i] = pDI; minusDI[i] = mDI;
    const sum = pDI + mDI; dx[i] = sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum;
  }
  let cnt = 0, acc = 0, adxStart = null;
  for (let i = period + 1; i < n; i++) { if (dx[i] == null) continue; acc += dx[i]; cnt++; if (cnt === period) { adxStart = i; adx[i] = acc / period; break; } }
  if (adxStart != null) for (let i = adxStart + 1; i < n; i++) { if (dx[i] != null) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period; }
  return { adx, plusDI, minusDI };
}
function computeIchimoku(candles, conv, base, span) {
  conv = conv || 9; base = base || 26; span = span || 52;
  const n = candles.length;
  const hh = (p, i) => { let h = -Infinity; for (let j = i - p + 1; j <= i; j++) if (candles[j].high > h) h = candles[j].high; return h; };
  const ll = (p, i) => { let l = Infinity; for (let j = i - p + 1; j <= i; j++) if (candles[j].low < l) l = candles[j].low; return l; };
  const tenkan = new Array(n).fill(null), kijun = new Array(n).fill(null), spanA = new Array(n).fill(null), spanB = new Array(n).fill(null), chikou = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i >= conv - 1) tenkan[i] = (hh(conv, i) + ll(conv, i)) / 2;
    if (i >= base - 1) kijun[i] = (hh(base, i) + ll(base, i)) / 2;
    if (tenkan[i] != null && kijun[i] != null) spanA[i] = (tenkan[i] + kijun[i]) / 2;
    if (i >= span - 1) spanB[i] = (hh(span, i) + ll(span, i)) / 2;
    chikou[i] = candles[i].close;
  }
  return { tenkan, kijun, spanA, spanB, chikou };
}
/* ---- Phase 3 indicator math (Momentum + Volume) ---- */
function _smaArr(arr, p) { // SMA over p contiguous non-null values
  const n = arr.length, out = new Array(n).fill(null);
  for (let i = p - 1; i < n; i++) {
    let sum = 0, ok = true;
    for (let j = i - p + 1; j <= i; j++) { if (arr[j] == null) { ok = false; break; } sum += arr[j]; }
    if (ok) out[i] = sum / p;
  }
  return out;
}
function computeStochRSI(closes, period, smooth) {
  period = period || 14; smooth = smooth || 3;
  const rsi = computeRSI(closes, period), n = closes.length, stoch = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (rsi[i] == null) continue;
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let j = i - period + 1; j <= i; j++) { if (j < 0 || rsi[j] == null) { ok = false; break; } if (rsi[j] < lo) lo = rsi[j]; if (rsi[j] > hi) hi = rsi[j]; }
    if (ok) stoch[i] = hi === lo ? 0 : (rsi[i] - lo) / (hi - lo) * 100;
  }
  const k = _smaArr(stoch, smooth), d = _smaArr(k, smooth);
  return { k, d };
}
function computeCCI(candles, period) {
  period = period || 20;
  const n = candles.length, out = new Array(n).fill(null), tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  for (let i = period - 1; i < n; i++) {
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += tp[j];
    const ma = sum / period;
    let md = 0; for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - ma); md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - ma) / (0.015 * md);
  }
  return out;
}
function computeOBV(candles) {
  const n = candles.length, out = new Array(n).fill(null);
  if (!n) return out;
  let obv = 0; out[0] = 0;
  for (let i = 1; i < n; i++) {
    const v = candles[i].volume || 0;
    if (candles[i].close > candles[i - 1].close) obv += v;
    else if (candles[i].close < candles[i - 1].close) obv -= v;
    out[i] = obv;
  }
  return out;
}
function computeVWAP(candles, from) {
  from = from || 0;
  const n = candles.length, out = new Array(n).fill(null);
  let cumPV = 0, cumV = 0;
  for (let i = from; i < n; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3, v = candles[i].volume || 0;
    cumPV += tp * v; cumV += v; out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}
function computeVolumeProfile(candles, lookback, bins) {
  lookback = lookback || 120; bins = Math.max(4, bins || 24);
  const n = candles.length, start = Math.max(0, n - lookback);
  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < n; i++) { if (candles[i].low < lo) lo = candles[i].low; if (candles[i].high > hi) hi = candles[i].high; }
  if (!(hi > lo)) return null;
  const binSize = (hi - lo) / bins, vol = new Array(bins).fill(0);
  for (let i = start; i < n; i++) {
    const v = candles[i].volume || 0;
    const b0 = Math.max(0, Math.floor((candles[i].low - lo) / binSize)), b1 = Math.min(bins - 1, Math.floor((candles[i].high - lo) / binSize));
    const each = v / (b1 - b0 + 1);
    for (let b = b0; b <= b1; b++) vol[b] += each;
  }
  let poc = 0; for (let b = 1; b < bins; b++) if (vol[b] > vol[poc]) poc = b;
  const total = vol.reduce((a, b) => a + b, 0), target = total * 0.7;
  let acc = vol[poc], loB = poc, hiB = poc;
  while (acc < target && (loB > 0 || hiB < bins - 1)) {
    const belowV = loB > 0 ? vol[loB - 1] : -1, aboveV = hiB < bins - 1 ? vol[hiB + 1] : -1;
    if (aboveV >= belowV) { hiB++; acc += vol[hiB]; } else { loB--; acc += vol[loB]; }
  }
  return { poc: lo + (poc + 0.5) * binSize, vah: lo + (hiB + 1) * binSize, val: lo + loB * binSize };
}
/* ---- Phase 4 math: Support / Resistance ---- */
function computePivots(candles) {
  const n = candles.length;
  if (n < 2) return null;
  const b = candles[n - 2]; // previous completed period
  const P = (b.high + b.low + b.close) / 3, rng = b.high - b.low;
  return { P, R1: 2 * P - b.low, S1: 2 * P - b.high, R2: P + rng, S2: P - rng, R3: b.high + 2 * (P - b.low), S3: b.low - 2 * (b.high - P) };
}
function computeFib(candles, lookback) {
  lookback = lookback || 120;
  const n = candles.length, start = Math.max(0, n - lookback);
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i < n; i++) { if (candles[i].high > hi) hi = candles[i].high; if (candles[i].low < lo) lo = candles[i].low; }
  if (!(hi > lo)) return null;
  return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((r) => ({ r, price: hi - (hi - lo) * r }));
}
function computeAutoSR(candles, lookback, strength, max) {
  lookback = lookback || 120; strength = strength || 3; max = max || 6;
  const n = candles.length, start = Math.max(strength, n - lookback), levels = [];
  for (let i = start; i < n - strength; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) levels.push({ price: candles[i].high, type: "res" });
    if (isLow) levels.push({ price: candles[i].low, type: "sup" });
  }
  if (!levels.length) return [];
  // cluster levels within ~0.5% into one, keep the most recent price
  const px = candles[n - 1].close, tol = px * 0.006, merged = [];
  levels.sort((a, b) => a.price - b.price);
  for (const lv of levels) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(lv.price - last.price) <= tol) { last.price = (last.price + lv.price) / 2; }
    else merged.push({ price: lv.price, type: lv.price >= px ? "res" : "sup" });
  }
  // keep the `max` nearest to current price
  merged.forEach((m) => { m.dist = Math.abs(m.price - px); m.type = m.price >= px ? "res" : "sup"; });
  merged.sort((a, b) => a.dist - b.dist);
  return merged.slice(0, max);
}
function slots() { return [l9, l21, l50]; }

// Fit all bars across the full chart width. fitContent() can get stuck at the
// 0.5px minimum barSpacing when initChart ran while the Search page was hidden
// (zero width), so we force an explicit logical range once layout has settled.
function fitChart() {
  if (!chart) return;
  requestAnimationFrame(() => {
    try { chart.timeScale().setVisibleLogicalRange({ from: -1, to: currentCandles.length }); } catch (e) {}
  });
}

function initChart() {
  chart = LightweightCharts.createChart($("chart"), {
    layout: { background: { color: "#12151c" }, textColor: "#8a93a6" },
    grid: { vertLines: { color: "#171b24" }, horzLines: { color: "#171b24" } },
    rightPriceScale: { borderColor: "#222835", scaleMargins: { top: 0.08, bottom: 0.26 } },
    timeScale: { borderColor: "#222835", timeVisible: false, rightOffset: 3, barSpacing: 6 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });
  const LC = LightweightCharts;
  candle = chart.addSeries(LC.CandlestickSeries, { upColor: "#15b870", downColor: "#f04444",
    borderVisible: false, wickUpColor: "#15b870", wickDownColor: "#f04444" });
  vol = chart.addSeries(LC.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol" });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  l50 = chart.addSeries(LC.LineSeries, { color: EMA_COLORS[2], lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  l21 = chart.addSeries(LC.LineSeries, { color: EMA_COLORS[1], lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  l9 = chart.addSeries(LC.LineSeries, { color: EMA_COLORS[0], lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  markersPrim = LC.createSeriesMarkers(candle, []);
  chart.subscribeCrosshairMove((p) => {
    if (!p || !p.time || !p.seriesData) return setLegend(lastCandle, emaAt);
    const c = p.seriesData.get(candle);
    if (!c) return setLegend(lastCandle, emaAt);
    const SER = slots();
    const emas = emaConfig.map((cfg, i) => {
      if (!cfg.on) return null; const x = p.seriesData.get(SER[i]);
      return x ? { period: cfg.period, color: EMA_COLORS[i], value: x.value } : null;
    });
    const rv = rsiSeries ? p.seriesData.get(rsiSeries) : null;
    setLegend({ time: p.time, open: c.open, high: c.high, low: c.low, close: c.close }, emas, rv ? rsiState(rv.value) : null);
  });
  chartReady = true;
}

function setLegend(c, emas, rsi) {
  if (!c) { $("chartLegend").innerHTML = ""; return; }
  const col = c.close >= c.open ? "#4ade80" : "#f87171";
  const b = (x) => `<b style="color:${col}">${fmt(x)}</b>`;
  let h = `<span class="lg-d">${c.time}</span> O ${b(c.open)} H ${b(c.high)} L ${b(c.low)} C ${b(c.close)}`;
  (emas || []).forEach((e) => { if (e && e.value != null) h += ` <span style="color:${e.color}">E${e.period} ${fmt(e.value)}</span>`; });
  if (rsi && rsi.value != null) h += ` <span style="color:${RSI_COLOR}">RSI ${Math.round(rsi.value * 10) / 10}${rsi.state ? " · " + rsi.state : ""}</span>`;
  $("chartLegend").innerHTML = h;
}

function applyEMAs() {
  const SER = slots();
  const closes = currentCandles.map((c) => c.close);
  emaConfig.forEach((cfg, i) => {
    const s = SER[i];
    if (cfg.on && cfg.period > 0) {
      const e = computeEMA(closes, cfg.period);
      s.setData(currentCandles.map((c, j) => (e[j] != null ? { time: c.time, value: Math.round(e[j] * 100) / 100 } : null)).filter(Boolean));
      s.applyOptions({ visible: true });
    } else { s.setData([]); s.applyOptions({ visible: false }); }
  });
  const last = currentCandles[currentCandles.length - 1];
  lastCandle = last ? { time: last.time, open: last.open, high: last.high, low: last.low, close: last.close } : null;
  emaAt = emaConfig.map((cfg, i) => {
    if (!cfg.on || cfg.period <= 0) return null;
    const e = computeEMA(closes, cfg.period);
    return { period: cfg.period, color: EMA_COLORS[i], value: e.length ? e[e.length - 1] : null };
  });
  setLegend(lastCandle, emaAt);
}

function applyRSI() {
  const LC = LightweightCharts;
  if (rsiCfg.on && chart) {
    if (!rsiSeries) {
      rsiPane = chart.addPane();
      rsiSeries = chart.addSeries(LC.LineSeries, {
        color: RSI_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
        priceScaleId: "rsi",
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      }, rsiPane.paneIndex());
      [70, 50, 30].forEach((lvl) => rsiSeries.createPriceLine({
        price: lvl, color: lvl === 50 ? "#ffffff22" : (lvl === 70 ? "#f0444466" : "#15b87066"),
        lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: String(lvl),
      }));
      restretch();
    }
    const closes = currentCandles.map((c) => c.close);
    const r = computeRSI(closes, rsiCfg.period);
    rsiSeries.setData(currentCandles.map((c, j) => (r[j] != null ? { time: c.time, value: Math.round(r[j] * 10) / 10 } : null)).filter(Boolean));
    rsiAt = r.length ? r[r.length - 1] : null;
  } else if (rsiSeries) {
    chart.removeSeries(rsiSeries); rsiSeries = null;
    if (rsiPane) { try { chart.removePane(rsiPane.paneIndex()); } catch (e) {} rsiPane = null; }
    rsiAt = null; restretch();
  }
  setLegend(lastCandle, emaAt, rsiState(rsiAt));
}

function macdState() {
  if (!macdAt || macdAt.macd == null || macdAt.signal == null) return null;
  const bull = macdAt.macd >= macdAt.signal;
  return { bull: bull, hist: macdAt.hist, cross: macdAt.cross };
}
function applyMACD() {
  const LC = LightweightCharts;
  if (macdCfg.on && chart) {
    if (!macdHist) {
      macdPane = chart.addPane();
      const pi = macdPane.paneIndex();
      macdHist = chart.addSeries(LC.HistogramSeries, { priceScaleId: "macd", priceLineVisible: false, lastValueVisible: false }, pi);
      macdSignal = chart.addSeries(LC.LineSeries, { color: MACD_COLORS.signal, lineWidth: 1, priceScaleId: "macd", priceLineVisible: false, lastValueVisible: false }, pi);
      macdLine = chart.addSeries(LC.LineSeries, { color: MACD_COLORS.macd, lineWidth: 2, priceScaleId: "macd", priceLineVisible: false, lastValueVisible: true }, pi);
      macdLine.createPriceLine({ price: 0, color: "#ffffff22", lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      restretch();
    }
    const closes = currentCandles.map((c) => c.close);
    const m = computeMACD(closes, macdCfg.fast, macdCfg.slow, macdCfg.signal);
    const mk = (arr) => currentCandles.map((c, j) => (arr[j] != null ? { time: c.time, value: Math.round(arr[j] * 100) / 100 } : null)).filter(Boolean);
    macdLine.setData(mk(m.macd));
    macdSignal.setData(mk(m.signal));
    macdHist.setData(currentCandles.map((c, j) => (m.hist[j] != null ? { time: c.time, value: Math.round(m.hist[j] * 100) / 100, color: m.hist[j] >= 0 ? MACD_COLORS.up : MACD_COLORS.down } : null)).filter(Boolean));
    const n = closes.length - 1;
    const crossedUp = n > 0 && m.macd[n] != null && m.signal[n] != null && m.macd[n - 1] != null && m.signal[n - 1] != null && m.macd[n] >= m.signal[n] && m.macd[n - 1] < m.signal[n - 1];
    const crossedDn = n > 0 && m.macd[n] != null && m.signal[n] != null && m.macd[n - 1] != null && m.signal[n - 1] != null && m.macd[n] < m.signal[n] && m.macd[n - 1] >= m.signal[n - 1];
    macdAt = { macd: m.macd[n], signal: m.signal[n], hist: m.hist[n], cross: crossedUp ? "bull" : crossedDn ? "bear" : null };
  } else if (macdHist) {
    [macdLine, macdSignal, macdHist].forEach((s) => { if (s) { try { chart.removeSeries(s); } catch (e) {} } });
    macdLine = macdSignal = macdHist = null;
    if (macdPane) { try { chart.removePane(macdPane.paneIndex()); } catch (e) {} macdPane = null; }
    macdAt = null; restretch();
  }
}

function _indRow(reg) {
  const live = LIVECFG[reg.id]();
  const params = (reg.params || []).map((p) =>
    `<input type="number" class="ind-p" data-id="${reg.id}" data-k="${p.k}"${p.float ? ' data-float="1" step="0.5"' : ""} min="${p.min}" max="${p.max}" value="${live[p.k]}" title="${p.lbl}" aria-label="${reg.label} ${p.lbl}">`).join("");
  const note = reg.note ? `<div class="ind-note">${reg.note}</div>` : "";
  return `<label class="emarow"><input type="checkbox" class="ind-on" data-id="${reg.id}" ${live.on ? "checked" : ""}>
      <span class="emaswatch" style="background:${reg.swatch}"></span><span>${reg.label}</span>
      <span class="ind-params">${params}</span></label>${note}`;
}
function buildIndicatorPanel() {
  const pop = $("emaPop");
  const opts = INDSTORE.order.map((id) => { const p = INDSTORE.profiles[id]; if (!p) return "";
    return `<option value="${id}" ${id === INDSTORE.active ? "selected" : ""}>${_esc(p.name)}${p.builtin ? "" : " ✎"}</option>`; }).join("");
  const custom = !(_activeProfile() || {}).builtin;
  let html = `<div class="indhead">
      <select id="indProfSel" class="indsel" title="Trading-style profile">${opts}</select>
      <div class="indbtns">
        <button id="indNew" class="indbtn" title="Save current settings as a new profile">＋</button>
        <button id="indReset" class="indbtn" title="Reset this profile to its defaults">⟲</button>
        ${custom ? '<button id="indDel" class="indbtn" title="Delete this profile">🗑</button>' : ""}
      </div></div>`;
  IND_CATS.forEach((cat) => {
    const regs = IND_REGISTRY.filter((r) => r.cat === cat);
    if (!regs.length) return;
    html += `<div class="indsec">${cat}</div>`;
    regs.forEach((r) => {
      if (r.kind === "ema") html += emaConfig.map((cfg, i) =>
        `<label class="emarow"><input type="checkbox" class="ind-ema-on" data-i="${i}" ${cfg.on ? "checked" : ""}>
          <span class="emaswatch" style="background:${EMA_COLORS[i]}"></span><span>EMA</span>
          <span class="ind-params"><input type="number" class="ind-ema-p" data-i="${i}" min="1" max="400" value="${cfg.period}" aria-label="EMA period"></span></label>`).join("");
      else html += _indRow(r);
    });
  });
  html += `<div class="indsec">Analysis</div>
    <label class="emarow"><input type="checkbox" class="ta-on" ${taCfg.on ? "checked" : ""}>
      <span class="emaswatch" style="background:#2563EB"></span><span>Analysis summary</span></label>
    <div class="ind-note">A plain-English read of your selected indicators, below the chart. Descriptive only — not a prediction or advice.</div>`;
  html += `<div class="emahint">Chart overlays only — your BUY/SELL signals always use the weekly 9/21 &amp; 21/50 method, whatever you display here.</div>`;
  pop.innerHTML = html;
  pop.onchange = (e) => {
    const t = e.target;
    if (t.id === "indProfSel") { switchProfile(t.value); return; }
    if (t.classList.contains("ta-on")) { taCfg.on = t.checked; saveTaCfg(); renderTASummary(); return; }
    if (t.classList.contains("ind-ema-on")) { const i = +t.dataset.i; emaConfig[i].on = t.checked; saveEmaCfg(); applyEMAs(); _syncActiveFromLive(); renderTASummary(); setTimeout(fitChart, 40); return; }
    if (t.classList.contains("ind-ema-p")) { const i = +t.dataset.i; const v = Math.max(1, Math.min(400, parseInt(t.value) || 1)); emaConfig[i].period = v; t.value = v; saveEmaCfg(); applyEMAs(); _syncActiveFromLive(); renderTASummary(); return; }
    if (t.classList.contains("ind-on")) { const id = t.dataset.id; LIVECFG[id]().on = t.checked; SAVECFG[id](); APPLYCFG[id](); _syncActiveFromLive(); renderTASummary(); setTimeout(fitChart, 40); return; }
    if (t.classList.contains("ind-p")) {
      const id = t.dataset.id, k = t.dataset.k;
      let v = t.dataset.float ? parseFloat(t.value) : parseInt(t.value);
      if (isNaN(v)) v = LIVECFG[id]()[k];
      v = Math.max(+t.min, Math.min(+t.max, v)); t.value = v;
      LIVECFG[id]()[k] = v; SAVECFG[id](); APPLYCFG[id](); _syncActiveFromLive(); renderTASummary();
    }
  };
  pop.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "indNew") newProfile();
    else if (b.id === "indReset") resetProfile();
    else if (b.id === "indDel") deleteProfile();
  };
}
function switchProfile(id) {
  if (!INDSTORE.profiles[id]) return;
  INDSTORE.active = id; saveIndStore();
  _liveFromCfg(_getActiveCfg()); _applyActiveToChart(); buildIndicatorPanel();
}
function newProfile() {
  const name = (prompt("Name this profile:", "My profile") || "").trim();
  if (!name) return;
  const id = "cust_" + Date.now().toString(36);
  INDSTORE.profiles[id] = { name, builtin: false, cfg: _cfgFromLive() };
  INDSTORE.order.push(id); INDSTORE.active = id; saveIndStore();
  buildIndicatorPanel();
  if (typeof showToast === "function") showToast("Saved profile: " + name, "ok");
}
function resetProfile() {
  const id = INDSTORE.active;
  const def = IND_BUILTINS[id] ? _clone(IND_BUILTINS[id].cfg) : _clone(IND_BUILTINS.short.cfg);
  INDSTORE.profiles[id].cfg = def; saveIndStore();
  _liveFromCfg(def); _applyActiveToChart(); buildIndicatorPanel();
  if (typeof showToast === "function") showToast("Profile reset to defaults", "ok");
}
function deleteProfile() {
  const id = INDSTORE.active;
  if (IND_BUILTINS[id] || (_activeProfile() || {}).builtin) return;
  if (!confirm("Delete this profile?")) return;
  delete INDSTORE.profiles[id];
  INDSTORE.order = INDSTORE.order.filter((x) => x !== id);
  INDSTORE.active = INDSTORE.order[0]; saveIndStore();
  _liveFromCfg(_getActiveCfg()); _applyActiveToChart(); buildIndicatorPanel();
}
$("emaBtn").addEventListener("click", (e) => { e.stopPropagation(); buildIndicatorPanel(); $("emaPop").classList.toggle("hidden"); });
document.addEventListener("click", (e) => {
  if (!$("emaPop").contains(e.target) && e.target.id !== "emaBtn") $("emaPop").classList.add("hidden");
});

/* ---------- Search / detail ---------- */
async function loadStock(sym, tf) {
  currentSym = sym;
  if (tf) currentTf = tf;
  updateStarBtn();
  showPage("search");
  $("searchEmpty").classList.add("hidden");
  $("detail").classList.remove("hidden");
  $("chartMsg").textContent = "";
  if (!chartReady) initChart();
  document.querySelectorAll(".tfbtn").forEach((b) => b.classList.toggle("active", b.dataset.tf === currentTf));
  $("chartError").classList.add("hidden");
  $("chartLoading").classList.remove("hidden");
  try {
    const res = await fetch("/api/stock?symbol=" + encodeURIComponent(sym) + "&tf=" + currentTf);
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) throw { code: d.error || "server_error", message: d.message || ("HTTP " + res.status) };
    renderChart(d);
    renderDetail(d);
  } catch (e) {
    showChartError(sym, e);
  } finally { $("chartLoading").classList.add("hidden"); }
}
function showChartError(sym, e) {
  const code = e && e.code, name = (sym || "").replace(".NS", "");
  let o;
  if (code === "not_found") o = { ic: "🔎", t: "Not on the feed", m: `<b>${name}</b> may be delisted, renamed, or mistyped — check the symbol or try another.`, retry: false };
  else if (code === "feed_down") o = { ic: "📡", t: "Feed unavailable", m: "Can't reach the price feed right now — this is usually temporary.", retry: true };
  else if (code === "no_data") o = { ic: "📭", t: "No data", m: `No price data for <b>${name}</b> right now.`, retry: true };
  else o = { ic: "⚠️", t: "Couldn't load", m: (e && e.message) || "Something went wrong.", retry: true };
  $("detailPanel").innerHTML = "";
  $("chartError").innerHTML = `<div class="cherr-ic">${o.ic}</div><div class="cherr-t">${o.t}</div>
    <div class="cherr-m">${o.m}</div>${o.retry ? '<button class="btn sm" id="chartRetry">↻ Retry</button>' : ""}`;
  $("chartError").classList.remove("hidden");
  const rb = document.getElementById("chartRetry");
  if (rb) rb.addEventListener("click", () => loadStock(sym, currentTf));
}

function freshnessText(asOf) {
  if (!asOf) return "";
  const ms = asOf * 1000, dt = new Date(ms);
  const t = dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  const ageMin = Math.round((Date.now() - ms) / 60000);
  if (ageMin <= 25 && ageMin >= 0) return `as of ${t} IST · ~${Math.max(ageMin, 1)} min delayed`;
  const day = dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  return `last quote ${t} IST · ${day}`;
}
function renderChart(d) {
  currentCandles = d.candles;
  candle.setData(d.candles);
  vol.setData(d.candles.map((c) => ({ time: c.time, value: c.volume,
    color: c.close >= c.open ? "rgba(21,184,112,.35)" : "rgba(240,68,68,.35)" })));
  applyEMAs();
  applyBollinger();
  applySupertrend();
  applyRSI();
  applyMACD();
  applyVolume();
  applySMA();
  applyDonchian();
  applyIchimoku();
  applyKeltner();
  applyADX();
  applyATR();
  applyStochRSI();
  applyCCI();
  applyOBV();
  applyVWAP();
  applyAnchoredVWAP();
  applyVolumeProfile();
  applyPivots();
  applyFib();
  applyAutoSR();
  if (markersPrim) markersPrim.setMarkers(d.markers || []);
  fitChart();
  $("cSym").textContent = d.symbol.replace(".NS", "");
  document.title = d.symbol.replace(".NS", "") + " · Trader";
  $("cPrice").textContent = d.price != null ? "₹" + fmt(d.price) : "";
  $("cFresh").textContent = freshnessText(d.as_of);
  const chg = (d.last_close != null && d.prev_close) ? (d.last_close - d.prev_close) / d.prev_close * 100 : null;
  const ce = $("cChg");
  ce.textContent = chg != null ? (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" : "";
  ce.className = "cchg " + (chg >= 0 ? "up" : "down");
  setLive();
}

document.querySelectorAll(".tfbtn").forEach((b) =>
  b.addEventListener("click", () => { if (currentSym) loadStock(currentSym, b.dataset.tf); }));

function regimeLine(p) {
  if (!p) return "<span class='down'>n/a</span>";
  const cls = p.regime === "above" ? "up" : "down";
  let ex = p.fresh_bull ? " — fresh cross ▲" : p.fresh_bear ? " — fresh cross ▼" : "";
  return `<span class='${cls}'>fast ${fmt(p.fast)} ${p.regime === "above" ? "≥" : "<"} slow ${fmt(p.slow)} · ${p.regime}${ex}</span>`;
}
function gateRow(g) {
  const v = (g.value == null ? "n/a" : (typeof g.value === "number" ? fmt(g.value) : g.value)) + (g.unit || "");
  return `<div class="row"><span>${g.pass ? "✓" : "✗"} ${g.name}</span><span class="r-v ${g.pass ? "ok" : "no"}">${v} <span style="color:#5b6475;font-weight:400">${g.thresh}</span></span></div>`;
}

function statusStrip(s9, s21) {
  function seg(label, p) {
    if (!p) return `<div class="ss-seg"><span class="ss-dot off"></span><span class="ss-l">${label}</span><span class="ss-v">n/a</span></div>`;
    const up = p.regime === "above", fresh = p.fresh_bull || p.fresh_bear;
    return `<div class="ss-seg${fresh ? " fresh" : ""}"><span class="ss-dot ${up ? "up" : "down"}"></span>
      <span class="ss-l">${label}${fresh ? ' <span class="ss-spark">⚡ fresh</span>' : ""}</span>
      <span class="ss-v ${up ? "up" : "down"}">${up ? "▲ above" : "▼ below"}</span></div>`;
  }
  return `<div class="statusstrip" title="At-a-glance method state — the weekly 9/21 and 21/50 crossovers">${seg("9/21", s9)}${seg("21/50", s21)}</div>`;
}
function confluenceBlock(c) {
  if (!c) return "";
  const pct = Math.round(c.bull / c.total * 100);
  const cls = c.side === "bullish" ? "bull" : c.side === "bearish" ? "bear" : "mixed";
  const head = c.side === "mixed" ? `${c.bull} / ${c.total} — mixed signals` : `${c.bull} of ${c.total} aligned ${c.side}`;
  const chips = c.votes.map((v) => `<span class="cvote ${v.bull ? "b" : "s"}${v.core ? " core" : ""}" title="${v.core ? "method core" : "confirmation"}">${v.name} ${v.bull ? "▲" : "▼"}</span>`).join("");
  return `<div class="block conf ${cls}"><h3>Signal confluence</h3>
     <div class="conf-head">${head}</div>
     <div class="conf-bar ${cls}"><i style="width:${pct}%"></i></div>
     <div class="conf-votes">${chips}</div>
     <div class="note"><b>Underlined</b> = your method core (weekly 9/21 &amp; 21/50); RSI &amp; MACD are confirmation.</div></div>`;
}
/* ---------- Smart analysis (Phase A): plain-English explanation + trading perspectives ---------- */
// All of this READS the existing engine output + separate daily/intraday candles.
// It never changes the weekly 9/21·21/50 signal, the completed-candle rule, or any
// BUY/SELL logic — it only explains and contextualises them.
function explainSignal(d) {
  const v = d.verdict, s9 = d.signal_9_21, s21 = d.signal_21_50, q = d.quality, val = d.valuation;
  if (!v) return "";
  const parts = [];
  if (s9) {
    const rel = s9.regime === "above"
      ? `the 9-week EMA (₹${fmt(s9.fast)}) is above the 21-week EMA (₹${fmt(s9.slow)}), so the short-term trend is up`
      : `the 9-week EMA (₹${fmt(s9.fast)}) is below the 21-week EMA (₹${fmt(s9.slow)}), so the short-term trend is down`;
    const cross = s9.fresh_bull ? " — and it crossed up this week for the first time, a <b>fresh buy trigger</b>"
      : s9.fresh_bear ? " — and it crossed down this week, a <b>fresh sell trigger</b>"
      : " (no fresh cross this week)";
    parts.push("On the chart, " + rel + cross + ".");
  }
  if (s21) parts.push("The longer-term 21/50 trend is " + (s21.regime === "above" ? "<b>up</b> — a broader uptrend" : "<b>down</b> — the broader trend is weak") + " (21-week EMA ₹" + fmt(s21.slow) + " vs the 50-week).");
  if (q && q.available) parts.push("On fundamentals it " + (q.quality === "PASS" ? "<b>passes</b> the quality checks" : q.quality === "NEAR" ? "is <b>borderline</b> on quality" : "<b>fails</b> the quality checks") + (q.valuation ? " and looks <b>" + q.valuation.toLowerCase() + "</b> on valuation" : "") + ".");
  else parts.push("No curated fundamentals are on file for this stock, so this is a <b>chart &amp; signal only</b> read.");
  parts.push("This uses the last <b>completed</b> weekly candle (" + (d.last_week || "—") + ") — the weekly signal only changes when a week closes, never intra-week.");
  const net = v.headline.startsWith("STRONG") ? "STRONG BUY" : v.action;
  const why = v.action === "BUY" ? (q && q.available && q.quality === "PASS" ? "a fresh entry trigger inside an uptrend, with quality passing" : v.headline.startsWith("STRONG") ? "a fresh entry trigger inside a long-term uptrend" : "a fresh entry trigger, but check the caveats")
    : v.action === "SELL" ? "a fresh exit trigger (9/21 death cross)"
    : v.action === "HOLD" ? "the uptrend is intact, but there's no new entry trigger"
    : "there's no buy trigger yet (9/21 below)";
  return `<div class="explain"><div class="ex-text">${parts.join(" ")}</div><div class="ex-net"><b>In short:</b> ${net} — ${why}.</div><div class="ex-news" id="exNews" hidden></div></div>`;
}
// Fills the explanation's news-awareness line from the SAME /api/news data the
// News section uses — deterministic (no LLM): a count + the latest headline, so
// the explanation reflects the latest available news and auto-updates per stock.
function fillExplainNews(data) {
  const el = document.getElementById("exNews");
  if (!el) return;
  const items = (data && data.items) || [];
  if (!items.length) { el.hidden = true; return; }
  const top = items[0];
  const when = _newsAgo(top.date);
  const meta = [top.source, when].filter(Boolean).join(", ");
  el.innerHTML = `📰 <b>${items.length} recent ${items.length === 1 ? "headline" : "headlines"}</b> — latest: “${_esc(top.title)}”${meta ? " (" + _esc(meta) + ")" : ""}. `
    + `<span class="ex-news-note">News is context, not a signal — your BUY/SELL call stays on the weekly 9/21·21/50 method. See the News section below.</span>`;
  el.hidden = false;
}
function _trendFrom(closes) {
  if (!closes || closes.length < 22) return null;
  const e9 = computeEMA(closes, 9), e21 = computeEMA(closes, 21);
  const a = e9[e9.length - 1], b = e21[e21.length - 1];
  return (a == null || b == null) ? null : { up: a >= b };
}
function _rsiFrom(closes) { const r = computeRSI(closes, 14); return r.length ? r[r.length - 1] : null; }
function _levels(candles) {
  if (!candles || candles.length < 5) return null;
  const r = candles.slice(-40);
  return { support: Math.min(...r.map((c) => c.low)), resistance: Math.max(...r.map((c) => c.high)), last: candles[candles.length - 1].close };
}
async function loadPerspectives(d) {
  const host = document.getElementById("perspectives");
  if (!host) return;
  const sym = d.symbol;
  let daily = [], intraday = null, intradayErr = null;
  try { const dd = await (await fetch("/api/stock?symbol=" + encodeURIComponent(sym) + "&tf=D")).json(); daily = dd.candles || []; } catch (e) {}
  try { const id = await (await fetch("/api/intraday?symbol=" + encodeURIComponent(sym) + "&interval=15m")).json(); if (id && id.bars && id.bars.length) intraday = id; else intradayErr = (id && id.error) || "no_data"; } catch (e) { intradayErr = "feed_down"; }
  const dCl = daily.map((c) => c.close), dT = _trendFrom(dCl), dR = _rsiFrom(dCl), dL = _levels(daily);
  const iBars = intraday ? intraday.bars : [], iCl = iBars.map((c) => c.close), iT = _trendFrom(iCl), iR = _rsiFrom(iCl), iL = _levels(iBars);
  const wkUp = d.signal_21_50 && d.signal_21_50.regime === "above";
  const s9 = d.signal_9_21, up921 = s9 && s9.regime === "above", fresh = s9 && s9.fresh_bull, q = d.quality, val = d.valuation;
  const P = [];
  // Long-term
  P.push({ label: "Long-term investing", horizon: "months – years",
    verdict: (wkUp && q && q.available && q.quality === "PASS") ? "Suitable" : wkUp ? "Possible, with caveats" : "Not yet",
    reasons: [wkUp ? "Long-term 21/50 weekly trend is up." : "Long-term 21/50 weekly trend is down — wait for it to turn up.",
      q && q.available ? "Quality " + q.quality + (q.valuation ? " · valuation " + q.valuation : "") + "." : null].filter(Boolean),
    risks: [q && q.available ? null : "No curated fundamentals — quality unverified.",
      (val && val.applicable && val.flag) ? "5-model valuation is unreliable for this cyclical." : null,
      (val && val.applicable && val.upside_pct != null && val.upside_pct < -10) ? ("Trades above intrinsic value (" + val.upside_pct + "%).") : null].filter(Boolean),
    levels: null, note: "Your weekly method + quality + valuation." });
  // Swing
  P.push({ label: "Swing", horizon: "2 – 8 weeks",
    verdict: (fresh && wkUp) ? "Suitable" : up921 ? "Hold-friendly" : "Not yet",
    reasons: [up921 ? "Weekly 9/21 is in an uptrend (entry side positive)." : "Weekly 9/21 is below — no swing entry trigger.",
      fresh ? "Fresh 9/21 cross this week — a timely swing entry." : null,
      dT ? ("Daily trend is " + (dT.up ? "up" : "down") + ".") : null].filter(Boolean),
    risks: ["Weekly signals change only on a weekly close — can lag intra-week moves."],
    levels: dL, note: "" });
  // Short-term (daily, delayed)
  if (!dT) P.push({ label: "Short-term", horizon: "a few days", verdict: "Not enough data", reasons: ["Not enough daily history to read a short-term trend."], risks: [], levels: dL, note: "Daily · ~15-min delayed", delayed: true });
  else P.push({ label: "Short-term", horizon: "a few days",
    verdict: (dT.up && dR != null && dR < 70 && dR > 45) ? "Watchable" : dT.up ? "Up but stretched" : "Not yet",
    reasons: ["Daily trend is " + (dT.up ? "up (9-day EMA above 21-day)" : "down") + ".", dR != null ? ("Daily RSI " + Math.round(dR) + " (" + (dR >= 70 ? "overbought" : dR <= 30 ? "oversold" : "neutral") + ").") : ""].filter(Boolean),
    risks: ["Uses end-of-day data that's ~15-min delayed — not for precise day timing."], levels: dL, note: "Daily · ~15-min delayed", delayed: true });
  // Intraday (DELAYED — heavily labelled)
  if (intradayErr || !iT) P.push({ label: "Intraday", horizon: "minutes – hours", verdict: "Not reliable", reasons: [], risks: ["Needs real-time data. Yahoo is ~15-min delayed and not licensed for live intraday — any intraday read here is illustrative only, never for live entries/exits."], levels: iL, note: "⚠ DELAYED ~15 min — not for live trading", delayed: true });
  else P.push({ label: "Intraday", horizon: "minutes – hours", verdict: "Illustrative only",
    reasons: ["15-minute trend is " + (iT.up ? "up" : "down") + " (9/21 EMA on 15-min candles).", iR != null ? ("15-min RSI " + Math.round(iR) + ".") : ""].filter(Boolean),
    risks: ["⚠ This is ~15-MINUTE DELAYED data — NOT real-time. Do NOT use it for live intraday entries or exits. Shown for context only."],
    levels: iL, note: "⚠ DELAYED ~15 min — not for live trading", delayed: true });
  host.innerHTML = `<div class="d-grid">` + P.map(perspectiveCard).join("") + `</div>`;
}
function perspectiveCard(p) {
  const vcls = /suitable/i.test(p.verdict) ? "ok" : /not|reliable|enough/i.test(p.verdict) ? "no" : "near";
  const lv = p.levels ? `<div class="psp-lv"><span>Support ₹${fmt(p.levels.support)}</span><span>Now ₹${fmt(p.levels.last)}</span><span>Resistance ₹${fmt(p.levels.resistance)}</span></div>` : "";
  return `<div class="block psp ${p.delayed ? "delayed" : ""}">
      <div class="psp-h"><h3>${p.label}</h3><span class="psp-hz">${p.horizon}</span></div>
      <div class="psp-v ${vcls}">${p.verdict}</div>
      ${p.reasons.length ? `<div class="subtitle">Why</div>${p.reasons.map((r) => `<div class="psp-r">• ${r}</div>`).join("")}` : ""}
      ${p.risks.length ? `<div class="subtitle">Risks</div>${p.risks.map((r) => `<div class="psp-risk">⚠ ${r}</div>`).join("")}` : ""}
      ${lv}
      ${p.note ? `<div class="psp-note">${p.note}</div>` : ""}</div>`;
}

/* ---------- News (Phase B) — facts only, no sentiment/impact label ----------
   Reads /api/news (Google News RSS, parsed server-side). Headline, source,
   date and link only. Graceful on no news / feed failure. Does not touch the
   weekly engine or any signal. */
function _esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function _newsAgo(iso) {
  if (!iso) return "";
  const t = Date.parse(iso); if (isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return mins <= 1 ? "just now" : mins + " min ago";
  const hrs = Math.round(mins / 60); if (hrs < 24) return hrs + "h ago";
  const days = Math.round(hrs / 24); if (days < 30) return days + "d ago";
  try { return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch (e) { return new Date(t).toLocaleDateString(); }
}
async function loadNews(sym) {
  const host = document.getElementById("newsBox");
  if (!host) return;
  let data = null;
  try { data = await (await fetch("/api/news?symbol=" + encodeURIComponent(sym))).json(); }
  catch (e) { host.innerHTML = `<div class="block"><div class="note">News is unavailable right now. The feed couldn't be reached — this doesn't affect prices or signals.</div></div>`; return; }
  fillExplainNews(data); // surface the latest headline in the explanation (deterministic)
  const items = (data && data.items) || [];
  if (!items.length) {
    host.innerHTML = `<div class="block"><div class="note">${_esc((data && data.note) || "No recent news found for this company.")}</div></div>`;
    return;
  }
  const rows = items.map((it) => {
    const when = _newsAgo(it.date);
    const meta = [it.source ? _esc(it.source) : "", when].filter(Boolean).join(" · ");
    return `<a class="news-item" href="${_esc(it.link)}" target="_blank" rel="noopener noreferrer">
        <div class="news-title">${_esc(it.title)}</div>
        ${it.snippet ? `<div class="news-snip">${_esc(it.snippet)}</div>` : ""}
        <div class="news-meta">${meta}${meta ? " · " : ""}<span class="news-go">open ↗</span></div>
      </a>`;
  }).join("");
  host.innerHTML = `<div class="news-list">${rows}</div>
    <div class="news-foot">Headlines via Google News · dates are as reported · opens the original source. Not investment advice.</div>`;
}
function renderDetail(d) {
  const v = d.verdict, q = d.quality, val = d.valuation;
  const strong = v.headline.startsWith("STRONG");
  const cls = strong ? "STRONG" : v.action;
  let combined = "";
  if (q && q.available) {
    if (v.action === "BUY" && q.quality === "PASS") combined = "✅ <b>Quality ✓ + buy trigger</b> — both halves align.";
    else if (v.action === "BUY" && q.quality === "FAIL") combined = "⚠️ <b>Chart-only</b> — trigger but fails quality.";
  }
  // EMA values come straight from the engine's signal pairs (9/21 and 21/50).
  const s9 = d.signal_9_21, s21 = d.signal_21_50;
  const e9 = s9 ? s9.fast : null, e21 = s9 ? s9.slow : (s21 ? s21.fast : null), e50 = s21 ? s21.slow : null;
  const emaRow = (lbl, col, val2) => `<div class="row"><span><span class="ema-dot" style="background:${col}"></span>${lbl}</span><span class="r-v">${val2 != null ? "₹" + fmt(val2) : "—"}</span></div>`;
  const crossTxt = !s9 ? "—"
    : s9.fresh_bull ? '<span class="up">▲ Fresh bullish cross this week</span>'
    : s9.fresh_bear ? '<span class="down">▼ Fresh bearish cross this week</span>'
    : s9.regime === "above" ? '<span class="up">▲ Above (uptrend, no fresh cross)</span>'
    : '<span class="down">▼ Below (downtrend)</span>';
  const trendTxt = !s21 ? "—" : s21.regime === "above" ? '<span class="up">▲ Long-term uptrend</span>' : '<span class="down">▼ Long-term downtrend</span>';

  const rsiArr = computeRSI((d.candles || []).map((c) => c.close), rsiCfg.period);
  const rv = rsiArr.length ? rsiArr[rsiArr.length - 1] : null;
  const rs = rsiState(rv);
  const rsiHtml = rv == null ? "" : `<div class="subtitle">Momentum — RSI ${rsiCfg.period}</div>
     <span class="${rs.state === "overbought" ? "down" : rs.state === "oversold" ? "up" : ""}">${Math.round(rv * 10) / 10} · ${rs.state || "neutral"}</span>`;
  const mm = computeMACD((d.candles || []).map((c) => c.close), macdCfg.fast, macdCfg.slow, macdCfg.signal);
  const mi = mm.macd.length - 1;
  const mMacd = mm.macd[mi], mSig = mm.signal[mi], mHist = mm.hist[mi];
  const macdHtml = (mMacd == null || mSig == null) ? "" : `<div class="subtitle">Momentum — MACD ${macdCfg.fast}/${macdCfg.slow}/${macdCfg.signal}</div>
     <span class="${mMacd >= mSig ? "up" : "down"}">${mMacd >= mSig ? "bullish" : "bearish"} · hist ${mHist >= 0 ? "+" : ""}${Math.round(mHist * 100) / 100}</span>`;

  // ---- Section 1: Trading signal & technical analysis ----
  let html = `<nav class="d-subnav">
      <button data-anchor="d-analysis" class="active">Analysis</button>
      <button data-anchor="d-fundamentals">Fundamentals</button>
      <button data-anchor="d-news">News</button></nav>
    <section class="d-sec" id="d-analysis">
    <h2 class="d-h"><span class="d-num">1</span>Trading signal &amp; technical analysis</h2>
    ${explainSignal(d)}
    <div class="d-grid">
      <div class="block verdict ${cls}"><div class="vaction">${strong ? "STRONG BUY" : v.action}</div>
        <div class="vhead">${v.headline}</div>${combined ? `<div class="vnote">${combined}</div>` : ""}</div>
      <div class="block"><h3>Moving averages (weekly)</h3>
        ${emaRow("EMA 9", "#eab308", e9)}${emaRow("EMA 21", "#3b82f6", e21)}${emaRow("EMA 50", "#f97316", e50)}
        <div class="subtitle">9 / 21 — entry</div><div class="d-line">${crossTxt}</div>
        <div class="subtitle">21 / 50 — trend</div><div class="d-line">${trendTxt}</div>
        <div class="subtitle">Completed weekly candle</div><div class="d-line">${d.last_week || "—"}</div></div>
      <div class="block"><h3>Signals</h3>
        <div class="subtitle">Short-term 9 / 21 (entry)</div>${regimeLine(d.signal_9_21)}
        <div class="subtitle">Long-term 21 / 50 (trend)</div>${regimeLine(d.signal_21_50)}
        ${rsiHtml}${macdHtml}</div>
      <div class="block"><h3>Confluence &amp; momentum</h3>${statusStrip(d.signal_9_21, d.signal_21_50)}${confluenceBlock(d.confluence)}</div>
    </div></section>
    <div id="taSummaryWrap"></div>
    <section class="d-sec"><h2 class="d-h"><span class="d-num">2</span>Trading perspectives — how to trade this</h2>
      <div id="perspectives"><div class="scanhint"><span class="spinner"></span>Analysing across timeframes…</div></div></section>`;

  // ---- Section 2: Fundamentals & quality ----
  html += `<section class="d-sec" id="d-fundamentals"><h2 class="d-h"><span class="d-num">3</span>Fundamentals &amp; quality</h2><div class="d-grid">`;
  if (q && q.available) {
    const qcls = { PASS: "ok", NEAR: "near", FAIL: "no" }[q.quality] || "";
    const vcls = { CHEAP: "ok", FAIR: "near", EXPENSIVE: "no" }[q.valuation] || "";
    html += `<div class="block"><h3>Business quality <span style="color:var(--faint);font-weight:400">as of ${q.as_of}</span></h3>
        <div style="display:flex;gap:6px;margin-bottom:8px"><span class="pill ${qcls}">QUALITY ${q.quality} (${q.quality_passed}/${q.quality_total})</span></div>
        ${q.quality_gates.map(gateRow).join("")}</div>
      <div class="block"><h3>Valuation &amp; ownership</h3>
        <div style="display:flex;gap:6px;margin-bottom:8px"><span class="pill ${vcls}">${q.valuation}</span></div>
        ${q.value_gates.map(gateRow).join("")}
        ${q.flag ? `<div class="flagnote">⚠ ${q.flag}</div>` : ""}</div>`;
  } else {
    html += `<div class="block"><h3>Business quality</h3><div class="note">No fundamentals on file for this stock — it shows chart &amp; signal only (not in the curated quality universe).</div></div>`;
  }
  html += `</div></section>`;

  // ---- Section 3: Valuation ----
  html += `<section class="d-sec"><h2 class="d-h"><span class="d-num">4</span>Valuation</h2><div class="d-grid">`;
  if (val && val.applicable) {
    const up = val.upside_pct;
    const upPill = val.flag
      ? `<span class="pill unreliable" title="Unreliable for cyclicals — a sanity check, not a price target">~${up == null ? "—%" : (up >= 0 ? "+" + up : up) + "%"} ⚠ unreliable</span>`
      : `<span class="pill ${up == null ? "" : (up >= 0 ? "ok" : "no")}">${up == null ? "—" : (up >= 0 ? "+" + up + "% upside" : up + "% downside")}</span>`;
    html += `<div class="block"><h3>Intrinsic value <span style="color:var(--faint);font-weight:400">5-model</span></h3>
        <div style="display:flex;gap:6px;margin-bottom:8px"><span class="pill">₹${val.intrinsic != null ? fmt(val.intrinsic) : "—"}</span>${upPill}</div>
        ${val.models.map((m) => `<div class="row"><span>${m.name}</span><span class="r-v">${m.value != null ? "₹" + fmt(m.value) : "—"}</span></div>`).join("")}
        ${val.flag ? `<div class="flagnote">⚠ ${val.flag} — unreliable for cyclicals.</div>` : ""}
        <div class="note">Rough estimate on generic assumptions · ${val.used}/5 models · a sanity check, not a price target.</div></div>`;
  } else {
    html += `<div class="block"><h3>Intrinsic value</h3><div class="note">${(val && val.note) || "Valuation isn't computed for this stock (e.g. banks, or no fundamentals on file)."}</div></div>`;
  }
  html += `</div></section>`;

  // ---- Section 4: Company information (only what the app actually has) ----
  const sym = d.symbol || "";
  const exch = /\.NS$/i.test(sym) ? "NSE · India" : /\.BO$/i.test(sym) ? "BSE · India" : "—";
  const coName = (q && q.name) || sym.replace(/\.(NS|BO)$/i, "");
  const seg = q && q.type ? (q.type === "bank" ? "Banking / financials" : q.type) : null;
  const infoRow = (l, val2) => `<div class="row"><span>${l}</span><span class="r-v">${val2}</span></div>`;
  html += `<section class="d-sec"><h2 class="d-h"><span class="d-num">5</span>Company information</h2><div class="d-grid">
      <div class="block"><h3>Overview</h3>
        ${infoRow("Company", coName)}
        ${infoRow("Symbol", sym)}
        ${infoRow("Exchange", exch)}
        ${infoRow("Currency", d.currency || "INR")}
        ${seg ? infoRow("Segment", seg) : ""}
        ${infoRow("Fundamentals", q && q.available ? "Curated · as of " + q.as_of : "Not on file")}
        <div class="d-note">Sector, industry and a company description aren't in the current data set — the app focuses on the weekly method, quality and valuation. These can be added in a later phase with a fundamentals data source.</div></div>
    </div></section>`;

  // ---- Section 6: Latest news (facts only — headline, source, date, link) ----
  html += `<section class="d-sec" id="d-news"><h2 class="d-h"><span class="d-num">6</span>Latest news</h2>
      <div id="newsBox"><div class="scanhint"><span class="spinner"></span>Loading news…</div></div></section>`;

  $("detailPanel").innerHTML = html;
  lastStockData = d;
  wireDetailSubnav();  // sticky Analysis/Fundamentals/News jump nav
  renderTASummary();   // optional plain-English summary (from selected indicators), when enabled
  loadPerspectives(d); // async: fills the Trading-perspectives section (daily + delayed intraday)
  loadNews(d.symbol);  // async: fills the Latest-news section (Google News RSS, facts only)
}

/* ---------- search autocomplete (R-2) ---------- */
let SYMBOLS = [];
fetch("symbols.json").then((r) => r.json()).then((d) => { SYMBOLS = d; }).catch(() => {});

function searchSymbols(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const starts = [], has = [];
  for (const s of SYMBOLS) {
    const n = s.n.toLowerCase(), t = s.t.toLowerCase();
    if (n.startsWith(q) || t.startsWith(q)) starts.push(s);
    else if (n.includes(q) || t.includes(q)) has.push(s);
  }
  return starts.concat(has).slice(0, 12);
}
function hl(name, q) {
  q = q.trim().toLowerCase();
  const i = name.toLowerCase().indexOf(q);
  if (i < 0 || !q) return name;
  return name.slice(0, i) + "<b>" + name.slice(i, i + q.length) + "</b>" + name.slice(i + q.length);
}
function attachAutocomplete(input, drop, onPick) {
  let idx = -1, items = [];
  function paint() {
    drop.innerHTML = items.map((s, i) =>
      `<div class="acitem${i === idx ? " active" : ""}" data-i="${i}">
        <span class="ac-n">${hl(s.n, input.value)}</span><span class="ac-t">${s.t.replace(".NS", "")}</span></div>`).join("");
    drop.querySelectorAll(".acitem").forEach((el) =>
      el.addEventListener("mousedown", (e) => { e.preventDefault(); pick(items[+el.dataset.i]); }));
  }
  function show() { items = searchSymbols(input.value); if (!items.length) return hide(); paint(); drop.classList.remove("hidden"); }
  function hide() { drop.classList.add("hidden"); drop.innerHTML = ""; idx = -1; }
  function pick(s) { if (!s) return; hide(); onPick(s); }
  input.addEventListener("input", () => { idx = -1; show(); });
  input.addEventListener("keydown", (e) => {
    if (drop.classList.contains("hidden")) {
      if (e.key === "Enter" && (input.id === "searchInput" || input.id === "globalSearch") && input.value.trim()) {
        e.preventDefault();
        let s = input.value.trim().toUpperCase(); if (!s.includes(".")) s += ".NS";
        loadStock(s);
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(idx - 1, 0); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(items[idx >= 0 ? idx : 0]); }
    else if (e.key === "Escape") hide();
  });
  input.addEventListener("blur", () => setTimeout(hide, 150));
}
attachAutocomplete($("searchInput"), $("searchDrop"), (s) => loadStock(s.t));
attachAutocomplete($("hSym"), $("hSymDrop"), (s) => { $("hSym").value = s.t; $("hBuy").focus(); });
// top-bar global search → load the stock (navigates to the chart view)
if ($("globalSearch")) {
  attachAutocomplete($("globalSearch"), $("globalSearchDrop"), (s) => { loadStock(s.t); $("globalSearch").value = ""; });
  // "/" focuses search (unless already typing in a field)
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || "")) && !e.target.isContentEditable) {
      e.preventDefault(); $("globalSearch").focus();
    }
  });
}
if ($("profileBtn")) $("profileBtn").addEventListener("click", () => showToast("Single-user app — your data stays in this browser.", "ok"));

/* ---------- toast + add-to-holdings (R-5) ---------- */
function showToast(msg, kind) {
  const t = document.createElement("div");
  t.className = "toast " + (kind === "err" ? "err" : "ok");
  t.innerHTML = `<span class="ic">${kind === "err" ? "⚠" : "✓"}</span><span>${msg}</span>`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 320); }, 2200);
}
async function addHolding(sym, label) {
  try {
    setHolding(sym, 1, null);
    showToast((label || sym.replace(".NS", "")) + " added to holdings", "ok");
    return true;
  } catch (e) { showToast("Couldn't add " + (label || sym), "err"); return false; }
}

/* ---------- Home (suggestions) ---------- */
let suggestions = [], activeFilter = "ALL", priceBand = "";
const PRICE_BANDS = [{ v: "", t: "All prices" }, { v: "penny", t: "Penny < ₹50" }, { v: "low", t: "₹50–200" }, { v: "mid", t: "₹200–1000" }, { v: "high", t: "Over ₹1000" }];
function inBand(price, band) {
  if (!band) return true;
  if (price == null) return false;
  if (band === "penny") return price < 50;
  if (band === "low") return price >= 50 && price < 200;
  if (band === "mid") return price >= 200 && price < 1000;
  if (band === "high") return price >= 1000;
  return true;
}
let sortMode = "signal";
const SORTS = [["signal", "Signal Strength"], ["priceDesc", "Price: High → Low"], ["priceAsc", "Price: Low → High"], ["chg", "1W Change"], ["name", "Name A–Z"]];
function sortRows(rows) {
  const r = rows.slice();
  if (sortMode === "priceDesc") r.sort((a, b) => (b.price == null ? -1 : b.price) - (a.price == null ? -1 : a.price));
  else if (sortMode === "priceAsc") r.sort((a, b) => (a.price == null ? 1e12 : a.price) - (b.price == null ? 1e12 : b.price));
  else if (sortMode === "chg") r.sort((a, b) => (b.chg1w == null ? -1e9 : b.chg1w) - (a.chg1w == null ? -1e9 : a.chg1w));
  else if (sortMode === "name") r.sort((a, b) => (a.name || a.symbol).localeCompare(b.name || b.symbol));
  return r; // "signal" keeps the server's rank order
}
const FILTER_ORDER = ["STRONG BUY", "BUY", "HOLD", "WAIT", "CHART-ONLY", "SELL"];
function whyText(x) {
  const q = x.quality;
  if (x.penny && !q) {
    // chart-and-signal only: quality not rated (outside the curated fundamentals set)
    if (x.category === "STRONG BUY" || x.category === "BUY") return "Buy cross on the chart — <b>quality not rated</b> (outside the curated quality universe).";
    if (x.category === "SELL") return "<b>Exit signal</b> — 9/21 death cross. Quality not rated.";
    return "No buy signal yet (9/21 below). <b>Quality not rated</b> — outside the curated quality universe.";
  }
  if (x.category === "STRONG BUY") return "Fresh <b>9/21 buy cross</b>, passes quality, and the <b>21/50 long-term trend is up</b>.";
  if (x.category === "BUY") return "Buy cross with " + (q === "PASS" ? "solid" : "acceptable") + " quality.";
  if (x.category === "CHART-ONLY") return "Has the buy cross but <b>fails quality</b> — avoid.";
  if (x.category === "HOLD") return "Uptrend intact — hold if you own it, no fresh entry.";
  if (x.category === "SELL") return "<b>Exit signal</b> — 9/21 death cross.";
  return "No buy signal yet (9/21 below).";
}
function upsidePill(x) {
  if (x.upside == null) return "";
  const u = Math.round(x.upside);
  if (x.upside_flag) return `<span class="pill unreliable" title="5-model value is unreliable for cyclicals — a sanity check, not a target">~${u >= 0 ? "+" + u : u}% ⚠</span>`;
  const cls = u >= 0 ? "upside" : "downside";
  return `<span class="pill ${cls}" title="vs 5-model intrinsic value">${u >= 0 ? "+" + u : u}% ${u >= 0 ? "upside" : "downside"}</span>`;
}
function cardConf(c) {
  if (!c) return "";
  const cls = c.side === "bullish" ? "bull" : c.side === "bearish" ? "bear" : "mixed";
  const dots = c.votes.map((v) => `<span class="cdot ${v.bull ? "b" : "s"}" title="${v.name} ${v.bull ? "bullish" : "bearish"}"></span>`).join("");
  return `<div class="cardconf ${cls}" title="Signal confluence: ${c.bull} of ${c.total} ${c.side}">${dots}<span class="cconf-n">${c.bull}/${c.total}</span><span class="cconf-side">${c.side}</span></div>`;
}
function sparkSVG(data) {
  if (!data || data.length < 2) return "";
  const w = 124, h = 38, pad = 3, n = data.length;
  const min = Math.min(...data), max = Math.max(...data), range = (max - min) || 1;
  const px = (i) => pad + i / (n - 1) * (w - 2 * pad);
  const py = (v) => pad + (1 - (v - min) / range) * (h - 2 * pad);
  const col = data[n - 1] >= data[0] ? "#15b870" : "#f04444";
  let line = "M" + px(0).toFixed(1) + " " + py(data[0]).toFixed(1);
  for (let i = 1; i < n; i++) line += " L" + px(i).toFixed(1) + " " + py(data[i]).toFixed(1);
  const area = line + " L" + px(n - 1).toFixed(1) + " " + h + " L" + px(0).toFixed(1) + " " + h + " Z";
  const gid = "sg" + Math.random().toString(36).slice(2, 7);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.26"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function logoTile(name, sym) {
  const s = (name || sym || "?").trim();
  const parts = s.split(/\s+/).filter(Boolean);
  const initials = (parts.length >= 2 ? parts[0][0] + parts[1][0] : s.slice(0, 2)).toUpperCase();
  let hsh = 0; for (let i = 0; i < s.length; i++) hsh = (hsh * 31 + s.charCodeAt(i)) % 360;
  const bg = `linear-gradient(135deg,hsl(${hsh},52%,44%),hsl(${(hsh + 42) % 360},54%,30%))`;
  return `<div class="sc-logo" style="background:${bg}">${initials}</div>`;
}
function cardHTML(x) {
  const bcls = CAT_BADGE[x.category] || "WAIT";
  const q = x.quality ? `<span class="pill ${x.quality === "PASS" ? "ok" : x.quality === "NEAR" ? "near" : "no"}">Q ${x.quality}</span>` : "";
  const val = x.valuation ? `<span class="pill ${x.valuation === "CHEAP" ? "ok" : x.valuation === "FAIR" ? "near" : "no"}">${x.valuation}</span>` : "";
  const chg = x.chg1w;
  const chgHtml = chg == null ? "" : `<span class="sc-chg ${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "+" : ""}${chg}%</span>`;
  const nm = (x.name || x.symbol).replace(/"/g, "&quot;");
  // weekly prev-close, stored so the live poll can recompute the weekly % from a fresh price
  const pc = (x.chg1w != null && x.price) ? (x.price / (1 + x.chg1w / 100)) : "";
  return `<div class="card stockcard" data-sym="${x.symbol}" data-pc="${pc}" tabindex="0" role="button" aria-label="${nm}, ${x.category}">
      <div class="sc-top">
        ${logoTile(x.name, x.symbol)}
        <div class="sc-id"><div class="sc-name">${x.name || x.symbol}</div><div class="sc-tkr">${x.symbol}</div></div>
        <div class="sc-price"><span class="sc-p">${x.price != null ? "₹" + fmt(x.price) : ""}</span>${chgHtml}</div>
        <div class="sc-spark">${sparkSVG(x.spark)}</div>
        <span class="badge ${bcls}">${x.category}</span>
      </div>
      <div class="sc-pills">${q}${val}${upsidePill(x)}${x.penny ? '<span class="pill" title="Not in the curated quality universe — chart & signal only">not rated</span>' : ""}</div>
      ${cardConf(x.confluence)}
      <div class="sc-why">${whyText(x)}</div>
      <div class="sc-foot">
        <span class="foot-note">Tap card for chart &amp; signal</span>
        <div class="foot-r">
          <button class="cardstar${isWatched(x.symbol) ? " on" : ""}" data-star="${x.symbol}" data-sn="${nm}" title="Watchlist">${isWatched(x.symbol) ? "★" : "☆"}</button>
          <button class="cardcmp${inCompare(x.symbol) ? " on" : ""}" data-cmp="${x.symbol}" data-cn="${nm}" title="Add to Compare" aria-label="Compare">⇄</button>
          <button class="cardalert" data-alert="${x.symbol}" data-an="${nm}" title="Set an alert" aria-label="Alert">🔔</button>
          <button class="addbtn" data-add="${x.symbol}" data-name="${nm}">+ Add</button>
        </div>
      </div></div>`;
}
function renderFilters() {
  const counts = { ALL: suggestions.length };
  suggestions.forEach((x) => { counts[x.category] = (counts[x.category] || 0) + 1; });
  const cats = ["ALL"].concat(FILTER_ORDER.filter((c) => counts[c]));
  const f = $("homeFilters");
  f.classList.remove("hidden");
  const catChips = cats.map((c) =>
    `<button class="chip${c === activeFilter ? " active" : ""}" data-f="${c}">${c === "ALL" ? "All" : c}<span class="n">${counts[c]}</span></button>`).join("");
  const priceOpts = PRICE_BANDS.map((p) => {
    const n = p.v ? suggestions.filter((x) => inBand(x.price, p.v)).length : suggestions.length;
    return `<option value="${p.v}"${priceBand === p.v ? " selected" : ""}>${p.t}${p.v ? ` (${n})` : ""}</option>`;
  }).join("");
  const sortOpts = SORTS.map(([v, t]) => `<option value="${v}"${sortMode === v ? " selected" : ""}>${t}</option>`).join("");
  f.innerHTML = `<div class="filterbar">
      <div class="filters">${catChips}</div>
      <div class="filtertools">
        <label class="ftl">Price <select id="fPrice" class="fsel">${priceOpts}</select></label>
        <label class="ftl">Sort <select id="fSort" class="fsel">${sortOpts}</select></label>
      </div></div>`;
  f.querySelectorAll("[data-f]").forEach((b) =>
    b.addEventListener("click", () => { activeFilter = b.dataset.f; renderFilters(); renderHomeCards(); }));
  const ps = document.getElementById("fPrice");
  if (ps) ps.addEventListener("change", () => { priceBand = ps.value; renderHomeCards(); });
  const ss = document.getElementById("fSort");
  if (ss) ss.addEventListener("change", () => { sortMode = ss.value; renderHomeCards(); });
}
function statIcon(kind) {
  const I = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 7-8"/><path d="M17 7h4v4"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L4 9.4l6-.8z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };
  return I[kind] || I.up;
}
function renderHomeStats() {
  const box = $("homeStats");
  if (!box) return;
  if (!suggestions.length) { box.innerHTML = ""; return; }
  const strong = suggestions.filter((x) => x.category === "STRONG BUY").length;
  const wait = suggestions.filter((x) => x.category === "WAIT").length;
  const chgs = suggestions.map((x) => x.chg1w).filter((v) => v != null);
  const avg = chgs.length ? chgs.reduce((a, b) => a + b, 0) / chgs.length : null;
  const card = (cls, ic, v, l) => `<div class="statcard ${cls}"><div class="st-ic">${statIcon(ic)}</div><div class="st-t"><div class="st-v">${v}</div><div class="st-l">${l}</div></div></div>`;
  box.innerHTML =
    card("green", "up", suggestions.length, "Total Picks") +
    card("green", "star", strong, "Strong Buy") +
    card("amber", "clock", wait, "Wait") +
    card(avg == null ? "blue" : (avg >= 0 ? "green" : "red"), "up", avg == null ? "—" : (avg >= 0 ? "+" : "") + avg.toFixed(1) + "%", "Avg 1W Return");
}
function wireStockCards(box) {
  box.querySelectorAll(".card").forEach((el) =>
    el.addEventListener("click", (e) => { if (!e.target.closest(".addbtn,.cardstar,.cardcmp,.cardalert")) loadStock(el.dataset.sym); }));
  box.querySelectorAll(".cardcmp").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const on = toggleCompare(b.dataset.cmp, b.dataset.cn);
      b.classList.toggle("on", on); b.title = on ? "In Compare — click to remove" : "Add to Compare";
      if (document.getElementById("page-compare").classList.contains("active")) loadCompare();
    }));
  box.querySelectorAll(".cardalert").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); quickAlert(b.dataset.alert, b.dataset.an); }));
  box.querySelectorAll(".addbtn").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (b.disabled) return;
      const ok = await addHolding(b.dataset.add, b.dataset.name);
      if (ok) { b.textContent = "✓ Added"; b.disabled = true; }
    }));
  box.querySelectorAll(".cardstar").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const on = toggleWatch(b.dataset.star, b.dataset.sn);
      b.classList.toggle("on", on); b.textContent = on ? "★" : "☆";
      if (currentSym === b.dataset.star) updateStarBtn();
      if (document.getElementById("page-watchlist").classList.contains("active")) loadWatchlist();
    }));
}
function renderHomeCards() {
  const box = $("homeCards");
  const rows = sortRows(suggestions.filter((x) =>
    (activeFilter === "ALL" || x.category === activeFilter) && inBand(x.price, priceBand)));
  box.innerHTML = rows.map(cardHTML).join("")
    || stateBox({ icon: "🗂️", title: "Nothing here", msg: "No stocks match these filters — try another category or price range." });
  wireStockCards(box);
}
/* ---- Markets curated landing (Phase R2) — picks + watchlist movers + fired alerts.
   Reuses the same scanner data + cardHTML; the full filterable grid stays below. */
function renderMarketPicks() {
  const box = $("marketPicks");
  if (!box) return;
  const picks = suggestions.filter((x) => x.category === "STRONG BUY" || x.category === "BUY").slice(0, 8);
  box.innerHTML = picks.length ? picks.map(cardHTML).join("")
    : stateBox({ icon: "🔍", title: "No fresh buy signals today", msg: "Nothing is on a STRONG BUY or BUY trigger right now. Browse the full universe below or in Screener." });
  if (picks.length) wireStockCards(box);
  const cur = $("marketCurated"); if (cur) cur.classList.remove("hidden");
  const br = $("browseAll"); if (br) br.classList.remove("hidden");
}
function renderMarketSide() {
  // Watchlist movers
  const wbox = $("marketWatch");
  if (wbox) {
    const w = getWatch();
    const byT = {}; suggestions.forEach((x) => { byT[(x.symbol || "").toUpperCase()] = x; });
    const rows = w.map((x) => byT[(x.t || "").toUpperCase()]).filter(Boolean)
      .sort((a, b) => Math.abs(b.chg1w || 0) - Math.abs(a.chg1w || 0)).slice(0, 5);
    if (!w.length) wbox.innerHTML = `<div class="mk-empty">Star a stock to track it here.</div>`;
    else if (!rows.length) wbox.innerHTML = `<div class="mk-empty">Your watched stocks aren’t in today’s scan.</div>`;
    else wbox.innerHTML = rows.map((x) => {
      const c = x.chg1w, cls = c == null ? "" : c >= 0 ? "up" : "down";
      return `<button class="mk-row" data-sym="${x.symbol}" type="button">
        <span class="mk-row-n">${x.name || x.symbol.replace(/\.(NS|BO)$/i, "")}</span>
        <span class="mk-row-r"><b>₹${fmt(x.price)}</b> <span class="${cls}">${c == null ? "" : (c >= 0 ? "+" : "") + c.toFixed(1) + "%"}</span></span></button>`;
    }).join("");
    wbox.querySelectorAll(".mk-row[data-sym]").forEach((b) => b.addEventListener("click", () => loadStock(b.dataset.sym)));
  }
  // Alerts fired
  const abox = $("marketAlerts");
  if (abox) {
    const all = getAlerts();
    const fired = all.filter((a) => a.fired && a.t).slice(0, 5);
    const active = all.filter((a) => !a.fired).length;
    if (fired.length) abox.innerHTML = fired.map((a) =>
      `<button class="mk-row alert" data-sym="${a.t}" type="button"><span class="mk-row-n">${alCondText(a)}</span></button>`).join("")
      + `<button class="mk-link" id="mkAllAlerts" type="button" style="margin-top:6px">Manage alerts →</button>`;
    else abox.innerHTML = `<div class="mk-empty">No alerts fired${active ? ` · ${active} armed` : ""}. <button class="mk-link" id="mkAllAlerts" type="button">Set an alert →</button></div>`;
    abox.querySelectorAll(".mk-row[data-sym]").forEach((b) => b.addEventListener("click", () => loadStock(b.dataset.sym)));
    const ma = document.getElementById("mkAllAlerts"); if (ma) ma.addEventListener("click", () => showPage("alerts"));
  }
}
async function loadSuggestions() {
  $("homeFilters").classList.add("hidden");
  $("homeCards").innerHTML =
    '<div class="scanhint"><span class="spinner"></span>Scanning your universe — live data, ~10–15s on a cold start…</div>' + skelCards(6);
  try {
    const d = await (await fetch("/api/scanner")).json();
    suggestions = d.results || [];
    if (suggestions.length && suggestions.every((x) => x.category === "ERROR")) {
      suggestions = [];
      $("homeFilters").classList.add("hidden"); $("homeStats").innerHTML = "";
      $("marketCurated").classList.add("hidden"); $("browseAll").classList.add("hidden");
      renderState($("homeCards"), { icon: "📡", title: "Feed unavailable", msg: "Can't reach the price feed to scan right now — this is usually temporary.", retry: true }, loadSuggestions);
      return;
    }
    renderHomeStats();
    renderMarketPicks();
    renderMarketSide();
    renderFilters();
    renderHomeCards();
    setLive();
  } catch (e) {
    $("homeStats").innerHTML = "";
    $("marketCurated").classList.add("hidden"); $("browseAll").classList.add("hidden");
    renderState($("homeCards"), { icon: "📡", title: "Scan failed", msg: "Couldn't run the scan. Check your connection and try again.", retry: true }, loadSuggestions);
  }
}
// Live-price in-place updater for the card lists (Home / Screeners / Watchlist).
// Uses the 15s quote cache (same source as the Dashboard) so these pages are
// genuinely fresh every poll — the scanner (signals/categories, 5-min cache) is
// refreshed on page load and manual Refresh, not on every tick.
async function updateCardPricesInPlace(container) {
  if (!container) return;
  const cards = [...container.querySelectorAll(".stockcard[data-sym]")];
  if (!cards.length) return;
  const syms = [...new Set(cards.map((c) => (c.dataset.sym || "").toUpperCase()))].filter(Boolean).slice(0, 50);
  if (!syms.length) return;
  const d = await (await fetch("/api/quote?symbols=" + encodeURIComponent(syms.join(",")))).json();
  const q = d.quotes || {};
  cards.forEach((card) => {
    const qt = q[(card.dataset.sym || "").toUpperCase()];
    if (!qt || qt.error || qt.price == null) return;
    const pEl = card.querySelector(".sc-p");
    if (pEl) { const nv = "₹" + fmt(qt.price); if (pEl.textContent !== nv) { pEl.textContent = nv; flashEl(pEl); } }
    const pc = parseFloat(card.dataset.pc);
    const cEl = card.querySelector(".sc-chg");
    if (cEl && pc > 0) { const chg = (qt.price / pc - 1) * 100; cEl.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"; cEl.className = "sc-chg " + (chg >= 0 ? "up" : "down"); }
  });
}
/* ---------- watchlist + star (R-7) ---------- */
function updateStarBtn() {
  const on = !!(currentSym && isWatched(currentSym));
  const b = $("starBtn");
  b.classList.toggle("on", on);
  b.textContent = on ? "★" : "☆";
  b.title = on ? "Remove from watchlist" : "Add to watchlist";
}
$("starBtn").addEventListener("click", () => {
  if (!currentSym) return;
  const sym = $("cSym").textContent;
  const label = (sym && sym !== "—") ? sym : currentSym.replace(".NS", "");
  const on = toggleWatch(currentSym, label);
  updateStarBtn();
  showToast(label + (on ? " added to watchlist" : " removed from watchlist"), "ok");
});
function watchErrCard(x) {
  return `<div class="stockcard" style="opacity:.75">
    <div class="sc-top">${logoTile(x.name, x.symbol)}
      <div class="sc-id"><div class="sc-name">${x.name}</div><div class="sc-tkr">${x.symbol} · unavailable on the feed</div></div>
      <button class="cardstar on" data-star="${x.symbol}" data-sn="${(x.name || "").replace(/"/g, "&quot;")}" title="Remove from watchlist" style="margin-left:auto">★</button></div></div>`;
}
async function loadWatchlist(quiet) {
  const w = getWatch();
  const box = $("watchCards");
  if (!box) return;
  box.className = "stocklist";
  if (!w.length) { box.innerHTML = stateBox({ icon: "★", title: "No watchlist yet", msg: "Star a stock from Home or any chart to track it here." }); return; }
  if (!quiet || !box.querySelector(".stockcard")) box.innerHTML = skelCards(Math.min(w.length, 6));
  let rows;
  try {
    const d = await (await fetch("/api/scan?symbols=" + encodeURIComponent(w.map((x) => x.t).join(",")))).json();
    const byT = {}; (d.results || []).forEach((r) => { byT[r.symbol] = r; });
    rows = w.map((x) => {
      const r = byT[x.t];
      if (!r || r.action === "ERROR") return { symbol: x.t, name: x.n, _err: true };
      if ((!r.name || r.name === x.t) && x.n) r.name = x.n;
      return r;
    });
  } catch (e) {
    renderState(box, { icon: "📡", title: "Couldn't load watchlist", msg: "Check your connection and try again.", retry: true }, loadWatchlist);
    return;
  }
  box.innerHTML = rows.map((x) => (x._err ? watchErrCard(x) : cardHTML(x))).join("");
  wireStockCards(box);
  setLive();
}
function loadScreeners() { if (typeof renderScreeners === "function") renderScreeners(); }
function loadAlerts() { if (typeof renderAlerts === "function") renderAlerts(); }
function loadReports() { if (typeof renderReports === "function") renderReports(); }
function loadHome() {
  if (getSettings().autoScan) { loadSuggestions(); return; }
  if (suggestions.length) { renderHomeStats(); renderMarketPicks(); renderMarketSide(); renderFilters(); renderHomeCards(); return; }
  $("homeFilters").classList.add("hidden");
  $("marketCurated").classList.add("hidden"); $("browseAll").classList.add("hidden");
  $("homeCards").innerHTML = '<div class="empty">Auto-scan is off — <button id="scanNow" class="btn sm">Scan now</button></div>';
  const sb = document.getElementById("scanNow");
  if (sb) sb.addEventListener("click", loadSuggestions);
}
$("refreshHome").addEventListener("click", () =>
  withBtnLoading($("refreshHome"), "Refreshing…", loadSuggestions));
(() => { const b = document.getElementById("mkBrowseTop"); if (b) b.addEventListener("click", () => { const el = document.getElementById("browseAll"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }); })();
$("refreshWatch").addEventListener("click", () => withBtnLoading($("refreshWatch"), "Refreshing…", loadWatchlist));
$("bellBtn").addEventListener("click", () => showPage("alerts"));
$("addHoldBtn").addEventListener("click", () => { if (currentSym) addHolding(currentSym, $("cSym").textContent); });

/* ---------- settings panel (R-7) ---------- */
function buildSetPanel() {
  const s = getSettings();
  $("setPanel").innerHTML =
    `<h4>Settings</h4>
     <div class="setrow"><span class="setlbl">Default chart timeframe</span>
       <div class="seg" id="setTf">
         <button data-tf="D"${s.defaultTf === "D" ? ' class="active"' : ""}>Daily</button>
         <button data-tf="W"${s.defaultTf === "W" ? ' class="active"' : ""}>Weekly</button>
         <button data-tf="M"${s.defaultTf === "M" ? ' class="active"' : ""}>Monthly</button>
       </div>
       <div class="sethint">Signals stay weekly 9/21 &amp; 21/50 — this only sets the chart view.</div></div>
     <div class="setrow">
       <label class="tgl"><span class="setlbl" style="margin:0">Auto-scan on Home</span>
         <input type="checkbox" id="setAuto"${s.autoScan ? " checked" : ""}></label>
       <div class="sethint">Off = Home opens instantly; tap Refresh or “Scan now” for the live scan.</div></div>
     <div class="setrow">
       <span class="setlbl">Data &amp; backup</span>
       <div class="setbtns">
         <button class="btn sm" id="setExport">↓ Export backup</button>
         <button class="btn sm ghost" id="setImport">↑ Restore</button>
         <input type="file" id="setImportFile" accept="application/json,.json" hidden>
       </div>
       <div class="sethint">Your holdings, watchlist, alerts &amp; settings live only in this browser. Export a JSON backup (also how you move data to another device). Restore replaces current data.</div>
       <div class="setbtns" style="margin-top:8px"><button class="btn sm ghost" id="setHealth">⚡ Check data feed</button><span id="setHealthOut" class="sethint" style="margin:0"></span></div>
     </div>`;
  $("setPanel").querySelectorAll("#setTf button").forEach((b) =>
    b.addEventListener("click", () => {
      const ns = getSettings(); ns.defaultTf = b.dataset.tf; saveSettings(ns);
      $("setPanel").querySelectorAll("#setTf button").forEach((x) => x.classList.toggle("active", x === b));
      currentTf = b.dataset.tf;
      if (currentSym) loadStock(currentSym, currentTf);
    }));
  document.getElementById("setAuto").addEventListener("change", (e) => {
    const ns = getSettings(); ns.autoScan = e.target.checked; saveSettings(ns);
  });
  document.getElementById("setExport").addEventListener("click", exportBackup);
  const impBtn = document.getElementById("setImport"), impFile = document.getElementById("setImportFile");
  impBtn.addEventListener("click", () => impFile.click());
  impFile.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) importBackupFile(f); e.target.value = ""; });
  document.getElementById("setHealth").addEventListener("click", checkDataFeed);
}
/* ---------- Settings PAGE (Phase R6) — consolidates chart defaults, indicator
   profiles, the trading journal and data/backup. Reuses the same handlers; no
   setting or profile is reset (all keys stay in localStorage as-is). ---------- */
function renderSettingsPage() {
  const body = $("settingsBody");
  if (!body) return;
  const s = getSettings();
  const autoJ = s.autoJournal !== false;
  const profOpts = (typeof INDSTORE !== "undefined" && INDSTORE.order ? INDSTORE.order : [])
    .map((id) => { const p = INDSTORE.profiles[id]; return p ? `<option value="${id}"${id === INDSTORE.active ? " selected" : ""}>${_esc(p.name)}${p.builtin ? "" : " ✎"}</option>` : ""; }).join("");
  body.innerHTML = `
    <div class="sec-h"><span>Chart &amp; display</span></div>
    <div class="set-card">
      <div class="setrow"><span class="setlbl">Default chart timeframe</span>
        <div class="seg" id="setTf">
          <button data-tf="D"${s.defaultTf === "D" ? ' class="active"' : ""}>Daily</button>
          <button data-tf="W"${s.defaultTf === "W" ? ' class="active"' : ""}>Weekly</button>
          <button data-tf="M"${s.defaultTf === "M" ? ' class="active"' : ""}>Monthly</button></div>
        <div class="sethint">Signals stay weekly 9/21 &amp; 21/50 — this only sets the chart view.</div></div>
      <div class="setrow"><label class="tgl"><span class="setlbl" style="margin:0">Auto-scan on Markets</span>
        <input type="checkbox" id="setAuto"${s.autoScan ? " checked" : ""}></label>
        <div class="sethint">Off = Markets opens instantly; tap Refresh for the live scan.</div></div></div>

    <div class="sec-h"><span>Indicators</span></div>
    <div class="set-card">
      <div class="setrow"><span class="setlbl">Active indicator profile</span>
        <div class="setbtns"><select id="setProf" class="fsel">${profOpts}</select><button class="btn sm ghost" id="setProfReset">Reset to defaults</button></div>
        <div class="sethint">Full indicator management (all 21 indicators, parameters, and custom profiles) is on any chart via <b>ƒ Indicators</b>. Overlays never change your BUY/SELL signals.</div></div></div>

    <div class="sec-h"><span>Trading journal</span></div>
    <div class="set-card">
      <div class="setrow"><label class="tgl"><span class="setlbl" style="margin:0">Auto-log trades to the journal</span>
        <input type="checkbox" id="setAutoJ"${autoJ ? " checked" : ""}></label>
        <div class="sethint">On = a journal entry opens when you add a holding and closes when you remove it. Off = log trades manually only.</div></div></div>

    <div class="sec-h"><span>Data &amp; backup</span></div>
    <div class="set-card">
      <div class="setrow">
        <div class="setbtns">
          <button class="btn sm" id="setExport">↓ Export backup</button>
          <button class="btn sm ghost" id="setImport">↑ Restore</button>
          <input type="file" id="setImportFile" accept="application/json,.json" hidden></div>
        <div class="sethint">Your holdings, watchlist, alerts, journal, indicator profiles &amp; settings live only in this browser. Export a JSON backup (also how you move data to another device). Restore replaces current data.</div>
        <div class="setbtns" style="margin-top:10px"><button class="btn sm ghost" id="setHealth">⚡ Check data feed</button><span id="setHealthOut" class="sethint" style="margin:0"></span></div></div></div>`;
  body.querySelectorAll("#setTf button").forEach((b) =>
    b.addEventListener("click", () => {
      const ns = getSettings(); ns.defaultTf = b.dataset.tf; saveSettings(ns);
      body.querySelectorAll("#setTf button").forEach((x) => x.classList.toggle("active", x === b));
      currentTf = b.dataset.tf; if (currentSym) loadStock(currentSym, currentTf);
    }));
  $("setAuto").addEventListener("change", (e) => { const ns = getSettings(); ns.autoScan = e.target.checked; saveSettings(ns); });
  $("setAutoJ").addEventListener("change", (e) => { const ns = getSettings(); ns.autoJournal = e.target.checked; saveSettings(ns); showToast(e.target.checked ? "Auto-journal on" : "Auto-journal off", "ok"); });
  const prof = $("setProf"); if (prof) prof.addEventListener("change", () => { if (typeof switchProfile === "function") switchProfile(prof.value); });
  const pr = $("setProfReset"); if (pr) pr.addEventListener("click", () => { if (typeof resetProfile === "function") { resetProfile(); renderSettingsPage(); } });
  $("setExport").addEventListener("click", exportBackup);
  const impBtn = $("setImport"), impFile = $("setImportFile");
  impBtn.addEventListener("click", () => impFile.click());
  impFile.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) importBackupFile(f); e.target.value = ""; });
  $("setHealth").addEventListener("click", checkDataFeed);
}

/* ---------- Phase 0: backup / restore + data health ---------- */
// Every piece of your data that lives only in this browser. Export/restore keeps
// it safe (a browser clear wipes localStorage) and moves it between devices.
const BACKUP_KEYS = ["holdings", "watch", "alerts", "settings", "cash", "compare", "emaCfg", "rsiCfg", "macdCfg", "bbCfg", "stCfg", "indProfiles", "taCfg", "pwCats"];
async function exportBackup() {
  const data = {};
  BACKUP_KEYS.forEach((k) => { try { const v = localStorage.getItem(k); if (v != null) data[k] = v; } catch (e) {} });
  let journal = [], snapshots = [];
  try { journal = await jAll(); } catch (e) {}
  try { snapshots = await snapAll(); } catch (e) {}
  const payload = { app: "trader-dashboard", kind: "backup", version: 3, exportedAt: new Date().toISOString(), data, journal, snapshots };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "trader-dashboard-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Backup downloaded (" + Object.keys(data).length + " items" + (journal.length ? " + " + journal.length + " journal" : "") + ")", "ok");
}
function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let payload;
    try { payload = JSON.parse(reader.result); } catch (e) { showToast("That file isn't valid JSON", "err"); return; }
    const data = payload && payload.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) { showToast("Not a Trader Dashboard backup", "err"); return; }
    const keys = Object.keys(data).filter((k) => BACKUP_KEYS.includes(k));
    const journal = Array.isArray(payload.journal) ? payload.journal : [];
    if (!keys.length && !journal.length) { showToast("Backup has no recognised data", "err"); return; }
    if (!confirm("Restore this backup?\n\nIt will REPLACE your current holdings, watchlist, alerts, settings and journal in this browser (" + keys.length + " items" + (journal.length ? " + " + journal.length + " journal" : "") + "). This cannot be undone.")) return;
    let ok = 0;
    keys.forEach((k) => { try { const v = data[k]; if (typeof v === "string") { JSON.parse(v); localStorage.setItem(k, v); ok++; } } catch (e) {} });
    if (journal.length) { try { await jBulkPut(journal); } catch (e) {} }
    const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : [];
    if (snapshots.length) { try { await snapBulkPut(snapshots); } catch (e) {} }
    showToast("Restored " + ok + " items — reloading…", "ok");
    setTimeout(() => location.reload(), 800);
  };
  reader.onerror = () => showToast("Couldn't read that file", "err");
  reader.readAsText(file);
}
async function checkDataFeed() {
  const out = document.getElementById("setHealthOut");
  if (out) out.textContent = "Checking…";
  try {
    const hz = await fetch("/healthz", { cache: "no-store" });
    const q = await (await fetch("/api/quote?symbols=" + encodeURIComponent("^NSEI"), { cache: "no-store" })).json();
    const nq = (q.quotes || {})["^NSEI"];
    const okFeed = hz.ok && nq && !nq.error && nq.price != null;
    let when = "";
    if (nq && nq.as_of) { const d = new Date(nq.as_of * 1000 + 330 * 60000); when = " · last quote " + d.toISOString().slice(11, 16) + " IST, " + d.toISOString().slice(0, 10); }
    if (out) out.textContent = okFeed ? ("● Feed OK · delayed ~15 min" + when) : "● Feed problem — data may be stale";
    if (out) out.style.color = okFeed ? "var(--buy)" : "var(--sell)";
  } catch (e) { if (out) { out.textContent = "● Can't reach the feed"; out.style.color = "var(--sell)"; } }
}
$("setBtn").addEventListener("click", () => showPage("settings"));

/* ---------- Dashboard (holdings) ---------- */
const HCLASS = { HOLD: "HOLD", SELL: "SELL", EXIT: "EXIT", NODATA: "WAIT", ERROR: "ERROR" };
// Holdings live in the browser (per-device, like the watchlist) and are sent to
// the server to be valued + given an exit verdict. This keeps the backend
// stateless so it runs on Vercel / any serverless host. Seeded on first use.
const DEFAULT_HOLDINGS = [
  { ticker: "EICHERMOT.NS", qty: 1, buy_price: 7700 },
  { ticker: "SUNPHARMA.NS", qty: 1, buy_price: 1900 },
  { ticker: "ICICIBANK.NS", qty: 4, buy_price: 1505 },
  { ticker: "SBIN.NS", qty: 4, buy_price: 1110 },
  { ticker: "HDFCBANK.NS", qty: 5, buy_price: 816 },
];
function getHoldings() {
  try { const s = localStorage.getItem("holdings"); if (s) return JSON.parse(s); } catch (e) {}
  saveHoldings(DEFAULT_HOLDINGS); return DEFAULT_HOLDINGS.slice();
}
function saveHoldings(list) { try { localStorage.setItem("holdings", JSON.stringify(list)); } catch (e) {} }
function setHolding(sym, qty, buyPrice) {
  const s = sym.toUpperCase();
  const list = getHoldings().filter((h) => (h.ticker || "").toUpperCase() !== s);
  list.push({ ticker: s, qty: qty, buy_price: buyPrice });
  saveHoldings(list);
  if (typeof autoJournalBuy === "function") autoJournalBuy(s, null, qty, buyPrice); // auto-log the buy (R5)
}
function removeHolding(sym) {
  const s = sym.toUpperCase();
  saveHoldings(getHoldings().filter((h) => (h.ticker || "").toUpperCase() !== s));
  if (typeof autoJournalSell === "function") autoJournalSell(s); // auto-close the journal trade on sell (R5)
}
async function computeHoldings() {
  return (await fetch("/api/holdings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdings: getHoldings() }),
  })).json();
}
async function loadHoldings() {
  $("dashHoldings").innerHTML = skelCards(3);
  try {
    const d = await computeHoldings();
    renderHoldings(d); setLive();
    snapToday(d.total_value, d.total_invested, getCash()); // daily portfolio snapshot (Phase 4)
  }
  catch (e) { renderState($("dashHoldings"), { icon: "📡", title: "Couldn't load holdings", msg: "Check your connection and try again.", retry: true }, loadHoldings); }
}
const EXIT_RANK = { SELL: 0, EXIT: 1 };
function sigPill(label, regime) {
  const up = regime === "above";
  const txt = regime ? (up ? "above" : "below") : "n/a";
  return `<span class="sig"><span class="dot ${up ? "up" : "down"}"></span>${label} ${txt}</span>`;
}
function holdCard(h, totalVal) {
  if (h.code === "ERROR") {
    return `<div class="stockcard holdcard" style="opacity:.8">
      <div class="sc-top">${logoTile(h.name, h.symbol)}
        <div class="sc-id"><div class="sc-name">${h.name}</div><div class="sc-tkr">${h.symbol} · couldn't load</div></div>
        <span class="badge ERROR" style="margin-left:auto">ERROR</span>
        <button class="rmbtn" data-rm="${h.symbol}" title="Remove" aria-label="Remove ${h.name}">✕</button></div></div>`;
  }
  const cls = HCLASS[h.code] || "WAIT";
  const wt = (totalVal && h.value != null) ? Math.round(h.value / totalVal * 100) : null;
  const plc = h.pl_pct == null ? "" : (h.pl_pct >= 0 ? "up" : "down");
  const plText = h.pl_pct == null ? "—"
    : `${h.pl_abs >= 0 ? "+" : ""}₹${fmt(h.pl_abs)} · ${h.pl_pct >= 0 ? "+" : ""}${h.pl_pct}%`;
  return `<div class="card stockcard holdcard" data-sym="${h.symbol}" tabindex="0" role="button" aria-label="${h.name}, ${h.code}">
    <div class="sc-top">
      ${logoTile(h.name, h.symbol)}
      <div class="sc-id"><div class="sc-name">${h.name}</div><div class="sc-tkr">${h.qty} sh @ ₹${h.buy_price != null ? fmt(h.buy_price) : "—"}</div></div>
      <div class="hc-metrics">
        <div class="hc-metric"><div class="hc-k">Price</div><div class="hc-v hv-price">${h.price != null ? "₹" + fmt(h.price) : "—"}</div></div>
        <div class="hc-metric"><div class="hc-k">Value</div><div class="hc-v hv-value">${h.value != null ? "₹" + fmt(h.value) : "—"}</div></div>
        <div class="hc-metric"><div class="hc-k">P / L</div><div class="hc-v hv-pl ${plc}">${plText}</div></div>
      </div>
      <span class="badge ${cls}">${h.code}</span>
      <button class="rmbtn" data-rm="${h.symbol}" title="Remove ${h.name}" aria-label="Remove ${h.name}">✕</button>
    </div>
    <div class="hc-foot">
      <div class="sigpills">${sigPill("9/21", h.s9)}${sigPill("21/50", h.s21)}</div>
      <div class="hc-weight"><span class="hk-weight">Weight${wt != null ? " " + wt + "%" : ""}</span><div class="wbar"><i class="wbar-i" style="width:${wt || 0}%"></i></div></div>
    </div>
    ${h.note ? `<div class="hold-sub">${h.note}</div>` : ""}</div>`;
}
function renderHoldings(d) {
  lastHoldings = d;
  const hs = (d.holdings || []).slice().sort((a, b) =>
    (EXIT_RANK[a.code] ?? 5) - (EXIT_RANK[b.code] ?? 5) || (b.value || 0) - (a.value || 0));
  const exits = hs.filter((h) => h.code === "SELL" || h.code === "EXIT");
  $("dashAlert").innerHTML = exits.length
    ? `<div class="alertbar"><span class="ab-ic">⚠</span><div>
         <div class="ab-t">${exits.length} exit signal${exits.length > 1 ? "s" : ""} — review now</div>
         <div class="ab-b">${exits.map((h) => `<b>${h.name}</b> — ${h.note}`).join("<br>")}</div></div></div>`
    : "";
  const plcls = d.total_pl >= 0 ? "up" : "down";
  $("dashSummary").innerHTML =
    `<div class="stat"><div class="k">Invested</div><div class="v sm">₹${fmt(d.total_invested)}</div></div>
     <div class="stat"><div class="k">Current value</div><div class="v sm" id="statValue">₹${fmt(d.total_value)}</div></div>
     <div class="stat"><div class="k">Total P / L</div><div class="v sm ${plcls}" id="statPl">${d.total_pl >= 0 ? "+" : ""}₹${fmt(d.total_pl)}</div>
       <div class="d ${plcls}" id="statPlPct">${d.total_pl_pct != null ? (d.total_pl_pct >= 0 ? "+" : "") + d.total_pl_pct + "%" : ""}</div></div>
     <div class="stat"><div class="k">Holdings</div><div class="v sm">${hs.length}</div></div>
     <div class="stat ${d.any_exit ? "alert" : ""}"><div class="k">Exit alerts</div>
       <div class="v sm">${exits.length ? "⚠ " + exits.length : "None"}</div></div>`;
  $("dashHoldings").innerHTML = hs.map((h) => holdCard(h, d.total_value)).join("")
    || stateBox({ icon: "📊", title: "No holdings yet", msg: "Add a stock above to track it and get an exit signal when the weekly 9/21 turns down." });
  $("dashHoldings").querySelectorAll(".holdcard").forEach((el) =>
    el.addEventListener("click", (e) => { if (!e.target.classList.contains("rmbtn")) loadStock(el.dataset.sym); }));
  $("dashHoldings").querySelectorAll(".rmbtn").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      removeHolding(b.dataset.rm);
      renderHoldings(await computeHoldings());
      showToast(b.dataset.rm.replace(".NS", "") + " removed", "ok");
    }));
}
$("holdAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  let s = $("hSym").value.trim().toUpperCase();
  if (!s) return;
  if (!s.includes(".")) s += ".NS";
  await withBtnLoading(e.submitter || $("holdAdd").querySelector("button[type=submit]"), "Adding…", async () => {
    setHolding(s, parseFloat($("hQty").value) || 1, $("hBuy").value ? parseFloat($("hBuy").value) : null);
    const d = await computeHoldings();
    showToast(s.replace(".NS", "") + " added to holdings", "ok");
    $("hSym").value = ""; $("hQty").value = ""; $("hBuy").value = "";
    renderHoldings(d);
  });
});
$("refreshDash").addEventListener("click", () => withBtnLoading($("refreshDash"), "Refreshing…", loadHoldings));
if ($("exportHoldings")) $("exportHoldings").addEventListener("click", exportHoldingsCSV);
if ($("dashToReports")) $("dashToReports").addEventListener("click", () => showPage("reports"));

/* ---------- live auto-refresh (polls the ~15-min delayed feed) ---------- */
let lastHoldings = null, pollTimer = null, lastTickAt = 0;
const POLL_MS = 15000;
function setLive() { lastTickAt = Date.now(); }
function tickLive() {
  const els = document.querySelectorAll(".liveago");
  if (!lastTickAt) { els.forEach((e) => (e.innerHTML = "")); return; }
  const s = Math.max(0, Math.round((Date.now() - lastTickAt) / 1000));
  const txt = `<span class="livedot"></span>updated ${s}s ago`;
  els.forEach((e) => { e.innerHTML = txt; });
}
async function refreshQuoteQuiet() {
  const sym = currentSym;
  if (!sym) return;
  const d = await (await fetch("/api/quote?symbols=" + encodeURIComponent(sym))).json();
  const q = (d.quotes || {})[sym.toUpperCase()];
  if (!q || q.error || q.price == null) return;
  $("cPrice").textContent = "₹" + fmt(q.price);
  if (q.prev_close) {
    const chg = (q.price - q.prev_close) / q.prev_close * 100;
    const ce = $("cChg"); ce.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
    ce.className = "cchg " + (chg >= 0 ? "up" : "down");
  }
  if (q.as_of) $("cFresh").textContent = freshnessText(q.as_of);
  if (currentCandles.length && candle) {
    const last = currentCandles[currentCandles.length - 1];
    last.high = Math.max(last.high, q.price); last.low = Math.min(last.low, q.price); last.close = q.price;
    candle.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
  }
}
async function refreshHoldingsQuiet() {
  if (!lastHoldings || !(lastHoldings.holdings || []).length) return;
  const syms = lastHoldings.holdings.filter((h) => h.code !== "ERROR").map((h) => h.symbol);
  if (!syms.length) return;
  const d = await (await fetch("/api/quote?symbols=" + encodeURIComponent(syms.join(",")))).json();
  const quotes = d.quotes || {};
  let totVal = 0, totInv = 0;
  lastHoldings.holdings.forEach((h) => {
    const q = quotes[h.symbol.toUpperCase()];
    if (q && !q.error && q.price != null) {
      h.price = q.price; h.value = Math.round(q.price * h.qty * 100) / 100;
      if (h.buy_price) {
        h.pl_abs = Math.round((h.value - h.buy_price * h.qty) * 100) / 100;
        h.pl_pct = Math.round((q.price - h.buy_price) / h.buy_price * 1000) / 10;
      }
    }
    totVal += h.value || 0; totInv += (h.buy_price || 0) * h.qty;
  });
  lastHoldings.total_value = Math.round(totVal * 100) / 100;
  lastHoldings.total_invested = Math.round(totInv * 100) / 100;
  lastHoldings.total_pl = Math.round((totVal - totInv) * 100) / 100;
  lastHoldings.total_pl_pct = totInv ? Math.round((totVal - totInv) / totInv * 1000) / 10 : null;
  updateHoldingsInPlace();
}
function flashEl(el) { if (!el) return; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
function updateHoldingsInPlace() {
  const d = lastHoldings;
  if (!d) { return; }
  // if the DOM cards don't match the current holdings (e.g. not rendered yet), fall back to a full render
  if (!document.querySelector("#dashHoldings .holdcard") && (d.holdings || []).some((h) => h.code !== "ERROR")) { renderHoldings(d); return; }
  const plcls = d.total_pl >= 0 ? "up" : "down";
  const sv = $("statValue"); if (sv) { const t = "₹" + fmt(d.total_value); if (sv.textContent !== t) { sv.textContent = t; flashEl(sv); } }
  const sp = $("statPl"); if (sp) { sp.textContent = (d.total_pl >= 0 ? "+" : "") + "₹" + fmt(d.total_pl); sp.className = "v sm " + plcls; }
  const spp = $("statPlPct"); if (spp) { spp.textContent = d.total_pl_pct != null ? (d.total_pl_pct >= 0 ? "+" : "") + d.total_pl_pct + "%" : ""; spp.className = "d " + plcls; }
  (d.holdings || []).forEach((h) => {
    const card = document.querySelector('#dashHoldings .holdcard[data-sym="' + CSS.escape(h.symbol) + '"]');
    if (!card) return;
    const pe = card.querySelector(".hv-price"); const pt = h.price != null ? "₹" + fmt(h.price) : "—";
    if (pe && pe.textContent !== pt) { pe.textContent = pt; flashEl(pe); }
    const ve = card.querySelector(".hv-value"); if (ve) ve.textContent = h.value != null ? "₹" + fmt(h.value) : "—";
    const ple = card.querySelector(".hv-pl");
    if (ple) {
      const plc2 = h.pl_pct == null ? "" : (h.pl_pct >= 0 ? "up" : "down");
      ple.textContent = h.pl_pct == null ? "—" : `${h.pl_abs >= 0 ? "+" : ""}₹${fmt(h.pl_abs)} · ${h.pl_pct >= 0 ? "+" : ""}${h.pl_pct}%`;
      ple.className = "hold-v hv-pl " + plc2;
    }
    const wt = (d.total_value && h.value != null) ? Math.round(h.value / d.total_value * 100) : null;
    const wl = card.querySelector(".hk-weight"); if (wl) wl.textContent = "Weight" + (wt != null ? " " + wt + "%" : "");
    const wb = card.querySelector(".wbar-i"); if (wb) wb.style.width = (wt || 0) + "%";
  });
}
async function pollTick() {
  if (document.hidden) return;
  checkAlerts();
  const active = (document.querySelector(".page.active") || {}).id;
  try {
    if (active === "page-dashboard") await refreshHoldingsQuiet();
    else if (active === "page-search" && currentSym) await refreshQuoteQuiet();
    else if (active === "page-home") { await updateCardPricesInPlace($("marketPicks")); await updateCardPricesInPlace($("homeCards")); }
    else if (active === "page-screeners") await updateCardPricesInPlace(document.querySelector("#screenBody .stocklist"));
    else if (active === "page-watchlist") await updateCardPricesInPlace($("watchCards"));
    else if (active === "page-reports") await renderReports(true);
    else return;
    setLive();
  } catch (e) { /* keep polling; transient feed hiccups are fine */ }
}
function startPolling() { if (!pollTimer) pollTimer = setInterval(pollTick, POLL_MS); }
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollTick(); });

/* ---------- keyboard activation for cards (A4) ---------- */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = document.activeElement;
  if (el && el.matches && el.matches(".card,.wcard,.holdcard")) { e.preventDefault(); el.click(); }
});

/* ---------- Alerts (N5) — price alerts that fire on the live poll ---------- */
function getAlerts() { try { return JSON.parse(localStorage.getItem("alerts") || "[]"); } catch (e) { return []; } }
function saveAlerts(a) { try { localStorage.setItem("alerts", JSON.stringify(a)); } catch (e) {} }
function updateBellDot() { const d = $("bellDot"); if (d) d.classList.toggle("hidden", !getAlerts().some((a) => a.fired)); }
let alOp = "above", alType = "price";
let saSig = "", saQ = "", saConf = 0; // screener-alert builder state
function pwOn() { return !!getSettings().portfolioWatch; }
function setPw(v) { const s = getSettings(); s.portfolioWatch = !!v; saveSettings(s); }
function getPwCats() { try { return JSON.parse(localStorage.getItem("pwCats") || "{}"); } catch (e) { return {}; } }
function setPwCats(m) { try { localStorage.setItem("pwCats", JSON.stringify(m)); } catch (e) {} }
function portfolioWatchSyms() {
  const h = (getHoldings() || []).map((x) => (x.ticker || "").toUpperCase());
  const w = (getWatch() || []).map((x) => (x.t || "").toUpperCase());
  return [...new Set([...h, ...w])].filter(Boolean);
}
function screenMatch(x, f) {
  return (!f.cat || x.category === f.cat) && (!f.q || x.quality === f.q) && (!f.conf || (x.confluence && x.confluence.bull >= f.conf));
}
function screenFilterText(f) {
  const bits = [f.cat || "Any signal"];
  if (f.q) bits.push("Quality " + f.q);
  if (f.conf) bits.push(f.conf + "/4+ confluence");
  return bits.join(" · ");
}
function alCondText(a) {
  const t = a.t.replace(".NS", "");
  const k = a.kind || "price";
  if (k === "pct") return `${t} moves <b>±${a.pct}%</b> from the previous close`;
  if (k === "signal") return `${t} — <b>fresh weekly signal</b> (9/21 buy or sell cross)`;
  return `${t} <b>${a.op}</b> ₹${fmt(a.price)}`;
}
function alertRow(a) {
  const st = a.fired ? '<span class="al-st fired">✓ Triggered</span>' : '<span class="al-st armed">● Armed</span>';
  const tag = { price: "Price", pct: "% Move", signal: "Signal" }[a.kind || "price"];
  return `<div class="alert-row ${a.fired ? "fired" : ""}">
    <div class="al-main"><div class="al-name">${a.n} <span class="al-tag">${tag}</span></div><div class="al-cond">${alCondText(a)}</div></div>
    ${st}<button class="al-remove iconbtn" data-id="${a.id}" title="Remove" aria-label="Remove alert">✕</button></div>`;
}
function renderAlerts() {
  const body = $("alertsBody");
  if (!body) return;
  const alerts = getAlerts();
  const typeSeg = `<div class="seg altype" id="alType">
      <button data-k="price" class="${alType === "price" ? "active" : ""}">Price</button>
      <button data-k="pct" class="${alType === "pct" ? "active" : ""}">% Move</button>
      <button data-k="signal" class="${alType === "signal" ? "active" : ""}">Signal</button></div>`;
  const inputs = alType === "price"
    ? `<div class="seg" id="alOp"><button data-op="above" class="${alOp === "above" ? "active" : ""}">Above</button><button data-op="below" class="${alOp === "below" ? "active" : ""}">Below</button></div>
       <input id="alPrice" class="al-in al-price" type="number" min="0" step="any" placeholder="Target ₹">`
    : alType === "pct"
    ? `<input id="alPct" class="al-in al-price" type="number" min="0" step="any" placeholder="± % move">`
    : `<span class="al-siginfo">Fires on a fresh weekly 9/21 buy or sell cross.</span>`;
  const symAlerts = alerts.filter((a) => a.kind !== "screen");
  const screenAlerts = alerts.filter((a) => a.kind === "screen");
  const pwSyms = portfolioWatchSyms().length;
  // builder segments for screener alerts
  const saSeg = (key, cur, opts) => `<div class="scf"><div class="scf-l">${key}</div><div class="seg" data-sa="${key}">${opts.map((o) => `<button data-v="${o.v}" class="${String(cur) === String(o.v) ? "active" : ""}">${o.t}</button>`).join("")}</div></div>`;
  const sortedSym = symAlerts.slice().sort((a, b) => (b.fired ? 1 : 0) - (a.fired ? 1 : 0));
  const firedN = symAlerts.filter((a) => a.fired).length;
  body.innerHTML = `
    <div class="sec-h"><span>Create an alert</span></div>
    <div class="alert-add">
      <div class="acwrap"><input id="alSym" class="al-in" placeholder="Stock — name or symbol" autocomplete="off"><div id="alDrop" class="dropdown hidden"></div></div>
      ${typeSeg}${inputs}
      <button id="alAdd" class="btn">Add alert</button></div>
    <div class="al-note">⚑ Alerts use delayed (~15 min) data and fire once — they're reminders, not real-time notifications.</div>

    <div class="sec-h"><span>Portfolio watch</span></div>
    <div class="pw-card">
      <label class="tgl"><div><div class="pw-t">Watch my portfolio for signal changes</div>
        <div class="sethint" style="margin:0">One alert for a fresh weekly 9/21 buy or sell cross on any of your <b>${pwSyms}</b> holdings &amp; watchlist stocks.</div></div>
        <input type="checkbox" id="pwToggle"${pwOn() ? " checked" : ""}></label></div>

    <div class="sec-h"><span>Your alerts</span>${symAlerts.length ? `<span class="al-count">${firedN ? firedN + " triggered · " : ""}${symAlerts.length} total</span>` : ""}</div>
    ${symAlerts.length ? `<div class="alertlist">${sortedSym.map(alertRow).join("")}</div>`
      : stateBox({ icon: "🔔", title: "No alerts yet", msg: "Add a price, % move, or weekly-signal alert above." })}

    <div class="sec-h"><span>Screener alerts</span></div>
    <div class="screen-alert-add">
      <div class="sabuild">
        ${saSeg("Signal", saSig, [{ v: "", t: "Any" }, { v: "STRONG BUY", t: "Strong" }, { v: "BUY", t: "Buy" }])}
        ${saSeg("Quality", saQ, [{ v: "", t: "Any" }, { v: "PASS", t: "Pass" }])}
        ${saSeg("Min confluence", saConf, [{ v: 0, t: "Any" }, { v: 3, t: "3+" }, { v: 4, t: "4/4" }])}
      </div>
      <button id="saAdd" class="btn">Create screener alert</button></div>
    <div class="sethint" style="margin:-6px 0 12px">Fires when a stock enters this filter in the universe scan (checked every poll, delayed data).</div>
    ${screenAlerts.length ? `<div class="alertlist">${screenAlerts.map(screenAlertRow).join("")}</div>` : ""}`;
  attachAutocomplete($("alSym"), $("alDrop"), (s) => { $("alSym").value = s.t; $("alSym").dataset.name = s.n; });
  $("alType").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { alType = b.dataset.k; renderAlerts(); }));
  const opEl = document.getElementById("alOp");
  if (opEl) opEl.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { alOp = b.dataset.op; opEl.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b)); }));
  document.getElementById("pwToggle").addEventListener("change", (e) => { setPw(e.target.checked); if (e.target.checked) { setPwCats({}); showToast("Watching your portfolio for signal changes", "ok"); } });
  body.querySelectorAll("[data-sa]").forEach((seg) => seg.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      const k = seg.dataset.sa, v = b.dataset.v;
      if (k === "Signal") saSig = v; else if (k === "Quality") saQ = v; else saConf = +v;
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    })));
  document.getElementById("saAdd").addEventListener("click", () => {
    const a = getAlerts();
    a.push({ id: Date.now(), kind: "screen", filter: { cat: saSig, q: saQ, conf: saConf }, lastSet: null });
    saveAlerts(a); showToast("Screener alert created", "ok"); renderAlerts();
  });
  $("alAdd").addEventListener("click", () => {
    let s = $("alSym").value.trim().toUpperCase(); if (!s) { showToast("Pick a stock", "err"); return; }
    if (!s.includes(".")) s += ".NS";
    const n = $("alSym").dataset.name || s.replace(".NS", "");
    const a = getAlerts();
    if (alType === "price") {
      const p = parseFloat($("alPrice").value); if (!(p > 0)) { showToast("Enter a target price", "err"); return; }
      a.push({ id: Date.now(), t: s, n, kind: "price", op: alOp, price: p, fired: false });
    } else if (alType === "pct") {
      const p = parseFloat($("alPct").value); if (!(p > 0)) { showToast("Enter a % move", "err"); return; }
      a.push({ id: Date.now(), t: s, n, kind: "pct", pct: p, fired: false });
    } else {
      a.push({ id: Date.now(), t: s, n, kind: "signal", lastCat: null, fired: false });
    }
    saveAlerts(a); showToast("Alert added", "ok"); renderAlerts();
  });
  body.querySelectorAll(".al-remove").forEach((b) =>
    b.addEventListener("click", () => { saveAlerts(getAlerts().filter((x) => String(x.id) !== b.dataset.id)); renderAlerts(); updateBellDot(); }));
}
function screenAlertRow(a) {
  const n = (a.lastSet && a.lastSet.length) || 0;
  return `<div class="alert-row"><div class="al-main"><div class="al-name">Screener <span class="al-tag">Enter</span></div>
      <div class="al-cond">${screenFilterText(a.filter)}${n ? ` · <b>${n}</b> match${n === 1 ? "" : "es"} now` : ""}</div></div>
    <span class="al-st armed">● Watching</span><button class="al-remove iconbtn" data-id="${a.id}" title="Remove" aria-label="Remove">✕</button></div>`;
}
async function checkAlerts() {
  const alerts0 = getAlerts();
  const active = alerts0.filter((a) => a.kind !== "screen" && !a.fired);
  const screenAlerts = alerts0.filter((a) => a.kind === "screen");
  const pw = pwOn();
  if (!active.length && !screenAlerts.length && !pw) return;
  const quoteSyms = [...new Set(active.filter((a) => (a.kind || "price") !== "signal").map((a) => a.t))];
  const signalSet = new Set(active.filter((a) => a.kind === "signal").map((a) => a.t));
  const pwSyms = pw ? portfolioWatchSyms() : [];
  pwSyms.forEach((s) => signalSet.add(s));
  try {
    let q = {}, cats = {};
    if (quoteSyms.length) { const d = await (await fetch("/api/quote?symbols=" + encodeURIComponent(quoteSyms.join(",")))).json(); q = d.quotes || {}; }
    // Signal / portfolio-watch reuse the scanner's category (STRONG BUY/BUY = fresh 9/21 bull cross; SELL = fresh death cross) — no new engine call.
    if (signalSet.size) { const d = await (await fetch("/api/scan?symbols=" + encodeURIComponent([...signalSet].join(",")))).json(); (d.results || []).forEach((r) => { cats[r.symbol] = r.category; }); }
    // Screener alerts scan the whole universe to diff which stocks match the filter.
    let universe = null;
    if (screenAlerts.length) { const d = await (await fetch("/api/scanner")).json(); universe = (d.results || []).filter((x) => x.category !== "ERROR"); }
    let changed = false;
    const all = getAlerts();
    all.forEach((a) => {
      if (a.kind === "screen" || a.fired) return;
      const kind = a.kind || "price";
      if (kind === "price") {
        const price = (q[a.t] || {}).price; if (price == null) return;
        if ((a.op === "above" && price >= a.price) || (a.op === "below" && price <= a.price)) {
          a.fired = true; changed = true; showToast(`🔔 ${a.n} is ${a.op} ₹${fmt(a.price)} — now ₹${fmt(price)} · delayed`, "ok");
        }
      } else if (kind === "pct") {
        const qq = q[a.t] || {}; if (qq.price == null || !qq.prev_close) return;
        const chg = (qq.price - qq.prev_close) / qq.prev_close * 100;
        if (Math.abs(chg) >= a.pct) {
          a.fired = true; changed = true; showToast(`🔔 ${a.n} moved ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% (±${a.pct}%) · delayed`, "ok");
        }
      } else if (kind === "signal") {
        const cat = cats[a.t]; if (cat == null) return;
        if (a.lastCat == null) { a.lastCat = cat; changed = true; return; } // set baseline on first check, don't fire
        if (cat !== a.lastCat) {
          const buy = cat === "STRONG BUY" || cat === "BUY", wasBuy = a.lastCat === "STRONG BUY" || a.lastCat === "BUY";
          const sell = cat === "SELL", wasSell = a.lastCat === "SELL";
          if (buy && !wasBuy) { a.fired = true; changed = true; showToast(`🔔 ${a.n}: fresh weekly BUY signal (${cat}) · delayed`, "ok"); }
          else if (sell && !wasSell) { a.fired = true; changed = true; showToast(`🔔 ${a.n}: fresh weekly SELL signal · delayed`, "ok"); }
          else { a.lastCat = cat; changed = true; }
        }
      }
    });
    // Portfolio-wide signal watch: fire on a fresh buy/sell for any holding or watchlist stock.
    if (pw) {
      const pwCats = getPwCats(); let pwChanged = false;
      const nameOf = (sym) => (getWatch().find((x) => (x.t || "").toUpperCase() === sym) || {}).n || sym.replace(".NS", "");
      pwSyms.forEach((sym) => {
        const cat = cats[sym]; if (cat == null) return;
        const last = pwCats[sym];
        if (last == null) { pwCats[sym] = cat; pwChanged = true; return; } // baseline, don't fire
        if (cat !== last) {
          const buy = cat === "STRONG BUY" || cat === "BUY", wasBuy = last === "STRONG BUY" || last === "BUY";
          const sell = cat === "SELL", wasSell = last === "SELL";
          if (buy && !wasBuy) showToast(`🔔 ${nameOf(sym)}: fresh weekly BUY signal (${cat}) — in your portfolio · delayed`, "ok");
          else if (sell && !wasSell) showToast(`🔔 ${nameOf(sym)}: fresh weekly SELL signal — in your portfolio · delayed`, "ok");
          pwCats[sym] = cat; pwChanged = true;
        }
      });
      // prune symbols no longer tracked
      Object.keys(pwCats).forEach((s) => { if (!pwSyms.includes(s)) { delete pwCats[s]; pwChanged = true; } });
      if (pwChanged) setPwCats(pwCats);
    }
    // Screener alerts: notify when a stock enters the saved filter.
    if (universe) {
      all.forEach((a) => {
        if (a.kind !== "screen") return;
        const match = universe.filter((x) => screenMatch(x, a.filter)).map((x) => x.symbol);
        if (a.lastSet == null) { a.lastSet = match; changed = true; return; } // baseline
        const entered = match.filter((s) => !a.lastSet.includes(s));
        if (entered.length) {
          const names = entered.slice(0, 3).map((s) => (universe.find((x) => x.symbol === s) || {}).name || s).join(", ");
          showToast(`🔔 ${entered.length} stock${entered.length === 1 ? "" : "s"} entered "${screenFilterText(a.filter)}": ${names}${entered.length > 3 ? "…" : ""} · delayed`, "ok");
        }
        if (JSON.stringify(match) !== JSON.stringify(a.lastSet)) { a.lastSet = match; changed = true; }
      });
    }
    if (changed) { saveAlerts(all); updateBellDot(); if (document.getElementById("page-alerts").classList.contains("active")) renderAlerts(); }
  } catch (e) {}
}

/* ---------- Reports (N6) — portfolio + universe analytics from existing data ---------- */
async function renderReports(quiet) {
  const body = $("reportsBody");
  if (!body) return;
  if (!quiet || !body.querySelector(".report-grid")) body.innerHTML = '<div class="scanhint"><span class="spinner"></span>Building your report…</div>';
  let hold, scan;
  try {
    [hold, scan] = await Promise.all([
      computeHoldings(),   // browser-stored holdings (server GET is empty on Vercel)
      (await fetch("/api/scanner")).json(),
    ]);
  } catch (e) { renderState(body, { icon: "📡", title: "Couldn't build the report", msg: "Check your connection and try again.", retry: true }, renderReports); return; }
  const rows = (scan.results || []).filter((x) => x.category !== "ERROR");
  const H = hold.holdings || [];
  // Live-price override so Reports matches the 15s Dashboard freshness: re-value
  // holdings from the quote cache. Exit codes/signals stay from the full load
  // (they only change on a weekly candle close).
  try {
    const hsyms = [...new Set(H.filter((h) => h.code !== "ERROR" && h.symbol).map((h) => h.symbol.toUpperCase()))].slice(0, 50);
    if (hsyms.length) {
      const qd = await (await fetch("/api/quote?symbols=" + encodeURIComponent(hsyms.join(",")))).json();
      const q = qd.quotes || {};
      let tv = 0, ti = 0;
      H.forEach((h) => {
        const qt = q[(h.symbol || "").toUpperCase()];
        if (qt && !qt.error && qt.price != null) { h.price = qt.price; h.value = (h.qty || 0) * qt.price; }
        tv += h.value || 0; ti += (h.qty || 0) * (h.buy_price || 0);
      });
      hold.total_value = tv; hold.total_invested = ti; hold.total_pl = tv - ti;
      hold.total_pl_pct = ti ? Math.round((tv - ti) / ti * 1000) / 10 : 0;
    }
  } catch (e) { /* keep the server-computed totals if the quote fetch fails */ }
  // ---- Phase 4: cash, realised P/L, snapshots, sector allocation, concentration ----
  const cash = getCash();
  const totalPortfolio = (hold.total_value || 0) + cash;
  let realised = 0, closedN = 0;
  try { (await jAll()).forEach((e) => { if (e.status === "closed" && e.realised) { realised += e.realised.pl_abs || 0; closedN++; } }); } catch (e) {}
  await snapToday(hold.total_value, hold.total_invested, cash);
  const snaps = (await snapAll()).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const vals = snaps.map((s) => s.value);
  const peak = vals.length ? Math.max(...vals) : null;
  const latest = vals.length ? vals[vals.length - 1] : null;
  const drawdown = (peak && latest != null && peak > 0) ? (latest - peak) / peak * 100 : null;
  const perfSince = (days) => { if (snaps.length < 2) return null; const t = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); let base = null; for (const s of snaps) { if (s.date <= t) base = s; } if (!base) base = snaps[0]; return base.value > 0 ? (latest - base.value) / base.value * 100 : null; };
  const perf1w = perfSince(7), perf1m = perfSince(30), perfAll = (snaps.length >= 2 && snaps[0].value > 0) ? (latest - snaps[0].value) / snaps[0].value * 100 : null;
  // ---- Phase 5: benchmark vs NIFTY 50, best/worst, sector performance, monthly returns ----
  const nh = await niftyHistory();
  const periods = [["1 week", 7], ["1 month", 30], ["All-time", null]];
  const benchRows = (snaps.length >= 2 && nh.latest) ? periods.map(([label, days]) => {
    let base; if (days == null) base = snaps[0]; else { const t = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); base = null; for (const s of snaps) { if (s.date <= t) base = s; } if (!base) base = snaps[0]; }
    if (!base || base.value <= 0) return null;
    const port = (latest - base.value) / base.value * 100;
    const nb = niftyCloseOn(nh, base.date);
    const nfty = (nb && nb > 0) ? (nh.latest - nb) / nb * 100 : null;
    return { label, port, nfty, alpha: nfty != null ? port - nfty : null };
  }).filter(Boolean) : [];
  const byPl = H.filter((h) => h.pl_pct != null).slice().sort((a, b) => b.pl_pct - a.pl_pct);
  const best = byPl.slice(0, 3), worst = byPl.slice(-3).reverse().filter((h) => !best.includes(h));
  const secPerf = {}; H.filter((h) => h.pl_pct != null).forEach((h) => { const s = sectorOf(h.symbol); const inv = (h.buy_price || 0) * h.qty; (secPerf[s] = secPerf[s] || { inv: 0, pl: 0 }), secPerf[s].inv += inv, secPerf[s].pl += (h.pl_abs || 0); });
  const secPerfRows = Object.entries(secPerf).map(([s, o]) => ({ s, pct: o.inv ? o.pl / o.inv * 100 : 0 })).sort((a, b) => b.pct - a.pct);
  const byMonth = {}; snaps.forEach((s) => { byMonth[s.date.slice(0, 7)] = s.value; });
  const months = Object.keys(byMonth).sort(); const monthRows = [];
  for (let i = 1; i < months.length; i++) { const p = byMonth[months[i - 1]], c = byMonth[months[i]]; if (p > 0) monthRows.push({ m: months[i], pct: (c - p) / p * 100 }); }
  const secMap = {}; H.filter((h) => h.value).forEach((h) => { const s = sectorOf(h.symbol); secMap[s] = (secMap[s] || 0) + h.value; });
  const secRows = Object.entries(secMap).sort((a, b) => b[1] - a[1]);
  const pcls = (x) => x == null ? "" : (x >= 0 ? "up" : "down");
  const pfmt = (x) => x == null ? "—" : (x >= 0 ? "+" : "") + (Math.round(x * 10) / 10) + "%";
  const distRow = (l, w, col) => `<div class="dist-row"><span class="dist-l">${l}</span><div class="dist-bar"><i style="width:${Math.min(100, w)}%;background:${col}"></i></div><span class="dist-n">${w}%</span></div>`;

  const sc = (cls, ic, v, l) => `<div class="statcard ${cls}"><div class="st-ic">${statIcon(ic)}</div><div class="st-t"><div class="st-v">${v}</div><div class="st-l">${l}</div></div></div>`;
  const stats = `<div class="statrow">
    ${sc("blue", "up", "₹" + fmt(hold.total_value), "Holdings value")}
    ${sc(hold.total_pl >= 0 ? "green" : "red", "up", (hold.total_pl >= 0 ? "+" : "") + "₹" + fmt(hold.total_pl), "Unrealised P/L" + (hold.total_pl_pct != null ? " · " + (hold.total_pl_pct >= 0 ? "+" : "") + hold.total_pl_pct + "%" : ""))}
    ${sc(realised >= 0 ? "green" : "red", "star", (realised >= 0 ? "+" : "") + "₹" + fmt(realised), "Realised P/L" + (closedN ? " · " + closedN + " closed" : ""))}
    ${sc("blue", "up", "₹" + fmt(totalPortfolio), "Total incl. cash")}</div>`;
  const cashCtl = `<div class="cashbar"><span class="cash-l">Available cash</span>
     <input id="repCash" class="al-in" type="number" min="0" step="any" value="${cash || ""}" placeholder="₹ cash balance">
     <span class="cash-hint">Invested ₹${fmt(hold.total_invested)} · Cash ₹${fmt(cash)} · Total ₹${fmt(totalPortfolio)}</span></div>`;

  const CATS = ["STRONG BUY", "BUY", "HOLD", "WAIT", "CHART-ONLY", "SELL"];
  const CATCOL = { "STRONG BUY": "var(--buy)", "BUY": "var(--buy)", "HOLD": "var(--hold)", "WAIT": "var(--wait)", "CHART-ONLY": "var(--warn)", "SELL": "var(--sell)" };
  const maxN = rows.length || 1;
  const dist = CATS.map((c) => { const n = rows.filter((x) => x.category === c).length; return `<div class="dist-row"><span class="dist-l">${c}</span><div class="dist-bar"><i style="width:${n / maxN * 100}%;background:${CATCOL[c]}"></i></div><span class="dist-n">${n}</span></div>`; }).join("");
  const withChg = rows.filter((x) => x.chg1w != null).slice().sort((a, b) => b.chg1w - a.chg1w);
  const mover = (x) => `<div class="mover-row"><span class="mv-n">${x.name}</span><span class="mv-c ${x.chg1w >= 0 ? "up" : "down"}">${x.chg1w >= 0 ? "+" : ""}${x.chg1w}%</span></div>`;
  const gainers = withChg.slice(0, 5).map(mover).join("") || '<div class="note">No data yet.</div>';
  const losers = withChg.slice(-5).reverse().map(mover).join("") || '<div class="note">No data yet.</div>';
  const allocStock = H.filter((h) => h.value).slice().sort((a, b) => (b.value || 0) - (a.value || 0)).map((h) => distRow(h.name, hold.total_value ? Math.round(h.value / hold.total_value * 100) : 0, "var(--accent)")).join("") || '<div class="note">No holdings yet.</div>';
  const allocSector = secRows.map(([s, v]) => distRow(s, hold.total_value ? Math.round(v / hold.total_value * 100) : 0, "#7aa2ff")).join("") || '<div class="note">No holdings yet.</div>';
  const topStock = H.filter((h) => h.value).slice().sort((a, b) => (b.value || 0) - (a.value || 0))[0];
  const topStockPct = (topStock && hold.total_value) ? Math.round(topStock.value / hold.total_value * 100) : 0;
  const topSecPct = (secRows.length && hold.total_value) ? Math.round(secRows[0][1] / hold.total_value * 100) : 0;
  const riskFlags = [];
  if (topStock && topStockPct > 25) riskFlags.push(`<div class="risk-f warn">⚠ ${esc(topStock.name)} is ${topStockPct}% of holdings — concentrated.</div>`);
  if (secRows.length && topSecPct > 40) riskFlags.push(`<div class="risk-f warn">⚠ ${secRows[0][0]} is ${topSecPct}% of holdings — sector concentration.</div>`);
  if (!riskFlags.length && H.length) riskFlags.push(`<div class="risk-f ok">✓ Well spread — no stock over 25% or sector over 40%.</div>`);
  const riskCard = `<div class="jc-snap" style="margin:0 0 6px"></div>
     <div class="row"><span>Positions</span><span class="r-v">${H.length}</span></div>
     <div class="row"><span>Sectors</span><span class="r-v">${secRows.length}</span></div>
     <div class="row"><span>Largest position</span><span class="r-v ${topStockPct > 25 ? "no" : ""}">${topStockPct}%</span></div>
     <div class="row"><span>Largest sector</span><span class="r-v ${topSecPct > 40 ? "no" : ""}">${topSecPct}%</span></div>
     ${riskFlags.join("")}`;
  const histCard = snaps.length >= 2
    ? `<div class="hist-spark">${sparkSVG(vals)}</div>
       <div class="row"><span>All-time</span><span class="r-v ${pcls(perfAll)}">${pfmt(perfAll)}</span></div>
       <div class="row"><span>1 week</span><span class="r-v ${pcls(perf1w)}">${pfmt(perf1w)}</span></div>
       <div class="row"><span>1 month</span><span class="r-v ${pcls(perf1m)}">${pfmt(perf1m)}</span></div>
       <div class="row"><span>Drawdown from peak</span><span class="r-v ${pcls(drawdown)}">${pfmt(drawdown)}</span></div>
       <div class="note">${snaps.length} daily snapshot${snaps.length === 1 ? "" : "s"} since ${snaps[0].date}.</div>`
    : `<div class="note">Building history — one snapshot is saved each day you open the app. Come back tomorrow to see your portfolio trend, returns and drawdown.</div>`;
  // Phase 5: benchmark vs NIFTY 50
  const benchCard = benchRows.length
    ? `<div class="bench-head"><span>Period</span><span>You</span><span>NIFTY</span><span>+/−</span></div>` +
      benchRows.map((b) => `<div class="bench-row"><span class="bench-l">${b.label}</span><span class="r-v ${pcls(b.port)}">${pfmt(b.port)}</span><span class="r-v ${pcls(b.nfty)}">${pfmt(b.nfty)}</span><span class="r-v ${pcls(b.alpha)}">${pfmt(b.alpha)}</span></div>`).join("") +
      `<div class="note">+/− is your return minus NIFTY 50 over the same window (delayed data).</div>`
    : `<div class="note">Needs a couple of days of portfolio history to compare against NIFTY 50. It builds automatically each day you open the app.</div>`;
  const plMover = (h) => `<div class="mover-row"><span class="mv-n">${esc(h.name)}</span><span class="mv-c ${h.pl_pct >= 0 ? "up" : "down"}">${h.pl_pct >= 0 ? "+" : ""}${h.pl_pct}%</span></div>`;
  const bestWorst = (best.length || worst.length)
    ? `<div class="subtitle" style="margin-top:0">Best</div>${best.map(plMover).join("") || '<div class="note">—</div>'}
       <div class="subtitle">Worst</div>${worst.map(plMover).join("") || '<div class="note">—</div>'}`
    : '<div class="note">No holdings with a buy price yet.</div>';
  const secPerfHtml = secPerfRows.length
    ? secPerfRows.map((r) => `<div class="mover-row"><span class="mv-n">${r.s}</span><span class="mv-c ${r.pct >= 0 ? "up" : "down"}">${r.pct >= 0 ? "+" : ""}${Math.round(r.pct * 10) / 10}%</span></div>`).join("")
    : '<div class="note">No holdings yet.</div>';
  const monthlyCard = monthRows.length
    ? monthRows.slice(-6).reverse().map((r) => `<div class="mover-row"><span class="mv-n">${r.m}</span><span class="mv-c ${r.pct >= 0 ? "up" : "down"}">${r.pct >= 0 ? "+" : ""}${Math.round(r.pct * 10) / 10}%</span></div>`).join("")
    : "";

  body.innerHTML = stats + cashCtl + `<div class="report-grid">
    <div class="report-card"><h3>Performance vs NIFTY 50</h3>${benchCard}</div>
    <div class="report-card"><h3>Portfolio over time</h3>${histCard}</div>
    ${monthlyCard ? `<div class="report-card"><h3>Monthly returns</h3>${monthlyCard}</div>` : ""}
    <div class="report-card"><h3>Best &amp; worst holdings</h3>${bestWorst}</div>
    <div class="report-card"><h3>Sector performance · your holdings</h3>${secPerfHtml}</div>
    <div class="report-card"><h3>Allocation by stock</h3>${allocStock}</div>
    <div class="report-card"><h3>Allocation by sector</h3>${allocSector}</div>
    <div class="report-card"><h3>Concentration &amp; diversification</h3>${riskCard}</div>
    <div class="report-card"><h3>Signal distribution · universe</h3>${dist}</div>
    <div class="report-card"><h3>Top gainers · universe</h3>${gainers}</div>
    <div class="report-card"><h3>Top losers · universe</h3>${losers}</div></div>`;
  const cashEl = document.getElementById("repCash");
  if (cashEl) cashEl.addEventListener("change", () => { const v = parseFloat(cashEl.value); setCash(isFinite(v) && v >= 0 ? v : 0); renderReports(); });
  setLive();
}

/* ---------- Screeners (N4) — filters the universe, reuses scanner data ---------- */
let screenData = [], screenFilters = { cat: "", q: "", v: "", conf: 0 }, screenMode = "weekly";
async function renderScreeners() {
  const body = $("screenBody");
  if (!body) return;
  body.innerHTML = `<div class="screenmode">
      <button data-sm="weekly" class="${screenMode === "weekly" ? "active" : ""}">📅 Weekly method</button>
      <button data-sm="short" class="${screenMode === "short" ? "active" : ""}">⚡ Short-term (daily)</button>
      <button data-sm="intraday" class="${screenMode === "intraday" ? "active" : ""}">⏱ Intraday (delayed)</button>
    </div><div id="screenInner"></div>`;
  body.querySelectorAll(".screenmode button").forEach((b) =>
    b.addEventListener("click", () => { screenMode = b.dataset.sm; renderScreeners(); }));
  if (screenMode === "short") { renderShortTerm(); return; }
  if (screenMode === "intraday") { renderIntraday(); return; }
  const inner = $("screenInner");
  if (!screenData.length) {
    inner.innerHTML = '<div class="scanhint"><span class="spinner"></span>Loading your universe…</div>';
    try {
      const d = await (await fetch("/api/scanner")).json();
      screenData = (d.results || []).filter((x) => x.category !== "ERROR");
    } catch (e) { renderState(inner, { icon: "📡", title: "Couldn't load the universe", msg: "Check your connection and try again.", retry: true }, renderScreeners); return; }
  }
  drawScreeners();
  setLive();
}
function drawScreeners() {
  const body = $("screenInner") || $("screenBody"), f = screenFilters;
  const seg = (label, key, opts) => `<div class="scf"><div class="scf-l">${label}</div><div class="seg">${opts.map((o) =>
    `<button class="${String(f[key]) === String(o.v) ? "active" : ""}" data-sk="${key}" data-sv="${o.v}">${o.t}</button>`).join("")}</div></div>`;
  const filters = `<div class="screenbar">
    ${seg("Signal", "cat", [{ v: "", t: "All" }, { v: "STRONG BUY", t: "Strong" }, { v: "BUY", t: "Buy" }, { v: "HOLD", t: "Hold" }, { v: "WAIT", t: "Wait" }, { v: "SELL", t: "Sell" }])}
    ${seg("Quality", "q", [{ v: "", t: "Any" }, { v: "PASS", t: "Pass" }, { v: "NEAR", t: "Near" }, { v: "FAIL", t: "Fail" }])}
    ${seg("Valuation", "v", [{ v: "", t: "Any" }, { v: "CHEAP", t: "Cheap" }, { v: "FAIR", t: "Fair" }, { v: "EXPENSIVE", t: "Expensive" }])}
    ${seg("Min confluence", "conf", [{ v: 0, t: "Any" }, { v: 2, t: "2+" }, { v: 3, t: "3+" }, { v: 4, t: "4/4" }])}
  </div>`;
  const rows = screenData.filter((x) =>
    (!f.cat || x.category === f.cat) &&
    (!f.q || x.quality === f.q) &&
    (!f.v || x.valuation === f.v) &&
    (!f.conf || (x.confluence && x.confluence.bull >= f.conf)));
  const active = !!(f.cat || f.q || f.v || f.conf);
  const count = `<div class="screen-count"><span class="sc-n"><b>${rows.length}</b> of ${screenData.length} stocks match</span>${active ? '<button class="sc-clear" id="scClear">✕ Clear filters</button>' : ""}<button class="sc-clear" id="scExport">↓ Export CSV</button></div>`;
  body.innerHTML = filters + count +
    (rows.length ? `<div class="stocklist">${rows.map(cardHTML).join("")}</div>`
      : stateBox({ icon: "🔍", title: "No matches", msg: "Loosen the filters to see more stocks." }));
  body.querySelectorAll(".seg button[data-sk]").forEach((b) =>
    b.addEventListener("click", () => { const k = b.dataset.sk; f[k] = (k === "conf") ? +b.dataset.sv : b.dataset.sv; drawScreeners(); }));
  const clr = document.getElementById("scClear");
  if (clr) clr.addEventListener("click", () => { screenFilters = { cat: "", q: "", v: "", conf: 0 }; drawScreeners(); });
  const exp = document.getElementById("scExport");
  if (exp) exp.addEventListener("click", exportScreenerCSV);
  const list = body.querySelector(".stocklist"); if (list) wireStockCards(list);
}

/* ---------- Short-term screener (Phase C) — SEPARATE daily-timeframe screen.
   Does not use or change the weekly method. Delayed EOD data, clearly labelled.
   No intraday screen: honest intraday needs real-time data we don't have. ---- */
let shortTermData = null;
async function renderShortTerm(force) {
  const inner = $("screenInner");
  if (!inner) return;
  const banner = `<div class="st-banner">⚡ <b>Short-term screener</b> — scans the daily chart (not the weekly method) for setups playable over <b>days to a few weeks</b>.
      Uses Yahoo end-of-day data that's <b>~15-min delayed</b> — a watchlist, not live signals, and <b>not investment advice</b>.
      There's deliberately <b>no intraday screener</b>: honest intraday needs real-time data this app doesn't have.</div>`;
  if (!shortTermData || force) {
    inner.innerHTML = banner + '<div class="scanhint"><span class="spinner"></span>Scanning the daily charts…</div>';
    try {
      const d = await (await fetch("/api/shortterm")).json();
      shortTermData = d.results || [];
    } catch (e) {
      renderState(inner, { icon: "📡", title: "Couldn't run the short-term scan", msg: "The data feed couldn't be reached. Your weekly method and prices are unaffected.", retry: true }, () => renderShortTerm(true));
      return;
    }
  }
  const rows = shortTermData;
  const head = `<div class="screen-count"><span class="sc-n"><b>${rows.length}</b> short-term ${rows.length === 1 ? "setup" : "setups"} found</span>
      <button class="sc-clear" id="stRefresh">↻ Rescan</button></div>`;
  inner.innerHTML = banner + head +
    (rows.length ? `<div class="stocklist">${rows.map(shortTermCard).join("")}</div>`
      : stateBox({ icon: "🔍", title: "No clean short-term setups right now", msg: "Nothing in the universe meets the daily-trend criteria today. No setup is better than a forced one — check back after the next close." }));
  const rf = document.getElementById("stRefresh");
  if (rf) rf.addEventListener("click", () => renderShortTerm(true));
  const list = inner.querySelector(".stocklist"); if (list) wireStockCards(list);
}
function shortTermCard(r) {
  const chg = r.chg1d;
  const chgCls = chg == null ? "" : chg >= 0 ? "up" : "down";
  const setupCls = r.setup === "Fresh breakout" ? "st-fresh" : "st-cont";
  const lv = `<div class="st-lv">
      <span>Support <b>₹${fmt(r.support)}</b></span>
      <span>Now <b>₹${fmt(r.price)}</b></span>
      <span>Resistance <b>₹${fmt(r.resistance)}</b></span>
      <span class="st-stop">Stop <b>₹${fmt(r.stop)}</b></span></div>`;
  return `<div class="card st-card" data-sym="${r.symbol}">
      <div class="st-top">
        <div><div class="st-name">${r.name}</div><div class="st-sym">${r.symbol.replace(/\.(NS|BO)$/i, "")}</div></div>
        <div class="st-price">₹${fmt(r.price)} ${chg != null ? `<span class="${chgCls}">${chg >= 0 ? "+" : ""}${chg}%</span>` : ""}</div>
      </div>
      <div class="st-tags"><span class="st-setup ${setupCls}">${r.setup}</span>${r.rsi != null ? `<span class="st-rsi">RSI ${r.rsi}</span>` : ""}</div>
      <div class="subtitle">Why</div>${r.reasons.map((x) => `<div class="psp-r">• ${x}</div>`).join("")}
      <div class="subtitle">Risks</div>${r.risks.map((x) => `<div class="psp-risk">⚠ ${x}</div>`).join("")}
      ${lv}
      <div class="st-foot">Daily · ~15-min delayed · tap for full chart &amp; weekly signal</div></div>`;
}

/* ---------- Intraday snapshot (DELAYED, illustrative only) ----------
   A clearly-labelled delayed 15-minute momentum snapshot. NOT a live screener
   and NOT for live entries/exits — honest limitation of ~15-min delayed data.
   Does not use or change the weekly method. */
let intradayData = null;
async function renderIntraday(force) {
  const inner = $("screenInner");
  if (!inner) return;
  if (!intradayData || force) {
    inner.innerHTML = '<div class="scanhint"><span class="spinner"></span>Reading the delayed 15-minute charts…</div>';
    try {
      intradayData = await (await fetch("/api/intradayscan")).json();
    } catch (e) {
      renderState(inner, { icon: "📡", title: "Couldn't read the intraday snapshot", msg: "The data feed couldn't be reached. Your weekly method, prices and signals are unaffected.", retry: true }, () => renderIntraday(true));
      return;
    }
  }
  const rows = (intradayData && intradayData.results) || [];
  const asOf = intradayData && intradayData.as_of;
  // Honest data-age line: real timestamp + market-closed note using existing helpers.
  let stamp = "";
  if (asOf) {
    const fresh = freshnessText(asOf);
    const closed = !isTodayIST(asOf);
    stamp = `<div class="itd-stamp">Data ${fresh}${closed ? " · market was closed — this is the last session's 15-min data" : ""}.</div>`;
  }
  const banner = `<div class="st-banner itd-banner">⏱ <b>Delayed intraday snapshot — illustrative only.</b>
      This reads the <b>~15-minute DELAYED</b> chart (Yahoo, not licensed for live intraday). It is <b>NOT real-time, NOT a live screener, and NOT for live entries or exits</b> — it shows which names are leaning up on the delayed 15-minute trend, for context only. For your actual decisions use the weekly 9/21·21/50 method. Not investment advice.</div>`;
  const head = `<div class="screen-count"><span class="sc-n"><b>${rows.length}</b> leaning up on the delayed 15-min trend</span>
      <button class="sc-clear" id="itdRefresh">↻ Rescan</button></div>`;
  inner.innerHTML = banner + stamp + head +
    (rows.length ? `<div class="stocklist">${rows.map(intradayCard).join("")}</div>`
      : stateBox({ icon: "🔍", title: "Nothing leaning up on the delayed 15-min trend", msg: "No names in the universe are trending up on the delayed 15-minute chart right now." }));
  const rf = document.getElementById("itdRefresh");
  if (rf) rf.addEventListener("click", () => renderIntraday(true));
  const list = inner.querySelector(".stocklist"); if (list) wireStockCards(list);
}
function intradayCard(r) {
  const setupCls = r.fresh ? "st-fresh" : "st-cont";
  const setup = r.fresh ? "Fresh 15-min cross" : "15-min uptrend";
  return `<div class="card st-card itd-card" data-sym="${r.symbol}">
      <div class="st-top">
        <div><div class="st-name">${r.name}</div><div class="st-sym">${r.symbol.replace(/\.(NS|BO)$/i, "")}</div></div>
        <div class="st-price">₹${fmt(r.price)}</div>
      </div>
      <div class="st-tags"><span class="st-setup ${setupCls}">${setup}</span>${r.rsi != null ? `<span class="st-rsi">15m RSI ${r.rsi}</span>` : ""}</div>
      <div class="subtitle">What the delayed 15-min chart shows</div>${r.reasons.map((x) => `<div class="psp-r">• ${x}</div>`).join("")}
      <div class="psp-risk">⚠ ~15-MIN DELAYED — NOT real-time. Do NOT use for live intraday entries or exits. Illustrative context only.</div>
      <div class="st-foot itd-foot">Delayed 15-min · illustrative only · tap for full chart &amp; weekly signal</div></div>`;
}

/* ---------- market widget (sidebar) ---------- */
function nseOpen() {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins <= 930; // 9:15–15:30 IST
}
function setIdx(prefix, q) {
  const v = $(prefix + "V"), c = $(prefix + "C");
  if (!v) return;
  if (!q || q.error || q.price == null) { v.textContent = "—"; if (c) { c.textContent = ""; c.className = "mc-c"; } return; }
  v.textContent = fmt(q.price);
  if (c) {
    const chg = q.prev_close ? (q.price - q.prev_close) / q.prev_close * 100 : null;
    c.textContent = chg == null ? "" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
    c.className = "mc-c " + (chg == null ? "" : (chg >= 0 ? "up" : "down"));
  }
}
let _mktSparkDone = false;
async function loadMktSpark() {
  const box = $("mktSpark");
  if (!box || _mktSparkDone) return;
  _mktSparkDone = true;
  try {
    const d = await (await fetch("/api/stock?symbol=" + encodeURIComponent("^NSEI") + "&tf=D")).json();
    const closes = (d.candles || []).map((c) => c.close).filter((x) => x != null).slice(-60);
    if (closes.length >= 2) box.innerHTML = sparkSVG(closes);
  } catch (e) { /* no sparkline if the index series is unavailable */ }
}
function istDateStr(ms) { return new Date(ms + 330 * 60000).toISOString().slice(0, 10); } // YYYY-MM-DD in IST
function isTodayIST(unixSec) { return !!unixSec && istDateStr(unixSec * 1000) === istDateStr(Date.now()); }
async function loadMarket() {
  const pill = $("mktPill"), t = $("mktPillTxt");
  const setPill = (open) => { if (pill) pill.className = "mkt-pill " + (open ? "open" : "closed"); if (t) t.textContent = open ? "Market Open" : "Market Closed"; };
  setPill(nseOpen()); // optimistic time-based until the live quote confirms
  try {
    const d = await (await fetch("/api/quote?symbols=" + encodeURIComponent("^NSEI,^BSESN"))).json();
    const q = d.quotes || {};
    setIdx("nifty", q["^NSEI"]); setIdx("sensex", q["^BSESN"]);
    // Honest open/closed: "Open" only when inside NSE hours AND the latest index
    // quote is from TODAY (IST). On a holiday the quote stays on the prior trading
    // day, so this reads "Closed" — no hardcoded holiday calendar needed.
    const asOf = (q["^NSEI"] || {}).as_of || (q["^BSESN"] || {}).as_of;
    if (asOf) setPill(nseOpen() && isTodayIST(asOf));
  } catch (e) { setIdx("nifty", null); setIdx("sensex", null); }
  loadMktSpark();
}
function updateClock() {
  const el = $("topClock");
  if (!el) return;
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][ist.getMonth()];
  let h = ist.getHours(); const m = ist.getMinutes(); const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  el.textContent = ist.getDate() + " " + mon + ", " + h + ":" + String(m).padStart(2, "0") + " " + ap;
}

/* ---------- Phase 3: Trading Journal (IndexedDB) ---------- */
// Journal entries grow over time, so they live in IndexedDB (not localStorage).
// They are included in the Settings → Export backup / Restore.
const JDB_NAME = "traderdash", JDB_STORE = "journal", SNAP_STORE = "snapshots", JDB_VER = 2;
let _jdb = null, journalPrefill = null;
function jdb() {
  if (_jdb) return Promise.resolve(_jdb);
  return new Promise((resolve, reject) => {
    let req; try { req = indexedDB.open(JDB_NAME, JDB_VER); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(JDB_STORE)) db.createObjectStore(JDB_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SNAP_STORE)) db.createObjectStore(SNAP_STORE, { keyPath: "date" }); // one portfolio snapshot per day
    };
    req.onsuccess = () => { _jdb = req.result; resolve(_jdb); };
    req.onerror = () => reject(req.error);
  });
}
function jTx(mode) { return jdb().then((db) => db.transaction(JDB_STORE, mode).objectStore(JDB_STORE)); }
function jAll() { return jTx("readonly").then((st) => new Promise((res, rej) => { const r = st.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); })).catch(() => []); }
function jPut(e) { return jTx("readwrite").then((st) => new Promise((res, rej) => { const r = st.put(e); r.onsuccess = () => res(e); r.onerror = () => rej(r.error); })); }
function jDel(id) { return jTx("readwrite").then((st) => new Promise((res, rej) => { const r = st.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); })); }
function jBulkPut(arr) { return jdb().then((db) => new Promise((res, rej) => { const tx = db.transaction(JDB_STORE, "readwrite"), st = tx.objectStore(JDB_STORE); (arr || []).forEach((e) => { if (e && e.id != null) st.put(e); }); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }
/* ---------- Phase 4: portfolio snapshots (IndexedDB) + cash + sectors ---------- */
function sTx(mode) { return jdb().then((db) => db.transaction(SNAP_STORE, mode).objectStore(SNAP_STORE)); }
function snapAll() { return sTx("readonly").then((st) => new Promise((res, rej) => { const r = st.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); })).catch(() => []); }
function snapPut(s) { return sTx("readwrite").then((st) => new Promise((res, rej) => { const r = st.put(s); r.onsuccess = () => res(); r.onerror = () => rej(r.error); })); }
function snapBulkPut(arr) { return jdb().then((db) => new Promise((res, rej) => { const tx = db.transaction(SNAP_STORE, "readwrite"), st = tx.objectStore(SNAP_STORE); (arr || []).forEach((s) => { if (s && s.date) st.put(s); }); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })); }
// Capture (or refresh) today's portfolio snapshot — one per day, so drawdown and
// performance-over-time build up as you open the app. Called on Dashboard/Reports load.
async function snapToday(value, invested, cash) {
  if (value == null || !isFinite(value)) return;
  try { await snapPut({ date: new Date().toISOString().slice(0, 10), value: Math.round(value * 100) / 100, invested: Math.round((invested || 0) * 100) / 100, cash: Math.round((cash || 0) * 100) / 100 }); } catch (e) {}
}
function getCash() { try { const v = parseFloat(localStorage.getItem("cash")); return isFinite(v) && v >= 0 ? v : 0; } catch (e) { return 0; } }
function setCash(v) { try { localStorage.setItem("cash", String(v)); } catch (e) {} }
// Curated sector map for the universe (config, not market data). Unknown -> "Other".
const SECTORS = {
  "SUNPHARMA.NS": "Pharma", "AUROPHARMA.NS": "Pharma", "AJANTPHARM.NS": "Pharma", "IPCALAB.NS": "Pharma",
  "NATCOPHARM.NS": "Pharma", "JBCHEPHARM.NS": "Pharma", "CAPLIPOINT.NS": "Pharma", "APOLLOHOSP.NS": "Healthcare",
  "SBIN.NS": "Banks", "HDFCBANK.NS": "Banks", "ICICIBANK.NS": "Banks", "PNB.NS": "Banks", "YESBANK.NS": "Banks", "IOB.NS": "Banks",
  "TCS.NS": "IT", "INFY.NS": "IT", "RELIANCE.NS": "Energy", "IOC.NS": "Energy",
  "MARUTI.NS": "Auto", "EICHERMOT.NS": "Auto", "M&M.NS": "Auto", "BALKRISIND.NS": "Auto ancillary",
  "COALINDIA.NS": "Metals & mining", "NMDC.NS": "Metals & mining", "JINDALSTEL.NS": "Metals & mining",
  "CUMMINSIND.NS": "Capital goods", "TRIDENT.NS": "Textiles", "IDEA.NS": "Telecom", "IRFC.NS": "Financials",
  "ADANIPOWER.NS": "Power & utilities", "RPOWER.NS": "Power & utilities", "JPPOWER.NS": "Power & utilities",
  "SJVN.NS": "Power & utilities", "NHPC.NS": "Power & utilities", "SUZLON.NS": "Power & utilities",
};
function sectorOf(sym) { return SECTORS[(sym || "").toUpperCase()] || "Other"; }
/* ---------- Phase 5: NIFTY 50 benchmark history (cached ~5 min) ---------- */
let _niftyHist = null;
async function niftyHistory() {
  if (_niftyHist && Date.now() - _niftyHist.at < 300000) return _niftyHist;
  try {
    const d = await (await fetch("/api/stock?symbol=" + encodeURIComponent("^NSEI") + "&tf=D")).json();
    const map = {}; (d.candles || []).forEach((c) => { if (c.close != null) map[c.time] = c.close; });
    const dates = Object.keys(map).sort();
    _niftyHist = { at: Date.now(), map, dates, latest: dates.length ? map[dates[dates.length - 1]] : null };
  } catch (e) { if (!_niftyHist) _niftyHist = { at: Date.now(), map: {}, dates: [], latest: null }; }
  return _niftyHist;
}
function niftyCloseOn(hist, date) { // nearest NIFTY close on or before `date`
  let best = null; for (const d of hist.dates) { if (d <= date) best = hist.map[d]; else break; }
  return best != null ? best : (hist.dates.length ? hist.map[hist.dates[0]] : null);
}
function esc(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
// Snapshot the engine's signal at the moment of entry (reuses existing data — no recompute).
function journalSnapshot(d) {
  if (!d) return null;
  const s9 = d.signal_9_21, s21 = d.signal_21_50, c = d.confluence;
  return {
    verdict: d.verdict ? ((d.verdict.headline || "").startsWith("STRONG") ? "STRONG BUY" : d.verdict.action) : null,
    headline: d.verdict ? d.verdict.headline : null,
    ema9: s9 ? s9.fast : null, ema21: s9 ? s9.slow : (s21 ? s21.fast : null), ema50: s21 ? s21.slow : null,
    s9: s9 ? s9.regime : null, s9_fresh: s9 ? !!s9.fresh_bull : null, s21: s21 ? s21.regime : null,
    confluence: c ? (c.bull + "/" + c.total + " " + c.side) : null,
    last_week: d.last_week || null, price_at: d.price != null ? d.price : null,
  };
}
function loadJournal() { jAll().then(renderJournal); }
/* Phase R5: auto-log a journal trade when a holding is added (buy) or removed (sell).
   On buy, open an entry with the weekly signal snapshot (skips if one is already
   open for that stock). On sell, close the open entry with realised P/L. Opt-out
   via settings.autoJournal === false. Does not touch manual entries beyond closing
   an open one for the same ticker you sold. */
async function autoJournalBuy(sym, name, qty, buyPrice) {
  if (getSettings().autoJournal === false) return;
  const s = (sym || "").toUpperCase();
  if (!s) return;
  try {
    const entries = await jAll();
    if (entries.some((e) => (e.ticker || "").toUpperCase() === s && e.status !== "closed")) return;
    let snapshot = null, price = (buyPrice != null && buyPrice !== "") ? +buyPrice : null, nm = name;
    try {
      const d = await (await fetch("/api/stock?symbol=" + encodeURIComponent(s) + "&tf=W")).json();
      snapshot = journalSnapshot(d);
      if (price == null) price = d.price;
      if (!nm && d.quality && d.quality.name) nm = d.quality.name;
    } catch (e) {}
    const today = new Date().toISOString().slice(0, 10);
    await jPut({ id: Date.now(), ticker: s, name: nm || s.replace(".NS", ""), qty: +qty || 1, status: "open",
      entry: { date: today, price: price != null ? price : 0, reason: "", notes: "Auto-logged when added to holdings", snapshot }, auto: true });
    const jp = document.getElementById("page-journal");
    if (jp && jp.classList.contains("active")) loadJournal();
  } catch (e) {}
}
async function autoJournalSell(sym) {
  if (getSettings().autoJournal === false) return;
  const s = (sym || "").toUpperCase();
  if (!s) return;
  try {
    const entries = await jAll();
    const open = entries.filter((e) => (e.ticker || "").toUpperCase() === s && e.status !== "closed");
    if (!open.length) return;
    let price = null;
    try { const d = await (await fetch("/api/quote?symbols=" + encodeURIComponent(s))).json(); const q = (d.quotes || {})[s]; if (q && q.price != null) price = q.price; } catch (e) {}
    const today = new Date().toISOString().slice(0, 10);
    for (const e of open) {
      const ex = price != null ? price : e.entry.price;
      const pl_abs = Math.round((ex - e.entry.price) * (+e.qty || 1) * 100) / 100;
      const pl_pct = e.entry.price ? Math.round((ex / e.entry.price - 1) * 1000) / 10 : 0;
      e.status = "closed"; e.exit = { date: today, price: ex, reason: "Auto-logged when removed from holdings" }; e.realised = { pl_abs, pl_pct };
      await jPut(e);
    }
    const jp = document.getElementById("page-journal");
    if (jp && jp.classList.contains("active")) loadJournal();
  } catch (e) {}
}
function jWinBadge(e) {
  if (e.status !== "closed" || !e.realised) return "";
  const w = e.realised.pl_pct >= 0;
  return `<span class="j-wl ${w ? "win" : "loss"}">${w ? "WIN" : "LOSS"}</span>`;
}
function journalCard(e) {
  const snap = e.entry.snapshot || {}, closed = e.status === "closed";
  const plHtml = closed && e.realised ? `<span class="j-pl ${e.realised.pl_pct >= 0 ? "up" : "down"}">${e.realised.pl_abs >= 0 ? "+" : ""}₹${fmt(e.realised.pl_abs)} · ${e.realised.pl_pct >= 0 ? "+" : ""}${e.realised.pl_pct}%</span>` : "";
  return `<div class="jcard ${closed ? "closed" : "open"}">
      <div class="jc-top">${logoTile(e.name, e.ticker)}
        <div class="jc-id"><div class="jc-name">${esc(e.name)} ${jWinBadge(e)}</div>
          <div class="jc-tkr">${e.ticker} · ${e.qty} @ ₹${fmt(e.entry.price)} · ${e.entry.date}</div></div>
        <div class="jc-stat">${closed ? plHtml : '<span class="j-open">● Open</span>'}</div></div>
      <div class="jc-snap">
        <span class="jc-chip">Signal at entry: <b>${snap.verdict || "—"}</b></span>
        ${snap.ema9 != null ? `<span class="jc-chip">EMA 9/21/50 ₹${fmt(snap.ema9)} / ${fmt(snap.ema21)} / ${fmt(snap.ema50)}</span>` : ""}
        ${snap.confluence ? `<span class="jc-chip">Confluence ${snap.confluence}</span>` : ""}
        ${snap.last_week ? `<span class="jc-chip">wk ${snap.last_week}</span>` : ""}</div>
      ${e.entry.reason ? `<div class="jc-reason"><b>Why I bought:</b> ${esc(e.entry.reason)}</div>` : ""}
      ${e.entry.notes ? `<div class="jc-notes">${esc(e.entry.notes)}</div>` : ""}
      ${closed ? `<div class="jc-exit"><b>Exit:</b> ${e.exit.date} @ ₹${fmt(e.exit.price)}${e.exit.reason ? " — " + esc(e.exit.reason) : ""}</div>` : ""}
      <div class="jc-foot">
        ${!closed ? `<button class="btn sm" data-close="${e.id}">Close trade</button>` : ""}
        <button class="btn sm ghost" data-view="${e.ticker}">Open chart</button>
        <button class="btn sm ghost j-del" data-del="${e.id}">Delete</button></div>
      <div class="jc-closeform hidden" id="jclose-${e.id}"></div></div>`;
}
function renderJournal(entries) {
  const body = $("journalBody"); if (!body) return;
  entries = (entries || []).slice().sort((a, b) => (b.id || 0) - (a.id || 0));
  const open = entries.filter((e) => e.status !== "closed");
  const closed = entries.filter((e) => e.status === "closed");
  const wins = closed.filter((e) => e.realised && e.realised.pl_pct >= 0).length;
  const realisedPl = closed.reduce((s, e) => s + ((e.realised && e.realised.pl_abs) || 0), 0);
  const winRate = closed.length ? Math.round(wins / closed.length * 100) : null;
  // Phase 5: trade analysis — avg win / avg loss / profit factor / best / worst
  const winsArr = closed.filter((e) => e.realised && e.realised.pl_pct >= 0);
  const lossArr = closed.filter((e) => e.realised && e.realised.pl_pct < 0);
  const avgWin = winsArr.length ? winsArr.reduce((s, e) => s + e.realised.pl_pct, 0) / winsArr.length : null;
  const avgLoss = lossArr.length ? lossArr.reduce((s, e) => s + e.realised.pl_pct, 0) / lossArr.length : null;
  const grossWin = winsArr.reduce((s, e) => s + (e.realised.pl_abs || 0), 0);
  const grossLoss = Math.abs(lossArr.reduce((s, e) => s + (e.realised.pl_abs || 0), 0));
  const profitFactor = grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : null);
  const byPct = closed.filter((e) => e.realised).slice().sort((a, b) => b.realised.pl_pct - a.realised.pl_pct);
  const bestT = byPct[0], worstT = byPct.length > 1 ? byPct[byPct.length - 1] : null;
  const p1 = (x) => x == null ? "—" : (x >= 0 ? "+" : "") + (Math.round(x * 10) / 10) + "%";
  const anaRow = (l, v, cls) => `<div class="ana-i"><div class="ana-l">${l}</div><div class="ana-v ${cls || ""}">${v}</div></div>`;
  const analysis = closed.length ? `<div class="ana-strip">
      ${anaRow("Avg win", p1(avgWin), "up")}
      ${anaRow("Avg loss", p1(avgLoss), "down")}
      ${anaRow("Profit factor", profitFactor == null ? "—" : (profitFactor === Infinity ? "∞" : Math.round(profitFactor * 100) / 100), profitFactor != null && profitFactor >= 1 ? "up" : "down")}
      ${anaRow("Best trade", bestT ? esc(bestT.name) + " " + p1(bestT.realised.pl_pct) : "—", "up")}
      ${anaRow("Worst trade", worstT ? esc(worstT.name) + " " + p1(worstT.realised.pl_pct) : "—", "down")}
    </div>` : "";
  const stat = (cls, ic, v, l) => `<div class="statcard ${cls}"><div class="st-ic">${statIcon(ic)}</div><div class="st-t"><div class="st-v">${v}</div><div class="st-l">${l}</div></div></div>`;
  const pf = journalPrefill || {};
  const today = new Date().toISOString().slice(0, 10);
  body.innerHTML = `<div class="statrow">
      ${stat("blue", "up", entries.length, "Trades logged")}
      ${stat("amber", "clock", open.length, "Open")}
      ${stat(winRate == null ? "blue" : (winRate >= 50 ? "green" : "red"), "star", winRate == null ? "—" : winRate + "%", "Win rate")}
      ${stat(realisedPl >= 0 ? "green" : "red", "up", (realisedPl >= 0 ? "+" : "") + "₹" + fmt(realisedPl), "Realised P/L")}
    </div>${analysis}
    <div class="sec-h"><span>Log a trade</span></div>
    <form id="jForm" class="jform">
      <div class="acwrap jgrow"><input id="jSym" class="al-in" placeholder="Stock — name or symbol" autocomplete="off" value="${pf.t ? esc(pf.t) : ""}"><div id="jDrop" class="dropdown hidden"></div></div>
      <input id="jQty" class="al-in jqty" type="number" min="0" step="any" placeholder="Qty">
      <input id="jPrice" class="al-in jqty" type="number" min="0" step="any" placeholder="Entry ₹" value="${pf.price != null ? pf.price : ""}">
      <input id="jDate" class="al-in jqty" type="date" value="${today}">
      <input id="jReason" class="al-in jgrow" placeholder="Why are you buying?">
      <button type="submit" class="btn">＋ Log trade</button>
    </form>
    <div class="j-note">Trades are <b>logged automatically</b> when you add a stock to holdings and closed when you remove it — or log one manually above. Each entry captures the weekly signal at that moment and is saved in this browser (Settings → Export backup).</div>
    ${open.length ? `<h3 class="jsec">Open positions <span>${open.length}</span></h3><div class="jlist">${open.map(journalCard).join("")}</div>` : ""}
    ${closed.length ? `<h3 class="jsec">Closed trades <span>${closed.length}</span></h3><div class="jlist">${closed.map(journalCard).join("")}</div>` : ""}
    ${!entries.length ? stateBox({ icon: "📓", title: "No trades logged yet", msg: "Log a buy above, or tap ✎ Journal on any stock's chart to capture the signal at the time." }) : ""}`;
  const pfSnap = pf.snapshot, pfName = pf.n; journalPrefill = null;
  attachAutocomplete($("jSym"), $("jDrop"), (s) => { $("jSym").value = s.t; $("jSym").dataset.name = s.n; });
  $("jForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    let s = $("jSym").value.trim().toUpperCase(); if (!s) { showToast("Pick a stock", "err"); return; }
    if (!s.includes(".")) s += ".NS";
    const qty = parseFloat($("jQty").value), price = parseFloat($("jPrice").value);
    if (!(qty > 0)) { showToast("Enter a quantity", "err"); return; }
    if (!(price > 0)) { showToast("Enter an entry price", "err"); return; }
    const name = $("jSym").dataset.name || (pfName && pf.t === s ? pfName : "") || s.replace(".NS", "");
    let snapshot = (pfSnap && pf.t === s) ? pfSnap : null;
    if (!snapshot) { try { const d = await (await fetch("/api/stock?symbol=" + encodeURIComponent(s))).json(); snapshot = journalSnapshot(d); } catch (e) {} }
    const entry = { id: Date.now(), ticker: s, name, qty, status: "open",
      entry: { date: $("jDate").value || today, price, reason: $("jReason").value.trim(), notes: "", snapshot } };
    await jPut(entry); showToast("Trade logged", "ok"); loadJournal();
  });
  body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (confirm("Delete this journal entry? This cannot be undone.")) { await jDel(+b.dataset.del); loadJournal(); } }));
  body.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => loadStock(b.dataset.view)));
  body.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => openJournalClose(+b.dataset.close)));
}
async function openJournalClose(id) {
  const box = document.getElementById("jclose-" + id); if (!box) return;
  const e = (await jAll()).find((x) => x.id === id); if (!e) return;
  const today = new Date().toISOString().slice(0, 10);
  box.classList.remove("hidden");
  box.innerHTML = `<div class="jclose">
      <input id="jcPrice" class="al-in jqty" type="number" min="0" step="any" placeholder="Exit ₹">
      <input id="jcDate" class="al-in jqty" type="date" value="${today}">
      <input id="jcReason" class="al-in jgrow" placeholder="Reason for selling">
      <button class="btn sm" id="jcSave">Save exit</button>
      <button class="btn sm ghost" id="jcCancel">Cancel</button></div>`;
  document.getElementById("jcCancel").addEventListener("click", () => { box.classList.add("hidden"); box.innerHTML = ""; });
  document.getElementById("jcSave").addEventListener("click", async () => {
    const xp = parseFloat(document.getElementById("jcPrice").value);
    if (!(xp > 0)) { showToast("Enter an exit price", "err"); return; }
    e.status = "closed";
    e.exit = { date: document.getElementById("jcDate").value || today, price: xp, reason: document.getElementById("jcReason").value.trim() };
    e.realised = { pl_abs: Math.round((xp - e.entry.price) * e.qty * 100) / 100, pl_pct: Math.round((xp - e.entry.price) / e.entry.price * 1000) / 10 };
    await jPut(e); showToast("Trade closed", "ok"); loadJournal();
  });
}
$("journalBtn").addEventListener("click", () => {
  if (!currentSym || !lastStockData) { showToast("Open a stock first", "err"); return; }
  const d = lastStockData;
  journalPrefill = { t: currentSym, n: (d.quality && d.quality.name) || currentSym.replace(".NS", ""), price: d.price, snapshot: journalSnapshot(d) };
  showPage("journal");
});
if ($("exportJournal")) $("exportJournal").addEventListener("click", exportJournalCSV);

/* ---------- Compare 2–5 stocks (reuses /api/scan — one call, rich rows) ---------- */
function getCompare() { try { return JSON.parse(localStorage.getItem("compare") || "[]"); } catch (e) { return []; } }
function saveCompare(l) { try { localStorage.setItem("compare", JSON.stringify(l)); } catch (e) {} }
function inCompare(t) { return getCompare().some((x) => x.t === t); }
/* Phase R3: add/remove a stock from the compare set (max 5) from any card. */
function toggleCompare(t, n) {
  const list = getCompare();
  const i = list.findIndex((x) => x.t === t);
  if (i >= 0) { list.splice(i, 1); saveCompare(list); updateCompareBadge(); return false; }
  if (list.length >= 5) { showToast("Compare holds up to 5 — remove one first", "err"); return inCompare(t); }
  list.push({ t, n: n || t.replace(".NS", "") }); saveCompare(list); updateCompareBadge();
  showToast((n || t.replace(".NS", "")) + " added to Compare (" + list.length + ")", "ok");
  return true;
}
function updateCompareBadge() {
  const b = document.getElementById("cmpNavBadge");
  if (!b) return;
  const n = getCompare().length;
  b.textContent = n || "";
  b.classList.toggle("hidden", !n);
}
/* Phase R3: quick-alert — open Alerts with the stock prefilled. */
function quickAlert(sym, name) {
  showPage("alerts");
  setTimeout(() => {
    const i = document.getElementById("alSym");
    if (i) { i.value = sym; i.dataset.name = name || sym.replace(".NS", ""); i.focus(); }
  }, 60);
}
async function loadCompare() {
  const list = getCompare();
  if (list.length < 2) { renderCompare([]); return; }
  renderCompare(null); // show picker + loading
  let rows;
  try {
    const d = await (await fetch("/api/scan?symbols=" + encodeURIComponent(list.map((x) => x.t).join(",")))).json();
    const byT = {}; (d.results || []).forEach((r) => { byT[r.symbol] = r; });
    rows = list.map((x) => byT[x.t] || { symbol: x.t, name: x.n, _err: true });
  } catch (e) { rows = list.map((x) => ({ symbol: x.t, name: x.n, _err: true })); }
  renderCompare(rows);
}
function cmpRegime(reg) { return reg === "above" ? '<span class="up">▲ above</span>' : reg === "below" ? '<span class="down">▼ below</span>' : "—"; }
function compareTable(rows) {
  const col = (r) => `<th>${logoTile(r.name, r.symbol)}<div class="cmp-hn">${esc(r.name || r.symbol)}</div><div class="cmp-ht">${(r.symbol || "").replace(".NS", "")}</div></th>`;
  const defs = [
    ["Price", (r) => `<td>${r.price != null ? "₹" + fmt(r.price) : "—"}</td>`],
    ["1-week change", (r) => `<td class="${r.chg1w == null ? "" : (r.chg1w >= 0 ? "up" : "down")}">${r.chg1w == null ? "—" : (r.chg1w >= 0 ? "+" : "") + r.chg1w + "%"}</td>`],
    ["Signal", (r) => `<td><span class="badge ${CAT_BADGE[r.category] || "WAIT"}">${r.category || "—"}</span></td>`],
    ["9/21 (entry)", (r) => `<td>${cmpRegime(r.s9)}</td>`],
    ["21/50 (trend)", (r) => `<td>${cmpRegime(r.s21)}</td>`],
    ["Confluence", (r) => `<td>${r.confluence ? r.confluence.bull + "/" + r.confluence.total + " " + r.confluence.side : "—"}</td>`],
    ["Quality", (r) => `<td>${r.quality ? `<span class="pill ${r.quality === "PASS" ? "ok" : r.quality === "NEAR" ? "near" : "no"}">${r.quality}</span>` : '<span class="cmp-na">not rated</span>'}</td>`],
    ["Valuation", (r) => `<td>${r.valuation ? `<span class="pill ${r.valuation === "CHEAP" ? "ok" : r.valuation === "FAIR" ? "near" : "no"}">${r.valuation}</span>` : "—"}</td>`],
    ["Upside (5-model)", (r) => `<td class="${r.upside == null || r.upside_flag ? "" : (r.upside >= 0 ? "up" : "down")}">${r.upside == null ? "—" : (r.upside_flag ? "~" : "") + (r.upside >= 0 ? "+" : "") + r.upside + "%" + (r.upside_flag ? " ⚠" : "")}</td>`],
  ];
  const cellOf = (r, fn) => r._err ? `<td class="cmp-na">unavailable</td>` : fn(r);
  const head = `<tr><th class="cmp-corner">Metric</th>${rows.map(col).join("")}</tr>`;
  const bodyRows = defs.map(([l, fn]) => `<tr><td class="cmp-metric">${l}</td>${rows.map((r) => cellOf(r, fn)).join("")}</tr>`).join("");
  const openRow = `<tr><td class="cmp-metric"></td>${rows.map((r) => `<td><button class="btn sm ghost" data-open="${r.symbol}">Open chart</button></td>`).join("")}</tr>`;
  return `<div class="cmp-tablewrap"><table class="cmp-table"><thead>${head}</thead><tbody>${bodyRows}${openRow}</tbody></table></div>`;
}
function renderCompare(rows) {
  const body = $("compareBody"); if (!body) return;
  const list = getCompare();
  const canAdd = list.length < 5;
  const chips = list.map((x) => `<span class="cmp-chip">${esc(x.n || x.t)}<button data-rm="${x.t}" title="Remove" aria-label="Remove">✕</button></span>`).join("");
  const picker = `<div class="cmp-add">
      <div class="acwrap jgrow"><input id="cmpSym" class="al-in" placeholder="${canAdd ? "Add a stock (up to 5)…" : "Max 5 — remove one to add another"}"${canAdd ? "" : " disabled"} autocomplete="off"><div id="cmpDrop" class="dropdown hidden"></div></div>
      <div class="cmp-chips">${chips || '<span class="cmp-none">No stocks selected yet</span>'}</div></div>`;
  let tbl;
  if (list.length < 2) tbl = stateBox({ icon: "📊", title: "Add at least 2 stocks", msg: "Search above to add up to 5 stocks and compare their price, weekly signal, quality and valuation side by side." });
  else if (rows == null) tbl = '<div class="scanhint"><span class="spinner"></span>Loading comparison…</div>';
  else tbl = compareTable(rows);
  body.innerHTML = picker + tbl;
  attachAutocomplete($("cmpSym"), $("cmpDrop"), (s) => { const l = getCompare(); if (l.length >= 5 || l.some((x) => x.t === s.t)) return; l.push({ t: s.t, n: s.n }); saveCompare(l); loadCompare(); });
  body.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { saveCompare(getCompare().filter((x) => x.t !== b.dataset.rm)); loadCompare(); }));
  body.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => loadStock(b.dataset.open)));
}

/* ---------- P6: CSV export (holdings, journal, screener) ---------- */
function toCSV(headers, rows) {
  const esc = (v) => { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return "﻿" + [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n"); // BOM so Excel reads UTF-8
}
function downloadText(name, text, type) {
  const blob = new Blob([text], { type: type || "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const _today = () => new Date().toISOString().slice(0, 10);
async function exportHoldingsCSV() {
  const d = (lastHoldings && (lastHoldings.holdings || []).length) ? lastHoldings : await computeHoldings();
  const H = d.holdings || [];
  if (!H.length) { showToast("No holdings to export", "err"); return; }
  const headers = ["Symbol", "Name", "Qty", "Buy price", "Current price", "Value", "P/L (₹)", "P/L (%)", "Exit signal"];
  const rows = H.map((h) => [h.symbol, h.name, h.qty, h.buy_price, h.price, h.value, h.pl_abs, h.pl_pct, h.code]);
  downloadText("holdings-" + _today() + ".csv", toCSV(headers, rows));
  showToast("Holdings exported (" + H.length + ")", "ok");
}
async function exportJournalCSV() {
  const je = await jAll();
  if (!je.length) { showToast("No journal entries to export", "err"); return; }
  je.sort((a, b) => (b.id || 0) - (a.id || 0));
  const headers = ["Ticker", "Name", "Qty", "Status", "Entry date", "Entry price", "Reason", "Exit date", "Exit price", "Exit reason", "Realised (₹)", "Realised (%)", "Result", "Signal at entry", "EMA9", "EMA21", "EMA50", "Confluence"];
  const rows = je.map((e) => { const s = e.entry.snapshot || {}, x = e.exit || {}, r = e.realised || {}; return [e.ticker, e.name, e.qty, e.status, e.entry.date, e.entry.price, e.entry.reason, x.date || "", x.price != null ? x.price : "", x.reason || "", r.pl_abs != null ? r.pl_abs : "", r.pl_pct != null ? r.pl_pct : "", e.status === "closed" ? (r.pl_pct >= 0 ? "WIN" : "LOSS") : "", s.verdict || "", s.ema9 != null ? s.ema9 : "", s.ema21 != null ? s.ema21 : "", s.ema50 != null ? s.ema50 : "", s.confluence || ""]; });
  downloadText("journal-" + _today() + ".csv", toCSV(headers, rows));
  showToast("Journal exported (" + je.length + ")", "ok");
}
function exportScreenerCSV() {
  const f = screenFilters;
  const rows0 = (screenData || []).filter((x) => (!f.cat || x.category === f.cat) && (!f.q || x.quality === f.q) && (!f.v || x.valuation === f.v) && (!f.conf || (x.confluence && x.confluence.bull >= f.conf)));
  if (!rows0.length) { showToast("No rows to export", "err"); return; }
  const headers = ["Symbol", "Name", "Price", "1-week %", "Signal", "Quality", "Valuation", "Confluence", "Upside %"];
  const rows = rows0.map((x) => [x.symbol, x.name, x.price, x.chg1w, x.category, x.quality || "", x.valuation || "", x.confluence ? x.confluence.bull + "/" + x.confluence.total + " " + x.confluence.side : "", x.upside != null ? x.upside : ""]);
  downloadText("screener-" + _today() + ".csv", toCSV(headers, rows));
  showToast("Screener exported (" + rows0.length + ")", "ok");
}

/* ---------- boot ---------- */
// Persistence health: everything you save (holdings, watchlist, alerts, settings,
// cash, compare) lives in this browser's local storage; journal + snapshots in
// IndexedDB. Both survive refresh, closing the tab and reopening. If the browser
// is BLOCKING storage (private window, or site data disabled), saves fail silently
// — so warn once, and point to Export backup, instead of losing data quietly.
(function storageHealth() {
  let ok = false;
  try { localStorage.setItem("__probe__", "1"); ok = localStorage.getItem("__probe__") === "1"; localStorage.removeItem("__probe__"); } catch (e) { ok = false; }
  if (!ok) setTimeout(() => showToast("⚠ This browser is blocking storage — your holdings, watchlist & alerts won't be saved. Use a normal (non-private) window.", "err"), 1800);
})();
updateBellDot();
updateCompareBadge();
updateClock();
setInterval(updateClock, 15000);
loadMarket();
setInterval(loadMarket, 60000);
setInterval(tickLive, 1000);
startPolling();
showPage("home");
