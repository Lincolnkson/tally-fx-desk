'use strict';
/* Day trading desk: stores the intraday advisor's signals, enforces the rulebook's hard rules and
   circuit breakers on everything n8n sends, journals what you actually did, and measures both in R.
   Rules and defaults live in config/day_trading_rules.json (the companion file to the Day Trading
   Advisor Rulebook). Tally never computes a trade; it gates, records and measures. */
const path = require('path');
const { db, setSetting, nowIso } = require('./db');
const S = require('./stats');

const CFG = require(path.join(__dirname, '..', 'config', 'day_trading_rules.json'));
const TZ = 'Africa/Johannesburg';
const STAGES = ['RESEARCH', 'PAPER', 'MICRO_LIVE', 'LIVE', 'LIVE_PROVEN', 'DISABLED'];
const ALERT_STAGES = CFG.hard_rules.H16_alerting_stages;
const GRADE_ORDER = ['C', 'B', 'A', 'A+'];

db.exec(`
CREATE TABLE IF NOT EXISTS dt_signals (id INTEGER PRIMARY KEY, signal_id TEXT UNIQUE, created_at TEXT, received_at TEXT, source TEXT DEFAULT 'advisor',
  instrument TEXT, asset_class TEXT, strategy_id TEXT, strategy_name TEXT, strategy_stage TEXT, direction TEXT, session TEXT, regime TEXT, regime_conf REAL,
  score INTEGER, grade TEXT, entry_type TEXT, entry REAL, valid_until TEXT, stop REAL, cur_stop REAL, targets TEXT, risk_pct REAL, risk_amount REAL, currency TEXT,
  size REAL, size_unit TEXT, stop_distance REAL, distance_unit TEXT, cost_r REAL, rr REAL, flat_by TEXT, invalidation TEXT, rules TEXT, volume_source TEXT,
  narrative TEXT, payload TEXT, status TEXT, gate TEXT, reasons TEXT, next_action TEXT, last_update_at TEXT,
  plan_r REAL, plan_mfe REAL, plan_mae REAL, plan_exit_reason TEXT, plan_closed_at TEXT,
  user_action TEXT, skip_reason TEXT, taken_at TEXT, act_entry REAL, act_size REAL, units_left REAL, act_exit REAL, closed_at TEXT,
  r REAL, pnl_zar REAL, exit_reason TEXT, followed INTEGER, errors TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS dt_fills (id INTEGER PRIMARY KEY, sig_id INTEGER REFERENCES dt_signals(id) ON DELETE CASCADE, at TEXT, kind TEXT, price REAL, size REAL, r_part REAL, pnl_zar REAL, note TEXT);
CREATE TABLE IF NOT EXISTS dt_updates (id INTEGER PRIMARY KEY, sig_id INTEGER REFERENCES dt_signals(id) ON DELETE CASCADE, at TEXT, status TEXT, action TEXT, rule TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS dt_decisions (id INTEGER PRIMARY KEY, at TEXT, instrument TEXT, regime TEXT, reasons TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS dt_state (id INTEGER PRIMARY KEY, at TEXT, source TEXT, state TEXT, reason TEXT, until TEXT, day TEXT, acked_at TEXT);
CREATE TABLE IF NOT EXISTS dt_readiness (day TEXT PRIMARY KEY, at TEXT, answers TEXT, ok INTEGER);
CREATE TABLE IF NOT EXISTS dt_calendar (id INTEGER PRIMARY KEY, at TEXT, ccy TEXT, impact TEXT, kind TEXT, title TEXT, UNIQUE(at, ccy, title));
CREATE INDEX IF NOT EXISTS idx_dt_status ON dt_signals(status); CREATE INDEX IF NOT EXISTS idx_dt_gate ON dt_signals(gate); CREATE INDEX IF NOT EXISTS idx_dt_dec_at ON dt_decisions(at);
`);

// ---------- settings ----------
const DT_DEFAULTS = () => ({ backtest: {}, equityZar: 100000, webhookUrl: '', tier2Enabled: !!CFG.universe.tier2_enabled, strategies: Object.fromEntries(Object.entries(CFG.strategies).map(([k, v]) => [k, v.status])), webhook: null });
function settingsGet() { const r = db.prepare("SELECT value FROM settings WHERE key='dt'").get(); const s = r ? JSON.parse(r.value) : {}; const d = DT_DEFAULTS(); return { ...d, ...s, strategies: { ...d.strategies, ...(s.strategies || {}) } }; }
const settingsSet = v => setSetting('dt', v);

// ---------- time helpers (SAST, exchange time zones) ----------
const dayKey = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
function tzOffsetMs(tz, t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}
function zonedUtc(dateStr, hm, tz) { const [y, m, d] = dateStr.split('-').map(Number), [H, M] = hm.split(':').map(Number); const wall = Date.UTC(y, m - 1, d, H, M); let g = wall; for (let i = 0; i < 3; i++) g = wall - tzOffsetMs(tz, g); return g; }
const WINDOW_LABEL = { ASIA: 'Asia / Tokyo', LONDON_OPEN: 'London open drive', JSE: 'JSE continuous trading', NY_OPEN: 'New York cash open', OVERLAP: 'London–New York overlap', US_MIDDAY: 'US midday', US_FINAL_HOUR: 'US final hour', FX_ROLLOVER: 'FX rollover (be flat)' };
const WINDOW_USE = { ASIA: 'Mark Asia high/low; S4 on JPY pairs only', LONDON_OPEN: 'FX and EU index: S1, S2, S7', JSE: 'SA40 and JSE equities', NY_OPEN: 'US indices: S1, S2, S7', OVERLAP: 'Peak FX liquidity: S1, S6', US_MIDDAY: 'S3, S4 only; others need A+', US_FINAL_HOUR: 'S1 only; flat by 15:50 New York', FX_ROLLOVER: 'Flat beforehand; spreads widen' };
function sessions(t = Date.now()) {
  const day = dayKey(t), wd = new Date(zonedUtc(day, '12:00', TZ)).getUTCDay(); const weekend = wd === 0 || wd === 6;
  const list = Object.entries(CFG.sessions.windows).map(([k, w]) => { const s = zonedUtc(day, w.start || w.time, w.tz), e = zonedUtc(day, w.end || w.time, w.tz); return { key: k, label: WINDOW_LABEL[k] || k, use: WINDOW_USE[k] || '', tz: w.tz, local: (w.start || w.time) + (w.end ? '–' + w.end : ''), start: new Date(s).toISOString(), end: new Date(e).toISOString(), open: !weekend && t >= s && t < e + (w.time ? 60000 : 0) }; }).sort((a, b) => a.start < b.start ? -1 : 1);
  return { day, weekend, now: new Date(t).toISOString(), windows: list, openNow: list.filter(w => w.open).map(w => w.key) };
}
function blackouts(t = Date.now()) {
  const from = new Date(t - 6 * 3600000).toISOString(), to = new Date(t + 30 * 3600000).toISOString(); const B = CFG.sessions.T6_blackout;
  return db.prepare('SELECT * FROM dt_calendar WHERE at BETWEEN ? AND ? ORDER BY at').all(from, to).filter(e => e.impact === 'high' || e.impact === 'medium' || e.kind === 'rate_decision').map(e => {
    const at = Date.parse(e.at), rule = e.kind === 'rate_decision' ? B.rate_decision : (B[e.impact] || B.medium); const after = e.kind === 'rate_decision' ? 75 : rule.after_min;
    return { ...e, start: new Date(at - rule.before_min * 60000).toISOString(), end: new Date(at + after * 60000).toISOString(), note: e.kind === 'rate_decision' ? 'until the press conference ends (about 75 min assumed)' : '', active: t >= at - rule.before_min * 60000 && t <= at + after * 60000 };
  });
}

// ---------- parsing ----------
const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const J = (v, d) => { if (v == null) return d; try { return JSON.parse(v); } catch (e) { return d; } };
const dirOf = d => String(d || '').toLowerCase() === 'short' ? -1 : 1;
const groupOf = inst => { for (const [g, l] of Object.entries(CFG.universe.U8_correlation_groups)) if (l.includes(inst)) return g; return null; };
const row = r => r && { ...r, targets: J(r.targets, []), invalidation: J(r.invalidation, []), rules: J(r.rules, []), reasons: J(r.reasons, []), errors: J(r.errors, []), payload: undefined, group: groupOf(r.instrument) };
const resolvedTaken = "user_action='taken' AND closed_at IS NOT NULL";
const openTakenSql = "user_action='taken' AND closed_at IS NULL";

// ---------- account, breakers and advisor state (C1–C11) ----------
function closedTaken() { return db.prepare('SELECT * FROM dt_signals WHERE ' + resolvedTaken + ' ORDER BY closed_at').all(); }
function equity(st) { const s = st || settingsGet(); const p = db.prepare('SELECT COALESCE(SUM(pnl_zar),0) p FROM dt_signals WHERE ' + resolvedTaken).get().p + db.prepare("SELECT COALESCE(SUM(f.pnl_zar),0) p FROM dt_fills f JOIN dt_signals s ON s.id=f.sig_id WHERE s.closed_at IS NULL AND f.kind='partial'").get().p; return s.equityZar + p; }
function openExposure() {
  const rows = db.prepare('SELECT * FROM dt_signals WHERE ' + openTakenSql).all();
  return rows.map(r => ({ id: r.id, signal_id: r.signal_id, instrument: r.instrument, direction: r.direction, group: groupOf(r.instrument), risk_pct: (r.risk_pct || 0) * (r.act_size && r.size ? r.act_size / r.size : 1) * (r.units_left != null && r.act_size ? r.units_left / r.act_size : 1), strategy_id: r.strategy_id, status: r.status }));
}
function breakers(t = Date.now()) {
  const C = CFG.circuit_breakers, st = settingsGet(), eq = equity(st), today = dayKey(t); const items = closedTaken();
  const todays = items.filter(x => dayKey(Date.parse(x.closed_at)) === today);
  const dayR = todays.reduce((s, x) => s + (x.r || 0), 0), dayZar = todays.reduce((s, x) => s + (x.pnl_zar || 0), 0);
  let run = 0, peakDay = 0; todays.forEach(x => { run += x.r || 0; peakDay = Math.max(peakDay, run); });
  let streak = 0, lastLossAt = null; for (let i = todays.length - 1; i >= 0; i--) { if ((todays[i].r || 0) < -S.WIN) { streak++; if (!lastLossAt) lastLossAt = todays[i].closed_at; } else break; }
  const takenRows = db.prepare("SELECT instrument, taken_at, strategy_id FROM dt_signals WHERE user_action='taken'").all().filter(x => x.taken_at && dayKey(Date.parse(x.taken_at)) === today && x.strategy_id !== 'S6');
  const perInst = {}; takenRows.forEach(x => perInst[x.instrument] = (perInst[x.instrument] || 0) + 1);
  // weekly (Mon–Sun SAST)
  const wd = (new Date(zonedUtc(today, '12:00', TZ)).getUTCDay() + 6) % 7; const weekStart = dayKey(zonedUtc(today, '12:00', TZ) - wd * 86400000), lastWeekStart = dayKey(zonedUtc(today, '12:00', TZ) - (wd + 7) * 86400000);
  const weekR = items.filter(x => dayKey(Date.parse(x.closed_at)) >= weekStart).reduce((s, x) => s + (x.r || 0), 0);
  const lastWeekR = items.filter(x => { const k = dayKey(Date.parse(x.closed_at)); return k >= lastWeekStart && k < weekStart; }).reduce((s, x) => s + (x.r || 0), 0);
  let cum = 0, peak = 0; items.forEach(x => { cum += x.r || 0; peak = Math.max(peak, cum); }); const ddR = peak - cum;
  const reasons = [], codes = []; let lock = false, cooldownUntil = null, aPlusOnly = false, riskMult = 1;
  if (dayR <= -C.C1_daily_loss.r || (eq > 0 && dayZar <= -C.C1_daily_loss.pct / 100 * (eq - dayZar))) { lock = true; codes.push('C1'); reasons.push('Daily loss limit reached (' + dayR.toFixed(1) + 'R). Done for today.'); }
  if (streak >= C.C2_consecutive_losses.lock_after) { lock = true; codes.push('C2'); reasons.push(streak + ' losses in a row today. Locked until the next session.'); }
  else if (streak >= C.C2_consecutive_losses.cooldown_after) { const until = Date.parse(lastLossAt) + C.C2_consecutive_losses.cooldown_min * 60000; aPlusOnly = true; codes.push('C2'); if (t < until) { cooldownUntil = new Date(until).toISOString(); reasons.push(streak + ' losses in a row. Cooling down until ' + fmtSast(until) + ', then A+ only for the rest of the day.'); } else reasons.push(streak + ' losses in a row today. A+ signals only for the rest of the day.'); }
  if (peakDay >= C.C4_profit_protection.halve_risk_at_r) { riskMult *= 0.5; codes.push('C4'); if (dayR <= peakDay * (1 - C.C4_profit_protection.stop_if_giveback_pct / 100)) { lock = true; reasons.push('Gave back half of a +' + peakDay.toFixed(1) + 'R day. Stop for today.'); } else reasons.push('Up +' + peakDay.toFixed(1) + 'R at the peak today: risk halved.'); }
  if (lastWeekR <= -C.C5_weekly_loss_r) { riskMult *= C.C5_next_week_risk_mult; codes.push('C5'); reasons.push('Last week finished at ' + lastWeekR.toFixed(1) + 'R: this week trades at half risk.'); }
  const review = ddR >= C.C6_peak_drawdown_r; if (review) { codes.push('C6'); reasons.push('Down ' + ddR.toFixed(1) + 'R from the equity peak: live trading stopped. Back to Paper and write a review.'); }
  const tradesToday = takenRows.length; const maxTrades = tradesToday >= C.C3_max_trades.per_day; if (maxTrades) { codes.push('C3'); reasons.push('Five trades taken today: no more entries.'); }
  return { day: today, dayR, dayZar, peakDayR: peakDay, weekR, lastWeekR, ddR, lossStreak: streak, tradesToday, perInstrument: perInst, maxTrades, lock, cooldownUntil, aPlusOnly, riskMult, review, codes, reasons, equity: eq };
}
const fmtSast = t => new Date(t).toLocaleTimeString('en-ZA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

function readinessToday(t = Date.now()) { const r = db.prepare('SELECT * FROM dt_readiness WHERE day=?').get(dayKey(t)); return r ? { ...r, answers: J(r.answers, {}), ok: !!r.ok } : null; }
function recordLock(b, t = Date.now()) {
  if (!b.lock) return; const day = dayKey(t); if (db.prepare("SELECT 1 FROM dt_state WHERE source='tally' AND state='LOCKED' AND day=?").get(day)) return;
  db.prepare("INSERT INTO dt_state(at,source,state,reason,day) VALUES(?,?,?,?,?)").run(new Date(t).toISOString(), 'tally', 'LOCKED', b.reasons.join(' '), day);
}
// One state for the whole desk. Precedence: LOCKED > PAUSED > ACK_REQUIRED > COOLDOWN > OBSERVE_ONLY > ACTIVE.
function advisorState(t = Date.now()) {
  const b = breakers(t); recordLock(b, t); const day = dayKey(t), rd = readinessToday(t); const st = settingsGet();
  const n8n = db.prepare("SELECT * FROM dt_state WHERE source='n8n' ORDER BY id DESC LIMIT 1").get();
  const n8nActive = n8n && n8n.state !== 'ACTIVE' && (n8n.until ? Date.parse(n8n.until) > t : n8n.day === day) ? n8n : null;
  const unacked = db.prepare("SELECT * FROM dt_state WHERE state IN ('LOCKED','PAUSED') AND acked_at IS NULL AND day < ? ORDER BY id").all(day);
  const lockToday = db.prepare("SELECT * FROM dt_state WHERE source='tally' AND state='LOCKED' AND day=? ORDER BY id DESC LIMIT 1").get(day);
  let state = 'ACTIVE', reasons = [];
  if (b.lock || lockToday) { state = 'LOCKED'; reasons = b.reasons.length ? b.reasons.slice() : [lockToday.reason]; }
  else if (n8nActive && (n8nActive.state === 'LOCKED' || n8nActive.state === 'PAUSED')) { state = n8nActive.state; reasons = [n8nActive.reason || 'Set by the advisor.']; }
  else if (unacked.length) { state = 'ACK_REQUIRED'; reasons = ['Acknowledge the ' + unacked[0].state.toLowerCase() + ' event from ' + unacked[0].day + ' before new alerts are sent (C11).']; }
  else if (b.cooldownUntil || (n8nActive && n8nActive.state === 'COOLDOWN')) { state = 'COOLDOWN'; reasons = b.cooldownUntil ? b.reasons.slice() : [n8nActive.reason || 'Cooldown set by the advisor.']; }
  else if (!rd || !rd.ok || (n8nActive && n8nActive.state === 'OBSERVE_ONLY')) { state = 'OBSERVE_ONLY'; reasons = [!rd ? 'Morning readiness check not done yet (C9). Signals are logged, not alerted.' : !rd.ok ? 'A readiness answer was "no", so this session is observe-only (C9).' : (n8nActive.reason || 'Observe-only set by the advisor.')]; }
  if (state === 'ACTIVE' && b.reasons.length) reasons = b.reasons.slice();
  const alertsEnabled = state === 'ACTIVE';
  return { state, alertsEnabled, aPlusOnly: b.aPlusOnly, reasons, breakers: b, readiness: rd, n8n: n8nActive, unacked: unacked.map(u => ({ id: u.id, day: u.day, state: u.state, reason: u.reason })), lockToday: lockToday ? { id: lockToday.id, acked: !!lockToday.acked_at } : null, riskMult: b.review ? 0 : b.riskMult, strategies: st.strategies };
}

// ---------- signal gate: the hard rules, re-checked on everything n8n sends ----------
function gradeBucketOk(strategy, grade) {
  const G = CFG.scoring.grades[grade] || {}; if (!G.alert_if_bucket_trades_gte) return false;
  const rs = db.prepare('SELECT plan_r FROM dt_signals WHERE strategy_id=? AND grade=? AND plan_r IS NOT NULL').all(strategy, grade).map(x => x.plan_r);
  return rs.length >= G.alert_if_bucket_trades_gte && rs.reduce((s, x) => s + x, 0) / rs.length > (G.and_bucket_expectancy_gt || 0);
}
function stageRiskPct(stage) { const K = CFG.risk.K1_risk_pct_by_stage; return K[stage] != null ? K[stage] : K.PAPER; }
function evaluate(s, t = Date.now()) {
  const H = CFG.hard_rules, codes = [], soft = []; const st = settingsGet(), A = advisorState(t);
  const stage = st.strategies[s.strategy_id] || 'RESEARCH'; const d = dirOf(s.direction), R = Math.abs(s.entry - s.stop);
  // H2 + target order
  if (!(R > 0) || (d === 1 ? s.stop >= s.entry : s.stop <= s.entry)) codes.push('STOP_RULE');
  const tg = s.targets.filter(x => num(x.price) != null); if (tg.some(x => d * (x.price - s.entry) <= 0)) codes.push('INCOMPLETE_SIGNAL');
  for (let i = 1; i < tg.length; i++) if (d * (tg[i].price - tg[i - 1].price) < 0) { codes.push('INCOMPLETE_SIGNAL'); break; }
  // H7 reward to risk, computed from prices (falls back to the stated rr)
  const rrCalc = R > 0 && tg.length ? Math.max(...tg.map(x => d * (x.price - s.entry) / R)) : num(s.rr); s.rr = rrCalc != null ? Math.round(rrCalc * 100) / 100 : s.rr;
  const scalp = s.strategy_id === 'S6'; const minRR = scalp ? H.H7_scalp_min_rr : H.H7_min_primary_rr; if (s.rr == null || s.rr < minRR - 1e-9) codes.push('RR_TOO_LOW');
  // H6 costs
  if (s.cost_r != null && (scalp ? s.cost_r > (H.H6_scalp_max_cost_pct_of_target / 100) * (s.rr || 0) + 1e-9 : s.cost_r > H.H6_max_cost_r + 1e-9)) codes.push('COST_TOO_HIGH');
  // H3 risk cap against the strategy's stage
  const cap = Math.min(H.H3_risk_pct_ceiling, ALERT_STAGES.includes(stage) ? stageRiskPct(stage) : H.H3_risk_pct_ceiling); if (s.risk_pct != null && s.risk_pct > cap + 1e-9) codes.push('RISK_CAP');
  // expiry on arrival
  if (s.valid_until && Date.parse(s.valid_until) < t) codes.push('EXPIRED_ON_ARRIVAL');
  // H16 strategy stage
  if (stage === 'DISABLED') codes.push('STRATEGY_NOT_LIVE'); else if (!ALERT_STAGES.includes(stage)) soft.push('STRATEGY_NOT_LIVE');
  // G3 grades
  if (s.grade === 'C' || !GRADE_ORDER.includes(s.grade)) soft.push('GRADE_TOO_LOW'); else if (s.grade === 'B' && !gradeBucketOk(s.strategy_id, 'B')) soft.push('GRADE_B_LOG_ONLY');
  // H10 exposure and C3 trade counts (only matters for signals that would alert)
  const ex = openExposure(); const armed = db.prepare("SELECT instrument FROM dt_signals WHERE gate='ALERT' AND status='ARMED' AND user_action IS NULL").all();
  if (ex.some(x => x.instrument === s.instrument) || armed.some(x => x.instrument === s.instrument)) codes.push('EXPOSURE_CAP');
  const g = groupOf(s.instrument); if (g && ex.some(x => x.group === g && x.instrument !== s.instrument)) codes.push('EXPOSURE_CAP');
  const openRisk = ex.reduce((a, x) => a + (x.risk_pct || 0), 0); if (openRisk + (s.risk_pct || 0) > H.H10_max_total_open_risk_pct + 1e-9) codes.push('EXPOSURE_CAP');
  if (A.breakers.maxTrades) codes.push('MAX_TRADES'); if ((A.breakers.perInstrument[s.instrument] || 0) >= CFG.circuit_breakers.C3_max_trades.per_instrument) codes.push('MAX_ATTEMPTS');
  // advisor state
  if (A.state === 'LOCKED' || A.state === 'PAUSED' || A.state === 'ACK_REQUIRED' || A.state === 'COOLDOWN') codes.push(A.state === 'ACK_REQUIRED' ? 'LOCKED' : A.state);
  else if (A.aPlusOnly && s.grade !== 'A+') codes.push('COOLDOWN');
  if (A.breakers.review && ['MICRO_LIVE', 'LIVE', 'LIVE_PROVEN'].includes(stage)) codes.push('LOCKED');
  if (A.state === 'OBSERVE_ONLY') soft.push('OBSERVE_ONLY');
  const uniq = a => [...new Set(a)];
  let gate = 'ALERT';
  const hard = uniq(codes.filter(c => ['STOP_RULE', 'INCOMPLETE_SIGNAL', 'RR_TOO_LOW', 'COST_TOO_HIGH', 'RISK_CAP', 'EXPIRED_ON_ARRIVAL', 'STRATEGY_NOT_LIVE'].includes(c)));
  if (hard.length) gate = 'BLOCKED';
  else if (soft.includes('STRATEGY_NOT_LIVE')) gate = 'SHADOW';
  else if (soft.includes('GRADE_TOO_LOW')) gate = 'SHADOW';
  else if (soft.includes('GRADE_B_LOG_ONLY')) gate = 'LOGGED';
  else if (codes.length) gate = 'BLOCKED';
  else if (soft.includes('OBSERVE_ONLY')) gate = 'OBSERVE';
  return { gate, stage, reasons: uniq(codes.concat(soft)), rr: s.rr };
}

// ---------- normalise the advisor's O1 payload ----------
function normalise(b) {
  const e = b.entry || {}, r = b.risk || {}, m = b.management || {}, reg = b.regime || {};
  return {
    signal_id: b.signal_id, created_at: b.created_at || nowIso(), instrument: String(b.instrument || '').toUpperCase(), asset_class: b.asset_class || null,
    strategy_id: b.strategy_id, strategy_name: b.strategy_name || (CFG.strategies[b.strategy_id] || {}).name || null, strategy_stage: b.strategy_stage || null,
    direction: String(b.direction || '').toLowerCase(), session: b.session || null, regime: typeof reg === 'string' ? reg : reg.label || null, regime_conf: num(reg.confidence),
    score: num(b.score), grade: b.grade || null, entry_type: e.type || null, entry: num(typeof e === 'object' ? e.price : e), valid_until: e.valid_until || b.expires_at || null,
    stop: num(b.stop), targets: Array.isArray(b.targets) ? b.targets.map(x => ({ id: x.id, price: num(x.price), r: num(x.r), close_pct: num(x.close_pct), trail: x.trail || null })) : [],
    risk_pct: num(r.effective_risk_pct), risk_amount: num(r.risk_amount), currency: r.currency || 'ZAR', size: num(r.position_size), size_unit: r.size_unit || null,
    stop_distance: num(r.stop_distance), distance_unit: r.distance_unit || null, cost_r: num(r.cost_r), rr: num(r.rr_primary), flat_by: m.flat_by || null,
    invalidation: Array.isArray(b.invalidation) ? b.invalidation : (b.invalidation ? [b.invalidation] : []), rules: b.rules_passed || [], volume_source: b.volume_source || null,
    narrative: b.narrative || null, status: b.status || 'ARMED'
  };
}
function missing(s) {
  const need = { signal_id: s.signal_id, instrument: s.instrument, direction: ['long', 'short'].includes(s.direction) ? s.direction : null, strategy_id: s.strategy_id, 'entry.price': s.entry, stop: s.stop, 'targets[0]': s.targets.length ? 1 : null, 'risk.position_size': s.size, 'entry.valid_until': s.valid_until };
  return Object.keys(need).filter(k => need[k] == null || need[k] === '');
}
const INSERT_COLS = ['signal_id', 'created_at', 'received_at', 'source', 'instrument', 'asset_class', 'strategy_id', 'strategy_name', 'strategy_stage', 'direction', 'session', 'regime', 'regime_conf', 'score', 'grade', 'entry_type', 'entry', 'valid_until', 'stop', 'cur_stop', 'targets', 'risk_pct', 'risk_amount', 'currency', 'size', 'size_unit', 'stop_distance', 'distance_unit', 'cost_r', 'rr', 'flat_by', 'invalidation', 'rules', 'volume_source', 'narrative', 'payload', 'status', 'gate', 'reasons'];
function insertSignal(s, gate, reasons, payload, source) {
  const v = { ...s, received_at: nowIso(), source: source || 'advisor', cur_stop: s.stop, targets: JSON.stringify(s.targets), invalidation: JSON.stringify(s.invalidation), rules: JSON.stringify(s.rules), payload: JSON.stringify(payload || {}), gate, reasons: JSON.stringify(reasons || []), status: gate === 'BLOCKED' && reasons.includes('EXPIRED_ON_ARRIVAL') ? 'EXPIRED' : (s.status || 'ARMED') };
  return db.prepare('INSERT INTO dt_signals(' + INSERT_COLS.join(',') + ') VALUES(' + INSERT_COLS.map(() => '?').join(',') + ')').run(...INSERT_COLS.map(k => v[k] === undefined ? null : v[k])).lastInsertRowid;
}

// ---------- stats (J2, J3) and strategy stages (section 14) ----------
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function edgeStats(items) { const s = S.stats(items); const mf = items.filter(x => x.mfe != null), ma = items.filter(x => x.mae != null); const avgMfe = mf.length ? mf.reduce((a, x) => a + x.mfe, 0) / mf.length : null, avgMae = ma.length ? ma.reduce((a, x) => a + Math.abs(x.mae), 0) / ma.length : null; return { ...s, avgMfe, avgMae, edgeRatio: avgMfe != null && avgMae ? avgMfe / avgMae : null }; }
function seg(items, f) { return S.groupStats(items, f); }
function statsBuild(days) {
  const cut = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
  const all = db.prepare('SELECT * FROM dt_signals WHERE created_at >= ? ORDER BY created_at').all(cut);
  const mine = all.filter(x => x.user_action === 'taken' && x.closed_at).sort((a, b) => a.closed_at < b.closed_at ? -1 : 1).map(x => ({ ...x, r: x.r || 0, pnl: x.pnl_zar || 0, mfe: x.plan_mfe, mae: x.plan_mae }));
  const plan = all.filter(x => x.plan_r != null && x.source === 'advisor').map(x => ({ ...x, r: x.plan_r, pnl: 0, mfe: x.plan_mfe, mae: x.plan_mae }));
  const alerted = all.filter(x => x.gate === 'ALERT');
  const decided = alerted.filter(x => x.user_action || ['CLOSED', 'EXPIRED', 'CANCELLED'].includes(x.status));
  const followed = alerted.filter(x => x.user_action === 'taken' && x.followed === 1).length; const offPlan = all.filter(x => x.source === 'off_plan').length;
  const adherence = decided.length + offPlan ? followed / (decided.length + offPlan) : null;
  const both = alerted.filter(x => x.user_action === 'taken' && x.closed_at && x.plan_r != null); const gap = both.length ? both.reduce((s, x) => s + ((x.r || 0) - x.plan_r), 0) / both.length : null;
  const weeks = Math.max(1, ((Date.now() - (all.length ? Date.parse(all[0].created_at) : Date.now())) / 604800000)); const freq = {}; alerted.forEach(x => freq[x.strategy_id] = (freq[x.strategy_id] || 0) + 1);
  const wd = x => WD[(new Date(Date.parse(x.created_at) + 2 * 3600000).getUTCDay() + 6) % 7];
  const segs = items => ({ strategy: seg(items, x => x.strategy_id + ' ' + (x.strategy_name || '')), grade: seg(items, x => x.grade).sort((a, b) => GRADE_ORDER.indexOf(b.key) - GRADE_ORDER.indexOf(a.key)), regime: seg(items, x => x.regime), session: seg(items, x => x.session), instrument: seg(items, x => x.instrument), weekday: seg(items, wd).sort((a, b) => WD.indexOf(a.key) - WD.indexOf(b.key)), volume: seg(items, x => x.volume_source) });
  const gradeExp = g => { const a = plan.filter(x => x.grade === g); return a.length ? a.reduce((s, x) => s + x.r, 0) / a.length : null; };
  const calib = plan.length >= CFG.scoring.G5_calibration_every_trades ? { ok: (gradeExp('A+') ?? -9) >= (gradeExp('A') ?? -9) && (gradeExp('A') ?? -9) >= (gradeExp('B') ?? -9), aPlus: gradeExp('A+'), a: gradeExp('A'), b: gradeExp('B') } : null;
  let eq = settingsGet().equityZar, cum = 0; const curve = [{ date: mine.length ? mine[0].closed_at.slice(0, 10) : '', equity: eq, cumR: 0 }].concat(mine.map(x => { eq += x.pnl; cum += x.r; return { date: dayKey(Date.parse(x.closed_at)), equity: Math.round(eq), cumR: Math.round(cum * 100) / 100 }; }));
  const planCurve = [{ cumR: 0, date: '' }]; let pc = 0; plan.slice().sort((a, b) => (a.plan_closed_at || '') < (b.plan_closed_at || '') ? -1 : 1).forEach(x => { pc += x.r; planCurve.push({ cumR: Math.round(pc * 100) / 100, date: (x.plan_closed_at || x.created_at).slice(0, 10) }); });
  const errs = {}; mine.forEach(x => J(x.errors, []).forEach(e => errs[e] = (errs[e] || 0) + 1));
  const exits = {}; mine.forEach(x => { const k = x.exit_reason || 'MANUAL'; exits[k] = (exits[k] || 0) + 1; });
  return {
    you: edgeStats(mine), advisor: edgeStats(plan), counts: { signals: all.length, alerted: alerted.length, shadow: all.filter(x => x.gate === 'SHADOW').length, blocked: all.filter(x => x.gate === 'BLOCKED').length, observe: all.filter(x => x.gate === 'OBSERVE').length, logged: all.filter(x => x.gate === 'LOGGED').length, taken: all.filter(x => x.user_action === 'taken').length, skipped: all.filter(x => x.user_action === 'skipped').length, offPlan },
    adherence, executionGapR: gap, gapN: both.length, perWeek: Object.fromEntries(Object.entries(freq).map(([k, n]) => [k, n / weeks])),
    segYou: segs(mine), segAdvisor: segs(plan), curve, planCurve, hist: S.histogram(mine.map(x => x.r)), errors: errs, exits, calibration: calib, recent: mine.slice(-24).map(x => ({ r: x.r, pair: x.instrument, id: x.id }))
  };
}
function stages() {
  const st = settingsGet(), V = CFG.validation.gates;
  return Object.entries(CFG.strategies).map(([id, c]) => {
    const stage = st.strategies[id] || 'RESEARCH'; const rows = db.prepare('SELECT * FROM dt_signals WHERE strategy_id=? AND source=? ORDER BY created_at').all(id, 'advisor');
    const plan = rows.filter(x => x.plan_r != null); const ps = S.stats(plan.map(x => ({ r: x.plan_r, pnl: 0 })));
    const mineAll = rows.filter(x => x.user_action === 'taken' && x.closed_at); const ms = S.stats(mineAll.map(x => ({ r: x.r || 0, pnl: x.pnl_zar || 0 })));
    const alerted = rows.filter(x => x.gate === 'ALERT'); const followed = alerted.filter(x => x.user_action === 'taken' && x.followed === 1).length; const adh = alerted.length ? followed / alerted.length : null;
    const days = rows.length ? (Date.now() - Date.parse(rows[0].created_at)) / 86400000 : 0; const last30 = plan.slice(-CFG.circuit_breakers.C7_strategy_kill.rolling_trades); const roll = last30.length ? last30.reduce((s, x) => s + x.plan_r, 0) / last30.length : null;
    const bt = st.backtest && st.backtest[id] != null ? st.backtest[id] : null; let next = null, checks = [];
    if (stage === 'RESEARCH') { next = 'PAPER'; checks = [{ label: 'Backtest: ≥ ' + CFG.validation.backtest_min_trades + ' trades over ≥ ' + CFG.validation.backtest_min_years + ' years, out-of-sample expectancy > +' + V.RESEARCH_to_PAPER.oos_expectancy_r_gt + 'R, profit factor > ' + V.RESEARCH_to_PAPER.profit_factor_gt + ', robustness and walk-forward pass (V4, V5)', pass: null, note: 'Run outside Tally; confirm when you promote' }, { label: 'Shadow signals logged here', pass: plan.length > 0, note: plan.length + ' resolved, ' + (plan.length ? rf(ps.expR) + ' each' : 'none yet') }]; }
    else if (stage === 'PAPER') { const g = V.PAPER_to_MICRO_LIVE; next = 'MICRO_LIVE'; checks = [{ label: '≥ ' + g.min_days + ' days on Paper', pass: days >= g.min_days, note: Math.floor(days) + ' days' }, { label: '≥ ' + g.min_trades + ' trades', pass: plan.length >= g.min_trades, note: plan.length + ' resolved' }, { label: 'Expectancy within ' + g.max_expectancy_gap_r + 'R of the backtest', pass: bt == null || !plan.length ? null : Math.abs(ps.expR - bt) <= g.max_expectancy_gap_r + 1e-9, note: 'Live ' + rf(ps.expR) + (bt == null ? ', add the backtest expectancy' : ', backtest ' + rf(bt)) }, { label: 'Rule adherence ≥ ' + g.min_adherence_pct + '%', pass: adh != null && adh * 100 >= g.min_adherence_pct, note: adh == null ? 'no alerts yet' : Math.round(adh * 100) + '%' }]; }
    else if (stage === 'MICRO_LIVE') { const g = V.MICRO_LIVE_to_LIVE; next = 'LIVE'; checks = [{ label: '≥ ' + g.min_days + ' days at micro size', pass: days >= g.min_days, note: Math.floor(days) + ' days' }, { label: '≥ ' + g.min_trades + ' trades', pass: mineAll.length >= g.min_trades, note: mineAll.length + ' taken and closed' }, { label: 'Expectancy > 0 after real costs', pass: mineAll.length > 0 && ms.expR > g.expectancy_r_gt, note: mineAll.length ? rf(ms.expR) : '–' }, { label: 'No C6 drawdown event', pass: !breakers().review, note: '' }]; }
    else if (stage === 'LIVE') { next = 'LIVE_PROVEN'; checks = [{ label: '≥ ' + CFG.risk.K1_live_proven_min_trades + ' live trades', pass: mineAll.length >= CFG.risk.K1_live_proven_min_trades, note: mineAll.length + ' so far' }, { label: 'Positive expectancy', pass: mineAll.length > 0 && ms.expR > 0, note: mineAll.length ? rf(ms.expR) : '–' }]; }
    const kill = roll != null && last30.length >= CFG.circuit_breakers.C7_strategy_kill.rolling_trades && roll < CFG.circuit_breakers.C7_strategy_kill.min_expectancy_r;
    return { id, name: c.name, stage, backtestE: bt, defaultStage: c.status, riskMult: c.risk_mult, stageRiskPct: ALERT_STAGES.includes(stage) ? stageRiskPct(stage) : null, plan: { n: ps.n, expR: ps.expR, pf: ps.pf, winRate: ps.winRate, maxDDR: ps.maxDDR }, you: { n: ms.n, expR: ms.expR }, adherence: adh, days: Math.floor(days), rollingExpR: roll, killSwitch: kill, next, checks };
  });
}
const rf = (x, d = 2) => x == null ? '–' : (x < 0 ? '−' : '+') + Math.abs(x).toFixed(d) + 'R';

// C7: a live strategy whose rolling 30-trade plan expectancy goes below −0.10R drops to Paper.
function killSwitch(strategy, addEvent) {
  const st = settingsGet(); const stage = st.strategies[strategy]; if (!['MICRO_LIVE', 'LIVE', 'LIVE_PROVEN'].includes(stage)) return;
  const K = CFG.circuit_breakers.C7_strategy_kill; const rs = db.prepare('SELECT plan_r FROM dt_signals WHERE strategy_id=? AND plan_r IS NOT NULL ORDER BY plan_closed_at DESC LIMIT ?').all(strategy, K.rolling_trades).map(x => x.plan_r);
  if (rs.length < K.rolling_trades) return; const e = rs.reduce((s, x) => s + x, 0) / rs.length; if (e >= K.min_expectancy_r) return;
  st.strategies[strategy] = 'PAPER'; settingsSet(st); addEvent('day', 'alert', strategy + ' demoted to Paper (C7)', 'Its last ' + rs.length + ' signals averaged ' + rf(e) + ', below the ' + K.min_expectancy_r + 'R kill line.');
}

// ---------- outbound webhook to n8n ----------
async function hook(event, payload) {
  const st = settingsGet(); if (!st.webhookUrl) return { skipped: true };
  const key = process.env.INGEST_API_KEY || ''; let ok = false, status = null, error = null;
  try { const r = await fetch(st.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ event, at: nowIso(), payload }), signal: AbortSignal.timeout(6000) }); ok = r.ok; status = r.status; }
  catch (e) { error = e.message; }
  const s2 = settingsGet(); s2.webhook = { event, at: nowIso(), ok, status, error }; settingsSet(s2); return { ok, status, error };
}

// ---------- routes ----------
function mount({ ingest, api, addEvent, push, guard }) {
  const refresh = () => push('refresh', { what: 'day' });
  const getSig = id => db.prepare('SELECT * FROM dt_signals WHERE id=?').get(id);
  const ctx = () => {
    const A = advisorState(), st = settingsGet(), ex = openExposure();
    return { rulebook_version: CFG.rulebook_version, now: nowIso(), sast_day: dayKey(), equity_zar: Math.round(equity(st)), advisor_state: A.state, alerts_enabled: A.alertsEnabled, a_plus_only: A.aPlusOnly, reasons: A.reasons,
      risk_multiplier: A.riskMult, risk_pct_by_stage: CFG.risk.K1_risk_pct_by_stage, strategies: st.strategies, alerting_stages: ALERT_STAGES, tier2_enabled: st.tier2Enabled,
      readiness: A.readiness ? { done: true, ok: A.readiness.ok } : { done: false, ok: false }, breakers: { day_r: +A.breakers.dayR.toFixed(2), week_r: +A.breakers.weekR.toFixed(2), last_week_r: +A.breakers.lastWeekR.toFixed(2), loss_streak: A.breakers.lossStreak, trades_today: A.breakers.tradesToday, per_instrument: A.breakers.perInstrument, drawdown_r: +A.breakers.ddR.toFixed(2), codes: A.breakers.codes },
      open_positions: ex, open_risk_pct: +ex.reduce((a, x) => a + (x.risk_pct || 0), 0).toFixed(3), armed: db.prepare("SELECT signal_id, instrument, strategy_id FROM dt_signals WHERE gate='ALERT' AND status='ARMED' AND user_action IS NULL").all(), sessions_open: sessions().openNow, blackouts_active: blackouts().filter(b => b.active).map(b => ({ ccy: b.ccy, title: b.title, until: b.end })) };
  };

  // --- n8n → Tally ---
  ingest.get('/dt/context', (req, res) => res.json(ctx()));
  ingest.get('/dt/config', (req, res) => res.json({ ...CFG, effective: { strategies: settingsGet().strategies, tier2_enabled: settingsGet().tier2Enabled } }));
  ingest.post('/dt/signals', (req, res) => {
    const b = req.body || {}; if (b.decision && b.decision !== 'SIGNAL') return res.status(400).json({ error: 'decision must be SIGNAL here; send NO_TRADE decisions to /api/ingest/dt/decisions' });
    const s = normalise(b); const miss = missing(s); if (miss.length) return res.status(400).json({ error: 'INCOMPLETE_SIGNAL (H1): missing ' + miss.join(', '), code: 'INCOMPLETE_SIGNAL', missing: miss });
    const ex = db.prepare('SELECT id, gate FROM dt_signals WHERE signal_id=?').get(s.signal_id); if (ex) return res.json({ ok: true, duplicate: true, id: ex.id, gate: ex.gate });
    const ev = evaluate(s); s.strategy_stage = ev.stage; s.rr = ev.rr; const id = insertSignal(s, ev.gate, ev.reasons, b);
    if (ev.gate === 'ALERT') addEvent('day', 'action', s.instrument + ' ' + s.direction + ' · ' + s.strategy_id + ' ' + (s.grade || '') + ' armed', (s.narrative || '') + (s.valid_until ? ' Valid until ' + fmtSast(Date.parse(s.valid_until)) + ' SAST.' : ''));
    refresh(); res.json({ ok: true, id, gate: ev.gate, alerted: ev.gate === 'ALERT', reasons: ev.reasons, stage: ev.stage });
  });
  ingest.patch('/dt/signals/:sid', (req, res) => {
    const s = db.prepare('SELECT * FROM dt_signals WHERE signal_id=?').get(req.params.sid); if (!s) return res.status(404).json({ error: 'Unknown signal_id' }); const u = req.body || {};
    const d = dirOf(s.direction); let cur = s.cur_stop; const ns = num(u.new_stop); let stopIgnored = false;
    if (ns != null) { if (d * (ns - cur) > 0) cur = ns; else if (ns !== cur) stopIgnored = true; } // H2: stops only tighten
    const status = u.status ? String(u.status).toUpperCase() : s.status; const resolved = ['CLOSED', 'EXPIRED', 'CANCELLED'].includes(status);
    const planR = num(u.result_r) != null ? num(u.result_r) : (status === 'CLOSED' && num(u.r_open) != null ? num(u.r_open) : null);
    const next = u.action ? String(u.action).toUpperCase() + (u.message ? ': ' + u.message : '') : (u.message || null);
    db.prepare('UPDATE dt_signals SET status=?, cur_stop=?, next_action=COALESCE(?,next_action), last_update_at=?, plan_mfe=MAX(COALESCE(plan_mfe,-99),COALESCE(?,-99)), plan_mae=MIN(COALESCE(plan_mae,99),COALESCE(?,99)), plan_r=COALESCE(?,plan_r), plan_exit_reason=COALESCE(?,plan_exit_reason), plan_closed_at=COALESCE(?,plan_closed_at) WHERE id=?')
      .run(status, cur, next, nowIso(), num(u.mfe_r), num(u.mae_r), resolved ? planR : null, resolved ? (u.exit_reason || status) : null, resolved ? (u.at || nowIso()) : null, s.id);
    db.prepare('UPDATE dt_signals SET plan_mfe=NULLIF(plan_mfe,-99), plan_mae=NULLIF(plan_mae,99) WHERE id=?').run(s.id);
    db.prepare('INSERT INTO dt_updates(sig_id,at,status,action,rule,payload) VALUES(?,?,?,?,?,?)').run(s.id, u.at || nowIso(), status, u.action || null, u.rule || null, JSON.stringify(u));
    const watched = s.gate === 'ALERT' && (s.user_action !== 'skipped') && !s.closed_at;
    if (watched && (u.action || status !== s.status)) { const exit = /EXIT|CLOSED|STOP/.test(String(u.action || status)); addEvent('day', exit ? 'alert' : 'action', s.instrument + ' ' + s.direction + ': ' + String(u.action || status).replace(/_/g, ' ').toLowerCase() + (ns != null && !stopIgnored ? ' to ' + ns : ''), (u.message || '') + (u.rule ? ' (' + u.rule + ')' : '')); }
    if (resolved && planR != null) killSwitch(s.strategy_id, addEvent);
    refresh(); res.json({ ok: true, status, cur_stop: cur, stop_ignored: stopIgnored });
  });
  ingest.get('/dt/active', (req, res) => res.json(db.prepare("SELECT signal_id, instrument, direction, strategy_id, status, gate, entry, stop, cur_stop, targets, valid_until, flat_by, user_action, act_entry, act_size, units_left FROM dt_signals WHERE status IN ('ARMED','ACTIVE','PARTIAL') ORDER BY created_at").all().map(r => ({ ...r, targets: J(r.targets, []) }))));
  ingest.post('/dt/decisions', (req, res) => {
    const list = Array.isArray(req.body) ? req.body : Array.isArray(req.body.decisions) ? req.body.decisions : [req.body]; const ins = db.prepare('INSERT INTO dt_decisions(at,instrument,regime,reasons,payload) VALUES(?,?,?,?,?)');
    let n = 0; db.transaction(() => list.forEach(d => { if (!d || !d.instrument) return; ins.run(d.evaluated_at || nowIso(), String(d.instrument).toUpperCase(), (d.regime && (d.regime.label || d.regime)) || null, JSON.stringify(d.reason_codes || []), JSON.stringify(d)); n++; }))();
    db.prepare('DELETE FROM dt_decisions WHERE at < ?').run(new Date(Date.now() - 14 * 86400000).toISOString()); if (n) push('refresh', { what: 'day-decisions' }); res.json({ ok: true, stored: n });
  });
  ingest.post('/dt/advisor-state', (req, res) => {
    const b = req.body || {}; const state = String(b.state || '').toUpperCase(); if (!['ACTIVE', 'LOCKED', 'PAUSED', 'COOLDOWN', 'OBSERVE_ONLY'].includes(state)) return res.status(400).json({ error: 'state must be ACTIVE, LOCKED, PAUSED, COOLDOWN or OBSERVE_ONLY' });
    db.prepare('INSERT INTO dt_state(at,source,state,reason,until,day) VALUES(?,?,?,?,?,?)').run(nowIso(), 'n8n', state, b.reason || '', b.until || null, dayKey());
    if (state !== 'ACTIVE') addEvent('day', state === 'LOCKED' || state === 'PAUSED' ? 'alert' : 'info', 'Day advisor ' + state.toLowerCase().replace('_', '-'), b.reason || ''); refresh(); res.json({ ok: true, effective: advisorState().state });
  });
  ingest.post('/dt/calendar', (req, res) => {
    const list = Array.isArray(req.body) ? req.body : (req.body.events || []); const ins = db.prepare('INSERT OR IGNORE INTO dt_calendar(at,ccy,impact,kind,title) VALUES(?,?,?,?,?)'); let n = 0;
    db.transaction(() => list.forEach(e => { if (!e || !e.at || isNaN(Date.parse(e.at))) return; ins.run(new Date(e.at).toISOString(), (e.ccy || e.currency || '').toUpperCase(), String(e.impact || 'low').toLowerCase(), e.kind || (/rate|policy|fomc|mpc/i.test(e.title || '') ? 'rate_decision' : 'release'), e.title || ''); n++; }))();
    db.prepare('DELETE FROM dt_calendar WHERE at < ?').run(new Date(Date.now() - 7 * 86400000).toISOString()); push('refresh', { what: 'day-calendar' }); res.json({ ok: true, stored: n });
  });
  ingest.get('/dt/stats', (req, res) => { const b = statsBuild(num(req.query.days)); res.json({ you: b.you, advisor: b.advisor, adherence: b.adherence, executionGapR: b.executionGapR, counts: b.counts, stages: stages().map(s => ({ id: s.id, stage: s.stage, plan: s.plan, rollingExpR: s.rollingExpR, killSwitch: s.killSwitch })) }); });

  // --- UI ---
  api.get('/dt/state', (req, res) => { const A = advisorState(); const st = settingsGet(); res.json({ ...A, equity: Math.round(equity(st)), equityStart: st.equityZar, sessions: sessions(), blackouts: blackouts(), openRiskPct: openExposure().reduce((a, x) => a + (x.risk_pct || 0), 0), armed: db.prepare("SELECT COUNT(*) c FROM dt_signals WHERE gate='ALERT' AND status='ARMED' AND user_action IS NULL").get().c, open: db.prepare('SELECT COUNT(*) c FROM dt_signals WHERE ' + openTakenSql).get().c, webhook: st.webhook, webhookSet: !!st.webhookUrl }); });
  api.get('/dt/signals', (req, res) => {
    const f = req.query.view || 'board'; let sql;
    if (f === 'board') sql = "SELECT * FROM dt_signals WHERE (gate='ALERT' AND status IN ('ARMED','ACTIVE','PARTIAL') AND COALESCE(user_action,'')!='skipped' AND closed_at IS NULL) OR (" + openTakenSql + ") ORDER BY created_at DESC";
    else if (f === 'all') sql = 'SELECT * FROM dt_signals ORDER BY created_at DESC LIMIT 300';
    else if (f === 'taken') sql = "SELECT * FROM dt_signals WHERE user_action='taken' ORDER BY COALESCE(closed_at,taken_at) DESC LIMIT 300";
    else sql = 'SELECT * FROM dt_signals WHERE gate=? ORDER BY created_at DESC LIMIT 300';
    res.json(db.prepare(sql).all(...(['board', 'all', 'taken'].includes(f) ? [] : [f.toUpperCase()])).map(row));
  });
  api.get('/dt/signals/:id', (req, res) => { const s = getSig(req.params.id); if (!s) return res.status(404).json({ error: 'Signal not found' }); const o = row(s); o.fills = db.prepare('SELECT * FROM dt_fills WHERE sig_id=? ORDER BY id').all(s.id); o.updates = db.prepare('SELECT at,status,action,rule,payload FROM dt_updates WHERE sig_id=? ORDER BY id').all(s.id).map(u => ({ ...u, payload: J(u.payload, {}) })); res.json(o); });
  const need = (v, m) => { if (num(v) == null || num(v) <= 0) throw new Error(m); return Number(v); };
  api.post('/dt/signals/:id/take', guard((req, res) => {
    const s = getSig(req.params.id); if (!s) throw new Error('Signal not found'); if (s.user_action) throw new Error('You already marked this signal as ' + s.user_action);
    const b = req.body || {}; const entry = need(b.fillPrice, 'Enter your fill price'); const size = need(b.size || s.size, 'Enter your position size'); const d = dirOf(s.direction);
    if (d * (entry - s.stop) <= 0) throw new Error('That fill is already through the stop'); const at = nowIso();
    db.prepare("UPDATE dt_signals SET user_action='taken', taken_at=?, act_entry=?, act_size=?, units_left=?, notes=COALESCE(?,notes) WHERE id=?").run(at, entry, size, size, b.notes || null, s.id);
    db.prepare("INSERT INTO dt_fills(sig_id,at,kind,price,size,r_part,pnl_zar,note) VALUES(?,?,'entry',?,?,0,0,'Opened')").run(s.id, at, entry, size);
    hook('signal.taken', { signal_id: s.signal_id, actual_entry: entry, actual_size: size, time: at }); refresh(); res.json({ ok: true });
  }));
  api.post('/dt/signals/:id/skip', guard((req, res) => { const s = getSig(req.params.id); if (!s) throw new Error('Signal not found'); if (s.user_action) throw new Error('Already marked ' + s.user_action); const reason = (req.body && req.body.reason) || ''; db.prepare("UPDATE dt_signals SET user_action='skipped', skip_reason=? WHERE id=?").run(reason, s.id); hook('signal.skipped', { signal_id: s.signal_id, reason }); refresh(); res.json({ ok: true }); }));
  function fill(s, kind, price, size, note) {
    const d = dirOf(s.direction), R = Math.abs(s.act_entry - s.stop); size = Math.min(size, s.units_left); const rAt = d * (price - s.act_entry) / R; const rPart = rAt * (size / s.act_size);
    const pnl = rPart * (s.risk_amount || 0) * (s.size ? s.act_size / s.size : 1);
    db.prepare('INSERT INTO dt_fills(sig_id,at,kind,price,size,r_part,pnl_zar,note) VALUES(?,?,?,?,?,?,?,?)').run(s.id, nowIso(), kind, price, size, rPart, pnl, note || '');
    const left = s.units_left - size; db.prepare('UPDATE dt_signals SET units_left=? WHERE id=?').run(left <= 1e-9 ? 0 : left, s.id); return { left, rAt };
  }
  api.post('/dt/signals/:id/partial', guard((req, res) => { const s = getSig(req.params.id); if (!s || s.user_action !== 'taken' || s.closed_at) throw new Error('That trade is not open'); const b = req.body || {}; const price = need(b.price, 'Enter the exit price'); const f = fill(s, 'partial', price, s.units_left * (num(b.fraction) || 0.5), b.note); if (f.left <= 1e-9) closeOut(s.id, b); refresh(); res.json({ ok: true }); }));
  function closeOut(id, b) {
    const s = getSig(id); const agg = db.prepare("SELECT SUM(r_part) r, SUM(pnl_zar) p, SUM(price*size)/SUM(size) px FROM dt_fills WHERE sig_id=? AND kind!='entry'").get(id); const at = nowIso();
    const hold = (Date.parse(at) - Date.parse(s.taken_at)) / 60000;
    db.prepare('UPDATE dt_signals SET closed_at=?, act_exit=?, r=?, pnl_zar=?, exit_reason=?, followed=?, errors=?, notes=TRIM(COALESCE(notes,\'\') || CASE WHEN ? IS NULL OR ?=\'\' THEN \'\' ELSE char(10) || ? END), units_left=0 WHERE id=?')
      .run(at, agg.px, agg.r || 0, agg.p || 0, b.reason || 'MANUAL', b.followed == null ? null : (b.followed ? 1 : 0), JSON.stringify(b.errors || []), b.lesson || null, b.lesson || null, b.lesson ? 'Lesson: ' + b.lesson : null, id);
    const f = getSig(id); hook('trade.closed', { signal_id: f.signal_id, actual_exit: f.act_exit, time: at, exit_reason: f.exit_reason, result_r: +(f.r || 0).toFixed(3), result_zar: Math.round(f.pnl_zar || 0), hold_minutes: Math.round(hold), followed: f.followed, errors: J(f.errors, []) });
    const A = advisorState(); if (A.state === 'LOCKED') addEvent('day', 'alert', 'Day trading locked for today', A.reasons.join(' '));
    return f;
  }
  api.post('/dt/signals/:id/close', guard((req, res) => { const s = getSig(req.params.id); if (!s || s.user_action !== 'taken' || s.closed_at) throw new Error('That trade is not open'); const b = req.body || {}; const price = need(b.price, 'Enter the exit price'); fill(s, 'exit', price, s.units_left, b.note); const f = closeOut(s.id, b); refresh(); res.json({ ok: true, r: f.r, pnl: f.pnl_zar }); }));
  api.patch('/dt/signals/:id', guard((req, res) => { const s = getSig(req.params.id); if (!s) throw new Error('Signal not found'); const b = req.body || {}; if (b.notes != null) db.prepare('UPDATE dt_signals SET notes=? WHERE id=?').run(String(b.notes), s.id); if (Array.isArray(b.errors)) db.prepare('UPDATE dt_signals SET errors=? WHERE id=?').run(JSON.stringify(b.errors), s.id); res.json({ ok: true }); }));
  api.delete('/dt/signals/:id', guard((req, res) => { const s = getSig(req.params.id); if (!s) throw new Error('Signal not found'); if (s.source === 'off_plan') db.prepare('DELETE FROM dt_signals WHERE id=?').run(s.id); else { db.prepare('DELETE FROM dt_fills WHERE sig_id=?').run(s.id); db.prepare("UPDATE dt_signals SET user_action=NULL, skip_reason=NULL, taken_at=NULL, act_entry=NULL, act_size=NULL, units_left=NULL, act_exit=NULL, closed_at=NULL, r=NULL, pnl_zar=NULL, exit_reason=NULL, followed=NULL, errors=NULL WHERE id=?").run(s.id); } refresh(); res.json({ ok: true }); }));
  api.post('/dt/offplan', guard((req, res) => {
    const b = req.body || {}; const dir = b.direction === 'short' ? 'short' : 'long'; const entry = need(b.entry, 'Entry is required'), stop = need(b.stop, 'Stop is required'), size = need(b.size, 'Size is required'), risk = need(b.riskZar, 'Enter the rand amount you risked');
    if (dirOf(dir) * (entry - stop) <= 0) throw new Error('The stop is on the wrong side of the entry'); const at = nowIso(); const inst = String(b.instrument || '').toUpperCase(); if (!inst) throw new Error('Instrument is required');
    const s = { signal_id: 'OFF-' + Date.now(), created_at: at, instrument: inst, strategy_id: 'OFF_PLAN', strategy_name: 'Off-plan trade', direction: dir, entry, stop, targets: [], size, risk_amount: risk, currency: 'ZAR', invalidation: [], rules: [], status: 'ACTIVE', narrative: b.notes || '' };
    const id = insertSignal(s, 'OFF_PLAN', ['OFF_PLAN'], b, 'off_plan'); db.prepare("UPDATE dt_signals SET user_action='taken', taken_at=?, act_entry=?, act_size=?, units_left=?, notes=? WHERE id=?").run(at, entry, size, size, b.notes || '', id);
    db.prepare("INSERT INTO dt_fills(sig_id,at,kind,price,size,r_part,pnl_zar,note) VALUES(?,?,'entry',?,?,0,0,'Opened')").run(id, at, entry, size);
    hook('trade.off_plan', { instrument: inst, direction: dir, size, entry, stop, risk_zar: risk, time: at }); refresh(); res.json({ ok: true, id });
  }));
  api.post('/dt/readiness', guard((req, res) => {
    const b = req.body || {}; const keys = ['calendar', 'notRecovering', 'atScreen']; const answers = Object.fromEntries(keys.map(k => [k, b[k] === true || b[k] === 'yes'])); const ok = keys.every(k => answers[k]);
    db.prepare('INSERT INTO dt_readiness(day,at,answers,ok) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET at=excluded.at, answers=excluded.answers, ok=excluded.ok').run(dayKey(), nowIso(), JSON.stringify(answers), ok ? 1 : 0);
    hook('readiness.submitted', { day: dayKey(), answers, ok }); refresh(); res.json({ ok: true, ready: ok });
  }));
  api.post('/dt/ack', guard((req, res) => { const ids = db.prepare("SELECT id FROM dt_state WHERE state IN ('LOCKED','PAUSED') AND acked_at IS NULL AND day < ?").all(dayKey()).map(x => x.id); const one = num(req.body && req.body.id); const list = one ? [one] : ids; list.forEach(i => db.prepare('UPDATE dt_state SET acked_at=? WHERE id=?').run(nowIso(), i)); list.forEach(i => hook('lock.acknowledged', { state_id: i })); refresh(); res.json({ ok: true, acknowledged: list.length }); }));
  api.get('/dt/decisions', (req, res) => {
    const since = new Date(Date.now() - 24 * 3600000).toISOString(); const rows = db.prepare('SELECT * FROM dt_decisions WHERE at >= ? ORDER BY at DESC LIMIT 2000').all(since);
    const latest = {}; rows.forEach(r => { if (!latest[r.instrument]) latest[r.instrument] = { instrument: r.instrument, at: r.at, regime: r.regime, reasons: J(r.reasons, []), rejected: (J(r.payload, {}).candidates_rejected || []) }; });
    const counts = {}; rows.forEach(r => J(r.reasons, []).forEach(c => counts[c] = (counts[c] || 0) + 1)); res.json({ latest: Object.values(latest), counts, n: rows.length });
  });
  api.get('/dt/stats', (req, res) => res.json(statsBuild(num(req.query.days))));
  api.get('/dt/stages', (req, res) => res.json(stages()));
  api.put('/dt/stages/:sid', guard((req, res) => { const id = req.params.sid; if (!CFG.strategies[id]) throw new Error('Unknown strategy'); const b = req.body || {}; const st = settingsGet(); if ('backtestE' in b) { st.backtest = st.backtest || {}; if (b.backtestE === '' || b.backtestE == null) delete st.backtest[id]; else { if (num(b.backtestE) == null) throw new Error('Backtest expectancy must be a number of R'); st.backtest[id] = num(b.backtestE); } if (!b.stage) { settingsSet(st); return res.json({ ok: true }); } } const stg = String(b.stage || '').toUpperCase(); if (!STAGES.includes(stg)) throw new Error('Unknown stage'); const was = st.strategies[id]; st.strategies[id] = stg; settingsSet(st); addEvent('day', 'info', id + ' moved from ' + was + ' to ' + stg, (req.body && req.body.note) || ''); refresh(); res.json({ ok: true }); }));
  api.get('/dt/rules', (req, res) => res.json({ config: CFG, strategies: settingsGet().strategies, stages: STAGES }));
  api.get('/dt/settings', (req, res) => { const st = settingsGet(); res.json({ equityZar: st.equityZar, webhookUrl: st.webhookUrl, tier2Enabled: st.tier2Enabled, webhook: st.webhook }); });
  api.put('/dt/settings', guard((req, res) => {
    const b = req.body || {}; const st = settingsGet();
    if (b.equityZar != null) { if (!(Number(b.equityZar) > 0)) throw new Error('Starting equity must be positive'); st.equityZar = Number(b.equityZar); }
    if (b.webhookUrl != null) { const u = String(b.webhookUrl).trim(); if (u && !/^https:\/\/[^\s]+$/i.test(u)) throw new Error('The n8n webhook URL must start with https://'); st.webhookUrl = u; }
    if (b.tier2Enabled != null) st.tier2Enabled = !!b.tier2Enabled; settingsSet(st); refresh(); res.json({ ok: true });
  }));
  api.post('/dt/settings/test-webhook', async (req, res) => { const r = await hook('test.ping', { message: 'Hello from Tally' }); res.json(r); });
  api.get('/dt/export.csv', (req, res) => {
    const rows = db.prepare('SELECT signal_id,created_at,source,instrument,strategy_id,strategy_stage,grade,score,regime,session,direction,gate,status,entry,stop,rr,risk_pct,risk_amount,size,user_action,skip_reason,taken_at,act_entry,act_size,act_exit,closed_at,r,pnl_zar,exit_reason,followed,errors,plan_r,plan_mfe,plan_mae,plan_exit_reason,volume_source,notes FROM dt_signals ORDER BY created_at').all();
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; const cols = rows[0] ? Object.keys(rows[0]) : ['signal_id'];
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=tally-day-trades.csv' }); res.send(cols.join(',') + '\n' + rows.map(r => cols.map(c => q(r[c])).join(',')).join('\n'));
  });
}
function summary() { const A = advisorState(); return { state: A.state, armed: db.prepare("SELECT COUNT(*) c FROM dt_signals WHERE gate='ALERT' AND status='ARMED' AND user_action IS NULL").get().c, open: db.prepare('SELECT COUNT(*) c FROM dt_signals WHERE ' + openTakenSql).get().c }; }

module.exports = { mount, summary, CFG, sessions, blackouts, advisorState, evaluate, statsBuild, stages, dayKey, zonedUtc };
