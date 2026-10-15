'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const vscode = acquireVsCodeApi();
  const COLORS = ['#6eb8ac', '#7dabef', '#e2ac70', '#c19ae5', '#dc8492'];
  const state = { dataset: null, session: null, segment: null, columns: null, average: null, psd: null,
    shown: new Set(), view: [0, 1], psdView: null, psdDragging: null, selection: null, pinned: null,
    request: 0, computation: 0, dragging: null, filterWarnings: [], psdError: null, mode: 'ssvep' };
  let worker, resolveWorker, rejectWorker;
  const workerReady = new Promise((resolve, reject) => { resolveWorker = resolve; rejectWorker = reject; });
  // ready 的拒绝在 calculate 中呈现，避免初始化失败成为未处理的 Promise。
  workerReady.catch(() => {});

  const text = (id, value) => { $(id).textContent = value; };
  const format = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : '—';
  const duration = () => (state.segment?.sampleCount || 0) / (state.segment?.fs || 1);
  function notice(message, error = false) {
    $('notice').hidden = !message; $('notice').classList.toggle('error', error); text('notice', message || '');
  }
  function updateWarnings() {
    const messages = [...(state.dataset?.warnings || []), ...(state.segment?.warnings || []),
      ...state.filterWarnings, ...(state.psd?.warnings || [])];
    notice(messages.slice(0, 5).join('\n') + (messages.length > 5 ? `\n另有 ${messages.length - 5} 条导入提示。` : ''));
  }
  function config() {
    return { filter: $('signal-mode').value === 'filtered', notch: $('notch').checked,
      highpass: Number($('highpass').value), lowpass: Number($('lowpass').value) };
  }
  function processingLabel(c = config()) {
    return `${c.filter ? `2阶高通 ${c.highpass} Hz + 2阶低通 ${c.lowpass} Hz，前后向零相位` : '原始信号'}${c.notch ? ' + 50 Hz Q30 零相位陷波' : ''}`;
  }
  function analysisOptions() {
    const fs = state.segment.fs, source = $('psd-source').value;
    const range = source === 'view' ? state.view : source === 'selection' ? state.selection : [0, duration()];
    if (!range) throw new Error('请先在波形上拖动框选一个分析区间');
    return { start: Math.max(0, Math.floor(range[0] * fs)),
      end: Math.min(state.segment.sampleCount, Math.ceil(range[1] * fs)),
      seconds: $('window').value === 'full' ? 'full' : Number($('window').value), overlap: Number($('overlap').value) };
  }

  async function initWorker() {
    try {
      // VS Code 的本地资源由 Webview 文档代理；在文档中读取后合成单文件 Worker。
      // Worker 内再次 fetch/importScripts 会绕过该代理，导致真实宿主资源超时。
      const responses = await Promise.all([fetch(document.body.dataset.dsp), fetch(document.body.dataset.worker)]);
      for (const response of responses) if (!response.ok) throw new Error(`Worker 资源返回 ${response.status}`);
      const scripts = await Promise.all(responses.map(response => response.text()));
      const url = URL.createObjectURL(new Blob([scripts[0], '\n', scripts[1]], { type: 'text/javascript' }));
      worker = new Worker(url); URL.revokeObjectURL(url);
      worker.onerror = event => { rejectWorker(new Error(event.message || '计算 Worker 无法启动')); computationError(event.message || '计算 Worker 无法启动'); };
      worker.onmessage = ({ data: message }) => {
        if (message.type === 'ready') { resolveWorker(); return; }
        if (message.type === 'error' && message.id === 0) { rejectWorker(new Error(message.message)); return; }
        if (message.id !== state.computation) return;
        if (message.type === 'error') { computationError(message.message); return; }
        state.psd = message.psd; state.columns = message.columns; state.average = message.average; state.psdError = null;
        state.filterWarnings = message.warnings || [];
        $('workspace').dataset.state = 'ready'; text('compute-status', '');
        const p = state.psd, start = p.start / state.segment.fs, end = p.end / state.segment.fs;
        text('psd-info', `${format(start, 3)}–${format(end, 3)} s · Δf ${format(p.binHz, 4)} Hz · ${p.segments} 窗`);
        $('export-png').disabled = !state.columns; $('export-csv').disabled = !p.segments; $('pin').disabled = !p.segments;
        drawWave(); drawPSD(); updateWarnings();
      };
      worker.postMessage({ id: 0, type: 'init' });
    } catch (error) { rejectWorker(error); }
  }

  function computationError(message) {
    state.psd = null; state.columns = null; state.average = null; state.psdError = message;
    $('workspace').dataset.state = 'error';
    $('export-png').disabled = true; $('export-csv').disabled = true; $('pin').disabled = true;
    text('compute-status', '计算未完成'); text('psd-info', message); notice(message, true); drawWave(); drawPSD();
  }

  async function calculate(load = false) {
    if (!state.segment) return;
    const id = ++state.computation, segment = state.segment;
    state.psd = null; $('export-csv').disabled = true; $('pin').disabled = true;
    $('workspace').dataset.state = 'computing';
    text('compute-status', '计算中…');
    try {
      const options = analysisOptions(), settings = config();
      await workerReady;
      if (id !== state.computation || segment !== state.segment) return;
      const needsLoad = load || state.workerSource !== segment;
      worker.postMessage({ id, type: needsLoad ? 'load' : 'compute',
        ...(needsLoad ? { source: { values: segment.values, fs: segment.fs } } : {}), config: settings, options });
      state.workerSource = segment;
    } catch (error) { if (id === state.computation) computationError(error.message); }
  }

  function renderSessions() {
    const list = $('session-list'); list.replaceChildren();
    for (const session of state.dataset.sessions) {
      const button = document.createElement('button'); button.className = 'session-button';
      button.classList.toggle('active', session.id === state.session?.id);
      const title = document.createElement('strong'); title.textContent = `${session.subject || '未知被试'} · ${session.profile.toUpperCase()}`;
      const subtitle = document.createElement('small'); subtitle.textContent = `${session.date || ''} · ${session.trials.length} trial · ${session.label}`;
      button.title = session.label; button.append(title, subtitle);
      button.addEventListener('click', () => selectSession(session.id)); list.append(button);
    }
    text('record-count', state.dataset.sessions.length);
    document.querySelector('.trial-browser').hidden = false;
  }

  function segmentEntries() {
    if (!state.session) return [];
    const entries = [];
    if (state.session.profile === 'assr') {
      entries.push({ id: 'continuous', label: '连续记录', kind: 'recording', valid: true });
      for (const stage of state.session.stages || []) entries.push({ ...stage, valid: true });
    }
    entries.push(...state.session.trials);
    return entries;
  }
  function filteredEntries() {
    const query = $('search').value.trim().toLowerCase();
    return segmentEntries().filter(t => (!query || `${t.label} ${t.condition || ''} ${t.trial || ''}`.toLowerCase().includes(query)) &&
      (!$('valid-only').checked || t.valid));
  }
  function renderTrials() {
    const list = $('trial-list'); list.replaceChildren();
    let lastGroup = '';
    for (const entry of filteredEntries()) {
      const group = entry.kind === 'recording' ? '记录概览' : ['baseline', 'rest'].includes(entry.kind) ? '实验阶段' : entry.condition || 'Trials';
      if (group !== lastGroup) {
        const title = document.createElement('div'); title.className = 'group-heading'; title.textContent = group;
        list.append(title); lastGroup = group;
      }
      const button = document.createElement('button'); button.className = 'trial-button';
      button.setAttribute('role', 'listitem'); button.dataset.segmentId = entry.id;
      button.classList.toggle('active', entry.id === state.requestedId);
      const dot = document.createElement('span'); dot.className = `trial-dot${entry.valid ? '' : ' invalid'}`;
      const title = document.createElement('span'); title.textContent = entry.label;
      const indicator = document.createElement('small'); indicator.textContent = entry.kind === 'stimulus' ? '↗' : '·';
      button.title = entry.valid ? entry.label : `${entry.label} · ${entry.reason || entry.status || '采集标记无效'}`;
      button.append(dot, title, indicator); button.addEventListener('click', () => requestSegment(entry.id)); list.append(button);
    }
    if (!list.children.length) { const hint = document.createElement('p'); hint.className = 'muted empty-hint'; hint.textContent = '没有匹配的区间'; list.append(hint); }
    updateNavigation();
  }

  function selectSession(id, initialTrial) {
    state.session = state.dataset.sessions.find(s => s.id === id) || state.dataset.sessions[0];
    state.mode = state.session.profile; $('profile').value = state.mode;
    $('search').value = ''; renderSessions();
    requestSegment(initialTrial || state.session.trials[0]?.id || 'continuous');
  }
  function requestSegment(id) {
    finishPSDPan();
    state.request++; state.computation++; state.requestedId = id;
    state.segment = null; state.columns = null; state.average = null; state.psd = null; state.selection = null;
    state.filterWarnings = []; state.psdError = null;
    $('workspace').hidden = false; $('workspace').dataset.state = 'loading';
    text('record-title', '正在读取 EEG…'); text('record-subtitle', state.session.label);
    text('breadcrumb', `${state.session.subject || ''} / ${state.session.profile.toUpperCase()}`);
    text('compute-status', '读取中…'); text('psd-info', ''); text('selection-label', ''); $('selection-footer').hidden = true;
    for (const id of ['export-png', 'export-csv', 'pin', 'zoom-selection', 'clear-selection']) $(id).disabled = true;
    $('channels').replaceChildren(); $('details').replaceChildren();
    renderTrials(); drawWave(); drawPSD();
    vscode.postMessage({ type: 'segment', sessionId: state.session.id, segmentId: id, requestId: state.request });
  }

  function acceptSegment(segment) {
    state.segment = segment; state.selection = null;
    state.view = [0, segment.profile === 'assr' && segment.id === 'continuous' ? Math.min(12, duration()) : duration()];
    if (segment.stages?.length) state.session.stages = segment.stages;
    state.shown = new Set(segment.channels);
    $('psd-source').value = 'segment';
    text('record-title', segment.label); text('record-subtitle', `${segment.sessionLabel} · ${segment.sampleCount.toLocaleString()} 样本 · ${format(duration(), 3)} s`);
    text('wave-unit', segment.unit);
    const channels = $('channels'); channels.replaceChildren();
    segment.channels.forEach((channel, index) => {
      const label = document.createElement('label'); label.className = `checkbox channel-label channel-${index % 3}`;
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.setAttribute('aria-label', `显示 ${channel}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.shown.add(channel); else state.shown.delete(channel);
        // 至少保留一个通道，避免没有含义的空图。
        if (!state.shown.size) { state.shown.add(channel); checkbox.checked = true; }
        drawWave(); drawPSD();
      });
      label.append(checkbox, document.createTextNode(channel)); channels.append(label);
    });
    renderTrials(); renderDetails(); updateView(); updatePinInfo(); updateWarnings(); calculate(true);
  }

  function renderDetails() {
    const container = $('details'); container.replaceChildren();
    const labels = { samplingRate: '采样率', unitConversion: '单位换算', indexRange: '源文件样本区间', timing: '事件对齐', hostTiming: '收包时间', collectionStatus: '采集标记', qualityNote: '标记含义' };
    for (const [key, label] of Object.entries(labels)) {
      const row = document.createElement('div'); row.className = 'detail-row';
      const title = document.createElement('span'), value = document.createElement('span'); title.textContent = label; value.textContent = state.segment.details[key] || '未记录';
      row.append(title, value); container.append(row);
    }
    const row = document.createElement('div'); row.className = 'detail-row';
    const title = document.createElement('span'), value = document.createElement('span'); title.textContent = '当前信号处理'; value.id = 'processing-detail'; value.textContent = processingLabel();
    row.append(title, value); container.append(row);
    if (state.segment.events.length) {
      const list = document.createElement('div'); list.className = 'event-list';
      for (const event of state.segment.events) {
        const button = document.createElement('button'); const time = event.index / state.segment.fs;
        button.textContent = `${format(time, 3)} s · ${event.label}`; button.title = event.source;
        button.addEventListener('click', () => { const width = Math.min(4, duration()); setView(time - width / 2, time + width / 2); }); list.append(button);
      }
      container.append(list);
    }
  }
  function updateNavigation() {
    const entries = filteredEntries(), index = entries.findIndex(t => t.id === state.requestedId);
    $('previous').disabled = index <= 0; $('next').disabled = index < 0 || index >= entries.length - 1;
  }
  function navigate(delta) {
    const entries = filteredEntries(), index = entries.findIndex(t => t.id === state.requestedId), next = entries[index + delta];
    if (next) requestSegment(next.id);
  }
  function updateView() {
    if (!state.segment) return;
    const total = duration(), [a, b] = state.view;
    text('view-range', `${format(a)}–${format(b)} s`);
    $('pan').value = b - a >= total ? '0' : String(Math.round(a / (total - (b - a)) * 1000));
    $('pan').disabled = b - a >= total;
    const selection = state.selection;
    $('selection-footer').hidden = !selection;
    text('selection-label', selection ? `${format(selection[0], 3)}–${format(selection[1], 3)} s` : '');
    $('zoom-selection').disabled = !selection; $('clear-selection').disabled = !selection;
    drawWave();
  }
  function setView(a, b, recompute = true) {
    if (!state.segment) return;
    const total = duration(), width = Math.max(Math.min(0.05, total), Math.min(total, b - a));
    const left = Math.max(0, Math.min(total - width, a)); state.view = [left, left + width]; updateView();
    if (recompute && $('psd-source').value === 'view') calculate();
  }

  function prepareCanvas(id) {
    const canvas = $(id), rect = canvas.getBoundingClientRect(), scale = window.devicePixelRatio || 1;
    const width = Math.max(100, rect.width), height = Math.max(100, rect.height);
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) { canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale); }
    const ctx = canvas.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, width, height);
    const style = getComputedStyle(document.body), muted = style.getPropertyValue('--muted').trim() || '#8995aa';
    const background = style.getPropertyValue('--bg').trim();
    ctx.fillStyle = background.startsWith('#') || background.startsWith('rgb') ? background : getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, width, height); ctx.font = '10px -apple-system, sans-serif';
    return { canvas, ctx, width, height, muted, border: style.getPropertyValue('--border').trim() || '#2a3342', left: 63, right: width - 19, top: 24, bottom: height - 29 };
  }
  function ticks(min, max, count = 6) {
    if (!(max > min)) return [min];
    const raw = (max - min) / count, power = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].find(s => s * power >= raw) * power;
    const values = []; for (let x = Math.ceil(min / step) * step; x <= max + step * 1e-6 && values.length < 100; x += step) values.push(x);
    return values;
  }
  function line(ctx, x1, y1, x2, y2, color, dash = []) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
  }
  function canvasEmpty(p, message) { p.ctx.fillStyle = p.muted; p.ctx.textAlign = 'center'; p.ctx.fillText(message, p.width / 2, p.height / 2); }
  function shownIndices() { return state.segment?.channels.map((c, i) => state.shown.has(c) ? i : -1).filter(i => i >= 0) || []; }

  function drawWave() {
    const p = prepareCanvas('wave'), { ctx, left, right, top, bottom, muted, border } = p;
    if (!state.columns || !state.average || !state.segment) { canvasEmpty(p, state.psdError || ''); return; }
    const [a, b] = state.view, fs = state.segment.fs, width = right - left;
    const toX = t => left + (t - a) / (b - a) * width;
    for (const region of state.segment.regions) {
      const begin = Math.max(a, region.start / fs), finish = Math.min(b, region.end / fs);
      if (finish <= begin) continue;
      ctx.fillStyle = region.kind === 'rest' ? '#7dabef0b' : '#6eb8ac0b'; ctx.fillRect(toX(begin), top, toX(finish) - toX(begin), bottom - top);
      if (toX(finish) - toX(begin) > 55) { ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.fillText(region.label || '', toX(begin) + 5, 14); }
    }
    for (const t of ticks(a, b, Math.max(2, width / 120))) {
      const x = toX(t); line(ctx, x, top, x, bottom, border); ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.fillText(`${format(t, b - a < 1 ? 2 : 1)} s`, x, bottom + 17);
    }
    const rows = $('wave-mode').value === 'average'
      ? [{ values: state.average, label: '平均', color: COLORS[0] }]
      : shownIndices().map(c => ({ values: state.columns[c], label: state.segment.channels[c], color: COLORS[c % COLORS.length] }));
    const lane = (bottom - top) / rows.length;
    const first = Math.max(0, Math.floor(a * fs)), end = Math.min(state.segment.sampleCount, Math.ceil(b * fs));
    const stride = Math.max(1, Math.ceil((end - first) / width));
    rows.forEach(({ values, label, color }, j) => {
      const mid = top + lane * (j + 0.5);
      let center = 0, count = 0;
      if ($('center-wave').checked) { for (let i = first; i < end; i++) if (Number.isFinite(values[i])) { center += values[i]; count++; } center = count ? center / count : 0; }
      let limit = Number($('amplitude').value);
      if (!Number.isFinite(limit) || limit <= 0) {
        limit = 1; for (let i = first; i < end; i++) if (Number.isFinite(values[i])) limit = Math.max(limit, Math.abs(values[i] - center)); limit *= 1.1;
      }
      const scale = (lane / 2 - 15) / limit;
      line(ctx, left, mid, right, mid, border, [2, 4]);
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(label, 10, mid - 5);
      ctx.fillStyle = muted; ctx.font = '9px -apple-system, sans-serif'; ctx.fillText(`±${limit >= 10 ? Math.round(limit) : format(limit, 1)}`, 10, mid + 11); ctx.font = '10px -apple-system, sans-serif';
      ctx.save(); ctx.beginPath(); ctx.rect(left, top + j * lane, width, lane); ctx.clip(); ctx.strokeStyle = color; ctx.lineWidth = 1.1;
      ctx.beginPath(); let connected = false;
      // 每个像素桶保留极值；缺口不连线。PSD 从完整数据计算。
      for (let i = first; i < end; i += stride) {
        let min = Infinity, max = -Infinity, minIndex = i, maxIndex = i, gap = false;
        const finish = Math.min(end, i + stride);
        for (let k = i; k < finish; k++) {
          if (!Number.isFinite(values[k])) { gap = true; continue; }
          if (values[k] < min) { min = values[k]; minIndex = k; }
          if (values[k] > max) { max = values[k]; maxIndex = k; }
        }
        if (gap || min === Infinity) { connected = false; continue; }
        const points = minIndex < maxIndex ? [[minIndex, min], [maxIndex, max]] : [[maxIndex, max], [minIndex, min]];
        for (const [index, value] of points) {
          const x = toX(index / fs), y = mid - (value - center) * scale;
          if (connected) ctx.lineTo(x, y); else { ctx.moveTo(x, y); connected = true; }
        }
      }
      ctx.stroke(); ctx.restore();
    });
    for (const event of state.segment.events) {
      const t = event.index / fs; if (t < a || t > b) continue;
      const x = toX(t); line(ctx, x, top, x, bottom, '#a6b3c177', [3, 4]);
    }
    if (state.selection) {
      const x1 = Math.max(left, toX(state.selection[0])), x2 = Math.min(right, toX(state.selection[1]));
      if (x2 > x1) { ctx.fillStyle = '#6eb8ac25'; ctx.fillRect(x1, top, x2 - x1, bottom - top); line(ctx, x1, top, x1, bottom, '#6eb8ac'); line(ctx, x2, top, x2, bottom, '#6eb8ac'); }
    }
  }

  function frequencyBounds() {
    const limit = (state.segment?.fs || 500) / 2;
    const [a, b] = state.psdView || [0, Math.min(limit, 60)];
    // 最窄显示两个实际频率间隔；放大不改变 Welch 的频率分辨率。
    const width = Math.min(limit, Math.max(state.psd?.binHz * 2 || 0, b - a));
    const start = Math.max(0, Math.min(limit - width, (a + b - width) / 2));
    return [start, start + width];
  }
  function setPSDView(a, b) {
    if (!state.psd?.segments || !state.segment) return;
    state.psdView = [a, b]; state.psdView = frequencyBounds();
    $('psd-tooltip').hidden = true; drawPSD();
  }
  function resetPSDView() {
    if (state.segment) setPSDView(0, state.segment.fs / 2);
  }
  function psdPointer(event) {
    const rect = $('psd').getBoundingClientRect();
    return { x: event.clientX - rect.left, width: rect.width - 82,
      fraction: Math.max(0, Math.min(1, (event.clientX - rect.left - 63) / (rect.width - 82))) };
  }
  function finishPSDPan() {
    const drag = state.psdDragging; state.psdDragging = null;
    $('psd').classList.remove('dragging');
    if (drag && $('psd').hasPointerCapture(drag.pointerId)) $('psd').releasePointerCapture(drag.pointerId);
  }
  function visibleSpectrum(curve, minF, maxF, convert) {
    const points = [];
    for (let i = 0; i < curve.f.length; i++) {
      const f = curve.f[i], y = Number.isFinite(curve.p[i]) ? convert(curve.p[i]) : NaN;
      // 保留边界处的连线，放大后不会因相邻频点位于视口外而截断曲线。
      if (i && curve.f[i - 1] < minF && f > minF && Number.isFinite(curve.p[i - 1]) && Number.isFinite(y)) {
        const previous = convert(curve.p[i - 1]);
        points.push({ f: minF, y: previous + (y - previous) * (minF - curve.f[i - 1]) / (f - curve.f[i - 1]) });
      }
      if (f >= minF && f <= maxF) points.push({ f, y, bin: true });
      if (i && f > maxF) {
        if (curve.f[i - 1] < maxF && Number.isFinite(curve.p[i - 1]) && Number.isFinite(y)) {
          const previous = convert(curve.p[i - 1]);
          points.push({ f: maxF, y: previous + (y - previous) * (maxF - curve.f[i - 1]) / (f - curve.f[i - 1]) });
        }
        break;
      }
    }
    return points;
  }
  function compatiblePin() { return state.pinned && state.segment && state.pinned.unit === state.segment.unit; }
  function drawPSD() {
    const p = prepareCanvas('psd'), { ctx, left, right, top, bottom, muted, border } = p;
    $('reset-psd').disabled = !state.psd?.segments;
    if (!state.psd?.segments || !state.segment) { canvasEmpty(p, state.psdError || (state.psd ? state.psd.warnings.join(' ') : '等待频谱计算…')); return; }
    const [minF, maxF] = frequencyBounds(), logarithmic = $('psd-scale').value === 'db', indices = shownIndices();
    p.canvas.setAttribute('aria-label', `各通道 Welch PSD，${format(minF, 4)}–${format(maxF, 4)} Hz`);
    const convert = y => logarithmic ? 10 * Math.log10(Math.max(1e-30, y)) : y;
    const curves = indices.map(c => ({ f: state.psd.frequencies, p: state.psd.power[c], color: COLORS[c % COLORS.length], dash: [] }));
    if (compatiblePin()) for (const c of indices) {
      const pinIndex = state.pinned.channels.indexOf(state.segment.channels[c]);
      if (pinIndex >= 0) curves.push({ f: state.pinned.psd.frequencies, p: state.pinned.psd.power[pinIndex], color: COLORS[c % COLORS.length], dash: [5, 4] });
    }
    let minY = Infinity, maxY = -Infinity;
    for (const curve of curves) {
      curve.points = visibleSpectrum(curve, minF, maxF, convert);
      for (const { y } of curve.points) if (Number.isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    if (!Number.isFinite(minY)) { canvasEmpty(p, '当前频率范围内没有 PSD 频点'); return; }
    if (logarithmic) { const span = Math.max(10, maxY - minY); minY -= span * 0.08; maxY += span * 0.08; }
    else { minY = 0; maxY = maxY > 0 ? maxY * 1.1 : 1; }
    if (maxY <= minY) maxY = minY + 1;
    const toX = f => left + (f - minF) / (maxF - minF) * (right - left), toY = y => bottom - (y - minY) / (maxY - minY) * (bottom - top);
    const xTicks = ticks(minF, maxF, Math.max(2, (right - left) / 105));
    const digits = Math.min(6, Math.max(0, Math.ceil(-Math.log10((xTicks[1] - xTicks[0]) || (maxF - minF))) + 1));
    for (const f of xTicks) {
      const x = toX(f); line(ctx, x, top, x, bottom, border); ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.fillText(`${format(f, digits)} Hz`, x, bottom + 17);
    }
    for (const y of ticks(minY, maxY, 4)) {
      const screen = bottom - (y - minY) / (maxY - minY) * (bottom - top); line(ctx, left, screen, right, screen, border);
      ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.fillText(logarithmic ? format(y, 0) : y.toExponential(1), left - 8, screen + 3);
    }
    const unit = state.segment.unit === 'μV' ? 'μV²/Hz' : `${state.segment.unit}²/Hz`;
    ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.fillText(logarithmic ? `dB re 1 ${unit}` : unit, 10, 12);
    const markers = [];
    for (const frequency of state.segment.targets) for (let harmonic = 1; harmonic <= 3; harmonic++) {
      const f = frequency * harmonic; if (f >= minF && f <= maxF) markers.push({ f, label: harmonic === 1 ? `${frequency} Hz` : `${harmonic}f (${format(f, 1)})` });
    }
    let lastLabelX = -Infinity;
    for (const marker of markers.sort((a, b) => a.f - b.f)) {
      const x = toX(marker.f); line(ctx, x, top, x, bottom, '#6eb8ac88', [3, 4]);
      if (x - lastLabelX > 58) { ctx.fillStyle = '#6eb8ac'; ctx.textAlign = 'center'; ctx.fillText(marker.label, Math.min(right - 20, Math.max(left + 22, x)), 12); lastLabelX = x; }
    }
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    for (const curve of curves) {
      ctx.strokeStyle = curve.color; ctx.lineWidth = curve.dash.length ? 1.1 : 1.4; ctx.setLineDash(curve.dash); ctx.globalAlpha = curve.dash.length ? 0.6 : 1;
      ctx.beginPath(); let started = false;
      for (const point of curve.points) {
        if (!Number.isFinite(point.y)) { started = false; continue; }
        const x = toX(point.f), y = toY(point.y); if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
      ctx.stroke();
      if ((curve.f[1] - curve.f[0]) / (maxF - minF) * (right - left) >= 12) {
        ctx.fillStyle = curve.color;
        for (const point of curve.points) if (point.bin && Number.isFinite(point.y)) {
          ctx.beginPath(); ctx.arc(toX(point.f), toY(point.y), 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.restore(); ctx.setLineDash([]);
  }

  function updatePinInfo() {
    const pin = state.pinned; $('clear-pin').hidden = !pin; $('pin-info').hidden = !pin;
    if (pin) text('pin-info', `虚线 A：${pin.sessionLabel} / ${pin.label} · ${processingLabel(pin.config)} · 窗长 ${format(pin.psd.windowSeconds, 3)} s${compatiblePin() ? '' : ' · 单位不同，暂不叠加'}`);
  }

  function canvasTime(event) {
    const rect = $('wave').getBoundingClientRect(), x = Math.max(63, Math.min(rect.width - 19, event.clientX - rect.left));
    return state.view[0] + (x - 63) / (rect.width - 82) * (state.view[1] - state.view[0]);
  }
  function tooltip(id, event, content) {
    const target = $(id), parent = target.parentElement.getBoundingClientRect();
    target.hidden = false; target.textContent = content;
    target.style.left = `${Math.max(0, Math.min(parent.width - 190, event.clientX - parent.left + 12))}px`;
    target.style.top = `${Math.max(5, Math.min(parent.height - 75, event.clientY - parent.top + 10))}px`;
  }

  $('wave').addEventListener('pointerdown', event => {
    if (!state.segment || !state.columns || event.button !== 0) return;
    const t = canvasTime(event); state.dragging = { t, pointerId: event.pointerId }; state.selection = [t, t];
    $('wave').setPointerCapture(event.pointerId); $('wave-tooltip').hidden = true;
  });
  $('wave').addEventListener('pointermove', event => {
    if (!state.segment || !state.columns) return;
    const t = canvasTime(event);
    if (state.dragging) { state.selection = [Math.min(state.dragging.t, t), Math.max(state.dragging.t, t)]; updateView(); return; }
    const index = Math.max(0, Math.min(state.segment.sampleCount - 1, Math.round(t * state.segment.fs)));
    const values = $('wave-mode').value === 'average'
      ? [`平均  ${format(state.average[index], 3)} ${state.segment.unit}`]
      : shownIndices().map(c => `${state.segment.channels[c]}  ${format(state.columns[c][index], 3)} ${state.segment.unit}`);
    tooltip('wave-tooltip', event, [`${format(index / state.segment.fs, 3)} s`, ...values].join('\n'));
  });
  function finishSelection(event) {
    if (!state.dragging) return;
    if (event.type === 'pointercancel' || !state.selection || state.selection[1] - state.selection[0] < 1 / state.segment.fs) state.selection = null;
    state.dragging = null;
    if ($('wave').hasPointerCapture(event.pointerId)) $('wave').releasePointerCapture(event.pointerId);
    $('psd-source').value = state.selection ? 'selection' : 'segment'; updateView(); calculate();
  }
  $('wave').addEventListener('pointerup', finishSelection); $('wave').addEventListener('pointercancel', finishSelection);
  $('wave').addEventListener('pointerleave', () => { $('wave-tooltip').hidden = true; });
  $('wave').addEventListener('wheel', event => {
    if (!state.segment) return; event.preventDefault();
    const pivot = canvasTime(event), factor = event.deltaY > 0 ? 1.3 : 1 / 1.3;
    setView(pivot - (pivot - state.view[0]) * factor, pivot + (state.view[1] - pivot) * factor);
  }, { passive: false });
  $('wave').addEventListener('dblclick', () => setView(0, duration()));
  $('psd').addEventListener('wheel', event => {
    if (!state.psd?.segments || !state.segment || !event.deltaY) return;
    event.preventDefault(); finishPSDPan();
    const [a, b] = frequencyBounds(), { fraction } = psdPointer(event);
    const pivot = a + fraction * (b - a), factor = event.deltaY > 0 ? 1.3 : 1 / 1.3;
    const width = Math.min(state.segment.fs / 2, Math.max(state.psd.binHz * 2, (b - a) * factor));
    setPSDView(pivot - fraction * width, pivot + (1 - fraction) * width);
  }, { passive: false });
  $('psd').addEventListener('pointerdown', event => {
    if (!state.psd?.segments || !state.segment || event.button !== 0) return;
    const { x, width } = psdPointer(event);
    if (x < 63 || x > 63 + width) return;
    state.psdDragging = { x, width, view: frequencyBounds(), pointerId: event.pointerId };
    $('psd').setPointerCapture(event.pointerId); $('psd').classList.add('dragging'); $('psd-tooltip').hidden = true;
  });
  $('psd').addEventListener('pointermove', event => {
    if (!state.psd?.segments || !state.segment) return;
    if (state.psdDragging) {
      const { x, width, view: [a, b] } = state.psdDragging;
      const delta = (x - psdPointer(event).x) / width * (b - a);
      setPSDView(a + delta, b + delta); return;
    }
    const [a, b] = frequencyBounds(), f = a + psdPointer(event).fraction * (b - a);
    const i = Math.max(0, Math.min(state.psd.frequencies.length - 1, Math.round(f / state.psd.binHz)));
    const logarithmic = $('psd-scale').value === 'db', unit = state.segment.unit === 'μV' ? 'μV²/Hz' : `${state.segment.unit}²/Hz`;
    tooltip('psd-tooltip', event, [`${format(state.psd.frequencies[i], 4)} Hz`, ...shownIndices().map(c => {
      const value = state.psd.power[c][i]; return `${state.segment.channels[c]}  ${logarithmic ? format(10 * Math.log10(Math.max(1e-30, value)), 2) + ' dB' : value.toExponential(4) + ' ' + unit}`;
    })].join('\n'));
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('psd').addEventListener(event, finishPSDPan);
  $('psd').addEventListener('dblclick', resetPSDView);
  $('reset-psd').addEventListener('click', resetPSDView);
  $('psd').addEventListener('pointerleave', () => { $('psd-tooltip').hidden = true; });

  $('profile').addEventListener('change', () => { state.mode = $('profile').value; vscode.postMessage({ type: 'profile', profile: state.mode }); });
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('search').addEventListener('input', renderTrials); $('valid-only').addEventListener('change', renderTrials);
  $('previous').addEventListener('click', () => navigate(-1)); $('next').addEventListener('click', () => navigate(1));
  window.addEventListener('keydown', event => {
    if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1); }
    if (event.key === 'Escape' && state.selection) clearSelection();
  });
  for (const id of ['signal-mode', 'notch', 'highpass', 'lowpass']) $(id).addEventListener('change', () => {
    document.querySelector('.filter-control').hidden = $('signal-mode').value !== 'filtered';
    if ($('processing-detail')) text('processing-detail', processingLabel());
    state.columns = null; updateView(); calculate();
  });
  for (const id of ['center-wave', 'amplitude']) $(id).addEventListener('change', drawWave);
  $('wave-mode').addEventListener('change', () => {
    $('wave-wrap').dataset.view = $('wave-mode').value;
    $('wave-tooltip').hidden = true;
    drawWave();
  });
  for (const id of ['psd-source', 'window', 'overlap']) $(id).addEventListener('change', () => calculate());
  $('psd-scale').addEventListener('change', drawPSD);
  $('zoom-in').addEventListener('click', () => { const [a, b] = state.view; setView(a + (b - a) / 4, b - (b - a) / 4); });
  $('zoom-out').addEventListener('click', () => { const [a, b] = state.view; setView(a - (b - a) / 2, b + (b - a) / 2); });
  $('reset-view').addEventListener('click', () => setView(0, duration()));
  $('zoom-selection').addEventListener('click', () => { if (state.selection) setView(...state.selection); });
  function clearSelection() { state.selection = null; if ($('psd-source').value === 'selection') $('psd-source').value = 'segment'; updateView(); calculate(); }
  $('clear-selection').addEventListener('click', clearSelection);
  function pan(delta) { const [a, b] = state.view; setView(a + delta * (b - a), b + delta * (b - a)); }
  $('pan-left').addEventListener('click', () => pan(-0.75)); $('pan-right').addEventListener('click', () => pan(0.75));
  $('pan').addEventListener('input', () => { const width = state.view[1] - state.view[0], a = Number($('pan').value) / 1000 * (duration() - width); setView(a, a + width, false); });
  $('pan').addEventListener('change', () => { if ($('psd-source').value === 'view') calculate(); });
  $('pin').addEventListener('click', () => {
    if (!state.psd?.segments) return;
    state.pinned = { psd: state.psd, label: state.segment.label, sessionLabel: state.segment.sessionLabel,
      unit: state.segment.unit, channels: [...state.segment.channels], config: config() };
    updatePinInfo(); drawPSD();
  });
  $('clear-pin').addEventListener('click', () => { state.pinned = null; updatePinInfo(); drawPSD(); });

  function csvCell(value) {
    const raw = String(value); return '"' + (/^[=+@-]/.test(raw) ? "'" + raw : raw).replaceAll('"', '""') + '"';
  }
  $('export-csv').addEventListener('click', () => {
    if (!state.psd?.segments) return;
    const p = state.psd, s = state.segment;
    const unit = s.unit === 'μV' ? 'uV2_per_Hz' : `${s.unit}2_per_Hz`;
    const header = ['frequency_hz', ...s.channels.map(c => `${c}_PSD_${unit}`), 'fs_hz', 'source_start_index', 'source_end_index',
      'nperseg', 'averaged_segments', 'window', 'overlap_fraction', 'processing', 'session', 'segment'];
    const rows = [header.map(csvCell).join(',')];
    p.frequencies.forEach((f, i) => rows.push([f, ...p.power.map(c => c[i]), s.fs, s.startIndex + p.start, s.startIndex + p.end,
      p.nperseg, p.segments, 'hann_periodic', Number($('overlap').value), processingLabel(), s.sessionLabel, s.label].map((v, j) => j <= s.channels.length + 5 ? String(v) : csvCell(v)).join(',')));
    vscode.postMessage({ type: 'export', format: 'csv', name: `${s.subject}_${s.label}_PSD`, content: rows.join('\r\n') });
  });
  $('export-png').addEventListener('click', () => {
    if (!state.segment || !state.columns || !state.psd) return;
    const wave = $('wave'), psd = $('psd'), output = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1, padding = 24 * ratio;
    output.width = Math.max(wave.width, psd.width) + padding * 2; output.height = wave.height + psd.height + 160 * ratio;
    const ctx = output.getContext('2d'); ctx.fillStyle = getComputedStyle(document.body).backgroundColor; ctx.fillRect(0, 0, output.width, output.height);
    ctx.fillStyle = getComputedStyle(document.body).color; ctx.font = `${16 * ratio}px sans-serif`;
    ctx.fillText(`${state.segment.sessionLabel} / ${state.segment.label}`, padding, 30 * ratio);
    const waveLabel = $('wave-mode').value === 'average' ? '三通道平均 (1:1:1)' : '分别显示';
    ctx.font = `${10 * ratio}px sans-serif`; ctx.fillText(`EEG (${state.segment.unit}) · ${waveLabel} · ${processingLabel()}`, padding, 52 * ratio);
    ctx.drawImage(wave, padding, 65 * ratio); ctx.drawImage(psd, padding, wave.height + 95 * ratio);
    ctx.fillText($('psd-info').textContent, padding, output.height - 28 * ratio);
    ctx.fillText(`PSD ${$('psd-scale').value === 'db' ? 'dB' : '线性'} · ${$('psd-source').selectedOptions[0].textContent}${state.pinned ? ` · 虚线 A: ${state.pinned.label}` : ''}`, padding, output.height - 12 * ratio);
    vscode.postMessage({ type: 'export', format: 'png', name: `${state.segment.subject}_${state.segment.label}_EEG_PSD`, content: output.toDataURL('image/png') });
  });

  window.addEventListener('message', ({ data: message }) => {
    if (message.type === 'dataset') {
      state.dataset = message.data; state.mode = message.data.profile; $('profile').value = state.mode;
      selectSession(message.data.initialSession, message.data.initialTrial);
    } else if (message.type === 'segment' && message.requestId === state.request) acceptSegment(message.data);
    else if (message.type === 'loading') { state.request++; state.computation++; $('workspace').dataset.state = 'loading'; notice(''); }
    else if (message.type === 'error') {
      if (message.scope === 'segment' && message.requestId !== state.request) return;
      if (message.scope === 'segment') { state.segment = null; state.columns = null; state.average = null; state.psd = null; state.psdError = message.message; text('record-title', '当前区间无法读取'); drawWave(); drawPSD(); }
      else if (state.session) { state.mode = state.session.profile; $('profile').value = state.mode; }
      notice(message.message, true);
    }
  });
  const observer = new ResizeObserver(() => { drawWave(); drawPSD(); }); observer.observe($('wave-wrap')); observer.observe($('psd-wrap'));
  new MutationObserver(() => { drawWave(); drawPSD(); }).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  window.addEventListener('beforeunload', () => { worker?.terminate(); observer.disconnect(); });
  initWorker(); vscode.postMessage({ type: 'ready' });
})();
