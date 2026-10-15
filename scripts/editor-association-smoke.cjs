'use strict';
// 在全新、隔离的 Extension Development Host 中运行，同时启用普通 CSV 查看器。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

async function open(file) {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: false });
  for (let i = 0; i < 100; i++) {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input?.uri?.fsPath === file) return input.viewType || 'default';
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`等待文件编辑器超时：${file}`);
}

exports.run = async () => {
  const csvExtension = process.env.EEG_CSV_EXTENSION_ID || 'chihang03.kieran-document-studio';
  const csvView = process.env.EEG_CSV_VIEW_TYPE || 'kieranDocumentStudio.officeViewer';
  for (const id of ['chihang03.kieran-eeg-viewer', csvExtension]) {
    const extension = vscode.extensions.getExtension(id); assert.ok(extension, `未启用 ${id}`); await extension.activate();
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eeg-association-'));
  const cfg = vscode.workspace.getConfiguration('workbench');
  const before = cfg.inspect('editorAssociations');
  assert.equal(before.defaultValue['*_eeg.csv'], 'kieranEEG.viewer');
  assert.equal(before.globalValue?.['*_eeg.csv'], undefined, '测试配置不应预先包含用户 EEG 规则');
  assert.equal(before.workspaceValue?.['*_eeg.csv'], undefined, '测试配置不应预先包含工作区 EEG 规则');
  try {
    for (const name of ['trial-01', 'continuous']) {
      await fs.writeFile(path.join(root, name + '_eeg.csv'), 'FP1,FP2,FPz\n1,2,3\n4,5,6\n');
      await fs.writeFile(path.join(root, name + '_meta.json'), JSON.stringify({
        device: { channels: ['FP1', 'FP2', 'FPz'], sampling_rate_hz: 500, signal_unit: 'μV' },
        stimulus: { frequency_hz: 10 }, quality: { valid: true, sample_count: 2 }, trial_id: name
      }));
    }
    for (const name of ['ordinary.csv', 'trials.csv', 'events.csv']) await fs.writeFile(path.join(root, name), 'name,value\nexample,1\n');
    for (const name of ['trial-01_eeg.csv', 'continuous_eeg.csv']) assert.equal(await open(path.join(root, name)), 'kieranEEG.viewer');
    for (const name of ['ordinary.csv', 'trials.csv', 'events.csv']) assert.equal(await open(path.join(root, name)), csvView);
    assert.deepEqual(cfg.inspect('editorAssociations').globalValue, before.globalValue, '插件不应改写用户设置');
    assert.deepEqual(cfg.inspect('editorAssociations').workspaceValue, before.workspaceValue, '插件不应改写工作区设置');

    const user = before.globalValue || {}, eegFile = path.join(root, 'trial-01_eeg.csv');
    async function userRules(rules) {
      await cfg.update('editorAssociations', rules, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
    await userRules({ ...user, '*.csv': csvView });
    assert.equal(await open(eegFile), 'kieranEEG.viewer', '专用默认值优先于普通 CSV 规则');
    assert.equal(await open(path.join(root, 'ordinary.csv')), csvView);
    assert.equal(cfg.inspect('editorAssociations').globalValue['*_eeg.csv'], undefined);

    await userRules({ ...user, '*.csv': csvView, '*_eeg.csv': 'default' });
    assert.equal(await open(eegFile), 'default', '用户明确选择的文本编辑器优先');
    await userRules(before.globalValue);
    await cfg.update('editorAssociations', { ...before.workspaceValue, '*_eeg.csv': 'default' }, vscode.ConfigurationTarget.Workspace);
    assert.equal(await open(eegFile), 'default', '工作区明确选择优先');
    await cfg.update('editorAssociations', before.workspaceValue, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(await open(eegFile), 'kieranEEG.viewer', '清除显式选择后恢复插件默认值');
    console.log('EEG_ASSOCIATION_PASS: fresh defaults, CSV coexistence, broad CSV rule, user/workspace overrides, no settings writes');
  } finally {
    await cfg.update('editorAssociations', before.globalValue, vscode.ConfigurationTarget.Global);
    await cfg.update('editorAssociations', before.workspaceValue, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(root, { recursive: true, force: true });
  }
};
