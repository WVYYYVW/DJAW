# Windows 移植：設計細節、對照表與注意事項

[日本語](../PORTING.md) | [English](PORTING.en.md) | [简体中文](PORTING.zh-Hans.md) | **繁體中文** | [한국어](PORTING.ko.md) | [Español](PORTING.es.md) | [Français](PORTING.fr.md) | [Deutsch](PORTING.de.md) | [Italiano](PORTING.it.md) | [Português](PORTING.pt.md) | [Русский](PORTING.ru.md)

接續 `CLAUDE.md`。Mac 版（`mac/DJAW`）的程式碼是**規範的正本**。數值、曲線和閾值要原樣照搬
（幾乎都是使用者花了很長時間憑耳朵調出來的）。

> 以日文原版為準，本文為譯文。

---

## 1. Electron 應用的結構

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main：視窗、選單（Mac 版 MyApp.swift 的選單結構）、對話方塊、自動儲存、最近使用的檔案
src/core/               不依賴 UI 的 TypeScript（可在 Node 中單獨測試）
  models.ts             Models.swift（Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…）
  tempo.ts              TempoFX.swift（TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState）
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() 等
  project.ts            .djaw 讀寫（DJAWPACK）
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer(ONNX), AnalysisCache
  render/*.ts           Voice（讀取→伸縮→EQ→FXKernel→回聲→混響→推子）, RenderSession, WAV 匯出, 混音波形
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts（預覽、匯出、波形。Web Worker）, analysis.child.ts（分析。子程序）
src/renderer/           React UI（store.ts＝MixStore 的 UI 狀態部分，components/…）
src/vendor/stretch-core.mjs   由 tools/signalsmith/make-core.mjs 生成
tests/                  core 的測試（Node）
```

- `BrowserWindow` 可以用 `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true`
  （只處理本地檔案的個人應用。能在 Worker 裡直接用 fs 是很大的優勢）。
- 狀態管理：MixStore 是“文件（clips, library, masterBPM, gridOffset…）＋ UI 狀態”。
  文件部分用純函式（`core/`）更新，撤銷與 Mac 版一樣使用快照（最多 300 個）。
- ID：Swift 的 UUID 以大寫字串儲存 → `crypto.randomUUID().toUpperCase()`。

## 2. 音訊資料的處理

- **解碼**：在 renderer 中用 `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → 統一為 44.1kHz。
  Chromium 不能讀 AIFF，所以自行解析（檔案頭＋大端 PCM）。
- **PCM 快取**：`<userData>/cache/pcm/<指紋>.pcm`（16bit 立體聲交錯，檔案頭含長度和取樣率）。
  用 `fs.readSync` 只讀需要的範圍。曲目長度按原檔案的取樣數 / 原取樣率計算（與 Mac 版 `duration` 一致）。
- **指紋**（`AnalysisCache.fingerprint`）：SHA-256（`"<大小>"` ＋ 開頭 256KB ＋ 大小 > 512KB 時末尾 256KB），小寫十六進位制。
  分析、檔案、分軌的快取都以它為鍵。與 Mac 版取值相同，所以 `.djaw` 裡的 `profiles` 等可以共用。
- **後設資料**：`music-metadata`（標題、藝術家、封面、流派標籤）。

## 3. 渲染引擎（最重要）

請閱讀 Mac 版的 `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift`。

### 時間單位
- 時間軸使用 **reference 秒**（基準 BPM＝`masterBPM` 下的秒）。有變速時與實際時間（real）不同。
  用 `TempoMap.real(t)`、`reference(atReal:)` 換算。取樣位置始終是 **real 秒 × 取樣率**。
- 曲目 `c` 的播放速度 `rate = master / c.bpm`（`tempoSync` 時）。在速度圖下為 `c.rate(tempo.bpm(at: t))`。
- 一首曲目播放的原音源區間由 `playSegments()` 給出（含迴圈和跳轉）。經過時間 `elapsed` 以原音源秒計。

### 步進
- 從混音開頭起每 **512 幀邊界** 為一步。曲目的開始幀落在步中間時就在那裡切開（`nextChunk`）。
- 在每一步中點的時刻 `t` 評估 `Automation.state(clips, i, t, master)`，並應用到所有聲部。
- 每首曲目的聲部**恰好**從其開始幀開始執行（Mac 版曾長期被中途加入的伸縮單元的偏移困擾）。
  結束後仍執行 `tail = 8` 秒，用於回聲和混響的餘音。

### 聲部內部（Chain）
1. **讀取**（`ClipSchedule.ranges` / `BufferFeeder`）：逐區間讀取。
   第一個區間開頭 **3ms 淡入**。下一首是 `cut` 時，最後 **5ms 淡出**。
   剎車 / 倒旋（`OutroFX`）用 `TurntableFX.render` 的結果替換結尾部分（原樣移植）。
2. **伸縮 / 音高**：signalsmith-stretch。`stretchRate`（正好為 1 時設為 1.00002，始終處理）。
   鍵鎖關閉（黑膠）時按 `pitchCents` 移調，鍵位移動 ±6 半音。
   每個輸出塊 `inN = round(outN × rate)`（餘數累積帶入，累計誤差為零）。
   延遲（44.1k 下輸入輸出合計 5292 取樣）要在聲部開始時，用“開始位置之前的輸入”定位後丟棄輸出等方法**精確抵消**。
   測試：透過一串點選聲，輸出上的點選位置必須與 `(輸入位置 − 開始位置) / rate` 在 ±1 取樣內一致。
3. **EQ**（`DJEQ.configure`）：低架 180Hz / 峰值 1kHz、頻寬 2 個八度 / 高架 4.5kHz。
   增益為 `state.low/mid/high`（dB，切除為 −40dB，MID 為 −24dB）。用相當於 Apple AVAudioUnitEQ 的雙二階濾波器實現。
4. **DJ FX**：`FXKernel`（濾波、移相、鑲邊、位元破碎、門限、滾奏）是逐取樣處理，**原樣移植**。
5. **回聲**：相當於 AVAudioUnitDelay（延遲 = 拍 × 0.75（回聲淡出）或 `echoDiv`，反饋 55%（FX 時為 30＋30×量），
   低通 7kHz，乾溼比）。回聲淡出時 1 拍後把 `send` 設為 0，只留下餘音。
6. **混響**：相當於 AVAudioUnitReverb 的 largeHall2（用 Freeverb 等接近的聲音）。wet = 55% × 量。
7. **推子**：`state.volume`（增益 × 響度補償 × 包絡）。

- **分軌**（第 3 階段）：把人聲 / 伴奏兩路讀取混合後再進入伸縮（`stemMix`）。
- **預覽**：在 Worker 中用同一會話提前渲染 0.25 秒，送往 AudioWorklet。
  只改電平、EQ、FX、曲線時，反映到正在渲染的會話（`update`）。會改變聲音位置的修改（`structureKey` 變化）則從當前位置重建。
  播放位置由“Worklet 實際輸出的幀數”求出，顯示端插值使其平滑（Mac 版 `smoothPlayhead`）。
- **匯出**：WAV 24bit 和 M4A（AAC 256kbps），44.1k/48k。標準化把峰值調到 −1dBFS（放大最多 4 倍，`OfflineRenderer.normalizeGain`）。標準化時第 1 遍測峰值、第 2 遍寫入（能用混音波形的峰值時 1 遍即可）。剩餘時間在進入穩定階段後才估算。

## 4. `.djaw` 格式（Mac 版與 Windows 版相互讀寫）

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile（鍵排序，日期為 ISO8601）
音訊檔案               原檔案的位元組原樣串接（media[].offset 是相對於 JSON 之後的位置）
```
- 開頭不是 `DJAWPACK` 時為普通 JSON（舊格式、自動儲存）。
- `ProjectFile`：`format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` 等（`Models.swift` 末尾）。
- `clips[].url` 是 `file:///Users/...` 形式的 URL 字串（Mac 路徑）。開啟時的查詢順序：嵌入的音訊（`mediaID` → 解包資料夾）→ `relativePath`（相對於 .djaw）→ `url` → 都找不到則作為“丟失的檔案”提示重新連結。
  儲存時 Windows 路徑寫成 `file:///C:/...`。
- 嵌入音訊的解包位置：Mac 為 `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<原檔名>`，Windows 為 `%APPDATA%/DJAW/Media/<projectID>/`。
- `analyses`：指紋 → Mac 版的分析結果（LZFSE 壓縮的二進位制 plist）。Windows 可以不讀（自行重新分析），但
  **儲存時原樣保留**，這樣在 Mac 上開啟時無需重新分析。Windows 版的分析結果放在另一個鍵（如 `analysesWin`）。
- 例項：使用者的 `hyperflip.djaw`（約 400MB，嵌入 9 首，混音 5 首＋曲庫 4 首，masterBPM 107，有變速，有自定義軌道）。

## 5. Swift → TypeScript 對照表

| Swift | 行數 | 作用 | 階段 | 備註 |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | 片段、曲線、軌道、候選、配色、ProjectFile | 1 | 計算原樣照搬 |
| Model/TempoFX.swift | 399 | 速度圖、FX 定義 | 1 | |
| Model/Automation.swift | 260 | 各時刻的音量、EQ、FX、分軌，切換點 | 1 | 播放與匯出共用 |
| Model/Localization.swift | 43 | 日英切換 | 1 | |
| Model/PerformanceGuide.swift | 454 | 演奏步驟、曲目列表 | 2 | |
| Model/AutoMixer.swift | 857 | 自動混音的規劃 | 2 | |
| Audio/AudioAnalyzer.swift | 503 | 讀取、波形、BPM、強拍、頻段能量 | 1 | |
| Audio/StructureAnalyzer.swift | 517 | 結構（前奏 / 鋪墊 / Drop…）、調性 | 1 | 自動混音和指南的基礎 |
| Audio/NeuralAnalyzer.swift | 603 | Beat This!（拍）、CUE-DETR（提示點候選） | 1/2 | 需要轉為 ONNX |
| Audio/GenreAnalyzer.swift | 487 | 流派（EffNet）、是否有人聲 | 2 | 有 ONNX |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS（BS.1770） | 1 | |
| Audio/AnalysisCache.swift | 169 | 指紋、分析快取 | 1 | |
| Audio/AnalysisProgress.swift | 216 | 分析進度、剩餘時間 | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | AVFoundation 部分換成自有 DSP |
| Audio/MixRenderSession.swift | 299 | 混音渲染主體 | 1 | |
| Audio/StreamingPlayback.swift | 185 | 預覽 | 1 | Worker＋AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | 匯出、混音波形（區域性渲染） | 1 | |
| Audio/DJFX.swift | 464 | FXKernel、剎車 / 倒旋 | 1 | 原樣移植 |
| Audio/StretchCalibration.swift | 118 | AVAudioUnitTimePitch 的速度偏差修正 | — | **不需要**（signalsmith 可直接指定輸入數） |
| Audio/TransitionCheck.swift | 187 | 自動過渡的試聽檢查 | 2 | |
| Audio/StemSeparator.swift | 231 | Spleeter 人聲分離 | 3 | 需要轉為 ONNX |
| Audio/MusicLibrary.swift | 97 | 音樂.app 資料庫 | 2 | 讀取 iTunes / 音樂 資料庫 XML（`src/core/musicLibrary.ts`） |
| Store/MixStore.swift | 3352 | 狀態、編輯操作、佈局、播放、儲存、匯出 | 1(+2) | 自動混音部分在第 2 階段 |
| Store/MixStore+Locks.swift | 83 | 過渡鎖定 | 1 | |
| Store/MixStore+Loudness.swift | 55 | 響度匹配 | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | 混音波形（差分繪製、空閒時整體重繪） | 1 | |
| Store/MixStore+Simplify.swift | 169 | 過渡簡化 | 1 | |
| Store/MixStore+Takes.swift | 92 | 過渡候選 | 1 | |
| Store/MixStore+Profiles.swift | 105 | 曲目資訊、封面 | 2 | |
| Store/MixStore+Stems.swift | 49 | 分軌準備 | 3 | |
| Store/ProjectContainer.swift | 136 | .djaw 格式 | 1 | |
| Store/DebugHarness.swift | 514 | 開發用自動測試命令 | — | Windows 上用 Node 測試代替 |
| Timeline/TimelineNSView.swift | 1655 | 時間軸（A/B 兩軌、小節標尺、過渡帶、拖動操作、混音波形、播放頭跟隨） | 1 | Canvas。只畫可見範圍，只重繪播放頭 |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | 右側面板（過渡、唱盤、FX、混音臺、候選、曲目用法） | 1 | |
| Views/TransitionEditorView.swift | 836 | 過渡編輯器（軌道繪製、在標尺上試聽） | 1 | |
| Views/CueEditorView.swift | 891 | CUE 編輯器（單獨試聽、IN/OUT、網格調整） | 1 | |
| Views/DeckPanel.swift | 593 | 唱盤和混音臺顯示 | 1 | 用插值時鐘平滑旋轉 |
| Views/SidebarView.swift | 347 | 曲目順序、曲庫 | 1 | |
| Views/TransportViews.swift | 156 | 播放按鈕、時間、BPM | 1 | |
| Views/ExportSheet.swift | 179 | 匯出 | 1(音訊)/3(影片) | |
| Views/ShortcutsView.swift | 116 | 快捷鍵列表 | 1 | ⌘ 換成 Ctrl |
| Views/AnalysisProgressView.swift | 48 | 分析進度 | 1 | |
| Views/Theme.swift | 108 | 顏色、格式（Fmt） | 1 | |
| Views/AutoArrangeSheet.swift | 340 | 自動編排 | 2 | |
| Views/PerformanceGuideView.swift | 162 | 演奏步驟、曲目列表 | 2 | |
| Views/TrackProfileSheet.swift | 164 | 編輯曲目資訊 | 2 | |
| Views/MusicLibrarySheet.swift | 313 | 音樂.app | 2 | 沒有 XML 時選擇檔案 |
| Views/VisualPreviewView.swift | 84 | 視覺預覽 | 3 | |
| Media/TrackProfiles.swift | 123 | 儲存曲目檔案 | 2 | |
| Media/VideoExporter.swift | 445 | 影片匯出 | 3 | |
| Media/VisualPainter.swift | 583 | 畫面繪製、自動 VJ | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | 選單、整體佈局 | 1 | |

## 6. 機器學習模型（需要 ONNX）

許可證見 `mac/DJAW/ML/ThirdPartyNotices.txt`。預處理用的矩陣（`*_fbank_*.f32`、`*_melfb_*.f32`）和標籤在 `mac/DJAW/ML/`。
原始資料在使用者 Mac 的 `~/Downloads`（需要時請使用者複製到 Windows。許可權在開始時一併詢問）。

| 模型 | 原始資料（Mac 的 ~/Downloads） | Windows 上的形式 |
|---|---|---|
| Beat This!（拍、小節頭，MIT） | `final0.ckpt`（81MB，PyTorch） | 用 `beat_this` 官方程式碼讀取並匯出 ONNX。預處理為 `beatthis_fbank_513x128.f32`。推理用 onnxruntime-node |
| CUE-DETR（提示點候選，MIT） | `model.safetensors`（166MB，HF transformers 的 DETR） | 用 transformers 讀取並匯出 ONNX。預處理 `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet（流派，CC BY-NC-SA） | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`、頭部 `genre_discogs400-...pb`、`DJAW_heads/*.onnx` | 主體和 4 個頭部可直接用 ONNX。genre400 頭部 .pb → ONNX（tf2onnx），或取出權重做矩陣運算 |
| Spleeter 2stems（MIT） | Mac 版中用 PyTorch 重建並轉為 Core ML（與 TF 相對誤差 8e-6 內一致，已確認） | 用同樣步驟轉為 ONNX。STFT 4096/1024，1024 頻點 × 512 幀，伴奏＝原音−人聲 |

推理在 analysis.child（把 Electron 作為 Node 啟動的子程序）中進行。因為 **onnxruntime-node 在 renderer 的 Web Worker 中無法執行**（載入會使整個 renderer 崩潰）。Mac 版的預處理（`NeuralAnalyzer.swift`、`GenreAnalyzer.swift`、`StemSeparator.swift`）必須嚴格照搬。

## 7. 注意事項與經過（從 Mac 版得到的經驗）

- **匯出與預覽一致**：Mac 版最初為預覽單獨設有實時路徑，曲目進入點與匯出有偏差。
  最終改為“預覽也用與匯出相同的會話渲染後播放”。Windows 版一開始就採用這種形式。
- **伸縮單元的延遲與速度偏差**：中途加入的聲部會延遲 / 提前，設定速度與實際速度的偏差使拍子漂移（0.23ms/秒）。
  直接使用 signalsmith 原理上兩者都不會發生，但必須用測試確認。
- **切入**（`updateCutNudges`）：小節線有時與起音（底鼓 / 軍鼓）相差 10〜40ms。
  退出的曲目在下一次起音前停止，進入的曲目從自己的起音前開始（用 `BandEnergies.onsetOffset` 的 2ms 包絡檢測）。
  只保留 5ms 重疊，退出側 5ms 淡出，進入側 3ms 淡入。
- **自動化的評估時刻**：步邊界以混音開頭為基準（從中途播放也在同一瞬間評估）。
- **開始前的電平**：開始前 0.25 秒內的曲目先寫入開始後的值（避免切入的開頭缺失）。
- **混音波形**：響度高的曲目一直在削波，只畫峰值會成為一條紅帶 → 用峰值＋RMS 芯來畫。
  只重繪發生變化的範圍（帶 10 秒助跑），後面的部分在時間方向平移後複用。20 秒沒有操作則整體精確重繪。
- **時間軸的負荷**：曲目增多時變慢 → 只畫可見範圍，播放中只使播放頭那一條失效，速度圖等按修訂版本快取。
- **顏色**：相鄰曲目的色相距離至少 0.15（`separateNeighbourColors`）。
- **禁止重複載入同一曲目**：同時用（規範化後的）路徑和指紋判斷。拖到時間軸上的曲目如果在曲庫中，就把它移到混音中。
- **唱盤**：60Hz 定時器與音訊時鐘的錯位導致卡頓 → 用插值時鐘（每次修正 15% 的誤差，偏差超過 50ms 則重新對齊）在每次畫面重新整理時繪製。
- **自動 VJ**：切換間隔太短 → 以 8 小節樂句為單位，在 Drop 開頭切換，至少保持 2 個樂句。
- **匯出的剩餘時間**：最初的估計不可靠 → 只用進入穩定階段後的進度估算，按 5 秒 / 10 秒取整。

## 8. 驗證資料

使用者 Mac 的 `~/Downloads`（需要時請使用者複製）：
- `hyperflip.djaw`（Mac 版的混音，嵌入音訊）、`hyperflip.wav`（其匯出）
- `DJAW_pv_export*.wav`（用於比較預覽與匯出的匯出檔案）
- 曲目：`chance-FINAL.wav`、`TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`、`you dont need to fall.mp3`、`01 welcome.wav` 等

## 9. 0.4.0 新增的規範

- **變速的開始位置**（`Clip.tempoStart`）：`'afterTransition'`（過渡之後；新建變速時的預設值）、`'mixIn'` 或未設定（與過渡同時；0.3 及更早的混音）、數值（進入曲目後的小節數）。
  變化從 `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))` 開始，用 `tempoRampBars(c)`（`Clip.tempoBars`，未設定時為過渡長度）個小節變到下一個 BPM。
- **疊加曲目**（`ProjectFile.layers`、`Clip.layerOf`・`layerBar`・`layerParts`）：固定在混音曲目（宿主）的某個小節上並在其上播放。
  位置由 `core/layers.ts` 的 `placeLayers` 決定，唱盤 C / D 的分配由 `layerDecks` 決定（同時最多 2 首）。
  渲染時為每首疊加曲目建立只含一首的 RenderSession，在 `renderNext()` 中相加（`nextChunk` 取所有會話的最小值）。
  `layerParts` 為 `vocals` / `instrumental` 時使用分軌，由 `Automation.state` 把另一部分設為 0。
- **從迴圈中銜接**（`Clip.outPass`）：前一首在迴圈時，在第幾遍銜接。透過 `elapsedOfSourcePass` 反映到佈局。
- **多語言**：以 `L(ja, en)` 的英文為鍵的表（`src/core/locales/<lang>.json`）。英文是模板字串的呼叫，由 `scripts/i18n.mjs` 在構建時補上鍵和值。
  自動混音備註等會被儲存的文字用 `captureLanguages()` 留下所有語言的標記，顯示時用 `localize()` 轉為當前語言。
  抽取鍵：`node scripts/i18n.mjs extract`；合併譯文：`node scripts/i18n-merge.mjs`（`_parts/c<N>_*.json`，每份 200 條）。
- **儲存大小**：嵌入的未壓縮音訊（WAV）轉為 FLAC（`core/flac.ts`，固定預測＋萊斯編碼，與原資料逐位一致）。MP3 等保持原樣。
