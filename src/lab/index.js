'use strict';
// Strategy Lab pipeline: one function that takes raw history and returns everything the Lab page shows.
//   1. measure the strategy the advisor runs today on the same history
//   2. search for a better recipe using design data only (everything before the last two years)
//   3. walk-forward: repeat that search in the past and score each winner on the years after it (the reality check)
//   4. put the single best recipe through the gauntlet, including one look at the locked-away last two years
//   5. re-test whichever lab strategy is in use
const D = require('./data'), Fx = require('./features'), R = require('./recipe'), S = require('./search');
const FX_SYMS = Object.keys(D.UNIVERSE).filter(D.isFx);
const SIZES = { quick: { n0: 250, gens: 2, top: 10, kids: 3, sims: 60 }, standard: { n0: 2000, gens: 4, top: 24, kids: 5, sims: 200 }, deep: { n0: 4000, gens: 6, top: 30, kids: 6, sims: 300 } };
const HOLD_DAYS = 730, START = D.dayOfIso('2008-01-10');
const round = (x, p = 3) => x == null || isNaN(x) ? null : Math.round(x * 10 ** p) / 10 ** p;
const lite = s => ({ n: s.n, winRate: round(s.winRate), payoff: round(s.payoff, 2), expR: round(s.expR), sumR: round(s.sumR, 1), rPerYear: round(s.rPerYear, 1), perYear: round(s.perYear, 1), maxDDR: round(s.maxDDR, 1), pf: round(s.pf, 2), posYears: round(s.posYears, 2), avgWin: round(s.avgWin, 2), avgLoss: round(s.avgLoss, 2), maxLossStreak: s.maxLossStreak, t: round(s.t, 2), years: Object.fromEntries(Object.entries(s.years || {}).map(([k, v]) => [k, round(v, 1)])) });
const thin = (curve, max = 240) => { if (curve.length <= max) return curve; const out = [], step = curve.length / max; for (let i = 0; i < max; i++) out.push(curve[Math.floor(i * step)]); out.push(curve[curve.length - 1]); return out; };

// The strategy the advisor runs today (technical score of 70+, fixed exits), on the same history and the same windows.
async function baseline(raw, win, macro) {
  macro = macro || { settings: { minScore: 70, minRR: 2, eventBlockHours: 24 }, rates: {}, stance: {}, riskCcy: { AUD: 1, NZD: 1, CAD: 1, EUR: 0.5, GBP: 0.5, USD: -1, JPY: -1, CHF: -1 } };
  const candles = async ticker => { const s = ticker === '^VIX' ? raw.gauges.VIX : ticker === '^GSPC' ? raw.gauges.SPX : raw.pairs[ticker.replace('=X', '')]; if (!s) throw new Error('no data'); const bars = []; for (let i = 0; i < s.n; i++) bars.push({ t: s.d[i] * 86400, o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i] }); return { bars, price: bars[bars.length - 1].c }; };
  const years = (win.end - win.start) / 365.25; const minScore = (macro.settings && macro.settings.minScore) || 70;
  const { walkAll } = require('../sim'); const tr = (await walkAll({ years, minScore, fundMode: 'off', costPips: 1.5, macro, maxConcurrent: 4 }, candles)).map(t => ({ r: t.r, entryDay: D.dayOfIso(t.entryDate), exitDay: D.dayOfIso(t.exitDate) })).sort((a, b) => a.entryDay - b.entryDay);
  const st = a => S.stats(a.map(t => t.r), a.map(t => t.entryDay)); const pick = (a, b) => tr.filter(t => t.entryDay >= a && t.entryDay < b);
  let c = 0; const curve = tr.slice().sort((a, b) => a.exitDay - b.exitDay).map(t => { c += t.r; return [t.exitDay, round(c, 2)]; });
  return { name: 'Current advisor strategy', minScore, all: lite(st(pick(win.start, win.end + 1))), design: lite(st(pick(win.start, win.holdout))), holdout: lite(st(pick(win.holdout, win.end + 1))), last12: lite(st(pick(win.end - 365, win.end + 1))), curve: thin(curve), note: 'Technical score of ' + minScore + ' or more on the 7 majors, with the advisor\'s fixed exits and a 1.5-pip cost. The central-bank bias is left out because its history is not recorded.' };
}

function compact(rep, g) {
  const grp = a => a.map(m => ({ key: m.key, n: m.n, winRate: round(m.winRate), expR: round(m.expR), sumR: round(m.sumR, 1) }));
  return { key: rep.key, recipe: rep.g, name: rep.name, describe: rep.describe, complexity: rep.complexity, all: lite(rep.all), design: lite(rep.design), holdout: lite(rep.holdout), curve: thin(rep.curve), byPair: grp(rep.byPair), bySide: grp(rep.bySide), byMood: grp(rep.byMood), byTrend: grp(rep.byTrend), byExit: grp(rep.byExit), avgBars: round(rep.avgBars, 1), luck: rep.luck ? { probProfit: round(rep.luck.probProfit), p5: round(rep.luck.p5, 1), p50: round(rep.luck.p50, 1), p95: round(rep.luck.p95, 1) } : null, random: rep.random ? { p: round(rep.random.p), randomMedian: round(rep.random.randomMedian), actual: round(rep.random.actual) } : null, checks: g ? g.checks : null, passed: g ? g.passed : null, failed: g ? g.failed : null };
}

// Re-test of a strategy already in use: how the same rules did since it was approved and over the last 12 months.
function health(X, recipe, win, sinceDay) {
  const rep = S.report(X, recipe, { start: win.start, holdout: win.holdout, end: win.end }); const st = a => S.stats(a.map(t => t.r), a.map(t => t.entryDay));
  const last12 = st(rep.trades.filter(t => t.entryDay >= win.end - 365)), last6 = st(rep.trades.filter(t => t.entryDay >= win.end - 183)), since = sinceDay ? st(rep.trades.filter(t => t.entryDay >= sinceDay)) : null;
  let state = 'healthy', why = 'The last 12 months are in line with its history.';
  if (last12.n >= 8 && last12.expR < 0) { state = 'watch'; why = 'It lost money over the last 12 months (' + last12.sumR.toFixed(1) + 'R over ' + last12.n + ' trades).'; }
  if ((last12.n >= 12 && last12.sumR <= -5) || (since && since.n >= 20 && since.expR < 0) || (last12.n >= 12 && last12.winRate < 0.4)) { state = 'failing'; why = 'It no longer meets your rules: ' + (last12.sumR <= -5 ? last12.sumR.toFixed(1) + 'R over the last 12 months' : (since && since.n >= 20 && since.expR < 0 ? 'negative since you approved it (' + since.sumR.toFixed(1) + 'R over ' + since.n + ' trades)' : 'win rate ' + (last12.winRate * 100).toFixed(0) + '% over the last 12 months')) + '.'; }
  return { state, why, all: lite(rep.all), last12: lite(last12), last6: lite(last6), since: since ? lite(since) : null, curve: thin(rep.curve), checkedAt: new Date().toISOString() };
}

async function runPipeline(raw, o = {}) {
  const size = SIZES[o.size] || SIZES.standard, log = o.onProgress || (() => {}); const t0 = Date.now();
  log(0.02, 'Preparing indicators and interest-rate history');
  const X = Fx.build({ pairs: Object.fromEntries(Object.entries(raw.pairs).filter(([s]) => D.isFx(s))), gauges: raw.gauges, fred: raw.fred });
  const end = Math.max(...D.MAJORS.map(s => X.P[s].d[X.P[s].n - 1])), holdout = end - HOLD_DAYS, win = { start: START, holdout, end };
  const base = await baseline(raw, win, o.macro).catch(e => ({ error: e.message }));
  log(0.08, 'Searching for recipes on data up to ' + D.isoDay(holdout));
  const cache = new Map(); const common = { n0: size.n0, gens: size.gens, top: size.top, kids: size.kids, k: 1, minPerYear: 20, finalists: 20, universes: ['majors', 'fx'], poolSeed: 99, seeds: o.seeds || [] };
  const firstSplit = D.dayOfIso('2012-11-16'); const nFolds = Math.ceil((holdout - 31 - firstSplit) / 730); let done = 0;
  const wf = S.walkForward(X, cache, Object.assign({}, common, { start: START, firstSplit, step: 730, end: holdout - 1, seed: o.seed || 1, onFold: () => { done++; log(0.08 + 0.6 * done / (nFolds + 1), 'Reality check: ' + done + ' of ' + nFolds + ' past periods replayed'); } }));
  const res = S.search(X, cache, Object.assign({}, common, { from: START, to: holdout, seed: (o.seed || 1) + 7 }));
  log(0.75, 'Putting the best recipe through the gauntlet');
  const champ = o.active ? null : (base && base.all ? { rPerYear: base.all.rPerYear, holdoutRPerYear: base.holdout.rPerYear } : null);
  let activeHealth = null, champion = champ;
  if (o.active) { activeHealth = health(X, o.active.recipe, win, o.active.sinceDay); const rep = S.report(X, o.active.recipe, win); champion = { rPerYear: rep.all.rPerYear, holdoutRPerYear: rep.holdout.rPerYear }; }
  let pick = null;
  if (res.best) { const rep = S.report(X, res.best.ev.g, win); const g = S.gauntlet(X, rep, { start: START, end, wf, champion, randomSims: size.sims }); pick = compact(rep, g); pick.plateau = round(res.best.plateau, 2); pick.stable = round(res.best.stable, 2); pick.sameAsActive = !!(o.active && R.keyOf(R.canon(o.active.recipe)) === pick.key); }
  const folds = wf.folds.map(f => ({ from: D.isoDay(f.split), to: D.isoDay(f.to), name: f.picked ? R.nameOf(f.picked.g) : null, train: f.picked ? lite(f.picked.train) : null, test: f.picked ? lite(f.picked.test) : null }));
  const pf = folds.filter(f => f.train); const avg = k => pf.length ? pf.reduce((s, f) => s + f.train[k], 0) / pf.length : 0;
  log(1, 'Done');
  return {
    asOf: D.isoDay(end), window: { start: D.isoDay(START), holdout: D.isoDay(holdout), end: D.isoDay(end) }, size: o.size || 'standard', tried: cache.size, seconds: Math.round((Date.now() - t0) / 1000), rules: S.RULES,
    baseline: base, pick, runnersUp: res.top.filter(c => !pick || c.ev.key !== pick.key).slice(0, 4).map(c => ({ name: R.nameOf(c.ev.g), design: lite(c.s), stable: round(c.stable, 2) })),
    reality: { folds, inSample: { winRate: round(avg('winRate')), expR: round(avg('expR')) }, unseen: lite(wf.oos) }, history: res.history, activeHealth,
    data: { pairs: X.syms.length, missing: FX_SYMS.filter(s => !X.P[s]), rates: Object.keys(raw.fred || {}).length }
  };
}

// ---------- live signals for an approved recipe ----------
// usd value of one unit of a currency, from the latest closes of the majors
function usdPer(X, ccy) { if (ccy === 'USD') return 1; const s = D.MAJORS.find(m => D.UNIVERSE[m][0] === ccy || D.UNIVERSE[m][1] === ccy); const F = X.P[s]; const c = F.c[F.n - 1]; return D.UNIVERSE[s][0] === ccy ? c : 1 / c; }
function planOf(g) { return { stopAtr: g.stop, t1R: g.t1, frac: g.frac, t2R: g.t2 || null, be: g.be ? 1 : 0, trailAtr: g.trail || null, days: g.days, ind: g.ind }; }
function liveSignals(raw, strat, ctx = {}) {
  const g = R.canon(strat.recipe); const X = Fx.build({ pairs: Object.fromEntries(Object.entries(raw.pairs).filter(([s]) => D.isFx(s))), gauges: raw.gauges, fred: raw.fred });
  const end = Math.max(...D.MAJORS.map(s => X.P[s].d[X.P[s].n - 1])); const open = (ctx.open || []).map(t => ({ sym: t.pair, dir: t.direction === 'LONG' ? 1 : -1 })).filter(t => D.UNIVERSE[t.sym]);
  const riskUsd = (ctx.equity || 10000) * (ctx.riskPct || 1) / 100; const items = []; const dp = s => s.indexOf('JPY') >= 0 ? 3 : 5; const rd = (x, s) => +x.toFixed(dp(s));
  const moodName = { '1': 'RISK_ON', '0': 'NEUTRAL', '-1': 'RISK_OFF' };
  for (const sym of R.symsOf(X, g)) {
    const F = X.P[sym]; const i = F.n - 1; const base = { pair: sym, ticker: D.tickerOf(sym), price: F.c[i], atr: F.atr[i], regime: moodName[F.risk[i]], vix: round(F.vix[i], 1), runAt: new Date().toISOString(), strategy: strat.label, lab: true };
    if (F.d[i] < end - 4) { items.push(Object.assign(base, { decision: 'WAIT', score: 0, reasons: ['Price history for this pair is stale'], vetoes: [] })); continue; }
    const dir = R.signalAt(F, i, g); let block = null;
    if (dir) { if (open.some(o => o.sym === sym)) block = 'You already hold ' + sym; else if (open.length >= 6) block = 'Six trades are already open'; else { const [b, q] = D.UNIVERSE[sym]; let nb = 0, nq = 0; for (const o of open) { const [ob, oq] = D.UNIVERSE[o.sym]; if ((ob === b && o.dir === dir) || (oq === b && o.dir === -dir)) nb++; if ((oq === q && o.dir === dir) || (ob === q && o.dir === -dir)) nq++; } if (nb >= 2 || nq >= 2) block = 'Two open trades already lean the same way on ' + (nb >= 2 ? b : q); } }
    if (!dir || block) { items.push(Object.assign(base, { decision: dir ? 'WATCH' : 'WAIT', direction: dir ? (dir > 0 ? 'LONG' : 'SHORT') : null, score: dir ? 60 : 0, reasons: [block || 'The recipe\'s entry conditions are not met today'], vetoes: block ? [block] : [] })); continue; }
    const Rd = g.stop * F.atr[i], entry = F.c[i], stop = entry - dir * Rd, t1 = entry + dir * g.t1 * Rd, t2 = g.t2 ? entry + dir * g.t2 * Rd : null; const qUsd = usdPer(X, D.UNIVERSE[sym][1]);
    const units = Math.max(1000, Math.round(riskUsd / (Rd * qUsd) / 1000) * 1000); open.push({ sym, dir });
    items.push(Object.assign(base, { decision: 'ENTER', direction: dir > 0 ? 'LONG' : 'SHORT', score: Math.round((strat.winRate || 0.5) * 100), entryType: 'market', entry: rd(entry, sym), stop: rd(stop, sym), target1: rd(t1, sym), target2: t2 ? rd(t2, sym) : null, rr: round(g.frac === 1 ? g.t1 : (g.t2 || g.t1), 2), units, riskUsd: round(riskUsd, 2), qUsd: round(qUsd, 6), plan: planOf(g),
      breakdown: 'Strategy Lab recipe. The score is the recipe\'s tested win rate.', reasons: [R.describe(g).entry].concat(R.describe(g).conditions), vetoes: [], exitText: R.describe(g).stop + ' ' + R.describe(g).exit }));
  }
  return { asOf: D.isoDay(end), items };
}

// What an untaken signal would have done under its own exit plan (used for the scorecard of lab signals).
function shadow(bars, sigDay, sym, dir, plan) {
  const d = Int32Array.from(bars.map(b => D.dayOfTs(b.t))), B = { d, o: Float64Array.from(bars.map(b => b.o)), h: Float64Array.from(bars.map(b => b.h)), l: Float64Array.from(bars.map(b => b.l)), c: Float64Array.from(bars.map(b => b.c)), n: bars.length };
  const F = Fx.pairFeatures(B); F.sym = sym; F.carry = new Float64Array(B.n).fill(NaN); F.finMarkup = 1; let i = -1; for (let k = 0; k < B.n; k++) if (d[k] <= sigDay) i = k; if (i < 20) return null;
  const g = { stop: plan.stopAtr, t1: plan.t1R, frac: plan.frac, t2: plan.t2R || 0, be: plan.be, trail: plan.trailAtr || 0, days: plan.days, ind: plan.ind || 'none' }; const t = R.simulate(F, i, dir, g, 1);
  return !t ? null : (t.open ? { status: 'OPEN' } : { status: 'CLOSED', r: t.r, reason: t.reason });
}

module.exports = { runPipeline, liveSignals, health, shadow, planOf, SIZES, FX_SYMS, START, HOLD_DAYS };
