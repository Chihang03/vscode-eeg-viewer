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
      processed = self.EEGDSP.process(source.values, source.fs, config);
      processed.average = self.EEGDSP.weightedAverage(processed.columns);
      processedKey = key;
    }
    const psd = self.EEGDSP.welch(processed.columns, source.fs, message.options || {});
    self.postMessage({ id, type: 'result', psd, warnings: processed.warnings, columns: processed.columns, average: processed.average });
  } catch (error) { self.postMessage({ id, type: 'error', message: error.message }); }
};
