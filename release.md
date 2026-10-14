# Kieran EEG Viewer 0.1.1

面向 Bigshen SSVEP 和 ASSR 两个采集项目的 VS Code 脑电查看器，提供专用入口和自动识别。

- 多通道波形，支持 trial / 阶段切换、时间缩放与平移。
- 拖动波形框选区间，联动计算 Welch PSD；支持窗长、重叠、频率范围和 dB / 线性显示。
- 元数据单位换算、样本索引切片、目标频率与谐波参考线。
- 可选零相位带通和 50 Hz 陷波，固定对照 A。
- PNG 图像和带参数 PSD CSV 导出。
- 独立 Logo、维护者信息、跨平台检查及可重复的 VSIX 打包配置。

## 安装

下载本次 Release 的 `.vsix` 文件，在 VS Code 扩展视图的「… → 从 VSIX 安装…」中选择它。

安装后，在命令面板运行「EEG：打开数据（自动识别）」，或分别选择 SSVEP / ASSR 命令。要求 VS Code 1.85+，运行时不需要 Python。

`SHA256SUMS.txt` 提供安装包校验值。本次发布通过 GitHub 分发，不包含 Marketplace 商店发布。

## 验证与范围

数值验证覆盖 Welch PSD 与零相位 SOS 滤波的 SciPy 对照。本机 macOS 已验证实际 VS Code Webview 中的记录加载、trial 切换、选区联动和滤波。GitHub CI 在 Linux、Windows、macOS 上运行文件适配与计算核心测试；其结果不替代各平台的人工界面验证。

0.1.x 为预览版本。当前支持项目现有 CSV / JSON 输出，尚不支持设备直连、实时采集或 EDF / BDF。采集有效性标记不代表已经确认信号质量或诱发响应；事件时间保留原始记录的估算性质。
