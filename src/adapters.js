'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const readline = require('node:readline');

// 本插件只适配 SSVEP 与 ASSR；不根据文件名猜测采样率、单位或刺激频率。
const PROFILES = ['auto', 'ssvep', 'assr'];
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_SAMPLES = 2_000_000;

function parseCSV(text) {
  const records = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v !== '')) records.push(row);
      row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  if (field || row.length) { row.push(field); records.push(row); }
  if (!records.length) return [];
  const headers = records.shift().map(x => x.trim());
  if (new Set(headers).size !== headers.length) throw new Error('CSV 包含重复列名');
  return records.map((values, i) => {
    if (values.length !== headers.length) throw new Error(`CSV 第 ${i + 2} 行列数不一致`);
    return Object.fromEntries(headers.map((h, j) => [h, values[j]]));
  });
}

async function readJSON(file) {
  const stat = await fsp.stat(file);
  if (stat.size > 4 * 1024 * 1024) throw new Error('元数据文件超过 4 MB');
  return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function readCSV(file) {
  if ((await fsp.stat(file)).size > 16 * 1024 * 1024) throw new Error('事件／trial 文件过大');
  return parseCSV(await fsp.readFile(file, 'utf8'));
}

async function optionalCSV(file, warnings) {
  try { return await readCSV(file); }
  catch (error) {
    if (error.code === 'ENOENT') { warnings.push(`缺少 ${path.basename(file)}，未显示对应事件。`); return []; }
    throw error;
  }
}

function recordedNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deviceInfo(meta) {
  const device = meta.device || {};
  const fsHz = recordedNumber(device.sampling_rate_hz ?? device.sample_rate_hz);
  if (!(fsHz > 0)) throw new Error('元数据没有有效的 EEG 采样率');
  const channels = device.channels;
  if (!Array.isArray(channels) || !channels.length || channels.some(c => typeof c !== 'string')) {
    throw new Error('元数据没有通道列表');
  }
  if (new Set(channels).size !== channels.length) throw new Error('元数据通道名重复');
  const scale = recordedNumber(device.device_to_uv_scale);
  const converted = device.signal_unit === 'raw_device_float' && scale !== null && scale !== 0;
  return { fs: fsHz, channels, scale: converted ? scale : 1,
    unit: converted ? 'μV' : String(device.signal_unit || '原始单位'),
    samplingSource: device.sampling_rate_source || 'metadata_configured', converted };
}

function validFlag(value) { return value === true || String(value).toLowerCase() === 'true'; }
function targetFrequencies(row) {
  return [...new Set(['frequency_hz', 'modulation_hz', 'left_modulation_hz', 'right_modulation_hz']
    .map(k => recordedNumber(row[k])).filter(v => v > 0))];
}

function insideFile(dir, value, fallback) {
  const name = value || fallback;
  if (typeof name !== 'string' || path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error('关联数据文件必须位于当前会话目录');
  }
  return path.join(dir, name);
}

async function discover(input, profile = 'auto') {
  if (!PROFILES.includes(profile)) throw new Error('未知数据模式');
  const selected = path.resolve(input);
  const stat = await fsp.stat(selected);
  const root = stat.isDirectory() ? selected : path.dirname(selected);
  const entries = [], warnings = [];
  let visited = 0;
  async function walk(dir, depth) {
    if (depth > 8) { warnings.push(`跳过超过 8 层的目录：${path.basename(dir)}`); return; }
    const files = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of files) {
      if (++visited > 30000) throw new Error('目录条目超过 30,000，请选择更具体的采集目录');
      if (item.isSymbolicLink() || item.name.startsWith('.') || ['node_modules', '__pycache__'].includes(item.name)) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file, depth + 1);
      else if ((profile !== 'assr' && item.name.endsWith('_meta.json')) ||
               (profile !== 'ssvep' && item.name === 'session.json')) entries.push(file);
    }
  }
  await walk(root, 0);
  const sessions = [];
  const ssvepGroups = new Map();
  for (const file of entries.sort()) {
    try {
      const meta = await readJSON(file);
      if (path.basename(file) === 'session.json') {
        if (!meta.device || !meta.files?.eeg || !meta.files?.trials) continue;
        const dir = path.dirname(file), info = deviceInfo(meta);
        const trialsFile = insideFile(dir, meta.files.trials, 'trials.csv');
        const rows = await readCSV(trialsFile);
        if (rows.length && !('eeg_start_index' in rows[0])) throw new Error('ASSR trials.csv 缺少样本索引');
        sessions.push({ id: file, profile: 'assr', label: path.basename(dir), subject: meta.subject_id,
          session: meta.session_id, date: meta.date, info, meta, dir,
          eegFile: insideFile(dir, meta.files.eeg, 'continuous_eeg.csv'),
          eventsFile: insideFile(dir, meta.files.events, 'events.csv'),
          trials: rows.map((row, i) => ({ id: `${file}#${i}`, kind: 'stimulus',
            label: `${row.condition || '未知条件'} · trial ${row.trial_id}`, condition: row.condition,
            trial: row.trial_id, repetition: row.repetition, targets: targetFrequencies(row),
            valid: validFlag(row.valid), status: row.status, reason: row.invalid_reason, row })) });
      } else {
        if (!meta.device || !meta.stimulus || !meta.quality) continue;
        const dir = path.dirname(file), info = deviceInfo(meta);
        if (!ssvepGroups.has(dir)) ssvepGroups.set(dir, { id: dir, profile: 'ssvep', label: path.basename(dir),
          subject: meta.subject_id, session: meta.session_id, date: meta.date, info, dir, trials: [] });
        const prefix = file.slice(0, -'_meta.json'.length);
        ssvepGroups.get(dir).trials.push({ id: file, metaFile: file, eegFile: `${prefix}_eeg.csv`,
          eventsFile: `${prefix}_events.csv`, meta, info, kind: meta.segment_kind || 'stimulus',
          label: `${meta.stimulus.frequency_hz} Hz · trial ${meta.trial_id}`,
          condition: `${meta.stimulus.frequency_hz} Hz`, trial: meta.trial_id,
          targets: targetFrequencies(meta.stimulus), valid: validFlag(meta.quality.valid),
          status: meta.quality.completed_phase || '', reason: meta.quality.invalid_reason || '' });
      }
    } catch (error) { warnings.push(`${path.relative(root, file)}：${error.message}`); }
  }
  for (const session of ssvepGroups.values()) {
    session.trials.sort((a, b) => a.targets[0] - b.targets[0] || Number(a.trial) - Number(b.trial));
    sessions.push(session);
  }
  sessions.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  if (!sessions.length) throw new Error(`没有找到${profile === 'auto' ? ' SSVEP 或 ASSR' : ` ${profile.toUpperCase()}`} 数据。${warnings[0] ? `\n${warnings[0]}` : ''}`);
  let initialSession = sessions[0].id, initialTrial;
  if (!stat.isDirectory()) {
    for (const session of sessions) {
      const match = session.profile === 'assr' ? [session.id, session.eegFile, session.eventsFile].includes(selected)
        : session.trials.some(t => [t.id, t.eegFile, t.eventsFile].includes(selected));
      if (match) {
        initialSession = session.id;
        initialTrial = session.trials.find(t => [t.id, t.eegFile, t.eventsFile].includes(selected))?.id;
        break;
      }
    }
  }
  return { root, profile, sessions, warnings, initialSession, initialTrial };
}

function publicDataset(dataset) {
  const profile = dataset.sessions.find(session => session.id === dataset.initialSession)?.profile || dataset.sessions[0].profile;
  return { rootLabel: path.basename(dataset.root), profile, warnings: dataset.warnings,
    initialSession: dataset.initialSession, initialTrial: dataset.initialTrial,
    sessions: dataset.sessions.map(s => ({ id: s.id, profile: s.profile, label: s.label, subject: s.subject,
      date: s.date, info: s.info, trials: s.trials.map(t => ({ id: t.id, label: t.label, condition: t.condition,
        trial: t.trial, targets: t.targets, valid: t.valid, status: t.status, reason: t.reason, kind: t.kind })) })) };
}

// 连续 CSV 只缓存最近两份；使用 mtime/size，重新打开时不会沿用旧记录。
class RecordingCache {
  constructor() { this.cache = new Map(); }
  clear() { this.cache.clear(); }
  async read(file, channels) {
    const stat = await fsp.stat(file);
    if (stat.size > MAX_BYTES) throw new Error('EEG 文件超过 256 MB，请先按会话分割');
    const key = `${file}:${stat.mtimeMs}:${stat.size}:${channels.join('|')}`;
    if (this.cache.has(key)) {
      const value = this.cache.get(key); this.cache.delete(key); this.cache.set(key, value); return value;
    }
    const values = channels.map(() => []), stamps = [];
    let header, indices, timeIndex, lineNumber = 0, repeats = 0, invalid = 0, previous;
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        const cells = line.replace(/^\uFEFF/, '').split(',').map(v => v.trim());
        if (!header) {
          header = cells; indices = channels.map(c => header.indexOf(c)); timeIndex = header.indexOf('host_receive_monotonic_ns');
          if (new Set(header).size !== header.length || indices.some(i => i < 0)) throw new Error('EEG 列名重复或缺少元数据指定的通道');
          continue;
        }
        if (cells.length !== header.length) throw new Error(`EEG 第 ${lineNumber} 行列数错误`);
        if (values[0].length >= MAX_SAMPLES) throw new Error('EEG 超过 200 万样本');
        for (let c = 0; c < channels.length; c++) {
          const raw = cells[indices[c]], value = raw === '' ? NaN : Number(raw);
          values[c].push(value);
          if (!Number.isFinite(value)) invalid++;
        }
        if (timeIndex >= 0) {
          const raw = cells[timeIndex];
          if (!/^\d+$/.test(raw)) throw new Error(`EEG 第 ${lineNumber} 行接收时间无效`);
          const stamp = BigInt(raw);
          if (previous !== undefined && stamp < previous) throw new Error('EEG 接收时间倒退，无法进行事件索引映射');
          if (stamp === previous) repeats++;
          previous = stamp; stamps.push(stamp);
        }
      }
    } finally { lines.close(); input.destroy(); }
    if (!values[0].length) throw new Error('EEG 文件没有样本');
    const value = { values: values.map(v => Float64Array.from(v)), stamps, count: values[0].length, repeats, invalid };
    this.cache.set(key, value);
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
}

function bisectLeft(stamps, target) {
  let low = 0, high = stamps.length;
  while (low < high) { const mid = (low + high) >>> 1; if (stamps[mid] < target) low = mid + 1; else high = mid; }
  return low;
}

function indexBounds(row, count) {
  const left = recordedNumber(row.eeg_start_index), right = recordedNumber(row.eeg_end_index);
  if (!Number.isInteger(left) || !Number.isInteger(right) || left < 0 || right > count || right <= left) {
    throw new Error('此 trial 没有可用的 [start, end) EEG 索引，可能尚未呈现、已中断或文件不完整');
  }
  return [left, right];
}

async function loadSegment(dataset, sessionId, segmentId, cache) {
  const session = dataset.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('会话不存在');
  const warnings = [];
  let trial, info, data, start = 0, end, events = [], regions = [], meta, label, targets = [], timing;
  if (session.profile === 'ssvep') {
    trial = session.trials.find(t => t.id === segmentId) || (segmentId === 'initial' ? session.trials[0] : null);
    if (!trial) throw new Error('trial 不存在');
    info = trial.info; meta = trial.meta; label = trial.label; targets = trial.targets;
    data = await cache.read(trial.eegFile, info.channels); end = data.count;
    const rows = await optionalCSV(trial.eventsFile, warnings);
    events = rows.map(row => ({ index: recordedNumber(row.sample_index), label: row.event,
      hostSeconds: recordedNumber(row.timestamp), source: '采集文件 sample_index；timestamp 为单独记录的事件时间' }))
      .filter(e => Number.isInteger(e.index) && e.index >= 0 && e.index <= end);
    timing = '独立 trial；事件按 sample_index 显示。主机事件时间不等同于设备采样／像素点亮时间。';
    if (meta.quality.sample_count !== end) warnings.push(`元数据样本数 ${meta.quality.sample_count} 与 EEG 实际 ${end} 不一致。`);
  } else {
    info = session.info; meta = session.meta;
    data = await cache.read(session.eegFile, info.channels); end = data.count;
    const rows = await optionalCSV(session.eventsFile, warnings);
    const boundaries = rows.filter(row => String(row.event).endsWith('_reached_estimate') && /^\d+$/.test(row.estimated_output_monotonic_ns || ''));
    events = boundaries.map(row => ({ index: bisectLeft(data.stamps, BigInt(row.estimated_output_monotonic_ns)),
      label: `${row.stage_kind || ''} ${row.event.includes('_start_') ? 'start' : 'end'}${row.condition ? ` · ${row.condition}` : ''}`,
      source: '主机收包时间对齐驱动输出估算，未验证声学同步' }));
    for (const row of session.trials) {
      try { const [a, b] = indexBounds(row.row, data.count); regions.push({ id: row.id, start: a, end: b,
        label: row.label, condition: row.condition, kind: 'stimulus', targets: row.targets, valid: row.valid }); }
      catch { /* 尚未呈现的 trial 保留在列表，但不绘制虚构的区间。 */ }
    }
    const stages = [];
    for (const row of boundaries.filter(r => r.event.includes('_start_') && ['baseline', 'rest'].includes(r.stage_kind))) {
      if (!String(row.stage_index ?? '').trim()) continue;
      const finish = boundaries.find(r => r.stage_index === row.stage_index && r.stage_kind === row.stage_kind && r.event.includes('_end_'));
      if (!finish || !data.stamps.length) continue;
      const stageStart = bisectLeft(data.stamps, BigInt(row.estimated_output_monotonic_ns));
      const stageEnd = bisectLeft(data.stamps, BigInt(finish.estimated_output_monotonic_ns));
      if (stageEnd <= stageStart) continue;
      stages.push({ id: `stage:${row.stage_index}`, kind: row.stage_kind, targets: [], valid: true,
        start: stageStart, end: stageEnd,
        label: row.stage_kind === 'baseline' ? 'Baseline' : `Rest · ${row.condition || row.trial_id || ''}` });
    }
    regions.push(...stages);
    if (segmentId === 'continuous') label = '连续记录';
    else if (String(segmentId).startsWith('stage:')) {
      const stage = stages.find(s => s.id === segmentId);
      if (!stage || stage.end <= stage.start) throw new Error('该阶段没有已到达边界或可用 EEG');
      start = stage.start; end = stage.end; label = stage.label;
    } else {
      trial = session.trials.find(t => t.id === segmentId) || (segmentId === 'initial' ? session.trials[0] : null);
      if (!trial) throw new Error('trial 不存在');
      [start, end] = indexBounds(trial.row, data.count); label = trial.label; targets = trial.targets;
      if (recordedNumber(trial.row.sample_count) !== end - start) warnings.push('trial 记录的 sample_count 与索引长度不一致。');
    }
    timing = 'trial 使用记录的 [start, end) 索引；事件和阶段按主机收包时间对齐驱动输出估算，未验证声学同步。';
    session.stages = stages;
  }
  if (!info.converted) warnings.push('未找到可确认的 μV 换算，保持原始信号单位。');
  if (data.invalid) warnings.push(`完整文件含 ${data.invalid} 个非有限通道值。`);
  if (trial && !trial.valid) warnings.push(`采集标记无效：${trial.reason || trial.status || '未说明原因'}`);
  return { id: trial?.id || segmentId, sessionId, profile: session.profile, label,
    sessionLabel: session.label, subject: session.subject, fs: info.fs, unit: info.unit,
    scale: info.scale, rawUnit: String(meta.device?.signal_unit || '原始单位'),
    channels: info.channels, values: data.values.map(v => Array.from(v.subarray(start, end), x => Number.isFinite(x) ? x * info.scale : null)),
    sampleCount: end - start, startIndex: start, targets,
    events: events.filter(e => e.index >= start && e.index <= end).map(e => ({ ...e, index: e.index - start })),
    regions: regions.filter(r => r.end > start && r.start < end).sort((a, b) => a.start - b.start || a.end - b.end)
      .map(r => ({ ...r, start: Math.max(start, r.start) - start, end: Math.min(end, r.end) - start })),
    stages: session.stages || [], warnings,
    details: { samplingRate: `${info.fs} Hz（${info.samplingSource}；按记录配置构建样本时间轴）`,
      unitConversion: info.converted ? `raw_device_float × ${info.scale} → μV` : info.unit,
      indexRange: `[${start}, ${end})`, timing,
      hostTiming: `${data.repeats} 对相邻样本共享收包时间；全文件 ${data.count} 样本`,
      collectionStatus: trial ? `${trial.valid ? '采集标记有效' : '采集标记无效'} · ${trial.status}` : String(meta.status || '未记录'),
      qualityNote: '采集有效性标记不代表已确认信号质量或诱发响应。' } };
}

module.exports = { parseCSV, recordedNumber, deviceInfo, targetFrequencies, discover, publicDataset,
  RecordingCache, loadSegment, bisectLeft, indexBounds };
