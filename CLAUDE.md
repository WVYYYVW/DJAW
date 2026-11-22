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
- **更新したら GitHub の Releases に追加する**（2026-11-09 ユーザーの指示）。手順：`package.json` の version を上げる → `RELEASE_NOTES.md` をその版の内容に書き換える → commit・push → Actions の「Release」を起動（`gh api -X POST repos/WVYYYVW/DJAW/actions/workflows/release.yml/dispatches -f ref=main`。クラウドのセッションからはタグの push が通らないため。タグはワークフローが付ける）。Windows インストーラと Mac（Apple シリコン）の dmg が GitHub の機械で作られて載る。

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

## 6.5 Windows 版の進み具合（2026-11-06）

第1〜3段階をすべて移植済み（Mac 版と同じ機能）。主なファイル：
- 描画：`src/core/render/`（session.ts＝MixRenderSession、ステムは `openStems`、offline.ts、mixWaveform.ts＝差分描画、video.ts＝映像書き出し、mp4.ts、resampler.ts、check.ts＝つなぎチェック）
- 映像：`src/core/visuals.ts`（VisualPainter・特徴量・オート VJ。Canvas 2D を y 反転して CoreGraphics と同じ座標で描く）
- 解析：`src/core/analysis/`（neural.ts＝Beat This!/CUE-DETR、genreModel.ts、stems.ts＝Spleeter）。ONNX は子プロセス（解析用とステム用の 2 本）
- 自動ミックス：`src/core/automixer.ts`、`src/renderer/store/automix.ts`、演奏手順 `src/core/performance.ts`
- ストア拡張：`src/renderer/store/{automix,simplify,profiles,video,stems,libraryFolders,sampler,loops}.ts`（`declare module './store'` で MixStore に足す方式。store.ts からこれらを import しないこと＝循環 import で起動時に落ちる）
- AAC エンコーダが無い環境（Linux、CI の Mac・Windows Server など。Electron は OS の AAC エンコーダを使えないことがある）では、映像の音声は Opus 48kHz に自動で切り替え。書き出し画面の M4A は押せなくなり WAV になる
- クラウド（MEGA）機能は 0.3.6 で削除（ユーザーの指示）。クラウドに保存したミックスの曲は relativePath で探す（`core/paths.ts` の `resolveRelative`）ので、そのまま開ける
- 0.3.0（2026-11-18）で Mac 版より先に進んだ機能：ステム4分割（`stems.ts`、Spleeter 4stems を1ステム1ファイルの ONNX に。melody＝原音−他3つ）、ライブラリのフォルダ（`store/libraryFolders.ts`）、サンプラー（`core/sampler.ts`＝拍の位置に正確に鳴らす SamplerVoice、`store/sampler.ts`、`components/SamplerPanel.tsx`、タイムラインのサンプラーレーン）、ループタブ（`store/loops.ts`、`components/LoopEditor.tsx`）
- 画面は Ableton 風（0.3.0〜）：上のツールバー・左のブラウザ・中央のアレンジ（`Timeline.tsx` はトラック見出しを別キャンバス `HEAD_W` で描く）・下の詳細パネル（`components/Panel.tsx`、タブ＝`store.panelTab`）。右インスペクタは廃止し、`Inspector.tsx` は各タブで使う部品の置き場。つなぎ／CUE／ループの各エディタはパネル内に埋め込み。エディタのキー操作は `store.focusArea === 'panel'`（最後にパネル内をクリックした）の時だけ効く
- 作業の進め方（2026-11-18 ユーザーの指示）：大きな変更はブランチで進め、デバッグしてバグが無いことを確かめてから main に入れて push する
- 解析用プロセス（0.3.2〜）：レンダラーからではなく**メインプロセスから** fork し（`src/main/analysisHost.ts`）、MessagePort で中継する。Mac ではレンダラー（ヘルパーアプリ）から起動すると落ちる。Electron の utilityProcess は起動引数にファイルがあると別のスクリプトを読むので使わない
- Mac では onnxruntime のメモリアリーナを切る（`beatmodel.ts`。Electron の PartitionAlloc が大きなアライン確保で SIGTRAP を起こす）
- 自動更新（`src/main/updater.ts`）：このリポジトリ（2026-11-19 から公開）の最新リリースを見る（ログイン不要）。0.3.2 だけは存在しない `DJAW-releases` を見ていたので、0.3.3 は手で入れてもらう必要がある。Windows は NSIS を `/S --updated` で（/S を外すとインストーラーが止まる）、Mac は dmg からアプリを取り出し codesign で検証して終了時に入れ替え。ダウンロードは `session.downloadURL`（Chromium のダウンロード機能、パーティション djaw-updates）で、進み具合は `update:status`（段階・バイト数・速度・残り時間）でレンダラーの `UpdateCard` に送る。ボタン類のアイコンは `.tbtn` の inline-flex で中央に（`.icon` は display:block なので、そうしないと左に寄る）
- E2E テスト（`.github/workflows/e2e.yml`、手動起動。リポジトリが公開になったので GitHub の機械の利用は無料）：`tests/e2e/smoke.cjs` が配布版を起動し、無音再生（`DJAW_MUTE=1`）で音が流れているか・解析・ステム・書き出し（WAV/M4A/映像）・保存・.djaw を引数で開く を確認。`tests/e2e/update.cjs` が 9.9.9 への自動更新、`tests/e2e/onnx-probe.cjs` が解析プロセス単体。スクリーンショットは下書きリリース `e2e-results` に上がる
- 画面（0.3.5〜0.3.6）：ツールバーは3列のグリッドで再生バーが常にウィンドウ中央。詳細パネルは「大きく表示」（`panelMaximized`、Ctrl+Alt+F）でアレンジを隠して全面に（アレンジはマウントしたまま `display:none`）。タブの欄は段組み（`.panel-columns` が CSS columns、`.span-all` で全幅）。全体タブ `components/Overview.tsx`（各曲の波形を Automation.state で整形：フェーダー・EQ・フィルター・ステム。FX の帯・つなぎ・ミックス波形）、FX タブ上部の `components/FXWave.tsx`（波形＋FX ごとの強さのレーン、ドラッグで移動・長さ）
- 曲の読み込み順（0.3.4〜）：保存済みの解析 → 全曲の音声と簡易解析（`analyzeQuick`＝モデルなし、波形・エネルギーのテンポ）→ AI の解析を1曲ずつミックス順（`loadAnalyses`、`addFiles`）。追加した曲は簡易テンポで並べ、AI の結果で `refineProvisional` が直す（手で触った曲は直さない）。読み込み中はミックス波形を止める（`holdMixWaveform`）
- 標準サンプル（0.3.8〜）：`assets/samples/*.wav`（`scripts/make-samples.mjs` で合成。決まった乱数なので作り直しても同じ）、一覧と標準キットは `core/builtinSamples.ts`。asarUnpack で展開（`env.builtinSampleDir()`）。保存時は埋め込まず、別のインストール先のパスはファイル名で付け直す（`prepareSamples`）。新しいミックス（未保存）でサンプラーを開くと標準キットが入る
- Windows のコード署名（0.3.9〜準備）：Certum「Open Source Code Signing in the cloud」（SimplySign）。リリースの Windows ジョブで `scripts/certum-login.ps1` が SimplySign Desktop を入れて自動ログイン（ユーザー名＋TOTP を SendKeys）、`scripts/sign-win.cjs`（electron-builder の `win.signtoolOptions.sign`）が signtool で署名、`signtool verify /pa` で確認。secret `CERTUM_USERNAME`・`CERTUM_OTP`（otpauth:// の URI ごと、または Base32）が無いときは署名しない。ps1 の TOTP は E2E で `-SelfTest`（RFC 6238 の値）
- 映像プレビューの全画面：HTML Fullscreen API（`VisualPreview.tsx` の `toggleFullScreen`）。Electron では Esc で自動で抜けないので自前で処理
- つなぎエディタ（0.3.10〜）：レーンの後ろに成分の波形（`laneWave`：上＝前の曲・下＝この曲。LOW＝低音、MID/HIGH＝低音以外、ステムは分離した WAV を `services/stemPeaks.ts` で読んで表示）。編集グリッド `store.editGrid`（拍単位、0＝なし、設定に保存）は `components/GridSelect.tsx` でつなぎエディタと FX レーンが共有。説明文と選んだ点の操作は高さ固定の `.te-selbar` 行に置く（0.3.12。ツールバーの高さが変わるとレーンが動き、ダブルクリックがずれる）
- リリースの前に E2E を Mac・Windows で通すこと（Linux のクラウドだけの確認で Mac 版が壊れていた前例あり）
- まだ Windows 実機で確認していないもの：AAC（Media Foundation）での M4A／映像書き出し、映像プレビューの別ウィンドウ、iTunes XML の実データ

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
