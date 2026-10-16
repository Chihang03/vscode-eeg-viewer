(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EEGPreferences = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const choices = {
    'psd-method': ['welch', 'full'], window: ['2', '4', '8'], overlap: ['0.5', '0', '0.75'],
    'signal-units': ['metadata', 'raw'], missing: ['interpolate', 'preserve'],
    'signal-mode': ['raw', 'filtered', 'ssvep'], 'wave-mode': ['average', 'channels'],
    amplitude: ['auto', '50', '100', '250', '500', '1000'], 'psd-scale': ['db', 'linear']
  };
  function sanitize(input, profile) {
    const result = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
    for (const [key, values] of Object.entries(choices)) {
      if (values.includes(input[key]) && !(profile === 'assr' && key === 'signal-mode' && input[key] === 'ssvep')) result[key] = input[key];
    }
    for (const key of ['notch', 'center-wave']) if (typeof input[key] === 'boolean') result[key] = input[key];
    for (const key of ['highpass', 'lowpass']) if (Number.isFinite(input[key]) && input[key] > 0 && input[key] < 1e6) result[key] = input[key];
    const range = input['psd-range'];
    if (Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] >= 0 && range[1] > range[0]) result['psd-range'] = [...range];
    const channels = input['visible-channels'];
    if (Array.isArray(channels) && channels.length > 0 && channels.length <= 64 && channels.every(c => typeof c === 'string' && c.length > 0 && c.length <= 80)) result['visible-channels'] = [...new Set(channels)];
    return result;
  }
  function defaults(profile) {
    return { 'psd-method': 'welch', window: '4', overlap: '0.5', 'signal-units': 'metadata', missing: 'interpolate',
      'signal-mode': profile === 'assr' ? 'raw' : 'ssvep', 'wave-mode': 'average', amplitude: 'auto',
      'psd-scale': 'db', notch: false, 'center-wave': true, highpass: 0.5, lowpass: 60,
      'psd-range': profile === 'assr' ? [0, 60] : [6, 35] };
  }
  function resolve(input, profile) { return { ...defaults(profile), ...sanitize(input, profile) }; }
  return { sanitize, defaults, resolve };
});
