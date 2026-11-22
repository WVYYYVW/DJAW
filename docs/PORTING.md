# Windows 移植：設計の詳細・対応表・落とし穴

**日本語** | [English](i18n/PORTING.en.md) | [简体中文](i18n/PORTING.zh-Hans.md) | [繁體中文](i18n/PORTING.zh-Hant.md) | [한국어](i18n/PORTING.ko.md) | [Español](i18n/PORTING.es.md) | [Français](i18n/PORTING.fr.md) | [Deutsch](i18n/PORTING.de.md) | [Italiano](i18n/PORTING.it.md) | [Português](i18n/PORTING.pt.md) | [Русский](i18n/PORTING.ru.md)

`CLAUDE.md` の続き。Mac 版（`mac/DJAW`）のコードが **仕様の正本**。数値・曲線・閾値はそのまま写すこと
（ユーザーが長い時間をかけて耳で調整してきた値ばかり）。

---

## 1. Electron アプリの構成案

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main：ウィンドウ、メニュー（Mac 版 MyApp.swift のメニュー構成）、ダイアログ、自動保存、最近使ったファイル
src/core/               UI に依存しない TypeScript（Node 単体でテストできること）
  models.ts             Models.swift（Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…）
  tempo.ts              TempoFX.swift（TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState）
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() など
  project.ts            .djaw 読み書き（DJAWPACK）
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer(ONNX), AnalysisCache
  render/*.ts           Voice（読み出し→伸縮→EQ→FXKernel→エコー→リバーブ→フェーダー）, RenderSession, WAV 書き出し, ミックス波形
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts（プレビュー・書き出し・波形。Web Worker）, analysis.child.ts（解析。子プロセス）
src/renderer/           React UI（store.ts＝MixStore の UI 状態部分、components/…）
src/vendor/stretch-core.mjs   tools/signalsmith/make-core.mjs で生成
tests/                  core のテスト（Node）
```

- `BrowserWindow` は `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true` で良い
  （ローカルファイルしか扱わない個人用アプリ。fs を Worker から直接使えるのが大きい）。
- 状態管理：MixStore は「ドキュメント（clips, library, masterBPM, gridOffset…）＋ UI 状態」。
  ドキュメント部分は純粋関数（`core/`）で更新し、Undo は Mac 版と同じくスナップショット（最大 300）。
- ID：Swift の UUID は大文字の文字列で保存される → `crypto.randomUUID().toUpperCase()`。

## 2. 音声データの扱い

- **デコード**：renderer で `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → 44.1kHz に揃う。
  AIFF は Chromium が読めないので自前で（ヘッダ解析＋ビッグエンディアン PCM）。
- **PCM キャッシュ**：`<userData>/cache/pcm/<指紋>.pcm`（16bit ステレオ・インターリーブ、ヘッダに長さとサンプルレート）。
  読み出しは `fs.readSync` で必要な範囲だけ。曲の長さは元ファイルのサンプル数／元のサンプルレートから（Mac 版 `duration` と一致させる）。
- **指紋**（`AnalysisCache.fingerprint`）：SHA-256（`"<サイズ>"` ＋ 先頭 256KB ＋ サイズ > 512KB なら末尾 256KB）。小文字 16 進。
  解析・プロファイル・ステムのキャッシュはすべてこれがキー。Mac 版と同じ値になるので `.djaw` の `profiles` などが共有できる。
- **メタデータ**：`music-metadata`（タイトル・アーティスト・ジャケット・ジャンルタグ）。

## 3. 描画エンジン（いちばん大事）

Mac 版 `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift` を読むこと。

### 時間の単位
- タイムラインは **reference 秒**（基準 BPM＝`masterBPM` での秒）。テンポ変更があると実時間（real）とずれる。
  `TempoMap.real(t)`, `reference(atReal:)` で変換。サンプル位置は常に **real 秒 × サンプルレート**。
- 曲 `c` の再生速度 `rate = master / c.bpm`（`tempoSync` のとき）。テンポマップ下では `c.rate(tempo.bpm(at: t))`。
- 1 曲が再生する元音源の区間は `playSegments()`（ループ・ジャンプ込み）。経過 `elapsed` は元音源の秒。

### ステップ
- ミックス先頭から数えて **512 フレーム境界** ごとに 1 ステップ。曲の開始フレームがステップ途中にあれば、そこで区切る（`nextChunk`）。
- 各ステップの中央の時刻 `t` で `Automation.state(clips, i, t, master)` を評価し、全声部に適用。
- 曲ごとの声部は、その曲の開始フレーム **ちょうど** から動き出す（Mac 版で、途中参加の伸縮ユニットのずれに長く苦しんだ）。
  終了後も `tail = 8` 秒はエコー・リバーブの残響のため動かす。

### 声部の中身（Chain）
1. **読み出し**（`ClipSchedule.ranges` / `BufferFeeder`）：区間ごとに読み出し。
   最初の区間の頭に **3ms のフェードイン**。次の曲が `cut` のときは最後の **5ms をフェードアウト**。
   ブレーキ／バックスピン（`OutroFX`）は終わりの部分を `TurntableFX.render` の結果に差し替え（そのまま移植）。
2. **伸縮・ピッチ**：signalsmith-stretch。`stretchRate`（1 ちょうどは 1.00002 にして常に処理）。
   キーロック OFF（レコード）なら `pitchCents` 分トランスポーズ、キーシフト ±6 半音。
   出力ブロックごとに `inN = round(outN × rate)`（端数は持ち越して累積誤差ゼロ）。
   遅延（入出力合計 5292 サンプル @44.1k）は、声部の開始時に「開始位置より前の入力」でシークしてから出力を捨てる等で **正確に打ち消す**。
   テスト：クリック列を通し、出力上のクリック位置が `(入力位置 − 開始位置) / rate` に ±1 サンプルで一致すること。
3. **EQ**（`DJEQ.configure`）：ローシェルフ 180Hz／ピーキング 1kHz・帯域幅 2 オクターブ／ハイシェルフ 4.5kHz。
   ゲインは `state.low/mid/high`（dB、キルは −40dB、MID は −24dB）。Apple の AVAudioUnitEQ 相当の双二次フィルタで。
4. **DJ FX**：`FXKernel`（フィルター・フェイザー・フランジャー・ビットクラッシャー・ゲート・ロール）はサンプル単位の処理なので **そのまま移植**。
5. **エコー**：AVAudioUnitDelay 相当（遅延 = 拍 × 0.75（エコーアウト）または `echoDiv`、フィードバック 55%（FX のときは 30＋30×量）、
   ローパス 7kHz、wet/dry）。エコーアウトでは `send` を 1 拍後に 0 にして残響だけ残す。
6. **リバーブ**：AVAudioUnitReverb の largeHall2 相当（Freeverb などで近い響き）。wet = 55% × 量。
7. **フェーダー**：`state.volume`（ゲイン×ラウドネス補正×包絡）。

- **ステム**（第3段階）：ボーカル／伴奏の 2 つの読み出しを混ぜてから伸縮へ（`stemMix`）。
- **プレビュー**：同じセッションを Worker で 0.25 秒先まで描画し、AudioWorklet に送る。
  レベル・EQ・FX・曲線だけの変更は描画中のセッションに反映（`update`）。音の位置が変わる変更（`structureKey` が変わる）は、今の位置から作り直す。
  再生位置表示は「Worklet が実際に出したフレーム数」から求め、表示側は補間して滑らかに（Mac 版 `smoothPlayhead`）。
- **書き出し**：WAV 24bit と M4A（AAC 256kbps）、44.1k/48k。ノーマライズはピークを −1dBFS に（増幅は最大 4 倍、`OfflineRenderer.normalizeGain`）。ノーマライズ時は 1 回目でピークを測り 2 回目で書く（ミックス波形のピークが使えれば 1 回で済む）。残り時間は安定段階に入ってから推定。

## 4. `.djaw` 形式（Mac 版と相互に読み書き）

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile（キーはソート、日付は ISO8601）
音声ファイル           元ファイルのバイト列をそのまま連結（media[].offset は JSON の直後からの相対）
```
- 先頭が `DJAWPACK` でなければプレーン JSON（古い形式・自動保存）。
- `ProjectFile`：`format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` など（`Models.swift` 末尾）。
- `clips[].url` は `file:///Users/...` の URL 文字列（Mac のパス）。開くときの解決順：埋め込み音声（`mediaID` → 展開先フォルダ）→ `relativePath`（.djaw からの相対）→ `url` → 見つからなければ「見つからないファイル」として再リンクを促す。
  保存時は Windows のパスを `file:///C:/...` で書く。
- 埋め込み音声の展開先：Mac は `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<元のファイル名>`。Windows は `%APPDATA%/DJAW/Media/<projectID>/`。
- `analyses`：指紋 → Mac 版の解析結果（LZFSE 圧縮のバイナリ plist）。Windows では読めなくてよい（自前で解析し直す）が、
  **保存時に消さずにそのまま残す**と Mac で開いたときに再解析が要らない。Windows 版の解析結果は別キー（例 `analysesWin`）に入れる。
- 実例：ユーザーの `hyperflip.djaw`（約 400MB、9 曲埋め込み、5 曲ミックス＋4 曲ライブラリ、masterBPM 107、テンポ変更あり、カスタムレーンあり）。

## 5. Swift → TypeScript 対応表

| Swift | 行数 | 役割 | 段階 | メモ |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | クリップ・曲線・レーン・候補・パレット・ProjectFile | 1 | 計算はそのまま |
| Model/TempoFX.swift | 399 | テンポマップ・FX 定義 | 1 | |
| Model/Automation.swift | 260 | 時刻ごとの音量・EQ・FX・ステム、切り替え点 | 1 | 再生と書き出しの共通処理 |
| Model/Localization.swift | 43 | 日英切り替え | 1 | |
| Model/PerformanceGuide.swift | 454 | 演奏手順・曲リスト | 2 | |
| Model/AutoMixer.swift | 857 | 自動ミックスの計画 | 2 | |
| Audio/AudioAnalyzer.swift | 503 | 読み込み・波形・BPM・頭拍・帯域エネルギー | 1 | |
| Audio/StructureAnalyzer.swift | 517 | 構成（イントロ／ビルド／ドロップ…）・キー | 1 | 自動ミックスとガイドの土台 |
| Audio/NeuralAnalyzer.swift | 603 | Beat This!（拍）・CUE-DETR（CUE 候補） | 1/2 | ONNX 化が必要 |
| Audio/GenreAnalyzer.swift | 487 | ジャンル（EffNet）・声の有無 | 2 | ONNX あり |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS（BS.1770） | 1 | |
| Audio/AnalysisCache.swift | 169 | 指紋・解析キャッシュ | 1 | |
| Audio/AnalysisProgress.swift | 216 | 解析の進み具合・残り時間 | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | AVFoundation 部分は自前 DSP に置き換え |
| Audio/MixRenderSession.swift | 299 | ミックス描画の本体 | 1 | |
| Audio/StreamingPlayback.swift | 185 | プレビュー | 1 | Worker＋AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | 書き出し・ミックス波形（部分描画） | 1 | |
| Audio/DJFX.swift | 464 | FXKernel・ブレーキ／バックスピン | 1 | そのまま移植 |
| Audio/StretchCalibration.swift | 118 | AVAudioUnitTimePitch の速度ずれ補正 | — | **不要**（signalsmith は入力数を直接指定できる） |
| Audio/TransitionCheck.swift | 187 | 自動つなぎの試聴チェック | 2 | |
| Audio/StemSeparator.swift | 231 | Spleeter ボーカル分離 | 3 | ONNX 化が必要 |
| Audio/MusicLibrary.swift | 97 | ミュージック.app ライブラリ | 2 | iTunes／ミュージックのライブラリ XML を読む（`src/core/musicLibrary.ts`） |
| Store/MixStore.swift | 3352 | 状態・編集操作・レイアウト・再生・保存・書き出し | 1(+2) | 自動ミックス部分は第2段階 |
| Store/MixStore+Locks.swift | 83 | つなぎのロック | 1 | |
| Store/MixStore+Loudness.swift | 55 | ラウドネス合わせ | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | ミックス波形（差分描画・アイドル時に全体） | 1 | |
| Store/MixStore+Simplify.swift | 169 | つなぎの単純化 | 1 | |
| Store/MixStore+Takes.swift | 92 | つなぎ候補 | 1 | |
| Store/MixStore+Profiles.swift | 105 | 曲の情報・ジャケット | 2 | |
| Store/MixStore+Stems.swift | 49 | ステムの準備 | 3 | |
| Store/ProjectContainer.swift | 136 | .djaw 形式 | 1 | |
| Store/DebugHarness.swift | 514 | 開発用の自動テスト命令 | — | Windows では Node テストで代替 |
| Timeline/TimelineNSView.swift | 1655 | タイムライン（A/B 2 レーン、小節ルーラー、つなぎ帯、ドラッグ操作、ミックス波形、再生ヘッド追従） | 1 | Canvas。描画範囲だけ描く、再生ヘッドだけ再描画 |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | 右パネル（つなぎ・デッキ・FX・ミキサー、候補、曲の使い方） | 1 | |
| Views/TransitionEditorView.swift | 836 | つなぎエディタ（レーン描画、ルーラーで試聴） | 1 | |
| Views/CueEditorView.swift | 891 | CUE エディタ（単独試聴、IN/OUT、グリッド調整） | 1 | |
| Views/DeckPanel.swift | 593 | ターンテーブル・ミキサー表示 | 1 | 補間した時計で滑らかに回す |
| Views/SidebarView.swift | 347 | 曲順・ライブラリ | 1 | |
| Views/TransportViews.swift | 156 | 再生ボタン・時刻・BPM | 1 | |
| Views/ExportSheet.swift | 179 | 書き出し | 1(音声)/3(映像) | |
| Views/ShortcutsView.swift | 116 | ショートカット一覧 | 1 | Ctrl に読み替え |
| Views/AnalysisProgressView.swift | 48 | 解析の進み具合 | 1 | |
| Views/Theme.swift | 108 | 色・書式（Fmt） | 1 | |
| Views/AutoArrangeSheet.swift | 340 | 自動で並べる | 2 | |
| Views/PerformanceGuideView.swift | 162 | 演奏手順・曲リスト | 2 | |
| Views/TrackProfileSheet.swift | 164 | 曲の情報編集 | 2 | |
| Views/MusicLibrarySheet.swift | 313 | ミュージック.app | 2 | XML が無いときはファイルを選ぶ |
| Views/VisualPreviewView.swift | 84 | 映像プレビュー | 3 | |
| Media/TrackProfiles.swift | 123 | 曲プロファイル保存 | 2 | |
| Media/VideoExporter.swift | 445 | 映像書き出し | 3 | |
| Media/VisualPainter.swift | 583 | 映像の絵作り・オート VJ | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | メニュー・全体レイアウト | 1 | |

## 6. ML モデル（ONNX が必要）

ライセンスは `mac/DJAW/ML/ThirdPartyNotices.txt`。前処理用の行列（`*_fbank_*.f32`, `*_melfb_*.f32`）とラベルは `mac/DJAW/ML/` に入っている。
元データはユーザーの Mac の `~/Downloads` にある（必要になったらユーザーに Windows へコピーしてもらう。権限は最初にまとめて聞く）。

| モデル | 元データ（Mac の ~/Downloads） | Windows での形 |
|---|---|---|
| Beat This!（拍・小節頭, MIT） | `final0.ckpt`（81MB, PyTorch） | `beat_this` の公式コードで読み、ONNX へ書き出し。前処理は `beatthis_fbank_513x128.f32`。推論は onnxruntime-node |
| CUE-DETR（CUE 候補, MIT） | `model.safetensors`（166MB, HF transformers の DETR） | transformers で読み ONNX へ。前処理 `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet（ジャンル, CC BY-NC-SA） | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`, ヘッド `genre_discogs400-...pb`、`DJAW_heads/*.onnx` | 本体とヘッド 4 つは ONNX のまま使える。genre400 ヘッドは .pb → ONNX（tf2onnx）か、重みを取り出して行列計算 |
| Spleeter 2stems（MIT） | Mac 版では PyTorch に組み直して Core ML 化（TF と相対誤差 8e-6 で一致を確認済み） | 同じ手順で ONNX 化。STFT 4096/1024、1024 ビン × 512 フレーム、伴奏＝原音−ボーカル |

推論は analysis.child（Electron を Node として起動した子プロセス）で。**onnxruntime-node は renderer の Web Worker では動かない**（読み込むと renderer ごと落ちる）ため。Mac 版の前処理（`NeuralAnalyzer.swift`, `GenreAnalyzer.swift`, `StemSeparator.swift`）を厳密に写すこと。

## 7. 落とし穴・経緯（Mac 版で分かったこと）

- **書き出しとプレビューの一致**：Mac 版は当初、プレビュー用に別のリアルタイム経路を持っていて、曲の入りが書き出しとずれた。
  最終的に「プレビューも書き出しと同じセッションで描画して流す」形にした。Windows 版は最初からこの形で。
- **伸縮ユニットの遅延と速度ずれ**：途中から加わった声部が遅れる／早まる、設定速度と実速度のずれで拍が流れる（0.23ms/秒）。
  signalsmith を直接使えば両方とも原理的に起きないが、テストで必ず確認。
- **カットイン**（`updateCutNudges`）：小節線はアタック（キック／スネア）から 10〜40ms ずれていることがある。
  出る曲は次のアタックの直前で止め、入る曲は自分のアタックの直前から始める（`BandEnergies.onsetOffset` の 2ms 包絡で検出）。
  重なりは 5ms だけ残し、出る側 5ms フェードアウト・入る側 3ms フェードイン。
- **自動化の評価時刻**：ステップ境界はミックス先頭基準（途中から再生しても同じ瞬間に評価）。
- **開始直前のレベル**：開始 0.25 秒前の曲は開始直後の値を先に入れておく（カットインの頭が欠けないように）。
- **ミックス波形**：音圧の高い曲は常にクリップしていて、ピークだけだと赤い帯になる → ピーク＋RMS の芯で描く。
  変更があった範囲だけ 10 秒の助走付きで描き直し、後ろは時間方向にずらして使い回す。20 秒操作がなければ全体を正確に描き直す。
- **タイムラインの重さ**：曲が増えると重くなった → 見えている範囲だけ描く、再生中は再生ヘッドの帯だけ無効化、テンポマップ等はリビジョン単位でキャッシュ。
- **色**：隣り合う曲は色相距離 0.15 以上（`separateNeighbourColors`）。
- **同じ曲の二重読み込み禁止**：パス（正規化）と指紋の両方で判定。タイムラインにドロップした曲がライブラリにあれば、それをミックスへ移す。
- **ターンテーブル**：60Hz タイマーと音声クロックの段差でカクつく → 補間した時計（誤差は 15% ずつ補正、50ms 以上ずれたら合わせ直す）で、表示更新ごとに描く。
- **自動 VJ**：短い間隔で切り替わりすぎた → 8 小節フレーズ単位、ドロップの頭で切り替え、最低 2 フレーズ維持。
- **書き出しの残り時間**：最初の推定が当てにならない → 安定段階に入ってからの進み方だけで推定し、5 秒／10 秒単位に丸める。

## 8. 検証データ

ユーザーの Mac `~/Downloads`（必要ならコピーしてもらう）：
- `hyperflip.djaw`（Mac 版のミックス、音声埋め込み）、`hyperflip.wav`（その書き出し）
- `DJAW_pv_export*.wav`（プレビューと書き出しの比較に使った書き出し）
- 曲：`chance-FINAL.wav`, `TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`, `you dont need to fall.mp3`, `01 welcome.wav` ほか

## 9. 0.4.0 で加えた仕様

- **テンポ変更の開始位置**（`Clip.tempoStart`）：`'afterTransition'`（つなぎの後。新しくテンポ変更を作るときの標準）・`'mixIn'` または未設定（つなぎと同時。0.3 以前のミックス）・数値（曲に入ってからの小節数）。
  変化は `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))` から始まり、`tempoRampBars(c)`（`Clip.tempoBars`、未設定ならつなぎの長さ）小節かけて次の BPM へ。
- **重ねる曲**（`ProjectFile.layers`、`Clip.layerOf`・`layerBar`・`layerParts`）：ミックスの曲（ホスト）の小節に固定して上に鳴らす。
  位置は `core/layers.ts` の `placeLayers`、デッキ C／D の割り当ては `layerDecks`（同時に最大 2 曲）。
  描画は重ねる曲ごとに 1 曲だけの RenderSession を作り、`renderNext()` で足し合わせる（`nextChunk` は全セッションの最小）。
  `layerParts` が `vocals`／`instrumental` のときはステムを使い、`Automation.state` がもう一方を 0 にする。
- **ループ中のつなぎ**（`Clip.outPass`）：前の曲がループしているとき、何周目でつなぐか。`elapsedOfSourcePass` でレイアウトに反映。
- **多言語**：`L(ja, en)` の英語を鍵にした表（`src/core/locales/<lang>.json`）。英語がテンプレート文字列の呼び出しには、組み立て時に `scripts/i18n.mjs` が鍵と値を足す。
  自動ミックスのメモのように保存される文は `captureLanguages()` で全言語の印を残し、表示時に `localize()` で今の言語にする。
  鍵の抽出は `node scripts/i18n.mjs extract`、訳の結合は `node scripts/i18n-merge.mjs`（`_parts/c<N>_*.json`、200 個ずつ）。
- **保存サイズ**：埋め込む非圧縮の音声（WAV）は FLAC（`core/flac.ts`、固定予測＋ライス符号、ビット単位で元と一致）にして入れる。MP3 などはそのまま。
