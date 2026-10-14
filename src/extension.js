'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { discover, publicDataset, RecordingCache, loadSegment } = require('./adapters');

function activate(context) {
  const resourceRoots = ['media', 'assets'].map(folder => vscode.Uri.joinPath(context.extensionUri, folder));
  async function open(uri, profile = 'auto') {
    const panel = vscode.window.createWebviewPanel('kieranEEG.viewer', 'Kieran EEG Viewer · 波形与 PSD', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: resourceRoots });
    await setupPanel(panel, uri, profile);
  }

  async function setupPanel(panel, initialUri, initialProfile) {
    const cache = new RecordingCache();
    let dataset = null, sourceUri = initialUri, profile = initialProfile, version = 0, disposed = false;
    const send = message => disposed ? Promise.resolve(false) : panel.webview.postMessage(message);
    async function chooseUri() {
      const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
        canSelectMany: false, openLabel: '打开 EEG 采集目录' });
      return selected?.[0];
    }
    async function openDataset(uri, requestedProfile) {
      const current = ++version;
      if (!uri) uri = await chooseUri();
      if (!uri || disposed || current !== version) { await send({ type: 'idle' }); return; }
      if (uri.scheme !== 'file') throw new Error('当前版本支持本地文件与通过 SSH 扩展宿主访问的磁盘文件');
      await send({ type: 'loading', message: '正在识别会话与 trial…' });
      const next = await discover(uri.fsPath, requestedProfile);
      if (disposed || current !== version) return;
      dataset = next; sourceUri = uri; profile = requestedProfile; cache.clear();
      panel.title = `EEG · ${path.basename(next.root)}`;
      await send({ type: 'dataset', data: publicDataset(next) });
    }

    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'ready') {
          if (initialUri) await openDataset(initialUri, profile);
          else await send({ type: 'welcome', profile });
        } else if (message.type === 'open') {
          const requested = ['auto', 'ssvep', 'assr'].includes(message.profile) ? message.profile : 'auto';
          await openDataset(undefined, requested);
        } else if (message.type === 'profile') {
          if (!['auto', 'ssvep', 'assr'].includes(message.profile)) return;
          if (sourceUri) await openDataset(sourceUri, message.profile);
          else await send({ type: 'welcome' });
        } else if (message.type === 'refresh') {
          if (sourceUri) await openDataset(sourceUri, profile);
        } else if (message.type === 'segment') {
          if (!dataset || !Number.isSafeInteger(message.requestId)) return;
          const current = version, data = await loadSegment(dataset, message.sessionId, message.segmentId, cache);
          if (current === version) await send({ type: 'segment', requestId: message.requestId, data });
        } else if (message.type === 'export') {
          if (!['csv', 'png'].includes(message.format) || typeof message.content !== 'string' || message.content.length > 24 * 1024 * 1024) return;
          let bytes;
          if (message.format === 'png') {
            if (!message.content.startsWith('data:image/png;base64,')) throw new Error('PNG 导出数据无效');
            bytes = Buffer.from(message.content.slice('data:image/png;base64,'.length), 'base64');
            if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PNG 签名无效');
          } else bytes = Buffer.from('\uFEFF' + message.content, 'utf8');
          const safeName = String(message.name || 'eeg').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120);
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(dataset?.root || context.extensionPath, `${safeName}.${message.format}`)),
            filters: message.format === 'png' ? { 'PNG 图像': ['png'] } : { 'PSD CSV': ['csv'] } });
          if (target) { await vscode.workspace.fs.writeFile(target, bytes); vscode.window.showInformationMessage(`EEG 已导出：${target.fsPath}`); }
        }
      } catch (error) {
        await send({ type: 'error', requestId: message.requestId, scope: message.type === 'segment' ? 'segment' : 'dataset', message: error.message });
      }
    }, undefined, context.subscriptions);
    panel.onDidDispose(() => { disposed = true; version++; cache.clear(); });
    panel.webview.options = { enableScripts: true, localResourceRoots: resourceRoots };
    const media = name => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name)).toString();
    const nonce = crypto.randomBytes(18).toString('base64');
    const html = await fs.readFile(path.join(context.extensionPath, 'media', 'index.html'), 'utf8');
    panel.webview.html = html.replaceAll('{{CSP}}', panel.webview.cspSource).replaceAll('{{NONCE}}', nonce)
      .replaceAll('{{STYLE}}', media('style.css')).replaceAll('{{APP}}', media('app.js'))
      .replaceAll('{{WORKER}}', media('worker.js')).replaceAll('{{DSP}}', media('dsp.js'))
      .replaceAll('{{ICON}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png')).toString())
      .replaceAll('{{VERSION}}', context.extension.packageJSON.version);
  }

  for (const [command, profile] of [['open', 'auto'], ['openSSVEP', 'ssvep'], ['openASSR', 'assr']]) {
    context.subscriptions.push(vscode.commands.registerCommand(`kieranEEG.${command}`, uri => open(uri, profile)));
  }
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('kieranEEG.viewer', {
    openCustomDocument(uri) { return { uri, dispose() {} }; },
    resolveCustomEditor(document, panel) { return setupPanel(panel, document.uri, 'auto'); }
  }, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
}

module.exports = { activate, deactivate() {} };
