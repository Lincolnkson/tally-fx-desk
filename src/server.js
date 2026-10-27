'use strict';
const express = require('express'); const crypto = require('crypto'); const path = require('path');
const { db, getSetting, setSetting, nowIso, pnlUsd } = require('./db'); const A = require('./analytics');
const { runBacktest, simulateTrade, PAIRS } = require('./sim'); const { wilder, trueRange } = require('./engine');
// Offline demo mode swaps the live price feed for deterministic synthetic candles.
const candles = process.env.TALLY_FAKE_PRICES ? require('../test/synth').fakeCandles : require('./yahoo').candles;

const PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const PASSWORD = process.env.APP_PASSWORD || (PROD ? null : 'dev'); const SECRET = process.env.SESSION_SECRET || (PROD ? null : 'dev-secret');
const API_KEY = process.env.INGEST_API_KEY || (PROD ? null : 'dev-key');
const app = express(); app.set('trust proxy', 1); app.disable('x-powered-by'); app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }); next(); });
app.get('/health', (q, r) => r.json({ ok: true, at: nowIso() }));

// ---------- auth: one password, signed cookie; n8n uses an API key ----------
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(p => [p[0], decodeURIComponent(p.slice(1).join('='))]));
const authed = req => { const c = cookie(req).tally; if (!c || !SECRET) return false; const [exp, mac] = c.split('.'); return Number(exp) > Date.now() && !!mac && safeEq(mac, sign(exp)); };
const tries = new Map();
app.post('/api/login', (req, res) => {
  if (!PASSWORD || !SECRET) return res.status(503).json({ error: 'The server is missing APP_PASSWORD or SESSION_SECRET.' });
  const ip = req.ip, t = (tries.get(ip) || []).filter(x => Date.now() - x < 900000); if (t.length >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!safeEq((req.body && req.body.password) || '', PASSWORD)) { t.push(Date.now()); tries.set(ip, t); return res.status(401).json({ error: 'Wrong password.' }); }
  const exp = String(Date.now() + 30 * 86400000);
  res.setHeader('Set-Cookie', 'tally=' + exp + '.' + sign(exp) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + (req.secure ? '; Secure' : '')); res.json({ ok: true });
});
app.post('/api/logout', (q, res) => { res.setHeader('Set-Cookie', 'tally=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ authed: authed(req), configured: !!(PASSWORD && SECRET) }));
const ingestAuth = (req, res, next) => { if (!API_KEY) return res.status(503).json({ error: 'INGEST_API_KEY not set' }); if (!safeEq(req.headers['x-api-key'] || req.headers['x-advisor-key'] || '', API_KEY)) return res.status(401).json({ error: 'Bad API key' }); next(); };
const uiAuth = (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'Not signed in' });

// ---------- live updates (server-sent events) ----------
const clients = new Set();
const push = (type, data) => clients.forEach(c => c.write('event: ' + type + '\ndata: ' + JSON.stringify(data || {}) + '\n\n'));
setInterval(() => clients.forEach(c => c.write(': ping\n\n')), 25000).unref();
app.get('/api/stream', uiAuth, (req, res) => { res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); res.write('retry: 4000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); });
function addEvent(type, severity, title, body, tradeId, signalId) { const id = db.prepare('INSERT INTO events(at,type,severity,title,body,trade_id,signal_id) VALUES(?,?,?,?,?,?,?)').run(nowIso(), type, severity, title, body || '', tradeId || null, signalId || null).lastInsertRowid; push('event', { id, type, severity, title }); return id; }

// ---------- ingest: called by the n8n workflows ----------
const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const ingest = express.Router(); ingest.use(ingestAuth); app.use('/api/ingest', ingest);
ingest.get('/macro', (req, res) => { const m = getSetting('macro'), a = getSetting('account'); res.json({ settings: { accountUsd: A.exposure().equity, riskPct: a.riskPct, minScore: m.settings.minScore, minRR: m.settings.minRR, eventBlockHours: m.settings.eventBlockHours }, rates: m.rates, stance: m.stance, cb: m.cb, riskCcy: m.riskCcy, standAside: A.breaker().tripped }); });
ingest.get('/open-trades', (req, res) => res.json(db.prepare("SELECT id, pair, ticker, direction, entry, stop, trail_stop AS trailStop, t1 AS target1, t2 AS target2, last_action AS lastAction, opened_at AS signalDate, units_left AS units FROM trades WHERE status='OPEN'").all()));
ingest.post('/brief', (req, res) => {
  const b = req.body || {}; const pairs = Array.isArray(b.pairs) ? b.pairs : []; const c = k => pairs.filter(p => p.decision === k).length;
  db.prepare('INSERT INTO briefs(at,regime,vix,payload) VALUES(?,?,?,?)').run(b.runAt || nowIso(), b.regime || null, num(b.vix), JSON.stringify(pairs));
  addEvent('brief', 'info', 'Daily brief: ' + c('ENTER') + ' enter, ' + c('WATCH') + ' watch, ' + c('WAIT') + ' wait', 'Market mood ' + String(b.regime || 'unknown').replace('_', '-').toLowerCase() + (b.vix != null ? ', VIX ' + Number(b.vix).toFixed(1) : ''));
  push('refresh', { what: 'brief' }); res.json({ ok: true });
});
ingest.post('/signal', (req, res) => {
  const s = req.body || {}; if (!s.pair || !s.direction || num(s.entry) == null || num(s.stop) == null) return res.status(400).json({ error: 'pair, direction, entry and stop are required' });
  const sid = s.signalId || (s.pair + '-' + String(s.signalDate || nowIso()).slice(0, 10)); const ex = db.prepare('SELECT id FROM signals WHERE signal_id=?').get(sid); if (ex) return res.json({ ok: true, duplicate: true, id: ex.id });
  const atr = num(s.atr) || 0, price = num(s.price) != null ? num(s.price) : num(s.entry); const entryType = s.entryType || (Math.abs(num(s.entry) - price) < 0.15 * (atr || 1e-9) ? 'market' : 'stop'); const rejected = s.aiVerdict === 'REJECT';
  const vals = [sid, s.signalDate || nowIso(), s.pair, s.ticker || s.pair + '=X', s.direction, s.strategy, num(s.score), s.breakdown, num(s.entry), num(s.stop), num(s.target1), num(s.target2), num(s.rr), atr, price, entryType, num(s.units), num(s.riskUsd), s.aiVerdict, num(s.aiConfidence), num(s.sizeMultiplier), s.thesis, s.keyRisk, s.invalidation, s.regime, num(s.vix), JSON.stringify(s.vetoes || []), rejected ? 'rejected' : 'new'];
  const id = db.prepare('INSERT INTO signals(signal_id,created_at,pair,ticker,direction,strategy,score,breakdown,entry,stop,t1,t2,rr,atr,price,entry_type,units,risk_usd,ai_verdict,ai_conf,size_mult,thesis,key_risk,invalidation,regime,vix,vetoes,status) VALUES(' + vals.map(() => '?').join(',') + ')').run(...vals).lastInsertRowid;
  addEvent('signal', rejected ? 'info' : 'action', s.pair + ' ' + s.direction + ' signal, score ' + s.score + (rejected ? ' (AI rejected)' : ''), s.thesis || '', null, id); push('refresh', { what: 'signals' }); res.json({ ok: true, id });
});
ingest.post('/guardian', (req, res) => {
  const list = Array.isArray(req.body.updates) ? req.body.updates : [req.body]; let n = 0;
  list.forEach(u => {
    const t = db.prepare('SELECT * FROM trades WHERE id=? AND status=?').get(u.rowId || u.tradeId, 'OPEN'); if (!t) return; n++;
    const dir = t.direction === 'LONG' ? 1 : -1; let trail = t.trail_stop; const ns = num(u.newStop);
    if (ns != null && ns > 0 && (!trail || (dir === 1 ? ns > trail : ns < trail)) && (dir === 1 ? ns >= t.stop : ns <= t.stop)) trail = ns; // stops only ever tighten
    const r = num(u.rMult); const exit = /^EXIT/.test(u.action || ''); const advice = exit || u.action === 'TAKE_PARTIAL' || u.action === 'WARN_NEAR_STOP' ? u.action : null;
    db.prepare("UPDATE trades SET trail_stop=?, last_price=COALESCE(?,last_price), last_r=COALESCE(?,last_r), mfe_r=MAX(mfe_r,COALESCE(?,mfe_r)), mae_r=MIN(mae_r,COALESCE(?,mae_r)), checked_at=?, last_action=COALESCE(NULLIF(?,''),last_action), advice=? WHERE id=?")
      .run(trail, num(u.price), r, r, r, nowIso(), u.lastAction || '', advice, t.id);
    if (u.notify && u.action && u.action !== 'HOLD') { const dup = db.prepare('SELECT 1 FROM events WHERE trade_id=? AND title LIKE ? AND at > ?').get(t.id, '%' + u.action.replace(/_/g, ' ').toLowerCase() + '%', new Date(Date.now() - 20 * 3600000).toISOString()); if (!dup) addEvent('trade', exit || u.action === 'WARN_NEAR_STOP' ? 'alert' : 'action', t.pair + ' ' + t.direction + ': ' + u.action.replace(/_/g, ' ').toLowerCase(), u.message || '', t.id); }
  });
  push('refresh', { what: 'trades' }); res.json({ ok: true, updated: n });
});

// ---------- UI api ----------
const api = express.Router(); api.use(uiAuth); app.use('/api', api);
const parse = r => { const o = { ...r }; ['vetoes', 'checklist'].forEach(k => { if (o[k]) try { o[k] = JSON.parse(o[k]); } catch (e) { } }); return o; };
const need = (v, m) => { if (num(v) == null || num(v) <= 0) throw new Error(m); return Number(v); };
const guard = f => (req, res) => { try { f(req, res); } catch (e) { res.status(400).json({ error: e.message }); } };
const DT = require('./daytrade'); DT.mount({ ingest, api, addEvent, push, guard }); // day trading desk: /api/ingest/dt/* and /api/dt/*

api.get('/state', (req, res) => {
  const brief = db.prepare('SELECT * FROM briefs ORDER BY id DESC LIMIT 1').get();
  res.json({ unread: db.prepare('SELECT COUNT(*) c FROM events WHERE read=0').get().c, newSignals: db.prepare("SELECT COUNT(*) c FROM signals WHERE status='new'").get().c, openTrades: db.prepare("SELECT COUNT(*) c FROM trades WHERE status='OPEN'").get().c, breaker: A.breaker(), day: DT.summary(), brief: brief ? { at: brief.at, regime: brief.regime, vix: brief.vix, pairs: JSON.parse(brief.payload) } : null, account: getSetting('account'), macroUpdatedAt: getSetting('macro').updatedAt });
});
api.get('/signals', (req, res) => { const st = req.query.status; const f = st && st !== 'all'; res.json(db.prepare('SELECT * FROM signals ' + (f ? 'WHERE status=? ' : '') + 'ORDER BY created_at DESC LIMIT 200').all(...(f ? [st] : [])).map(parse)); });
api.post('/signals/:id/skip', (req, res) => { db.prepare("UPDATE signals SET status='skipped', skip_reason=? WHERE id=? AND status='new'").run((req.body && req.body.reason) || '', req.params.id); push('refresh', {}); res.json({ ok: true }); });
function openTrade(o) {
  const dir = o.direction === 'LONG' ? 1 : -1; const R = Math.abs(o.entry - o.stop); if (!(R > 0)) throw new Error('Entry and stop must differ');
  if (dir === 1 ? o.stop >= o.entry : o.stop <= o.entry) throw new Error('The stop is on the wrong side of the entry for a ' + o.direction.toLowerCase());
  const id = db.prepare('INSERT INTO trades(signal_id,pair,ticker,direction,strategy,score,regime,ai_verdict,opened_at,entry,stop,t1,t2,t1_r,t2_r,units,units_left,notes,tags,checklist) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(o.signal_id || null, o.pair, o.ticker || o.pair + '=X', o.direction, o.strategy || 'Manual', o.score || null, o.regime || null, o.ai_verdict || null, o.opened_at || nowIso(), o.entry, o.stop, o.t1 || null, o.t2 || null, o.t1 ? dir * (o.t1 - o.entry) / R : null, o.t2 ? dir * (o.t2 - o.entry) / R : null, o.units, o.units, o.notes || '', o.tags || '', JSON.stringify(o.checklist || {})).lastInsertRowid;
  db.prepare("INSERT INTO fills(trade_id,at,kind,price,units,pnl_usd,r_part,note) VALUES(?,?,'entry',?,?,0,0,'Opened')").run(id, o.opened_at || nowIso(), o.entry, o.units); return id;
}
api.post('/signals/:id/take', guard((req, res) => {
  const s = db.prepare('SELECT * FROM signals WHERE id=?').get(req.params.id); if (!s) throw new Error('Signal not found'); if (s.status === 'taken') throw new Error('You already logged this signal');
  const b = req.body || {}; const id = openTrade({ signal_id: s.id, pair: s.pair, ticker: s.ticker, direction: s.direction, strategy: s.strategy, score: s.score, regime: s.regime, ai_verdict: s.ai_verdict, entry: need(b.fillPrice, 'Enter your fill price'), stop: need(b.stop || s.stop, 'A stop is required'), t1: s.t1, t2: s.t2, units: need(b.units || s.units, 'Enter the position size in units'), notes: b.notes, checklist: b.checklist });
  db.prepare("UPDATE signals SET status='taken', trade_id=? WHERE id=?").run(id, s.id); push('refresh', {}); res.json({ ok: true, tradeId: id });
}));
api.post('/trades', guard((req, res) => { const b = req.body || {}; if (!PAIRS[b.pair]) throw new Error('Unknown pair'); const id = openTrade({ pair: b.pair, direction: b.direction === 'SHORT' ? 'SHORT' : 'LONG', entry: need(b.entry, 'Entry is required'), stop: need(b.stop, 'Stop is required'), t1: num(b.t1), t2: num(b.t2), units: need(b.units, 'Units are required'), notes: b.notes, strategy: 'Manual' }); push('refresh', {}); res.json({ ok: true, tradeId: id }); }));
api.get('/trades', (req, res) => { const st = req.query.status; res.json(db.prepare('SELECT * FROM trades ' + (st ? 'WHERE status=? ' : '') + 'ORDER BY ' + (st === 'OPEN' ? 'opened_at' : 'COALESCE(closed_at,opened_at)') + ' DESC LIMIT 500').all(...(st ? [st] : [])).map(t => ({ ...parse(t), curStop: A.curStop(t) }))); });
api.get('/trades/:id', (req, res) => { const t = db.prepare('SELECT * FROM trades WHERE id=?').get(req.params.id); if (!t) return res.status(404).json({ error: 'Trade not found' }); const o = parse(t); o.fills = db.prepare('SELECT * FROM fills WHERE trade_id=? ORDER BY id').all(t.id); o.curStop = A.curStop(t); res.json(o); });
function fill(t, kind, price, units, note, reason, followed) {
  units = Math.min(units, t.units_left); const dir = t.direction === 'LONG' ? 1 : -1; const R = Math.abs(t.entry - t.stop); const rAt = dir * (price - t.entry) / R;
  const pnl = pnlUsd(t.pair, t.direction, t.entry, price, units), rPart = rAt * (units / t.units);
  db.prepare('INSERT INTO fills(trade_id,at,kind,price,units,pnl_usd,r_part,note) VALUES(?,?,?,?,?,?,?,?)').run(t.id, nowIso(), kind, price, units, pnl, rPart, note || '');
  const left = t.units_left - units; const close = left <= 1e-9 || kind === 'exit';
  db.prepare('UPDATE trades SET units_left=?, pnl_usd=pnl_usd+?, r=r+?, mfe_r=MAX(mfe_r,?), mae_r=MIN(mae_r,?) WHERE id=?').run(close ? 0 : left, pnl, rPart, rAt, rAt, t.id);
  if (close) { const ex = db.prepare("SELECT SUM(price*units)/SUM(units) p FROM fills WHERE trade_id=? AND kind!='entry'").get(t.id).p; db.prepare("UPDATE trades SET status='CLOSED', closed_at=?, exit_price=?, exit_reason=?, followed_plan=?, advice=NULL WHERE id=?").run(nowIso(), ex, reason || 'MANUAL', followed == null ? null : (followed ? 1 : 0), t.id); }
  return close;
}
api.post('/trades/:id/partial', guard((req, res) => { const t = db.prepare("SELECT * FROM trades WHERE id=? AND status='OPEN'").get(req.params.id); if (!t) throw new Error('That trade is not open'); const b = req.body || {}; const price = need(b.price, 'Enter the exit price'); const units = b.units ? need(b.units, 'Units must be positive') : t.units_left * (num(b.fraction) || 0.5); const closed = fill(t, 'partial', price, units, b.note, 'T1', b.followed); if (!closed) db.prepare("UPDATE trades SET advice=NULL, last_action=TRIM(COALESCE(last_action,'') || ' PARTIAL') WHERE id=?").run(t.id); push('refresh', {}); res.json({ ok: true, closed }); }));
api.post('/trades/:id/close', guard((req, res) => { const t = db.prepare("SELECT * FROM trades WHERE id=? AND status='OPEN'").get(req.params.id); if (!t) throw new Error('That trade is not open'); const b = req.body || {}; fill(t, 'exit', need(b.price, 'Enter the exit price'), t.units_left, b.note, b.reason, b.followed); if (b.lesson) db.prepare("UPDATE trades SET notes=TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?").run('Lesson: ' + b.lesson, t.id); push('refresh', {}); res.json({ ok: true }); }));
api.patch('/trades/:id', guard((req, res) => { const t = db.prepare('SELECT * FROM trades WHERE id=?').get(req.params.id); if (!t) throw new Error('Trade not found'); const b = req.body || {}; if (b.notes != null) db.prepare('UPDATE trades SET notes=? WHERE id=?').run(b.notes, t.id); if (b.tags != null) db.prepare('UPDATE trades SET tags=? WHERE id=?').run(b.tags, t.id); if (num(b.trail_stop) != null && t.status === 'OPEN') db.prepare('UPDATE trades SET trail_stop=? WHERE id=?').run(num(b.trail_stop), t.id); res.json({ ok: true }); }));
api.delete('/trades/:id', guard((req, res) => { db.prepare("UPDATE signals SET status='new', trade_id=NULL WHERE trade_id=?").run(req.params.id); db.prepare('DELETE FROM trades WHERE id=?').run(req.params.id); push('refresh', {}); res.json({ ok: true }); }));
api.get('/stats', (req, res) => { const b = A.build(num(req.query.days)); const items = b.items; delete b.items; b.insights = A.insights(b); b.recent = items.slice(-24).map(t => ({ r: t.r, pair: t.pair, id: t.id })); res.json(b); });
api.get('/events', (req, res) => res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all()));
api.post('/events/read', (req, res) => { db.prepare('UPDATE events SET read=1').run(); res.json({ ok: true }); });
api.get('/settings', (req, res) => res.json({ account: getSetting('account'), limits: getSetting('limits'), macro: getSetting('macro'), pairs: Object.keys(PAIRS) }));
api.put('/settings', guard((req, res) => {
  const b = req.body || {};
  if (b.account) { const a = b.account; if (!(a.startEquity > 0) || !(a.riskPct > 0 && a.riskPct <= 5)) throw new Error('Equity must be positive and risk between 0 and 5%'); setSetting('account', { startEquity: +a.startEquity, riskPct: +a.riskPct, tzOffset: +a.tzOffset || 0 }); }
  if (b.limits) setSetting('limits', Object.fromEntries(Object.entries(b.limits).map(([k, v]) => [k, +v])));
  if (b.macro) { const m = b.macro; ['rates', 'stance', 'riskCcy', 'settings'].forEach(k => { if (!m[k] || typeof m[k] !== 'object') throw new Error('Central bank settings are incomplete (' + k + ')'); }); m.updatedAt = nowIso(); setSetting('macro', m); }
  push('refresh', {}); res.json({ ok: true });
}));
api.post('/backtest', async (req, res) => {
  try { const b = req.body || {}; res.json(await runBacktest({ pairs: b.pairs, years: Math.min(8, Math.max(1, +b.years || 3)), minScore: +b.minScore || 70, riskPct: Math.min(5, +b.riskPct || 1), minRR: +b.minRR || 2, fundMode: b.fundMode === 'off' ? 'off' : 'static', costPips: +b.costPips >= 0 ? +b.costPips : 1, maxConcurrent: Math.min(7, +b.maxConcurrent || 4), startEquity: getSetting('account').startEquity, compound: b.compound !== false, macro: getSetting('macro') }, candles)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
api.get('/export/trades.csv', (req, res) => { const rows = db.prepare('SELECT id,pair,direction,strategy,score,regime,ai_verdict,opened_at,closed_at,entry,stop,exit_price,units,pnl_usd,r,exit_reason,followed_plan,mfe_r,mae_r,tags,notes FROM trades ORDER BY id').all(); const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; const cols = rows[0] ? Object.keys(rows[0]) : ['id']; res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=tally-trades.csv' }); res.send(cols.join(',') + '\n' + rows.map(r => cols.map(c => q(r[c])).join(',')).join('\n')); });

// ---------- shadow outcomes: what would each advisor signal have done if followed exactly? ----------
async function resolveShadows() {
  const rows = db.prepare('SELECT * FROM signals WHERE shadow_r IS NULL AND shadow_reason IS NULL AND created_at < ?').all(new Date(Date.now() - 20 * 3600000).toISOString());
  for (const s of rows) {
    try {
      const { bars } = await candles(s.ticker, '6mo'); const atrA = wilder(trueRange(bars), 14); const day = s.created_at.slice(0, 10);
      let idx = -1; bars.forEach((b, i) => { if (new Date(b.t * 1000).toISOString().slice(0, 10) <= day) idx = i; }); if (idx < 0) continue;
      const expired = bars.length - 1 - idx >= 22; const plan = { dir: s.direction === 'LONG' ? 1 : -1, entryType: s.entry_type, entry: s.entry, stop: s.stop, t1: s.t1, t2: s.t2 };
      const r = simulateTrade(bars, atrA, idx, plan, { pair: s.pair, costPips: 1, closeAtEnd: expired });
      if (r.status === 'CLOSED') db.prepare('UPDATE signals SET shadow_r=?, shadow_reason=?, shadow_resolved_at=? WHERE id=?').run(r.r, expired && r.reason === 'END' ? 'EXPIRED' : r.reason, nowIso(), s.id);
      else if (r.status === 'NOFILL') db.prepare("UPDATE signals SET shadow_reason='NOFILL', shadow_resolved_at=? WHERE id=?").run(nowIso(), s.id);
    } catch (e) { console.error('shadow', s.pair, e.message); }
  }
  if (rows.length) push('refresh', { what: 'scorecard' });
}

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', setHeaders: (res, p) => { if (/(sw\.js|index\.html|app\.js|day\.js|styles\.css)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
if (require.main === module) {
  if (!PASSWORD || !SECRET || !API_KEY) console.error('WARNING: set APP_PASSWORD, SESSION_SECRET and INGEST_API_KEY. Sign-in and n8n ingestion are disabled until you do.');
  setTimeout(() => resolveShadows().catch(console.error), 20000); setInterval(() => resolveShadows().catch(console.error), 3 * 3600000);
  const PORT = process.env.PORT || 3000; app.listen(PORT, '0.0.0.0', () => console.log('Tally listening on ' + PORT + ', data in ' + require('./db').dir));
}
module.exports = { app, resolveShadows };
