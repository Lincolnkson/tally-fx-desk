'use strict';
/* Tally Strategy Lab. Loaded before app.js and uses its helpers ($, api, head, lineChart, sheet …) at call time. */
const StrategyLab = (() => {
  let timer = null;
  const pct = (x, d = 0) => x == null ? '–' : (x * 100).toFixed(d) + '%';
  const r3 = x => x == null ? '–' : (x < 0 ? '−' : '+') + Math.abs(x).toFixed(3) + 'R';
  const r1 = x => x == null ? '–' : (x < 0 ? '−' : '+') + Math.abs(x).toFixed(1) + 'R';
  const day = d => new Date(d * 86400000).toISOString().slice(0, 10);
  const kpis = s => '<div class="kpis"><div class="kpi"><span class="big">' + pct(s.winRate, 1) + '</span><span class="lbl">Won, over ' + s.n + ' trades</span></div><div class="kpi"><span class="big ' + cls(s.expR) + '">' + r3(s.expR) + '</span><span class="lbl">Per trade after costs</span></div><div class="kpi"><span class="big ' + cls(s.rPerYear) + '">' + r1(s.rPerYear) + '</span><span class="lbl">A year (1R = what you risk on one trade)</span></div><div class="kpi"><span class="big loss">−' + (s.maxDDR || 0).toFixed(1) + 'R</span><span class="lbl">Deepest drawdown</span></div></div>';
  const curve = (c, label) => c && c.length > 2 ? '<div class="card">' + lineChart(c.map(p => ({ y: p[1], label: day(p[0]) })), { base: 0, fmt: x => (x < 0 ? '−' : '') + Math.abs(x).toFixed(0) + 'R', color: c[c.length - 1][1] >= 0 ? 'var(--gain)' : 'var(--loss)', label }) + '</div>' : '';
  const row = (k, s) => '<tr><td>' + k + '</td><td class="tnum">' + s.n + '</td><td class="tnum">' + pct(s.winRate, 1) + '</td><td class="tnum ' + cls(s.expR) + '">' + r3(s.expR) + '</td><td class="tnum ' + cls(s.sumR) + '">' + r1(s.sumR) + '</td></tr>';
  const tbl = (rows, first) => '<div class="tablewrap"><table><thead><tr><th>' + first + '</th><th>Trades</th><th>Won</th><th>Per trade</th><th>Total</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';

  function rules(d) {
    return '<div class="card"><p><b>Entry.</b> ' + esc(d.entry) + '</p>' + (d.conditions.length ? '<p><b>Only when all of these hold.</b></p><ul style="margin:0 0 8px;padding-left:20px">' + d.conditions.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>' : '') + '<p><b>Stop.</b> ' + esc(d.stop.replace(/^Stop /, '')) + '</p><p><b>Exit.</b> ' + esc(d.exit) + '</p><p style="margin:0"><b>Traded on.</b> ' + esc(d.universe) + '</p></div>';
  }
  function checks(list) {
    return '<div class="list">' + list.map(c => '<div class="li" style="align-items:flex-start"><span class="pill ' + (c.pass ? 'gain' : 'loss') + '" style="margin-top:2px;min-width:44px;text-align:center">' + (c.pass ? 'Pass' : 'Fail') + '</span><div class="grow"><b>' + esc(c.label) + '</b><div class="small muted">' + esc(c.detail) + '</div></div></div>').join('') + '</div>';
  }
  function inUse(d) {
    const a = d.active, res = d.last && d.last.result, b = res && res.baseline && !res.baseline.error ? res.baseline : null; let h = '<section class="blk"><h2>In use now</h2>';
    if (a) {
      const hl = a.health, st = { healthy: ['gain', 'Healthy'], watch: ['warn', 'Needs watching'], failing: ['loss', 'No longer working'] }[hl ? hl.state : ''] || ['', 'Not re-tested yet'];
      h += '<div class="card"><div class="row wrap"><h3 class="grow">' + esc(a.name) + '</h3><span class="pill ' + (a.status === 'live' ? 'blue' : 'warn') + '">' + (a.status === 'live' ? 'Live: drives the advisor' : 'Paper trial') + '</span><span class="pill ' + st[0] + '">' + st[1] + '</span></div><p class="small muted" style="margin-top:6px">' + (a.status === 'live' ? 'Approved' : 'Trial started') + ' ' + dshort(a.decidedAt) + '.' + (hl ? ' ' + esc(hl.why) : ' Its first re-test happens on the next lab run.') + '</p>';
      if (hl) h += tbl([hl.since ? row('Since you approved it', hl.since) : '', row('Last 6 months', hl.last6), row('Last 12 months', hl.last12), row('Whole history', hl.all)], 'Same rules, replayed on');
      if (d.liveScore) h += '<p class="small" style="margin-top:10px">Signals it has actually sent: <b>' + d.liveScore.n + '</b> finished' + (d.liveScore.n ? ', ' + d.liveScore.wins + ' won, <b class="' + cls(d.liveScore.sumR) + '">' + r1(d.liveScore.sumR) + '</b> in total' : '') + (d.liveScore.pending ? ', ' + d.liveScore.pending + ' still playing out' : '') + '.</p>';
      h += '<div class="row" style="margin-top:12px"><button class="btn loss sm" id="retire" data-id="' + a.id + '">' + (a.status === 'live' ? 'Retire it and go back to the original rules' : 'Stop the trial') + '</button></div></div>';
    }
    if (!a || a.status === 'trial') {
      h += '<div class="card"' + (a ? ' style="margin-top:12px"' : '') + '><div class="row wrap"><h3 class="grow">The advisor\'s original rules</h3><span class="pill ' + (d.settings.pauseLegacy ? 'warn' : 'blue') + '">' + (d.settings.pauseLegacy ? 'Signals paused' : 'Sending signals') + '</span></div>';
      if (b) {
        const bad = b.all.expR < 0;
        h += '<p class="tonebar ' + (bad ? 'bad' : 'good') + '" style="margin-top:10px">Replayed on real prices from ' + res.window.start.slice(0, 4) + ' to today, these rules ' + (bad ? 'lost money' : 'made money') + ': ' + b.all.n + ' trades, ' + pct(b.all.winRate, 1) + ' won, ' + r3(b.all.expR) + ' per trade, ' + r1(b.all.sumR) + ' in total, with a drawdown of ' + b.all.maxDDR.toFixed(0) + 'R on the way.' + (b.all.winRate < res.rules.minWinRate ? ' That is below your 50% win-rate rule.' : '') + '</p>' + curve(b.curve, 'Original rules, cumulative R') + '<p class="small muted" style="margin-top:8px">' + esc(b.note) + '</p>';
        if (bad && !d.settings.pauseLegacy) h += '<div class="warnbox">These rules have not earned their place. Until a strategy passes the checks below, consider pausing the signals or trading them on a demo account only.</div>';
      } else h += '<p class="small muted" style="margin-top:8px">Run the lab once to see how these rules have done on 18 years of real prices.</p>';
      h += '<label class="check" style="margin-top:14px"><input type="checkbox" id="pause"' + (d.settings.pauseLegacy ? ' checked' : '') + '><span>Pause signals from the original rules. The daily brief still arrives, but nothing is marked ENTER.</span></label></div>';
    }
    return h + '</section>';
  }
  function candidate(d) {
    const c = d.candidate, res = d.last && d.last.result; if (!c) { if (!res) return ''; return '<section class="blk"><h2>Candidate</h2><div class="empty">' + esc(d.last.summary) + '</div></section>'; }
    const p = c.report, ok = p.passed, nFail = p.failed.length;
    let h = '<section class="blk"><h2>' + (ok ? 'Waiting for your approval' : 'Best candidate this run') + ' <span class="small muted">found ' + dshort(c.createdAt) + '</span></h2>';
    h += '<div class="' + (ok ? 'card' : 'banner') + '" style="margin-bottom:14px">' + (ok ? '<b class="gain">Passed every check.</b> It only goes into the advisor if you approve it.' : '<b>Not proposed.</b> It failed ' + nFail + ' of ' + p.checks.length + ' checks, so it cannot be set live. You may paper-trade it to watch it without money.') + '</div>';
    h += '<h3 style="margin-bottom:8px">' + esc(c.name) + '</h3>' + rules(p.describe) + '<div style="height:18px"></div>' + kpis(p.all) + curve(p.curve, 'Cumulative R, whole history');
    h += '<p class="small muted" style="margin:8px 0 18px">Average win ' + p.all.avgWin.toFixed(2) + 'R against an average loss of ' + Math.abs(p.all.avgLoss).toFixed(2) + 'R. Trades last about ' + p.avgBars + ' trading days. Worst losing run: ' + p.all.maxLossStreak + ' in a row. Costs counted: each pair\'s spread, half a pip of slippage and overnight financing.</p>';
    h += '<h3 style="margin-bottom:8px">Found on old data, then tested on data it never saw</h3>' + tbl([row('Data the search could see (to ' + res.window.holdout + ')', p.design), row('Locked away until the final exam (last two years)', p.holdout)], 'Period');
    h += '<h3 style="margin:18px 0 8px">The checks</h3>' + checks(p.checks);
    h += '<div class="grid2" style="margin-top:18px"><div>' + tbl(p.byPair.slice(0, 17).map(m => row(m.key, m)), 'Pair') + '</div><div>' + tbl(p.bySide.concat(p.byMood, p.byTrend).map(m => row(m.key, m)), 'Condition') + '<div style="height:12px"></div>' + tbl(Object.entries(p.all.years).map(([y, v]) => '<tr><td>' + y + '</td><td colspan="3"></td><td class="tnum ' + cls(v) + '">' + r1(v) + '</td></tr>'), 'Year') + '</div></div>';
    if (c.status === 'proposed' || c.status === 'failed') h += '<div class="row wrap" style="margin-top:18px">' + (ok ? '<button class="btn gain" id="approve" data-id="' + c.id + '">Approve and set it live</button>' : '') + '<button class="btn ghost" id="trial" data-id="' + c.id + '">Paper-trade it</button><button class="btn ghost" id="reject" data-id="' + c.id + '">Dismiss</button></div>';
    return h + '</section>';
  }
  function reality(res) {
    const rc = res.reality, f = rc.folds.filter(x => x.train); if (!f.length) return '';
    const cell = s => '<td class="tnum">' + pct(s.winRate) + '</td><td class="tnum ' + cls(s.expR) + '">' + r3(s.expR) + '</td>';
    return '<section class="blk"><h2>Reality check <span class="small muted">does the search itself work?</span></h2><p class="tonebar ' + (rc.unseen.expR >= res.rules.minExpR ? 'good' : 'warn') + '">The lab repeated its whole search as if it were ' + f.map(x => x.from.slice(0, 4)).join(', ') + ', then traded each winner on the two years that followed. When chosen, the winners averaged ' + pct(rc.inSample.winRate) + ' wins and ' + r3(rc.inSample.expR) + ' a trade. On the years they had not seen they made ' + pct(rc.unseen.winRate, 1) + ' and ' + r3(rc.unseen.expR) + ' over ' + rc.unseen.n + ' trades. The gap between those two lines is how much a backtest flatters a strategy.</p>'
      + '<div class="tablewrap"><table><thead><tr><th>Chosen in</th><th>Recipe</th><th>Won then</th><th>Per trade then</th><th>Won after</th><th>Per trade after</th><th>Trades after</th></tr></thead><tbody>' + f.map(x => '<tr><td>' + x.from.slice(0, 7) + '</td><td>' + esc(x.name) + '</td>' + cell(x.train) + cell(x.test) + '<td class="tnum">' + x.test.n + '</td></tr>').join('') + '</tbody></table></div></section>';
  }
  async function view(v) {
    clearTimeout(timer); const d = await api('GET', '/strategy-lab'); const res = d.last && d.last.result, run = d.running;
    let h = head('Strategy Lab', 'Searches for better rules, tests them on years they never saw, and proposes only what survives', '<button class="btn" id="run"' + (run ? ' disabled' : '') + '>' + (run ? 'Running…' : 'Run the lab now') + '</button>');
    if (run) h += '<div class="card" style="margin-bottom:24px"><div class="row"><span class="spin"></span><b class="grow">' + esc(run.msg) + '</b><span class="tnum">' + Math.round(run.p * 100) + '%</span></div><div class="meter"><i style="width:' + Math.round(run.p * 100) + '%;background:var(--blue)"></i><i style="flex:1;background:var(--rule)"></i></div><div class="small muted">A full run downloads 18 years of prices and interest rates and tests several thousand recipes. It takes a few minutes; you can leave this page.</div></div>';
    if (d.lastError) h += '<div class="banner"><b>The last run failed.</b> ' + esc(d.lastError.message) + '</div>';
    if (d.last) h += '<p class="tonebar ' + (d.last.status === 'proposed' ? 'good' : 'warn') + '" style="margin-bottom:24px"><b>Last run ' + dshort(d.last.at) + ' (' + (d.last.by === 'schedule' ? 'scheduled' : 'started by you') + ').</b> ' + esc(d.last.summary) + (res ? ' ' + res.tried.toLocaleString() + ' recipes tried on ' + res.data.pairs + ' pairs, prices to ' + res.asOf + '.' : '') + '</p>';
    else if (!run) h += '<div class="empty" style="margin-bottom:24px">Nothing has been tested yet. Run the lab to measure the advisor\'s current rules and search for better ones.</div>';
    h += inUse(d) + candidate(d) + (res ? reality(res) : '');
    h += '<section class="blk"><h2>How it decides</h2><div class="card small"><p><b>Your rules.</b> A strategy must win at least half its trades, its average win must be at least 0.8 of its average loss, and it must make money after spread, slippage and overnight financing. Nothing below that is ever proposed.</p><p><b>Two kinds of improvement.</b> Each run tries thousands of recipes: the same setups with different settings (tuning), and new combinations of setup, trend, interest-rate, currency-strength and market-mood rules (inventing). The best ones are varied again for several rounds.</p><p><b>The final exam.</b> The search never sees the last two years. Only its single best recipe is tested on them, once. A recipe that only worked on the data it was fitted to fails here.</p><p><b>Every two weeks</b> the lab runs again, re-tests whatever is in use and tells you in the inbox if it has stopped working. Nothing changes in the advisor without your approval.</p><p style="margin:0"><b>Limits.</b> Daily candles from Yahoo, monthly interest rates from FRED (used two months late, as published). No news, order flow or intraday data. Passing these checks is evidence, not a promise: paper-trade first and keep risk small.</p></div></section>';
    if (d.runs.length) h += '<section class="blk"><h2>Run history</h2><div class="list">' + d.runs.map(r => '<div class="li"><span class="small muted" style="width:64px">' + dshort(r.at) + '</span><span class="pill ' + ({ proposed: 'gain', error: 'loss' }[r.status] || '') + '">' + ({ proposed: 'Proposed', failed: 'Nothing passed', none: 'Nothing found', same: 'No change', error: 'Error' }[r.status] || r.status) + '</span><span class="grow small">' + esc(r.summary) + '</span></div>').join('') + '</div></section>';
    v.innerHTML = h;
    const post = (path, body, msg) => e => submit(e.target, () => api('POST', '/strategy-lab' + path, body || {}), () => { toast(msg); view(v); });
    $('#run', v).onclick = post('/run', {}, 'Lab run started');
    const q = (id, fn) => { const el = $('#' + id, v); if (el) el.onclick = fn; };
    q('pause', e => api('PUT', '/strategy-lab/settings', { pauseLegacy: e.target.checked }).then(() => { toast(e.target.checked ? 'Original rules paused from the next run' : 'Original rules will send signals again'); view(v); }).catch(x => toast(x.message, true)));
    q('approve', e => { if (confirm('Set this strategy live? From the next advisor run its signals replace the original rules. You can retire it at any time.')) post('/strategies/' + e.target.dataset.id + '/approve', { mode: 'live' }, 'Approved. The advisor uses it from its next run.')(e); });
    q('trial', e => { if (confirm('Start a paper trial? Its signals will arrive marked PAPER TRIAL next to the usual ones. Do not trade them with real money.')) post('/strategies/' + e.target.dataset.id + '/approve', { mode: 'trial' }, 'Paper trial started')(e); });
    q('reject', e => post('/strategies/' + e.target.dataset.id + '/reject', {}, 'Dismissed')(e));
    q('retire', e => { if (confirm('Stop using this strategy?')) post('/strategies/' + e.target.dataset.id + '/retire', {}, 'Retired')(e); });
    if (run) timer = setTimeout(() => { if (S.route === 'strategy') view(v).catch(() => { }); }, 4000);
  }
  return { view };
})();
