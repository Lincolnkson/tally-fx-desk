'use strict';
// Strategy Lab: engine invariants on synthetic data, then the approval flow through the real HTTP API with a fake runner.
process.env.DB_FILE = ':memory:'; process.env.APP_PASSWORD = 'pw'; process.env.SESSION_SECRET = 's3'; process.env.INGEST_API_KEY = 'k'; process.env.TALLY_FAKE_PRICES = '1';
const assert = require('assert'); const D = require('../src/lab/data'), Fx = require('../src/lab/features'), R = require('../src/lab/recipe'), S = require('../src/lab/search'), L = require('../src/lab/index');
const { walk } = require('./synth');
const END = D.dayOfIso('2026-11-13');
// A pure random walk: by construction no rule can have an edge on it.
function rw(n, seed, vol, start, endTs) { let s = seed; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; const g = () => (rnd() + rnd() + rnd() + rnd()) * 1.73; const bars = []; let p = start; const t0 = endTs - n * 86400; for (let i = 0; i < n; i++) { const op = p; p = p * Math.exp(vol * g()); const h = Math.max(op, p) * (1 + Math.abs(vol * g() * 0.5)), l = Math.min(op, p) * (1 - Math.abs(vol * g() * 0.5)); bars.push({ t: t0 + i * 86400, o: op, h, l, c: p }); } return { bars }; }
function series(seed, start, vol, n = 5200) { const w = (process.env.LAB_TREND ? walk(Math.round(n * 1.45), seed, 0.00002, vol, start, END * 86400) : rw(Math.round(n * 1.45), seed, vol * 1.6, start, END * 86400)).bars; const rows = []; w.forEach(b => { const d = Math.floor(b.t / 86400); if (D.dow(d) !== 0 && D.dow(d) !== 6) rows.push({ d, o: b.o, h: b.h, l: b.l, c: b.c }); }); return D.clean(rows, true); }
function fakeRaw() {
  const pairs = {}; Object.keys(D.UNIVERSE).filter(D.isFx).forEach((s, i) => { pairs[s] = series(11 + i * 7, s.indexOf('JPY') >= 0 ? 120 : 1.1, 0.0035); });
  const fred = {}; D.FRED_IDS.forEach((id, k) => { const a = []; for (let y = 2006; y <= 2026; y++) for (let m = 1; m <= 12; m++) a.push({ ym: y + '-' + String(m).padStart(2, '0'), v: 2 + Math.sin((y * 12 + m) / 17 + k) * 1.5 + (k % 5) * 0.3 }); fred[id] = a; });
  return { pairs, gauges: { VIX: series(4, 17, 0.02), SPX: series(6, 3000, 0.006) }, fred };
}
(async () => {
  const raw = fakeRaw(); const X = Fx.build(raw); assert.equal(X.syms.length, 17);
  // 1. no look-ahead: features at bar i are identical when the future is cut off
  { const F = X.P.EURUSD, cut = F.n - 400; const raw2 = JSON.parse(JSON.stringify({ fred: raw.fred })); raw2.pairs = {}; raw2.gauges = {}; const trim = (B, day) => { let n = 0; while (n < B.n && B.d[n] <= day) n++; return { d: B.d.slice(0, n), o: B.o.slice(0, n), h: B.h.slice(0, n), l: B.l.slice(0, n), c: B.c.slice(0, n), n }; };
    Object.keys(raw.pairs).forEach(s => { raw2.pairs[s] = trim(raw.pairs[s], F.d[cut]); }); Object.keys(raw.gauges).forEach(s => { raw2.gauges[s] = trim(raw.gauges[s], F.d[cut]); });
    const F2 = Fx.build(raw2).P.EURUSD; ['atr', 'e200', 'rsi2', 'adx', 'z20', 'carry', 'carryChg', 'str60', 'ret250', 'hh20'].forEach(k => { for (const i of [cut, cut - 1, cut - 57]) assert.ok(Math.abs(F[k][i] - F2[k][i]) < 1e-9 || (isNaN(F[k][i]) && isNaN(F2[k][i])), 'look-ahead in ' + k); }); assert.equal(F.macro[cut], F2.macro[cut]); assert.equal(F.risk[cut], F2.risk[cut]); }
  // 2. rates are used two months late
  { const rt = D.buildRates({ IR3TIB01USM156N: [{ ym: '2020-01', v: 1 }, { ym: '2020-02', v: 2 }, { ym: '2020-03', v: 3 }, { ym: '2020-04', v: 4 }, { ym: '2020-05', v: 5 }, { ym: '2020-06', v: 6 }, { ym: '2020-07', v: 7 }, { ym: '2020-08', v: 8 }, { ym: '2020-09', v: 9 }, { ym: '2020-10', v: 10 }] }); assert.equal(rt.at('USD', D.dayOfIso('2020-10-20')).r3, 8, 'October must see August'); }
  // 3. the simulator: stop before target, costs always charged, entry at next open
  { const g = R.canon({ universe: 'majors', side: 'both', setup: 'breakout', brkN: 20, trigger: 'none', trend: 'none', macro: 'none', fund: 'none', strength: 'none', risk: 'none', adx: 'none', vol: 'none', stop: 2, t1: 1, frac: 0.5, t2: 2, be: 1, trail: 3, days: 15, ind: 'none', rsiLen: 2, rsiLt: 10, emaLen: 20, look: 3, fadeZ: 2, fadeRsi: 0, crossLen: 20, runN: 3 });
    const bt = R.backtest(X, g); assert.ok(bt.trades.length > 100, 'breakouts trade'); bt.trades.forEach(t => { assert.ok(t.r < t.gross + 0.3, 'spread is charged; only overnight interest can add a little'); assert.ok(t.r > -3 && t.r < 6, 'sane R'); assert.ok(t.exitDay >= t.entryDay); const F = X.P[t.sym]; assert.equal(t.entry, F.o[t.i + 1]); });
    const per = {}; bt.trades.forEach(t => { (per[t.sym] = per[t.sym] || []).push(t); }); Object.values(per).forEach(a => a.sort((x, y) => x.entryDay - y.entryDay).forEach((t, i) => { if (i) assert.ok(t.entryDay >= a[i - 1].exitDay, 'one position per pair'); }));
    assert.equal(R.keyOf(R.canon(R.mutate(g, R.lcg(3)))).split('|').length, Object.keys(R.GENES).length); assert.ok(R.describe(g).entry.includes('20-day high'));
    // live signal for a bar equals the backtest's decision for that bar
    const out = L.liveSignals(raw, { recipe: g, label: 'T [Lab #1]', winRate: 0.55 }, { equity: 10000, riskPct: 1, open: [] }); assert.equal(out.items.length, 7);
    out.items.forEach(it => { const F = X.P[it.pair]; const s = R.signalAt(F, F.n - 1, g); if (it.decision === 'ENTER') { assert.equal(it.direction, s > 0 ? 'LONG' : 'SHORT'); assert.ok(it.units >= 1000 && it.plan.days === 15 && it.target2); const risk = Math.abs(it.entry - it.stop) * it.units * it.qUsd; assert.ok(risk > 50 && risk < 150, 'sized to about 1% risk, got ' + risk); } else if (it.decision === 'WAIT') assert.equal(s, 0); });
    const sh = L.shadow(Array.from({ length: X.P.EURUSD.n }, (_, i) => ({ t: X.P.EURUSD.d[i] * 86400 - 3600, o: X.P.EURUSD.o[i], h: X.P.EURUSD.h[i], l: X.P.EURUSD.l[i], c: X.P.EURUSD.c[i] })), X.P.EURUSD.d[X.P.EURUSD.n - 60], 'EURUSD', 1, L.planOf(g)); assert.equal(sh.status, 'CLOSED'); }
  // 4. random data must not produce an approved strategy: the gauntlet has to say no
  const t0 = Date.now(); const res = await L.runPipeline(raw, { size: 'quick' }); console.log('pipeline ms', Date.now() - t0, 'tried', res.tried, 'pick', res.pick ? res.pick.name + ' passed=' + res.pick.passed : 'none', 'unseen', res.reality.unseen.expR);
  assert.ok(res.baseline && res.baseline.all && res.baseline.all.n > 20, 'baseline measured'); assert.ok(res.reality.folds.length >= 5);
  if (process.env.LAB_TREND) { console.log(JSON.stringify(res.pick && res.pick.checks.map(c => [c.id, c.pass, c.detail]), null, 0)); process.exit(0); }
  assert.ok(!res.pick || !res.pick.passed, 'a random walk has no edge, so nothing may pass'); if (res.pick) { assert.ok(res.pick.checks.length >= 11); assert.ok(res.pick.design.n > 0); }
  assert.equal(S.gauntlet(X, S.report(X, res.pick ? res.pick.recipe : R.randomRecipe(R.lcg(1)), { start: L.START, holdout: END - 730, end: END }), { start: L.START, end: END }).passed, false);

  // ---------- approval flow over HTTP ----------
  const mk = passed => ({ asOf: '2026-11-13', window: { start: '2008-01-10', holdout: '2024-11-13', end: '2026-11-13' }, tried: 10, rules: S.RULES, data: { pairs: 17, missing: [] }, baseline: res.baseline, reality: res.reality, runnersUp: [], history: [],
    pick: Object.assign({}, res.pick || {}, { key: 'k' + passed, name: 'Test recipe', recipe: R.canon(R.randomRecipe(R.lcg(5))), describe: R.describe(R.canon(R.randomRecipe(R.lcg(5)))), passed, failed: passed ? [] : ['holdout'], checks: [{ id: 'holdout', label: 'Held up', pass: passed, detail: 'x' }], all: res.baseline.all, design: res.baseline.design, holdout: res.baseline.holdout, sameAsActive: false }), activeHealth: null });
  let next = mk(false), sigCalls = 0;
  global.__labRunner = async d => { if (d.job === 'signals') { sigCalls++; return { asOf: '2026-11-13', rates: 24, warnings: [], items: [{ pair: 'EURGBP', ticker: 'EURGBP=X', decision: 'ENTER', direction: 'LONG', score: 55, strategy: d.strategy.label, entry: 0.85, stop: 0.84, target1: 0.86, target2: null, units: 8000, riskUsd: 100, qUsd: 1.25, plan: { stopAtr: 2, t1R: 1, frac: 1, days: 10, ind: 'none' }, vetoes: [], reasons: ['r'] }, { pair: 'EURUSD', decision: 'WAIT', score: 0, vetoes: [] }] }; } await new Promise(r => setTimeout(r, 60)); if (d.opts.active) next.activeHealth = { state: 'failing', why: 'It lost.', all: res.baseline.all, last12: res.baseline.last12, last6: res.baseline.last12, since: null, curve: [] }; return next; };
  const { app, resolveShadows } = require('../src/server'); const { db, pnlUsd } = require('../src/db'); const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port; let ck = '';
  const call = async (m, p, body, hdr) => { const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json', cookie: ck }, hdr || {}), body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0]; return { s: r.status, j }; };
  const K = { 'x-api-key': 'k' }; const wait = async () => { for (let i = 0; i < 50; i++) { if (!(await call('GET', '/api/strategy-lab')).j.running) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('run did not finish'); };
  assert.equal((await call('GET', '/api/strategy-lab')).s, 401); assert.equal((await call('POST', '/api/ingest/lab/run', {})).s, 401); await call('POST', '/api/login', { password: 'pw' });
  assert.deepEqual((await call('GET', '/api/ingest/lab/signals', null, K)).j, { mode: 'legacy', pauseLegacy: false, items: [] });
  assert.ok((await call('POST', '/api/ingest/lab/run', {}, K)).j.started); await wait();
  let v = (await call('GET', '/api/strategy-lab')).j; assert.equal(v.candidate.status, 'failed'); assert.equal(v.last.status, 'failed'); assert.equal(v.active, null);
  assert.equal((await call('POST', '/api/strategy-lab/strategies/' + v.candidate.id + '/approve', { mode: 'live' })).s, 400, 'a failed strategy can never go live');
  assert.equal((await call('GET', '/api/ingest/lab/signals', null, K)).j.mode, 'legacy', 'nothing reaches the advisor without approval');
  assert.equal((await call('POST', '/api/strategy-lab/strategies/' + v.candidate.id + '/approve', { mode: 'trial' })).s, 200);
  let sg = (await call('GET', '/api/ingest/lab/signals', null, K)).j; assert.equal(sg.mode, 'trial'); assert.ok(sg.items[0].paper && /PAPER TRIAL/.test(sg.items[0].strategy) && /^LAB\d+-EURGBP-2026-11-13$/.test(sg.items[0].signalId));
  next = mk(true); assert.ok((await call('POST', '/api/strategy-lab/run', {})).j.started); assert.equal((await call('POST', '/api/strategy-lab/run', {})).s, 400, 'one run at a time'); await wait();
  v = (await call('GET', '/api/strategy-lab')).j; assert.equal(v.candidate.status, 'proposed'); assert.equal(v.active.status, 'trial'); assert.equal(v.active.health.state, 'failing', 'the strategy in use is re-tested on every run');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE title LIKE '%waiting for your approval%'").get() && db.prepare("SELECT 1 FROM events WHERE title LIKE '%stopped working%'").get());
  assert.equal((await call('POST', '/api/strategy-lab/strategies/' + v.candidate.id + '/approve', { mode: 'live' })).s, 200);
  v = (await call('GET', '/api/strategy-lab')).j; assert.equal(v.active.status, 'live'); assert.equal(v.candidate, null); assert.equal(v.past.length, 1);
  sg = (await call('GET', '/api/ingest/lab/signals', null, K)).j; assert.equal(sg.mode, 'live'); assert.equal(sg.items[0].paper, false); const n0 = sigCalls; await call('GET', '/api/ingest/lab/signals', null, K); assert.equal(sigCalls, n0, 'signals are cached between advisor retries');
  // a lab signal on a cross keeps its exit plan and converts profit to dollars
  const it = sg.items[0]; const a = await call('POST', '/api/ingest/signal', { signalId: it.signalId, signalDate: new Date().toISOString(), pair: it.pair, ticker: it.ticker, direction: it.direction, strategy: it.strategy, score: it.score, entry: it.entry, stop: it.stop, target1: it.target1, target2: it.target2, units: it.units, riskUsd: it.riskUsd, plan: it.plan, qUsd: it.qUsd, vetoes: [] }, K); assert.ok(a.j.id);
  const tk = await call('POST', '/api/signals/' + a.j.id + '/take', { fillPrice: 0.85, units: 8000 }); assert.ok(tk.j.tradeId);
  const ot = (await call('GET', '/api/ingest/open-trades', null, K)).j; assert.equal(ot[0].plan.frac, 1); assert.equal(ot[0].target2, null);
  await call('POST', '/api/trades/' + tk.j.tradeId + '/close', { price: 0.86 }); const tr = (await call('GET', '/api/trades/' + tk.j.tradeId)).j; assert.ok(Math.abs(tr.pnl_usd - 100) < 0.01, 'EURGBP profit in dollars, got ' + tr.pnl_usd); assert.ok(Math.abs(tr.r - 1) < 1e-6);
  assert.equal(pnlUsd('USDJPY', 'LONG', 150, 151, 1000), 1000 / 151); assert.equal(pnlUsd('EURUSD', 'SHORT', 1.1, 1.09, 1000), 10.000000000000009);
  assert.equal((await call('PUT', '/api/strategy-lab/settings', { pauseLegacy: true })).s, 200); assert.equal((await call('GET', '/api/ingest/lab/status', null, K)).j.pauseLegacy, true);
  assert.equal((await call('POST', '/api/strategy-lab/strategies/' + v.active.id + '/retire', {})).s, 200); assert.equal((await call('GET', '/api/ingest/lab/signals', null, K)).j.mode, 'legacy');
  await resolveShadows(); srv.close(); console.log('LAB OK (engine invariants, random data rejected, approval flow, cross-pair P&L)'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
