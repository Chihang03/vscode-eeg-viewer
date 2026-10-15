# 参与开发

这个插件专为 SSVEP 与 ASSR 两个采集项目维护。修改应优先保持现有输出的兼容性和日常查看操作的稳定性。

## 环境

- VS Code 1.85 或更新版本。
- Node.js 22 或更新版本；CI 同时运行于 Linux、Windows 和 macOS。
- Python / NumPy / SciPy 仅用于可选的开发验证，不是插件运行依赖。

```bash
npm ci --ignore-scripts
npm run check
npm run check:identity
npm test
npm run package
```

在 VS Code 中打开项目根目录，按 F5 启动扩展开发宿主。修改 Webview 后，应实际检查打开记录、切换 trial、拖动框选、缩放、PSD 参数和导出路径；构建成功不替代界面验证。

## 数据和数值约定

- 采样率、单位、换算系数和目标频率来自元数据。
- ASSR trial 保持零基半开区间 `[start, end)`，不把音频提交当作实际声学起点。
- 收包时间与设备采样时间分别处理，不通过重复时间戳估算采样率。
- PSD 不使用绘图抽稀数据、不跨缺口，参数和密度单位必须明确。
- 修改 FFT、PSD 或滤波时，运行 `python scripts/verify-scipy.py` 并补充必要的数值验证。

## 提交与发行

提交应说明问题、用户可见变化和验证结果。不要提交真实 EEG、被试资料、本机绝对路径、访问凭据或本地 VSIX；问题复现优先使用合成数据或匿名化的最小样例。

版本号由 `package.json` 管理，变更写入 `CHANGELOG.md`。发行时创建匹配的 `v<version>` tag；GitHub 工作流会核对版本并发布 VSIX 和 SHA256 校验文件。工作流不包含 VS Code Marketplace 发布。
