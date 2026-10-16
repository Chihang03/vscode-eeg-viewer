<p align="center">
  <img src="assets/icon.png" width="144" height="144" alt="Kieran EEG Viewer Logo">
</p>

# Kieran EEG Viewer（脑电查看器）

[![CI](https://github.com/Chihang03/vscode-eeg-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/Chihang03/vscode-eeg-viewer/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/Chihang03/vscode-eeg-viewer?include_prereleases)](https://github.com/Chihang03/vscode-eeg-viewer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-6eb8ac.svg)](LICENSE)

由 **Kieran Dai（GitHub：Chihang03；扩展发布者：chihang03）** 独立维护。扩展 ID：`chihang03.kieran-eeg-viewer`。这是一款针对现有采集输出开发的独立工具，不代表采集设备厂商、Microsoft 或第三方机构。

用于在 VS Code 中查看 **SSVEP** 和 **ASSR** 的 EEG 波形与 PSD。默认显示三通道平均波形，可切换为分别显示。安装后无需 Python、服务端或额外运行依赖。

从 [GitHub Releases](https://github.com/Chihang03/vscode-eeg-viewer/releases) 下载 `.vsix` 和 `SHA256SUMS.txt`。使用反馈和功能建议请提交到 [Issues](https://github.com/Chihang03/vscode-eeg-viewer/issues)。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 查看文件

安装 VSIX 后，直接打开 `*_eeg.csv`，插件会读取同目录的元数据和事件。也可右键 EEG 文件选择 **EEG：查看波形与 PSD**，或对当前文件使用同名命令。

模式选择仅显示 **SSVEP** 和 **ASSR**，初始值由当前文件结构确定。需要手动指定时，可使用模式下拉框或 **EEG：以 SSVEP 查看** / **EEG：以 ASSR 查看** 命令。

`*_meta.json` 和 `session.json` 可通过「重新打开方式 → EEG 波形与 PSD」查看。其他 CSV 和 JSON 保持原有打开方式。

从 0.1.4 起，插件自带 `*_eeg.csv → kieranEEG.viewer` 默认编辑器关联，安装后无需手动修改设置。该规则比普通 `*.csv` 关联更具体，因此 EEG 文件使用本插件，`trials.csv`、`events.csv` 和其他 CSV 继续由原查看器处理。

默认关联不会写入用户或工作区设置，禁用或卸载插件后随之移除。用户或工作区对同一 `*_eeg.csv` 规则的明确配置优先。规则只依据文件名，不会把任意 CSV 内容判定为 EEG；已打开的文件需关闭后重新打开。

插件从当前文件进入，并关联同一会话中的 trial。左侧可以筛选频率、条件和 trial，或仅查看采集标记有效的记录。

左侧栏默认收起，不占用独立列，点击页面左上方箭头展开或收起。详情面板默认展开，可点击「详情」收起。

两个模式提供分别的入口和浏览内容，共用图表和计算核心；不要求两个项目使用相同的数据组织方式。

## 支持的项目输出

### SSVEP

```text
bigshen_eeg_collection/
  S009/
    sub-S009_20260908_ses-01_28key/
      sub-..._10.2Hz_trial-01_eeg.csv
      sub-..._10.2Hz_trial-01_meta.json
      sub-..._10.2Hz_trial-01_events.csv
      sub-..._10.2Hz_trial-01_display_timing.csv
```

按文件前缀关联 EEG、元数据和事件。频率从 `stimulus.frequency_hz` 读取，支持 0.2 Hz 间隔等小数频率。波形事件使用 `sample_index`；每个 trial 保持独立时间轴。当前版本不加载逐帧 display timing 文件，相关软件时序结论不解释为真实像素点亮时间。

### ASSR

```text
sub-S001_20261012_ses-02_assr/
  session.json
  continuous_eeg.csv
  trials.csv
  events.csv
  audio_manifest.json
```

trial 使用 `trials.csv` 的零基半开区间 `[eeg_start_index, eeg_end_index)`。连续记录、baseline、rest、AM 条件与纯音对照可以分别打开。baseline 和 rest 只使用 `events.csv` 中已经到达的 `*_reached_estimate` 起止边界，按收包时间进行左二分映射；计划或仅提交的阶段不会生成已完成区间。

目标频率读取 `modulation_hz`，同时兼容新输出中的 `left_modulation_hz` / `right_modulation_hz`。`PURE1000` 没有调制目标时不绘制 1000 Hz EEG 目标线。音频文件不是绘图依赖。

## 波形操作

- 波形默认是三通道等权平均：`(FP1 + FP2 + FPz) / 3`，采用较小的图高。任一通道缺失的样本保留为空缺，不临时改为其他通道平均。
- 选择「分别显示」可查看独立通道，切回「三通道平均」恢复紧凑视图。
- PSD 同时提供各通道及「三通道平均」曲线，勾选框控制显示；三通道平均先在时域计算 `(FP1 + FP2 + FPz) / 3`，再计算 PSD，不是三条功率谱的平均。通道开关也控制分别显示时的波形；隐藏某个通道不改变平均波形或平均 PSD 的定义。
- 拖动波形：框选区间，松开后使用选区完整样本计算 PSD。ASSR 选区端点接近事件边界时吸附到边界，按住 `Alt` 临时关闭吸附。
- 滚轮：以指针为中心缩放时间轴；双击：恢复全段。
- 工具栏支持放大选区、恢复全段和清除选区；当前波形可见时间范围显示在 EEG 标题行右侧。
- 上方时间导航条始终显示全记录。ASSR 展示全部事件分区，SSVEP 展示简洁时间条；细边框表示当前 EEG 视野，事件高亮表示当前所选事件。放大波形后拖动范围框可平移视野，PSD 来源保持不变。单击事件选择 PSD，双击事件放大对应波形；单击无事件的时间位置可将当前视野移到附近。
- 时间范围框获得键盘焦点后，左右方向键小步平移，PageUp／PageDown 大步平移，Home／End 移到记录首尾；Esc 取消正在进行的范围框拖动。
- `Alt + ←` / `Alt + →`：切换左侧筛选结果中的上一个／下一个区间；`Esc` 或「清除选区」先清除手动选区、恢复此前事件，再次清除事件后恢复全段 PSD。
- 默认启用「居中显示」：只减去当前视窗均值绘图，不改变参与 PSD 的信号。取消后显示实际信号零点。
- 纵轴可以自动缩放，也可以固定为指定的正负幅度，以便比较 trial。
- 长记录按像素桶保留极值绘图；PSD 使用分析区间内完整采样率的数据，不使用绘图抽稀数据。

## PSD 与滤波

SSVEP 默认显示完整 trial，并使用其全部连续有效样本生成整段 PSD。ASSR 默认显示完整连续记录与全记录 PSD 总览；在 EEG 上方的时间导航条或波形事件区单击可选中完整事件，双击时间导航条中的事件可进一步放大该事件的波形。事件选择只改变高亮范围与 PSD 来源，保留连续记录上下文。左侧的 trial／阶段入口同样选择连续记录中的相应事件。

PSD 来源可切换为完整 trial／记录、当前事件或手动选区。仅缩放、平移 EEG 时间轴不改变 PSD 来源。时间导航条中的事件只包含有效样本索引的刺激区间，以及有已到达起止边界的 baseline／rest 阶段；目标频率参考线随当前分析区间变化。

默认算法为整个分析区间的单窗 Hann 周期图，不再默认采用 4 秒分窗平均。需要 Welch 分窗平均时展开「高级」，选择 Welch 后默认使用 2 秒窗长、50% 重叠，与 `analyze_ssvep_frequency_quality.py` 的 Welch 参数一致；也可设置 4、8 秒窗长及 0%、75% 重叠。

在 PSD 图上滚动滚轮，以指针所在频率为中心放大或缩小；按住左键拖动可平移频率轴。双击图表或点击「全频段」恢复 0 Hz 至 Nyquist 频率。初次显示 0–60 Hz（不超过 Nyquist）；切换 trial、通道或显示参数时保留频率视野。放大到细节时显示实际频点，最窄视野为两个频率间隔；缩放只改变显示，不改变 PSD 计算结果或 `Δf`。

算法定义：

- 周期 Hann 窗、去均值、单边密度谱。默认以完整分析区间为一窗；Welch 模式在线性功率域平均多个窗口。
- 两种算法均使用 `nfft = max(4096, 2^ceil(log2(nperseg)))`，与分析脚本一致，补零只加密频率网格。周期图的 `nperseg` 为整段实际样本数，Welch 为实际分窗长度；Hann 窗和密度归一化始终使用 `nperseg`，不使用补零后的长度。
- 多通道使用联合有限区间，分析窗口不会跨越 NaN、空值或无穷值。不同连续片段按实际窗口数加权。
- 缺口将整段拆为连续有效片段。连续有效片段不足请求窗长时回退到最长连续片段的长度，其他不足该长度的片段不参与；不跨缺口拼接或补零。明确显示实际窗长及实际参与的有效时长，不把未参与样本计入结果。Welch 模式不足一窗的尾段同样不参与；Welch 不足 8 个连续样本时不显示 PSD。
- 显示实际窗长、频点间隔、FFT 点数、平均窗口数及有效样本数。`Δf = fs / nfft` 是频点间隔；`1 / 实际窗长` 另随 CSV 导出，两者都不保证相邻生理响应可以被分开。
- PSD 可显示线性密度，或 `10 log10(PSD / 1 单位²/Hz)`；μV 输入对应 μV²/Hz 和 dB re 1 μV²/Hz。
- 目标频率及其二、三次谐波由当前记录元数据生成参考线。

默认使用原始信号。「通用滤波」由二阶 Butterworth 高通和二阶 Butterworth 低通串联构成，默认截止频率 0.5 / 60 Hz；另可开启 50 Hz、Q=30 的陷波。短于通用滤波延拓长度的片段会被排除并提示。

「SSVEP 6–35 Hz」与分析脚本采用相同的处理顺序：50、60、100 Hz 陷波（Q=12.5，每个频率串联两节，超过 Nyquist 的频率跳过）→ 801 taps Hamming FIR 6–35 Hz 带通 → 逐通道去均值。陷波和 FIR 均为前后向零相位；奇对称边界延拓、稳态初值、短记录 padlen 限制与脚本一致。该选项自带上述陷波，不叠加通用 50 Hz 开关。

所有滤波都以完整已加载记录的各连续有效片段为边界，之后切出 PSD 分析范围；缩放不会重新定义滤波边界。ASSR 因此保留连续滤波上下文。高级设置中的「缺失点」默认保留缺口，也可显式选择与脚本一致的逐通道线性插值，开头／结尾缺失点延拓最近有效值；整条通道缺失时报错。插值影响波形和 PSD，不修改 CSV。

### 与 SSVEP 分析脚本比较

对应脚本的单 trial Welch 频谱：展开「高级」，选择 **Welch 平均、2 s、50%**；选择 **采集原值**，滤波图使用 **SSVEP 6–35 Hz**，存在缺失点时选择 **线性插值**，需要平均曲线时勾选 **三通道平均**。对应整段周期图时，算法选择 **整段**。脚本保留采集原始浮点单位，因此使用 μV 时功率值会按换算系数的平方缩放；例如系数 -100 对应功率 ×10000、dB +40。

比较数值时，输入样本范围和滤波边界也必须相同：分析脚本优先截取 `stimulus_start`／`stimulus_end` 样本区间后滤波；查看器保持完整 trial／连续记录，再对事件或手动选区计算 PSD。若 EEG 文件含刺激前后额外样本，即使框选范围相同，滤波边缘也可能不同。脚本部分短窗指标及原始周期图汇总使用的是通道功率平均，不能直接与这里的平均波形 PSD 混比。当前不在查看器中复刻跨 trial dB 均值、标准差阴影或分析资格筛选。

「固定为对照 A」保留当时的 PSD、分析参数和处理配置，随后可与其他 trial 叠加。A 显示为虚线，当前数据为实线；单位不同不叠加。可以跨会话比较，界面会显示 A 的来源及处理方式。

## 单位和时间轴

采样率从 `device.sampling_rate_hz` 或 `device.sample_rate_hz` 读取，通道从 `device.channels` 读取。不能缺省推断采样率。

默认仅当元数据声明 `signal_unit = raw_device_float` 且存在有限非零 `device_to_uv_scale` 时转换为 μV。当前两套数据的换算系数为 -100；未知单位保留为原始单位。高级设置选择「采集原值」时按该系数逆换算回采集尺度，波形、PSD、单位标注和导出同步更新；单位不同的对照不会叠加。

正常波形采用按元数据采样率构建的 `i / fs` 时间轴。`host_receive_monotonic_ns` 是主机批量接收时间，同批样本可以共用时间戳；它不作为每个样本的设备采样时间。接收时间用 BigInt 解析，避免纳秒整数精度损失。

ASSR 的驱动输出估算和主机收包时间对齐不等同于已经验证的声学同步；SSVEP 主机事件不等同于真实光学刺激起点。「采集标记有效」单独呈现，不替代波形质量或诱发响应判断。

## 导出

- **导出图像**：导出当前波形视窗和 PSD，附会话、信号处理、单位、PSD 来源与窗长说明。
- **导出 PSD**：导出所有通道及三通道平均波形 PSD 的完整频率网格与线性密度值。CSV 附带源文件样本起止索引、采样率、窗口、重叠比例、平均窗口数、处理配置、分析来源、事件 ID、算法、有限样本数、实际参与样本数、nfft、实际重叠点数、频点间隔、窗长倒数、单位及缺失点策略；不受当前通道隐藏、频率轴裁剪和 dB 显示影响。

通过保存对话框选择导出路径。原始文件只读访问，没有写回 EEG、事件和元数据的功能。

## 本地开发和验证

在 VS Code 中打开本目录，按 F5 启动扩展开发宿主。Node.js 22+ 可直接运行核心测试；构建发行包时先安装锁定的开发依赖：

```bash
npm run check
npm test
npm ci --ignore-scripts
npm run check:identity
npm run package
```

`@vscode/vsce` 是开发依赖，不随插件分发。`package-lock.json` 固定构建依赖，打包前会自动运行语法、产品身份和核心测试。开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全反馈见 [SECURITY.md](SECURITY.md)，Logo 说明见 [品牌资产](assets/README.md)。GitHub tag 发布仅生成 GitHub Release，不会发布到 VS Code Marketplace。

可选开发验证依赖 NumPy / SciPy，用户运行插件不需要这些依赖：

```bash
python scripts/verify-scipy.py
# 可选：直接提取现有分析脚本的数值函数，对相同合成输入逐点比较
python scripts/verify-scipy.py --reference-script /path/to/analyze_ssvep_frequency_quality.py
node scripts/verify-real.cjs /path/to/bigshen_eeg_collection /path/to/assr/session
```

数值验证包括任意长度 FFT、正弦功率积分、逐频点 SciPy 周期图及 Welch 比对、缺失段窗口权重、单位缩放以及逐样本 SOS、SSVEP FIR／陷波／插值比对，以及原始单位切换与平均波形 PSD 定义。真实数据脚本读取所有会话元数据，并检查代表性 trial 和 ASSR 阶段的切片与 PSD。

当前范围：本地桌面 VS Code，以及在远程工作区扩展宿主上运行的磁盘访问。暂不支持浏览器版 VS Code、设备直连、实时串口采集、EDF/BDF、头皮图、时频图或多 trial 的统计汇总。

为保持浏览响应，单个 EEG CSV 限制为 256 MB / 200 万样本；目录扫描限制为 8 层和 30,000 个条目，缓存最近两份记录。没有跨机器的加载耗时或帧率保证。
