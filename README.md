# DJAW

**日本語** | [English](docs/i18n/README.en.md) | [简体中文](docs/i18n/README.zh-Hans.md) | [繁體中文](docs/i18n/README.zh-Hant.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Français](docs/i18n/README.fr.md) | [Deutsch](docs/i18n/README.de.md) | [Italiano](docs/i18n/README.it.md) | [Português](docs/i18n/README.pt.md) | [Русский](docs/i18n/README.ru.md)

DAW 風（リアルタイムではない）DJ ミックス編集アプリ。小節単位のガイド付きでつなぎ、フェーダー・EQ・FX・ボーカルの動きを描いて、ミックスを書き出す。Windows と Mac（Apple シリコン）で動きます。

- `src/` — Windows / Mac 共通版（Electron + TypeScript）
- `mac/` — 以前の macOS 版（SwiftUI）。最初の仕様の正本
- 設計の詳細 → [`docs/PORTING.md`](docs/PORTING.md)（各言語版は `docs/i18n/`）

個人利用のためのアプリです（同梱している一部のモデルは非商用ライセンス）。

## インストール

[Releases](https://github.com/WVYYYVW/DJAW/releases) から：
- **Windows**：`DJAW-Setup-x.y.z.exe`
- **Mac（Apple シリコン）**：`DJAW-x.y.z-mac-arm64.dmg`

一度入れれば、起動時に新しい版へ自動で更新されます。

## ソースから動かす

必要なもの：[Node.js](https://nodejs.org/) 22 以上（LTS）と Git。

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … 組み立ててから起動します（開発用）。
- `npm run dist` … インストーラを作ります（`dist/`）。
- `npm test` … 描画エンジンのテスト（音は鳴りません）。

曲の解析結果・音声のキャッシュは `%APPDATA%\DJAW`（Mac は `~/Library/Application Support/DJAW`）に置かれます。

## 言語

日本語・English・简体中文・繁體中文・한국어・Español・Français・Deutsch・Italiano・Português・Русский。
初回は OS の言語で起動し、メニューの「言語」で切り替えられます。

## 画面

Ableton Live に近い作りです。
- 上：ファイル名、再生・時間・BPM・スナップ（ウィンドウの中央）、映像・演奏手順・書き出し
- 左：ブラウザ（ミックス順・ライブラリ）。幅と上下の比率はドラッグで変更。ライブラリはフォルダで整理、検索、並び替え（名前・BPM・キー・選んだ曲との相性など、全曲またはフォルダごと）、ドラッグで順番を入れ替え
- 中央：アレンジ画面（デッキ A／B・重ねる曲のデッキ C／D・MIX・サンプラー。サンプラーのレーンは表示を切り替え可能）
- 下：詳細パネル（Ctrl+Alt+I）。タブ：全体・ミックス・曲・つなぎ・CUE・ループ・FX・サンプラー・デッキ。「大きく表示」（Ctrl+Alt+F）でウィンドウいっぱいに。16:9 の全画面ではつなぎエディタがスクロールなしで収まります

## できること

- 曲の追加と解析：BPM・頭拍（Beat This!）・構成（イントロ／ドロップなど。CUE エディタにも表示）・キー・ラウドネス・ジャンル（EffNet）・AI の CUE 候補（CUE-DETR）。iTunes／ミュージックのライブラリからの追加
- タイムラインでの編集：つなぐ位置・長さ・カットイン・ループ／ジャンプ・FX
- **テンポ変更**：ミックスの途中で BPM を変える。つなぎの後・つなぎと同時など開始位置を選び、何小節かけて変えるかを指定（例：−7.5% の曲を 8 小節で 0.0% に戻す）
- **曲を重ねる（4 デッキ）**：ある曲の上に別の曲を丸ごと重ねて鳴らす（デッキ C／D）。ボーカルだけ・伴奏だけも選べる。デッキ表示とミキサーも 4 チャンネルに
- **ループ中のつなぎ**：ループの何周目で次の曲へつなぐかを選べる
- つなぎエディタ：フェーダー・EQ・フィルター・エコー・リバーブ・ボーカル／ドラム／ベース／メロディの線を描く。プリセット・候補（テイク）・自分のつなぎ方の保存
- 自動ミックス（パターン・候補・試聴チェック）、おまかせミックス（曲順も）、演奏手順と SoundCloud 用の曲リスト
- ステム分離：ボーカル・ドラム・ベース・メロディ（Spleeter 4stems）
- サンプラー：8 パッド（Q〜I キー）。拍の位置に置く（録音・連打・音量）。標準サンプル（エアホーン・ダブサイレン・ライザー・インパクト・ガバキックなど）はすべて DJAW のために合成したオリジナルの音で、ミックス・ライブ・配信で自由に使えます
- 書き出し：WAV（24bit）／M4A（AAC 256kbps）、44.1／48 kHz、映像付き MP4（オート VJ）、映像プレビュー（Ctrl+Alt+V）
- 保存：`.djaw` 1 ファイルに音声ごと保存（WAV などの非圧縮の曲は可逆圧縮 FLAC でおよそ半分に。音質は変わりません）。起動時に前回のミックスを自動で開く

プレビュー再生は書き出しと同じエンジンなので、聞こえる音がそのまま書き出されます。

`models/` のモデルのライセンスは `models/ThirdPartyNotices.txt`（EffNet は非商用）。
