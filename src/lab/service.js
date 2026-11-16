'use strict';
// Strategy Lab inside Tally: runs, the approval queue, the strategy in use, and the signals it hands to the advisor.
const path = require('path'); const { Worker } = require('worker_threads');
const { db, getSetting, setSetting, nowIso } = require('../db'); const D = require('./data'), R = require('./recipe');
const A = require('../analytics');

let job = null;   // { startedAt, p, msg, by }
const J = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const stratRow = r => r && ({ id: r.id, key: r.key, name: r.name, status: r.status, recipe: J(r.recipe), report: J(r.report), health: J(r.health), createdAt: r.created_at, decidedAt: r.decided_at, retiredAt: r.retired_at, runId: r.run_id, note: r.note });
const active = () => stratRow(db.prepare("SELECT * FROM lab_strategies WHERE status IN ('live','trial') ORDER BY decided_at DESC LIMIT 1").get());
const labSet = () => Object.assign({ pauseLegacy: false }, getSetting('lab') || {});
const work = data => new Promise((resolve, reject) => { const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: data }); w.on('message', m => { if (m.type === 'progress') { if (job && data.job === 'run') { job.p = m.p; job.msg = m.msg; } } else if (m.type === 'done') resolve(m.result); else reject(new Error(m.error)); }); w.on('error', reject); w.on('exit', c => { if (c !== 0) reject(new Error('The lab worker stopped unexpectedly')); }); });

function mount({ ingest, api, addEvent, push, guard, runner }) {
  const run = runner || work;   // tests swap in a fake
  function start(by, size) {
    if (job) return { started: false, running: true }; const act = active();
    job = { startedAt: nowIso(), p: 0, msg: 'Starting', by }; push('refresh', { what: 'lab' });
    const opts = { size: size || 'standard', seed: 1 + db.prepare('SELECT COUNT(*) c FROM lab_runs').get().c, macro: getSetting('macro'), active: act ? { recipe: act.recipe, sinceDay: D.dayOfIso(String(act.decidedAt).slice(0, 10)) } : null };
    run({ job: 'run', opts }).then(res => finish(res, by, act)).catch(e => { db.prepare('INSERT INTO lab_runs(at,by,status,summary,result) VALUES(?,?,?,?,?)').run(nowIso(), by, 'error', e.message, '{}'); addEvent('lab', 'alert', 'Strategy Lab run failed', e.message); }).finally(() => { job = null; push('refresh', { what: 'lab' }); });
    return { started: true };
  }
  function finish(res, by, act) {
    const p = res.pick; const verdict = !p ? 'none' : (p.sameAsActive ? 'same' : (p.passed ? 'proposed' : 'failed'));
    const summary = !p ? 'No recipe met your win-rate and payoff rules even on past data.' : (p.sameAsActive ? 'The strategy in use is still the best the lab can find.' : (p.passed ? p.name + ' passed every check and is waiting for your approval.' : 'Best candidate (' + p.name + ') failed ' + p.failed.length + ' of ' + p.checks.length + ' checks. Nothing was proposed.'));
    const runId = db.prepare('INSERT INTO lab_runs(at,by,status,summary,result) VALUES(?,?,?,?,?)').run(nowIso(), by, verdict, summary, JSON.stringify(res)).lastInsertRowid;
    db.prepare("DELETE FROM lab_runs WHERE id NOT IN (SELECT id FROM lab_runs ORDER BY id DESC LIMIT 12)").run();
    if (p && !p.sameAsActive) {
      db.prepare("UPDATE lab_strategies SET status='superseded' WHERE status IN ('proposed','failed')").run();   // only the newest candidate is on the table
      db.prepare('INSERT INTO lab_strategies(key,name,status,recipe,report,created_at,run_id) VALUES(?,?,?,?,?,?,?)').run(p.key, p.name, p.passed ? 'proposed' : 'failed', JSON.stringify(p.recipe), JSON.stringify(p), nowIso(), runId);
      if (p.passed) addEvent('lab', 'action', 'A new strategy is waiting for your approval', p.name + ': ' + (p.all.winRate * 100).toFixed(0) + '% wins, ' + p.all.rPerYear + 'R a year in testing. Open the Strategy Lab to review it.');
    }
    if (act && res.activeHealth) {
      db.prepare('UPDATE lab_strategies SET health=? WHERE id=?').run(JSON.stringify(res.activeHealth), act.id);
      if (res.activeHealth.state === 'failing') addEvent('lab', 'alert', 'Your strategy has stopped working', act.name + ': ' + res.activeHealth.why + ' Consider retiring it in the Strategy Lab.');
      else if (res.activeHealth.state === 'watch') addEvent('lab', 'action', 'Your strategy needs watching', act.name + ': ' + res.activeHealth.why);
    }
    if (!(p && p.passed)) addEvent('lab', 'info', 'Strategy Lab re-test finished', summary);
  }
  const view = () => {
    const last = db.prepare("SELECT * FROM lab_runs WHERE status!='error' ORDER BY id DESC LIMIT 1").get(), err = db.prepare('SELECT * FROM lab_runs ORDER BY id DESC LIMIT 1').get();
    const live = scorecard();
    return { running: job, settings: labSet(), active: active(), liveScore: live, candidate: stratRow(db.prepare("SELECT * FROM lab_strategies WHERE status IN ('proposed','failed') ORDER BY id DESC LIMIT 1").get()),
      last: last ? { id: last.id, at: last.at, by: last.by, status: last.status, summary: last.summary, result: J(last.result) } : null, lastError: err && err.status === 'error' ? { at: err.at, message: err.summary } : null,
      runs: db.prepare('SELECT id, at, by, status, summary FROM lab_runs ORDER BY id DESC LIMIT 12').all(), past: db.prepare("SELECT * FROM lab_strategies WHERE status IN ('retired') ORDER BY id DESC LIMIT 6").all().map(stratRow) };
  };
  // how the signals of the strategy in use have really done since approval (taken or not), from Tally's own records
  function scorecard() { const a = active(); if (!a) return null; const rows = db.prepare("SELECT shadow_r r FROM signals WHERE strategy LIKE ? AND shadow_r IS NOT NULL").all('%#' + a.id + ']%'); const n = rows.length, sum = rows.reduce((s, x) => s + x.r, 0); return { n, wins: rows.filter(x => x.r > 0.05).length, sumR: Math.round(sum * 100) / 100, pending: db.prepare("SELECT COUNT(*) c FROM signals WHERE strategy LIKE ? AND shadow_r IS NULL AND shadow_reason IS NULL").get('%#' + a.id + ']%').c }; }

  api.get('/strategy-lab', (req, res) => res.json(view()));
  api.post('/strategy-lab/run', guard((req, res) => { const r = start('you', (req.body || {}).size); if (!r.started) throw new Error('A run is already in progress'); res.json(r); }));
  api.put('/strategy-lab/settings', guard((req, res) => { setSetting('lab', { pauseLegacy: !!(req.body || {}).pauseLegacy }); push('refresh', { what: 'lab' }); res.json({ ok: true }); }));
  api.post('/strategy-lab/strategies/:id/approve', guard((req, res) => {
    const s = stratRow(db.prepare('SELECT * FROM lab_strategies WHERE id=?').get(req.params.id)); if (!s) throw new Error('Strategy not found'); const mode = (req.body || {}).mode === 'trial' ? 'trial' : 'live';
    if (!['proposed', 'failed', 'trial'].includes(s.status)) throw new Error('This strategy is no longer on the table. Run the lab again.');
    if (mode === 'live' && !(s.report && s.report.passed)) throw new Error('Only a strategy that passed every check can be set live. You can paper-trade this one instead.');
    db.prepare("UPDATE lab_strategies SET status='retired', retired_at=?, note='Replaced' WHERE status IN ('live','trial') AND id!=?").run(nowIso(), s.id);
    db.prepare('UPDATE lab_strategies SET status=?, decided_at=? WHERE id=?').run(mode, nowIso(), s.id);
    addEvent('lab', 'info', mode === 'live' ? 'You approved a new strategy' : 'Paper trial started', s.name + (mode === 'live' ? ' now drives the forex advisor from its next run.' : ' will post paper-only signals next to the current ones.')); push('refresh', { what: 'lab' }); res.json({ ok: true });
  }));
  api.post('/strategy-lab/strategies/:id/reject', guard((req, res) => { db.prepare("UPDATE lab_strategies SET status='rejected', decided_at=?, note=? WHERE id=? AND status IN ('proposed','failed')").run(nowIso(), (req.body || {}).reason || '', req.params.id); push('refresh', { what: 'lab' }); res.json({ ok: true }); }));
  api.post('/strategy-lab/strategies/:id/retire', guard((req, res) => { const n = db.prepare("UPDATE lab_strategies SET status='retired', retired_at=?, note=? WHERE id=? AND status IN ('live','trial')").run(nowIso(), (req.body || {}).reason || 'Retired by you', req.params.id).changes; if (!n) throw new Error('That strategy is not in use'); addEvent('lab', 'info', 'Strategy retired', 'The forex advisor is back on its original rules.'); push('refresh', { what: 'lab' }); res.json({ ok: true }); }));

  // ---- called by n8n ----
  ingest.post('/lab/run', (req, res) => res.json(start('schedule', (req.body || {}).size)));
  ingest.get('/lab/status', (req, res) => { const v = view(); res.json({ running: !!v.running, active: v.active ? { id: v.active.id, name: v.active.name, status: v.active.status, health: v.active.health && v.active.health.state } : null, pauseLegacy: v.settings.pauseLegacy, lastRun: v.last ? { at: v.last.at, status: v.last.status, summary: v.last.summary } : null }); });
  // Today's signals from the strategy in use. mode: 'legacy' (advisor uses its own rules), 'live' (lab replaces them) or 'trial' (lab signals are added as paper-only).
  let sigCache = null;
  ingest.get('/lab/signals', async (req, res) => {
    const a = active(), set = labSet(); if (!a) return res.json({ mode: 'legacy', pauseLegacy: set.pauseLegacy, items: [] });
    try {
      if (!sigCache || sigCache.id !== a.id || Date.now() - sigCache.at > 20 * 60000) {
        const acct = getSetting('account'); const label = (a.status === 'trial' ? 'PAPER TRIAL · ' : '') + a.name + ' [Lab #' + a.id + ']';
        const out = await run({ job: 'signals', strategy: { recipe: a.recipe, label, winRate: a.report && a.report.all ? a.report.all.winRate : 0.5 }, ctx: { equity: A.exposure().equity, riskPct: acct.riskPct, open: db.prepare("SELECT pair, direction FROM trades WHERE status='OPEN'").all() } });
        sigCache = { id: a.id, at: Date.now(), out };
      }
      const out = sigCache.out; const paper = a.status === 'trial';
      const needsRates = a.recipe.fund !== 'none' || a.recipe.macro !== 'none'; if (needsRates && out.rates < 20) throw new Error('Interest-rate history could not be downloaded, and this strategy needs it');
      res.json({ mode: a.status, pauseLegacy: set.pauseLegacy, strategy: { id: a.id, name: a.name }, asOf: out.asOf, warnings: out.warnings, items: out.items.map(i => Object.assign({}, i, { paper, signalId: i.decision === 'ENTER' ? 'LAB' + a.id + '-' + i.pair + '-' + out.asOf : undefined })) });
    } catch (e) { addEvent('lab', 'alert', 'The approved strategy could not produce signals today', e.message); res.status(502).json({ error: e.message, mode: 'error', pauseLegacy: set.pauseLegacy, items: [] }); }
  });
  return { start, view, active };
}
module.exports = { mount, active };
