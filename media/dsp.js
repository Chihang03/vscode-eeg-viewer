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
    const requested = options.seconds === 'full' ? end - start : Math.round(Number(options.seconds ?? 4) * fs);
    if (!(requested > 0)) throw new Error('PSD 窗长无效');
    const n = Math.min(requested, longest), overlap = Number(options.overlap ?? 0.5);
    if (!(overlap >= 0 && overlap < 1)) throw new Error('重叠比例必须在 [0, 1)');
    const result = { frequencies: [], power: columns.map(() => []), segments: 0, nperseg: n,
      binHz: n ? fs / n : null, windowSeconds: n / fs, start, end, samples: end - start,
      finiteSamples: spans.reduce((sum, [a, b]) => sum + b - a, 0), warnings: [] };
    if (n < 16) { result.warnings.push('连续有效样本不足 16 点，无法计算 PSD。'); return result; }
    if (n < requested) result.warnings.push(`可用连续片段不足请求窗长，实际使用 ${(n / fs).toFixed(3)} s。`);
    const hop = n - Math.min(n - 1, Math.round(n * overlap));
    const bins = Math.floor(n / 2) + 1, window = new Float64Array(n);
    let windowEnergy = 0;
    for (let i = 0; i < n; i++) { window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); windowEnergy += window[i] ** 2; }
    const power = columns.map(() => new Float64Array(bins)), frame = new Float64Array(n);
    for (const [a, b] of spans) {
      for (let offset = a; offset + n <= b; offset += hop) {
        for (let c = 0; c < columns.length; c++) {
          let mean = 0; for (let i = 0; i < n; i++) mean += columns[c][offset + i]; mean /= n;
          for (let i = 0; i < n; i++) frame[i] = (columns[c][offset + i] - mean) * window[i];
          const { re, im } = fftReal(frame);
          for (let k = 0; k < bins; k++) {
            const fold = k === 0 || (n % 2 === 0 && k === n / 2) ? 1 : 2;
            power[c][k] += fold * (re[k] ** 2 + im[k] ** 2) / (fs * windowEnergy);
          }
        }
        result.segments++;
      }
    }
    result.frequencies = Array.from({ length: bins }, (_, k) => k * fs / n);
    result.power = power.map(p => Array.from(p, v => v / result.segments));
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

  function sosFiltFilt(input, sos) {
    if (!sos.length) return Float64Array.from(input);
    const zerosB = sos.filter(s => s[2] === 0).length, zerosA = sos.filter(s => s[5] === 0).length;
    const pad = 3 * (2 * sos.length + 1 - Math.min(zerosB, zerosA));
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

  function process(columns, fs, config = {}) {
    const converted = columns.map(c => Float64Array.from(c, v => v === null ? NaN : Number(v)));
    const sos = [], warnings = [];
    if (config.filter) {
      const low = Number(config.highpass ?? 0.5), high = Number(config.lowpass ?? 60);
      if (!(low > 0 && high > low && high < fs / 2)) throw new Error('带通范围必须满足 0 < 下限 < 上限 < 采样率/2');
      sos.push(butter2(fs, low, true), butter2(fs, high, false));
    }
    if (config.notch) sos.push(notch(fs));
    if (sos.length) {
      let omitted = 0;
      for (const column of converted) {
        for (const [a, b] of finiteSpans([column])) {
          try { column.set(sosFiltFilt(column.subarray(a, b), sos), a); }
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

  return { fftReal, welch, finiteSpans, butter2, notch, sosFiltFilt, process, weightedAverage };
});
