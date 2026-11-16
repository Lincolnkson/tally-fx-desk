'use strict';
// Strategy Lab data layer: long daily price history (Yahoo) and interest-rate history (FRED),
// cleaned so one bad tick cannot create a fake win or a fake stop-out.

const UNIVERSE = {
  EURUSD: ['EUR', 'USD', 0.8], GBPUSD: ['GBP', 'USD', 1.2], USDJPY: ['USD', 'JPY', 1.0], AUDUSD: ['AUD', 'USD', 1.0], USDCAD: ['USD', 'CAD', 1.5], USDCHF: ['USD', 'CHF', 1.5], NZDUSD: ['NZD', 'USD', 1.5],
  EURJPY: ['EUR', 'JPY', 1.5], GBPJPY: ['GBP', 'JPY', 2.5], AUDJPY: ['AUD', 'JPY', 1.8], EURGBP: ['EUR', 'GBP', 1.2], EURAUD: ['EUR', 'AUD', 2.5], AUDNZD: ['AUD', 'NZD', 2.5], EURCHF: ['EUR', 'CHF', 2.0], CADJPY: ['CAD', 'JPY', 2.2], NZDJPY: ['NZD', 'JPY', 2.5], GBPAUD: ['GBP', 'AUD', 3.5],
  // dollar-quoted index and gold CFDs: cost is in points (index) or 10-cent steps (gold)
  US500: ['US500', 'USD', 0.6], NAS100: ['NAS100', 'USD', 2.0], US30: ['US30', 'USD', 3.0], US2000: ['US2000', 'USD', 0.5], GER40: ['GER40', 'EUR', 1.5], UK100: ['UK100', 'GBP', 1.5], FRA40: ['FRA40', 'EUR', 1.5], EU50: ['EU50', 'EUR', 2.0], XAUUSD: ['XAU', 'USD', 3.5]
};
const TICKERS = { US500: '^GSPC', NAS100: '^NDX', US30: '^DJI', US2000: '^RUT', GER40: '^GDAXI', UK100: '^FTSE', FRA40: '^FCHI', EU50: '^STOXX50E', XAUUSD: 'GC=F' };
const INDICES = ['US500', 'NAS100', 'US30', 'US2000', 'GER40', 'UK100', 'FRA40', 'EU50'];
const tickerOf = s => TICKERS[s] || s + '=X';
const isFx = s => !TICKERS[s];
const GROUPS = { majors: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD'], fx: null, indices: INDICES, 'indices+gold': INDICES.concat(['XAUUSD']) };
const MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD'];
const CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
const FRED_CC = { USD: 'US', EUR: 'EZ', GBP: 'GB', JPY: 'JP', AUD: 'AU', CAD: 'CA', CHF: 'CH', NZD: 'NZ' };
// How each currency tends to behave when markets are nervous: +1 gains in calm markets, -1 is a safe haven.
const RISK_BETA = { USD: -1, EUR: 0, GBP: 0, JPY: -1, AUD: 1, CAD: 1, CHF: -1, NZD: 1, US500: 1, NAS100: 1, US30: 1, US2000: 1, GER40: 1, UK100: 1, FRA40: 1, EU50: 1, XAU: -1 };
const GAUGES = { VIX: '^VIX', SPX: '^GSPC' };
const pipOf = sym => TICKERS[sym] ? (sym === 'XAUUSD' ? 0.1 : 1) : (sym.indexOf('JPY') >= 0 ? 0.01 : 0.0001);
const dayOfTs = t => Math.floor((t + 7200) / 86400);           // Yahoo stamps FX bars at UK midnight (23:00 or 00:00 UTC)
const isoDay = d => new Date(d * 86400000).toISOString().slice(0, 10);
const dayOfIso = s => Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
const dow = d => (d + 4) % 7;                                   // 0 = Sunday

function median(a) { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }

// rows: [{ d (day number), o, h, l, c }] in time order. Returns typed arrays.
function clean(rows, isFx) {
  let r = rows.filter(x => x && isFinite(x.o) && isFinite(x.h) && isFinite(x.l) && isFinite(x.c) && x.c > 0);
  if (isFx) r = r.filter(x => { const w = dow(x.d); return w !== 0 && w !== 6; });
  const seen = new Map(); r.forEach(x => seen.set(x.d, x)); r = Array.from(seen.values()).sort((a, b) => a.d - b.d);
  const n = r.length; const d = new Int32Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n); let fixed = 0;
  for (let i = 0; i < n; i++) { d[i] = r[i].d; o[i] = r[i].o; c[i] = r[i].c; h[i] = Math.max(r[i].h, r[i].o, r[i].c); l[i] = Math.min(r[i].l, r[i].o, r[i].c); }
  // 1. closes that jump away from their neighbours and come straight back are bad ticks
  for (let i = 1; i < n; i++) {
    const w = []; for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) w.push(c[k]);
    const m = median(w); if (Math.abs(c[i] / m - 1) > (isFx ? 0.04 : 0.25)) { o[i] = h[i] = l[i] = c[i] = c[i - 1]; fixed++; }
    else if (Math.abs(o[i] / c[i - 1] - 1) > (isFx ? 0.04 : 0.25)) { o[i] = c[i - 1]; h[i] = Math.max(h[i], o[i]); l[i] = Math.min(l[i], o[i]); fixed++; }
  }
  // 2. wicks far beyond anything the market was doing are clipped (the body is kept)
  if (isFx) {
    const tr = new Float64Array(n); for (let i = 0; i < n; i++) tr[i] = i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i];
    for (let i = 20; i < n; i++) { const m = median(tr.subarray(i - 20, i)); const hi = Math.max(o[i], c[i]) + 3 * m, lo = Math.min(o[i], c[i]) - 3 * m; if (h[i] > hi) { h[i] = hi; fixed++; } if (l[i] < lo) { l[i] = lo; fixed++; } }
  }
  return { d, o, h, l, c, n, fixed };
}

function parseYahoo(j, isFx) {
  const r = j.chart.result[0], q = r.indicators.quote[0]; const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) if (q.close[i] != null && q.high[i] != null && q.low[i] != null && q.open[i] != null) rows.push({ d: isFx ? dayOfTs(r.timestamp[i]) : Math.floor(r.timestamp[i] / 86400), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  return clean(rows, isFx);
}
function parseFred(csv) {
  const out = []; String(csv).trim().split('\n').slice(1).forEach(line => { const p = line.split(','); const v = Number(p[1]); if (p[0] && p[1] !== '' && p[1] !== '.' && isFinite(v)) out.push({ ym: p[0].slice(0, 7), v }); });
  return out;
}

// Monthly rate history per currency -> a function day -> { r3, y10, r3Chg3, y10Chg3 } that only uses months already published on that day.
function buildRates(fred) {
  const mIdx = ym => (Number(ym.slice(0, 4)) - 2000) * 12 + Number(ym.slice(5, 7)) - 1; const per = {};
  CCYS.forEach(ccy => {
    const cc = FRED_CC[ccy]; const mk = id => { const m = new Map(); (fred[id] || []).forEach(x => m.set(mIdx(x.ym), x.v)); return m; };
    const a = mk('IR3TIB01' + cc + 'M156N'), b = mk('IRSTCI01' + cc + 'M156N'), y = mk('IRLTLT01' + cc + 'M156N');
    const keys = [...a.keys(), ...b.keys(), ...y.keys()]; if (!keys.length) { per[ccy] = null; return; }
    const lo = Math.min(...keys), hi = Math.max(...keys); const r3 = [], y10 = []; let lr = null, ly = null, lb = null;
    for (let m = lo; m <= hi; m++) {
      if (a.has(m)) lr = a.get(m); else if (lr != null && b.has(m) && lb != null) lr = lr + (b.get(m) - lb); else if (lr == null && b.has(m)) lr = b.get(m);   // extend a stale 3-month series with moves in the overnight rate
      if (b.has(m)) lb = b.get(m); if (y.has(m)) ly = y.get(m); r3.push(lr); y10.push(ly);
    }
    per[ccy] = { lo, hi, r3, y10 };
  });
  const at = (ccy, day) => {
    const p = per[ccy]; if (!p) return null; const dt = new Date(day * 86400000); const m = (dt.getUTCFullYear() - 2000) * 12 + dt.getUTCMonth() - 2;   // two months back: the newest month the statistics offices have actually published by then
    const k = Math.min(p.hi, m) - p.lo; if (k < 6) return null; const g = (arr, i) => arr[Math.max(0, i)];
    return { r3: g(p.r3, k), y10: g(p.y10, k), r3Chg1: g(p.r3, k) - g(p.r3, k - 1), r3Chg3: g(p.r3, k) - g(p.r3, k - 3), r3Chg6: g(p.r3, k) - g(p.r3, k - 6), y10Chg3: g(p.y10, k) - g(p.y10, k - 3), y10Chg1: g(p.y10, k) - g(p.y10, k - 1) };
  };
  return { at, per };
}

// ---------- live loading (server) ----------
async function getText(url, tries = 3) {
  let err; for (let a = 0; a < tries; a++) { try { const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tally-lab)' }, signal: AbortSignal.timeout(30000) }); if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + new URL(url).host); return await res.text(); } catch (e) { err = e; await new Promise(r => setTimeout(r, 1200 * (a + 1))); } }
  throw err;
}
const yahooUrl = t => 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?interval=1d&period1=1167609600&period2=1999999999';
const fredUrl = id => 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id + '&cosd=2006-01-01';
const FRED_IDS = [].concat(...Object.values(FRED_CC).map(cc => ['IR3TIB01' + cc + 'M156N', 'IRSTCI01' + cc + 'M156N', 'IRLTLT01' + cc + 'M156N']));

// Fetch everything the lab needs. `fetchText` can be swapped in tests. Missing crosses or rate series are tolerated; missing majors are not.
async function loadLive(fetchText = getText, log = () => {}, only) {
  const pairs = {}, gauges = {}, fred = {}; const syms = only || Object.keys(UNIVERSE);
  const batch = async (items, fn, size) => { for (let i = 0; i < items.length; i += size) { await Promise.all(items.slice(i, i + size).map(fn)); await new Promise(r => setTimeout(r, 400)); } };
  await batch(syms, async s => { try { pairs[s] = parseYahoo(JSON.parse(await fetchText(yahooUrl(tickerOf(s)))), isFx(s)); } catch (e) { log('price history missing for ' + s + ': ' + e.message); } }, 3);
  await batch(Object.keys(GAUGES), async g => { try { gauges[g] = parseYahoo(JSON.parse(await fetchText(yahooUrl(GAUGES[g]))), false); } catch (e) { log('gauge missing: ' + g); } }, 2);
  await batch(FRED_IDS, async id => { try { fred[id] = parseFred(await fetchText(fredUrl(id), 2)); } catch (e) { log('rate history missing: ' + id); } }, 4);
  MAJORS.forEach(s => { if (!pairs[s] || pairs[s].n < 1500) throw new Error('Not enough price history for ' + s); });
  return { pairs, gauges, fred, loadedAt: new Date().toISOString() };
}

module.exports = { UNIVERSE, TICKERS, INDICES, GROUPS, tickerOf, isFx, MAJORS, CCYS, RISK_BETA, FRED_IDS, pipOf, dayOfTs, isoDay, dayOfIso, dow, median, clean, parseYahoo, parseFred, buildRates, loadLive, yahooUrl, fredUrl };
