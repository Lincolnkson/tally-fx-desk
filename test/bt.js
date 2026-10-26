'use strict';
const assert = require('assert');
const { runBacktest } = require('../src/sim'); const { fakeCandles } = require('./synth');
const macro = { settings: { minScore: 70, minRR: 2, eventBlockHours: 24 }, rates: { USD: 3.75, EUR: 2, GBP: 3.75, JPY: 0.75, AUD: 4.1, CAD: 2.25, CHF: 0, NZD: 2.25 }, stance: { USD: 0, EUR: 0, GBP: 0, JPY: 1, AUD: 1, CAD: 0, CHF: 0, NZD: 0 }, cb: [], riskCcy: { AUD: 1, NZD: 1, CAD: 1, EUR: .5, GBP: .5, USD: -1, JPY: -1, CHF: -1 } };
(async () => {
  const t = Date.now(); const r = await runBacktest({ macro, years: 3, minScore: 60 }, fakeCandles);
  console.log('backtest ms', Date.now() - t, 'trades', r.stats.n, 'win', r.stats.winRate.toFixed(2), 'expR', r.stats.expR.toFixed(2), 'ret%', r.ret.toFixed(1), 'dd%', r.maxDDPct.toFixed(1));
  assert.ok(r.stats.n > 10); assert.equal(r.sens.length, 5); assert.ok(r.mc && r.mc.bands.length > 2);
  const off = await runBacktest({ macro, years: 3, minScore: 55, fundMode: 'off' }, fakeCandles); assert.ok(off.stats.n > 0);
  console.log('BACKTEST OK');
})().catch(e => { console.error(e); process.exit(1); });
