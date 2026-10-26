'use strict';
const { wilder, trueRange, ema, analyze, evaluate, regimeOf } = require('./engine');
const { stats, histogram, monteCarlo, groupStats } = require('./stats');
const pipSize = pair => pair.indexOf('JPY') >= 0 ? 0.01 : 0.0001;
const iso = t => new Date(t * 1000).toISOString().slice(0, 10);

// Walk one planned trade forward over daily bars using the Exit Guardian's rules:
// stop first (conservative), half off at T1 then breakeven, T2 closes the rest, +1R arms a
// 3-ATR chandelier trail, 15 calendar days without progress is a time stop.
function simulateTrade(bars, atrA, sigIdx, plan, o = {}) {
  const dir = plan.dir; let fillIdx, fill, j;
  if (plan.entryType === 'market') { fillIdx = sigIdx; fill = plan.entry; j = sigIdx + 1; }
  else {
    fillIdx = -1;
    for (let k = sigIdx + 1; k <= sigIdx + 2 && k < bars.length; k++) { const b = bars[k]; if (dir === 1 ? b.h >= plan.entry : b.l <= plan.entry) { fillIdx = k; fill = dir === 1 ? Math.max(b.o, plan.entry) : Math.min(b.o, plan.entry); break; } }
    if (fillIdx < 0) return { status: sigIdx + 2 >= bars.length ? 'PENDING' : 'NOFILL' };
    j = fillIdx;
  }
  const R = Math.abs(fill - plan.stop); if (!(R > 0)) return { status: 'NOFILL' };
  let cur = plan.stop, partial = false, rem = 1, hi = fill, mfe = 0, mae = 0, reason = null, exitIdx = -1; const parts = [];
  for (; j < bars.length; j++) {
    const b = bars[j], same = plan.entryType === 'stop' && j === fillIdx;
    mfe = Math.max(mfe, dir * ((dir === 1 ? b.h : b.l) - fill) / R); mae = Math.min(mae, dir * ((dir === 1 ? b.l : b.h) - fill) / R);
    if (dir === 1 ? b.l <= cur : b.h >= cur) { parts.push({ frac: rem, price: dir === 1 ? Math.min(b.o, cur) : Math.max(b.o, cur) }); rem = 0; reason = cur === plan.stop ? 'STOP' : 'TRAIL'; exitIdx = j; break; }
    if (!same) {
      if (!partial && (dir === 1 ? b.h >= plan.t1 : b.l <= plan.t1)) { parts.push({ frac: 0.5, price: dir === 1 ? Math.max(b.o, plan.t1) : Math.min(b.o, plan.t1) }); rem = 0.5; partial = true; cur = dir === 1 ? Math.max(cur, fill + 0.1 * R) : Math.min(cur, fill - 0.1 * R); }
      if (dir === 1 ? b.h >= plan.t2 : b.l <= plan.t2) { parts.push({ frac: rem, price: dir === 1 ? Math.max(b.o, plan.t2) : Math.min(b.o, plan.t2) }); rem = 0; reason = 'T2'; exitIdx = j; break; }
    }
    hi = dir === 1 ? Math.max(hi, b.h) : Math.min(hi, b.l);
    const rNow = dir * (b.c - fill) / R;
    if (rNow >= 1 && atrA[j]) { const be = fill + dir * 0.1 * R, ch = hi - dir * 3 * atrA[j]; const cand = dir === 1 ? Math.max(be, ch) : Math.min(be, ch); cur = dir === 1 ? Math.max(cur, cand) : Math.min(cur, cand); }
    if ((b.t - bars[fillIdx].t) / 86400 > 15 && rNow < 0.5) { parts.push({ frac: rem, price: b.c }); rem = 0; reason = 'TIME'; exitIdx = j; break; }
  }
  if (rem > 0) {
    if (!o.closeAtEnd) return { status: 'OPEN', fillIdx, fill, R, mfe, mae, curStop: cur, partial };
    const b = bars[bars.length - 1]; parts.push({ frac: rem, price: b.c }); reason = 'END'; exitIdx = bars.length - 1;
  }
  const cost = (o.costPips || 0) * pipSize(o.pair || 'EURUSD') / R;
  const r = parts.reduce((s, p) => s + p.frac * dir * (p.price - fill) / R, 0) - cost;
  const exit = parts.reduce((s, p) => s + p.frac * p.price, 0);
  return { status: 'CLOSED', fillIdx, fill, R, exitIdx, exit, r, reason, mfe, mae, parts, days: (bars[exitIdx].t - bars[fillIdx].t) / 86400 };
}

const PAIRS = { EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'], USDJPY: ['USD', 'JPY'], AUDUSD: ['AUD', 'USD'], USDCAD: ['USD', 'CAD'], USDCHF: ['USD', 'CHF'], NZDUSD: ['NZD', 'USD'] };
const W = 260;

function gaugeReader(vix, spx) {
  const sp = spx ? ema(spx.bars.map(b => b.c), 50) : null;
  const at = (g, t) => { let lo = 0, hi = g.bars.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (g.bars[m].t <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
  return t => {
    const g = {};
    if (vix) { const k = at(vix, t); if (k >= 5) g.VIX = { last: vix.bars[k].c, chg5: (vix.bars[k].c / vix.bars[k - 5].c - 1) * 100 }; }
    if (spx) { const k = at(spx, t); if (k >= 5) g.SPX = { above50: spx.bars[k].c > sp[k], chg5: (spx.bars[k].c / spx.bars[k - 5].c - 1) * 100 }; }
    return regimeOf(g);
  };
}

function precompute(sym, bars, regimeAt, macro, fundMode, startTs) {
  const [base, quote] = PAIRS[sym]; const atrA = wilder(trueRange(bars), 14); const evals = new Array(bars.length).fill(null);
  for (let i = W - 1; i < bars.length - 1; i++) {
    if (bars[i].t < startTs) continue;
    const p = Object.assign({ base, quote }, analyze(bars.slice(i - W + 1, i + 1)));
    const reg = regimeAt(bars[i].t); const e = evaluate(p, { macro, regime: reg, events: [], now: bars[i].t * 1000, fundMode });
    evals[i] = { total: e.total, veto: e.veto, setup: e.setup, dir: e.dir === 'LONG' ? 1 : -1, entryType: e.entryType, entry: e.entry, stop: e.stop, t1: e.t1, t2: e.t2, usdDir: e.usdDir, regime: reg.state };
  }
  return { sym, bars, atrA, evals };
}

function walk(pc, thr, costPips) {
  const out = []; let i = 0; const n = pc.bars.length;
  while (i < n - 1) {
    const e = pc.evals[i];
    if (e && e.total >= thr && !e.veto.length && e.setup !== 'NONE') {
      const s = simulateTrade(pc.bars, pc.atrA, i, { dir: e.dir, entryType: e.entryType, entry: e.entry, stop: e.stop, t1: e.t1, t2: e.t2 }, { closeAtEnd: true, costPips, pair: pc.sym });
      if (s.status === 'CLOSED') {
        out.push({ pair: pc.sym, direction: e.dir === 1 ? 'LONG' : 'SHORT', strategy: e.setup, score: e.total, regime: e.regime, usdDir: e.usdDir, entryTs: pc.bars[s.fillIdx].t, exitTs: pc.bars[s.exitIdx].t, entryDate: iso(pc.bars[s.fillIdx].t), exitDate: iso(pc.bars[s.exitIdx].t), entry: s.fill, exit: s.exit, r: s.r, reason: s.reason, mfe: s.mfe, mae: s.mae, days: s.days });
        i = Math.max(i + 1, s.exitIdx); continue;
      }
    }
    i++;
  }
  return out;
}

// Apply portfolio rules on top of each pair's stream: max concurrent trades, no more than two
// positions leaning the same way on the dollar, risk sized from equity at entry.
function portfolio(cands, o) {
  const events = []; const sorted = cands.map(c => Object.assign({}, c)).sort((a, b) => a.entryTs - b.entryTs || b.score - a.score);
  sorted.forEach((c, i) => { events.push({ ts: c.entryTs, k: 1, c, i }); events.push({ ts: c.exitTs, k: 0, c, i }); });
  events.sort((a, b) => a.ts - b.ts || a.k - b.k);
  let eq = o.startEquity; const open = []; const acc = []; const curve = [{ date: sorted.length ? sorted[0].entryDate : '', equity: eq, cumR: 0 }]; let cumR = 0;
  events.forEach(ev => {
    if (ev.k === 1) {
      const same = open.filter(x => x.c.usdDir === ev.c.usdDir).length;
      if (open.length >= o.maxConcurrent || same >= 2) return;
      ev.c.riskUsd = (o.compound ? eq : o.startEquity) * o.riskPct / 100; open.push(ev);
    } else {
      const idx = open.findIndex(x => x.c === ev.c); if (idx < 0) return; open.splice(idx, 1);
      ev.c.pnl = ev.c.r * ev.c.riskUsd; eq += ev.c.pnl; cumR += ev.c.r; acc.push(ev.c); curve.push({ date: ev.c.exitDate, equity: Math.round(eq * 100) / 100, cumR: Math.round(cumR * 100) / 100 });
    }
  });
  let peak = o.startEquity, dd = 0; curve.forEach(p => { peak = Math.max(peak, p.equity); dd = Math.max(dd, (peak - p.equity) / peak); });
  return { trades: acc, curve, endEquity: eq, maxDDPct: dd * 100 };
}

async function runBacktest(opts, candles) {
  opts = Object.fromEntries(Object.entries(opts || {}).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));
  const o = Object.assign({ pairs: Object.keys(PAIRS), years: 3, minScore: 70, riskPct: 1, minRR: 2, fundMode: 'static', costPips: 1, maxConcurrent: 4, startEquity: 10000, compound: true }, opts);
  o.pairs = o.pairs.filter(p => PAIRS[p]); if (!o.pairs.length) throw new Error('Pick at least one pair');
  const range = o.years <= 1 ? '2y' : (o.years <= 3 ? '5y' : '10y');
  const macro = JSON.parse(JSON.stringify(o.macro)); macro.settings.minRR = o.minRR;
  const [vix, spx, ...pairData] = await Promise.all([candles('^VIX', range).catch(() => null), candles('^GSPC', range).catch(() => null), ...o.pairs.map(p => candles(p + '=X', range))]);
  const regimeAt = gaugeReader(vix, spx); const lastT = pairData[0].bars[pairData[0].bars.length - 1].t; const startTs = lastT - o.years * 365.25 * 86400;
  const pcs = pairData.map((d, i) => precompute(o.pairs[i], d.bars, regimeAt, macro, o.fundMode, startTs));
  const run = thr => portfolio([].concat(...pcs.map(pc => walk(pc, thr, o.costPips))), o);
  const main = run(o.minScore);
  const st = stats(main.trades.map(t => ({ r: t.r, pnl: t.pnl })));
  const sens = [50, 60, 70, 80, 90].map(thr => { const p = run(thr); const s = stats(p.trades.map(t => ({ r: t.r, pnl: t.pnl }))); return { thr, n: s.n, winRate: s.winRate, expR: s.expR, pf: s.pf, ret: (p.endEquity / o.startEquity - 1) * 100, maxDD: p.maxDDPct }; });
  delete o.macro;
  return {
    opts: o, from: iso(startTs), to: iso(lastT), stats: st, ret: (main.endEquity / o.startEquity - 1) * 100, endEquity: main.endEquity, maxDDPct: main.maxDDPct, curve: main.curve,
    hist: histogram(main.trades.map(t => t.r)), mc: monteCarlo(main.trades.map(t => t.r), o.riskPct), sens,
    trades: main.trades.slice().sort((a, b) => b.exitTs - a.exitTs).slice(0, 400).map(t => ({ pair: t.pair, direction: t.direction, strategy: t.strategy, score: t.score, entryDate: t.entryDate, exitDate: t.exitDate, r: Math.round(t.r * 100) / 100, pnl: Math.round(t.pnl), reason: t.reason, regime: t.regime })),
    byPair: groupStats(main.trades, t => t.pair), byStrategy: groupStats(main.trades, t => t.strategy), byRegime: groupStats(main.trades, t => t.regime)
  };
}
module.exports = { simulateTrade, runBacktest, PAIRS, pipSize };
