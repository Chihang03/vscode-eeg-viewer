'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const uri = file => ({ scheme: 'file', fsPath: file, toString() { return `file://${file}`; } });

function host(activeFile, storage = new Map()) {
  const commands = new Map(), panels = [], messages = [], providers = new Map();
  const vscode = {
    ViewColumn: { Active: 1 },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: {
      tabGroups: { activeTabGroup: { activeTab: { input: { uri: activeFile ? uri(activeFile) : undefined } } } },
      showInformationMessage(message) { messages.push(message); },
      showOpenDialog() { throw new Error('文件查看器不应打开文件夹选择器'); },
      registerCustomEditorProvider(name, provider) { providers.set(name, provider); return { dispose() {} }; },
      createWebviewPanel() {
        const panel = { title: '', onDidDispose() {}, webview: { cspSource: 'https://test.example', html: '',
          onDidReceiveMessage(callback) { this.listener = callback; },
          postMessage(message) { (this.sent ||= []).push(message); }, asWebviewUri: value => value } };
        panels.push(panel); return panel;
      }
    }
  };
  const localRequire = createRequire(path.join(root, 'src/extension.js')), module = { exports: {} };
  new Function('require', 'module', fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8'))(
    name => name === 'vscode' ? vscode : localRequire(name), module);
  module.exports.activate({ extensionUri: uri(root), extensionPath: root, subscriptions: [], extension: { packageJSON: require('../package.json') },
    globalState: { get: key => storage.get(key), async update(key, value) { await new Promise(resolve => setTimeout(resolve, 2)); storage.set(key, value); } } });
  return { commands, panels, messages, providers };
}

test('命令使用当前 EEG 文件，关联资源完整且没有目录选择入口', async () => {
  const instance = host('/records/sub-S001_10Hz_trial-01_eeg.csv');
  await instance.commands.get('kieranEEG.open')();
  assert.equal(instance.panels.length, 1);
  const html = instance.panels[0].webview.html;
  assert.ok(!html.includes('{{'));
  assert.match(html, /value="average" selected/);
  assert.match(html, /value="channels"/);
  const modes = html.match(/<select id="profile">([\s\S]*?)<\/select>/)[1];
  assert.ok(!modes.includes('value="auto"'));
  assert.ok(!html.includes('id="open"'));
  assert.ok(!html.includes('id="welcome"'));
  assert.equal(instance.providers.size, 2);
});

test('本机偏好跨编辑器和扩展重启保存，局部并发修改不丢失，SSVEP 与 ASSR 独立', async () => {
  const storage = new Map(), instance = host('/records/test_eeg.csv', storage);
  await instance.commands.get('kieranEEG.open')(); await instance.commands.get('kieranEEG.open')();
  const [a, b] = instance.panels.map(p => p.webview);
  await Promise.all([
    a.listener({ type: 'preferences', profile: 'ssvep', values: { window: '8', 'signal-mode': 'ssvep', unknown: 'ignored' } }),
    b.listener({ type: 'preferences', profile: 'ssvep', values: { 'signal-units': 'raw', 'psd-range': [9, 20] } }),
    b.listener({ type: 'preferences', profile: 'assr', values: { window: '2', 'signal-mode': 'ssvep' } })
  ]);
  assert.deepEqual(storage.get('viewer.preferences.v1.ssvep'), { window: '8', 'signal-mode': 'ssvep', 'signal-units': 'raw', 'psd-range': [9, 20] });
  assert.deepEqual(storage.get('viewer.preferences.v1.assr'), { window: '2' });
  assert.ok(a.sent.some(m => m.type === 'preferences-saved'));
  const restarted = host('/records/test_eeg.csv', storage); await restarted.commands.get('kieranEEG.open')();
  await restarted.panels[0].webview.listener({ type: 'preferences', profile: 'ssvep', values: { overlap: '0.75' } });
  assert.equal(storage.get('viewer.preferences.v1.ssvep').window, '8');
  assert.equal(storage.get('viewer.preferences.v1.ssvep').overlap, '0.75');
  assert.equal(storage.get('viewer.preferences.v1.assr').window, '2');
});

test('没有当前 EEG 文件时不建立空白 Webview 或弹出目录选择器', async () => {
  for (const active of [undefined, '/records', '/notes/readme.md']) {
    const instance = host(active);
    await instance.commands.get('kieranEEG.open')();
    assert.equal(instance.panels.length, 0);
    assert.deepEqual(instance.messages, ['请选择 EEG 文件。']);
  }
});

test('资源管理器命令优先使用选中文件，只有 EEG CSV 默认接管', async () => {
  const instance = host('/notes/readme.md');
  await instance.commands.get('kieranEEG.open')(
    uri('/records/continuous_eeg.csv'));
  assert.equal(instance.panels.length, 1);
  const pkg = require('../package.json');
  const defaults = pkg.contributes.customEditors.filter(editor => editor.priority === 'default');
  assert.equal(defaults.length, 1);
  assert.deepEqual(defaults[0].selector, [{ filenamePattern: '**/*_eeg.csv' }]);
  assert.ok(pkg.contributes.menus['explorer/context'].every(item => item.when.includes('!explorerResourceIsFolder')));
});
