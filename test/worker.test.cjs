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
  assert.ok(result.psd.averagePower.every(v => v < 1e-25), '反相信号的平均波形功率抵消，区别于通道功率平均');
});

test('Worker 单位切换按元数据逆换算，三通道平均频谱与直接波形计算一致，保留配置缓存边界', () => {
  const results = [], scope = { EEGDSP: dsp, postMessage: message => results.push(message) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/worker.js'), 'utf8'), { self: scope });
  const values = [0, 1, 2].map(c => Array.from({ length: 5000 }, (_, i) => -100 * (Math.sin(i * .1 + c) + 2)));
  const options = { seconds: 2, fft: 'script' };
  scope.onmessage({ data: { id: 1, type: 'load', source: { values, fs: 500, scale: -100 }, options } });
  scope.onmessage({ data: { id: 2, type: 'compute', config: { units: 'raw' }, options } });
  assert.equal(results[1].columns[0][0], 2);
  assert.notStrictEqual(results[0].columns, results[1].columns);
  for (let i = 0; i < results[0].psd.frequencies.length; i++) {
    assert.ok(Math.abs(results[0].psd.averagePower[i] - 10000 * results[1].psd.averagePower[i]) < 1e-8);
  }
  const expected = dsp.welch([dsp.weightedAverage(values.map(c => c.map(v => v / -100)))], 500, options);
  assert.deepEqual(results[1].psd.averagePower, expected.power[0]);
  assert.deepEqual(values[0][0], -200);
});

test('Worker 默认使用完整分析区间，并将事件或选区上下文随计算结果返回', () => {
  const results = [], scope = { EEGDSP: dsp, postMessage: message => results.push(message) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/worker.js'), 'utf8'), { self: scope });
  const values = [Array.from({ length: 5001 }, (_, i) => Math.sin(i * 0.1))];
  const event = { source: 'event', label: 'AM12 · trial 1', eventId: 'trial:1', targets: [12] };
  scope.onmessage({ data: { id: 1, type: 'load', source: { values, fs: 500 }, options: { start: 501, end: 4502 }, analysis: event } });
  assert.equal(results[0].psd.method, 'periodogram'); assert.equal(results[0].psd.nperseg, 4001);
  assert.equal(results[0].psd.usedSamples, 4001); assert.deepEqual(results[0].analysis, event);
  const selection = { source: 'selection', label: '框选区间', eventId: '', targets: [] };
  scope.onmessage({ data: { id: 2, type: 'compute', options: { start: 1001, end: 1502 }, analysis: selection } });
  assert.equal(results[1].id, 2); assert.equal(results[1].psd.nperseg, 501);
  assert.deepEqual(results[1].analysis, selection); assert.deepEqual(results[0].analysis, event);
  assert.strictEqual(results[0].columns, results[1].columns, '切换分析范围复用完整处理后的记录');
});
