'use strict';
// A strategy is a recipe: a flat set of named choices ("genes"). Because it is structured, the lab can
// vary it safely, describe it in plain words, backtest it and hand the exact same rules to the live advisor.
const { UNIVERSE, GROUPS, pipOf, isFx } = require('./data');

const GENES = {
  universe: ['majors', 'fx', 'indices', 'indices+gold'],
  side: ['both', 'long'],
  setup: ['pullRsi', 'pullEma', 'breakout', 'fade', 'cross', 'run'],
  rsiLen: [2, 5], rsiLt: [10, 15, 20, 25, 30, 35],
  emaLen: [20, 50], look: [3, 5],
  brkN: [10, 20, 55],
  fadeZ: [1.5, 2, 2.5], fadeRsi: [0, 30, 35, 40],
  crossLen: [10, 20, 50],
  runN: [3, 4, 5],
  trigger: ['none', 'prevHigh', 'upClose'],
  trend: ['none', 'e50', 'e200', 'e50e200', 'legacy', 'ret120', 'ret250'],
  macro: ['none', 'm1', 'm2', 'm3'],
  fund: ['none', 'carry0', 'carry1', 'carryChg', 'yChg', 'slope', 'carryOrChg', 'carryAndY', 'easy'],
  strength: ['none', 's20', 's60', 's120', 's60x'],
  risk: ['none', 'align', 'calm', 'notOff'],
  adx: ['none', 'gt20', 'gt25', 'lt20', 'lt25'],
  vol: ['none', 'lt1.5', 'lt1.8', 'gt0.8'],
  stop: [1.5, 2, 2.5, 3],
  t1: [0.5, 0.75, 1, 1.25, 1.5, 2], frac: [0.5, 1], t2: [0, 1.5, 2, 3], be: [0, 1], trail: [0, 2, 3],
  days: [5, 10, 15, 20, 30], ind: ['none', 'mean', 'rsiHi']
};
const SETUP_GENES = { pullRsi: ['rsiLen', 'rsiLt'], pullEma: ['emaLen', 'look'], breakout: ['brkN'], fade: ['fadeZ', 'fadeRsi'], cross: ['crossLen'], run: ['runN'] };
const FILTERS = ['trend', 'macro', 'fund', 'strength', 'risk', 'adx', 'vol'];
const DEFAULTS = { rsiLen: 2, rsiLt: 10, emaLen: 20, look: 3, brkN: 10, fadeZ: 1.5, fadeRsi: 0, crossLen: 10, runN: 3, t2: 0, be: 0, trail: 0 };

// Remove choices that do nothing for this recipe so two recipes that trade identically have the same key.
function canon(g) {
  const r = Object.assign({}, g);
  Object.keys(SETUP_GENES).forEach(s => { if (s !== r.setup) SETUP_GENES[s].forEach(k => { r[k] = DEFAULTS[k]; }); });
  if (r.frac === 1) { r.t2 = 0; r.be = 0; r.trail = 0; }
  else { if (r.t2 && r.t2 <= r.t1) r.t2 = GENES.t2.find(x => x > r.t1) || 0; if (!r.t2 && !r.trail) r.trail = 3; }
  if (r.setup === 'breakout' || r.setup === 'cross') r.trigger = 'none';
  const fxU = r.universe === 'majors' || r.universe === 'fx'; if (fxU) { r.side = 'both'; if (r.fund === 'easy') r.fund = 'none'; } else { r.macro = 'none'; r.strength = 'none'; if (r.fund !== 'easy') r.fund = 'none'; }
  const o = {}; Object.keys(GENES).forEach(k => { o[k] = r[k]; }); return o;
}
const keyOf = g => Object.keys(GENES).map(k => g[k]).join('|');
const complexity = g => FILTERS.filter(f => g[f] !== 'none').length + (g.trigger !== 'none' ? 1 : 0) + (g.ind !== 'none' ? 1 : 0);

function lcg(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
function randomRecipe(rnd) {
  const g = {}; Object.keys(GENES).forEach(k => { g[k] = pick(rnd, GENES[k]); });
  FILTERS.forEach(f => { if (rnd() < 0.55) g[f] = 'none'; });               // prefer simple recipes: most filters start switched off
  if (rnd() < 0.5) g.trigger = 'none'; if (rnd() < 0.6) g.ind = 'none';
  return canon(g);
}
function mutate(g, rnd) {
  const r = Object.assign({}, g); const active = Object.keys(GENES).filter(k => !Object.values(SETUP_GENES).some(a => a.includes(k)) || SETUP_GENES[r.setup].includes(k));
  const n = rnd() < 0.3 ? 2 : 1; for (let i = 0; i < n; i++) { const k = pick(rnd, active); const opts = GENES[k].filter(v => v !== r[k]); r[k] = pick(rnd, opts); }
  return canon(r);
}

// ---------- the rules ----------
// Returns +1 (buy), -1 (sell) or 0 for bar i of pair features F.
function setupAt(F, i, g, dir) {
  switch (g.setup) {
    case 'pullRsi': { const v = (g.rsiLen === 2 ? F.rsi2 : F.rsi5)[i]; return dir > 0 ? v < g.rsiLt : v > 100 - g.rsiLt; }
    case 'pullEma': { const e = g.emaLen === 20 ? F.e20 : F.e50; if (!(dir * (F.c[i] - e[i]) > 0)) return false; for (let k = i - g.look + 1; k <= i; k++) { if (dir > 0 ? F.l[k] <= e[k] + 0.25 * F.atr[k] : F.h[k] >= e[k] - 0.25 * F.atr[k]) return true; } return false; }
    case 'breakout': { const hh = F['hh' + g.brkN], ll = F['ll' + g.brkN]; return dir > 0 ? (F.c[i] > hh[i] && F.c[i - 1] <= hh[i - 1]) : (F.c[i] < ll[i] && F.c[i - 1] >= ll[i - 1]); }
    case 'fade': { const z = F.z20[i], r = F.rsi14[i]; return dir > 0 ? (z < -g.fadeZ && (!g.fadeRsi || r < g.fadeRsi)) : (z > g.fadeZ && (!g.fadeRsi || r > 100 - g.fadeRsi)); }
    case 'cross': { const e = g.crossLen === 10 ? F.e10 : (g.crossLen === 20 ? F.e20 : F.e50); return dir > 0 ? (F.c[i - 1] <= e[i - 1] && F.c[i] > e[i]) : (F.c[i - 1] >= e[i - 1] && F.c[i] < e[i]); }
    case 'run': return dir > 0 ? F.downRun[i] >= g.runN : F.upRun[i] >= g.runN;
  }
  return false;
}
function filtersAt(F, i, g, dir) {
  const c = F.c[i];
  switch (g.trend) {
    case 'e50': if (!(dir * (c - F.e50[i]) > 0)) return false; break;
    case 'e200': if (!(dir * (c - F.e200[i]) > 0)) return false; break;
    case 'e50e200': if (!(dir * (F.e50[i] - F.e200[i]) > 0)) return false; break;
    case 'legacy': if (!(dir * (c - F.e200[i]) > 0 && dir * (F.e50[i] - F.e200[i]) > 0 && dir * F.slope50[i] > 0)) return false; break;
    case 'ret120': if (!(dir * F.ret120[i] > 0)) return false; break;
    case 'ret250': if (!(dir * F.ret250[i] > 0)) return false; break;
  }
  switch (g.macro) {
    case 'm1': if (!(dir * F.macro[i] >= 1)) return false; break;
    case 'm2': if (!(dir * F.macro[i] >= 2)) return false; break;
    case 'm3': if (!(dir * F.macro[i] >= 3)) return false; break;
  }
  switch (g.fund) {
    case 'carry0': if (!(dir * F.carry[i] > 0)) return false; break;
    case 'carry1': if (!(dir * F.carry[i] >= 1)) return false; break;
    case 'carryChg': if (!(dir * F.carryChg[i] > 0.05)) return false; break;
    case 'yChg': if (!(dir * F.yChg[i] > 0.05)) return false; break;
    case 'slope': if (!(dir * F.slope[i] > 0)) return false; break;
    case 'easy': if (!(dir * F.usChg[i] <= 0.05)) return false; break;          // dollar interest rates are not rising (for buying shares or gold)
    case 'carryOrChg': if (!(dir * F.carry[i] >= 1 || dir * F.carryChg[i] > 0.1)) return false; break;
    case 'carryAndY': if (!(dir * F.carry[i] > 0 && dir * F.yChg[i] > 0)) return false; break;
  }
  switch (g.strength) {
    case 's20': if (!(dir * F.str20[i] > 0)) return false; break;
    case 's60': if (!(dir * F.str60[i] > 0)) return false; break;
    case 's120': if (!(dir * F.str120[i] > 0)) return false; break;
    case 's60x': if (!(dir * F.str60[i] > 2)) return false; break;
  }
  switch (g.risk) {
    case 'align': if (dir * F.riskBeta * F.risk[i] < 0) return false; break;       // do not fight the market mood
    case 'calm': if (!(F.vix[i] < 25)) return false; break;
    case 'notOff': if (F.risk[i] < 0 && dir * F.riskBeta > 0) return false; break;  // no risk-currency longs when markets are nervous
  }
  switch (g.adx) {
    case 'gt20': if (!(F.adx[i] > 20)) return false; break; case 'gt25': if (!(F.adx[i] > 25)) return false; break;
    case 'lt20': if (!(F.adx[i] < 20)) return false; break; case 'lt25': if (!(F.adx[i] < 25)) return false; break;
  }
  switch (g.vol) {
    case 'lt1.5': if (!(F.volRatio[i] < 1.5)) return false; break; case 'lt1.8': if (!(F.volRatio[i] < 1.8)) return false; break;
    case 'gt0.8': if (!(F.volRatio[i] > 0.8)) return false; break;
  }
  return true;
}
function dirAt(F, i, g, dir) {
  if (g.trigger === 'none') { if (!setupAt(F, i, g, dir)) return false; }
  else {
    if (!(setupAt(F, i - 1, g, dir) || setupAt(F, i - 2, g, dir))) return false;
    if (g.trigger === 'prevHigh' ? !(dir > 0 ? F.c[i] > F.h[i - 1] : F.c[i] < F.l[i - 1]) : !(dir * (F.c[i] - F.o[i]) > 0)) return false;
  }
  return filtersAt(F, i, g, dir);
}
function signalAt(F, i, g) { const a = dirAt(F, i, g, 1), b = g.side === 'long' ? false : dirAt(F, i, g, -1); return a === b ? 0 : (a ? 1 : -1); }

// ---------- one trade, walked forward bar by bar ----------
// Entry at the next bar's open. Inside a bar the stop is checked before any target (the cautious assumption).
// Returns null if there is no next bar; { open:true, ... } if still running at the end of the data.
const WARMUP = 260, SLIP_PIPS = 0.5;
function simulate(F, i, dir, g, costMult) {
  const n = F.n; if (i + 1 >= n) return null; const atr = F.atr[i]; if (!(atr > 0)) return null;
  const entry = F.o[i + 1], R = g.stop * atr, stop0 = entry - dir * R, t1 = entry + dir * g.t1 * R, t2 = g.t2 ? entry + dir * g.t2 * R : NaN;
  let stop = stop0, rem = 1, got = 0, partial = false, best = entry, mfe = 0, mae = 0, reason = null, x = -1;
  for (let j = i + 1; j < n; j++) {
    const hi = F.h[j], lo = F.l[j], op = F.o[j], cl = F.c[j];
    const adv = dir > 0 ? (lo - entry) / R : (entry - hi) / R, fav = dir > 0 ? (hi - entry) / R : (entry - lo) / R; if (adv < mae) mae = adv;
    if (dir > 0 ? lo <= stop : hi >= stop) { const px = dir > 0 ? Math.min(op, stop) : Math.max(op, stop); got += rem * dir * (px - entry) / R; rem = 0; reason = stop === stop0 ? 'STOP' : (partial && Math.abs(stop - (entry + dir * 0.1 * R)) < 1e-12 ? 'BE' : 'TRAIL'); x = j; break; }
    if (fav > mfe) mfe = fav;
    if (!partial && (dir > 0 ? hi >= t1 : lo <= t1)) { const px = dir > 0 ? Math.max(op, t1) : Math.min(op, t1); got += g.frac * dir * (px - entry) / R; rem -= g.frac; partial = true; if (rem <= 1e-9) { rem = 0; reason = 'T1'; x = j; break; } if (g.be) { const be = entry + dir * 0.1 * R; if (dir * (be - stop) > 0) stop = be; } }
    if (g.t2 && partial && (dir > 0 ? hi >= t2 : lo <= t2)) { const px = dir > 0 ? Math.max(op, t2) : Math.min(op, t2); got += rem * dir * (px - entry) / R; rem = 0; reason = 'T2'; x = j; break; }
    if (dir > 0 ? hi > best : lo < best) best = dir > 0 ? hi : lo;
    const rNow = dir * (cl - entry) / R;
    if (g.trail && (partial || rNow >= 1) && F.atr[j] > 0) { const ch = best - dir * g.trail * F.atr[j]; if (dir * (ch - stop) > 0) stop = ch; }
    let out = null;
    if (g.ind === 'mean' ? dir * (cl - F.sma20[j]) >= 0 : (g.ind === 'rsiHi' ? (dir > 0 ? F.rsi2[j] > 70 : F.rsi2[j] < 30) : false)) out = 'SIGNAL';
    else if (j - i >= g.days) out = 'TIME';
    if (out) { got += rem * rNow; rem = 0; reason = out; x = j; break; }
  }
  const pip = pipOf(F.sym), spread = (UNIVERSE[F.sym][2] * (costMult || 1) + SLIP_PIPS) * pip;
  if (rem > 0) return { open: true, i, dir, entry, stop, stop0, t1, t2, R, partial, mfe, mae, rOpen: got + rem * dir * (F.c[n - 1] - entry) / R };
  const nights = F.d[x] - F.d[i + 1]; const carry = isNaN(F.carry[i]) ? 0 : F.carry[i];
  const fin = (dir * carry - F.finMarkup) / 100 * (nights / 365) * entry / R;      // overnight financing: earn or pay the rate gap, minus the broker's markup
  return { i, x, dir, entry, stop0, t1, t2, R, r: got - spread / R + fin, gross: got, reason, mfe, mae, bars: x - i, entryDay: F.d[i + 1], exitDay: F.d[x] };
}

// All trades of a recipe on one pair, one position at a time.
function runPair(F, g, costMult, from) {
  const out = []; let i = Math.max(WARMUP, from || 0); const n = F.n; let open = null;
  while (i < n - 1) {
    const s = signalAt(F, i, g);
    if (s) { const t = simulate(F, i, s, g, costMult); if (t && !t.open) { t.sym = F.sym; out.push(t); i = Math.max(i + 1, t.x); continue; } if (t && t.open) { t.sym = F.sym; open = t; break; } }
    i++;
  }
  return { trades: out, open };
}

// Portfolio rules: at most `maxOpen` trades at once, at most two positions leaning the same way on any one currency,
// and at most `maxIndex` index or gold positions together (they tend to fall together).
function portfolio(trades, maxOpen = 6, maxIndex = 3) {
  const ev = trades.slice().sort((a, b) => a.entryDay - b.entryDay || a.exitDay - b.exitDay); const open = [], kept = [];
  for (const t of ev) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitDay <= t.entryDay) open.splice(k, 1);
    if (open.length >= maxOpen) continue; if (!isFx(t.sym) && open.filter(o => !isFx(o.sym)).length >= maxIndex) continue; const [b, q] = UNIVERSE[t.sym]; let nb = 0, nq = 0;
    for (const o of open) { const [ob, oq] = UNIVERSE[o.sym]; if ((ob === b && o.dir === t.dir) || (oq === b && o.dir === -t.dir)) nb++; if ((oq === q && o.dir === t.dir) || (ob === q && o.dir === -t.dir)) nq++; }
    if (nb >= 2 || nq >= 2) continue; open.push(t); kept.push(t);
  }
  return kept;
}
const symsOf = (X, g) => (GROUPS[g.universe] || X.syms.filter(isFx)).filter(s => X.P[s]);
function backtest(X, g, o = {}) {
  const syms = symsOf(X, g); let all = []; const open = [];
  for (const s of syms) { const r = runPair(X.P[s], g, o.costMult, o.from); all = all.concat(r.trades); if (r.open) open.push(r.open); }
  return { trades: portfolio(all, o.maxOpen), open };
}

// ---------- plain-language description ----------
function describe(g) {
  const setup = { pullRsi: 'a sharp dip (' + g.rsiLen + '-day RSI below ' + g.rsiLt + ')', pullEma: 'a pullback to the ' + g.emaLen + '-day average that price then reclaims', breakout: 'a fresh close beyond the ' + g.brkN + '-day high', fade: 'a stretch of ' + g.fadeZ + ' standard deviations below the 20-day average' + (g.fadeRsi ? ' with 14-day RSI under ' + g.fadeRsi : ''), cross: 'a close back above the ' + g.crossLen + '-day average', run: g.runN + ' down closes in a row' }[g.setup];
  const trig = { none: '', prevHigh: ', confirmed by a close above the previous day\'s high', upClose: ', confirmed by an up day' }[g.trigger];
  const trend = { none: null, e50: 'price is above its 50-day average', e200: 'price is above its 200-day average', e50e200: 'the 50-day average is above the 200-day', legacy: 'price and the 50-day average are above the 200-day and rising', ret120: 'the pair is up over the last 6 months', ret250: 'the pair is up over the last year' }[g.trend];
  const macro = { none: null, m1: 'the slow drivers lean the trade\'s way on balance (interest-rate gap moving, yield-curve gap, one-year trend)', m2: 'at least two of the three slow drivers favour the trade (interest-rate gap moving its way, steeper yield curve, one-year trend)', m3: 'all three slow drivers favour the trade (interest-rate gap moving its way, steeper yield curve, one-year trend)' }[g.macro];
  const fund = { none: null, carry0: 'the currency bought pays the higher interest rate', carry1: 'the currency bought pays at least 1 point more interest', carryChg: 'the interest-rate gap has been moving in the trade\'s favour over 3 months', yChg: 'the 10-year yield gap has been moving in the trade\'s favour over 3 months', slope: 'the currency bought has the steeper yield curve (markets expect its rates to rise more)', carryOrChg: 'the rate gap is at least 1 point in favour, or moving in favour', carryAndY: 'the rate gap is in favour and the 10-year yield gap is moving in favour', easy: 'short-term interest rates in the market\'s home currency have not been rising over the last 3 months' }[g.fund];
  const str = { none: null, s20: 'the currency bought has been the stronger of the two over 1 month', s60: 'the currency bought has been the stronger of the two over 3 months', s120: 'the currency bought has been the stronger of the two over 6 months', s60x: 'the currency bought has clearly out-performed the other over 3 months' }[g.strength];
  const risk = { none: null, align: 'the trade does not fight the market mood (risk-on or risk-off)', calm: 'the VIX is below 25', notOff: 'no buying of risk currencies while markets are nervous' }[g.risk];
  const adx = { none: null, gt20: 'the trend has some strength (ADX above 20)', gt25: 'the trend is strong (ADX above 25)', lt20: 'the market is range-bound (ADX below 20)', lt25: 'the market is not strongly trending (ADX below 25)' }[g.adx];
  const vol = { none: null, 'lt1.5': 'volatility is no more than 1.5 times normal', 'lt1.8': 'volatility is no more than 1.8 times normal', 'gt0.8': 'volatility is not unusually low' }[g.vol];
  const exit = g.frac === 1 ? 'Take the whole profit at ' + g.t1 + 'R.' : 'Bank half at ' + g.t1 + 'R' + (g.be ? ', move the stop to breakeven' : '') + ', then ' + (g.t2 ? 'close the rest at ' + g.t2 + 'R' : 'trail the rest') + (g.trail ? (g.t2 ? ' or on a ' : ' on a ') + g.trail + '-ATR trailing stop' : '') + '.';
  const ind = { none: '', mean: ' Exit early if price closes back at its 20-day average.', rsiHi: ' Exit early once the 2-day RSI recovers above 70.' }[g.ind];
  return {
    entry: 'Buy after ' + setup + trig + (g.side === 'long' ? '. Long only: no short selling.' : '. Sell short on the mirror image.'),
    conditions: [trend, macro, fund, str, risk, adx, vol].filter(Boolean).map(s => s.charAt(0).toUpperCase() + s.slice(1) + (g.side === 'long' ? '.' : ' (mirrored for shorts).')),
    stop: 'Stop ' + g.stop + ' ATR from entry.', exit: exit + ind + ' Close anything still open after ' + g.days + ' trading days.',
    universe: { majors: 'The 7 major dollar pairs.', fx: 'The 7 majors plus 10 crosses.', indices: '8 index CFDs: US500, NAS100, US30, US2000, GER40, UK100, FRA40 and EU50.', 'indices+gold': '8 index CFDs (US500, NAS100, US30, US2000, GER40, UK100, FRA40, EU50) plus gold.' }[g.universe]
  };
}
function nameOf(g) {
  const s = { pullRsi: 'Dip buyer', pullEma: 'Pullback', breakout: 'Breakout', fade: 'Stretch fade', cross: 'Average reclaim', run: 'Losing-run reversal' }[g.setup];
  const f = [g.trend !== 'none' ? 'trend' : null, g.macro !== 'none' ? 'macro score' : null, g.fund !== 'none' ? 'rates' : null, g.strength !== 'none' ? 'strength' : null, g.risk !== 'none' ? 'mood' : null].filter(Boolean);
  return s + (f.length ? ' with ' + f.join(' + ') : '');
}

module.exports = { GENES, FILTERS, canon, keyOf, complexity, lcg, randomRecipe, mutate, signalAt, dirAt, simulate, runPair, portfolio, backtest, symsOf, describe, nameOf, WARMUP };
