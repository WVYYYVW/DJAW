# DJAW — 引き継ぎ書（Claude Code 向け）

DJAW は、ユーザーが自分で作っている **DAW 風（リアルタイムではない）DJ ミックス編集アプリ**（dj.studio のようなもの）。
これまで macOS 用に SwiftUI で作ってきた（`mac/` にソース一式）。**これを Windows で動くように移植し、最終的には新しい版に一本化する**のが今の目標。

このファイルは、Mac 版を作ってきた Claude（claude.ai のクラウドセッション）から、Windows の Claude Code への引き継ぎ書。
最初に全部読み、`docs/` 以下も必要に応じて読むこと。

---

## 1. ユーザーについて・作業ルール（必ず守る）

- 返答は **日本語**。アプリの UI は日本語と英語の両対応（`L("日本語", "English")` 方式。Mac 版 `Model/Localization.swift`）。
- **必要な権限（ファイルアクセス・削除・ダウンロード・インストールなど）は、作業の最初にまとめて聞く**。途中で一つずつ聞かない。
- ユーザーは DJ のプロではない。ハードコア／ブレイクコア（hyperflip など）のミックスを DJAW で作り、DJ 機材で実際にプレイしたり、曲リスト付きで SoundCloud に上げたりしている。
- **手動ミックスが主役**。自動ミックスは補助機能（自動ミックスを叩き台にして手で直す、複数パターンやつなぎ方の候補を比べて選ぶ、という使い方）。
- 曲は自由配置ではなく「小節単位でつなぐ」ガイド付きの操作。カットインなど重ねないつなぎも使う。UI/UX と操作のしやすさを重視。
- 個人利用のみ（非商用ライセンスのモデルを同梱しているため）。
- 作業中に **音を鳴らさない**（ユーザーの PC で勝手に再生しない）。
- ユーザーが作業中のアプリを **勝手に再起動・終了しない**（保存していないミックスが消える）。再起動が必要なら先に聞く。
- 動作確認用に作った一時ファイル（例：`DJAW_*.wav` などのデバッグ出力）は、終わったら消す。
- 返答は簡潔に。結果を中心に、何が変わったかをユーザーの言葉で説明する。

---

## 2. 決まっていること（2026-11-05 にユーザーが選択）

| 項目 | 決定 |
|---|---|
| 技術 | **Electron + TypeScript**（Windows / Mac 両対応の 1 本のコード） |
| 範囲 | **段階的に全機能を移植**（下の「段階計画」） |
| Mac 版 | **新しい版に一本化**。移植版が追いついたら Swift 版の開発はやめる |
| 受け渡し | この GitHub リポジトリ（`WVYYYVW/DJAW`）。Windows では clone → `npm install` → `npm start` で起動できる形にする |

---

## 3. リポジトリ構成

```
CLAUDE.md                ← この引き継ぎ書
docs/PORTING.md          ← 設計の詳細・Swift→TS 対応表・落とし穴（必読）
mac/                     ← Mac 版（SwiftUI）一式。仕様の正本。動作の細部はここを読んで合わせる
  DJAW/Audio, Model, Store, Views, Timeline, Media, ML(モデル本体は除外)
  Tools/MixScore         ← ミックスの採点スクリプト（Python）
tools/signalsmith/       ← 音程を保ったテンポ変更ライブラリを直接動かす手順（検証済み）
（これから作る）app/ もしくはルートに Electron アプリ
```

`mac/` の Swift は 2026-11-05 時点の最新（Mac 上のコピーより、この 4 ファイルは新しい：
`Audio/StemSeparator.swift`, `Model/Automation.swift`, `Store/DebugHarness.swift`, `Views/TransitionEditorView.swift`）。

ML モデル本体（`*.mlpackage`, 合計 約 200MB）は容量とライセンスの都合でリポジトリに入れていない。
Windows 版では ONNX が必要になる → `docs/PORTING.md` の「ML モデル」を参照。

---

## 4. Windows 版の設計（要点。詳細は docs/PORTING.md）

**原則：「聞こえる音 ＝ 書き出される音」。** Mac 版は長い時間をかけて、プレビューと書き出しのタイミングを 1 サンプル単位で一致させた。
Windows 版では最初から **1 つの TypeScript 製レンダリングエンジン** で、プレビュー・書き出し・ミックス波形・つなぎチェックを全部作る。

- **プロセス構成**
  - Electron main：ウィンドウ、メニュー、ファイルダイアログ、保存・読み込み。
  - renderer（React）：UI。タイムラインは Canvas。
  - Web Worker（`nodeIntegrationInWorker`）：ミックスの描画（レンダリング）。重い処理は UI スレッドに置かない。
  - 解析用の子プロセス（`ELECTRON_RUN_AS_NODE` で fork）：解析・ONNX 推論・リサンプル。onnxruntime-node は Web Worker 内では落ちるため。
  - 再生：Worker が描画した音を AudioWorklet に流す（Worker → Worklet 間は MessageChannel）。
- **音声の読み込み**：Chromium の `decodeAudioData`（MP3/AAC/M4A/FLAC/WAV/OGG）でデコードし、
  **44.1kHz ステレオ 16bit の PCM キャッシュ**（`userData/cache/pcm/<指紋>.pcm`）に書き出す。以後はそこから必要な範囲だけ読む
  （曲を丸ごとメモリに置かない）。AIFF は自前のパーサで。48kHz 書き出しは最後にリサンプル。
- **テンポ変更（音程維持）**：`signalsmith-stretch`（MIT, WASM）を **AudioWorklet 用ラッパーを外して直接** 使う。
  `tools/signalsmith/` に手順とテストあり（Node で動作確認済み：入力 2646／出力 2646 サンプルの遅延、0.9 倍速で 440Hz → 439.9Hz）。
  出力ブロックごとに入力サンプル数を正確に指定できるので、Mac 版で苦労した「伸縮ユニットの速度ずれ」(StretchCalibration) は不要。遅延は固定値で正確に補正する。
- **ミックスの描画**：Mac 版 `MixRenderSession` と同じ考え方。
  曲ごとの声部（読み出し → 伸縮・ピッチ → 3 バンド EQ → DJ FX → エコー → リバーブ → フェーダー）を足し合わせる。
  自動化（フェーダー・EQ・FX）は **ミックス先頭から数えた 512 フレームごと** に `Automation.state` を評価（開始位置によらず同じ瞬間に評価するため）。
- **プロジェクトファイル**：Mac 版の `.djaw`（`DJAWPACK` コンテナ＋JSON、音声を埋め込み）をそのまま読み書きできるようにする（形式は `docs/PORTING.md`）。
- **UI**：React + TypeScript。見た目と操作は Mac 版に合わせる（SwiftUI のビューを読んで再現）。

---

## 5. 段階計画

### 第1段階：中核（これで「普通に使える」状態）
1. Electron + Vite + React + TypeScript の雛形。`npm start`（開発）、`npm run dist`（Windows インストーラ、electron-builder）。
2. データモデル：`Model/Models.swift`, `TempoFX.swift`, `Automation.swift`, `Localization.swift` をそのまま TS へ（関数・数値は同じに）。
3. 解析：`Audio/AudioAnalyzer.swift`（波形・BPM・頭拍）、`StructureAnalyzer.swift`（イントロ／ドロップ等・キー）、`LoudnessAnalyzer.swift`、`AnalysisCache.swift`（指紋＝サイズ＋先頭/末尾 256KB の SHA-256）。
   ビート検出は Beat This!（ONNX 化が必要）→ まず DSP の BPM 検出で動かし、ONNX ができたら差し替え。
4. 描画エンジン：`Audio/MixRenderSession.swift`, `PlaybackEngine.swift`（`ClipSchedule`, `BufferFeeder`, `Chain`）, `DJFX.swift`（FXKernel と TurntableFX をそのまま移植）, `StreamingPlayback.swift`, `OfflineRenderer.swift`（WAV 書き出し・ミックス波形）。
5. ストア：`Store/MixStore.swift` の編集操作・レイアウト（`layout()`, `updateCutNudges()`）・Undo/Redo・保存/読み込み/自動保存、`MixStore+Locks`, `+Loudness`, `+MixWaveform`, `+Simplify`, `+Takes`, `+Profiles`。
6. 画面：サイドバー（ライブラリ）、タイムライン（`Timeline/TimelineNSView.swift` 1655 行が仕様）、インスペクタ、つなぎエディタ、CUE エディタ、デッキ表示（ターンテーブル・ミキサー）、書き出し画面、ショートカット。
7. `.djaw` の相互読み込み（`mac/` で作ったユーザーの `hyperflip.djaw` が開けること）。

### 第2段階：自動ミックスと補助機能
`Model/AutoMixer.swift`, `MixStore` の自動ミックス部分（パターン・候補・検証 `TransitionCheck.swift`）, `Audio/GenreAnalyzer.swift`（EffNet）, CUE-DETR の CUE 候補, `Model/PerformanceGuide.swift`（演奏手順・曲リスト）, `Views/AutoArrangeSheet.swift`, `MusicLibrarySheet.swift`, 曲のプロファイル（ジャケット・アーティスト）。

### 第3段階：重い機能
ボーカル分離（Spleeter 2stems, `Audio/StemSeparator.swift`）、映像付き書き出しと映像プレビュー（`Media/VideoExporter.swift`, `VisualPainter.swift`, `Views/VisualPreviewView.swift`）。
Windows では WebCodecs（H.264）＋ mp4 マルチプレクサ、または ffmpeg。

各段階の終わりに、ユーザーに使ってもらって確認する。

---

## 6. 検証（自分で確かめてから渡す）

- 描画エンジンは Node だけで動くように作り、**テストで音を確かめる**（クリック音の位置、テンポ変更後の拍の位置、カットインの隙間・重なり、自動化の値）。
- Mac 版との比較：ユーザーの手元（Mac の `~/Downloads`）に Mac 版で書き出した WAV（`DJAW_pv_export13.wav` など）と、そのミックス `hyperflip.djaw` がある。
  同じ `.djaw` を Windows 版で書き出し、曲の入り・切り替えの位置が数 ms 以内で一致するかを相互相関で確かめる（Mac 版でも「書き出しとプレビューの差 約 20ms」を詰める作業をしていた）。
- UI は実際に起動して、画面を見て確かめる。

---

## 7. 参考：Mac 版の状態（2026-11-05）

Mac 版で最近入れた機能（すべて仕様として移植対象）：
- 自動ミックスがユーザーの手作りミックスから学んだ傾向（ジャンル別のペース、ドロップtoドロップ）
- 演奏手順（実機で再現するための操作手順）と SoundCloud 用の曲リスト（切り替え時刻はつなぎの曲線から判定）
- 同じ 2 曲のつなぎ方を複数「候補」として保存・比較・採用（TransitionTake）
- 隣り合う曲の色が被らない（ClipPalette）
- ミックス波形の部分的な再描画（変更箇所だけ描き直し、20 秒操作がなければ全体を正確に描き直し）
- つなぎエディタのレーン：フェーダー・EQ に加え、フィルター・エコー・リバーブ、ボーカル／伴奏
- 映像付き書き出し・映像プレビュー・オート VJ（フレーズ単位で切り替え）・ターンテーブルにジャケット
- 書き出しの残り時間表示（安定した段階に入ってから推定）
- 同じ曲を二重に読み込まない（パスと中身の指紋の両方で判定）
- ターンテーブルの回転を滑らかに（表示の更新に合わせて補間した時計で描く）

Mac 版の既知の課題（Windows 版では設計で回避できる）：書き出しとプレビューの約 20ms の差（AVAudioUnitTimePitch の速度ずれと補正の過渡）。
