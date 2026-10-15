'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dsp = require('../media/dsp');

test('Worker 生成平均波形，同时保留各通道 PSD；视图平均不混同功率平均', () => {
  const results = [], scope = { EEGDSP: dsp, postMessage: message => results.push(message) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/worker.js'), 'utf8'), { self: scope });
  const a = Array.from({ length: 2000 }, (_, i) => Math.sin(2 * Math.PI * 12 * i / 500));
  const values = [a, a.map(v => -v), a.map(() => 0)];
  scope.onmessage({ data: { id: 1, type: 'load', source: { values, fs: 500 }, options: { seconds: 2 } } });
  const result = results[0];
  assert.equal(result.type, 'result');
  assert.ok(result.average.every(v => Math.abs(v) < 1e-15));
  assert.equal(result.psd.power.length, 3);
  const bin = result.psd.frequencies.indexOf(12);
  assert.ok(result.psd.power[0][bin] > 0.1);
  assert.ok(result.psd.power[1][bin] > 0.1);
  assert.equal(result.psd.power[2][bin], 0);
});
