'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseCSV, recordedNumber, deviceInfo, targetFrequencies, discover, publicDataset, RecordingCache, loadSegment } = require('../src/adapters');

const device = { channels: ['FP1', 'FP2', 'FPz'], sampling_rate_hz: 500, signal_unit: 'raw_device_float', device_to_uv_scale: -100 };
const eeg = 'FP1,FP2,FPz,host_receive_monotonic_ns\n1,2,3,900000000000000001\n4,5,6,900000000000000001\n7,,9,900000000000000003\n10,11,12,900000000000000004\n';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eeg-adapter-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ss = path.join(root, 'ssvep'), assr = path.join(root, 'assr');
  await fs.mkdir(ss); await fs.mkdir(assr);
  const prefix = path.join(ss, 'sub-S001_10.2Hz_trial-01');
  await fs.writeFile(prefix + '_meta.json', JSON.stringify({ subject_id: 'S001', session_id: '01', device,
    stimulus: { frequency_hz: 10.2 }, quality: { valid: true, sample_count: 4 }, segment_kind: 'stimulus', trial_id: 1 }));
  await fs.writeFile(prefix + '_eeg.csv', eeg);
  await fs.writeFile(prefix + '_events.csv', 'timestamp,sample_index,event\n0,0,stimulus_start\n0.008,4,stimulus_end\n');
  await fs.writeFile(path.join(assr, 'session.json'), JSON.stringify({ device: { ...device, sampling_rate_hz: undefined, sample_rate_hz: 500 },
    subject_id: 'S002', session_id: '02', status: 'completed', files: { eeg: 'continuous_eeg.csv', trials: 'trials.csv', events: 'events.csv' } }));
  await fs.writeFile(path.join(assr, 'continuous_eeg.csv'), eeg);
  await fs.writeFile(path.join(assr, 'trials.csv'), 'trial_id,condition,modulation_hz,eeg_start_index,eeg_end_index,sample_count,valid,status\n1,AM12,12,1,3,2,True,completed\n2,PURE1000,,3,4,1,True,completed\n3,AM10,10,,,,False,not_presented\n');
  await fs.writeFile(path.join(assr, 'events.csv'), 'event,stage_kind,stage_index,estimated_output_monotonic_ns\nbaseline_start_reached_estimate,baseline,1,900000000000000001\nbaseline_end_reached_estimate,baseline,1,900000000000000003\nrest_start_submitted,rest,2,900000000000000003\nrest_end_submitted,rest,2,900000000000000004\n');
  return { root, ss, assr, prefix };
}

test('CSV 支持 BOM、引号、CRLF 和多行字段；结构错误不会静默修复', () => {
  assert.deepEqual(parseCSV('\uFEFFa,b\r\n"1,2","line\nnext"\r\n'), [{ a: '1,2', b: 'line\nnext' }]);
  assert.throws(() => parseCSV('a,a\n1,2'), /重复/); assert.throws(() => parseCSV('a,b\n1'), /列数/);
  assert.throws(() => parseCSV('a,b\n"unterminated'), /引号/);
  assert.equal(recordedNumber(''), null); assert.equal(recordedNumber(null), null);
});

test('采样率和单位来自元数据，不把未知单位误标成微伏', () => {
  assert.equal(deviceInfo({ device }).scale, -100);
  assert.equal(deviceInfo({ device: { ...device, signal_unit: 'V' } }).unit, 'V');
  assert.equal(deviceInfo({ device: { ...device, signal_unit: 'V' } }).scale, 1);
  assert.throws(() => deviceInfo({ device: { channels: ['FP1'] } }), /采样率/);
  assert.deepEqual(targetFrequencies({ modulation_hz: '', left_modulation_hz: '10.2', right_modulation_hz: '11.4' }), [10.2, 11.4]);
  assert.deepEqual(targetFrequencies({ condition: 'PURE1000' }), []);
});

test('按文件结构区分两种项目；显式模式仅显示对应会话', async t => {
  const { root, prefix } = await fixture(t);
  const data = await discover(root); assert.equal(data.sessions.length, 2);
  assert.equal((await discover(root, 'ssvep')).sessions.length, 1);
  assert.equal((await discover(root, 'assr')).sessions.length, 1);
  const selected = await discover(prefix + '_eeg.csv'); assert.equal(selected.initialTrial, prefix + '_meta.json');
  assert.equal(publicDataset(selected).profile, 'ssvep');
  const assr = data.sessions.find(s => s.profile === 'assr');
  assert.equal(publicDataset(await discover(assr.eegFile)).profile, 'assr');
  assert.ok(!JSON.stringify(publicDataset(data)).includes('device_to_uv_scale'));
});

test('SSVEP 正确转换单位、保留缺口及样本结束边界', async t => {
  const { ss } = await fixture(t); const data = await discover(ss), s = data.sessions[0];
  const result = await loadSegment(data, s.id, s.trials[0].id, new RecordingCache());
  assert.equal(result.values[0][0], -100); assert.equal(result.values[1][2], null);
  assert.equal(result.events[1].index, 4); assert.equal(result.targets[0], 10.2); assert.equal(result.unit, 'μV');
});

test('ASSR 用半开索引切片，BigInt 时间映射不丢精度，仅使用已到达事件', async t => {
  const { assr } = await fixture(t); const data = await discover(assr), s = data.sessions[0], cache = new RecordingCache();
  const result = await loadSegment(data, s.id, s.trials[0].id, cache);
  assert.deepEqual(result.values[0], [-400, -700]); assert.equal(result.startIndex, 1); assert.equal(result.sampleCount, 2);
  assert.equal(result.stages.length, 1); assert.equal(result.stages[0].end, 2);
  const baseline = await loadSegment(data, s.id, 'stage:1', cache); assert.equal(baseline.sampleCount, 2);
  const pure = await loadSegment(data, s.id, s.trials[1].id, cache); assert.deepEqual(pure.targets, []);
  await assert.rejects(loadSegment(data, s.id, s.trials[2].id, cache), /索引/);
});

test('缺少关联文件、损坏的行和目录越界会报告错误', async t => {
  const { assr, ss, prefix } = await fixture(t);
  const cache = new RecordingCache(); await fs.appendFile(prefix + '_eeg.csv', '1,2\n');
  const data = await discover(ss); await assert.rejects(loadSegment(data, data.sessions[0].id, data.sessions[0].trials[0].id, cache), /列数/);
  const metadataFile = path.join(assr, 'session.json'), meta = JSON.parse(await fs.readFile(metadataFile));
  meta.files.eeg = '../secret.csv'; await fs.writeFile(metadataFile, JSON.stringify(meta));
  await assert.rejects(discover(assr), /会话目录/);
});

test('缓存会根据修改时间和大小失效；时间倒退时停止事件映射', async t => {
  const { prefix } = await fixture(t); const file = prefix + '_eeg.csv', cache = new RecordingCache();
  assert.equal((await cache.read(file, device.channels)).count, 4);
  await fs.appendFile(file, '13,14,15,900000000000000005\n');
  assert.equal((await cache.read(file, device.channels)).count, 5);
  await fs.appendFile(file, '13,14,15,1\n');
  await assert.rejects(cache.read(file, device.channels), /倒退/);
});
