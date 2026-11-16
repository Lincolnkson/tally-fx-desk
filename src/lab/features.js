'use strict';
// Everything a strategy recipe may look at, computed once per pair. All values at index i use only bars up to and including i.
const { UNIVERSE, MAJORS, CCYS, RISK_BETA, buildRates, isFx } = require('./data');

function ema(a, p) { const n = a.length, r = new Float64Array(n), k = 2 / (p + 1); let e = a[0]; for (let i = 0; i < n; i++) { e = i ? a[i] * k + e * (1 - k) : a[0]; r[i] = e; } return r; }
function wilder(a, p) { const n = a.length, r = new Float64Array(n).fill(NaN); if (n < p) return r; let s = 0; for (let i = 0; i < p; i++) s += a[i]; r[p - 1] = s / p; for (let i = p; i < n; i++) r[i] = (r[i - 1] * (p - 1) + a[i]) / p; return r; }
function rsi(c, p) { const n = c.length, g = new Float64Array(n), l = new Float64Array(n); for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1]; g[i] = d > 0 ? d : 0; l[i] = d < 0 ? -d : 0; } const ag = wilder(g, p), al = wilder(l, p), r = new Float64Array(n).fill(NaN); for (let i = p; i < n; i++) r[i] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]); return r; }
function rollMax(a, w) { const n = a.length, r = new Float64Array(n).fill(NaN); for (let i = w; i < n; i++) { let m = -Infinity; for (let k = i - w; k < i; k++) if (a[k] > m) m = a[k]; r[i] = m; } return r; }   // over the w bars BEFORE i
function rollMin(a, w) { const n = a.length, r = new Float64Array(n).fill(NaN); for (let i = w; i < n; i++) { let m = Infinity; for (let k = i - w; k < i; k++) if (a[k] < m) m = a[k]; r[i] = m; } return r; }
function rollMedian(a, w) { const n = a.length, r = new Float64Array(n).fill(NaN); for (let i = w - 1; i < n; i += 1) { if (i % 5 && i > w && !isNaN(r[i - 1])) { r[i] = r[i - 1]; continue; } const s = Array.from(a.subarray(i - w + 1, i + 1)).filter(x => !isNaN(x)).sort((x, y) => x - y); r[i] = s.length ? s[s.length >> 1] : NaN; } return r; }

function pairFeatures(B) {
  const { o, h, l, c, n } = B; const F = { n, d: B.d, o, h, l, c };
  const tr = new Float64Array(n); for (let i = 0; i < n; i++) tr[i] = i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i];
  F.atr = wilder(tr, 14); F.volRatio = new Float64Array(n).fill(NaN); const am = rollMedian(F.atr, 120); for (let i = 0; i < n; i++) F.volRatio[i] = F.atr[i] / am[i];
  F.e10 = ema(c, 10); F.e20 = ema(c, 20); F.e50 = ema(c, 50); F.e100 = ema(c, 100); F.e200 = ema(c, 200);
  F.rsi2 = rsi(c, 2); F.rsi5 = rsi(c, 5); F.rsi14 = rsi(c, 14);
  // ADX 14
  const pdm = new Float64Array(n), mdm = new Float64Array(n); for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0; }
  const sp = wilder(pdm, 14), sm = wilder(mdm, 14), dx = new Float64Array(n); for (let i = 0; i < n; i++) { const a = F.atr[i]; if (!(a > 0)) { dx[i] = 0; continue; } const p = 100 * sp[i] / a, m = 100 * sm[i] / a; dx[i] = p + m === 0 ? 0 : 100 * Math.abs(p - m) / (p + m); }
  F.adx = new Float64Array(n).fill(NaN); { const from = 14; const w = wilder(dx.subarray(from), 14); for (let i = 0; i < w.length; i++) F.adx[i + from] = w[i]; }
  // MACD histogram
  const e12 = ema(c, 12), e26 = ema(c, 26), line = new Float64Array(n); for (let i = 0; i < n; i++) line[i] = e12[i] - e26[i]; const sig = ema(line, 9); F.macdH = new Float64Array(n); for (let i = 0; i < n; i++) F.macdH[i] = line[i] - sig[i];
  [10, 20, 55].forEach(w => { F['hh' + w] = rollMax(h, w); F['ll' + w] = rollMin(l, w); });
  F.hc5 = rollMax(c, 5); F.lc5 = rollMin(c, 5);
  // z-score of close against its 20-day mean
  F.z20 = new Float64Array(n).fill(NaN); F.sma20 = new Float64Array(n).fill(NaN); { let s = 0, s2 = 0; for (let i = 0; i < n; i++) { s += c[i]; s2 += c[i] * c[i]; if (i >= 20) { s -= c[i - 20]; s2 -= c[i - 20] * c[i - 20]; } if (i >= 19) { const m = s / 20, v = Math.max(0, s2 / 20 - m * m); F.sma20[i] = m; F.z20[i] = v > 0 ? (c[i] - m) / Math.sqrt(v) : 0; } } }
  [5, 20, 60, 120, 250].forEach(w => { const r = new Float64Array(n).fill(NaN); for (let i = w; i < n; i++) r[i] = Math.log(c[i] / c[i - w]) * 100; F['ret' + w] = r; });
  F.slope50 = new Float64Array(n).fill(NaN); for (let i = 10; i < n; i++) F.slope50[i] = (F.e50[i] - F.e50[i - 10]) / F.atr[i];
  // consecutive down / up closes
  F.downRun = new Int16Array(n); F.upRun = new Int16Array(n); for (let i = 1; i < n; i++) { F.downRun[i] = c[i] < c[i - 1] ? F.downRun[i - 1] + 1 : 0; F.upRun[i] = c[i] > c[i - 1] ? F.upRun[i - 1] + 1 : 0; }
  return F;
}

// value of series at or before `day` (binary search), for aligning other markets to a pair's calendar
function locate(d, day) { let lo = 0, hi = d.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (d[m] <= day) { k = m; lo = m + 1; } else hi = m - 1; } return k; }

function build(raw) {
  const rates = buildRates(raw.fred || {}); const P = {};
  Object.keys(raw.pairs).forEach(s => { if (UNIVERSE[s] && raw.pairs[s] && raw.pairs[s].n > 300) P[s] = pairFeatures(raw.pairs[s]); });
  // market mood per day from VIX and the S&P 500 (same scoring as the live advisor)
  const vix = raw.gauges && raw.gauges.VIX, spx = (raw.gauges && raw.gauges.SPX) || raw.pairs.US500; const sp50 = spx ? ema(spx.c, 50) : null, sp200 = spx ? ema(spx.c, 200) : null;
  const moodAt = day => {
    let s = 0, v = NaN, above200 = 0;
    if (vix) { const k = locate(vix.d, day); if (k >= 5) { v = vix.c[k]; const ch = (v / vix.c[k - 5] - 1) * 100; if (v < 18) s += 1; if (v > 20) s -= 1; if (v > 25) s -= 1; if (ch > 15) s -= 1; } }
    if (spx) { const k = locate(spx.d, day); if (k >= 5) { s += spx.c[k] > sp50[k] ? 1 : -1; if ((spx.c[k] / spx.c[k - 5] - 1) * 100 < -3) s -= 1; above200 = spx.c[k] > sp200[k] ? 1 : -1; } }
    return { risk: s >= 2 ? 1 : (s <= -1 ? -1 : 0), vix: v, above200 };
  };
  // currency strength: each currency's log value against an equal basket of the eight, from the seven dollar pairs
  const haveMajors = MAJORS.every(s => P[s]); const strength = {};
  const usdVal = (ccy, day) => { if (ccy === 'USD') return 0; const s = MAJORS.find(m => UNIVERSE[m][0] === ccy || UNIVERSE[m][1] === ccy); const F = P[s]; const k = locate(F.d, day); if (k < 0) return NaN; return UNIVERSE[s][0] === ccy ? Math.log(F.c[k]) : -Math.log(F.c[k]); };
  const strengthAt = (day, back) => { const key = day + ':' + back; if (strength[key]) return strength[key]; const out = {}; let sum = 0; CCYS.forEach(c => { const v = (usdVal(c, day) - usdVal(c, day - back)) * 100; out[c] = v; sum += v; }); const mean = sum / CCYS.length; CCYS.forEach(c => { out[c] -= mean; }); strength[key] = out; return out; };
  Object.keys(P).forEach(s => {
    const F = P[s], [base, quote] = UNIVERSE[s], n = F.n, fx = isFx(s); F.sym = s; F.fx = fx; F.base = base; F.quote = quote; F.riskBeta = RISK_BETA[base] - RISK_BETA[quote]; F.finMarkup = fx ? 1.0 : 2.5; F.usChg = new Float64Array(n).fill(NaN);
    F.carry = new Float64Array(n).fill(NaN); F.carryChg = new Float64Array(n).fill(NaN); F.carryChg1 = new Float64Array(n).fill(NaN); F.carryChg6 = new Float64Array(n).fill(NaN); F.slope = new Float64Array(n).fill(NaN); F.yDiff = new Float64Array(n).fill(NaN); F.yChg = new Float64Array(n).fill(NaN);
    F.macro = new Int8Array(n); F.risk = new Int8Array(n); F.vix = new Float64Array(n).fill(NaN); F.spx200 = new Int8Array(n); F.str20 = new Float64Array(n).fill(NaN); F.str60 = new Float64Array(n).fill(NaN); F.str120 = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const day = F.d[i]; const rb = fx ? rates.at(base, day) : null, rq = rates.at(quote, day); if (rq && rq.r3 != null) { F.usChg[i] = rq.r3Chg3; if (!fx) F.carry[i] = -rq.r3; }   // an index or gold CFD: a long pays the dollar rate
      if (rb && rq && rb.r3 != null && rq.r3 != null) { F.carry[i] = rb.r3 - rq.r3; F.carryChg[i] = rb.r3Chg3 - rq.r3Chg3; F.carryChg1[i] = rb.r3Chg1 - rq.r3Chg1; F.carryChg6[i] = rb.r3Chg6 - rq.r3Chg6; if (rb.y10 != null && rq.y10 != null) F.slope[i] = (rb.y10 - rb.r3) - (rq.y10 - rq.r3); }
      if (rb && rq && rb.y10 != null && rq.y10 != null) { F.yDiff[i] = rb.y10 - rq.y10; F.yChg[i] = rb.y10Chg3 - rq.y10Chg3; }
      const md = moodAt(day); F.risk[i] = md.risk; F.vix[i] = md.vix; F.spx200[i] = md.above200;
      { const sg = (x, t) => x > t ? 1 : (x < -t ? -1 : 0); F.macro[i] = fx ? sg(F.carryChg[i], 0.05) + sg(F.slope[i], 0) + sg(F.ret250[i], 0) : 0; }   // three slow drivers: rate gap moving, yield-curve gap, one-year trend
      if (fx && haveMajors && i >= 130) { const a = strengthAt(day, 28), b = strengthAt(day, 84), cc = strengthAt(day, 168); F.str20[i] = a[base] - a[quote]; F.str60[i] = b[base] - b[quote]; F.str120[i] = cc[base] - cc[quote]; }
    }
  });
  return { P, rates, syms: Object.keys(P) };
}

module.exports = { build, pairFeatures, ema, wilder, rsi, locate };
