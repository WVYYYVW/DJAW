# Port a Windows: detalles de diseño, tabla de correspondencias y trampas

[日本語](../PORTING.md) | [English](PORTING.en.md) | [简体中文](PORTING.zh-Hans.md) | [繁體中文](PORTING.zh-Hant.md) | [한국어](PORTING.ko.md) | **Español** | [Français](PORTING.fr.md) | [Deutsch](PORTING.de.md) | [Italiano](PORTING.it.md) | [Português](PORTING.pt.md) | [Русский](PORTING.ru.md)

Continuación de `CLAUDE.md`. El código de la app de Mac (`mac/DJAW`) es **la especificación de referencia**. Copia números, curvas y umbrales tal cual
(casi todos los ajustó el usuario de oído durante mucho tiempo).

> El original en japonés es el que manda; esto es una traducción.

---

## 1. Estructura de la app Electron

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main: ventana, menús (la estructura de menús de MyApp.swift en Mac), diálogos, autoguardado, archivos recientes
src/core/               TypeScript independiente de la UI (debe poder probarse en Node solo)
  models.ts             Models.swift (Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…)
  tempo.ts              TempoFX.swift (TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState)
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() etc.
  project.ts            lectura/escritura de .djaw (DJAWPACK)
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer (ONNX), AnalysisCache
  render/*.ts           Voice (lectura → estiramiento → EQ → FXKernel → eco → reverb → fader), RenderSession, exportación WAV, forma de onda de la mezcla
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts (vista previa, exportación, forma de onda; Web Worker), analysis.child.ts (análisis; proceso hijo)
src/renderer/           UI React (store.ts = la parte de estado de UI de MixStore, components/…)
src/vendor/stretch-core.mjs   generado por tools/signalsmith/make-core.mjs
tests/                  pruebas de core (Node)
```

- `BrowserWindow` puede usar `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true`
  (app personal que solo maneja archivos locales; usar fs directamente desde el Worker es una gran ventaja).
- Estado: MixStore es «el documento (clips, library, masterBPM, gridOffset…) + estado de UI».
  El documento se actualiza con funciones puras (`core/`) y Deshacer usa instantáneas como en Mac (hasta 300).
- IDs: los UUID de Swift se guardan como cadenas en mayúsculas → `crypto.randomUUID().toUpperCase()`.

## 2. Datos de audio

- **Decodificación**: en el renderer, `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → todo queda a 44,1 kHz.
  Chromium no lee AIFF, así que se analiza a mano (cabecera + PCM big-endian).
- **Caché PCM**: `<userData>/cache/pcm/<huella>.pcm` (16 bits estéreo entrelazado; longitud y frecuencia de muestreo en la cabecera).
  Se leen solo los rangos necesarios con `fs.readSync`. La duración sale del número de muestras / frecuencia del archivo original (para coincidir con `duration` en Mac).
- **Huella** (`AnalysisCache.fingerprint`): SHA-256 de (`"<tamaño>"` + primeros 256 KB + últimos 256 KB si el tamaño > 512 KB), hexadecimal en minúsculas.
  Las cachés de análisis, perfiles y stems usan esta clave. Da el mismo valor que en Mac, así que `profiles` etc. de `.djaw` se pueden compartir.
- **Metadatos**: `music-metadata` (título, artista, portada, etiqueta de género).

## 3. El motor de render (lo más importante)

Lee `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift` de la app de Mac.

### Unidades de tiempo
- La línea de tiempo va en **segundos de referencia** (segundos al BPM base = `masterBPM`). Con cambios de tempo difiere del tiempo real.
  Convierte con `TempoMap.real(t)` y `reference(atReal:)`. Las posiciones de muestra son siempre **segundos reales × frecuencia de muestreo**.
- Velocidad de la pista `c`: `rate = master / c.bpm` (con `tempoSync`). Con un mapa de tempo, `c.rate(tempo.bpm(at: t))`.
- Los tramos del original que suena una pista los da `playSegments()` (con bucles y saltos). `elapsed` está en segundos del original.

### Pasos
- Un paso por cada **límite de 512 frames**, contando desde el inicio de la mezcla. Si una pista empieza a mitad de un paso, el paso se corta ahí (`nextChunk`).
- En el instante central `t` de cada paso se evalúa `Automation.state(clips, i, t, master)` y se aplica a todas las voces.
- La voz de cada pista arranca **exactamente** en su frame de inicio (en Mac, las voces que se unían a mitad y se desfasaban en la unidad de estiramiento dieron muchos problemas).
  Tras terminar, sigue `tail = 8` segundos para las colas de eco y reverb.

### Dentro de una voz (Chain)
1. **Lectura** (`ClipSchedule.ranges` / `BufferFeeder`): lee tramo a tramo.
   **Fundido de entrada de 3 ms** al principio del primer tramo. Si la siguiente pista es un `cut`, **fundido de salida de 5 ms** al final.
   Freno / backspin (`OutroFX`) sustituye el final por el resultado de `TurntableFX.render` (portado tal cual).
2. **Estiramiento / tono**: signalsmith-stretch. `stretchRate` (exactamente 1 pasa a 1,00002 para procesar siempre).
   Con key lock OFF (vinilo), transponer `pitchCents`; desplazamiento de tonalidad ±6 semitonos.
   Por cada bloque de salida `inN = round(outN × rate)` (arrastrando el resto: error acumulado cero).
   La latencia (5292 muestras entre entrada y salida a 44,1 k) se **cancela exactamente**, p. ej. buscando con la entrada anterior a la posición de inicio al arrancar la voz y descartando salida.
   Prueba: pasar un tren de clics; los clics de salida deben estar en `(posición de entrada − posición de inicio) / rate` con ±1 muestra.
3. **EQ** (`DJEQ.configure`): shelving grave 180 Hz / peaking 1 kHz, ancho de banda 2 octavas / shelving agudo 4,5 kHz.
   Ganancias `state.low/mid/high` (dB; kill −40 dB, MID −24 dB). Biquads equivalentes a AVAudioUnitEQ de Apple.
4. **DJ FX**: `FXKernel` (filtro, phaser, flanger, bitcrusher, gate, roll) trabaja por muestra, así que se **porta tal cual**.
5. **Eco**: como AVAudioUnitDelay (retardo = tiempo × 0,75 (eco de salida) o `echoDiv`, realimentación 55 % (30 + 30 × cantidad como FX),
   paso bajo 7 kHz, wet/dry). En el eco de salida, `send` baja a 0 tras 1 tiempo y solo queda la cola.
6. **Reverb**: como largeHall2 de AVAudioUnitReverb (algo cercano, p. ej. Freeverb). wet = 55 % × cantidad.
7. **Fader**: `state.volume` (ganancia × corrección de sonoridad × envolvente).

- **Stems** (fase 3): las lecturas de voz y acompañamiento se mezclan antes del estiramiento (`stemMix`).
- **Vista previa**: la misma sesión renderiza 0,25 s por delante en el Worker y alimenta el AudioWorklet.
  Los cambios solo de niveles, EQ, FX y curvas se aplican a la sesión en marcha (`update`). Los que mueven sonidos (cambia `structureKey`) la reconstruyen desde la posición actual.
  El cabezal sale de «frames que el Worklet ha emitido de verdad», interpolado en pantalla para que sea suave (`smoothPlayhead` en Mac).
- **Exportación**: WAV 24 bits y M4A (AAC 256 kbps), 44,1 k / 48 k. La normalización lleva el pico a −1 dBFS (como mucho ×4, `OfflineRenderer.normalizeGain`). La primera pasada mide el pico y la segunda escribe (basta una si se tiene el pico de la forma de onda de la mezcla). El tiempo restante se estima solo cuando empieza la fase estable.

## 4. El formato `.djaw` (lo leen y escriben Mac y Windows)

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile (claves ordenadas, fechas ISO 8601)
archivos de audio     los bytes de los archivos originales concatenados tal cual (media[].offset es relativo al final del JSON)
```
- Si no empieza por `DJAWPACK`, es JSON plano (formato antiguo, autoguardado).
- `ProjectFile`: `format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` etc. (final de `Models.swift`).
- `clips[].url` es una URL tipo `file:///Users/...` (ruta de Mac). Orden de resolución al abrir: audio incrustado (`mediaID` → carpeta de extracción) → `relativePath` (relativa al .djaw) → `url` → si no, «archivo no encontrado» para volver a enlazar.
  Las rutas de Windows se guardan como `file:///C:/...`.
- Dónde se extrae el audio incrustado: Mac `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<nombre original>`, Windows `%APPDATA%/DJAW/Media/<projectID>/`.
- `analyses`: huella → análisis de la app de Mac (plist binario comprimido con LZFSE). Windows no necesita leerlo (vuelve a analizar), pero
  **lo conserva intacto al guardar**, así al abrir en Mac no hay que reanalizar. El análisis de Windows va en otra clave (p. ej. `analysesWin`).
- Ejemplo real: `hyperflip.djaw` del usuario (unos 400 MB, 9 pistas incrustadas, 5 en la mezcla + 4 en la biblioteca, masterBPM 107, cambios de tempo, carriles personalizados).

## 5. Correspondencia Swift → TypeScript

| Swift | Líneas | Función | Fase | Notas |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | clips, curvas, carriles, tomas, paleta, ProjectFile | 1 | copiar los cálculos tal cual |
| Model/TempoFX.swift | 399 | mapa de tempo, definición de FX | 1 | |
| Model/Automation.swift | 260 | volumen, EQ, FX y stems en cada instante; puntos de cambio | 1 | común a reproducción y exportación |
| Model/Localization.swift | 43 | cambio japonés / inglés | 1 | |
| Model/PerformanceGuide.swift | 454 | guía para tocar, lista de pistas | 2 | |
| Model/AutoMixer.swift | 857 | planificación de la mezcla automática | 2 | |
| Audio/AudioAnalyzer.swift | 503 | carga, forma de onda, BPM, primer tiempo, energía por bandas | 1 | |
| Audio/StructureAnalyzer.swift | 517 | estructura (intro / build / drop…), tonalidad | 1 | base de la mezcla automática y las guías |
| Audio/NeuralAnalyzer.swift | 603 | Beat This! (tiempos), CUE-DETR (cues sugeridos) | 1/2 | requiere ONNX |
| Audio/GenreAnalyzer.swift | 487 | género (EffNet), presencia de voz | 2 | ONNX disponible |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS (BS.1770) | 1 | |
| Audio/AnalysisCache.swift | 169 | huella, caché de análisis | 1 | |
| Audio/AnalysisProgress.swift | 216 | progreso del análisis, tiempo restante | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | sustituir las partes de AVFoundation por DSP propio |
| Audio/MixRenderSession.swift | 299 | el render de la mezcla | 1 | |
| Audio/StreamingPlayback.swift | 185 | vista previa | 1 | Worker + AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | exportación, forma de onda de la mezcla (render parcial) | 1 | |
| Audio/DJFX.swift | 464 | FXKernel, freno / backspin | 1 | portar tal cual |
| Audio/StretchCalibration.swift | 118 | corrección de deriva de AVAudioUnitTimePitch | — | **no hace falta** (signalsmith admite el número de entradas directamente) |
| Audio/TransitionCheck.swift | 187 | comprobación renderizada de transiciones automáticas | 2 | |
| Audio/StemSeparator.swift | 231 | separación de voz con Spleeter | 3 | requiere ONNX |
| Audio/MusicLibrary.swift | 97 | biblioteca de Música.app | 2 | lee el XML de la biblioteca de iTunes / Música (`src/core/musicLibrary.ts`) |
| Store/MixStore.swift | 3352 | estado, ediciones, layout, reproducción, guardado, exportación | 1(+2) | lo de mezcla automática en la fase 2 |
| Store/MixStore+Locks.swift | 83 | bloqueo de transiciones | 1 | |
| Store/MixStore+Loudness.swift | 55 | igualar sonoridad | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | forma de onda de la mezcla (redibujo parcial, completo en reposo) | 1 | |
| Store/MixStore+Simplify.swift | 169 | simplificar transiciones | 1 | |
| Store/MixStore+Takes.swift | 92 | tomas de transición | 1 | |
| Store/MixStore+Profiles.swift | 105 | información de pista, portada | 2 | |
| Store/MixStore+Stems.swift | 49 | preparar stems | 3 | |
| Store/ProjectContainer.swift | 136 | formato .djaw | 1 | |
| Store/DebugHarness.swift | 514 | órdenes de prueba automáticas para desarrollo | — | en Windows lo sustituyen las pruebas de Node |
| Timeline/TimelineNSView.swift | 1655 | línea de tiempo (carriles A/B, regla de compases, bandas de transición, arrastres, forma de onda de la mezcla, seguimiento del cabezal) | 1 | Canvas; dibujar solo lo visible, redibujar solo el cabezal |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | panel derecho (transición, decks, FX, mezclador, tomas, uso de la pista) | 1 | |
| Views/TransitionEditorView.swift | 836 | editor de transiciones (dibujo de carriles, escucha desde la regla) | 1 | |
| Views/CueEditorView.swift | 891 | editor CUE (escucha en solo, IN/OUT, ajuste de rejilla) | 1 | |
| Views/DeckPanel.swift | 593 | platos y mezclador | 1 | girar suave con un reloj interpolado |
| Views/SidebarView.swift | 347 | orden de la mezcla, biblioteca | 1 | |
| Views/TransportViews.swift | 156 | botón de reproducción, tiempo, BPM | 1 | |
| Views/ExportSheet.swift | 179 | exportación | 1 (audio) / 3 (vídeo) | |
| Views/ShortcutsView.swift | 116 | lista de atajos | 1 | ⌘ se lee como Ctrl |
| Views/AnalysisProgressView.swift | 48 | progreso del análisis | 1 | |
| Views/Theme.swift | 108 | colores, formato (Fmt) | 1 | |
| Views/AutoArrangeSheet.swift | 340 | orden automático | 2 | |
| Views/PerformanceGuideView.swift | 162 | guía para tocar, lista de pistas | 2 | |
| Views/TrackProfileSheet.swift | 164 | editar información de la pista | 2 | |
| Views/MusicLibrarySheet.swift | 313 | Música.app | 2 | elegir un archivo si no hay XML |
| Views/VisualPreviewView.swift | 84 | vista previa de visuales | 3 | |
| Media/TrackProfiles.swift | 123 | guardar perfiles de pistas | 2 | |
| Media/VideoExporter.swift | 445 | exportación de vídeo | 3 | |
| Media/VisualPainter.swift | 583 | dibujo de visuales, VJ automático | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | menús, layout general | 1 | |

## 6. Modelos de ML (requieren ONNX)

Licencias en `mac/DJAW/ML/ThirdPartyNotices.txt`. Las matrices de preprocesado (`*_fbank_*.f32`, `*_melfb_*.f32`) y las etiquetas están en `mac/DJAW/ML/`.
Los originales están en `~/Downloads` del Mac del usuario (pídele que los copie a Windows cuando haga falta; los permisos se piden al principio).

| Modelo | Original (Mac ~/Downloads) | Forma en Windows |
|---|---|---|
| Beat This! (tiempos, primeros tiempos; MIT) | `final0.ckpt` (81 MB, PyTorch) | cargar con el código oficial de `beat_this` y exportar a ONNX. Preprocesado `beatthis_fbank_513x128.f32`. Inferencia con onnxruntime-node |
| CUE-DETR (cues sugeridos; MIT) | `model.safetensors` (166 MB, DETR de HF transformers) | cargar con transformers y exportar a ONNX. Preprocesado `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet (género; CC BY-NC-SA) | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`, cabeza `genre_discogs400-...pb`, `DJAW_heads/*.onnx` | el modelo base y 4 cabezas sirven como ONNX. La cabeza genre400: .pb → ONNX (tf2onnx), o extraer los pesos y hacer el cálculo matricial |
| Spleeter 2stems (MIT) | en Mac se reconstruyó en PyTorch y se pasó a Core ML (coincide con TF con error relativo 8e-6) | pasar a ONNX igual. STFT 4096/1024, 1024 bins × 512 frames, acompañamiento = original − voz |

La inferencia va en analysis.child (proceso hijo que ejecuta Electron como Node), porque **onnxruntime-node no funciona en un Web Worker del renderer** (al cargarlo se cae todo el renderer). Copia exactamente el preprocesado de Mac (`NeuralAnalyzer.swift`, `GenreAnalyzer.swift`, `StemSeparator.swift`).

## 7. Trampas e historia (lo que enseñó la app de Mac)

- **Que coincidan exportación y vista previa**: al principio Mac tenía un camino en tiempo real aparte para la vista previa, y las entradas de pista se desviaban de la exportación.
  Al final: «renderizar la vista previa con la misma sesión que la exportación y reproducirla». La app de Windows lo hace así desde el principio.
- **Latencia y deriva de velocidad de la unidad de estiramiento**: las voces que se unían a mitad llegaban tarde / pronto, y la diferencia entre velocidad fijada y real hacía derivar los tiempos (0,23 ms/s).
  Con signalsmith directamente no ocurre ninguna de las dos en principio, pero compruébalo siempre con pruebas.
- **Cortes** (`updateCutNudges`): las líneas de compás pueden estar a 10–40 ms del ataque (bombo / caja).
  La pista saliente se para justo antes del siguiente ataque y la entrante empieza justo antes de su propio ataque (detectado con una envolvente de 2 ms, `BandEnergies.onsetOffset`).
  Solo 5 ms de solape: fundido de salida de 5 ms en la saliente, de entrada de 3 ms en la entrante.
- **Cuándo se evalúa la automatización**: los límites de paso cuentan desde el inicio de la mezcla (los mismos instantes aunque se reproduzca desde la mitad).
- **Niveles justo antes de un inicio**: para una pista que empieza en menos de 0,25 s, el valor de justo después del inicio se pone antes (para no perder el principio de un corte).
- **Forma de onda de la mezcla**: las pistas muy fuertes saturan todo el rato y solo con picos sale una banda roja → dibujar pico + núcleo RMS.
  Redibujar solo el rango cambiado con 10 s de carrerilla y reutilizar el resto desplazado en el tiempo. Tras 20 s sin ediciones, redibujar todo con exactitud.
- **Rendimiento de la línea de tiempo**: se volvía lenta con muchas pistas → dibujar solo lo visible, invalidar solo la franja del cabezal al reproducir, cachear el mapa de tempo etc. por revisión.
- **Colores**: pistas vecinas separadas al menos 0,15 en tono (`separateNeighbourColors`).
- **Sin cargas duplicadas**: se juzga por la ruta (normalizada) y por la huella. Una pista soltada en la línea de tiempo que ya está en la biblioteca se mueve de ahí a la mezcla.
- **Platos**: un temporizador de 60 Hz frente al reloj de audio daba tirones → dibujar en cada fotograma con un reloj interpolado (corrige el 15 % del error cada vez, resincroniza por encima de 50 ms).
- **VJ automático**: cambiaba demasiado a menudo → cambiar por frases de 8 compases, al principio de los drops, manteniendo cada aspecto al menos 2 frases.
- **Tiempo restante de exportación**: las primeras estimaciones no eran fiables → estimar solo con el avance de la fase estable, redondeado a 5 s / 10 s.

## 8. Datos de prueba

En `~/Downloads` del Mac del usuario (pide una copia si hace falta):
- `hyperflip.djaw` (mezcla de la app de Mac, audio incrustado), `hyperflip.wav` (su exportación)
- `DJAW_pv_export*.wav` (exportaciones usadas para comparar vista previa y exportación)
- Pistas: `chance-FINAL.wav`, `TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`, `you dont need to fall.mp3`, `01 welcome.wav` y más

## 9. Añadido en 0.4.0

- **Dónde empieza un cambio de tempo** (`Clip.tempoStart`): `'afterTransition'` (tras la transición; lo predeterminado al crear un cambio de tempo), `'mixIn'` o sin definir (con la transición; mezclas de 0.3 y anteriores), o un número (compases desde que entra la pista).
  El cambio empieza en `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))` y llega al siguiente BPM en `tempoRampBars(c)` compases (`Clip.tempoBars`, o la duración de la transición si no está definido).
- **Pistas superpuestas** (`ProjectFile.layers`, `Clip.layerOf`, `layerBar`, `layerParts`): fijadas a un compás de una pista de la mezcla (la anfitriona) y tocadas encima.
  Las posiciones las da `placeLayers` en `core/layers.ts`; la asignación a los decks C / D, `layerDecks` (como mucho 2 a la vez).
  El render crea una RenderSession de una sola pista por cada superpuesta y las suma en `renderNext()` (`nextChunk` es el mínimo de todas las sesiones).
  Si `layerParts` es `vocals` / `instrumental`, se usan stems y `Automation.state` silencia la otra parte.
- **Salir de un bucle mezclando** (`Clip.outPass`): si la pista anterior está en bucle, en qué vuelta se hace la transición. Se aplica en el layout con `elapsedOfSourcePass`.
- **Idiomas**: tablas con el texto inglés de `L(ja, en)` como clave (`src/core/locales/<lang>.json`). En las llamadas cuyo inglés es una plantilla, `scripts/i18n.mjs` añade la clave y los valores al compilar.
  El texto que se guarda, como las notas de la mezcla automática, se crea con `captureLanguages()`, que guarda marcas para todos los idiomas, y `localize()` lo muestra en el idioma actual.
  Extraer claves: `node scripts/i18n.mjs extract`; unir traducciones: `node scripts/i18n-merge.mjs` (`_parts/c<N>_*.json`, 200 por parte).
- **Tamaño del archivo**: el audio incrustado sin comprimir (WAV) se guarda en FLAC (`core/flac.ts`, predictores fijos + codificación Rice, idéntico bit a bit al original). MP3 y similares se guardan tal cual.
