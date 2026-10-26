'use strict';
const WIN = 0.05; // |R| below this counts as breakeven

function stats(items) {
  const n = items.length; const rs = items.map(i => i.r);
  const wins = rs.filter(r => r > WIN), losses = rs.filter(r => r < -WIN);
  const sum = a => a.reduce((s, x) => s + x, 0);
  const sumR = sum(rs); const gw = sum(wins), gl = Math.abs(sum(losses));
  let cum = 0, peak = 0, maxDD = 0, ws = 0, ls = 0, mws = 0, mls = 0;
  rs.forEach(r => { cum += r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); if (r > WIN) { ws++; ls = 0; } else if (r < -WIN) { ls++; ws = 0; } else { ws = 0; ls = 0; } mws = Math.max(mws, ws); mls = Math.max(mls, ls); });
  const cur = ls > 0 ? { type: 'L', len: ls } : (ws > 0 ? { type: 'W', len: ws } : { type: '-', len: 0 });
  return {
    n, wins: wins.length, losses: losses.length, be: n - wins.length - losses.length,
    winRate: n ? wins.length / n : 0, avgWinR: wins.length ? gw / wins.length : 0, avgLossR: losses.length ? -gl / losses.length : 0,
    expR: n ? sumR / n : 0, sumR, pf: gl > 0 ? gw / gl : (gw > 0 ? 99 : 0), payoff: (wins.length && losses.length) ? (gw / wins.length) / (gl / losses.length) : 0,
    maxDDR: maxDD, bestR: n ? Math.max(...rs) : 0, worstR: n ? Math.min(...rs) : 0, maxWinStreak: mws, maxLossStreak: mls, streak: cur,
    pnl: sum(items.map(i => i.pnl || 0))
  };
}
function groupStats(items, keyFn, minN = 1) {
  const m = {}; items.forEach(i => { const k = keyFn(i); if (k == null) return; (m[k] = m[k] || []).push(i); });
  return Object.keys(m).map(k => { const s = stats(m[k]); return { key: k, n: s.n, winRate: s.winRate, expR: s.expR, sumR: s.sumR, pnl: s.pnl, pf: s.pf }; }).filter(r => r.n >= minN).sort((a, b) => b.n - a.n);
}
function histogram(rs, bin = 0.5, lo = -3, hi = 4) {
  const nb = Math.round((hi - lo) / bin); const out = Array.from({ length: nb }, (_, i) => ({ from: lo + i * bin, to: lo + (i + 1) * bin, n: 0 }));
  rs.forEach(r => { const k = Math.min(nb - 1, Math.max(0, Math.floor((r - lo) / bin))); out[k].n++; });
  return out;
}
function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function pct(sorted, p) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]; }
// Bootstrap the trade sequence: how bad can the ride get with the same edge but a different order?
function monteCarlo(rs, riskPct, o = {}) {
  if (rs.length < 8) return null;
  const N = o.sims || 400, steps = rs.length, rnd = lcg(o.seed || 7), risk = riskPct / 100, cp = Math.min(24, steps);
  const finals = [], dds = [], marks = Array.from({ length: cp + 1 }, () => []); let lossN = 0, dd20 = 0;
  for (let s = 0; s < N; s++) {
    let eq = 1, peak = 1, dd = 0, next = 1; marks[0].push(1);
    for (let t = 1; t <= steps; t++) {
      const r = rs[Math.floor(rnd() * rs.length)]; eq *= Math.max(0.01, 1 + r * risk); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
      while (next <= cp && t >= Math.round(next * steps / cp)) { marks[next].push(eq); next++; }
    }
    finals.push(eq); dds.push(dd); if (eq < 1) lossN++; if (dd >= 0.2) dd20++;
  }
  const fs = finals.slice().sort((a, b) => a - b), ds = dds.slice().sort((a, b) => a - b);
  const bands = marks.map(m => { const q = m.slice().sort((a, b) => a - b); return { p5: pct(q, .05), p25: pct(q, .25), p50: pct(q, .5), p75: pct(q, .75), p95: pct(q, .95) }; });
  return { sims: N, steps, bands, final: { p5: pct(fs, .05), p50: pct(fs, .5), p95: pct(fs, .95) }, dd: { p50: pct(ds, .5), p95: pct(ds, .95) }, probLoss: lossN / N, probDD20: dd20 / N };
}
module.exports = { stats, groupStats, histogram, monteCarlo, WIN };
