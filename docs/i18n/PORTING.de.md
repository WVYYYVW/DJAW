# Windows-Port: Aufbau im Detail, Zuordnungstabelle und Fallstricke

[日本語](../PORTING.md) | [English](PORTING.en.md) | [简体中文](PORTING.zh-Hans.md) | [繁體中文](PORTING.zh-Hant.md) | [한국어](PORTING.ko.md) | [Español](PORTING.es.md) | [Français](PORTING.fr.md) | **Deutsch** | [Italiano](PORTING.it.md) | [Português](PORTING.pt.md) | [Русский](PORTING.ru.md)

Die Fortsetzung von `CLAUDE.md`. Der Code der Mac-App (`mac/DJAW`) ist **die Referenzspezifikation**. Zahlen, Kurven und Schwellen genau übernehmen
(fast alle hat der Nutzer lange nach Gehör eingestellt).

> Maßgeblich ist das japanische Original; dies ist eine Übersetzung.

---

## 1. Aufbau der Electron-App

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main: Fenster, Menüs (Menüaufbau von MyApp.swift auf dem Mac), Dialoge, Autosave, zuletzt verwendete Dateien
src/core/               UI-unabhängiges TypeScript (muss allein in Node testbar sein)
  models.ts             Models.swift (Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…)
  tempo.ts              TempoFX.swift (TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState)
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() usw.
  project.ts            .djaw lesen/schreiben (DJAWPACK)
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer (ONNX), AnalysisCache
  render/*.ts           Voice (Lesen → Stretch → EQ → FXKernel → Echo → Hall → Fader), RenderSession, WAV-Export, Mix-Wellenform
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts (Vorschau, Export, Wellenform; Web Worker), analysis.child.ts (Analyse; Kindprozess)
src/renderer/           React-UI (store.ts = der UI-Zustandsteil von MixStore, components/…)
src/vendor/stretch-core.mjs   erzeugt von tools/signalsmith/make-core.mjs
tests/                  Tests von core (Node)
```

- `BrowserWindow` darf `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true` verwenden
  (private App, die nur lokale Dateien bearbeitet; fs direkt im Worker zu nutzen ist ein großer Vorteil).
- Zustand: MixStore ist „das Dokument (clips, library, masterBPM, gridOffset…) + UI-Zustand“.
  Das Dokument wird mit reinen Funktionen (`core/`) geändert, Rückgängig nutzt wie auf dem Mac Schnappschüsse (bis zu 300).
- IDs: Swift-UUIDs werden als Großbuchstaben-Strings gespeichert → `crypto.randomUUID().toUpperCase()`.

## 2. Audiodaten

- **Dekodieren**: im Renderer `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → alles landet bei 44,1 kHz.
  Chromium kann kein AIFF lesen, daher eigener Parser (Header + Big-Endian-PCM).
- **PCM-Cache**: `<userData>/cache/pcm/<Fingerabdruck>.pcm` (16 Bit Stereo interleaved, Länge und Abtastrate im Header).
  Gelesen werden nur die nötigen Bereiche, mit `fs.readSync`. Die Tracklänge ergibt sich aus Samplezahl / Abtastrate der Quelldatei (passend zu `duration` auf dem Mac).
- **Fingerabdruck** (`AnalysisCache.fingerprint`): SHA-256 über (`"<Größe>"` + erste 256 KB + letzte 256 KB bei Größe > 512 KB), Kleinbuchstaben-Hex.
  Analyse-, Profil- und Stem-Caches nutzen ihn als Schlüssel. Er ergibt denselben Wert wie auf dem Mac, also lassen sich `profiles` usw. im `.djaw` teilen.
- **Metadaten**: `music-metadata` (Titel, Artist, Cover, Genre-Tag).

## 3. Die Render-Engine (das Wichtigste)

Lies `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift` der Mac-App.

### Zeiteinheiten
- Die Timeline läuft in **Referenzsekunden** (Sekunden beim Grund-BPM = `masterBPM`). Mit Tempowechseln weicht sie von der Echtzeit ab.
  Umrechnen mit `TempoMap.real(t)` und `reference(atReal:)`. Sample-Positionen sind immer **Echtsekunden × Abtastrate**.
- Abspielrate von Track `c`: `rate = master / c.bpm` (bei `tempoSync`). Unter einer Tempo-Map `c.rate(tempo.bpm(at: t))`.
- Welche Quellbereiche ein Track spielt, liefert `playSegments()` (mit Loops und Sprüngen). `elapsed` ist in Quellsekunden.

### Schritte
- Ein Schritt pro **512-Frame-Grenze**, gezählt ab Mixbeginn. Beginnt ein Track mitten in einem Schritt, wird dort geteilt (`nextChunk`).
- Zum Mittelzeitpunkt `t` jedes Schritts wird `Automation.state(clips, i, t, master)` ausgewertet und auf alle Stimmen angewendet.
- Die Stimme jedes Tracks startet **genau** an seinem Startframe (auf dem Mac haben mittendrin hinzukommende Stimmen, die im Stretch-Element verrutschten, lange Ärger gemacht).
  Nach dem Ende läuft sie noch `tail = 8` Sekunden für Echo- und Hallfahnen.

### Innerhalb einer Stimme (Chain)
1. **Lesen** (`ClipSchedule.ranges` / `BufferFeeder`): bereichsweise lesen.
   **3 ms Einblendung** am Anfang des ersten Bereichs. Ist der nächste Track ein `cut`, **5 ms Ausblendung** am Ende.
   Bremse / Backspin (`OutroFX`) ersetzt das Ende durch das Ergebnis von `TurntableFX.render` (unverändert portiert).
2. **Stretch / Tonhöhe**: signalsmith-stretch. `stretchRate` (genau 1 wird zu 1,00002, damit immer verarbeitet wird).
   Ohne Key-Lock (Vinyl) um `pitchCents` transponieren; Tonartverschiebung ±6 Halbtöne.
   Pro Ausgabeblock `inN = round(outN × rate)` (Rest übertragen, kumulierter Fehler null).
   Die Latenz (5292 Samples Ein- plus Ausgang bei 44,1 k) wird **exakt aufgehoben**, z. B. indem beim Start der Stimme mit Eingang vor der Startposition gesucht und Ausgabe verworfen wird.
   Test: einen Klickzug durchschicken; die Klicks im Ausgang müssen bei `(Eingangsposition − Startposition) / rate` auf ±1 Sample liegen.
3. **EQ** (`DJEQ.configure`): Low-Shelf 180 Hz / Peak 1 kHz, Bandbreite 2 Oktaven / High-Shelf 4,5 kHz.
   Pegel `state.low/mid/high` (dB; Kill −40 dB, MID −24 dB). Biquads entsprechend Apples AVAudioUnitEQ.
4. **DJ-FX**: `FXKernel` (Filter, Phaser, Flanger, Bitcrusher, Gate, Roll) arbeitet pro Sample und wird **unverändert portiert**.
5. **Echo**: wie AVAudioUnitDelay (Verzögerung = Schlag × 0,75 (Echo-Out) oder `echoDiv`, Feedback 55 % (als FX 30 + 30 × Stärke),
   Tiefpass 7 kHz, wet/dry). Beim Echo-Out fällt `send` nach 1 Schlag auf 0, nur die Fahne bleibt.
6. **Hall**: wie largeHall2 von AVAudioUnitReverb (etwas Ähnliches wie Freeverb). wet = 55 % × Stärke.
7. **Fader**: `state.volume` (Pegel × Lautheitskorrektur × Hüllkurve).

- **Stems** (Stufe 3): Vocal- und Begleitspur werden vor dem Stretch gemischt (`stemMix`).
- **Vorschau**: dieselbe Session rendert im Worker 0,25 s voraus und speist das AudioWorklet.
  Reine Änderungen an Pegeln, EQ, FX und Kurven gehen in die laufende Session (`update`). Änderungen, die Klänge verschieben (anderer `structureKey`), bauen sie ab der aktuellen Position neu.
  Der Abspielkopf ergibt sich aus „tatsächlich vom Worklet ausgegebenen Frames“, auf dem Bildschirm interpoliert (`smoothPlayhead` auf dem Mac).
- **Export**: WAV 24 Bit und M4A (AAC 256 kbit/s), 44,1 k / 48 k. Normalisieren bringt die Spitze auf −1 dBFS (höchstens ×4, `OfflineRenderer.normalizeGain`). Der erste Durchgang misst die Spitze, der zweite schreibt (einer genügt, wenn die Spitze der Mix-Wellenform vorliegt). Die Restzeit wird erst ab der stabilen Phase geschätzt.

## 4. Das `.djaw`-Format (von Mac und Windows gelesen und geschrieben)

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile (sortierte Schlüssel, Datum ISO 8601)
Audiodateien          die Bytes der Quelldateien unverändert aneinandergehängt (media[].offset ist relativ zum Ende des JSON)
```
- Beginnt die Datei nicht mit `DJAWPACK`, ist sie reines JSON (altes Format, Autosave).
- `ProjectFile`: `format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` usw. (Ende von `Models.swift`).
- `clips[].url` ist ein URL-String wie `file:///Users/...` (Mac-Pfad). Auflösungsreihenfolge beim Öffnen: eingebettetes Audio (`mediaID` → Entpackordner) → `relativePath` (relativ zur .djaw) → `url` → sonst „fehlende Datei“ zum Neuverknüpfen.
  Windows-Pfade werden als `file:///C:/...` gespeichert.
- Wohin eingebettetes Audio entpackt wird: Mac `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<Originalname>`, Windows `%APPDATA%/DJAW/Media/<projectID>/`.
- `analyses`: Fingerabdruck → Analyse der Mac-App (LZFSE-komprimierte binäre plist). Windows muss sie nicht lesen (analysiert neu), **behält sie aber beim Speichern unverändert**,
  damit beim Öffnen auf dem Mac keine Neuanalyse nötig ist. Die Windows-Analyse kommt unter einen anderen Schlüssel (z. B. `analysesWin`).
- Reales Beispiel: `hyperflip.djaw` des Nutzers (etwa 400 MB, 9 eingebettete Tracks, 5 im Mix + 4 in der Bibliothek, masterBPM 107, Tempowechsel, eigene Spuren).

## 5. Zuordnung Swift → TypeScript

| Swift | Zeilen | Aufgabe | Stufe | Hinweise |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | Clips, Kurven, Spuren, Takes, Palette, ProjectFile | 1 | Rechnungen unverändert übernehmen |
| Model/TempoFX.swift | 399 | Tempo-Map, FX-Definitionen | 1 | |
| Model/Automation.swift | 260 | Lautstärke, EQ, FX und Stems je Zeitpunkt; Umschaltpunkte | 1 | gemeinsam für Wiedergabe und Export |
| Model/Localization.swift | 43 | Umschalten Japanisch / Englisch | 1 | |
| Model/PerformanceGuide.swift | 454 | Spielanleitung, Trackliste | 2 | |
| Model/AutoMixer.swift | 857 | Planung des Auto-Mix | 2 | |
| Audio/AudioAnalyzer.swift | 503 | Laden, Wellenform, BPM, Downbeat, Bandenergien | 1 | |
| Audio/StructureAnalyzer.swift | 517 | Aufbau (Intro / Build / Drop…), Tonart | 1 | Grundlage für Auto-Mix und Anleitungen |
| Audio/NeuralAnalyzer.swift | 603 | Beat This! (Schläge), CUE-DETR (Cue-Vorschläge) | 1/2 | braucht ONNX |
| Audio/GenreAnalyzer.swift | 487 | Genre (EffNet), Gesang vorhanden | 2 | ONNX vorhanden |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS (BS.1770) | 1 | |
| Audio/AnalysisCache.swift | 169 | Fingerabdruck, Analyse-Cache | 1 | |
| Audio/AnalysisProgress.swift | 216 | Analysefortschritt, Restzeit | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | AVFoundation-Teile durch eigenes DSP ersetzen |
| Audio/MixRenderSession.swift | 299 | der Mix-Renderer selbst | 1 | |
| Audio/StreamingPlayback.swift | 185 | Vorschau | 1 | Worker + AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | Export, Mix-Wellenform (teilweises Rendern) | 1 | |
| Audio/DJFX.swift | 464 | FXKernel, Bremse / Backspin | 1 | unverändert portieren |
| Audio/StretchCalibration.swift | 118 | Korrektur der Tempo-Drift von AVAudioUnitTimePitch | — | **nicht nötig** (signalsmith nimmt die Eingangsanzahl direkt) |
| Audio/TransitionCheck.swift | 187 | gerenderte Prüfung automatischer Übergänge | 2 | |
| Audio/StemSeparator.swift | 231 | Vocal-Trennung mit Spleeter | 3 | braucht ONNX |
| Audio/MusicLibrary.swift | 97 | Mediathek von Musik.app | 2 | liest die XML der iTunes- / Musik-Mediathek (`src/core/musicLibrary.ts`) |
| Store/MixStore.swift | 3352 | Zustand, Bearbeitung, Layout, Wiedergabe, Speichern, Export | 1(+2) | Auto-Mix-Teile in Stufe 2 |
| Store/MixStore+Locks.swift | 83 | Übergänge sperren | 1 | |
| Store/MixStore+Loudness.swift | 55 | Lautheit angleichen | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | Mix-Wellenform (teilweise neu, im Leerlauf komplett) | 1 | |
| Store/MixStore+Simplify.swift | 169 | Übergänge vereinfachen | 1 | |
| Store/MixStore+Takes.swift | 92 | Übergangs-Takes | 1 | |
| Store/MixStore+Profiles.swift | 105 | Track-Infos, Cover | 2 | |
| Store/MixStore+Stems.swift | 49 | Stems vorbereiten | 3 | |
| Store/ProjectContainer.swift | 136 | .djaw-Format | 1 | |
| Store/DebugHarness.swift | 514 | automatische Testbefehle für die Entwicklung | — | unter Windows durch Node-Tests ersetzt |
| Timeline/TimelineNSView.swift | 1655 | Timeline (Spuren A/B, Taktlineal, Übergangsbänder, Ziehen, Mix-Wellenform, Abspielkopf folgen) | 1 | Canvas; nur Sichtbares zeichnen, nur den Abspielkopf neu zeichnen |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | rechtes Panel (Übergang, Decks, FX, Mixer, Takes, Track-Verwendung) | 1 | |
| Views/TransitionEditorView.swift | 836 | Übergangseditor (Spuren zeichnen, Vorhören vom Lineal) | 1 | |
| Views/CueEditorView.swift | 891 | CUE-Editor (Solo-Vorhören, IN/OUT, Rasteranpassung) | 1 | |
| Views/DeckPanel.swift | 593 | Plattenspieler und Mixer | 1 | mit interpolierter Uhr flüssig drehen |
| Views/SidebarView.swift | 347 | Mix-Reihenfolge, Bibliothek | 1 | |
| Views/TransportViews.swift | 156 | Play-Taste, Zeit, BPM | 1 | |
| Views/ExportSheet.swift | 179 | Export | 1 (Audio) / 3 (Video) | |
| Views/ShortcutsView.swift | 116 | Tastenkürzel-Liste | 1 | ⌘ als Strg lesen |
| Views/AnalysisProgressView.swift | 48 | Analysefortschritt | 1 | |
| Views/Theme.swift | 108 | Farben, Formatierung (Fmt) | 1 | |
| Views/AutoArrangeSheet.swift | 340 | automatisch anordnen | 2 | |
| Views/PerformanceGuideView.swift | 162 | Spielanleitung, Trackliste | 2 | |
| Views/TrackProfileSheet.swift | 164 | Track-Infos bearbeiten | 2 | |
| Views/MusicLibrarySheet.swift | 313 | Musik.app | 2 | ohne XML eine Datei wählen |
| Views/VisualPreviewView.swift | 84 | Visuals-Vorschau | 3 | |
| Media/TrackProfiles.swift | 123 | Track-Profile speichern | 2 | |
| Media/VideoExporter.swift | 445 | Video-Export | 3 | |
| Media/VisualPainter.swift | 583 | Visuals zeichnen, Auto-VJ | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | Menüs, Gesamtlayout | 1 | |

## 6. ML-Modelle (ONNX nötig)

Lizenzen in `mac/DJAW/ML/ThirdPartyNotices.txt`. Vorverarbeitungsmatrizen (`*_fbank_*.f32`, `*_melfb_*.f32`) und Labels liegen in `mac/DJAW/ML/`.
Die Ausgangsdateien liegen in `~/Downloads` auf dem Mac des Nutzers (bei Bedarf um eine Kopie nach Windows bitten; Berechtigungen am Anfang gesammelt erfragen).

| Modell | Quelle (Mac ~/Downloads) | Form unter Windows |
|---|---|---|
| Beat This! (Schläge, Downbeats; MIT) | `final0.ckpt` (81 MB, PyTorch) | mit dem offiziellen `beat_this`-Code laden und nach ONNX exportieren. Vorverarbeitung `beatthis_fbank_513x128.f32`. Inferenz mit onnxruntime-node |
| CUE-DETR (Cue-Vorschläge; MIT) | `model.safetensors` (166 MB, DETR aus HF transformers) | mit transformers laden und nach ONNX exportieren. Vorverarbeitung `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet (Genre; CC BY-NC-SA) | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`, Kopf `genre_discogs400-...pb`, `DJAW_heads/*.onnx` | Grundnetz und 4 Köpfe sind als ONNX nutzbar. Kopf genre400: .pb → ONNX (tf2onnx) oder Gewichte herauslösen und als Matrixrechnung |
| Spleeter 2stems (MIT) | in der Mac-App in PyTorch nachgebaut und zu Core ML konvertiert (stimmt mit TF bis 8e-6 relativem Fehler überein) | ebenso nach ONNX konvertieren. STFT 4096/1024, 1024 Bins × 512 Frames, Begleitung = Original − Vocals |

Die Inferenz läuft in analysis.child (ein Kindprozess, der Electron als Node startet), weil **onnxruntime-node nicht in einem Web Worker des Renderers läuft** (Laden bringt den ganzen Renderer zum Absturz). Die Mac-Vorverarbeitung (`NeuralAnalyzer.swift`, `GenreAnalyzer.swift`, `StemSeparator.swift`) genau übernehmen.

## 7. Fallstricke und Vorgeschichte (was die Mac-App gelehrt hat)

- **Export und Vorschau deckungsgleich**: Die Mac-App hatte anfangs einen eigenen Echtzeitweg für die Vorschau, und Track-Einstiege wichen vom Export ab.
  Am Ende: „die Vorschau mit derselben Session wie den Export rendern und abspielen“. Die Windows-App macht das von Anfang an so.
- **Latenz und Tempo-Drift des Stretch-Elements**: mittendrin hinzukommende Stimmen kamen zu spät / zu früh, und die Abweichung zwischen eingestelltem und tatsächlichem Tempo ließ Schläge driften (0,23 ms/s).
  Mit direkt genutztem signalsmith tritt beides grundsätzlich nicht auf, aber immer mit Tests prüfen.
- **Cut-ins** (`updateCutNudges`): Taktlinien können 10–40 ms neben dem Anschlag (Kick / Snare) liegen.
  Der ausgehende Track stoppt kurz vor dem nächsten Anschlag, der eingehende beginnt kurz vor seinem eigenen (erkannt mit einer 2-ms-Hüllkurve, `BandEnergies.onsetOffset`).
  Nur 5 ms Überlappung: 5 ms Ausblendung auf der ausgehenden, 3 ms Einblendung auf der eingehenden Seite.
- **Wann die Automation ausgewertet wird**: Schrittgrenzen zählen ab Mixbeginn (dieselben Zeitpunkte, auch wenn mittendrin abgespielt wird).
- **Pegel kurz vor einem Start**: bei einem Track, der in weniger als 0,25 s startet, wird der Wert direkt nach dem Start vorab gesetzt (damit der Anfang eines Cut-ins nicht fehlt).
- **Mix-Wellenform**: laute Tracks clippen ständig, nur Spitzen ergeben ein rotes Band → Spitze + RMS-Kern zeichnen.
  Nur den geänderten Bereich mit 10 s Anlauf neu zeichnen, den Rest zeitlich verschoben weiterverwenden. Nach 20 s ohne Bearbeitung alles exakt neu zeichnen.
- **Tempo der Timeline**: bei vielen Tracks wurde sie langsam → nur Sichtbares zeichnen, beim Abspielen nur den Streifen des Abspielkopfs invalidieren, Tempo-Map usw. je Revision cachen.
- **Farben**: benachbarte Tracks liegen im Farbton mindestens 0,15 auseinander (`separateNeighbourColors`).
- **Kein doppeltes Laden**: geprüft über (normalisierten) Pfad und Fingerabdruck. Ein auf die Timeline gezogener Track, der schon in der Bibliothek ist, wird von dort in den Mix verschoben.
- **Plattenspieler**: ein 60-Hz-Timer gegen die Audiouhr ruckelte → bei jedem Bild mit interpolierter Uhr zeichnen (korrigiert jeweils 15 % des Fehlers, synchronisiert über 50 ms neu).
- **Auto-VJ**: wechselte zu oft → pro 8-Takt-Phrase wechseln, am Anfang von Drops, jedes Bild mindestens 2 Phrasen halten.
- **Restzeit beim Export**: frühe Schätzungen waren unzuverlässig → nur aus dem Fortschritt in der stabilen Phase schätzen, auf 5 s / 10 s runden.

## 8. Testdaten

In `~/Downloads` auf dem Mac des Nutzers (bei Bedarf um Kopie bitten):
- `hyperflip.djaw` (Mix aus der Mac-App, Audio eingebettet), `hyperflip.wav` (sein Export)
- `DJAW_pv_export*.wav` (Exporte zum Vergleich von Vorschau und Export)
- Tracks: `chance-FINAL.wav`, `TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`, `you dont need to fall.mp3`, `01 welcome.wav` und weitere

## 9. Neu in 0.4.0

- **Wo ein Tempowechsel beginnt** (`Clip.tempoStart`): `'afterTransition'` (nach dem Übergang; Standard für einen neuen Tempowechsel), `'mixIn'` oder nicht gesetzt (mit dem Übergang; Mixe aus 0.3 und früher) oder eine Zahl (Takte nach dem Einstieg des Tracks).
  Der Wechsel beginnt bei `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))` und erreicht das nächste BPM in `tempoRampBars(c)` Takten (`Clip.tempoBars`, sonst die Übergangslänge).
- **Überlagerte Tracks** (`ProjectFile.layers`, `Clip.layerOf`, `layerBar`, `layerParts`): an einen Takt eines Mix-Tracks (des Hosts) geheftet und darüber gespielt.
  Positionen liefert `placeLayers` in `core/layers.ts`, die Zuordnung zu Deck C / D `layerDecks` (höchstens 2 gleichzeitig).
  Beim Rendern bekommt jeder überlagerte Track eine eigene RenderSession mit nur diesem Track; `renderNext()` summiert sie (`nextChunk` ist das Minimum aller Sessions).
  Ist `layerParts` `vocals` / `instrumental`, werden Stems verwendet und `Automation.state` schaltet den anderen Teil stumm.
- **Aus einem Loop heraus mixen** (`Clip.outPass`): wenn der vorige Track loopt, in welchem Durchlauf der Übergang kommt. Im Layout über `elapsedOfSourcePass` berücksichtigt.
- **Sprachen**: Tabellen mit dem englischen Text von `L(ja, en)` als Schlüssel (`src/core/locales/<lang>.json`). Bei Aufrufen, deren Englisch ein Template ist, ergänzt `scripts/i18n.mjs` beim Build Schlüssel und Werte.
  Gespeicherte Texte wie Auto-Mix-Notizen entstehen mit `captureLanguages()`, das Markierungen für alle Sprachen behält; `localize()` zeigt sie in der aktuellen Sprache.
  Schlüssel extrahieren: `node scripts/i18n.mjs extract`; Übersetzungen zusammenführen: `node scripts/i18n-merge.mjs` (`_parts/c<N>_*.json`, je 200).
- **Dateigröße**: eingebettetes unkomprimiertes Audio (WAV, AIFF) wird als FLAC gespeichert (`core/flac.ts`, feste Prädiktoren + Rice-Kodierung, bitgenau gleich wie die Quelle). MP3 und Ähnliches bleiben unverändert.
