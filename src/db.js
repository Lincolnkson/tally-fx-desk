'use strict';
const fs = require('fs'); const path = require('path'); const Database = require('better-sqlite3');
const dir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
if (process.env.DB_FILE !== ':memory:') fs.mkdirSync(dir, { recursive: true });
const db = new Database(process.env.DB_FILE || path.join(dir, 'tally.db'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY, signal_id TEXT UNIQUE, created_at TEXT, pair TEXT, ticker TEXT, direction TEXT, strategy TEXT, score INTEGER, breakdown TEXT,
  entry REAL, stop REAL, t1 REAL, t2 REAL, rr REAL, atr REAL, price REAL, entry_type TEXT, units REAL, risk_usd REAL, ai_verdict TEXT, ai_conf REAL, size_mult REAL, thesis TEXT, key_risk TEXT,
  invalidation TEXT, regime TEXT, vix REAL, vetoes TEXT, status TEXT DEFAULT 'new', skip_reason TEXT, shadow_r REAL, shadow_reason TEXT, shadow_resolved_at TEXT, trade_id INTEGER);
CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY, signal_id INTEGER, pair TEXT, ticker TEXT, direction TEXT, strategy TEXT, score INTEGER, regime TEXT, ai_verdict TEXT,
  opened_at TEXT, closed_at TEXT, entry REAL, stop REAL, trail_stop REAL, t1 REAL, t2 REAL, t1_r REAL, t2_r REAL, units REAL, units_left REAL, status TEXT DEFAULT 'OPEN', exit_price REAL,
  pnl_usd REAL DEFAULT 0, r REAL DEFAULT 0, exit_reason TEXT, followed_plan INTEGER, notes TEXT, tags TEXT, mfe_r REAL DEFAULT 0, mae_r REAL DEFAULT 0, last_action TEXT, last_price REAL,
  last_r REAL, advice TEXT, checked_at TEXT, checklist TEXT);
CREATE TABLE IF NOT EXISTS fills (id INTEGER PRIMARY KEY, trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE, at TEXT, kind TEXT, price REAL, units REAL, pnl_usd REAL, r_part REAL, note TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT, type TEXT, severity TEXT, title TEXT, body TEXT, trade_id INTEGER, signal_id INTEGER, read INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS briefs (id INTEGER PRIMARY KEY, at TEXT, regime TEXT, vix REAL, payload TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status); CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status); CREATE INDEX IF NOT EXISTS idx_events_read ON events(read);
`);
const DEFAULTS = {
  account: { startEquity: 10000, riskPct: 1, tzOffset: 2 },
  limits: { maxDailyLossR: 2, maxWeeklyLossR: 4, maxOpenRiskPct: 3, maxLossStreak: 3 },
  macro: {
    settings: { minScore: 70, minRR: 2, eventBlockHours: 24 },
    // Checked 26 Oct 2026. USD = top of the Fed range, EUR = ECB deposit rate. 1 = hiking or leaning to hike, 0 = on hold, -1 = cutting.
    rates: { USD: 4.0, EUR: 2.5, GBP: 3.75, JPY: 1.25, AUD: 4.6, CAD: 2.25, CHF: 0.0, NZD: 2.75 },
    stance: { USD: 1, EUR: 1, GBP: 1, JPY: 1, AUD: 1, CAD: 0, CHF: 0, NZD: 1 },
    cb: [{ ccy: 'USD', date: '2026-10-28' }, { ccy: 'CAD', date: '2026-10-28' }, { ccy: 'NZD', date: '2026-10-28' }, { ccy: 'EUR', date: '2026-10-29' }, { ccy: 'JPY', date: '2026-10-30' }, { ccy: 'AUD', date: '2026-11-03' }, { ccy: 'GBP', date: '2026-11-05' }, { ccy: 'CHF', date: '2026-12-10' }],
    riskCcy: { AUD: 1, NZD: 1, CAD: 1, EUR: 0.5, GBP: 0.5, USD: -1, JPY: -1, CHF: -1 }, updatedAt: '2026-10-26T08:00:00.000Z'
  }
};
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : JSON.parse(JSON.stringify(DEFAULTS[k])); };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
const nowIso = () => new Date().toISOString();
// Profit in USD for a move from entry to price on `units` of the base currency.
function pnlUsd(pair, dir, entry, price, units) { const d = (dir === 'LONG' ? 1 : -1) * (price - entry) * units; return pair.endsWith('USD') ? d : d / price; }
module.exports = { db, getSetting, setSetting, nowIso, pnlUsd, DEFAULTS, dir };
