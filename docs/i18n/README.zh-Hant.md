# DJAW

[日本語](../../README.md) | [English](README.en.md) | [简体中文](README.zh-Hans.md) | **繁體中文** | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md)

一款 DAW 風格（非即時）的 DJ 混音編輯器。在按小節的引導下銜接曲目，畫出推桿、EQ、效果和人聲的變化，然後匯出混音。支援 Windows 和 Mac（Apple 晶片）。

- `src/` — Windows / Mac 共用版（Electron + TypeScript）
- `mac/` — 早期的 macOS 版（SwiftUI），最初的行為規格來源
- 設計細節 → [`docs/PORTING.md`](PORTING.zh-Hant.md)（各語言版本在 `docs/i18n/`）

僅供個人使用（部分內建模型為非商業授權）。

## 安裝

從 [Releases](https://github.com/WVYYYVW/DJAW/releases) 下載：
- **Windows**：`DJAW-Setup-x.y.z.exe`
- **Mac（Apple 晶片）**：`DJAW-x.y.z-mac-arm64.dmg`

安裝一次後，每次啟動都會自動更新到新版本。

## 從原始碼執行

需要 [Node.js](https://nodejs.org/) 22 或更新版本（LTS）和 Git。

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … 建置後啟動（開發用）。
- `npm run dist` … 產生安裝程式（`dist/`）。
- `npm test` … 算繪引擎的測試（不會發出聲音）。

分析結果和音訊快取存放在 `%APPDATA%\DJAW`（Mac 為 `~/Library/Application Support/DJAW`）。

## 語言

日本語、English、简体中文、繁體中文、한국어、Español、Français、Deutsch、Italiano、Português、Русский。
首次啟動時使用系統語言，可在「語言」選單中切換。

## 介面

類似 Ableton Live。
- 上方：檔名、播放控制、時間、BPM、吸附（位於視窗中央）、視覺、演奏指南、匯出
- 左側：瀏覽器（混音順序和曲庫）。拖曳可改變寬度和上下比例。曲庫支援資料夾、搜尋、排序（名稱、BPM、調性、與所選曲目的搭配度等，可對全部曲目或單一資料夾）以及拖曳調整順序
- 中間：編排區（唱盤 A / B、疊加曲目用的唱盤 C / D、MIX、取樣器；取樣器軌道可隱藏）
- 下方：詳細面板（Ctrl+Alt+I），分頁：概覽、混音、曲目、過渡、CUE、循環、效果、取樣器、唱盤。按 Ctrl+Alt+F 放到最大。在 16:9 全螢幕時，過渡編輯器無需捲動即可完整顯示

## 功能

- 加入和分析曲目：BPM、強拍（Beat This!）、結構（前奏、Drop 等，也顯示在 CUE 編輯器中）、調性、響度、曲風（EffNet）、AI 提示點（CUE-DETR）。可從 iTunes / 音樂 資料庫匯入
- 在時間軸上編輯：曲目重疊的位置和長度、切入、循環 / 跳轉、效果
- **變速**：在混音過程中改變 BPM。可選擇變化開始的位置（過渡之後、與過渡同時等）以及用多少小節完成（例如把 −7.5% 的曲目用 8 小節恢復到 0.0%）
- **疊加曲目（4 台唱盤）**：在一首曲目上完整疊加播放另一首（唱盤 C / D），可選僅人聲或僅伴奏。唱盤顯示和混音台也變為 4 聲道
- **從循環中銜接**：可選擇在循環的第幾遍進入下一首
- 過渡編輯器：畫出推桿、EQ、濾波、回聲、殘響以及人聲 / 鼓 / 貝斯 / 旋律的曲線。預設、候選（Take）和儲存自己的過渡
- 自動混音（模式、候選、算繪檢查）、自動編排（包括曲目順序）、演奏指南和 SoundCloud 曲目清單
- 分軌分離：人聲、鼓、貝斯、旋律（Spleeter 4stems）
- 取樣器：8 個打擊墊（Q–I 鍵），按拍放置（錄製、滾奏、音量）。內建聲音（汽笛、Dub 警報、上升音效、衝擊音、Gabber 大鼓等）全部為 DJAW 原創合成，可在混音、現場演出和發布中自由使用
- 匯出：WAV（24 位元）/ M4A（AAC 256 kbps），44.1 / 48 kHz，帶視覺的 MP4（自動 VJ），即時視覺預覽（Ctrl+Alt+V）
- 儲存：一個 `.djaw` 檔包含音訊（WAV 等未壓縮曲目以無損 FLAC 儲存，大小約為一半，音質完全相同）。啟動時自動打開上次的混音

預覽播放與匯出使用同一引擎，所以聽到的就是匯出的結果。

模型授權：`models/ThirdPartyNotices.txt`（EffNet 為非商業授權）。
