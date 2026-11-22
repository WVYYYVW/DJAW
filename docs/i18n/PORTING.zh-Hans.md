# Windows 移植：设计细节、对照表与注意事项

[日本語](../PORTING.md) | [English](PORTING.en.md) | **简体中文** | [繁體中文](PORTING.zh-Hant.md) | [한국어](PORTING.ko.md) | [Español](PORTING.es.md) | [Français](PORTING.fr.md) | [Deutsch](PORTING.de.md) | [Italiano](PORTING.it.md) | [Português](PORTING.pt.md) | [Русский](PORTING.ru.md)

接续 `CLAUDE.md`。Mac 版（`mac/DJAW`）的代码是**规范的正本**。数值、曲线和阈值要原样照搬
（几乎都是用户花了很长时间凭耳朵调出来的）。

> 以日文原版为准，本文为译文。

---

## 1. Electron 应用的结构

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main：窗口、菜单（Mac 版 MyApp.swift 的菜单结构）、对话框、自动保存、最近使用的文件
src/core/               不依赖 UI 的 TypeScript（可在 Node 中单独测试）
  models.ts             Models.swift（Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…）
  tempo.ts              TempoFX.swift（TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState）
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() 等
  project.ts            .djaw 读写（DJAWPACK）
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer(ONNX), AnalysisCache
  render/*.ts           Voice（读取→伸缩→EQ→FXKernel→回声→混响→推子）, RenderSession, WAV 导出, 混音波形
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts（预览、导出、波形。Web Worker）, analysis.child.ts（分析。子进程）
src/renderer/           React UI（store.ts＝MixStore 的 UI 状态部分，components/…）
src/vendor/stretch-core.mjs   由 tools/signalsmith/make-core.mjs 生成
tests/                  core 的测试（Node）
```

- `BrowserWindow` 可以用 `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true`
  （只处理本地文件的个人应用。能在 Worker 里直接用 fs 是很大的优势）。
- 状态管理：MixStore 是“文档（clips, library, masterBPM, gridOffset…）＋ UI 状态”。
  文档部分用纯函数（`core/`）更新，撤销与 Mac 版一样使用快照（最多 300 个）。
- ID：Swift 的 UUID 以大写字符串保存 → `crypto.randomUUID().toUpperCase()`。

## 2. 音频数据的处理

- **解码**：在 renderer 中用 `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → 统一为 44.1kHz。
  Chromium 不能读 AIFF，所以自行解析（文件头＋大端 PCM）。
- **PCM 缓存**：`<userData>/cache/pcm/<指纹>.pcm`（16bit 立体声交错，文件头含长度和采样率）。
  用 `fs.readSync` 只读需要的范围。曲目长度按原文件的采样数 / 原采样率计算（与 Mac 版 `duration` 一致）。
- **指纹**（`AnalysisCache.fingerprint`）：SHA-256（`"<大小>"` ＋ 开头 256KB ＋ 大小 > 512KB 时末尾 256KB），小写十六进制。
  分析、档案、分轨的缓存都以它为键。与 Mac 版取值相同，所以 `.djaw` 里的 `profiles` 等可以共用。
- **元数据**：`music-metadata`（标题、艺术家、封面、流派标签）。

## 3. 渲染引擎（最重要）

请阅读 Mac 版的 `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift`。

### 时间单位
- 时间轴使用 **reference 秒**（基准 BPM＝`masterBPM` 下的秒）。有变速时与实际时间（real）不同。
  用 `TempoMap.real(t)`、`reference(atReal:)` 换算。采样位置始终是 **real 秒 × 采样率**。
- 曲目 `c` 的播放速度 `rate = master / c.bpm`（`tempoSync` 时）。在速度图下为 `c.rate(tempo.bpm(at: t))`。
- 一首曲目播放的原音源区间由 `playSegments()` 给出（含循环和跳转）。经过时间 `elapsed` 以原音源秒计。

### 步进
- 从混音开头起每 **512 帧边界** 为一步。曲目的开始帧落在步中间时就在那里切开（`nextChunk`）。
- 在每一步中点的时刻 `t` 评估 `Automation.state(clips, i, t, master)`，并应用到所有声部。
- 每首曲目的声部**恰好**从其开始帧开始运行（Mac 版曾长期被中途加入的伸缩单元的偏移困扰）。
  结束后仍运行 `tail = 8` 秒，用于回声和混响的余音。

### 声部内部（Chain）
1. **读取**（`ClipSchedule.ranges` / `BufferFeeder`）：逐区间读取。
   第一个区间开头 **3ms 淡入**。下一首是 `cut` 时，最后 **5ms 淡出**。
   刹车 / 倒旋（`OutroFX`）用 `TurntableFX.render` 的结果替换结尾部分（原样移植）。
2. **伸缩 / 音高**：signalsmith-stretch。`stretchRate`（正好为 1 时设为 1.00002，始终处理）。
   键锁关闭（黑胶）时按 `pitchCents` 移调，键位移动 ±6 半音。
   每个输出块 `inN = round(outN × rate)`（余数累积带入，累计误差为零）。
   延迟（44.1k 下输入输出合计 5292 采样）要在声部开始时，用“开始位置之前的输入”定位后丢弃输出等方法**精确抵消**。
   测试：通过一串点击声，输出上的点击位置必须与 `(输入位置 − 开始位置) / rate` 在 ±1 采样内一致。
3. **EQ**（`DJEQ.configure`）：低架 180Hz / 峰值 1kHz、带宽 2 个八度 / 高架 4.5kHz。
   增益为 `state.low/mid/high`（dB，切除为 −40dB，MID 为 −24dB）。用相当于 Apple AVAudioUnitEQ 的双二阶滤波器实现。
4. **DJ FX**：`FXKernel`（滤波、移相、镶边、比特破碎、门限、滚奏）是逐采样处理，**原样移植**。
5. **回声**：相当于 AVAudioUnitDelay（延迟 = 拍 × 0.75（回声淡出）或 `echoDiv`，反馈 55%（FX 时为 30＋30×量），
   低通 7kHz，干湿比）。回声淡出时 1 拍后把 `send` 设为 0，只留下余音。
6. **混响**：相当于 AVAudioUnitReverb 的 largeHall2（用 Freeverb 等接近的声音）。wet = 55% × 量。
7. **推子**：`state.volume`（增益 × 响度补偿 × 包络）。

- **分轨**（第 3 阶段）：把人声 / 伴奏两路读取混合后再进入伸缩（`stemMix`）。
- **预览**：在 Worker 中用同一会话提前渲染 0.25 秒，送往 AudioWorklet。
  只改电平、EQ、FX、曲线时，反映到正在渲染的会话（`update`）。会改变声音位置的修改（`structureKey` 变化）则从当前位置重建。
  播放位置由“Worklet 实际输出的帧数”求出，显示端插值使其平滑（Mac 版 `smoothPlayhead`）。
- **导出**：WAV 24bit 和 M4A（AAC 256kbps），44.1k/48k。标准化把峰值调到 −1dBFS（放大最多 4 倍，`OfflineRenderer.normalizeGain`）。标准化时第 1 遍测峰值、第 2 遍写入（能用混音波形的峰值时 1 遍即可）。剩余时间在进入稳定阶段后才估算。

## 4. `.djaw` 格式（Mac 版与 Windows 版相互读写）

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile（键排序，日期为 ISO8601）
音频文件               原文件的字节原样连接（media[].offset 是相对于 JSON 之后的位置）
```
- 开头不是 `DJAWPACK` 时为普通 JSON（旧格式、自动保存）。
- `ProjectFile`：`format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` 等（`Models.swift` 末尾）。
- `clips[].url` 是 `file:///Users/...` 形式的 URL 字符串（Mac 路径）。打开时的查找顺序：嵌入的音频（`mediaID` → 解包文件夹）→ `relativePath`（相对于 .djaw）→ `url` → 都找不到则作为“丢失的文件”提示重新链接。
  保存时 Windows 路径写成 `file:///C:/...`。
- 嵌入音频的解包位置：Mac 为 `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<原文件名>`，Windows 为 `%APPDATA%/DJAW/Media/<projectID>/`。
- `analyses`：指纹 → Mac 版的分析结果（LZFSE 压缩的二进制 plist）。Windows 可以不读（自行重新分析），但
  **保存时原样保留**，这样在 Mac 上打开时无需重新分析。Windows 版的分析结果放在另一个键（如 `analysesWin`）。
- 实例：用户的 `hyperflip.djaw`（约 400MB，嵌入 9 首，混音 5 首＋曲库 4 首，masterBPM 107，有变速，有自定义轨道）。

## 5. Swift → TypeScript 对照表

| Swift | 行数 | 作用 | 阶段 | 备注 |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | 片段、曲线、轨道、候选、配色、ProjectFile | 1 | 计算原样照搬 |
| Model/TempoFX.swift | 399 | 速度图、FX 定义 | 1 | |
| Model/Automation.swift | 260 | 各时刻的音量、EQ、FX、分轨，切换点 | 1 | 播放与导出共用 |
| Model/Localization.swift | 43 | 日英切换 | 1 | |
| Model/PerformanceGuide.swift | 454 | 演奏步骤、曲目列表 | 2 | |
| Model/AutoMixer.swift | 857 | 自动混音的规划 | 2 | |
| Audio/AudioAnalyzer.swift | 503 | 读取、波形、BPM、强拍、频段能量 | 1 | |
| Audio/StructureAnalyzer.swift | 517 | 结构（前奏 / 铺垫 / Drop…）、调性 | 1 | 自动混音和指南的基础 |
| Audio/NeuralAnalyzer.swift | 603 | Beat This!（拍）、CUE-DETR（提示点候选） | 1/2 | 需要转为 ONNX |
| Audio/GenreAnalyzer.swift | 487 | 流派（EffNet）、是否有人声 | 2 | 有 ONNX |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS（BS.1770） | 1 | |
| Audio/AnalysisCache.swift | 169 | 指纹、分析缓存 | 1 | |
| Audio/AnalysisProgress.swift | 216 | 分析进度、剩余时间 | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | AVFoundation 部分换成自有 DSP |
| Audio/MixRenderSession.swift | 299 | 混音渲染主体 | 1 | |
| Audio/StreamingPlayback.swift | 185 | 预览 | 1 | Worker＋AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | 导出、混音波形（局部渲染） | 1 | |
| Audio/DJFX.swift | 464 | FXKernel、刹车 / 倒旋 | 1 | 原样移植 |
| Audio/StretchCalibration.swift | 118 | AVAudioUnitTimePitch 的速度偏差修正 | — | **不需要**（signalsmith 可直接指定输入数） |
| Audio/TransitionCheck.swift | 187 | 自动过渡的试听检查 | 2 | |
| Audio/StemSeparator.swift | 231 | Spleeter 人声分离 | 3 | 需要转为 ONNX |
| Audio/MusicLibrary.swift | 97 | 音乐.app 资料库 | 2 | 读取 iTunes / 音乐 资料库 XML（`src/core/musicLibrary.ts`） |
| Store/MixStore.swift | 3352 | 状态、编辑操作、布局、播放、保存、导出 | 1(+2) | 自动混音部分在第 2 阶段 |
| Store/MixStore+Locks.swift | 83 | 过渡锁定 | 1 | |
| Store/MixStore+Loudness.swift | 55 | 响度匹配 | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | 混音波形（差分绘制、空闲时整体重绘） | 1 | |
| Store/MixStore+Simplify.swift | 169 | 过渡简化 | 1 | |
| Store/MixStore+Takes.swift | 92 | 过渡候选 | 1 | |
| Store/MixStore+Profiles.swift | 105 | 曲目信息、封面 | 2 | |
| Store/MixStore+Stems.swift | 49 | 分轨准备 | 3 | |
| Store/ProjectContainer.swift | 136 | .djaw 格式 | 1 | |
| Store/DebugHarness.swift | 514 | 开发用自动测试命令 | — | Windows 上用 Node 测试代替 |
| Timeline/TimelineNSView.swift | 1655 | 时间轴（A/B 两轨、小节标尺、过渡带、拖动操作、混音波形、播放头跟随） | 1 | Canvas。只画可见范围，只重绘播放头 |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | 右侧面板（过渡、碟机、FX、混音台、候选、曲目用法） | 1 | |
| Views/TransitionEditorView.swift | 836 | 过渡编辑器（轨道绘制、在标尺上试听） | 1 | |
| Views/CueEditorView.swift | 891 | CUE 编辑器（单独试听、IN/OUT、网格调整） | 1 | |
| Views/DeckPanel.swift | 593 | 唱机和混音台显示 | 1 | 用插值时钟平滑旋转 |
| Views/SidebarView.swift | 347 | 曲目顺序、曲库 | 1 | |
| Views/TransportViews.swift | 156 | 播放按钮、时间、BPM | 1 | |
| Views/ExportSheet.swift | 179 | 导出 | 1(音频)/3(视频) | |
| Views/ShortcutsView.swift | 116 | 快捷键列表 | 1 | ⌘ 换成 Ctrl |
| Views/AnalysisProgressView.swift | 48 | 分析进度 | 1 | |
| Views/Theme.swift | 108 | 颜色、格式（Fmt） | 1 | |
| Views/AutoArrangeSheet.swift | 340 | 自动编排 | 2 | |
| Views/PerformanceGuideView.swift | 162 | 演奏步骤、曲目列表 | 2 | |
| Views/TrackProfileSheet.swift | 164 | 编辑曲目信息 | 2 | |
| Views/MusicLibrarySheet.swift | 313 | 音乐.app | 2 | 没有 XML 时选择文件 |
| Views/VisualPreviewView.swift | 84 | 视觉预览 | 3 | |
| Media/TrackProfiles.swift | 123 | 保存曲目档案 | 2 | |
| Media/VideoExporter.swift | 445 | 视频导出 | 3 | |
| Media/VisualPainter.swift | 583 | 画面绘制、自动 VJ | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | 菜单、整体布局 | 1 | |

## 6. 机器学习模型（需要 ONNX）

许可证见 `mac/DJAW/ML/ThirdPartyNotices.txt`。预处理用的矩阵（`*_fbank_*.f32`、`*_melfb_*.f32`）和标签在 `mac/DJAW/ML/`。
原始数据在用户 Mac 的 `~/Downloads`（需要时请用户复制到 Windows。权限在开始时一并询问）。

| 模型 | 原始数据（Mac 的 ~/Downloads） | Windows 上的形式 |
|---|---|---|
| Beat This!（拍、小节头，MIT） | `final0.ckpt`（81MB，PyTorch） | 用 `beat_this` 官方代码读取并导出 ONNX。预处理为 `beatthis_fbank_513x128.f32`。推理用 onnxruntime-node |
| CUE-DETR（提示点候选，MIT） | `model.safetensors`（166MB，HF transformers 的 DETR） | 用 transformers 读取并导出 ONNX。预处理 `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet（流派，CC BY-NC-SA） | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`、头部 `genre_discogs400-...pb`、`DJAW_heads/*.onnx` | 主体和 4 个头部可直接用 ONNX。genre400 头部 .pb → ONNX（tf2onnx），或取出权重做矩阵运算 |
| Spleeter 2stems（MIT） | Mac 版中用 PyTorch 重建并转为 Core ML（与 TF 相对误差 8e-6 内一致，已确认） | 用同样步骤转为 ONNX。STFT 4096/1024，1024 频点 × 512 帧，伴奏＝原音−人声 |

推理在 analysis.child（把 Electron 作为 Node 启动的子进程）中进行。因为 **onnxruntime-node 在 renderer 的 Web Worker 中无法运行**（加载会使整个 renderer 崩溃）。Mac 版的预处理（`NeuralAnalyzer.swift`、`GenreAnalyzer.swift`、`StemSeparator.swift`）必须严格照搬。

## 7. 注意事项与经过（从 Mac 版得到的经验）

- **导出与预览一致**：Mac 版最初为预览单独设有实时路径，曲目进入点与导出有偏差。
  最终改为“预览也用与导出相同的会话渲染后播放”。Windows 版一开始就采用这种形式。
- **伸缩单元的延迟与速度偏差**：中途加入的声部会延迟 / 提前，设定速度与实际速度的偏差使拍子漂移（0.23ms/秒）。
  直接使用 signalsmith 原理上两者都不会发生，但必须用测试确认。
- **切入**（`updateCutNudges`）：小节线有时与起音（底鼓 / 军鼓）相差 10〜40ms。
  退出的曲目在下一次起音前停止，进入的曲目从自己的起音前开始（用 `BandEnergies.onsetOffset` 的 2ms 包络检测）。
  只保留 5ms 重叠，退出侧 5ms 淡出，进入侧 3ms 淡入。
- **自动化的评估时刻**：步边界以混音开头为基准（从中途播放也在同一瞬间评估）。
- **开始前的电平**：开始前 0.25 秒内的曲目先写入开始后的值（避免切入的开头缺失）。
- **混音波形**：响度高的曲目一直在削波，只画峰值会成为一条红带 → 用峰值＋RMS 芯来画。
  只重绘发生变化的范围（带 10 秒助跑），后面的部分在时间方向平移后复用。20 秒没有操作则整体精确重绘。
- **时间轴的负荷**：曲目增多时变慢 → 只画可见范围，播放中只使播放头那一条失效，速度图等按修订版本缓存。
- **颜色**：相邻曲目的色相距离至少 0.15（`separateNeighbourColors`）。
- **禁止重复载入同一曲目**：同时用（规范化后的）路径和指纹判断。拖到时间轴上的曲目如果在曲库中，就把它移到混音中。
- **唱机**：60Hz 定时器与音频时钟的错位导致卡顿 → 用插值时钟（每次修正 15% 的误差，偏差超过 50ms 则重新对齐）在每次画面刷新时绘制。
- **自动 VJ**：切换间隔太短 → 以 8 小节乐句为单位，在 Drop 开头切换，至少保持 2 个乐句。
- **导出的剩余时间**：最初的估计不可靠 → 只用进入稳定阶段后的进度估算，按 5 秒 / 10 秒取整。

## 8. 验证数据

用户 Mac 的 `~/Downloads`（需要时请用户复制）：
- `hyperflip.djaw`（Mac 版的混音，嵌入音频）、`hyperflip.wav`（其导出）
- `DJAW_pv_export*.wav`（用于比较预览与导出的导出文件）
- 曲目：`chance-FINAL.wav`、`TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`、`you dont need to fall.mp3`、`01 welcome.wav` 等

## 9. 0.4.0 新增的规范

- **变速的开始位置**（`Clip.tempoStart`）：`'afterTransition'`（过渡之后；新建变速时的默认值）、`'mixIn'` 或未设定（与过渡同时；0.3 及更早的混音）、数值（进入曲目后的小节数）。
  变化从 `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))` 开始，用 `tempoRampBars(c)`（`Clip.tempoBars`，未设定时为过渡长度）个小节变到下一个 BPM。
- **叠加曲目**（`ProjectFile.layers`、`Clip.layerOf`・`layerBar`・`layerParts`）：固定在混音曲目（宿主）的某个小节上并在其上播放。
  位置由 `core/layers.ts` 的 `placeLayers` 决定，碟机 C / D 的分配由 `layerDecks` 决定（同时最多 2 首）。
  渲染时为每首叠加曲目建立只含一首的 RenderSession，在 `renderNext()` 中相加（`nextChunk` 取所有会话的最小值）。
  `layerParts` 为 `vocals` / `instrumental` 时使用分轨，由 `Automation.state` 把另一部分设为 0。
- **从循环中衔接**（`Clip.outPass`）：前一首在循环时，在第几遍衔接。通过 `elapsedOfSourcePass` 反映到布局。
- **多语言**：以 `L(ja, en)` 的英文为键的表（`src/core/locales/<lang>.json`）。英文是模板字符串的调用，由 `scripts/i18n.mjs` 在构建时补上键和值。
  自动混音备注等会被保存的文字用 `captureLanguages()` 留下所有语言的标记，显示时用 `localize()` 转为当前语言。
  抽取键：`node scripts/i18n.mjs extract`；合并译文：`node scripts/i18n-merge.mjs`（`_parts/c<N>_*.json`，每份 200 条）。
- **保存大小**：嵌入的未压缩音频（WAV）转为 FLAC（`core/flac.ts`，固定预测＋莱斯编码，与原数据逐位一致）。MP3 等保持原样。
