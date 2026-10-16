"""可选开发验证：逐频点核对 SciPy，不是插件运行依赖。"""
from __future__ import annotations

import json
import math
import argparse
import ast
from pathlib import Path
import subprocess
from typing import Any

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parents[1]
RUNNER = r"""
const fs = require('node:fs');
const dsp = require('./media/dsp');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
let result;
if (request.method === 'welch') {
 const columns = dsp.process(request.columns, request.fs).columns;
 result = dsp.welch(columns, request.fs, request.options);
} else {
 const filtered = dsp.process(request.columns, request.fs, request.config);
 result = {columns: filtered.columns.map(c => Array.from(c)), warnings: filtered.warnings};
}
process.stdout.write(JSON.stringify(result));
"""


def run(request: dict) -> dict:
    completed = subprocess.run(["node", "-e", RUNNER], input=json.dumps(request), text=True,
                               cwd=ROOT, capture_output=True, check=True)
    return json.loads(completed.stdout)


def samples(n: int, fs: float) -> np.ndarray:
    return np.array([[7 * math.sin(2 * math.pi * 12.2 * i / fs) + 1.3 * math.cos(2 * math.pi * 50 * i / fs)
                      + 0.0007 * i + 30 for i in range(n)],
                     [3 * math.sin(2 * math.pi * 14.6 * i / fs) + 0.2 * math.cos(i * 0.813) - 20 for i in range(n)]])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference-script', type=Path, help='可选：直接核对现有 SSVEP 分析脚本中的计算函数')
    args = parser.parse_args()
    fs = 500
    x = samples(5001, fs)
    for start, end in [(0, 5001), (321, 4322)]:
        actual = run({"method": "welch", "columns": x.tolist(), "fs": fs,
                      "options": {"start": start, "end": end}})
        f, p = signal.periodogram(x[:, start:end], fs, window="hann", detrend="constant",
                                  scaling="density", axis=-1)
        np.testing.assert_allclose(actual["frequencies"], f, rtol=1e-13, atol=1e-12)
        np.testing.assert_allclose(actual["power"], p, rtol=3e-7, atol=1e-11)
        assert actual["usedSamples"] == end - start
        assert actual["method"] == "periodogram" and actual["segments"] == 1
        print(f"PASS default full-interval periodogram [{start}, {end}), all {len(f)} bins / 2 channels")

    for n, seconds in [(5000, 4), (4000, "full"), (1199, "full"), (2501, 8), (8192, 4)]:
        x = samples(n, fs)
        options = {"seconds": seconds, "overlap": 0.5}
        actual = run({"method": "welch", "columns": x.tolist(), "fs": fs, "options": options})
        size = n if seconds == "full" else min(n, round(seconds * fs))
        f, p = signal.welch(x, fs, window="hann", nperseg=size, noverlap=round(size * 0.5), nfft=size,
                            detrend="constant", scaling="density", axis=-1)
        np.testing.assert_allclose(actual["frequencies"], f, rtol=1e-13, atol=1e-12)
        np.testing.assert_allclose(actual["power"], p, rtol=3e-7, atol=1e-11)
        print(f"PASS Welch n={n}, window={seconds}, all {len(f)} bins / 2 channels")

    x = samples(6000, fs)
    x[:, 2200:2250] = np.nan
    actual = run({"method": "welch", "columns": [[None if not math.isfinite(v) else v for v in c] for c in x],
                  "fs": fs, "options": {"seconds": 4, "start": 100, "end": 5701}})
    powers, weights = [], []
    for a, b in [(100, 2200), (2250, 5701)]:
        _, p = signal.welch(x[:, a:b], fs, window="hann", nperseg=2000, noverlap=1000, nfft=2000,
                            detrend="constant", scaling="density", axis=-1)
        powers.append(p)
        weights.append(1 + (b-a-2000)//1000)
    np.testing.assert_allclose(actual["power"], np.average(powers, weights=weights, axis=0), rtol=3e-7, atol=1e-11)
    print("PASS gap-aware selected interval, weighted by valid windows")

    for bandpass, notch in [(True, False), (False, True), (True, True)]:
        x = samples(6000, fs)
        sos = []
        if bandpass:
            sos.extend(signal.butter(2, 0.5, btype="highpass", fs=fs, output="sos"))
            sos.extend(signal.butter(2, 60, btype="lowpass", fs=fs, output="sos"))
        if notch:
            b, a = signal.iirnotch(50, 30, fs=fs)
            sos.extend(signal.tf2sos(b, a))
        actual = run({"method": "filter", "columns": x.tolist(), "fs": fs,
                      "config": {"filter": bandpass, "notch": notch, "highpass": 0.5, "lowpass": 60}})
        expected = signal.sosfiltfilt(np.array(sos), x, axis=-1)
        np.testing.assert_allclose(actual["columns"], expected, rtol=1e-8, atol=1e-8)
        print(f"PASS zero-phase SOS filtering, bandpass={bandpass}, notch={notch}, all 12000 values")

    # 对齐分析脚本：两种 PSD 的补零、Python round 半偶规则，以及短记录回退。
    for n, seconds in [(5000, 2), (1001, 4), (1199, "full"), (5001, "full"), (8, 2), (2, "full"), (1, "full")]:
        x = samples(n, fs)
        size = n if seconds == "full" else min(n, round(seconds * fs))
        nfft = max(4096, 2 ** math.ceil(math.log2(max(size, 8))))
        options = {"seconds": seconds, "overlap": 0.5, "fft": "script"}
        actual = run({"method": "welch", "columns": x.tolist(), "fs": fs, "options": options})
        if seconds == "full":
            f, p = signal.periodogram(x, fs, window="hann", nfft=nfft, detrend="constant", scaling="density", axis=-1)
        else:
            f, p = signal.welch(x, fs, window="hann", nperseg=size, noverlap=round(size * 0.5), nfft=nfft,
                                detrend="constant", scaling="density", axis=-1)
        np.testing.assert_allclose(actual["frequencies"], f, rtol=1e-13, atol=1e-12)
        np.testing.assert_allclose(actual["power"], p, rtol=3e-7, atol=1e-11)
        assert actual["nfft"] == nfft and actual["nperseg"] == size
        assert actual["resolutionHz"] == fs / size
        print(f"PASS analysis-script PSD n={n}, window={seconds}, nfft={nfft}, all bins / 2 channels")

    for fs, n in [(500, 6000), (250, 1199), (128, 31), (80, 2)]:
        x = samples(n, fs)
        if n > 11:
            x[0, :2] = np.nan
            x[0, 7:11] = np.nan
            x[1, -3:] = np.nan
        # pandas interpolate(limit_direction='both') 的等价线性插值及边缘延拓。
        filled = np.array([np.interp(np.arange(n), np.flatnonzero(np.isfinite(c)), c[np.isfinite(c)]) for c in x])
        sos = []
        for frequency in (50, 60, 100):
            if frequency < fs / 2:
                b, a = signal.iirnotch(frequency, 12.5, fs=fs)
                sos.extend([signal.tf2sos(b, a)[0]] * 2)
        expected = filled.copy()
        if sos:
            expected = signal.sosfiltfilt(np.array(sos), expected, axis=-1, padlen=min(3 * (2 * len(sos) + 1), n - 1))
        taps = signal.firwin(801, [6, 35], pass_zero=False, window="hamming", fs=fs)
        expected = signal.filtfilt(taps, [1.0], expected, axis=-1, padlen=min(2403, n - 1))
        expected -= np.mean(expected, axis=-1, keepdims=True)
        actual = run({"method": "filter", "columns": [[None if not math.isfinite(v) else v for v in c] for c in x],
                      "fs": fs, "config": {"filter": True, "filterKind": "ssvep", "missing": "interpolate"}})
        np.testing.assert_allclose(actual["columns"], expected, rtol=2e-8, atol=2e-9)
        print(f"PASS SSVEP script interpolation + notch + FIR + centering, fs={fs}, n={n}, all samples")

    if args.reference_script:
        # 只提取数值函数及其常量，避免导入或执行完整分析程序。
        tree = ast.parse(args.reference_script.read_text(encoding='utf-8'))
        constants = {'FIR_NUMTAPS', 'FILTER_LOW_HZ', 'FILTER_HIGH_HZ', 'FIR_WINDOW', 'NOTCH_FREQS_HZ',
                     'NOTCH_Q', 'NOTCH_ORDER', 'USE_BASELINE', 'WELCH_WINDOW_SECONDS', 'WELCH_OVERLAP_RATIO', 'WELCH_NFFT'}
        functions = {'make_filter_coefficients', 'filter_zero_phase', 'welch_psd', 'periodogram_psd'}
        namespace = {'np': np, 'signal': signal, 'math': math, 'Any': Any}
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in constants:
                namespace[node.targets[0].id] = ast.literal_eval(node.value)
        selected = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in functions], type_ignores=[])
        exec(compile(selected, str(args.reference_script), 'exec'), namespace)
        fs = 500
        x = samples(5001, fs)
        expected = namespace['filter_zero_phase'](x.T, fs).T
        actual = run({'method': 'filter', 'columns': x.tolist(), 'fs': fs, 'config': {'filter': True, 'filterKind': 'ssvep'}})
        np.testing.assert_allclose(actual['columns'], expected, rtol=2e-8, atol=2e-9)
        for seconds, function in [(2, 'welch_psd'), ('full', 'periodogram_psd')]:
            # 三通道平均定义同样在时域完成；此处的合成输入有两个通道。
            reference_input = np.vstack([expected, np.mean(expected, axis=0)])
            f, p, _ = namespace[function](reference_input.T, fs)
            actual = run({'method': 'welch', 'columns': reference_input.tolist(), 'fs': fs,
                          'options': {'seconds': seconds, 'overlap': .5, 'fft': 'script'}})
            np.testing.assert_allclose(actual['frequencies'], f, rtol=1e-13, atol=1e-12)
            np.testing.assert_allclose(actual['power'], p.T, rtol=3e-7, atol=1e-11)
        print('PASS direct analysis-script functions: filter, Welch, periodogram and mean-wave PSD on identical synthetic input')


if __name__ == "__main__":
    main()
