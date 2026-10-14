'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');

function waitForTab(predicate) {
  const matches = () => vscode.window.tabGroups.all.some(group => group.tabs.some(predicate));
  if (matches()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (matches()) { listener.dispose(); clearTimeout(timer); resolve(); }
    });
    const timer = setTimeout(() => { listener.dispose(); reject(new Error('等待编辑器标签页超时')); }, 5000);
  });
}

async function run() {
  const extension = vscode.extensions.getExtension('chihang03.kieran-eeg-viewer');
  assert.ok(extension, 'Extension Development Host 发现插件');
  await extension.activate();
  assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['open', 'openSSVEP', 'openASSR']) assert.ok(commands.includes(`kieranEEG.${name}`));
  await vscode.commands.executeCommand('kieranEEG.open');
  await waitForTab(tab => tab.label.includes('EEG'));
  console.log('EEG_HOST_PASS: activation, three commands, Webview panel');
  if (process.env.EEG_SMOKE_FILE) {
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(process.env.EEG_SMOKE_FILE), 'kieranEEG.viewer');
    await waitForTab(tab => tab.input instanceof vscode.TabInputCustom);
    console.log('EEG_HOST_PASS: custom readonly editor opened');
  }
  // 实际 Webview 渲染与图表交互另由浏览器检查；注册成功不能代替交互验证。
}

module.exports = { run };
