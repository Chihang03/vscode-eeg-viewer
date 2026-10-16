'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dsp = require('../media/dsp');

test('三通道平均采用 1:1:1，通道缺失不改变分母', () => {
  const columns = [[1, 3, 6, 9], [2, 6, null, 12], [3, 9, 12, 15]];
  const result = dsp.weightedAverage(columns);
  assert.equal(result[0], 2); assert.equal(result[1], 6); assert.equal(result[3], 12);
  assert.ok(Number.isNaN(result[2]));
  assert.deepEqual(columns[0], [1, 3, 6, 9]);
});

test('权重归一化、零权重和错误输入有明确规则', () => {
  assert.deepEqual(Array.from(dsp.weightedAverage([[2, 4], [8, 10], [14, 16]], [1, 2, 1])), [8, 10]);
  assert.deepEqual(Array.from(dsp.weightedAverage([[2, 4], [null, NaN]], [1, 0])), [2, 4]);
  assert.throws(() => dsp.weightedAverage([[1], [2]], [0, 0]), /总和/);
  assert.throws(() => dsp.weightedAverage([[1], [2]], [-1, 2]), /非负/);
  assert.throws(() => dsp.weightedAverage([[1], [2, 3]]), /数量/);
});

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

test('默认整段周期图覆盖全部 trial，选区按实际样本长度建立频率网格', () => {
  const fs = 500, x = Float64Array.from({ length: 5251 }, (_, i) => 20 + 7 * Math.sin(2 * Math.PI * 12 * i / fs));
  const p = dsp.welch([x], fs);
  assert.equal(p.method, 'periodogram'); assert.equal(p.nperseg, x.length); assert.equal(p.segments, 1);
  assert.equal(p.binHz, fs / x.length); assert.equal(p.usedSamples, x.length); assert.equal(p.overlap, 0);
  assert.ok(Math.abs(p.power[0].reduce((a, b) => a + b, 0) * p.binHz - 49 / 2) < 1e-4);
  const selected = dsp.welch([x], fs, { start: 501, end: 4002, seconds: 'full' });
  assert.equal(selected.nperseg, 3501); assert.equal(selected.usedSamples, 3501); assert.equal(selected.binHz, fs / 3501);
  const exact = dsp.welch([x.slice(501, 4002)], fs);
  assert.deepEqual(selected.power, exact.power);
});

test('完整窗缺口回退及 Welch 尾段如实报告实际参与样本，不拼接缺失区间', () => {
  const x = Float64Array.from({ length: 100 }, (_, i) => Math.sin(i)); x.fill(NaN, 30, 40);
  const p = dsp.welch([x], 100);
  assert.equal(p.finiteSamples, 90); assert.equal(p.usedSamples, 60); assert.equal(p.nperseg, 60); assert.equal(p.segments, 1);
  assert.ok(p.warnings.some(w => w.includes('实际参与 60 点')));
  const long = Float64Array.from({ length: 5251 }, (_, i) => Math.sin(i));
  const averaged = dsp.welch([long], 500, { seconds: 4 });
  assert.equal(averaged.usedSamples, 5000); assert.equal(averaged.samples, 5251); assert.equal(averaged.method, 'welch');
  assert.ok(averaged.warnings.some(w => w.includes('实际参与 5000 点')));
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

test('脚本 FFT 规则补零但保持窗能量归一化和实际窗长，Welch 使用半偶舍入', () => {
  const x = Float64Array.from({ length: 5000 }, (_, i) => 3 * Math.sin(2 * Math.PI * 12 * i / 500));
  const p = dsp.welch([x], 500, { seconds: 2, fft: 'script' });
  assert.equal(p.nperseg, 1000); assert.equal(p.noverlap, 500); assert.equal(p.nfft, 4096); assert.equal(p.segments, 9);
  assert.equal(p.binHz, 500 / 4096); assert.equal(p.resolutionHz, 0.5);
  assert.ok(Math.abs(p.power[0].reduce((sum, v) => sum + v, 0) * p.binHz - 4.5) < 1e-9);
  const full = dsp.welch([x], 500, { fft: 'script' });
  assert.equal(full.nperseg, 5000); assert.equal(full.nfft, 8192); assert.equal(full.noverlap, 0);
  assert.equal(full.usedSamples, 5000); assert.equal(full.segments, 1);
  const odd = dsp.welch([x.slice(0, 1001)], 500, { seconds: 4, fft: 'script' });
  assert.equal(odd.noverlap, 500); assert.equal(odd.overlap, 500 / 1001);
  assert.equal(dsp.welch([x.slice(0, 8)], 500, { fft: 'script' }).segments, 1);
  assert.equal(dsp.welch([x.slice(0, 7)], 500, { seconds: 2, fft: 'script' }).segments, 0);
  assert.equal(dsp.welch([x.slice(0, 2)], 500, { fft: 'script' }).segments, 1);
});

test('缺失点插值为显式选项，边缘延拓，不修改输入或静默填补整条缺失通道', () => {
  const x = [null, 2, null, null, 8, NaN];
  assert.deepEqual(Array.from(dsp.process([x], 500, { missing: 'interpolate' }).columns[0]), [2, 2, 4, 6, 8, 8]);
  assert.equal(x[0], null); assert.ok(Number.isNaN(x[5]));
  assert.ok(Number.isNaN(dsp.process([x], 500).columns[0][0]));
  assert.throws(() => dsp.process([[null, NaN]], 500, { missing: 'interpolate' }), /没有有效样本/);
  assert.throws(() => dsp.process([[1, 2]], 60, { filter: true, filterKind: 'ssvep' }), /大于 70/);
});
