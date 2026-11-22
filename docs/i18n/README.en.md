# DJAW

[日本語](../../README.md) | **English** | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md)

A DAW-style (non-real-time) DJ mix editor. You join tracks with bar-by-bar guides, draw fader, EQ, FX and vocal moves, and export the mix. Runs on Windows and Mac (Apple silicon).

- `src/` — the Windows / Mac app (Electron + TypeScript)
- `mac/` — the earlier macOS app (SwiftUI), the original reference for the behaviour
- Design details → [`docs/PORTING.md`](PORTING.en.md) (translations in `docs/i18n/`)

For personal use (some bundled models have non-commercial licenses).

## Install

From [Releases](https://github.com/WVYYYVW/DJAW/releases):
- **Windows**: `DJAW-Setup-x.y.z.exe`
- **Mac (Apple silicon)**: `DJAW-x.y.z-mac-arm64.dmg`

Once installed, DJAW updates itself to new versions when it starts.

## Run from source

You need [Node.js](https://nodejs.org/) 22 or later (LTS) and Git.

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … builds, then starts the app (for development).
- `npm run dist` … builds the installer (`dist/`).
- `npm test` … tests of the render engine (no sound is played).

Analysis results and audio caches live in `%APPDATA%\DJAW` (`~/Library/Application Support/DJAW` on Mac).

## Languages

日本語, English, 简体中文, 繁體中文, 한국어, Español, Français, Deutsch, Italiano, Português, Русский.
DJAW starts in your system language; switch it from the Language menu.

## Layout

Similar to Ableton Live.
- Top: file name, transport, time, BPM and snap (centred in the window), visuals, playing guide, export
- Left: the browser (mix order and library). Drag to change its width and the split between the two. The library has folders, search, sorting (name, BPM, key, best match with the selected track…, for all tracks or one folder) and drag-to-reorder
- Centre: the arrangement (decks A / B, decks C / D for layered tracks, MIX, sampler; the sampler lane can be hidden)
- Bottom: the detail panel (Ctrl+Alt+I) with tabs: Overview, Mix, Track, Transition, CUE, Loop, FX, Sampler, Decks. Maximize it with Ctrl+Alt+F. In a 16:9 full-screen window the transition editor fits without scrolling

## Features

- Adding and analysing tracks: BPM, downbeats (Beat This!), structure (intro, drop… also shown in the CUE editor), key, loudness, genre (EffNet), AI cue suggestions (CUE-DETR). Import from the iTunes / Music library
- Editing on the timeline: where and how long tracks overlap, cut-ins, loops / jumps, FX
- **Tempo changes**: change the BPM during the mix. Choose where the change starts (after the transition, with it…) and over how many bars (e.g. bring a −7.5% track back to 0.0% over 8 bars)
- **Layered tracks (4 decks)**: play a whole track on top of another (decks C / D), optionally vocals only or instrumental only. The decks view and mixer show 4 channels
- **Mixing out of a loop**: choose on which pass of a loop the next track comes in
- Transition editor: draw fader, EQ, filter, echo, reverb and vocal / drums / bass / melody lines. Presets, takes, and your own saved transitions
- Auto mix (patterns, candidates, rendered checks), auto arrange (including the order), playing guide and SoundCloud track list
- Stem separation: vocals, drums, bass, melody (Spleeter 4stems)
- Sampler: 8 pads (keys Q–I), placed on beats (record, rolls, level). The built-in sounds (air horn, dub siren, risers, impacts, gabber kick…) are all synthesised for DJAW and free to use in mixes, live sets and uploads
- Export: WAV (24-bit) / M4A (AAC 256 kbps), 44.1 / 48 kHz, MP4 with visuals (auto VJ), live visuals preview (Ctrl+Alt+V)
- Saving: one `.djaw` file including the audio (uncompressed tracks such as WAV are stored as lossless FLAC, about half the size, with identical sound). The last mix reopens at startup

Preview playback uses the same engine as export, so what you hear is exactly what gets written.

Model licenses: `models/ThirdPartyNotices.txt` (EffNet is non-commercial).
