# DJAW

DAW 風（リアルタイムではない）DJ ミックス編集アプリ。小節単位のガイド付きでつなぎ、フェーダー・EQ・FX・ボーカルの動きを描いて、ミックスを書き出す。

- `src/` — Windows / Mac 共通版（Electron + TypeScript）。移植中（第1段階）
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

## いまできること（第1段階）

曲の追加と解析（BPM・頭拍・Beat This! による拍検出・構成・キー）、タイムラインでの編集（つなぐ位置・長さ・カットイン・テンポ変更・ループ／ジャンプ・FX）、
つなぎ方のプリセットとつなぎエディタ（フェーダー・EQ・フィルター・エコー・リバーブの線を描く）、つなぎの候補、CUE エディタ、デッキとミキサーの表示、
プレビュー再生（書き出しと同じエンジン）、WAV 書き出し、`.djaw` の読み書き・自動保存。

これから：自動ミックス・ジャンル解析・CUE 候補（第2段階）、ボーカル分離・映像付き書き出し（第3段階）。
