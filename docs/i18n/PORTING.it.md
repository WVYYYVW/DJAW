# Port per Windows: dettagli di progetto, tabella di corrispondenza e trappole

[日本語](../PORTING.md) | [English](PORTING.en.md) | [简体中文](PORTING.zh-Hans.md) | [繁體中文](PORTING.zh-Hant.md) | [한국어](PORTING.ko.md) | [Español](PORTING.es.md) | [Français](PORTING.fr.md) | [Deutsch](PORTING.de.md) | **Italiano** | [Português](PORTING.pt.md) | [Русский](PORTING.ru.md)

Il seguito di `CLAUDE.md`. Il codice dell’app Mac (`mac/DJAW`) è **la specifica di riferimento**. Copia numeri, curve e soglie esattamente
(quasi tutti sono stati regolati a orecchio dall’utente per molto tempo).

> Fa fede l’originale giapponese; questa è una traduzione.

---

## 1. Struttura dell’app Electron

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main: finestra, menu (la struttura dei menu di MyApp.swift su Mac), dialoghi, salvataggio automatico, file recenti
src/core/               TypeScript indipendente dalla UI (deve essere testabile in Node da solo)
  models.ts             Models.swift (Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…)
  tempo.ts              TempoFX.swift (TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState)
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() ecc.
  project.ts            lettura/scrittura .djaw (DJAWPACK)
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer (ONNX), AnalysisCache
  render/*.ts           Voice (lettura → stretch → EQ → FXKernel → eco → riverbero → fader), RenderSession, esportazione WAV, forma d’onda del mix
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts (anteprima, esportazione, forma d’onda; Web Worker), analysis.child.ts (analisi; processo figlio)
src/renderer/           UI React (store.ts = la parte di stato UI di MixStore, components/…)
src/vendor/stretch-core.mjs   generato da tools/signalsmith/make-core.mjs
tests/                  test di core (Node)
```

- `BrowserWindow` può usare `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true`
  (app personale che gestisce solo file locali; usare fs direttamente dal Worker è un grande vantaggio).
- Stato: MixStore è «il documento (clips, library, masterBPM, gridOffset…) + lo stato della UI».
  Il documento si aggiorna con funzioni pure (`core/`) e l’Annulla usa istantanee come su Mac (fino a 300).
- ID: gli UUID di Swift sono salvati come stringhe maiuscole → `crypto.randomUUID().toUpperCase()`.

## 2. Dati audio

- **Decodifica**: nel renderer, `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → tutto a 44,1 kHz.
  Chromium non legge l’AIFF, quindi si analizza a mano (intestazione + PCM big-endian).
- **Cache PCM**: `<userData>/cache/pcm/<impronta>.pcm` (16 bit stereo interleaved, lunghezza e frequenza di campionamento nell’intestazione).
  Si leggono solo gli intervalli necessari, con `fs.readSync`. La durata viene dal numero di campioni / frequenza del file originale (per coincidere con `duration` su Mac).
- **Impronta** (`AnalysisCache.fingerprint`): SHA-256 di (`"<dimensione>"` + primi 256 KB + ultimi 256 KB se dimensione > 512 KB), esadecimale minuscolo.
  Le cache di analisi, profili e stem usano tutte questa chiave. Dà lo stesso valore del Mac, quindi `profiles` ecc. del `.djaw` si possono condividere.
- **Metadati**: `music-metadata` (titolo, artista, copertina, tag di genere).

## 3. Il motore di rendering (la parte più importante)

Leggi `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift` dell’app Mac.

### Unità di tempo
- La timeline è in **secondi di riferimento** (secondi al BPM di base = `masterBPM`). Con i cambi di tempo differisce dal tempo reale.
  Si converte con `TempoMap.real(t)` e `reference(atReal:)`. Le posizioni dei campioni sono sempre **secondi reali × frequenza di campionamento**.
- Velocità del brano `c`: `rate = master / c.bpm` (con `tempoSync`). Con una mappa di tempo, `c.rate(tempo.bpm(at: t))`.
- I tratti della sorgente suonati da un brano li dà `playSegments()` (con loop e salti). `elapsed` è in secondi della sorgente.

### Passi
- Un passo per ogni **confine di 512 frame**, contando dall’inizio del mix. Se un brano inizia a metà di un passo, lì il passo si divide (`nextChunk`).
- All’istante centrale `t` di ogni passo si valuta `Automation.state(clips, i, t, master)` e lo si applica a tutte le voci.
- La voce di ogni brano parte **esattamente** dal suo frame iniziale (su Mac le voci che si univano a metà e slittavano nell’unità di stretch hanno dato a lungo problemi).
  Dopo la fine continua per `tail = 8` secondi per le code di eco e riverbero.

### Dentro una voce (Chain)
1. **Lettura** (`ClipSchedule.ranges` / `BufferFeeder`): lettura tratto per tratto.
   **Dissolvenza in entrata di 3 ms** all’inizio del primo tratto. Se il brano successivo è un `cut`, **dissolvenza in uscita di 5 ms** alla fine.
   Frenata / backspin (`OutroFX`) sostituisce il finale con il risultato di `TurntableFX.render` (portato così com’è).
2. **Stretch / intonazione**: signalsmith-stretch. `stretchRate` (esattamente 1 diventa 1,00002 per elaborare sempre).
   Con key lock OFF (vinile) si traspone di `pitchCents`; spostamento di tonalità ±6 semitoni.
   Per ogni blocco in uscita `inN = round(outN × rate)` (il resto si riporta: errore accumulato zero).
   La latenza (5292 campioni tra ingresso e uscita a 44,1 k) si **annulla esattamente**, per es. posizionandosi con l’ingresso precedente alla posizione iniziale all’avvio della voce e scartando l’uscita.
   Test: far passare un treno di clic; i clic in uscita devono essere a `(posizione in ingresso − posizione iniziale) / rate` entro ±1 campione.
3. **EQ** (`DJEQ.configure`): shelving bassi 180 Hz / peaking 1 kHz, larghezza 2 ottave / shelving acuti 4,5 kHz.
   Guadagni `state.low/mid/high` (dB; kill −40 dB, MID −24 dB). Biquad equivalenti ad AVAudioUnitEQ di Apple.
4. **DJ FX**: `FXKernel` (filtro, phaser, flanger, bitcrusher, gate, roll) lavora campione per campione, quindi si **porta così com’è**.
5. **Eco**: come AVAudioUnitDelay (ritardo = battito × 0,75 (eco in uscita) o `echoDiv`, feedback 55% (30 + 30 × quantità come FX),
   passa-basso 7 kHz, wet/dry). Nell’eco in uscita `send` va a 0 dopo 1 battito e resta solo la coda.
6. **Riverbero**: come largeHall2 di AVAudioUnitReverb (qualcosa di simile, per es. Freeverb). wet = 55% × quantità.
7. **Fader**: `state.volume` (guadagno × correzione di loudness × inviluppo).

- **Stem** (fase 3): le letture di voce e accompagnamento si mixano prima dello stretch (`stemMix`).
- **Anteprima**: la stessa sessione rende 0,25 s in anticipo nel Worker e alimenta l’AudioWorklet.
  Le modifiche solo a livelli, EQ, FX e curve vanno nella sessione in corso (`update`). Quelle che spostano i suoni (cambia `structureKey`) la ricostruiscono dalla posizione attuale.
  La testina deriva dai «frame effettivamente emessi dal Worklet», interpolati a schermo per renderla fluida (`smoothPlayhead` su Mac).
- **Esportazione**: WAV 24 bit e M4A (AAC 256 kbps), 44,1 k / 48 k. La normalizzazione porta il picco a −1 dBFS (al massimo ×4, `OfflineRenderer.normalizeGain`). Il primo passaggio misura il picco e il secondo scrive (ne basta uno se si ha il picco della forma d’onda del mix). Il tempo rimanente si stima solo quando inizia la fase stabile.

## 4. Il formato `.djaw` (letto e scritto da Mac e Windows)

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile (chiavi ordinate, date ISO 8601)
file audio            i byte dei file originali concatenati così come sono (media[].offset è relativo alla fine del JSON)
```
- Se non inizia con `DJAWPACK`, è JSON semplice (vecchio formato, salvataggio automatico).
- `ProjectFile`: `format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` ecc. (fine di `Models.swift`).
- `clips[].url` è un URL del tipo `file:///Users/...` (percorso Mac). Ordine di risoluzione all’apertura: audio incorporato (`mediaID` → cartella di estrazione) → `relativePath` (relativo al .djaw) → `url` → altrimenti «file mancante» da ricollegare.
  I percorsi Windows si salvano come `file:///C:/...`.
- Dove si estrae l’audio incorporato: Mac `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<nome originale>`, Windows `%APPDATA%/DJAW/Media/<projectID>/`.
- `analyses`: impronta → analisi dell’app Mac (plist binario compresso LZFSE). Windows non deve leggerlo (rianalizza), ma
  **lo conserva intatto al salvataggio**, così aprendo su Mac non serve rianalizzare. L’analisi di Windows va sotto un’altra chiave (per es. `analysesWin`).
- Esempio reale: `hyperflip.djaw` dell’utente (circa 400 MB, 9 brani incorporati, 5 nel mix + 4 in libreria, masterBPM 107, cambi di tempo, corsie personalizzate).

## 5. Corrispondenza Swift → TypeScript

| Swift | Righe | Ruolo | Fase | Note |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | clip, curve, corsie, take, palette, ProjectFile | 1 | copiare i calcoli così come sono |
| Model/TempoFX.swift | 399 | mappa di tempo, definizioni FX | 1 | |
| Model/Automation.swift | 260 | volume, EQ, FX e stem per istante; punti di cambio | 1 | comune a riproduzione ed esportazione |
| Model/Localization.swift | 43 | cambio giapponese / inglese | 1 | |
| Model/PerformanceGuide.swift | 454 | guida per suonarlo, scaletta | 2 | |
| Model/AutoMixer.swift | 857 | pianificazione del mix automatico | 2 | |
| Audio/AudioAnalyzer.swift | 503 | caricamento, forma d’onda, BPM, battere, energia per banda | 1 | |
| Audio/StructureAnalyzer.swift | 517 | struttura (intro / build / drop…), tonalità | 1 | base del mix automatico e delle guide |
| Audio/NeuralAnalyzer.swift | 603 | Beat This! (battiti), CUE-DETR (cue suggeriti) | 1/2 | serve ONNX |
| Audio/GenreAnalyzer.swift | 487 | genere (EffNet), presenza di voce | 2 | ONNX disponibile |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS (BS.1770) | 1 | |
| Audio/AnalysisCache.swift | 169 | impronta, cache di analisi | 1 | |
| Audio/AnalysisProgress.swift | 216 | avanzamento dell’analisi, tempo rimanente | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | sostituire le parti AVFoundation con DSP proprio |
| Audio/MixRenderSession.swift | 299 | il rendering del mix | 1 | |
| Audio/StreamingPlayback.swift | 185 | anteprima | 1 | Worker + AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | esportazione, forma d’onda del mix (rendering parziale) | 1 | |
| Audio/DJFX.swift | 464 | FXKernel, frenata / backspin | 1 | portare così com’è |
| Audio/StretchCalibration.swift | 118 | correzione della deriva di AVAudioUnitTimePitch | — | **non serve** (signalsmith accetta direttamente il numero di ingressi) |
| Audio/TransitionCheck.swift | 187 | verifica col rendering delle transizioni automatiche | 2 | |
| Audio/StemSeparator.swift | 231 | separazione della voce con Spleeter | 3 | serve ONNX |
| Audio/MusicLibrary.swift | 97 | libreria di Musica.app | 2 | legge l’XML della libreria di iTunes / Musica (`src/core/musicLibrary.ts`) |
| Store/MixStore.swift | 3352 | stato, modifiche, layout, riproduzione, salvataggio, esportazione | 1(+2) | le parti di mix automatico nella fase 2 |
| Store/MixStore+Locks.swift | 83 | blocco delle transizioni | 1 | |
| Store/MixStore+Loudness.swift | 55 | allineamento della loudness | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | forma d’onda del mix (ridisegno parziale, completo a riposo) | 1 | |
| Store/MixStore+Simplify.swift | 169 | semplificazione delle transizioni | 1 | |
| Store/MixStore+Takes.swift | 92 | take delle transizioni | 1 | |
| Store/MixStore+Profiles.swift | 105 | info del brano, copertina | 2 | |
| Store/MixStore+Stems.swift | 49 | preparazione degli stem | 3 | |
| Store/ProjectContainer.swift | 136 | formato .djaw | 1 | |
| Store/DebugHarness.swift | 514 | comandi di test automatici per lo sviluppo | — | su Windows sostituiti dai test in Node |
| Timeline/TimelineNSView.swift | 1655 | timeline (corsie A/B, righello delle battute, bande di transizione, trascinamenti, forma d’onda del mix, inseguimento della testina) | 1 | Canvas; disegnare solo il visibile, ridisegnare solo la testina |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | pannello destro (transizione, deck, FX, mixer, take, uso del brano) | 1 | |
| Views/TransitionEditorView.swift | 836 | editor delle transizioni (disegno delle corsie, ascolto dal righello) | 1 | |
| Views/CueEditorView.swift | 891 | editor CUE (ascolto in solo, IN/OUT, regolazione della griglia) | 1 | |
| Views/DeckPanel.swift | 593 | giradischi e mixer | 1 | rotazione fluida con un orologio interpolato |
| Views/SidebarView.swift | 347 | ordine del mix, libreria | 1 | |
| Views/TransportViews.swift | 156 | tasto play, tempo, BPM | 1 | |
| Views/ExportSheet.swift | 179 | esportazione | 1 (audio) / 3 (video) | |
| Views/ShortcutsView.swift | 116 | elenco delle scorciatoie | 1 | leggere ⌘ come Ctrl |
| Views/AnalysisProgressView.swift | 48 | avanzamento dell’analisi | 1 | |
| Views/Theme.swift | 108 | colori, formattazione (Fmt) | 1 | |
| Views/AutoArrangeSheet.swift | 340 | disposizione automatica | 2 | |
| Views/PerformanceGuideView.swift | 162 | guida per suonarlo, scaletta | 2 | |
| Views/TrackProfileSheet.swift | 164 | modifica delle info del brano | 2 | |
| Views/MusicLibrarySheet.swift | 313 | Musica.app | 2 | scegliere un file se non c’è l’XML |
| Views/VisualPreviewView.swift | 84 | anteprima dei visual | 3 | |
| Media/TrackProfiles.swift | 123 | salvataggio dei profili dei brani | 2 | |
| Media/VideoExporter.swift | 445 | esportazione video | 3 | |
| Media/VisualPainter.swift | 583 | disegno dei visual, VJ automatico | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | menu, layout generale | 1 | |

## 6. Modelli di ML (serve ONNX)

Licenze in `mac/DJAW/ML/ThirdPartyNotices.txt`. Le matrici di pre-elaborazione (`*_fbank_*.f32`, `*_melfb_*.f32`) e le etichette sono in `mac/DJAW/ML/`.
Gli originali sono in `~/Downloads` sul Mac dell’utente (chiedigli di copiarli su Windows quando servono; i permessi si chiedono all’inizio).

| Modello | Originale (Mac ~/Downloads) | Forma su Windows |
|---|---|---|
| Beat This! (battiti, battere; MIT) | `final0.ckpt` (81 MB, PyTorch) | caricare con il codice ufficiale `beat_this` ed esportare in ONNX. Pre-elaborazione `beatthis_fbank_513x128.f32`. Inferenza con onnxruntime-node |
| CUE-DETR (cue suggeriti; MIT) | `model.safetensors` (166 MB, DETR di HF transformers) | caricare con transformers ed esportare in ONNX. Pre-elaborazione `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet (genere; CC BY-NC-SA) | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`, testa `genre_discogs400-...pb`, `DJAW_heads/*.onnx` | il modello base e 4 teste si usano come ONNX. La testa genre400: .pb → ONNX (tf2onnx), oppure estrarre i pesi e fare il calcolo matriciale |
| Spleeter 2stems (MIT) | nell’app Mac ricostruito in PyTorch e convertito in Core ML (coincide con TF entro 8e-6 di errore relativo) | convertire in ONNX allo stesso modo. STFT 4096/1024, 1024 bin × 512 frame, accompagnamento = originale − voce |

L’inferenza gira in analysis.child (un processo figlio che avvia Electron come Node), perché **onnxruntime-node non funziona in un Web Worker del renderer** (caricarlo fa crollare tutto il renderer). Copia esattamente la pre-elaborazione del Mac (`NeuralAnalyzer.swift`, `GenreAnalyzer.swift`, `StemSeparator.swift`).

## 7. Trappole e storia (cosa ci ha insegnato l’app Mac)

- **Esportazione e anteprima coincidenti**: all’inizio il Mac aveva un percorso in tempo reale separato per l’anteprima e gli ingressi dei brani slittavano rispetto all’esportazione.
  Alla fine: «rendere l’anteprima con la stessa sessione dell’esportazione e riprodurla». L’app Windows fa così fin dall’inizio.
- **Latenza e deriva di velocità dell’unità di stretch**: le voci che si univano a metà entravano in ritardo / in anticipo e lo scarto tra velocità impostata e reale faceva slittare i battiti (0,23 ms/s).
  Usando signalsmith direttamente nessuno dei due problemi si presenta in linea di principio, ma verifica sempre con i test.
- **Cut-in** (`updateCutNudges`): le linee di battuta possono distare 10–40 ms dall’attacco (cassa / rullante).
  Il brano in uscita si ferma appena prima dell’attacco successivo, quello in entrata parte appena prima del proprio attacco (rilevato con un inviluppo di 2 ms, `BandEnergies.onsetOffset`).
  Solo 5 ms di sovrapposizione: 5 ms di dissolvenza in uscita da un lato, 3 ms in entrata dall’altro.
- **Quando si valuta l’automazione**: i confini dei passi contano dall’inizio del mix (stessi istanti anche riproducendo da metà).
- **Livelli subito prima di un inizio**: per un brano che parte entro 0,25 s, il valore subito dopo l’inizio si imposta in anticipo (per non perdere l’inizio di un cut-in).
- **Forma d’onda del mix**: i brani molto forti clippano sempre e i soli picchi danno una banda rossa → disegnare picco + nucleo RMS.
  Ridisegnare solo l’intervallo cambiato con 10 s di rincorsa e riutilizzare il resto spostato nel tempo. Dopo 20 s senza modifiche, ridisegnare tutto esattamente.
- **Pesantezza della timeline**: rallentava con molti brani → disegnare solo il visibile, durante la riproduzione invalidare solo la striscia della testina, mettere in cache mappa di tempo ecc. per revisione.
- **Colori**: brani vicini distanti almeno 0,15 di tinta (`separateNeighbourColors`).
- **Niente caricamenti doppi**: si giudica sia sul percorso (normalizzato) sia sull’impronta. Un brano trascinato sulla timeline che è già in libreria viene spostato da lì nel mix.
- **Giradischi**: un timer a 60 Hz contro l’orologio audio dava scatti → disegnare a ogni fotogramma con un orologio interpolato (corregge il 15% dell’errore ogni volta, si risincronizza oltre 50 ms).
- **VJ automatico**: cambiava troppo spesso → cambiare per frasi di 8 battute, all’inizio dei drop, mantenendo ogni scena per almeno 2 frasi.
- **Tempo rimanente dell’esportazione**: le prime stime non erano affidabili → stimare solo dall’avanzamento della fase stabile, arrotondato a 5 s / 10 s.

## 8. Dati di prova

In `~/Downloads` del Mac dell’utente (chiedi una copia se serve):
- `hyperflip.djaw` (mix dell’app Mac, audio incorporato), `hyperflip.wav` (la sua esportazione)
- `DJAW_pv_export*.wav` (esportazioni usate per confrontare anteprima ed esportazione)
- Brani: `chance-FINAL.wav`, `TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`, `you dont need to fall.mp3`, `01 welcome.wav` e altri

## 9. Aggiunte della 0.4.0

- **Dove inizia un cambio di tempo** (`Clip.tempoStart`): `'afterTransition'` (dopo la transizione; il valore predefinito di un nuovo cambio di tempo), `'mixIn'` o non impostato (insieme alla transizione; mix della 0.3 e precedenti), oppure un numero (battute dopo l’ingresso del brano).
  Il cambio inizia a `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))` e raggiunge il BPM successivo in `tempoRampBars(c)` battute (`Clip.tempoBars`, oppure la durata della transizione se non impostato).
- **Brani sovrapposti** (`ProjectFile.layers`, `Clip.layerOf`, `layerBar`, `layerParts`): fissati a una battuta di un brano del mix (l’ospite) e suonati sopra.
  Le posizioni vengono da `placeLayers` in `core/layers.ts`, l’assegnazione ai deck C / D da `layerDecks` (al massimo 2 alla volta).
  Il rendering crea una RenderSession con un solo brano per ogni sovrapposto e le somma in `renderNext()` (`nextChunk` è il minimo di tutte le sessioni).
  Quando `layerParts` è `vocals` / `instrumental`, si usano gli stem e `Automation.state` azzera l’altra parte.
- **Uscire da un loop mixando** (`Clip.outPass`): se il brano precedente è in loop, a quale giro avviene la transizione. Applicato al layout con `elapsedOfSourcePass`.
- **Lingue**: tabelle con il testo inglese di `L(ja, en)` come chiave (`src/core/locales/<lang>.json`). Per le chiamate il cui inglese è un template, `scripts/i18n.mjs` aggiunge chiave e valori in fase di build.
  I testi salvati, come le note del mix automatico, si creano con `captureLanguages()`, che conserva segnaposto per tutte le lingue, e `localize()` li mostra nella lingua attuale.
  Estrarre le chiavi: `node scripts/i18n.mjs extract`; unire le traduzioni: `node scripts/i18n-merge.mjs` (`_parts/c<N>_*.json`, 200 per parte).
- **Dimensione dei file**: l’audio incorporato non compresso (WAV) si salva in FLAC (`core/flac.ts`, predittori fissi + codifica Rice, identico bit per bit all’originale). MP3 e simili restano invariati.
