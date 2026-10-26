'use strict';
const { db, getSetting, pnlUsd } = require('./db'); const S = require('./stats');
const dayKey = (ms, off) => new Date(ms + off * 3600000).toISOString().slice(0, 10);
const bucket = s => s >= 80 ? '80+' : s >= 70 ? '70-79' : s >= 60 ? '60-69' : 'under 60';
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const closedRows = () => db.prepare("SELECT * FROM trades WHERE status='CLOSED' ORDER BY closed_at").all().map(t => ({ ...t, ts: Date.parse(t.closed_at), openTs: Date.parse(t.opened_at), pnl: t.pnl_usd }));
const curStop = t => (t.trail_stop && t.trail_stop > 0) ? t.trail_stop : t.stop;

function exposure() {
  const A = getSetting('account'); const open = db.prepare("SELECT * FROM trades WHERE status='OPEN'").all();
  const realized = db.prepare('SELECT COALESCE(SUM(pnl_usd),0) p FROM trades').get().p; const equity = A.startEquity + realized;
  let risk = 0, usdNet = 0; open.forEach(t => { risk += Math.max(0, -pnlUsd(t.pair, t.direction, t.entry, curStop(t), t.units_left)); const dir = t.direction === 'LONG' ? 1 : -1; usdNet += (t.pair.startsWith('USD') ? dir : -dir); });
  return { equity, openRiskUsd: risk, openRiskPct: equity > 0 ? risk / equity * 100 : 0, usdNet, openCount: open.length };
}
// Personal circuit breakers: the app tells you to stand aside when any limit trips.
function breaker() {
  const L = getSetting('limits'), A = getSetting('account'), off = A.tzOffset, items = closedRows(), ex = exposure();
  const d = new Date(Date.now() + off * 3600000); const dow = (d.getUTCDay() + 6) % 7; const weekStart = new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10), today = d.toISOString().slice(0, 10);
  const dayR = items.filter(t => dayKey(t.ts, off) === today).reduce((s, t) => s + t.r, 0);
  const weekR = items.filter(t => dayKey(t.ts, off) >= weekStart).reduce((s, t) => s + t.r, 0);
  const st = S.stats(items); const lossStreak = st.streak.type === 'L' ? st.streak.len : 0; const reasons = [];
  if (dayR <= -L.maxDailyLossR) reasons.push('Daily loss limit reached (' + dayR.toFixed(1) + 'R). Done for today.');
  if (weekR <= -L.maxWeeklyLossR) reasons.push('Weekly loss limit reached (' + weekR.toFixed(1) + 'R). Stand aside until Monday.');
  if (lossStreak >= L.maxLossStreak) reasons.push(lossStreak + ' losses in a row. Review the journal before the next entry.');
  if (ex.openRiskPct > L.maxOpenRiskPct) reasons.push('Open risk is ' + ex.openRiskPct.toFixed(1) + '% of equity, above your ' + L.maxOpenRiskPct + '% cap.');
  return { tripped: reasons.length > 0, reasons, dayR, weekR, lossStreak, ...ex };
}

// Shadow scorecard: every signal replayed exactly as the plan said, whether or not you took it.
function scorecard() {
  const rows = db.prepare('SELECT s.*, t.r AS real_r FROM signals s LEFT JOIN trades t ON t.id = s.trade_id WHERE s.shadow_r IS NOT NULL').all();
  const grp = f => { const a = rows.filter(f); const s = S.stats(a.map(x => ({ r: x.shadow_r, pnl: 0 }))); return { n: s.n, winRate: s.winRate, expR: s.expR, sumR: s.sumR }; };
  const both = rows.filter(x => x.real_r != null && x.status === 'taken');
  const gap = both.length ? both.reduce((s, x) => s + (x.real_r - x.shadow_r), 0) / both.length : null;
  const pending = db.prepare('SELECT COUNT(*) c FROM signals WHERE shadow_r IS NULL AND shadow_reason IS NULL').get().c;
  return { all: grp(() => true), taken: grp(x => x.status === 'taken'), skipped: grp(x => x.status === 'skipped'), rejected: grp(x => x.status === 'rejected'), executionGapR: gap, pairs: both.length, pending };
}

function build(rangeDays) {
  const A = getSetting('account'), off = A.tzOffset; let items = closedRows();
  if (rangeDays) { const cut = Date.now() - rangeDays * 86400000; items = items.filter(t => t.ts >= cut); }
  const all = S.stats(items); const partialSet = new Set(db.prepare("SELECT DISTINCT trade_id FROM fills WHERE kind='partial'").all().map(f => f.trade_id));
  let eq = A.startEquity, cum = 0; const curve = [{ t: items.length ? items[0].openTs : Date.now(), date: items.length ? dayKey(items[0].openTs, off) : '', equity: eq, cumR: 0 }].concat(items.map(t => { eq += t.pnl; cum += t.r; return { t: t.ts, date: dayKey(t.ts, off), equity: Math.round(eq * 100) / 100, cumR: Math.round(cum * 100) / 100 }; }));
  const daily = {}; items.forEach(t => { const k = dayKey(t.ts, off); const d = daily[k] = daily[k] || { pnl: 0, r: 0, n: 0 }; d.pnl += t.pnl; d.r += t.r; d.n++; });
  const winners = items.filter(t => t.r > S.WIN && t.mfe_r > 0);
  const t1Hit = items.filter(t => t.t1_r && t.mfe_r >= t.t1_r).length, t2Hit = items.filter(t => t.t2_r && t.mfe_r >= t.t2_r).length;
  const reasons = {}; items.forEach(t => { const k = t.exit_reason || 'MANUAL'; reasons[k] = (reasons[k] || 0) + 1; });
  const fol = items.filter(t => t.followed_plan === 1), nofol = items.filter(t => t.followed_plan === 0);
  const wins = items.filter(t => t.r > S.WIN), loss = items.filter(t => t.r < -S.WIN); const avgDays = a => a.length ? a.reduce((s, t) => s + (t.ts - t.openTs) / 86400000, 0) / a.length : 0;
  return {
    stats: all, curve, daily, hist: S.histogram(items.map(t => t.r)), startEquity: A.startEquity,
    by: { pair: S.groupStats(items, t => t.pair), strategy: S.groupStats(items, t => t.strategy), score: S.groupStats(items, t => bucket(t.score || 0)).sort((a, b) => a.key < b.key ? -1 : 1), regime: S.groupStats(items, t => t.regime), weekday: S.groupStats(items, t => WD[(new Date(t.openTs + off * 3600000).getUTCDay() + 6) % 7]).sort((a, b) => WD.indexOf(a.key) - WD.indexOf(b.key)), verdict: S.groupStats(items, t => t.ai_verdict), direction: S.groupStats(items, t => t.direction) },
    profit: { n: items.length, partialPct: items.length ? items.filter(t => partialSet.has(t.id)).length / items.length : 0, t1Pct: items.length ? t1Hit / items.length : 0, t2Pct: items.length ? t2Hit / items.length : 0, capture: winners.length ? winners.reduce((s, t) => s + Math.min(1, t.r / t.mfe_r), 0) / winners.length : null, leftR: items.length ? items.reduce((s, t) => s + Math.max(0, t.mfe_r - t.r), 0) / items.length : 0, reasons, avgDaysWin: avgDays(wins), avgDaysLoss: avgDays(loss) },
    discipline: { rated: fol.length + nofol.length, followedPct: (fol.length + nofol.length) ? fol.length / (fol.length + nofol.length) : null, followedExpR: S.stats(fol).expR, brokeExpR: S.stats(nofol).expR, brokeN: nofol.length },
    scorecard: scorecard(), items
  };
}

// Plain-language findings, each gated on a minimum sample so they do not overclaim.
function insights(b) {
  const out = []; const s = b.stats, add = (tone, text) => out.push({ tone, text });
  if (s.n === 0) { add('info', 'No closed trades yet. Take a signal from the Desk and close it when it is done: every stat here fills in from that.'); return out; }
  if (s.n < 30) add('info', 'Only ' + s.n + ' closed trade' + (s.n === 1 ? '' : 's') + '. Treat every percentage here as a hint, not a verdict, until you have 30 or more.');
  const hi = b.by.score.filter(x => x.key === '80+' || x.key === '70-79'), lo = b.by.score.filter(x => x.key === '60-69' || x.key === 'under 60');
  const sum = a => a.reduce((t, x) => ({ n: t.n + x.n, r: t.r + x.sumR }), { n: 0, r: 0 }); const H = sum(hi), Lw = sum(lo);
  if (H.n >= 5 && Lw.n >= 5) { const he = H.r / H.n, le = Lw.r / Lw.n; add(he > le ? 'good' : 'warn', he > le ? 'Higher advisor scores are paying: ' + he.toFixed(2) + 'R per trade at 70+ against ' + le.toFixed(2) + 'R below. The score is earning its keep.' : 'Scores of 70+ are not beating the lower ones (' + he.toFixed(2) + 'R vs ' + le.toFixed(2) + 'R). Check the Lab before trusting the score alone.'); }
  if (b.profit.capture != null && b.profit.n >= 5) add(b.profit.capture < 0.5 ? 'warn' : 'good', 'Your winners keep about ' + Math.round(b.profit.capture * 100) + '% of the best price they reached. ' + (b.profit.capture < 0.5 ? 'You are leaving a lot behind: test a later first partial or a wider trail in the Lab.' : 'Profit-taking looks healthy.'));
  if (b.discipline.rated >= 5 && b.discipline.brokeN >= 2) add(b.discipline.followedExpR >= b.discipline.brokeExpR ? 'good' : 'info', 'Trades where you followed the plan averaged ' + b.discipline.followedExpR.toFixed(2) + 'R. The ' + b.discipline.brokeN + ' where you did not averaged ' + b.discipline.brokeExpR.toFixed(2) + 'R.');
  const sc = b.scorecard; if (sc.taken.n >= 5 && sc.skipped.n >= 5) add(sc.skipped.expR > sc.taken.expR ? 'warn' : 'good', 'Signals you skipped would have made ' + sc.skipped.expR.toFixed(2) + 'R each; the ones you took made ' + sc.taken.expR.toFixed(2) + 'R on paper. ' + (sc.skipped.expR > sc.taken.expR ? 'Your filter may be costing you.' : 'Your filter is adding value.'));
  if (sc.rejected.n >= 5) add('info', 'The AI risk officer rejected ' + sc.rejected.n + ' signals that would have averaged ' + sc.rejected.expR.toFixed(2) + 'R. ' + (sc.rejected.expR > 0.2 ? 'It may be too cautious.' : 'Rejecting them looks right.'));
  if (sc.executionGapR != null && sc.pairs >= 5) add(sc.executionGapR < -0.2 ? 'warn' : 'info', 'Execution gap: your fills and exits land ' + sc.executionGapR.toFixed(2) + 'R per trade away from the advisor\'s plan.');
  const wd = b.by.weekday.filter(x => x.n >= 5).sort((a, c) => c.expR - a.expR); if (wd.length >= 3) add('info', 'Best entry day so far: ' + wd[0].key + ' (' + wd[0].expR.toFixed(2) + 'R). Weakest: ' + wd[wd.length - 1].key + ' (' + wd[wd.length - 1].expR.toFixed(2) + 'R).');
  if (s.streak.type === 'L' && s.streak.len >= 2) add('warn', 'You are on ' + s.streak.len + ' losses in a row. Normal variance, but keep size at plan.');
  if (s.expR > 0 && s.n >= 30) add('good', 'Positive expectancy over ' + s.n + ' trades: ' + s.expR.toFixed(2) + 'R each at a ' + Math.round(s.winRate * 100) + '% win rate.');
  return out;
}
module.exports = { build, insights, breaker, exposure, scorecard, closedRows, dayKey, curStop };
