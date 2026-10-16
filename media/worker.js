'use strict';
let source = null, processed = null, processedKey = '';
self.onmessage = ({ data: message }) => {
  const { id, type } = message;
  try {
    if (type === 'init') {
      if (!self.EEGDSP) throw new Error('频谱计算模块未加载');
      self.postMessage({ id, type: 'ready' }); return;
    }
    if (type === 'load') { source = message.source; processed = null; processedKey = ''; }
    if (!source) throw new Error('没有 EEG 数据');
    const config = message.config || {}, key = JSON.stringify(config);
    if (!processed || key !== processedKey) {
      const values = config.units === 'raw' && source.scale && source.scale !== 1
        ? source.values.map(c => c.map(v => v === null ? null : v / source.scale)) : source.values;
      processed = self.EEGDSP.process(values, source.fs, config);
      processed.average = self.EEGDSP.weightedAverage(processed.columns);
      processedKey = key;
    }
    const psd = self.EEGDSP.welch([...processed.columns, processed.average], source.fs, message.options || {});
    psd.averagePower = psd.power.pop();
    self.postMessage({ id, type: 'result', psd, analysis: message.analysis, warnings: processed.warnings, columns: processed.columns, average: processed.average });
  } catch (error) { self.postMessage({ id, type: 'error', message: error.message }); }
};
