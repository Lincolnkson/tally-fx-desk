'use strict';
// Seeds a throwaway database with realistic sample data and starts the app on port 3000.
// Run: npm run demo  (password: demo). Uses synthetic prices, so it works offline.
const path = require('path'); const fs = require('fs');
const file = path.join(__dirname, '..', 'data', 'demo.db'); fs.mkdirSync(path.dirname(file), { recursive: true }); for (const f of [file, file + '-wal', file + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
Object.assign(process.env, { DB_FILE: file, APP_PASSWORD: process.env.APP_PASSWORD || 'demo', SESSION_SECRET: 'demo-secret', INGEST_API_KEY: 'demo-key', TALLY_FAKE_PRICES: '1' });
const { db, pnlUsd } = require('../src/db');
let s = 11; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const PAIRS = [['EURUSD', 1.0842], ['GBPUSD', 1.2711], ['USDJPY', 151.32], ['AUDUSD', 0.6621], ['USDCAD', 1.3712], ['NZDUSD', 0.6014], ['USDCHF', 0.8812]];
const SETUPS = ['S1 Macro trend + pullback', 'S1 Macro trend + pullback', 'S4 Breakout + retest', 'S5 Range mean-reversion'];
const REG = ['RISK_ON', 'NEUTRAL', 'RISK_ON', 'RISK_OFF'];
const iso = ms => new Date(ms).toISOString(); const day = 86400000; const now = Date.now();
const insT = db.prepare('INSERT INTO trades(signal_id,pair,ticker,direction,strategy,score,regime,ai_verdict,opened_at,closed_at,entry,stop,trail_stop,t1,t2,t1_r,t2_r,units,units_left,status,exit_price,pnl_usd,r,exit_reason,followed_plan,notes,mfe_r,mae_r,last_r,last_price,checked_at,advice) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insF = db.prepare('INSERT INTO fills(trade_id,at,kind,price,units,pnl_usd,r_part,note) VALUES(?,?,?,?,?,?,?,?)');
const insS = db.prepare('INSERT INTO signals(signal_id,created_at,pair,ticker,direction,strategy,score,breakdown,entry,stop,t1,t2,rr,atr,price,entry_type,units,risk_usd,ai_verdict,thesis,key_risk,invalidation,regime,vix,vetoes,status,skip_reason,shadow_r,shadow_reason,shadow_resolved_at,trade_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const outcomes = [2.4, -1, 1.6, -1, 0.95, 2.6, -1, -0.4, 1.9, -1, 3, 0.1, -1, 2.2, 1.1, -1, -1, 2.8, 0.6, -1, 1.7, 2.5, -1, 0.9, -0.7, 2.1, -1, 1.4];
let equity = 10000;
outcomes.forEach((r, i) => {
  const [pair, px] = PAIRS[i % PAIRS.length]; const dir = rnd() > 0.45 ? 'LONG' : 'SHORT', d = dir === 'LONG' ? 1 : -1; const atr = px * 0.0055; const R = atr * 1.4;
  const entry = px * (1 + (rnd() - 0.5) * 0.02), stop = entry - d * R, t1 = entry + d * 2 * R, t2 = entry + d * 3 * R;
  const opened = now - (84 - i * 2.9) * day, closed = opened + (1 + rnd() * 9) * day; const units = Math.round((equity * 0.01) / (pair.endsWith('USD') ? R : R / entry) / 100) * 100;
  const score = Math.round(r > 0.5 ? 70 + rnd() * 20 : 60 + rnd() * 22); const partial = r >= 1.5; const exitR = partial ? 2 * r - 2 : r; const exitPx = entry + d * exitR * R;
  const reason = r <= -0.95 ? 'STOP' : r >= 2.4 ? 'T2' : r > 0.5 ? 'TRAIL' : r > 0 ? 'TIME' : 'MANUAL'; const mfe = Math.max(r, 0) + rnd() * 1.2 + (r < 0 ? 0.3 : 0.2);
  const pnlTotal = pnlUsd(pair, dir, entry, entry + d * r * R, units); equity += pnlTotal;
  const id = insT.run(null, pair, pair + '=X', dir, SETUPS[i % 4], score, REG[i % 4], i % 5 === 0 ? 'REDUCE_SIZE' : 'APPROVE', iso(opened), iso(closed), entry, stop, null, t1, t2, 2, 3, units, 0, 'CLOSED', exitPx, pnlTotal, r, reason, i % 7 === 3 ? 0 : 1, i % 6 === 0 ? 'Lesson: waited for the trigger, worth it.' : '', mfe, Math.min(-0.2, -rnd() * 1.1), null, null, null, null).lastInsertRowid;
  insF.run(id, iso(opened), 'entry', entry, units, 0, 0, 'Opened');
  if (partial) { const p1 = pnlUsd(pair, dir, entry, t1, units / 2); insF.run(id, iso(opened + day * 2), 'partial', t1, units / 2, p1, 1, ''); insF.run(id, iso(closed), 'exit', exitPx, units / 2, pnlTotal - p1, r - 1, ''); }
  else insF.run(id, iso(closed), 'exit', exitPx, units, pnlTotal, r, '');
  const sid = insS.run(pair + '-d' + i, iso(opened - 3600000), pair, pair + '=X', dir, SETUPS[i % 4], score, 'F18 T20 S20 R5 M8 C2', entry, stop, t1, t2, 2, atr, entry, 'market', units, 100, 'APPROVE', '', '', '', REG[i % 4], 16, '[]', 'taken', null, r + (rnd() - 0.5) * 0.3, reason, iso(closed), id).lastInsertRowid;
  db.prepare('UPDATE trades SET signal_id=? WHERE id=?').run(sid, id);
});
[[0.8, 'skipped', 'Not at my screen in time'], [-1, 'skipped', 'I disagree with the setup'], [2.2, 'skipped', 'Already enough risk on'], [-1, 'rejected', null], [0.4, 'rejected', null], [-1, 'skipped', 'Worried about upcoming news'], [1.9, 'skipped', 'Not at my screen in time']].forEach((x, i) => {
  const [pair, px] = PAIRS[(i + 2) % 7]; insS.run(pair + '-x' + i, iso(now - (70 - i * 9) * day), pair, pair + '=X', 'LONG', SETUPS[i % 4], 66 + i * 2, 'F15 T18 S10 R5 M6 C0', px, px * 0.992, px * 1.016, px * 1.024, 2, px * 0.005, px, 'market', 10000, 100, x[1] === 'rejected' ? 'REJECT' : 'APPROVE', '', '', '', 'NEUTRAL', 18, '[]', x[1], x[2], x[0], x[0] < 0 ? 'STOP' : 'TRAIL', iso(now - day), null);
});
// Two open trades the guardian is watching
const open = [['EURUSD', 'LONG', 1.0815, 1.0752, 1.0941, 1.1004, 1.0901, 1.37, 1.6, 1.0822, 'TAKE_PARTIAL'], ['USDJPY', 'SHORT', 152.40, 153.35, 150.50, 149.55, 152.02, 0.4, 0.7, null, null]];
open.forEach((o, i) => { const R = Math.abs(o[2] - o[3]); const units = o[0] === 'USDJPY' ? 16000 : 15800; const id = insT.run(null, o[0], o[0] + '=X', o[1], i ? 'S4 Breakout + retest' : 'S1 Macro trend + pullback', i ? 74 : 81, 'RISK_ON', 'APPROVE', iso(now - (4 + i * 2) * day), null, o[2], o[3], o[9], o[4], o[5], 2, 3, units, units, 'OPEN', null, 0, 0, null, null, '', o[8], -0.3, o[7], o[6], iso(now - 3 * 3600000), o[10]).lastInsertRowid; insF.run(id, iso(now - (4 + i * 2) * day), 'entry', o[2], units, 0, 0, 'Opened'); });
// A fresh signal waiting on the desk
insS.run('GBPUSD-live', iso(now - 9 * 3600000), 'GBPUSD', 'GBPUSD=X', 'LONG', 'S1 Macro trend + pullback', 78, 'F21 T23 S20 R5 M8 C2', 1.2752, 1.2668, 1.2920, 1.3004, 2, 0.0061, 1.2731, 'stop', 11900, 100, 'APPROVE', 'Rates in the UK stay higher than markets expected while the dollar softens; price has pulled back to its rising 20-day average inside a clean daily uptrend.', 'A dovish surprise from the Bank of England on 5 November.', 'A daily close back below 1.2668.', 'RISK_ON', 15.8, '[]', 'new', null, null, null, null, null);
db.prepare('INSERT INTO briefs(at,regime,vix,payload) VALUES(?,?,?,?)').run(iso(now - 9 * 3600000), 'RISK_ON', 15.8, JSON.stringify([{ pair: 'GBPUSD', decision: 'ENTER', direction: 'LONG', score: 78, strategy: 'S1 Macro trend + pullback', vetoes: [] }, { pair: 'AUDUSD', decision: 'WATCH', direction: 'LONG', score: 64, vetoes: ['Pullback seen, waiting for trigger'] }, { pair: 'USDJPY', decision: 'WATCH', direction: 'SHORT', score: 61, vetoes: ['event risk: JPY central-bank decision in about 4 days'] }, { pair: 'EURUSD', decision: 'WAIT', direction: 'LONG', score: 48, vetoes: ['recent high only 0.9R away'] }, { pair: 'USDCAD', decision: 'WAIT', direction: 'SHORT', score: 39, vetoes: ['no valid setup'] }, { pair: 'NZDUSD', decision: 'WAIT', direction: 'LONG', score: 35, vetoes: ['counter-trend'] }, { pair: 'USDCHF', decision: 'WAIT', direction: 'SHORT', score: 31, vetoes: ['no valid setup'] }]));
const ev = db.prepare('INSERT INTO events(at,type,severity,title,body,trade_id,signal_id,read) VALUES(?,?,?,?,?,?,?,?)');
ev.run(iso(now - 9 * 3600000), 'brief', 'info', 'Daily brief: 1 enter, 2 watch, 4 wait', 'Market mood risk-on, VIX 15.8', null, null, 1);
ev.run(iso(now - 9 * 3600000), 'signal', 'action', 'GBPUSD LONG signal, score 78', 'Pullback in a daily uptrend with UK rates holding up.', null, null, 0);
ev.run(iso(now - 3 * 3600000), 'trade', 'action', 'EURUSD LONG: take partial', 'Target 1 (2R) reached. Bank about half and keep the rest running with the trailing stop.', 1 + outcomes.length, null, 0);
db.prepare("INSERT INTO settings(key,value) VALUES('macro',?)").run(JSON.stringify(Object.assign({}, require('../src/db').DEFAULTS.macro, { updatedAt: iso(now - 2 * day) })));
require('./demo-day')(db);
console.log('Demo data ready: ' + outcomes.length + ' closed trades, 2 open, 1 new signal. Password: ' + process.env.APP_PASSWORD);
const { app } = require('../src/server'); const port = process.env.PORT || 3000; app.listen(port, () => console.log('Demo running at http://localhost:' + port));
