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
let currentSym = null, currentTf = getSettings().defaultTf, lastCandle = null, emaAt = {};
const lastv = (a) => (a && a.length ? a[a.length - 1].value : null);
const PAGE_TITLES = { dashboard: "Dashboard", search: "Search", watchlist: "Watchlist", screeners: "Screeners", alerts: "Alerts", reports: "Reports" };
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

function buildEmaPop() {
  const emaRows = emaConfig.map((cfg, i) =>
    `<label class="emarow"><input type="checkbox" class="ema-on" data-i="${i}" ${cfg.on ? "checked" : ""}>
      <span class="emaswatch" style="background:${EMA_COLORS[i]}"></span><span>EMA</span>
      <input type="number" class="emaperiod" data-i="${i}" min="1" max="400" value="${cfg.period}"></label>`).join("");
  const rsiRow = `<div class="indsec">Oscillators</div>
    <label class="emarow"><input type="checkbox" class="rsi-on" ${rsiCfg.on ? "checked" : ""}>
      <span class="emaswatch" style="background:${RSI_COLOR}"></span><span>RSI</span>
      <input type="number" class="rsi-period" min="2" max="100" value="${rsiCfg.period}"></label>
    <label class="emarow"><input type="checkbox" class="macd-on" ${macdCfg.on ? "checked" : ""}>
      <span class="emaswatch" style="background:${MACD_COLORS.macd}"></span><span>MACD</span>
      <span class="macdcfg">${macdCfg.fast}/${macdCfg.slow}/${macdCfg.signal}</span></label>
    <div class="indsec">Overlays</div>
    <label class="emarow"><input type="checkbox" class="bb-on" ${bbCfg.on ? "checked" : ""}>
      <span class="emaswatch" style="background:#94a3b8"></span><span>Bollinger</span>
      <span class="macdcfg">${bbCfg.period}/${bbCfg.mult}</span></label>
    <label class="emarow"><input type="checkbox" class="st-on" ${stCfg.on ? "checked" : ""}>
      <span class="emaswatch" style="background:linear-gradient(90deg,#15b870,#f04444)"></span><span>Supertrend</span>
      <span class="macdcfg">${stCfg.period}/${stCfg.mult}</span></label>`;
  $("emaPop").innerHTML = `<div class="indsec" style="margin-top:0">Moving averages</div>` + emaRows + rsiRow
    + `<div class="emahint">Chart overlays only — signals always use the weekly 9/21 &amp; 21/50.</div>`;
  $("emaPop").querySelectorAll(".rsi-on").forEach((cb) =>
    cb.addEventListener("change", () => { rsiCfg.on = cb.checked; saveRsiCfg(); applyRSI(); setTimeout(fitChart, 40); }));
  $("emaPop").querySelectorAll(".rsi-period").forEach((inp) =>
    inp.addEventListener("change", () => {
      const v = Math.max(2, Math.min(100, parseInt(inp.value) || 14));
      rsiCfg.period = v; inp.value = v; saveRsiCfg(); applyRSI();
    }));
  $("emaPop").querySelectorAll(".macd-on").forEach((cb) =>
    cb.addEventListener("change", () => { macdCfg.on = cb.checked; saveMacdCfg(); applyMACD(); setTimeout(fitChart, 40); }));
  $("emaPop").querySelectorAll(".bb-on").forEach((cb) =>
    cb.addEventListener("change", () => { bbCfg.on = cb.checked; saveBbCfg(); applyBollinger(); }));
  $("emaPop").querySelectorAll(".st-on").forEach((cb) =>
    cb.addEventListener("change", () => { stCfg.on = cb.checked; saveStCfg(); applySupertrend(); }));
  $("emaPop").querySelectorAll(".ema-on").forEach((cb) =>
    cb.addEventListener("change", () => { emaConfig[+cb.dataset.i].on = cb.checked; saveEmaCfg(); applyEMAs(); }));
  $("emaPop").querySelectorAll(".emaperiod").forEach((inp) =>
    inp.addEventListener("change", () => {
      const v = Math.max(1, Math.min(400, parseInt(inp.value) || 1));
      emaConfig[+inp.dataset.i].period = v; inp.value = v; saveEmaCfg(); applyEMAs();
    }));
}
$("emaBtn").addEventListener("click", (e) => { e.stopPropagation(); buildEmaPop(); $("emaPop").classList.toggle("hidden"); });
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
function renderDetail(d) {
  const v = d.verdict, q = d.quality, val = d.valuation;
  const strong = v.headline.startsWith("STRONG");
  const cls = strong ? "STRONG" : v.action;
  let combined = "";
  if (q && q.available) {
    if (v.action === "BUY" && q.quality === "PASS") combined = "✅ <b>Quality ✓ + buy trigger</b> — both halves align.";
    else if (v.action === "BUY" && q.quality === "FAIL") combined = "⚠️ <b>Chart-only</b> — trigger but fails quality.";
  }
  let html = `<div class="verdict ${cls}"><div class="vaction">${strong ? "STRONG BUY" : v.action}</div>
     <div class="vhead">${v.headline}</div>${combined ? `<div class="vnote">${combined}</div>` : ""}</div>`;

  html += statusStrip(d.signal_9_21, d.signal_21_50);
  html += confluenceBlock(d.confluence);

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
  html += `<div class="block"><h3>Signals</h3>
     <div class="subtitle">Short-term 9 / 21 (entry)</div>${regimeLine(d.signal_9_21)}
     <div class="subtitle">Long-term 21 / 50 (trend)</div>${regimeLine(d.signal_21_50)}
     ${rsiHtml}${macdHtml}</div>`;

  if (q && q.available) {
    const qcls = { PASS: "ok", NEAR: "near", FAIL: "no" }[q.quality] || "";
    const vcls = { CHEAP: "ok", FAIR: "near", EXPENSIVE: "no" }[q.valuation] || "";
    html += `<div class="block"><h3>Quality <span style="color:#5b6475;font-weight:400">as of ${q.as_of}</span></h3>
       <div style="display:flex;gap:6px;margin-bottom:8px">
         <span class="pill ${qcls}">QUALITY ${q.quality} (${q.quality_passed}/${q.quality_total})</span>
         <span class="pill ${vcls}">${q.valuation}</span></div>
       <div class="subtitle">Business quality</div>${q.quality_gates.map(gateRow).join("")}
       <div class="subtitle">Valuation &amp; ownership</div>${q.value_gates.map(gateRow).join("")}
       ${q.flag ? `<div class="flagnote">⚠ ${q.flag}</div>` : ""}</div>`;
  } else {
    html += `<div class="block"><h3>Quality</h3><div class="note">No fundamentals on file for this stock — chart &amp; signal only.</div></div>`;
  }

  if (val && val.applicable) {
    const up = val.upside_pct;
    const upPill = val.flag
      ? `<span class="pill unreliable" title="Unreliable for cyclicals — a sanity check, not a price target">~${up == null ? "—%" : (up >= 0 ? "+" + up : up) + "%"} ⚠ unreliable</span>`
      : `<span class="pill ${up == null ? "" : (up >= 0 ? "ok" : "no")}">${up == null ? "—" : (up >= 0 ? "+" + up + "% upside" : up + "% downside")}</span>`;
    html += `<div class="block"><h3>Intrinsic value <span style="color:#5b6475;font-weight:400">5-model</span></h3>
       <div style="display:flex;gap:6px;margin-bottom:8px">
         <span class="pill">₹${val.intrinsic != null ? fmt(val.intrinsic) : "—"}</span>
         ${upPill}</div>
       ${val.models.map((m) => `<div class="row"><span>${m.name}</span><span class="r-v">${m.value != null ? "₹" + fmt(m.value) : "—"}</span></div>`).join("")}
       ${val.flag ? `<div class="flagnote">⚠ ${val.flag} — unreliable for cyclicals.</div>` : ""}
       <div class="note">Rough estimate on generic assumptions · ${val.used}/5 models · a sanity check, not a price target.</div></div>`;
  } else if (val) {
    html += `<div class="block"><h3>Intrinsic value</h3><div class="note">${val.note || ""}</div></div>`;
  }
  $("detailPanel").innerHTML = html;
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
      if (e.key === "Enter" && input.id === "searchInput" && input.value.trim()) {
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
const FILTER_ORDER = ["STRONG BUY", "BUY", "HOLD", "WAIT", "CHART-ONLY", "SELL"];
function whyText(x) {
  const q = x.quality;
  if (x.penny && !q) {
    // low-priced / penny: chart-and-signal only, quality not rated (not curated)
    if (x.category === "STRONG BUY" || x.category === "BUY") return "Buy cross on the chart — <b>quality not rated</b> (penny/low-price, outside the curated universe).";
    if (x.category === "SELL") return "<b>Exit signal</b> — 9/21 death cross. Quality not rated.";
    return "No buy signal yet (9/21 below). <b>Quality not rated</b> — penny/low-price.";
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
  return `<div class="card stockcard" data-sym="${x.symbol}" tabindex="0" role="button" aria-label="${nm}, ${x.category}">
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
  const priceChips = PRICE_BANDS.map((p) => {
    const n = p.v ? suggestions.filter((x) => inBand(x.price, p.v)).length : suggestions.length;
    return `<button class="chip${priceBand === p.v ? " active" : ""}" data-pb="${p.v}">${p.t}${p.v ? `<span class="n">${n}</span>` : ""}</button>`;
  }).join("");
  f.innerHTML = `<div class="filters">${catChips}</div>
    <div class="filters pricefilters"><span class="filterlbl">Price</span>${priceChips}</div>`;
  f.querySelectorAll("[data-f]").forEach((b) =>
    b.addEventListener("click", () => { activeFilter = b.dataset.f; renderFilters(); renderHomeCards(); }));
  f.querySelectorAll("[data-pb]").forEach((b) =>
    b.addEventListener("click", () => { priceBand = b.dataset.pb; renderFilters(); renderHomeCards(); }));
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
    el.addEventListener("click", (e) => { if (!e.target.closest(".addbtn,.cardstar")) loadStock(el.dataset.sym); }));
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
  const rows = suggestions.filter((x) =>
    (activeFilter === "ALL" || x.category === activeFilter) && inBand(x.price, priceBand));
  box.innerHTML = rows.map(cardHTML).join("")
    || stateBox({ icon: "🗂️", title: "Nothing here", msg: "No stocks match these filters — try another category or price range." });
  wireStockCards(box);
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
      renderState($("homeCards"), { icon: "📡", title: "Feed unavailable", msg: "Can't reach the price feed to scan right now — this is usually temporary.", retry: true }, loadSuggestions);
      return;
    }
    renderHomeStats();
    renderFilters();
    renderHomeCards();
  } catch (e) {
    $("homeStats").innerHTML = "";
    renderState($("homeCards"), { icon: "📡", title: "Scan failed", msg: "Couldn't run the scan. Check your connection and try again.", retry: true }, loadSuggestions);
  }
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
async function loadWatchlist() {
  const w = getWatch();
  const box = $("watchCards");
  if (!box) return;
  box.className = "stocklist";
  if (!w.length) { box.innerHTML = stateBox({ icon: "★", title: "No watchlist yet", msg: "Star a stock from Home or any chart to track it here." }); return; }
  box.innerHTML = skelCards(Math.min(w.length, 6));
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
}
function loadScreeners() { if (typeof renderScreeners === "function") renderScreeners(); }
function loadAlerts() { if (typeof renderAlerts === "function") renderAlerts(); }
function loadReports() { if (typeof renderReports === "function") renderReports(); }
function loadHome() {
  if (getSettings().autoScan) { loadSuggestions(); return; }
  if (suggestions.length) { renderHomeStats(); renderFilters(); renderHomeCards(); return; }
  $("homeFilters").classList.add("hidden");
  $("homeCards").innerHTML = '<div class="empty">Auto-scan is off — <button id="scanNow" class="btn sm">Scan now</button></div>';
  const sb = document.getElementById("scanNow");
  if (sb) sb.addEventListener("click", loadSuggestions);
}
$("refreshHome").addEventListener("click", () =>
  withBtnLoading($("refreshHome"), "Refreshing…", loadSuggestions));
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
       <div class="sethint">Off = Home opens instantly; tap Refresh or “Scan now” for the live scan.</div></div>`;
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
}
$("setBtn").addEventListener("click", (e) => { e.stopPropagation(); buildSetPanel(); $("setPanel").classList.toggle("hidden"); });
document.addEventListener("click", (e) => {
  if (!$("setPanel").contains(e.target) && e.target.id !== "setBtn") $("setPanel").classList.add("hidden");
});

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
}
function removeHolding(sym) {
  saveHoldings(getHoldings().filter((h) => (h.ticker || "").toUpperCase() !== sym.toUpperCase()));
}
async function computeHoldings() {
  return (await fetch("/api/holdings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdings: getHoldings() }),
  })).json();
}
async function loadHoldings() {
  $("dashHoldings").innerHTML = skelCards(3);
  try { renderHoldings(await computeHoldings()); setLive(); }
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
let alOp = "above";
function alertRow(a) {
  const st = a.fired ? '<span class="al-st fired">✓ Triggered</span>' : '<span class="al-st armed">● Armed</span>';
  return `<div class="alert-row ${a.fired ? "fired" : ""}">
    <div class="al-main"><div class="al-name">${a.n}</div><div class="al-cond">${a.t.replace(".NS", "")} <b>${a.op}</b> ₹${fmt(a.price)}</div></div>
    ${st}<button class="al-remove iconbtn" data-id="${a.id}" title="Remove" aria-label="Remove alert">✕</button></div>`;
}
function renderAlerts() {
  const body = $("alertsBody");
  if (!body) return;
  const alerts = getAlerts();
  body.innerHTML = `<div class="alert-add">
      <div class="acwrap"><input id="alSym" class="al-in" placeholder="Stock — name or symbol" autocomplete="off"><div id="alDrop" class="dropdown hidden"></div></div>
      <div class="seg" id="alOp"><button data-op="above" class="${alOp === "above" ? "active" : ""}">Above</button><button data-op="below" class="${alOp === "below" ? "active" : ""}">Below</button></div>
      <input id="alPrice" class="al-in al-price" type="number" min="0" step="any" placeholder="Target ₹">
      <button id="alAdd" class="btn">Add alert</button></div>
    ${alerts.length ? `<div class="alertlist">${alerts.map(alertRow).join("")}</div>`
      : stateBox({ icon: "🔔", title: "No alerts yet", msg: "Add a price alert above — it fires when the delayed quote crosses your target." })}`;
  attachAutocomplete($("alSym"), $("alDrop"), (s) => { $("alSym").value = s.t; $("alSym").dataset.name = s.n; });
  $("alOp").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { alOp = b.dataset.op; $("alOp").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b)); }));
  $("alAdd").addEventListener("click", () => {
    let s = $("alSym").value.trim().toUpperCase(); if (!s) return; if (!s.includes(".")) s += ".NS";
    const p = parseFloat($("alPrice").value);
    if (!(p > 0)) { showToast("Enter a target price", "err"); return; }
    const a = getAlerts();
    a.push({ id: Date.now(), t: s, n: $("alSym").dataset.name || s.replace(".NS", ""), op: alOp, price: p, fired: false });
    saveAlerts(a); showToast("Alert added", "ok"); renderAlerts();
  });
  body.querySelectorAll(".al-remove").forEach((b) =>
    b.addEventListener("click", () => { saveAlerts(getAlerts().filter((x) => String(x.id) !== b.dataset.id)); renderAlerts(); updateBellDot(); }));
}
async function checkAlerts() {
  const armed = getAlerts().filter((a) => !a.fired);
  if (!armed.length) return;
  const syms = [...new Set(armed.map((a) => a.t))];
  try {
    const d = await (await fetch("/api/quote?symbols=" + encodeURIComponent(syms.join(",")))).json();
    const q = d.quotes || {};
    let changed = false;
    const all = getAlerts();
    all.forEach((a) => {
      if (a.fired) return;
      const price = (q[a.t] || {}).price;
      if (price == null) return;
      if ((a.op === "above" && price >= a.price) || (a.op === "below" && price <= a.price)) {
        a.fired = true; changed = true;
        showToast(`🔔 ${a.n} is ${a.op} ₹${fmt(a.price)} — now ₹${fmt(price)}`, "ok");
      }
    });
    if (changed) { saveAlerts(all); updateBellDot(); if (document.getElementById("page-alerts").classList.contains("active")) renderAlerts(); }
  } catch (e) {}
}

/* ---------- Reports (N6) — portfolio + universe analytics from existing data ---------- */
async function renderReports() {
  const body = $("reportsBody");
  if (!body) return;
  body.innerHTML = '<div class="scanhint"><span class="spinner"></span>Building your report…</div>';
  let hold, scan;
  try {
    [hold, scan] = await Promise.all([
      (await fetch("/api/holdings")).json(),
      (await fetch("/api/scanner")).json(),
    ]);
  } catch (e) { renderState(body, { icon: "📡", title: "Couldn't build the report", msg: "Check your connection and try again.", retry: true }, renderReports); return; }
  const rows = (scan.results || []).filter((x) => x.category !== "ERROR");
  const H = hold.holdings || [];
  const plc = hold.total_pl >= 0 ? "green" : "red";
  const sc = (cls, ic, v, l) => `<div class="statcard ${cls}"><div class="st-ic">${statIcon(ic)}</div><div class="st-t"><div class="st-v">${v}</div><div class="st-l">${l}</div></div></div>`;
  const stats = `<div class="statrow">
    ${sc("blue", "up", "₹" + fmt(hold.total_value), "Portfolio value")}
    ${sc(plc, "up", (hold.total_pl >= 0 ? "+" : "") + "₹" + fmt(hold.total_pl), "Total P/L" + (hold.total_pl_pct != null ? " · " + (hold.total_pl_pct >= 0 ? "+" : "") + hold.total_pl_pct + "%" : ""))}
    ${sc("green", "star", H.length, "Holdings")}
    ${sc("amber", "clock", H.filter((h) => h.code === "SELL" || h.code === "EXIT").length, "Exit alerts")}</div>`;
  const CATS = ["STRONG BUY", "BUY", "HOLD", "WAIT", "CHART-ONLY", "SELL"];
  const CATCOL = { "STRONG BUY": "var(--buy)", "BUY": "var(--buy)", "HOLD": "var(--hold)", "WAIT": "var(--wait)", "CHART-ONLY": "var(--warn)", "SELL": "var(--sell)" };
  const maxN = rows.length || 1;
  const dist = CATS.map((c) => { const n = rows.filter((x) => x.category === c).length; return `<div class="dist-row"><span class="dist-l">${c}</span><div class="dist-bar"><i style="width:${n / maxN * 100}%;background:${CATCOL[c]}"></i></div><span class="dist-n">${n}</span></div>`; }).join("");
  const withChg = rows.filter((x) => x.chg1w != null).slice().sort((a, b) => b.chg1w - a.chg1w);
  const mover = (x) => `<div class="mover-row"><span class="mv-n">${x.name}</span><span class="mv-c ${x.chg1w >= 0 ? "up" : "down"}">${x.chg1w >= 0 ? "+" : ""}${x.chg1w}%</span></div>`;
  const gainers = withChg.slice(0, 5).map(mover).join("") || '<div class="note">No data yet.</div>';
  const losers = withChg.slice(-5).reverse().map(mover).join("") || '<div class="note">No data yet.</div>';
  const alloc = H.filter((h) => h.value).slice().sort((a, b) => (b.value || 0) - (a.value || 0)).map((h) => {
    const w = hold.total_value ? Math.round(h.value / hold.total_value * 100) : 0;
    return `<div class="dist-row"><span class="dist-l">${h.name}</span><div class="dist-bar"><i style="width:${w}%;background:var(--accent)"></i></div><span class="dist-n">${w}%</span></div>`;
  }).join("") || '<div class="note">No holdings yet.</div>';
  body.innerHTML = stats + `<div class="report-grid">
    <div class="report-card"><h3>Signal distribution · universe</h3>${dist}</div>
    <div class="report-card"><h3>Portfolio allocation</h3>${alloc}</div>
    <div class="report-card"><h3>Top gainers · 1 week</h3>${gainers}</div>
    <div class="report-card"><h3>Top losers · 1 week</h3>${losers}</div></div>`;
}

/* ---------- Screeners (N4) — filters the universe, reuses scanner data ---------- */
let screenData = [], screenFilters = { cat: "", q: "", v: "", conf: 0 };
async function renderScreeners() {
  const body = $("screenBody");
  if (!body) return;
  if (!screenData.length) {
    body.innerHTML = '<div class="scanhint"><span class="spinner"></span>Loading your universe…</div>';
    try {
      const d = await (await fetch("/api/scanner")).json();
      screenData = (d.results || []).filter((x) => x.category !== "ERROR");
    } catch (e) { renderState(body, { icon: "📡", title: "Couldn't load the universe", msg: "Check your connection and try again.", retry: true }, renderScreeners); return; }
  }
  drawScreeners();
}
function drawScreeners() {
  const body = $("screenBody"), f = screenFilters;
  const seg = (label, key, opts) => `<div class="scf"><div class="scf-l">${label}</div><div class="seg">${opts.map((o) =>
    `<button class="${String(f[key]) === String(o.v) ? "active" : ""}" data-sk="${key}" data-sv="${o.v}">${o.t}</button>`).join("")}</div></div>`;
  const filters = `<div class="screen-filters">
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
  body.innerHTML = filters + `<div class="screen-count"><b>${rows.length}</b> of ${screenData.length} stocks match</div>` +
    (rows.length ? `<div class="stocklist">${rows.map(cardHTML).join("")}</div>`
      : stateBox({ icon: "🔍", title: "No matches", msg: "Loosen the filters to see more stocks." }));
  body.querySelectorAll(".seg button[data-sk]").forEach((b) =>
    b.addEventListener("click", () => { const k = b.dataset.sk; f[k] = (k === "conf") ? +b.dataset.sv : b.dataset.sv; drawScreeners(); }));
  const list = body.querySelector(".stocklist"); if (list) wireStockCards(list);
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
async function loadMarket() {
  const st = $("marketState");
  const open = nseOpen();
  if (st) { st.textContent = open ? "● Open" : "● Closed"; st.className = "market-state " + (open ? "open" : "closed"); }
  const box = $("marketRows");
  if (!box) return;
  const row = (name, q) => {
    if (!q || q.error || q.price == null) return `<div class="mkt-row"><div class="mk-n">${name}</div><div class="mk-line"><span class="mk-v">—</span></div></div>`;
    const chg = q.prev_close ? (q.price - q.prev_close) / q.prev_close * 100 : null;
    const cls = chg == null ? "" : (chg >= 0 ? "up" : "down");
    return `<div class="mkt-row"><div class="mk-n">${name}</div>
      <div class="mk-line"><span class="mk-v">${fmt(q.price)}</span><span class="mk-c ${cls}">${chg == null ? "" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"}</span></div></div>`;
  };
  try {
    const d = await (await fetch("/api/quote?symbols=" + encodeURIComponent("^NSEI,^BSESN"))).json();
    const q = d.quotes || {};
    box.innerHTML = row("NIFTY 50", q["^NSEI"]) + row("SENSEX", q["^BSESN"]);
  } catch (e) { box.innerHTML = row("NIFTY 50", null) + row("SENSEX", null); }
}

/* ---------- boot ---------- */
updateBellDot();
loadMarket();
setInterval(loadMarket, 60000);
setInterval(tickLive, 1000);
startPolling();
showPage("home");
