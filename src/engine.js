'use strict';
// Same rules as the n8n "Technical Engine" + "Strategy Scorer" nodes, factored so the
// backtester and the live advisor stay in lockstep.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function ema(a, p) { const k = 2 / (p + 1); const r = []; let e = a[0]; for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); r.push(e); } return r; }
function wilder(a, p) { const r = new Array(a.length).fill(null); if (a.length < p) return r; let s = 0; for (let i = 0; i < p; i++) s += a[i]; r[p - 1] = s / p; for (let i = p; i < a.length; i++) r[i] = (r[i - 1] * (p - 1) + a[i]) / p; return r; }
function trueRange(b) { return b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c))); }

function analyze(b, price) {
  const n = b.length, L = n - 1;
  const C = b.map(x => x.c), H = b.map(x => x.h), Lo = b.map(x => x.l);
  const e20 = ema(C, 20), e50 = ema(C, 50), e200 = ema(C, 200);
  const atrA = wilder(trueRange(b), 14); const atr = atrA[L];
  const recent = atrA.slice(-120).filter(v => v != null).sort((p, q) => p - q); const med = recent[Math.floor(recent.length / 2)];
  const gains = C.map((c, i) => i === 0 ? 0 : Math.max(c - C[i - 1], 0)), loss = C.map((c, i) => i === 0 ? 0 : Math.max(C[i - 1] - c, 0));
  const ag = wilder(gains, 14), al = wilder(loss, 14); const rsi = al[L] === 0 ? 100 : 100 - 100 / (1 + ag[L] / al[L]);
  const pdm = b.map((x, i) => { if (i === 0) return 0; const up = x.h - H[i - 1], dn = Lo[i - 1] - x.l; return up > dn && up > 0 ? up : 0; });
  const mdm = b.map((x, i) => { if (i === 0) return 0; const up = x.h - H[i - 1], dn = Lo[i - 1] - x.l; return dn > up && dn > 0 ? dn : 0; });
  const sp = wilder(pdm, 14), sm = wilder(mdm, 14);
  const dx = []; for (let i = 0; i < n; i++) { if (atrA[i] == null || sp[i] == null) continue; const pd = 100 * sp[i] / atrA[i], md = 100 * sm[i] / atrA[i]; dx.push(pd + md === 0 ? 0 : 100 * Math.abs(pd - md) / (pd + md)); }
  const adxA = wilder(dx, 14); const adx = adxA[adxA.length - 1];
  const e12 = ema(C, 12), e26 = ema(C, 26); const line = e12.map((v, i) => v - e26[i]); const sig = ema(line, 9);
  const hist = line[L] - sig[L], histPrev = line[L - 1] - sig[L - 1];
  const close = C[L]; const slope = e50[L] - e50[L - 10]; let trend = 'MIXED';
  if (close > e200[L] && e50[L] > e200[L] && slope > 0) trend = 'UP'; else if (close < e200[L] && e50[L] < e200[L] && slope < 0) trend = 'DOWN';
  const hh20 = Math.max(...H.slice(L - 20, L)), ll20 = Math.min(...Lo.slice(L - 20, L));
  const sl5 = Math.min(...Lo.slice(L - 4, L + 1)), sh5 = Math.max(...H.slice(L - 4, L + 1));
  const pbLong = Math.min(...Lo.slice(L - 5, L + 1)) <= e20[L] + 0.25 * atr && close > e50[L];
  const pbShort = Math.max(...H.slice(L - 5, L + 1)) >= e20[L] - 0.25 * atr && close < e50[L];
  let brL = null, brS = null;
  for (let k = L - 12; k < L; k++) {
    const lv = Math.max(...H.slice(k - 20, k)); if (C[k] > lv + 0.1 * atr) brL = { k, level: lv };
    const lw = Math.min(...Lo.slice(k - 20, k)); if (C[k] < lw - 0.1 * atr) brS = { k, level: lw };
  }
  if (brL) { let rt = false, fail = false; for (let j = brL.k + 1; j <= L; j++) { if (Lo[j] <= brL.level + 0.5 * atr) rt = true; if (C[j] < brL.level - 0.5 * atr) fail = true; } brL = { level: brL.level, barsAgo: L - brL.k, retested: rt, holding: !fail && close > brL.level }; }
  if (brS) { let rt = false, fail = false; for (let j = brS.k + 1; j <= L; j++) { if (H[j] >= brS.level - 0.5 * atr) rt = true; if (C[j] > brS.level + 0.5 * atr) fail = true; } brS = { level: brS.level, barsAgo: L - brS.k, retested: rt, holding: !fail && close < brS.level }; }
  return { price: price || close, close, prevHigh: H[L - 1], prevLow: Lo[L - 1], ema20: e20[L], ema50: e50[L], ema200: e200[L], atr, volRatio: atr / med, rsi, adx, macdHist: hist, macdHistPrev: histPrev, trend, hh20, ll20, sl5, sh5, pbLong, pbShort, trigLong: close > H[L - 1], trigShort: close < Lo[L - 1], brLong: brL, brShort: brS, rangeWidthAtr: (hh20 - ll20) / atr, posInRange: (close - ll20) / (hh20 - ll20) };
}

// gauges: { VIX:{last,chg5}, SPX:{above50,chg5} }
function regimeOf(g) {
  let s = 0; const v = g && g.VIX, sp = g && g.SPX;
  if (v) { if (v.last < 18) s += 1; if (v.last > 20) s -= 1; if (v.last > 25) s -= 1; if (v.chg5 > 15) s -= 1; }
  if (sp) { s += sp.above50 ? 1 : -1; if (sp.chg5 < -3) s -= 1; }
  return { state: s >= 2 ? 'RISK_ON' : (s <= -1 ? 'RISK_OFF' : 'NEUTRAL'), score: s, vix: v ? v.last : null };
}

// ctx: { macro, regime, events:[{country,title,impact,date}], now:ms, fundMode:'static'|'off' }
function evalDir(p, d, ctx) {
  const M = ctx.macro, S = M.settings, off = ctx.fundMode === 'off', regime = ctx.regime;
  const dir = d === 'LONG' ? 1 : -1; const reasons = [], veto = [];
  const rd = off ? 0 : M.rates[p.base] - M.rates[p.quote]; const sd = off ? 0 : M.stance[p.base] - M.stance[p.quote];
  const raw = clamp(rd / 2, -1, 1) * 0.6 + clamp(sd / 2, -1, 1) * 0.4; const fa = raw * dir;
  const F = off ? 15 : Math.max(0, fa) * 30; if (fa < -0.15) veto.push('fundamental headwind');
  const tm = (p.trend === 'UP' && dir === 1) || (p.trend === 'DOWN' && dir === -1), opp = (p.trend === 'UP' && dir === -1) || (p.trend === 'DOWN' && dir === 1);
  const T = tm ? 15 + clamp((p.adx - 18) / 12, 0, 1) * 10 : (opp ? 0 : 5);
  const pb = dir === 1 ? p.pbLong : p.pbShort, trig = dir === 1 ? p.trigLong : p.trigShort, br = dir === 1 ? p.brLong : p.brShort;
  let setup = 'NONE', Su = 0, entry = p.close, stopDist = 0, t1 = 0, t2 = 0, minRR = S.minRR, entryType = 'market'; const slBase = dir === 1 ? p.sl5 : p.sh5;
  if (tm && pb) { setup = 'S1 Macro trend + pullback'; Su = trig ? 20 : 10; if (!trig) { entry = dir === 1 ? p.prevHigh + 0.1 * p.atr : p.prevLow - 0.1 * p.atr; entryType = 'stop'; reasons.push('Pullback seen, waiting for trigger'); } }
  if (br && br.retested && br.holding && !opp && 18 > Su) { setup = 'S4 Breakout + retest'; Su = 18; entry = p.close; entryType = 'market'; }
  if (Su < 14 && p.adx < 20 && p.rangeWidthAtr > 3 && p.rangeWidthAtr < 10 && Math.abs(raw) < 0.35) { const edge = dir === 1 ? (p.posInRange < 0.2 && p.rsi < 38) : (p.posInRange > 0.8 && p.rsi > 62); if (edge) { setup = 'S5 Range mean-reversion'; Su = 14; minRR = 1.5; entry = p.close; entryType = 'market'; } }
  if (setup === 'NONE') veto.push('no valid setup');
  if (opp && setup !== 'S5 Range mean-reversion') veto.push('counter-trend');
  if (setup === 'S5 Range mean-reversion') { stopDist = dir === 1 ? entry - (p.ll20 - 0.5 * p.atr) : (p.hh20 + 0.5 * p.atr) - entry; t1 = (p.hh20 + p.ll20) / 2; t2 = dir === 1 ? p.hh20 - 0.25 * p.atr : p.ll20 + 0.25 * p.atr; }
  else { stopDist = clamp(dir === 1 ? entry - (slBase - 0.25 * p.atr) : (slBase + 0.25 * p.atr) - entry, p.atr, 2.5 * p.atr); t1 = entry + dir * 2 * stopDist; t2 = entry + dir * 3 * stopDist; const obs = dir === 1 ? p.hh20 : p.ll20; const room = dir * (obs - entry) / stopDist; if (setup === 'S1 Macro trend + pullback' && room > 0 && room < 1.5) veto.push('recent ' + (dir === 1 ? 'high' : 'low') + ' only ' + room.toFixed(1) + 'R away'); }
  const stop = entry - dir * stopDist, rr = stopDist > 0 ? dir * (t1 - entry) / stopDist : 0;
  if (setup !== 'NONE' && rr < minRR) veto.push('reward:risk ' + rr.toFixed(1) + ' below ' + minRR);
  const rg = M.riskCcy[p.base] - M.riskCcy[p.quote], rv = regime.state === 'RISK_ON' ? 1 : (regime.state === 'RISK_OFF' ? -1 : 0);
  const R = regime.state === 'NEUTRAL' ? 5 : 5 + clamp(rg * rv * dir, -1, 1) * 5;
  const mom = ((dir * p.macdHist > 0) ? 3 : 0) + ((dir * (p.macdHist - p.macdHistPrev) > 0) ? 2 : 0) + ((dir === 1 ? (p.rsi >= 45 && p.rsi <= 68) : (p.rsi >= 32 && p.rsi <= 55)) ? 5 : 0);
  const cd = dir * rd; const C = off ? 0 : ((cd >= 1.5 && regime.state !== 'RISK_OFF' && (regime.vix || 0) < 22) ? 5 : (cd >= 0.75 ? 2 : 0));
  if (p.volRatio > 1.8) veto.push('volatility spike ' + p.volRatio.toFixed(1) + 'x');
  (ctx.events || []).forEach(e => { if (e.impact !== 'High' || ![p.base, p.quote].includes(e.country)) return; const h = (Date.parse(e.date) - ctx.now) / 3600000; if (h > -2 && h <= S.eventBlockHours) veto.push('event risk: ' + e.country + ' ' + e.title); });
  const total = Math.round(F + T + Su + R + mom + C);
  return { dir: d, total, F: Math.round(F), T: Math.round(T), Su, R: Math.round(R), mom, C, setup, entryType, entry, stop, t1, t2, rr, veto, reasons, usdDir: p.base === 'USD' ? dir : -dir, stopDist };
}
function evaluate(p, ctx) { const a = evalDir(p, 'LONG', ctx), b = evalDir(p, 'SHORT', ctx); return a.total >= b.total ? a : b; }

module.exports = { ema, wilder, trueRange, analyze, regimeOf, evalDir, evaluate, clamp };
