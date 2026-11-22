# DJAW

[日本語](../../README.md) | [English](README.en.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | **Deutsch** | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md)

Ein DJ-Mix-Editor im DAW-Stil (nicht in Echtzeit). Du verbindest Tracks mit taktgenauen Hilfen, zeichnest Fader-, EQ-, FX- und Vocal-Bewegungen und exportierst den Mix. Läuft unter Windows und auf dem Mac (Apple Silicon).

- `src/` — die Windows- / Mac-App (Electron + TypeScript)
- `mac/` — die frühere macOS-App (SwiftUI), die ursprüngliche Referenz für das Verhalten
- Details zum Aufbau → [`docs/PORTING.md`](PORTING.de.md) (Übersetzungen in `docs/i18n/`)

Für den privaten Gebrauch (einige mitgelieferte Modelle haben nicht-kommerzielle Lizenzen).

## Installation

Unter [Releases](https://github.com/WVYYYVW/DJAW/releases):
- **Windows**: `DJAW-Setup-x.y.z.exe`
- **Mac (Apple Silicon)**: `DJAW-x.y.z-mac-arm64.dmg`

Einmal installiert, aktualisiert sich DJAW beim Start selbst auf neue Versionen.

## Aus dem Quellcode starten

Du brauchst [Node.js](https://nodejs.org/) 22 oder neuer (LTS) und Git.

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … baut und startet dann die App (zum Entwickeln).
- `npm run dist` … baut das Installationsprogramm (`dist/`).
- `npm test` … Tests der Render-Engine (es wird nichts abgespielt).

Analyseergebnisse und Audio-Caches liegen in `%APPDATA%\DJAW` (auf dem Mac `~/Library/Application Support/DJAW`).

## Sprachen

日本語, English, 简体中文, 繁體中文, 한국어, Español, Français, Deutsch, Italiano, Português, Русский.
DJAW startet in der Systemsprache; umstellen über das Menü „Sprache“.

## Oberfläche

Ähnlich wie Ableton Live.
- Oben: Dateiname, Transport, Zeit, BPM und Raster (mittig im Fenster), Visuals, Spielanleitung, Export
- Links: der Browser (Mix-Reihenfolge und Bibliothek). Breite und Aufteilung lassen sich ziehen. Die Bibliothek hat Ordner, Suche, Sortierung (Name, BPM, Tonart, beste Übereinstimmung mit dem gewählten Track …, für alle Tracks oder einen Ordner) und Umsortieren per Ziehen
- Mitte: das Arrangement (Decks A / B, Decks C / D für überlagerte Tracks, MIX, Sampler; die Sampler-Spur lässt sich ausblenden)
- Unten: der Detailbereich (Strg+Alt+I) mit den Tabs Übersicht, Mix, Track, Übergang, CUE, Loop, FX, Sampler, Decks. Mit Strg+Alt+F maximieren. Im 16:9-Vollbild passt der Übergangseditor ohne Scrollen

## Funktionen

- Tracks hinzufügen und analysieren: BPM, Downbeats (Beat This!), Aufbau (Intro, Drop … auch im CUE-Editor), Tonart, Lautheit, Genre (EffNet), KI-Cue-Vorschläge (CUE-DETR). Import aus der iTunes- / Musik-Mediathek
- Bearbeiten in der Timeline: wo und wie lange Tracks überlappen, Cut-ins, Loops / Sprünge, FX
- **Tempowechsel**: das BPM während des Mixes ändern. Wähle, wo der Wechsel beginnt (nach dem Übergang, mit ihm …) und über wie viele Takte (z. B. einen Track von −7,5 % in 8 Takten zurück auf 0,0 %)
- **Überlagerte Tracks (4 Decks)**: einen ganzen Track über einem anderen spielen (Decks C / D), wahlweise nur Vocals oder nur Instrumental. Decks-Ansicht und Mixer zeigen 4 Kanäle
- **Aus einem Loop heraus mixen**: wähle, in welchem Durchlauf des Loops der nächste Track einsteigt
- Übergangseditor: Linien für Fader, EQ, Filter, Echo, Hall und Vocals / Drums / Bass / Melodie zeichnen. Presets, Takes und eigene gespeicherte Übergänge
- Auto-Mix (Muster, Kandidaten, gerenderte Prüfung), automatisches Anordnen (auch die Reihenfolge), Spielanleitung und Trackliste für SoundCloud
- Stem-Trennung: Vocals, Drums, Bass, Melodie (Spleeter 4stems)
- Sampler: 8 Pads (Tasten Q–I), auf Schläge gesetzt (Aufnahme, Rolls, Pegel). Die eingebauten Sounds (Air Horn, Dub-Sirene, Riser, Impacts, Gabber-Kick …) sind alle für DJAW synthetisiert und frei nutzbar in Mixen, Live-Sets und Uploads
- Export: WAV (24 Bit) / M4A (AAC 256 kbit/s), 44,1 / 48 kHz, MP4 mit Visuals (Auto-VJ), Live-Vorschau der Visuals (Strg+Alt+V)
- Speichern: eine `.djaw`-Datei inklusive Audio (unkomprimierte Tracks wie WAV werden verlustfrei als FLAC gespeichert, etwa halb so groß, gleicher Klang). Der letzte Mix öffnet sich beim Start wieder

Die Vorschau nutzt dieselbe Engine wie der Export – was du hörst, wird genau so geschrieben.

Modell-Lizenzen: `models/ThirdPartyNotices.txt` (EffNet ist nicht-kommerziell).
