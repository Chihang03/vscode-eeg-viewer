"""可选开发验证：逐频点核对 SciPy，不是插件运行依赖。"""
from __future__ import annotations

import json
import math
from pathlib import Path
import subprocess

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


if __name__ == "__main__":
    main()
