'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const preferences = require('../media/preferences');

test('无保存记录时，两个模式使用共同高级参数及各自滤波和频率范围', () => {
  const ssvep = preferences.resolve(null, 'ssvep'), assr = preferences.resolve(null, 'assr');
  for (const values of [ssvep, assr]) {
    assert.equal(values.window, '4'); assert.equal(values.overlap, '0.5'); assert.equal(values['psd-method'], 'welch');
    assert.equal(values['signal-units'], 'metadata'); assert.equal(values.missing, 'interpolate');
  }
  assert.equal(ssvep['signal-mode'], 'ssvep'); assert.deepEqual(ssvep['psd-range'], [6, 35]);
  assert.equal(assr['signal-mode'], 'raw'); assert.deepEqual(assr['psd-range'], [0, 60]);
});

test('恢复手动偏好并过滤损坏值，ASSR 不继承 SSVEP 专用滤波', () => {
  const stored = { window: '8', 'signal-units': 'raw', 'signal-mode': 'ssvep', 'psd-range': [20, 10],
    'visible-channels': ['FP1', 'FP1', '三通道平均'], highpass: NaN, overlap: 'invalid', unexpected: true };
  const ssvep = preferences.resolve(stored, 'ssvep'), assr = preferences.resolve(stored, 'assr');
  assert.equal(ssvep.window, '8'); assert.equal(ssvep.overlap, '0.5'); assert.equal(ssvep.highpass, .5);
  assert.equal(assr['signal-mode'], 'raw'); assert.equal(assr['signal-units'], 'raw');
  assert.deepEqual(ssvep['psd-range'], [6, 35]); assert.equal('unexpected' in ssvep, false);
  assert.deepEqual(ssvep['visible-channels'], ['FP1', '三通道平均']);
  assert.deepEqual(preferences.sanitize([], 'ssvep'), {});
});
