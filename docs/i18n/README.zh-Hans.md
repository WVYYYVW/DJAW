# DJAW

[日本語](../../README.md) | [English](README.en.md) | **简体中文** | [繁體中文](README.zh-Hant.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md)

一款 DAW 风格（非实时）的 DJ 混音编辑器。在按小节的引导下衔接曲目，画出推子、EQ、效果和人声的变化，然后导出混音。支持 Windows 和 Mac（Apple 芯片）。

- `src/` — Windows / Mac 通用版（Electron + TypeScript）
- `mac/` — 早期的 macOS 版（SwiftUI），最初的行为规范来源
- 设计细节 → [`docs/PORTING.md`](PORTING.zh-Hans.md)（各语言版本在 `docs/i18n/`）

仅供个人使用（部分内置模型为非商业许可）。

## 安装

从 [Releases](https://github.com/WVYYYVW/DJAW/releases) 下载：
- **Windows**：`DJAW-Setup-x.y.z.exe`
- **Mac（Apple 芯片）**：`DJAW-x.y.z-mac-arm64.dmg`

安装一次后，每次启动都会自动更新到新版本。

## 从源码运行

需要 [Node.js](https://nodejs.org/) 22 或更高版本（LTS）和 Git。

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … 构建后启动（开发用）。
- `npm run dist` … 生成安装程序（`dist/`）。
- `npm test` … 渲染引擎的测试（不会发出声音）。

分析结果和音频缓存保存在 `%APPDATA%\DJAW`（Mac 为 `~/Library/Application Support/DJAW`）。

## 语言

日本語、English、简体中文、繁體中文、한국어、Español、Français、Deutsch、Italiano、Português、Русский。
首次启动时使用系统语言，可在“语言”菜单中切换。

## 界面

类似 Ableton Live。
- 顶部：文件名、播放控制、时间、BPM、吸附（位于窗口中央）、视觉、演奏指南、导出
- 左侧：浏览器（混音顺序和曲库）。拖动可改变宽度和上下比例。曲库支持文件夹、搜索、排序（名称、BPM、调性、与所选曲目的搭配度等，可对全部曲目或单个文件夹）以及拖动调整顺序
- 中间：编排区（碟机 A / B、叠加曲目用的碟机 C / D、MIX、采样器；采样器轨道可隐藏）
- 底部：详细面板（Ctrl+Alt+I），标签页：概览、混音、曲目、过渡、CUE、循环、效果、采样器、碟机。按 Ctrl+Alt+F 最大化。在 16:9 全屏时，过渡编辑器无需滚动即可完整显示

## 功能

- 添加和分析曲目：BPM、强拍（Beat This!）、结构（前奏、Drop 等，也显示在 CUE 编辑器中）、调性、响度、流派（EffNet）、AI 提示点（CUE-DETR）。可从 iTunes / 音乐 资料库导入
- 在时间轴上编辑：曲目重叠的位置和长度、切入、循环 / 跳转、效果
- **变速**：在混音过程中改变 BPM。可选择变化开始的位置（过渡之后、与过渡同时等）以及用多少小节完成（例如把 −7.5% 的曲目用 8 小节恢复到 0.0%）
- **叠加曲目（4 台碟机）**：在一首曲目上完整叠加播放另一首（碟机 C / D），可选仅人声或仅伴奏。碟机显示和混音台也变为 4 通道
- **从循环中衔接**：可选择在循环的第几遍进入下一首
- 过渡编辑器：画出推子、EQ、滤波、回声、混响以及人声 / 鼓 / 贝斯 / 旋律的曲线。预设、候选（Take）和保存自己的过渡
- 自动混音（模式、候选、渲染检查）、自动编排（包括曲目顺序）、演奏指南和 SoundCloud 曲目列表
- 分轨分离：人声、鼓、贝斯、旋律（Spleeter 4stems）
- 采样器：8 个打击垫（Q–I 键），按拍放置（录制、滚奏、音量）。内置声音（汽笛、Dub 警报、上升音效、冲击音、Gabber 底鼓等）全部为 DJAW 原创合成，可在混音、现场演出和发布中自由使用
- 导出：WAV（24 位）/ M4A（AAC 256 kbps），44.1 / 48 kHz，带视觉的 MP4（自动 VJ），实时视觉预览（Ctrl+Alt+V）
- 保存：一个 `.djaw` 文件包含音频（WAV 等无损曲目以无损 FLAC 保存，体积约为一半，音质完全相同）。启动时自动打开上次的混音

预览播放与导出使用同一引擎，所以听到的就是导出的结果。

模型许可证：`models/ThirdPartyNotices.txt`（EffNet 为非商业许可）。
