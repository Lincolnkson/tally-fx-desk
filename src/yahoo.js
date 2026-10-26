'use strict';
// Daily candles from Yahoo's public chart endpoint (unofficial; cached for 20 minutes).
const cache = new Map(); const TTL = 20 * 60 * 1000;
function parse(j) {
  const r = j.chart.result[0]; const q = r.indicators.quote[0]; const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) if (q.close[i] != null && q.high[i] != null && q.low[i] != null && q.open[i] != null) bars.push({ t: r.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  return { bars, price: r.meta.regularMarketPrice };
}
async function candles(ticker, range = '1y') {
  const key = ticker + '|' + range; const hit = cache.get(key); if (hit && Date.now() - hit.at < TTL) return hit.v;
  let err;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?interval=1d&range=' + range, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tally-fx-desk)' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('Price feed returned ' + res.status + ' for ' + ticker); const v = parse(await res.json()); cache.set(key, { at: Date.now(), v }); return v;
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 800 * (a + 1))); }
  }
  throw err;
}
module.exports = { candles, parse };
