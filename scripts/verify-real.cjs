'use strict';
const assert = require('node:assert/strict');
const { discover, loadSegment, RecordingCache } = require('../src/adapters');
const { process: processSignal, welch } = require('../media/dsp');

(async () => {
  const roots = process.argv.slice(2);
  if (!roots.length) throw new Error('用法：node scripts/verify-real.cjs <采集根目录> [更多目录]');
  for (const root of roots) {
    const dataset = await discover(root), cache = new RecordingCache();
    assert.equal(dataset.warnings.length, 0, dataset.warnings.join('\n'));
    let checked = 0;
    for (const session of dataset.sessions) {
      const selected = [session.trials[0], session.trials.find(t => t.targets.some(f => f % 1 !== 0)),
        session.trials.find(t => t.condition === 'PURE1000')].filter((t, i, list) => t && list.findIndex(other => other?.id === t.id) === i);
      for (const trial of selected) {
        const segment = await loadSegment(dataset, session.id, trial.id, cache);
        const columns = processSignal(segment.values, segment.fs).columns, psd = welch(columns, segment.fs, { seconds: 4 });
        assert.ok(segment.sampleCount > 0); assert.ok(psd.segments > 0); assert.ok(psd.power.every(p => p.every(v => Number.isFinite(v) && v >= 0)));
        if (session.profile === 'ssvep') assert.equal(segment.sampleCount, trial.meta.quality.sample_count);
        else assert.equal(segment.sampleCount, Number(trial.row.eeg_end_index) - Number(trial.row.eeg_start_index));
        checked++;
      }
      if (session.profile === 'assr') {
        const all = await loadSegment(dataset, session.id, 'continuous', cache);
        assert.equal(all.sampleCount, session.meta.sample_count);
        const baseline = all.stages.find(s => s.kind === 'baseline'); assert.ok(baseline);
        const base = await loadSegment(dataset, session.id, baseline.id, cache); assert.ok(base.sampleCount > 0);
        assert.ok(all.stages.some(s => s.kind === 'rest'));
      }
    }
    console.log(`PASS ${root}: ${dataset.sessions.length} sessions, ${dataset.sessions.reduce((n, s) => n + s.trials.length, 0)} trial metadata, ${checked} representative waveform/PSD loads`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
