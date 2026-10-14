'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dsp = require('../media/dsp');

test('任意长度 FFT 与直接 DFT 一致（奇数、偶数、2 的幂）', () => {
  for (const n of [1, 7, 8, 17, 100, 511]) {
    const values = Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + i * 0.001);
    const actual = dsp.fftReal(values);
    for (let k = 0; k < n; k++) {
      let re = 0, im = 0;
      for (let j = 0; j < n; j++) { re += values[j] * Math.cos(2 * Math.PI * j * k / n); im -= values[j] * Math.sin(2 * Math.PI * j * k / n); }
      assert.ok(Math.abs(actual.re[k] - re) < 1e-8, `n=${n} bin=${k}`);
      assert.ok(Math.abs(actual.im[k] - im) < 1e-8);
    }
  }
});

test('单边 Welch 密度谱积分还原正弦功率，保留真实频率网格', () => {
  const fs = 500, n = 5000, amplitude = 7;
  const x = Float64Array.from({ length: n }, (_, i) => 800 + amplitude * Math.sin(2 * Math.PI * 12 * i / fs));
  const p = dsp.welch([x], fs, { seconds: 4 });
  assert.equal(p.nperseg, 2000); assert.equal(p.binHz, 0.25); assert.equal(p.segments, 4);
  assert.ok(Math.abs(p.power[0].reduce((sum, v) => sum + v, 0) * p.binHz - amplitude ** 2 / 2) < 1e-8);
  assert.equal(p.frequencies[p.power[0].indexOf(Math.max(...p.power[0]))], 12);
});

test('缺失段不拼接、不跨边界，联合缺失样本保持一致', () => {
  const x = Float64Array.from({ length: 100 }, (_, i) => Math.sin(i));
  const y = Float64Array.from(x); y.fill(NaN, 30, 40);
  const p = dsp.welch([x, y], 100, { seconds: 0.2 });
  assert.equal(p.finiteSamples, 90); assert.equal(p.segments, 7);
  assert.deepEqual(p.power[0], p.power[1]);
});

test('缩放信号按平方缩放 PSD，负号不会改变功率', () => {
  const x = Float64Array.from({ length: 1000 }, (_, i) => Math.sin(i * 0.11));
  const a = dsp.welch([x], 500, { seconds: 2 });
  const b = dsp.welch([Float64Array.from(x, v => -100 * v)], 500, { seconds: 2 });
  for (let i = 0; i < a.power[0].length; i++) assert.ok(Math.abs(a.power[0][i] * 10000 - b.power[0][i]) < 1e-7);
});

test('选区、短窗口与不足样本有明确结果', () => {
  const x = Float64Array.from({ length: 2500 }, (_, i) => Math.sin(i));
  const p = dsp.welch([x], 500, { start: 500, end: 1501, seconds: 4 });
  assert.equal(p.nperseg, 1001); assert.equal(p.segments, 1); assert.ok(p.warnings.length);
  assert.equal(p.start, 500); assert.equal(p.end, 1501);
  assert.equal(dsp.welch([x.slice(0, 10)], 500).segments, 0);
  assert.throws(() => dsp.welch([x], 500, { start: 10, end: 10 }), /选区为空/);
  assert.throws(() => dsp.welch([x], 500, { overlap: 1 }), /重叠/);
});

test('滤波保留缺口，拒绝超 Nyquist 参数，短段不冒充滤波结果', () => {
  const x = Array.from({ length: 500 }, (_, i) => Math.sin(i * 0.15));
  x[200] = null; x[205] = null;
  const result = dsp.process([x], 500, { filter: true, notch: true });
  assert.ok(Number.isNaN(result.columns[0][200])); assert.ok(Number.isNaN(result.columns[0][203]));
  assert.ok(result.warnings.length); assert.ok(Number.isFinite(result.columns[0][100]));
  assert.throws(() => dsp.process([x], 100, { notch: true }), /陷波/);
  assert.throws(() => dsp.process([x], 500, { filter: true, lowpass: 300 }), /带通/);
});
