# DJAW

DAW 風（リアルタイムではない）DJ ミックス編集アプリ。小節単位のガイド付きでつなぎ、フェーダー・EQ・FX・ボーカルの動きを描いて、ミックスを書き出す。

- `src/` — Windows / Mac 共通版（Electron + TypeScript）。Mac 版と同じ機能まで移植済み（2026-11-06）
- `mac/` — macOS 版（SwiftUI）。仕様の正本
- 設計と移植の詳細 → `CLAUDE.md`, `docs/PORTING.md`

個人利用のためのアプリです（同梱している一部のモデルは非商用ライセンス）。

## Windows で動かす

必要なもの：[Node.js](https://nodejs.org/) 22 以上（LTS）と Git。

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … 組み立ててから起動します（開発用）。
- `npm run dist` … Windows のインストーラ（`dist/DJAW Setup x.y.z.exe`）を作ります。
- `npm test` … 描画エンジンのテスト（音は鳴りません）。

Mac 版で作った `.djaw` ファイルはそのまま開けます（音声を含めて保存したもの）。
曲の解析結果・音声のキャッシュは `%APPDATA%\DJAW` に置かれます。

## できること

- 曲の追加と解析（BPM・頭拍・Beat This! による拍検出・構成・キー・ラウドネス・ジャンル（EffNet）・AI の CUE 候補（CUE-DETR））、iTunes／ミュージックのライブラリ XML からの追加
- タイムラインでの編集（つなぐ位置・長さ・カットイン・テンポ変更・ループ／ジャンプ・FX）、ミックス波形（変更箇所だけ描き直し、20 秒操作がなければ全体を正確に描き直し）
- つなぎ方のプリセットとつなぎエディタ（フェーダー・EQ・フィルター・エコー・リバーブ・ボーカル／伴奏の線を描く）、つなぎの候補、単純化、CUE エディタ、デッキとミキサー、曲の情報とジャケット
- 自動ミックス（パターン・つなぎ方の候補・試聴チェック）、おまかせミックス（曲順も）、演奏手順と SoundCloud 用の曲リスト
- ボーカル分離（Spleeter、1 曲 4 分で約 15 秒、`%APPDATA%\DJAW\Stems` に保存）
- 書き出し：WAV（24bit）／M4A（AAC 256kbps）、44.1／48 kHz、映像付き MP4（H.264、オート VJ・パルス・トンネル・レーザー・スペクトラム）、映像プレビュー（別ウィンドウ、Ctrl+Alt+V）
- プレビュー再生は書き出しと同じエンジン。`.djaw` の読み書き・自動保存

`models/` のモデルのライセンスは `models/ThirdPartyNotices.txt`（EffNet は非商用）。
