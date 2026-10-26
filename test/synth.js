'use strict';
// Deterministic synthetic daily candles so tests run offline.
function walk(n, seed, drift, vol, start, endTs) {
  let s = seed; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const bars = []; let p = start; const t0 = (endTs || Math.floor(Date.now() / 1000)) - n * 86400;
  for (let i = 0; i < n; i++) { const wave = Math.sin(i / 55 + seed) * vol * 0.35; const op = p; p = p * (1 + drift + wave * 0.5 + vol * rnd() * 2); const h = Math.max(op, p) * (1 + Math.abs(vol * rnd() * 0.6)), l = Math.min(op, p) * (1 - Math.abs(vol * rnd() * 0.6)); bars.push({ t: t0 + i * 86400, o: op, h, l, c: p }); }
  return { bars, price: bars[n - 1].c };
}
const spec = { 'EURUSD=X': [3, 0.0001, 0.0045, 1.08], 'GBPUSD=X': [5, 0.0001, 0.005, 1.27], 'USDJPY=X': [9, 0.0003, 0.005, 148], 'AUDUSD=X': [21, 0, 0.005, 0.66], 'USDCAD=X': [12, 0, 0.004, 1.36], 'USDCHF=X': [17, -0.0001, 0.004, 0.88], 'NZDUSD=X': [33, 0, 0.005, 0.6], '^VIX': [4, 0, 0.03, 17], '^GSPC': [6, 0.0004, 0.007, 5200] };
async function fakeCandles(ticker, range) { const n = range === '10y' ? 2600 : range === '5y' ? 1300 : range === '6mo' ? 130 : 520; const s = spec[ticker]; if (!s) throw new Error('no synth for ' + ticker); return walk(n, s[0], s[1], s[2], s[3]); }
module.exports = { walk, fakeCandles };
