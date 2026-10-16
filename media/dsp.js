(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EEGDSP = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function fftRadix2(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let length = 2; length <= n; length *= 2) {
      const angle = (inverse ? 2 : -2) * Math.PI / length;
      const wr = Math.cos(angle), wi = Math.sin(angle);
      for (let offset = 0; offset < n; offset += length) {
        let ur = 1, ui = 0;
        for (let j = 0; j < length / 2; j++) {
          const a = offset + j, b = a + length / 2;
          const vr = re[b] * ur - im[b] * ui, vi = re[b] * ui + im[b] * ur;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
          const next = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = next;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  const plans = new Map();
  function fftReal(input) {
    const n = input.length;
    if (n === 0) return { re: new Float64Array(), im: new Float64Array() };
    if ((n & (n - 1)) === 0) {
      const re = Float64Array.from(input), im = new Float64Array(n);
      fftRadix2(re, im); return { re, im };
    }
    // Bluestein 支持 2000/4000 等真实窗长；卷积内部补零不改变输出频率网格。
    let plan = plans.get(n);
    if (!plan) {
      let m = 1; while (m < n * 2 - 1) m *= 2;
      const cos = new Float64Array(n), sin = new Float64Array(n);
      const br = new Float64Array(m), bi = new Float64Array(m);
      for (let i = 0; i < n; i++) {
        const phase = Math.PI * ((i * i) % (2 * n)) / n;
        cos[i] = Math.cos(phase); sin[i] = Math.sin(phase);
        br[i] = cos[i]; bi[i] = sin[i];
        if (i) { br[m - i] = cos[i]; bi[m - i] = sin[i]; }
      }
      fftRadix2(br, bi); plan = { m, cos, sin, br, bi }; plans.set(n, plan);
      if (plans.size > 6) plans.delete(plans.keys().next().value);
    }
    const { m, cos, sin, br, bi } = plan;
    const ar = new Float64Array(m), ai = new Float64Array(m);
    for (let i = 0; i < n; i++) { ar[i] = input[i] * cos[i]; ai[i] = -input[i] * sin[i]; }
    fftRadix2(ar, ai);
    for (let i = 0; i < m; i++) {
      const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r;
    }
    fftRadix2(ar, ai, true);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = ar[i] * cos[i] + ai[i] * sin[i]; im[i] = ai[i] * cos[i] - ar[i] * sin[i]; }
    return { re, im };
  }

  function finiteSpans(columns, start = 0, end = columns[0]?.length || 0) {
    const spans = [];
    let left = -1;
    for (let i = start; i <= end; i++) {
      const finite = i < end && columns.every(c => Number.isFinite(c[i]));
      if (finite && left < 0) left = i;
      else if (!finite && left >= 0) { spans.push([left, i]); left = -1; }
    }
    return spans;
  }

  function welch(columns, fs, options = {}) {
    if (!(fs > 0) || !columns.length || columns.some(c => c.length !== columns[0].length)) throw new Error('PSD 数据或采样率无效');
    const start = Math.max(0, Math.floor(options.start ?? 0)), end = Math.min(columns[0].length, Math.floor(options.end ?? columns[0].length));
    if (end <= start) throw new Error('PSD 选区为空');
    const spans = finiteSpans(columns, start, end);
    const longest = spans.reduce((max, [a, b]) => Math.max(max, b - a), 0);
    const full = options.seconds === undefined || options.seconds === 'full';
    const rounded = value => { const floor = Math.floor(value); return value - floor === 0.5 ? floor + (floor % 2) : Math.round(value); };
    const requested = full ? end - start : rounded(Number(options.seconds) * fs);
    if (!(requested > 0)) throw new Error('PSD 窗长无效');
    const n = Math.min(requested, longest), overlap = Number(options.overlap ?? 0.5);
    if (!(overlap >= 0 && overlap < 1)) throw new Error('重叠比例必须在 [0, 1)');
    const nfft = options.fft === 'script' ? Math.max(4096, 2 ** Math.ceil(Math.log2(Math.max(n, 8)))) : n;
    const noverlap = full ? 0 : Math.max(0, Math.min(n - 1, rounded(n * overlap)));
    const result = { frequencies: [], power: columns.map(() => []), segments: 0, nperseg: n, nfft, noverlap,
      binHz: nfft ? fs / nfft : null, resolutionHz: n ? fs / n : null, windowSeconds: n / fs, start, end, samples: end - start,
      finiteSamples: spans.reduce((sum, [a, b]) => sum + b - a, 0), usedSamples: 0,
      method: full ? 'periodogram' : 'welch', overlap: n ? noverlap / n : 0, warnings: [] };
    const minimum = options.fft === 'script' ? (full ? 1 : 8) : 16;
    if (n < minimum) { result.warnings.push(`连续有效样本不足 ${minimum} 点，无法计算 PSD。`); return result; }
    if (n < requested) result.warnings.push(`可用连续片段不足请求窗长，实际使用 ${(n / fs).toFixed(3)} s。`);
    const hop = n - noverlap;
    const bins = Math.floor(nfft / 2) + 1, window = new Float64Array(n);
    let windowEnergy = 0;
    for (let i = 0; i < n; i++) { window[i] = n === 1 ? 1 : 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); windowEnergy += window[i] ** 2; }
    const power = columns.map(() => new Float64Array(bins)), frame = new Float64Array(nfft);
    for (const [a, b] of spans) {
      const count = b - a < n ? 0 : 1 + Math.floor((b - a - n) / hop);
      if (count) result.usedSamples += n + (count - 1) * hop;
      for (let offset = a; offset + n <= b; offset += hop) {
        for (let c = 0; c < columns.length; c++) {
          let mean = 0; for (let i = 0; i < n; i++) mean += columns[c][offset + i]; mean /= n;
          for (let i = 0; i < n; i++) frame[i] = (columns[c][offset + i] - mean) * window[i];
          const { re, im } = fftReal(frame);
          for (let k = 0; k < bins; k++) {
            const fold = k === 0 || (nfft % 2 === 0 && k === nfft / 2) ? 1 : 2;
            power[c][k] += fold * (re[k] ** 2 + im[k] ** 2) / (fs * windowEnergy);
          }
        }
        result.segments++;
      }
    }
    result.frequencies = Array.from({ length: bins }, (_, k) => k * fs / nfft);
    result.power = power.map(p => Array.from(p, v => v / result.segments));
    if (result.usedSamples < result.samples) result.warnings.push(`分析范围 ${result.samples} 点，实际参与 ${result.usedSamples} 点；缺失段不跨越，未覆盖样本不参与频谱。`);
    return result;
  }

  function butter2(fs, cutoff, highpass) {
    if (!(cutoff > 0 && cutoff < fs / 2)) throw new Error('滤波截止频率必须在 0 与 Nyquist 频率之间');
    const k = Math.tan(Math.PI * cutoff / fs), norm = 1 / (1 + Math.SQRT2 * k + k * k);
    const b0 = (highpass ? 1 : k * k) * norm;
    return [b0, (highpass ? -2 : 2) * b0, b0, 1,
      2 * (k * k - 1) * norm, (1 - Math.SQRT2 * k + k * k) * norm];
  }

  function notch(fs, frequency = 50, q = 30) {
    if (!(frequency > 0 && frequency < fs / 2 && q > 0)) throw new Error('陷波频率或 Q 无效');
    const omega = 2 * Math.PI * frequency / fs, gain = 1 / (1 + Math.tan(omega / q / 2));
    return [gain, -2 * gain * Math.cos(omega), gain, 1, -2 * gain * Math.cos(omega), 2 * gain - 1];
  }

  function sosPass(input, sos) {
    let current = Float64Array.from(input);
    for (const [b0, b1, b2, , a1, a2] of sos) {
      const output = new Float64Array(current.length), dc = (b0 + b1 + b2) / (1 + a1 + a2);
      let z0 = (dc - b0) * current[0], z1 = (b2 - a2 * dc) * current[0];
      for (let i = 0; i < current.length; i++) {
        const x = current[i], y = b0 * x + z0;
        z0 = b1 * x - a1 * y + z1; z1 = b2 * x - a2 * y; output[i] = y;
      }
      current = output;
    }
    return current;
  }

  function sosFiltFilt(input, sos, padlen) {
    if (!sos.length) return Float64Array.from(input);
    const zerosB = sos.filter(s => s[2] === 0).length, zerosA = sos.filter(s => s[5] === 0).length;
    const pad = padlen ?? 3 * (2 * sos.length + 1 - Math.min(zerosB, zerosA));
    if (input.length <= pad) throw new Error(`零相位滤波至少需要 ${pad + 1} 个连续样本`);
    const extended = new Float64Array(input.length + 2 * pad);
    extended.set(input, pad);
    for (let i = 0; i < pad; i++) {
      extended[i] = 2 * input[0] - input[pad - i];
      extended[pad + input.length + i] = 2 * input[input.length - 1] - input[input.length - 2 - i];
    }
    const forward = sosPass(extended, sos); forward.reverse();
    const backward = sosPass(forward, sos); backward.reverse();
    return backward.slice(pad, pad + input.length);
  }

  function ssvepFIR(fs) {
    if (!(fs > 70)) throw new Error('SSVEP 6–35 Hz 滤波要求采样率大于 70 Hz');
    const taps = new Float64Array(801), center = 400, low = 6 / fs, high = 35 / fs;
    let scale = 0;
    for (let i = 0; i < taps.length; i++) {
      const t = i - center;
      taps[i] = (t ? (Math.sin(2 * Math.PI * high * t) - Math.sin(2 * Math.PI * low * t)) / (Math.PI * t) : 2 * (high - low))
        * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / 800));
      scale += taps[i] * Math.cos(Math.PI * (low + high) * t);
    }
    return Float64Array.from(taps, b => b / scale);
  }

  function firPass(input, taps) {
    // 分块 FFT 线性卷积，避免长记录逐点执行 801 阶直接卷积。
    const size = 8192, block = size - taps.length + 1;
    const kr = new Float64Array(size), ki = new Float64Array(size); kr.set(taps); fftRadix2(kr, ki);
    const output = new Float64Array(input.length), re = new Float64Array(size), im = new Float64Array(size);
    for (let a = 0; a < input.length; a += block) {
      const count = Math.min(block, input.length - a); re.fill(0); im.fill(0); re.set(input.subarray(a, a + count)); fftRadix2(re, im);
      for (let k = 0; k < size; k++) { const r = re[k] * kr[k] - im[k] * ki[k]; im[k] = re[k] * ki[k] + im[k] * kr[k]; re[k] = r; }
      fftRadix2(re, im, true);
      for (let k = 0; k < Math.min(count + taps.length - 1, input.length - a); k++) output[a + k] += re[k];
    }
    // 与 scipy.signal.lfilter_zi 的 FIR 稳态初值一致。
    let tail = 0;
    for (let i = taps.length - 1; i > 0; i--) { tail += taps[i]; if (i - 1 < output.length) output[i - 1] += tail * input[0]; }
    return output;
  }

  function ssvepFilter(input, fs, taps = ssvepFIR(fs)) {
    if (input.length < 2) return Float64Array.from(input);
    const sos = [50, 60, 100].filter(f => f < fs / 2).flatMap(f => [notch(fs, f, 12.5), notch(fs, f, 12.5)]);
    const notched = sosFiltFilt(input, sos, Math.min(3 * (2 * sos.length + 1), input.length - 1));
    const pad = Math.min(3 * taps.length, input.length - 1), extended = new Float64Array(input.length + 2 * pad);
    extended.set(notched, pad);
    for (let i = 0; i < pad; i++) {
      extended[i] = 2 * notched[0] - notched[pad - i];
      extended[pad + input.length + i] = 2 * notched[notched.length - 1] - notched[notched.length - 2 - i];
    }
    const forward = firPass(extended, taps); forward.reverse();
    const backward = firPass(forward, taps); backward.reverse();
    const result = backward.slice(pad, pad + input.length), mean = result.reduce((a, b) => a + b, 0) / result.length;
    return Float64Array.from(result, v => v - mean);
  }

  function interpolate(column) {
    let first = column.findIndex(Number.isFinite), count = 0;
    if (first < 0) throw new Error('通道没有有效样本，无法插值');
    for (let i = 0; i < first; i++) { column[i] = column[first]; count++; }
    for (let left = first, i = first + 1; i < column.length; i++) {
      if (!Number.isFinite(column[i])) continue;
      for (let j = left + 1; j < i; j++) { column[j] = column[left] + (column[i] - column[left]) * (j - left) / (i - left); count++; }
      left = i; first = i;
    }
    for (let i = first + 1; i < column.length; i++) { column[i] = column[first]; count++; }
    return count;
  }

  function process(columns, fs, config = {}) {
    const converted = columns.map(c => Float64Array.from(c, v => v === null ? NaN : Number(v)));
    const sos = [], warnings = [];
    if (config.missing === 'interpolate') {
      const count = converted.reduce((sum, column) => sum + interpolate(column), 0);
      if (count) warnings.push(`已按通道线性插值 ${count} 个缺失值，边缘使用最近有效值。`);
    }
    if (config.filter && config.filterKind !== 'ssvep') {
      const low = Number(config.highpass ?? 0.5), high = Number(config.lowpass ?? 60);
      if (!(low > 0 && high > low && high < fs / 2)) throw new Error('带通范围必须满足 0 < 下限 < 上限 < 采样率/2');
      sos.push(butter2(fs, low, true), butter2(fs, high, false));
    }
    if (config.notch && config.filterKind !== 'ssvep') sos.push(notch(fs));
    const taps = config.filter && config.filterKind === 'ssvep' ? ssvepFIR(fs) : null;
    if (sos.length || taps) {
      let omitted = 0;
      for (const column of converted) {
        for (const [a, b] of finiteSpans([column])) {
          try { column.set(taps ? ssvepFilter(column.subarray(a, b), fs, taps) : sosFiltFilt(column.subarray(a, b), sos), a); }
          catch { column.fill(NaN, a, b); omitted++; }
        }
      }
      if (omitted) warnings.push(`${omitted} 个连续片段过短，未参与零相位滤波和 PSD。`);
    }
    return { columns: converted, warnings };
  }

  function weightedAverage(columns, weights = columns.map(() => 1)) {
    if (!columns.length || weights.length !== columns.length || columns.some(c => c.length !== columns[0].length)) {
      throw new Error('平均波形的通道或权重数量无效');
    }
    if (weights.some(w => !Number.isFinite(w) || w < 0)) throw new Error('波形权重必须为非负有限数');
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (!(total > 0) || !Number.isFinite(total)) throw new Error('波形权重总和必须为正数');
    const output = new Float64Array(columns[0].length);
    for (let i = 0; i < output.length; i++) {
      let value = 0;
      for (let c = 0; c < columns.length; c++) {
        if (!weights[c]) continue;
        const sample = columns[c][i];
        if (sample === null || !Number.isFinite(sample)) { value = NaN; break; }
        value += sample * (weights[c] / total);
      }
      output[i] = value;
    }
    return output;
  }

  return { fftReal, welch, finiteSpans, butter2, notch, sosFiltFilt, ssvepFIR, ssvepFilter, process, weightedAverage };
});
