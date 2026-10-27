'use strict';
// Day trading desk: rule gates, journal maths, circuit breakers and the n8n contract.
process.env.DB_FILE = ':memory:'; process.env.APP_PASSWORD = 'pw'; process.env.SESSION_SECRET = 's3'; process.env.INGEST_API_KEY = 'k'; process.env.TALLY_FAKE_PRICES = '1';
const { app } = require('../src/server'); const { db } = require('../src/db'); const DT = require('../src/daytrade'); const assert = require('assert');
const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port; let ck = '';
const call = async (m, p, body, hdr) => { const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json', cookie: ck }, hdr || {}), body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0]; return { s: r.status, j }; };
const K = { 'x-api-key': 'k' };
const soon = m => new Date(Date.now() + m * 60000).toISOString();
// The rulebook's O1 example (EUR/USD ORB long at the London open).
const O1 = (o = {}) => Object.assign({
  schema_version: '1.0', rulebook_version: 'dt-rules-1.0', decision: 'SIGNAL', signal_id: 'DT-T-EURUSD-S2-001', created_at: new Date().toISOString(), instrument: 'EURUSD', asset_class: 'fx', strategy_id: 'S2', strategy_name: 'Opening-range breakout', direction: 'long', session: 'LONDON_OPEN', regime: { label: 'TREND', confidence: 0.72 }, score: 78, grade: 'A',
  entry: { type: 'limit', price: 1.08452, valid_until: soon(30) }, stop: 1.08331, targets: [{ id: 'T1', price: 1.08573, r: 1, close_pct: 33 }, { id: 'T2', price: 1.08694, r: 2, close_pct: 33 }, { id: 'RUNNER', trail: 'vwap_close', close_pct: 34 }],
  risk: { effective_risk_pct: 0.375, risk_amount: 375, currency: 'ZAR', position_size: 0.16, size_unit: 'lots', stop_distance: 12.1, distance_unit: 'pips', cost_r: 0.04, rr_primary: 2 },
  management: { breakeven: 'M3', trail: 'vwap_close', time_stop_bars: 6, flat_by: soon(600) }, invalidation: ['5m close back inside opening range'], rules_passed: ['H1-H16', 'S2.trigger'], volume_source: 'tick', status: 'ARMED', narrative: 'Opening range broke higher on strong volume above a rising VWAP.'
}, o);
(async () => {
  assert.equal((await call('POST', '/api/login', { password: 'pw' })).s, 200);
  assert.equal((await call('GET', '/api/ingest/dt/context')).s, 401, 'ingest needs key');
  assert.equal((await call('GET', '/api/ingest/dt/context', null, { 'x-advisor-key': 'k' })).s, 200, 'x-advisor-key alias works');
  let ctx = (await call('GET', '/api/ingest/dt/context', null, K)).j; assert.equal(ctx.advisor_state, 'OBSERVE_ONLY', 'no readiness check yet'); assert.equal(ctx.strategies.S2, 'RESEARCH');

  // H1: incomplete payload is refused outright
  const bad = await call('POST', '/api/ingest/dt/signals', O1({ stop: undefined, signal_id: 'x1' }), K); assert.equal(bad.s, 400); assert.equal(bad.j.code, 'INCOMPLETE_SIGNAL');
  // H16: a RESEARCH strategy only logs shadow signals
  let r = await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'sh-1' }), K); assert.equal(r.j.gate, 'SHADOW'); assert.ok(r.j.reasons.includes('STRATEGY_NOT_LIVE'));
  assert.ok((await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'sh-1' }), K)).j.duplicate, 'dedupe');
  // promote S2 to Paper; still observe-only until readiness is done
  assert.equal((await call('PUT', '/api/dt/stages/S2', { stage: 'PAPER' })).s, 200);
  r = await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'ob-1' }), K); assert.equal(r.j.gate, 'OBSERVE');
  // a "no" readiness answer keeps observe-only; all yes enables alerts
  await call('POST', '/api/dt/readiness', { calendar: true, notRecovering: false, atScreen: true }); assert.equal((await call('GET', '/api/dt/state')).j.state, 'OBSERVE_ONLY');
  await call('POST', '/api/dt/readiness', { calendar: true, notRecovering: true, atScreen: true }); assert.equal((await call('GET', '/api/dt/state')).j.state, 'ACTIVE');
  // H2 wrong-side stop, H7 reward to risk, H3 risk above the Paper stage (0.5%), H6 cost
  assert.equal((await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'b-stop', stop: 1.0860 }), K)).j.gate, 'BLOCKED');
  r = await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'b-rr', instrument: 'US500', targets: [{ id: 'T1', price: 1.08573, r: 1, close_pct: 100 }] }), K); assert.ok(r.j.reasons.includes('RR_TOO_LOW'), JSON.stringify(r.j));
  r = await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'b-risk', instrument: 'US500', risk: { ...O1().risk, effective_risk_pct: 0.75 } }), K); assert.ok(r.j.reasons.includes('RISK_CAP'));
  r = await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'b-cost', instrument: 'US500', risk: { ...O1().risk, cost_r: 0.2 } }), K); assert.ok(r.j.reasons.includes('COST_TOO_HIGH'));
  r = await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'b-exp', instrument: 'US500', entry: { type: 'stop', price: 1.08452, valid_until: soon(-5) } }), K); assert.equal(r.j.gate, 'BLOCKED'); assert.ok(r.j.reasons.includes('EXPIRED_ON_ARRIVAL'));
  // grades: C is shadow, B is log-only
  assert.equal((await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'g-c', instrument: 'GER40', grade: 'C' }), K)).j.gate, 'SHADOW');
  assert.equal((await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'g-b', instrument: 'GER40', grade: 'B' }), K)).j.gate, 'LOGGED');
  // the real thing
  const ok = await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'live-1' }), K); assert.equal(ok.j.gate, 'ALERT', JSON.stringify(ok.j)); assert.equal(ok.j.alerted, true);
  // H10: second signal on the same instrument or the same correlation group is blocked while the first is armed/open
  assert.ok((await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'dup-inst' }), K)).j.reasons.includes('EXPOSURE_CAP'));
  const act = (await call('GET', '/api/ingest/dt/active', null, K)).j; assert.ok(act.find(x => x.signal_id === 'live-1' && x.created_at && x.entry_type === 'limit' && x.cost_r === 0.04), 'active has replay fields');
  const c2 = (await call('GET', '/api/ingest/dt/context', null, K)).j; assert.ok(c2.today_signals.length >= 5 && Array.isArray(c2.blackouts), 'context has today_signals and blackouts');
  let board = (await call('GET', '/api/dt/signals?view=board')).j; assert.equal(board.length, 1); assert.equal(board[0].rr, 2);
  assert.equal((await call('GET', '/api/state')).j.day.armed, 1);
  // take it, partial at T1, close the rest at T2
  const id = ok.j.id; assert.equal((await call('POST', '/api/dt/signals/' + id + '/take', { fillPrice: 1.0830, size: 0.16 })).s, 400, 'fill through the stop');
  assert.equal((await call('POST', '/api/dt/signals/' + id + '/take', { fillPrice: 1.08452, size: 0.16 })).s, 200);
  assert.ok((await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'grp', instrument: 'GBPUSD' }), K)).j.reasons.includes('EXPOSURE_CAP'), 'USD block correlation');
  // O3: stops only tighten (H2)
  let u = await call('PATCH', '/api/ingest/dt/signals/live-1', { status: 'ACTIVE', action: 'HOLD', new_stop: 1.0832, r_open: 0.4, mfe_r: 0.6, mae_r: -0.3 }, K); assert.equal(u.j.cur_stop, 1.08331); assert.equal(u.j.stop_ignored, true);
  u = await call('PATCH', '/api/ingest/dt/signals/live-1', { status: 'PARTIAL', action: 'MOVE_STOP', new_stop: 1.0846, rule: 'M3', r_open: 1, mfe_r: 1.1 }, K); assert.equal(u.j.cur_stop, 1.0846);
  await call('POST', '/api/dt/signals/' + id + '/partial', { price: 1.08573, fraction: 0.5 });
  const cl = await call('POST', '/api/dt/signals/' + id + '/close', { price: 1.08694, reason: 'TARGET', followed: true, errors: [] }); assert.equal(cl.s, 200);
  assert.ok(Math.abs(cl.j.r - 1.5) < 0.01, 'r=' + cl.j.r); assert.ok(Math.abs(cl.j.pnl - 562.5) < 1, 'zar=' + cl.j.pnl);
  await call('PATCH', '/api/ingest/dt/signals/live-1', { status: 'CLOSED', action: 'EXIT_TARGET', result_r: 1.6, exit_reason: 'T2', mfe_r: 2.1 }, K);
  const sig = (await call('GET', '/api/dt/signals/' + id)).j; assert.equal(sig.plan_r, 1.6); assert.equal(sig.fills.length, 3); assert.ok(sig.updates.length >= 3);
  // shadow outcomes count for the advisor, not for you
  await call('PATCH', '/api/ingest/dt/signals/sh-1', { status: 'CLOSED', result_r: -1, exit_reason: 'STOP' }, K);
  let st = (await call('GET', '/api/dt/stats')).j; assert.equal(st.you.n, 1); assert.equal(st.advisor.n, 2); assert.ok(Math.abs(st.executionGapR - (1.5 - 1.6)) < 0.01); assert.equal(st.adherence, 1);
  // decisions, advisor state, calendar blackouts
  assert.equal((await call('POST', '/api/ingest/dt/decisions', { decisions: [{ decision: 'NO_TRADE', instrument: 'GBPUSD', evaluated_at: new Date().toISOString(), regime: { label: 'EVENT' }, reason_codes: ['NEWS_BLACKOUT'], candidates_rejected: [{ strategy_id: 'S1', rule: 'T6' }] }] }, K)).j.stored, 1);
  const dec = (await call('GET', '/api/dt/decisions')).j; assert.equal(dec.counts.NEWS_BLACKOUT, 1);
  await call('POST', '/api/ingest/dt/calendar', { events: [{ at: soon(10), ccy: 'USD', impact: 'high', title: 'CPI' }] }, K);
  const ds = (await call('GET', '/api/dt/state')).j; assert.equal(ds.blackouts.length, 1); assert.equal(ds.blackouts[0].active, true); assert.ok(ds.sessions.windows.length >= 8);
  assert.equal((await call('POST', '/api/ingest/dt/advisor-state', { state: 'PAUSED', reason: 'feed down', until: soon(30) }, K)).j.effective, 'PAUSED');
  assert.ok((await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'p-1', instrument: 'USDJPY' }), K)).j.reasons.includes('PAUSED'));
  await call('POST', '/api/ingest/dt/advisor-state', { state: 'ACTIVE' }, K);
  // circuit breakers: three losses today → cooldown; a 2.5R day → locked, and the lock must be acknowledged next session
  const lose = async (n, inst) => { for (let i = 0; i < n; i++) { const x = await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'L' + inst + i, instrument: inst, grade: 'A+' }), K); assert.equal(x.j.gate, 'ALERT', JSON.stringify(x.j)); await call('POST', '/api/dt/signals/' + x.j.id + '/take', { fillPrice: 1.08452, size: 0.16 }); await call('POST', '/api/dt/signals/' + x.j.id + '/close', { price: 1.08331, reason: 'STOP', followed: true }); } };
  await lose(1, 'US500'); await lose(1, 'GER40'); await lose(1, 'USDJPY');
  let A = (await call('GET', '/api/dt/state')).j; assert.equal(A.state, 'COOLDOWN', JSON.stringify(A.reasons)); assert.equal(A.breakers.lossStreak, 3);
  const cd = (await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'cd-1', instrument: 'NAS100', grade: 'A+' }), K)).j; assert.ok(cd.reasons.includes('COOLDOWN'), JSON.stringify(cd));
  // skip the cooldown clock: pretend the last loss was 2 hours ago, then a 4th loss locks the day (C2)
  const ago = m => new Date(Date.now() - m * 60000).toISOString();
  db.prepare("UPDATE dt_signals SET closed_at=? WHERE closed_at IS NOT NULL AND r > 0").run(ago(70));
  db.prepare("SELECT id FROM dt_signals WHERE closed_at IS NOT NULL AND r < 0 ORDER BY id").all().forEach((x, i) => db.prepare('UPDATE dt_signals SET closed_at=? WHERE id=?').run(ago(66 - i), x.id));
  A = (await call('GET', '/api/dt/state')).j; assert.equal(A.state, 'ACTIVE'); assert.equal(A.aPlusOnly, true);
  assert.ok((await call('POST', '/api/ingest/dt/signals', O1({ signal_id: 'ap-1', instrument: 'NAS100', grade: 'A' }), K)).j.reasons.includes('COOLDOWN'), 'A+ only after cooldown');
  await lose(1, 'NAS100'); A = (await call('GET', '/api/dt/state')).j; assert.equal(A.state, 'LOCKED');
  ctx = (await call('GET', '/api/ingest/dt/context', null, K)).j; assert.equal(ctx.alerts_enabled, false); assert.equal(ctx.breakers.trades_today, 5);
  // move the lock to yesterday: next session needs an acknowledgement (C11)
  const yday = DT.dayKey(Date.now() - 86400000); db.prepare("UPDATE dt_state SET day=? WHERE source='tally'").run(yday); db.prepare('UPDATE dt_signals SET closed_at=?, taken_at=? WHERE closed_at IS NOT NULL').run(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString());
  A = (await call('GET', '/api/dt/state')).j; assert.equal(A.state, 'ACK_REQUIRED', JSON.stringify(A));
  await call('POST', '/api/dt/ack', {}); assert.equal((await call('GET', '/api/dt/state')).j.state, 'ACTIVE');
  // off-plan trade, settings, stages, export
  assert.equal((await call('POST', '/api/dt/offplan', { instrument: 'xauusd', direction: 'long', entry: 2400, stop: 2390, size: 0.1, riskZar: 200 })).s, 200);
  assert.equal((await call('PUT', '/api/dt/settings', { webhookUrl: 'http://insecure' })).s, 400);
  assert.equal((await call('PUT', '/api/dt/settings', { equityZar: 150000 })).s, 200);
  const stg = (await call('GET', '/api/dt/stages')).j; assert.equal(stg.find(x => x.id === 'S2').stage, 'PAPER'); assert.ok(stg.find(x => x.id === 'S2').checks.length);
  assert.ok(String((await call('GET', '/api/dt/export.csv')).j).startsWith('signal_id,'));
  assert.equal((await call('GET', '/api/ingest/dt/config', null, K)).j.rulebook_version, 'dt-rules-1.0');
  // sessions: London open shifts with UK daylight saving; 27 Oct 2026 London is on GMT (10:00 SAST), New York still on EDT (15:30 SAST)
  const s27 = DT.sessions(Date.parse('2026-10-27T08:30:00Z')); const sast = iso => new Date(iso).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false });
  assert.equal(sast(s27.windows.find(w => w.key === 'LONDON_OPEN').start), '10:00'); assert.equal(sast(s27.windows.find(w => w.key === 'NY_OPEN').start), '15:30');
  const s10 = DT.sessions(Date.parse('2026-11-10T08:30:00Z')); assert.equal(sast(s10.windows.find(w => w.key === 'NY_OPEN').start), '16:30');
  console.log('DAYTRADE OK (' + st.you.n + ' trade at ' + st.you.expR.toFixed(2) + 'R, advisor ' + st.advisor.n + ' outcomes, breakers and sessions verified)'); srv.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
