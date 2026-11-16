'use strict';
// Runs the heavy Strategy Lab jobs off the web server's thread.
const { parentPort, workerData } = require('worker_threads');
const D = require('./data'), L = require('./index');
(async () => {
  try {
    const say = (p, msg) => parentPort.postMessage({ type: 'progress', p, msg }); const warnings = [];
    say(0.01, 'Downloading price and interest-rate history');
    const raw = await D.loadLive(undefined, m => warnings.push(m), L.FX_SYMS);
    if (workerData.job === 'signals') parentPort.postMessage({ type: 'done', result: Object.assign(L.liveSignals(raw, workerData.strategy, workerData.ctx), { warnings, rates: Object.keys(raw.fred).length }) });
    else { const result = await L.runPipeline(raw, Object.assign({}, workerData.opts, { onProgress: say })); result.warnings = warnings; parentPort.postMessage({ type: 'done', result }); }
  } catch (e) { parentPort.postMessage({ type: 'error', error: e.message }); }
})();
