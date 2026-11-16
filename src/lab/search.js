'use strict';
// The improvement loop and the validation gauntlet.
//   search()      : random recipes, then generations of small mutations of the best ones (using training data only)
//   walkForward() : repeats the whole search on past windows and scores each winner on the years that followed it
//   gauntlet()    : the checks a recipe must pass before it may be proposed to the trader
const R = require('./recipe'); const { UNIVERSE, MAJORS, isoDay } = require('./data');

const WIN = 0.05; const SYMS = Object.keys(UNIVERSE);
// The trader's standing rules for any strategy.
const RULES = { minWinRate: 0.50, minPayoff: 0.8, minExpR: 0.04, minTradesPerYear: 10, minPosYears: 0.6, holdoutMinWinRate: 0.45, luckMin: 0.95, randomMaxP: 0.05 };

function stats(rs, days) {
  const n = rs.length; if (!n) return { n: 0, winRate: 0, payoff: 0, expR: 0, t: 0, pf: 0, sumR: 0, maxDDR: 0, posYears: 0, years: {}, perYear: 0, avgWin: 0, avgLoss: 0, maxLossStreak: 0 };
  let w = 0, lo = 0, gw = 0, gl = 0, s = 0, s2 = 0, cum = 0, peak = 0, dd = 0, ls = 0, mls = 0; const years = {};
  for (let i = 0; i < n; i++) { const r = rs[i]; s += r; s2 += r * r; if (r > WIN) { w++; gw += r; ls = 0; } else if (r < -WIN) { lo++; gl -= r; ls++; if (ls > mls) mls = ls; } cum += r; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; if (days) { const y = new Date(days[i] * 86400000).getUTCFullYear(); years[y] = (years[y] || 0) + r; } }
  const mean = s / n, sd = Math.sqrt(Math.max(1e-12, s2 / n - mean * mean)); const yk = Object.keys(years); const span = days && n > 1 ? Math.max(0.5, (days[n - 1] - days[0]) / 365.25) : 1;
  return { n, winRate: w / n, payoff: w && lo ? (gw / w) / (gl / lo) : 0, avgWin: w ? gw / w : 0, avgLoss: lo ? -gl / lo : 0, expR: mean, t: mean / sd * Math.sqrt(n), pf: gl > 0 ? gw / gl : (gw > 0 ? 99 : 0), sumR: s, maxDDR: dd, maxLossStreak: mls, years, posYears: yk.length ? yk.filter(y => years[y] > 0).length / yk.length : 0, perYear: n / span, rPerYear: s / span };
}
const slice = (ev, from, to) => { const rs = [], ds = []; for (let i = 0; i < ev.n; i++) if (ev.ed[i] >= from && ev.xd[i] < to) { rs.push(ev.r[i]); ds.push(ev.ed[i]); } return { rs, ds }; };

function evaluate(X, cache, g, opts) {
  const k = R.keyOf(g); let ev = cache.get(k); if (ev) return ev;
  const tr = R.backtest(X, g, opts).trades.sort((a, b) => a.entryDay - b.entryDay); const n = tr.length;
  ev = { g, key: k, n, r: new Float32Array(n), ed: new Int32Array(n), xd: new Int32Array(n), sy: new Int8Array(n), dr: new Int8Array(n) }; for (let i = 0; i < n; i++) { ev.r[i] = tr[i].r; ev.ed[i] = tr[i].entryDay; ev.xd[i] = tr[i].exitDay; ev.sy[i] = SYMS.indexOf(tr[i].sym); ev.dr[i] = tr[i].dir; }
  cache.set(k, ev); return ev;
}

// How good a recipe looks on a window, with the trader's rules as hard requirements.
function fitness(ev, from, to, minPerYear) {
  const { rs, ds } = slice(ev, from, to); const s = stats(rs, ds); const yrs = Math.max(1, (to - from) / 365.25);
  const mid = from + (to - from) / 2; let a = 0, an = 0, b = 0, bn = 0; for (let i = 0; i < rs.length; i++) { if (ds[i] < mid) { a += rs[i]; an++; } else { b += rs[i]; bn++; } }
  const halves = an > 5 && bn > 5 && a > 0 && b > 0; const minN = (minPerYear || RULES.minTradesPerYear) * yrs;
  const valid = s.n >= minN && s.winRate >= RULES.minWinRate && s.payoff >= RULES.minPayoff && s.expR >= RULES.minExpR && s.posYears >= RULES.minPosYears && halves;
  const pen = 40 * Math.max(0, RULES.minWinRate + 0.01 - s.winRate) + 4 * Math.max(0, RULES.minPayoff - s.payoff) + (halves ? 0 : 1) + 3 * Math.max(0, RULES.minPosYears - s.posYears) + (s.n < minN ? 3 : 0);
  const score = s.t * (0.5 + 0.5 * s.posYears) - 0.12 * R.complexity(ev.g) - pen;
  return { s, valid, score };
}

function neighbours(g) { const out = []; for (const k of Object.keys(R.GENES)) for (const v of R.GENES[k]) { if (v === g[k]) continue; const c = R.canon(Object.assign({}, g, { [k]: v })); if (R.keyOf(c) !== R.keyOf(g) && c.setup === g.setup && c.universe === g.universe && c.side === g.side) out.push(c); } const seen = new Set(); return out.filter(c => { const k = R.keyOf(c); if (seen.has(k)) return false; seen.add(k); return true; }); }
function overlap(a, b, from, to) { const key = (e, i) => e.sy[i] * 100000 + e.ed[i]; const sa = new Set(); let na = 0; for (let i = 0; i < a.n; i++) if (a.ed[i] >= from && a.ed[i] < to) { sa.add(key(a, i)); na++; } let hit = 0, nb = 0; for (let i = 0; i < b.n; i++) if (b.ed[i] >= from && b.ed[i] < to) { nb++; for (let d = -2; d <= 2; d++) if (sa.has(key(b, i) + d)) { hit++; break; } } return Math.min(na, nb) ? hit / Math.min(na, nb) : 0; }
// Pool the trades of several recipes into one playbook: one position per pair at a time, then the usual portfolio caps.
function combine(evs, from, to) {
  let all = []; evs.forEach((ev, bi) => { for (let i = 0; i < ev.n; i++) if (ev.ed[i] >= from && ev.ed[i] < to) all.push({ sym: SYMS[ev.sy[i]], dir: ev.dr[i], entryDay: ev.ed[i], exitDay: ev.xd[i], r: ev.r[i], book: bi }); });
  all.sort((a, b) => a.entryDay - b.entryDay || a.book - b.book); const busy = {}; const one = []; for (const t of all) { if (busy[t.sym] && busy[t.sym] > t.entryDay) continue; busy[t.sym] = t.exitDay; one.push(t); }
  return R.portfolio(one);
}

// One search: n0 random recipes, then `gens` rounds where the best `top` each produce `kids` small variations.
function search(X, cache, o) {
  const rnd = R.lcg(o.seed || 1), from = o.from, to = o.to; const seen = new Map();
  const allow = o.universes; const fit = g => (!allow || allow.includes(g.universe)) ? g : R.canon(Object.assign({}, g, { universe: allow[(g.stop * 2 + g.days) % allow.length] }));
  const consider = g0 => { const ev = evaluate(X, cache, fit(g0), o.bt); if (seen.has(ev.key)) return; seen.set(ev.key, Object.assign({ ev }, fitness(ev, from, to, o.minPerYear))); };
  const poolRnd = R.lcg(o.poolSeed || 99); for (let i = 0; i < o.n0; i++) consider(R.randomRecipe(poolRnd));   // the same random pool for every window, so nothing leaks between them
  (o.seeds || []).forEach(g => consider(R.canon(g)));
  const ranked = () => Array.from(seen.values()).sort((a, b) => (b.valid - a.valid) || (b.score - a.score));
  const history = [];
  for (let gen = 0; gen < o.gens; gen++) {
    const best = ranked().slice(0, o.top); history.push({ gen, best: best[0] ? best[0].score : null, valid: Array.from(seen.values()).filter(x => x.valid).length, tried: seen.size });
    for (const p of best) for (let k = 0; k < o.kids; k++) consider(R.mutate(p.ev.g, rnd));
    if (o.onProgress) o.onProgress(gen + 1, o.gens);
  }
  let fin = ranked().filter(x => x.valid); history.push({ gen: o.gens, best: fin[0] ? fin[0].score : null, valid: fin.length, tried: seen.size });
  // Plateau check: a recipe only counts if its close relatives (one choice changed) also work. A lone spike is curve-fitting.
  const finalists = fin.slice(0, o.finalists || 20);
  for (const c of finalists) { const ts = []; for (const nb of neighbours(c.ev.g)) { const f = fitness(evaluate(X, cache, nb, o.bt), from, to, o.minPerYear); ts.push(f.s.n >= 20 ? f.s.t : 0); } ts.sort((a, b) => a - b); c.plateau = ts.length ? ts[ts.length >> 1] : 0; c.stable = ts.length ? ts.filter(t => t > 0).length / ts.length : 0; c.robust = 0.5 * c.score + 0.5 * c.plateau * (0.5 + 0.5 * c.s.posYears) - 0.12 * R.complexity(c.ev.g); }
  finalists.sort((a, b) => b.robust - a.robust);
  // Playbook: the best recipe plus up to k-1 others that are genuinely different (another setup, or little overlap in trades).
  const book = []; for (const c of finalists) { if (book.length >= (o.k || 1)) break; if (c.stable < 0.7) continue; if (book.some(b => b.ev.g.setup === c.ev.g.setup && overlap(b.ev, c.ev, from, to) > 0.5)) continue; book.push(c); }
  return { best: book[0] || null, book, top: finalists.slice(0, o.keep || 10), tried: seen.size, history };
}

// Repeat the search on expanding past windows; score each window's winner on the unseen block after it.
function walkForward(X, cache, o) {
  const folds = []; let rs = [], ds = [];
  for (let split = o.firstSplit; split + 30 < o.end; split += o.step) {
    const res = search(X, cache, Object.assign({}, o, { from: o.start, to: split, seed: (o.seed || 1) + split }));
    const tEnd = Math.min(o.end, split + o.step); const f = { split, to: tEnd, tried: res.tried, picked: null };
    if (res.best) { const evs = res.book.map(c => c.ev); const tr = combine(evs, o.start, split), te = combine(evs, split, tEnd); const r2 = te.map(t => t.r), d2 = te.map(t => t.entryDay); f.picked = { keys: evs.map(e => e.key), key: evs.map(e => e.key).join('  +  '), g: res.best.ev.g, train: stats(tr.map(t => t.r), tr.map(t => t.entryDay)), test: stats(r2, d2), plateau: res.best.plateau, stable: res.best.stable }; rs = rs.concat(r2); ds = ds.concat(d2); }
    folds.push(f); if (o.onFold) o.onFold(f);
  }
  return { folds, oos: stats(rs, ds), rs, ds };
}

// ---------- luck tests ----------
function bootstrap(rs, sims = 1000, seed = 7) { const n = rs.length; if (n < 10) return { probProfit: 0, p5: 0, p50: 0, p95: 0 }; const rnd = R.lcg(seed); const tot = []; let pos = 0; for (let s = 0; s < sims; s++) { let t = 0; for (let i = 0; i < n; i++) t += rs[Math.floor(rnd() * n)]; tot.push(t); if (t > 0) pos++; } tot.sort((a, b) => a - b); return { probProfit: pos / sims, p5: tot[Math.floor(sims * 0.05)], p50: tot[sims >> 1], p95: tot[Math.floor(sims * 0.95)] }; }
// Same exits, same number of trades per pair and direction, but entered on random days. If random entries do as well, the entry rules add nothing.
function randomEntryTest(X, g, trades, o = {}) {
  const sims = o.sims || 200, rnd = R.lcg(o.seed || 5), from = o.from || 0, to = o.to || 1e9; const per = {};
  trades.forEach(t => { if (t.entryDay < from || t.entryDay >= to) return; const p = per[t.sym] || (per[t.sym] = { n: 0, long: 0 }); p.n++; if (t.dir > 0) p.long++; });
  const actual = stats(trades.filter(t => t.entryDay >= from && t.entryDay < to).map(t => t.r)).expR; let ge = 0; const exps = [];
  for (let s = 0; s < sims; s++) {
    let all = [];
    for (const sym of Object.keys(per)) { const F = X.P[sym]; let lo = R.WARMUP, hi = F.n - 2; while (lo < hi && F.d[lo] < from) lo++; while (hi > lo && F.d[hi] >= to) hi--; const idx = new Set(); let guard = 0; while (idx.size < per[sym].n && guard++ < per[sym].n * 20) idx.add(lo + Math.floor(rnd() * (hi - lo))); let last = -1; Array.from(idx).sort((a, b) => a - b).forEach(i => { if (i <= last) return; const t = R.simulate(F, i, rnd() < per[sym].long / per[sym].n ? 1 : -1, g, o.costMult); if (t && !t.open) { t.sym = sym; all.push(t); last = t.x; } }); }
    const e = stats(R.portfolio(all).map(t => t.r)).expR; exps.push(e); if (e >= actual) ge++;
  }
  exps.sort((a, b) => a - b); return { actual, p: (ge + 1) / (sims + 1), randomMedian: exps[sims >> 1], random95: exps[Math.floor(sims * 0.95)] };
}

// ---------- full report on one recipe ----------
function report(X, g, o) {
  const bt = R.backtest(X, g, o.bt); const tr = bt.trades.sort((a, b) => a.entryDay - b.entryDay);
  const pick = (a, b) => tr.filter(t => t.entryDay >= a && t.entryDay < b); const st = a => stats(a.map(t => t.r), a.map(t => t.entryDay));
  const design = pick(o.start, o.holdout), hold = pick(o.holdout, o.end + 1), all = pick(o.start, o.end + 1);
  const tag = t => { const F = X.P[t.sym]; return { risk: F.risk[t.i], adx: F.adx[t.i] }; };
  const grp = (a, fn) => { const m = {}; a.forEach(t => { const k = fn(t); (m[k] || (m[k] = [])).push(t); }); return Object.keys(m).map(k => Object.assign({ key: k }, pickStats(st(m[k])))).sort((x, y) => y.n - x.n); };
  const pickStats = s => ({ n: s.n, winRate: s.winRate, expR: s.expR, sumR: s.sumR, pf: s.pf, payoff: s.payoff });
  const sAll = st(all), sDes = st(design), sHold = st(hold);
  const curve = []; { let c = 0; all.slice().sort((a, b) => a.exitDay - b.exitDay).forEach(t => { c += t.r; curve.push([t.exitDay, Math.round(c * 100) / 100]); }); }
  return {
    g, key: R.keyOf(g), name: R.nameOf(g), describe: R.describe(g), complexity: R.complexity(g), trades: tr, open: bt.open,
    all: sAll, design: sDes, holdout: sHold, curve,
    byMood: grp(all, t => ({ '1': 'Risk-on', '0': 'Neutral', '-1': 'Risk-off' })[tag(t).risk]), byTrend: grp(all, t => tag(t).adx >= 25 ? 'Trending (ADX 25+)' : 'Ranging (ADX under 25)'),
    byPair: grp(all, t => t.sym), bySide: grp(all, t => t.dir > 0 ? 'Long' : 'Short'), byExit: grp(all, t => t.reason),
    avgBars: all.length ? all.reduce((s, t) => s + t.bars, 0) / all.length : 0
  };
}

// The gates. Every one must pass before a recipe is proposed.
function gauntlet(X, rep, o) {
  const checks = []; const add = (id, label, pass, detail) => checks.push({ id, label, pass: !!pass, detail });
  const d = rep.design, h = rep.holdout, a = rep.all; const pct = x => (x * 100).toFixed(1) + '%', r3 = x => (x >= 0 ? '+' : '') + x.toFixed(3) + 'R';
  add('winrate', 'Win rate at least ' + pct(RULES.minWinRate).replace('.0', ''), a.winRate >= RULES.minWinRate, pct(a.winRate) + ' over ' + a.n + ' trades');
  add('payoff', 'Average win at least ' + RULES.minPayoff + ' times the average loss', a.payoff >= RULES.minPayoff, a.payoff.toFixed(2) + ' (avg win ' + a.avgWin.toFixed(2) + 'R, avg loss ' + a.avgLoss.toFixed(2) + 'R)');
  add('expectancy', 'Positive expectancy after spread, slippage and overnight financing', a.expR >= RULES.minExpR, r3(a.expR) + ' per trade, ' + (a.rPerYear >= 0 ? '+' : '') + a.rPerYear.toFixed(1) + 'R a year');
  add('sample', 'Enough trades to judge', a.perYear >= RULES.minTradesPerYear, a.perYear.toFixed(0) + ' trades a year');
  add('years', 'Profitable in at least ' + Math.round(RULES.minPosYears * 100) + '% of years', a.posYears >= RULES.minPosYears, Math.round(a.posYears * Object.keys(a.years).length) + ' of ' + Object.keys(a.years).length + ' years');
  if (o.wf) add('walkforward', 'The search process made money on years it had not seen', o.wf.oos.expR >= RULES.minExpR && o.wf.oos.winRate >= RULES.holdoutMinWinRate && o.wf.oos.n >= 30, r3(o.wf.oos.expR) + ' per trade, ' + pct(o.wf.oos.winRate) + ' wins over ' + o.wf.oos.n + ' unseen trades');
  add('holdout', 'Held up on the most recent, locked-away data', h.n >= 15 && h.expR > 0 && h.winRate >= RULES.holdoutMinWinRate, h.n + ' trades, ' + pct(h.winRate) + ' wins, ' + r3(h.expR) + ' per trade');
  const bs = bootstrap(rep.trades.map(t => t.r), 1000); rep.luck = bs;
  add('luck', 'Not luck: profitable in at least 95% of reshuffled histories', bs.probProfit >= RULES.luckMin, pct(bs.probProfit) + ' of 1,000 reshuffles ended in profit');
  const re = randomEntryTest(X, rep.g, rep.trades, { sims: o.randomSims || 200, from: o.start, to: o.end + 1 }); rep.random = re;
  add('random', 'Entries beat random entries with the same exits', re.p <= RULES.randomMaxP, 'random entries averaged ' + r3(re.randomMedian) + '; only ' + pct(re.p) + ' of random runs matched this');
  const moods = rep.byMood.filter(m => m.n >= 30); add('regimes', 'Works in calm and in nervous markets', moods.length >= 2 && moods.every(m => m.expR > -0.02) && rep.byTrend.every(m => m.n < 30 || m.expR > -0.02), rep.byMood.concat(rep.byTrend).map(m => m.key + ' ' + r3(m.expR)).join(', '));
  const sides = rep.bySide.filter(m => m.n >= 30); add('sides', 'Not dependent on one direction', sides.length === 2 && sides.every(m => m.expR > -0.02), rep.bySide.map(m => m.key + ' ' + r3(m.expR) + ' (' + m.n + ')').join(', '));
  if (o.champion) add('better', 'Better than the strategy in use', a.rPerYear > o.champion.rPerYear && h.rPerYear >= o.champion.holdoutRPerYear, a.rPerYear.toFixed(1) + 'R a year against ' + o.champion.rPerYear.toFixed(1) + 'R; last two years ' + h.rPerYear.toFixed(1) + 'R a year against ' + o.champion.holdoutRPerYear.toFixed(1) + 'R');
  return { checks, passed: checks.every(c => c.pass), failed: checks.filter(c => !c.pass).map(c => c.id) };
}

module.exports = { RULES, SYMS, stats, slice, evaluate, fitness, neighbours, overlap, combine, search, walkForward, bootstrap, randomEntryTest, report, gauntlet };
