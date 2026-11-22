# Portage Windows : détails de conception, table de correspondance et pièges

[日本語](../PORTING.md) | [English](PORTING.en.md) | [简体中文](PORTING.zh-Hans.md) | [繁體中文](PORTING.zh-Hant.md) | [한국어](PORTING.ko.md) | [Español](PORTING.es.md) | **Français** | [Deutsch](PORTING.de.md) | [Italiano](PORTING.it.md) | [Português](PORTING.pt.md) | [Русский](PORTING.ru.md)

La suite de `CLAUDE.md`. Le code de l’app Mac (`mac/DJAW`) est **la spécification de référence**. Recopiez les nombres, courbes et seuils à l’identique
(presque tous ont été réglés à l’oreille par l’utilisateur pendant longtemps).

> L’original japonais fait foi ; ceci est une traduction.

---

## 1. Structure de l’application Electron

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main : fenêtre, menus (la structure des menus de MyApp.swift sur Mac), dialogues, sauvegarde auto, fichiers récents
src/core/               TypeScript indépendant de l’UI (testable dans Node seul)
  models.ts             Models.swift (Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…)
  tempo.ts              TempoFX.swift (TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState)
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() etc.
  project.ts            lecture/écriture .djaw (DJAWPACK)
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer (ONNX), AnalysisCache
  render/*.ts           Voice (lecture → étirement → EQ → FXKernel → écho → réverb → fader), RenderSession, export WAV, forme d’onde du mix
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts (aperçu, export, forme d’onde ; Web Worker), analysis.child.ts (analyse ; processus enfant)
src/renderer/           UI React (store.ts = la partie état d’UI de MixStore, components/…)
src/vendor/stretch-core.mjs   généré par tools/signalsmith/make-core.mjs
tests/                  tests de core (Node)
```

- `BrowserWindow` peut utiliser `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true`
  (app personnelle qui ne manipule que des fichiers locaux ; utiliser fs directement depuis le Worker est un gros avantage).
- État : MixStore = « le document (clips, library, masterBPM, gridOffset…) + l’état d’UI ».
  Le document est mis à jour par des fonctions pures (`core/`) et l’annulation utilise des instantanés comme sur Mac (jusqu’à 300).
- ID : les UUID Swift sont enregistrés en majuscules → `crypto.randomUUID().toUpperCase()`.

## 2. Données audio

- **Décodage** : dans le renderer, `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → tout est ramené à 44,1 kHz.
  Chromium ne lit pas l’AIFF, on l’analyse donc soi-même (en-tête + PCM big-endian).
- **Cache PCM** : `<userData>/cache/pcm/<empreinte>.pcm` (16 bits stéréo entrelacé, longueur et fréquence d’échantillonnage dans l’en-tête).
  On ne lit que les plages utiles, avec `fs.readSync`. La durée vient du nombre d’échantillons / de la fréquence du fichier source (pour coïncider avec `duration` sur Mac).
- **Empreinte** (`AnalysisCache.fingerprint`) : SHA-256 de (`"<taille>"` + 256 Ko de début + 256 Ko de fin si taille > 512 Ko), hexadécimal minuscule.
  Les caches d’analyse, de profils et de stems ont tous cette clé. La valeur est la même que sur Mac, donc `profiles` etc. du `.djaw` se partagent.
- **Métadonnées** : `music-metadata` (titre, artiste, pochette, tag de genre).

## 3. Le moteur de rendu (le plus important)

Lisez `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift` de l’app Mac.

### Unités de temps
- La timeline est en **secondes de référence** (secondes au BPM de base = `masterBPM`). Avec des changements de tempo, elle diffère du temps réel.
  Conversion par `TempoMap.real(t)` et `reference(atReal:)`. Les positions d’échantillon sont toujours **secondes réelles × fréquence d’échantillonnage**.
- Vitesse du morceau `c` : `rate = master / c.bpm` (avec `tempoSync`). Sous une carte de tempo, `c.rate(tempo.bpm(at: t))`.
- Les portions de la source jouées par un morceau sont données par `playSegments()` (boucles et sauts compris). `elapsed` est en secondes de la source.

### Pas
- Un pas par **frontière de 512 trames**, compté depuis le début du mix. Si un morceau commence au milieu d’un pas, le pas est coupé là (`nextChunk`).
- À l’instant central `t` de chaque pas, `Automation.state(clips, i, t, master)` est évalué et appliqué à toutes les voix.
- La voix de chaque morceau démarre **exactement** à sa trame de début (sur Mac, les voix arrivées en cours de route qui se décalaient dans l’unité d’étirement ont longtemps posé problème).
  Après la fin, elle tourne encore `tail = 8` secondes pour les queues d’écho et de réverb.

### Dans une voix (Chain)
1. **Lecture** (`ClipSchedule.ranges` / `BufferFeeder`) : lecture portion par portion.
   **Fondu d’entrée de 3 ms** au début de la première portion. Si le morceau suivant est un `cut`, **fondu de sortie de 5 ms** à la fin.
   Frein / backspin (`OutroFX`) remplace la fin par le résultat de `TurntableFX.render` (porté tel quel).
2. **Étirement / hauteur** : signalsmith-stretch. `stretchRate` (1 exactement devient 1,00002 pour toujours traiter).
   Key lock désactivé (vinyle) : transposer de `pitchCents` ; décalage de tonalité ±6 demi-tons.
   Pour chaque bloc de sortie `inN = round(outN × rate)` (le reste est reporté : erreur cumulée nulle).
   La latence (5292 échantillons entrée + sortie à 44,1 k) est **annulée exactement**, p. ex. en se positionnant avec l’entrée précédant la position de départ au démarrage de la voix et en jetant la sortie.
   Test : passer un train de clics ; les clics en sortie doivent être à `(position d’entrée − position de départ) / rate` à ±1 échantillon.
3. **EQ** (`DJEQ.configure`) : plateau grave 180 Hz / cloche 1 kHz, largeur 2 octaves / plateau aigu 4,5 kHz.
   Gains `state.low/mid/high` (dB ; kill −40 dB, MID −24 dB). Biquads équivalents à AVAudioUnitEQ d’Apple.
4. **DJ FX** : `FXKernel` (filtre, phaser, flanger, bitcrusher, gate, roll) travaille à l’échantillon, donc **porté tel quel**.
5. **Écho** : comme AVAudioUnitDelay (délai = temps × 0,75 (écho de sortie) ou `echoDiv`, réinjection 55 % (30 + 30 × quantité en FX),
   passe-bas 7 kHz, wet/dry). En écho de sortie, `send` passe à 0 après 1 temps pour ne garder que la queue.
6. **Réverb** : comme largeHall2 d’AVAudioUnitReverb (quelque chose de proche, p. ex. Freeverb). wet = 55 % × quantité.
7. **Fader** : `state.volume` (gain × correction de loudness × enveloppe).

- **Stems** (étape 3) : les lectures voix et accompagnement sont mélangées avant l’étirement (`stemMix`).
- **Aperçu** : la même session rend 0,25 s d’avance dans le Worker et alimente l’AudioWorklet.
  Les changements de niveaux, EQ, FX et courbes seulement sont appliqués à la session en cours (`update`). Ceux qui déplacent les sons (`structureKey` change) la reconstruisent depuis la position actuelle.
  La tête de lecture vient des « trames réellement sorties par le Worklet », interpolées à l’écran pour la fluidité (`smoothPlayhead` sur Mac).
- **Export** : WAV 24 bits et M4A (AAC 256 kbit/s), 44,1 k / 48 k. La normalisation met la crête à −1 dBFS (gain ×4 au plus, `OfflineRenderer.normalizeGain`). Une première passe mesure la crête, la seconde écrit (une seule suffit si la crête de la forme d’onde du mix est disponible). Le temps restant n’est estimé qu’une fois la phase stable commencée.

## 4. Le format `.djaw` (lu et écrit par Mac et Windows)

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile (clés triées, dates ISO 8601)
fichiers audio        les octets des fichiers source concaténés tels quels (media[].offset est relatif à la fin du JSON)
```
- S’il ne commence pas par `DJAWPACK`, c’est du JSON simple (ancien format, sauvegarde auto).
- `ProjectFile` : `format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` etc. (fin de `Models.swift`).
- `clips[].url` est une URL du type `file:///Users/...` (chemin Mac). Ordre de résolution à l’ouverture : audio intégré (`mediaID` → dossier d’extraction) → `relativePath` (relatif au .djaw) → `url` → sinon « fichier introuvable » à relier.
  Les chemins Windows sont enregistrés en `file:///C:/...`.
- Où l’audio intégré est extrait : Mac `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<nom d’origine>`, Windows `%APPDATA%/DJAW/Media/<projectID>/`.
- `analyses` : empreinte → analyse de l’app Mac (plist binaire compressé LZFSE). Windows n’a pas besoin de le lire (il réanalyse), mais
  **le conserve intact à l’enregistrement**, si bien qu’à l’ouverture sur Mac aucune réanalyse n’est nécessaire. L’analyse Windows va sous une autre clé (p. ex. `analysesWin`).
- Exemple réel : le `hyperflip.djaw` de l’utilisateur (environ 400 Mo, 9 morceaux intégrés, 5 dans le mix + 4 en bibliothèque, masterBPM 107, changements de tempo, pistes personnalisées).

## 5. Correspondance Swift → TypeScript

| Swift | Lignes | Rôle | Étape | Notes |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | clips, courbes, pistes, prises, palette, ProjectFile | 1 | recopier les calculs tels quels |
| Model/TempoFX.swift | 399 | carte de tempo, définitions des FX | 1 | |
| Model/Automation.swift | 260 | volume, EQ, FX et stems à chaque instant ; points de bascule | 1 | commun à la lecture et à l’export |
| Model/Localization.swift | 43 | bascule japonais / anglais | 1 | |
| Model/PerformanceGuide.swift | 454 | guide de jeu, liste des morceaux | 2 | |
| Model/AutoMixer.swift | 857 | planification du mix automatique | 2 | |
| Audio/AudioAnalyzer.swift | 503 | chargement, forme d’onde, BPM, premier temps, énergie par bande | 1 | |
| Audio/StructureAnalyzer.swift | 517 | structure (intro / montée / drop…), tonalité | 1 | base du mix auto et des guides |
| Audio/NeuralAnalyzer.swift | 603 | Beat This! (temps), CUE-DETR (cues suggérés) | 1/2 | ONNX nécessaire |
| Audio/GenreAnalyzer.swift | 487 | genre (EffNet), présence de voix | 2 | ONNX disponible |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS (BS.1770) | 1 | |
| Audio/AnalysisCache.swift | 169 | empreinte, cache d’analyse | 1 | |
| Audio/AnalysisProgress.swift | 216 | progression de l’analyse, temps restant | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | remplacer les parties AVFoundation par notre DSP |
| Audio/MixRenderSession.swift | 299 | le rendu du mix | 1 | |
| Audio/StreamingPlayback.swift | 185 | aperçu | 1 | Worker + AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | export, forme d’onde du mix (rendu partiel) | 1 | |
| Audio/DJFX.swift | 464 | FXKernel, frein / backspin | 1 | porter tel quel |
| Audio/StretchCalibration.swift | 118 | correction de dérive d’AVAudioUnitTimePitch | — | **inutile** (signalsmith accepte directement le nombre d’entrées) |
| Audio/TransitionCheck.swift | 187 | vérification par rendu des transitions auto | 2 | |
| Audio/StemSeparator.swift | 231 | séparation de voix Spleeter | 3 | ONNX nécessaire |
| Audio/MusicLibrary.swift | 97 | bibliothèque de Musique.app | 2 | lit le XML de la bibliothèque iTunes / Musique (`src/core/musicLibrary.ts`) |
| Store/MixStore.swift | 3352 | état, éditions, mise en page, lecture, enregistrement, export | 1(+2) | les parties mix auto à l’étape 2 |
| Store/MixStore+Locks.swift | 83 | verrouillage des transitions | 1 | |
| Store/MixStore+Loudness.swift | 55 | égalisation de loudness | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | forme d’onde du mix (redessin partiel, complet au repos) | 1 | |
| Store/MixStore+Simplify.swift | 169 | simplification des transitions | 1 | |
| Store/MixStore+Takes.swift | 92 | prises de transition | 1 | |
| Store/MixStore+Profiles.swift | 105 | infos du morceau, pochette | 2 | |
| Store/MixStore+Stems.swift | 49 | préparation des stems | 3 | |
| Store/ProjectContainer.swift | 136 | format .djaw | 1 | |
| Store/DebugHarness.swift | 514 | commandes de test automatiques pour le développement | — | remplacées par les tests Node sous Windows |
| Timeline/TimelineNSView.swift | 1655 | timeline (pistes A/B, règle des mesures, bandes de transition, glisser, forme d’onde du mix, suivi de la tête) | 1 | Canvas ; ne dessiner que le visible, ne redessiner que la tête |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | panneau de droite (transition, platines, FX, table de mixage, prises, usage du morceau) | 1 | |
| Views/TransitionEditorView.swift | 836 | éditeur de transition (dessin des pistes, écoute depuis la règle) | 1 | |
| Views/CueEditorView.swift | 891 | éditeur CUE (écoute en solo, IN/OUT, réglage de la grille) | 1 | |
| Views/DeckPanel.swift | 593 | platines et table de mixage | 1 | rotation fluide avec une horloge interpolée |
| Views/SidebarView.swift | 347 | ordre du mix, bibliothèque | 1 | |
| Views/TransportViews.swift | 156 | bouton de lecture, temps, BPM | 1 | |
| Views/ExportSheet.swift | 179 | export | 1 (audio) / 3 (vidéo) | |
| Views/ShortcutsView.swift | 116 | liste des raccourcis | 1 | lire ⌘ comme Ctrl |
| Views/AnalysisProgressView.swift | 48 | progression de l’analyse | 1 | |
| Views/Theme.swift | 108 | couleurs, formatage (Fmt) | 1 | |
| Views/AutoArrangeSheet.swift | 340 | arrangement auto | 2 | |
| Views/PerformanceGuideView.swift | 162 | guide de jeu, liste des morceaux | 2 | |
| Views/TrackProfileSheet.swift | 164 | édition des infos du morceau | 2 | |
| Views/MusicLibrarySheet.swift | 313 | Musique.app | 2 | choisir un fichier s’il n’y a pas de XML |
| Views/VisualPreviewView.swift | 84 | aperçu des visuels | 3 | |
| Media/TrackProfiles.swift | 123 | stockage des profils de morceaux | 2 | |
| Media/VideoExporter.swift | 445 | export vidéo | 3 | |
| Media/VisualPainter.swift | 583 | dessin des visuels, VJ auto | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | menus, mise en page générale | 1 | |

## 6. Modèles de ML (ONNX nécessaire)

Licences dans `mac/DJAW/ML/ThirdPartyNotices.txt`. Les matrices de prétraitement (`*_fbank_*.f32`, `*_melfb_*.f32`) et les étiquettes sont dans `mac/DJAW/ML/`.
Les fichiers d’origine sont dans `~/Downloads` sur le Mac de l’utilisateur (demandez-lui de les copier sur Windows au besoin ; les autorisations se demandent au début).

| Modèle | Source (Mac ~/Downloads) | Forme sous Windows |
|---|---|---|
| Beat This! (temps, premiers temps ; MIT) | `final0.ckpt` (81 Mo, PyTorch) | charger avec le code officiel `beat_this` et exporter en ONNX. Prétraitement `beatthis_fbank_513x128.f32`. Inférence avec onnxruntime-node |
| CUE-DETR (cues suggérés ; MIT) | `model.safetensors` (166 Mo, DETR de HF transformers) | charger avec transformers et exporter en ONNX. Prétraitement `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet (genre ; CC BY-NC-SA) | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`, tête `genre_discogs400-...pb`, `DJAW_heads/*.onnx` | le réseau principal et 4 têtes s’utilisent en ONNX. La tête genre400 : .pb → ONNX (tf2onnx), ou extraire les poids et faire le calcul matriciel |
| Spleeter 2stems (MIT) | dans l’app Mac, reconstruit en PyTorch puis converti en Core ML (identique à TF à 8e-6 d’erreur relative) | convertir en ONNX de la même façon. STFT 4096/1024, 1024 bandes × 512 trames, accompagnement = original − voix |

L’inférence se fait dans analysis.child (un processus enfant qui exécute Electron en Node), car **onnxruntime-node ne fonctionne pas dans un Web Worker du renderer** (le charger fait planter tout le renderer). Recopiez exactement le prétraitement Mac (`NeuralAnalyzer.swift`, `GenreAnalyzer.swift`, `StemSeparator.swift`).

## 7. Pièges et historique (ce que l’app Mac nous a appris)

- **Concordance export / aperçu** : au départ l’app Mac avait un chemin temps réel séparé pour l’aperçu, et les entrées de morceaux décalaient par rapport à l’export.
  Finalement : « rendre l’aperçu avec la même session que l’export et le diffuser ». L’app Windows procède ainsi dès le départ.
- **Latence et dérive de vitesse de l’unité d’étirement** : les voix arrivées en cours de route entraient en retard / en avance, et l’écart entre vitesse réglée et réelle faisait dériver les temps (0,23 ms/s).
  Avec signalsmith utilisé directement, aucun des deux ne se produit en principe, mais vérifiez toujours par des tests.
- **Cut-ins** (`updateCutNudges`) : les barres de mesure peuvent être à 10–40 ms de l’attaque (grosse caisse / caisse claire).
  Le morceau sortant s’arrête juste avant l’attaque suivante, l’entrant démarre juste avant sa propre attaque (détectée avec une enveloppe de 2 ms, `BandEnergies.onsetOffset`).
  Ne garder que 5 ms de chevauchement : fondu de sortie de 5 ms côté sortant, fondu d’entrée de 3 ms côté entrant.
- **Moment d’évaluation de l’automation** : les frontières de pas comptent depuis le début du mix (mêmes instants même en lisant depuis le milieu).
- **Niveaux juste avant un départ** : pour un morceau qui démarre dans moins de 0,25 s, la valeur juste après son départ est posée à l’avance (pour ne pas perdre le début d’un cut-in).
- **Forme d’onde du mix** : les morceaux très forts saturent en permanence et les crêtes seules donnent une bande rouge → dessiner crête + cœur RMS.
  Ne redessiner que la plage modifiée avec 10 s d’élan et réutiliser le reste décalé dans le temps. Après 20 s sans édition, tout redessiner exactement.
- **Lenteur de la timeline** : elle ralentissait avec beaucoup de morceaux → ne dessiner que le visible, n’invalider que la bande de la tête pendant la lecture, mettre en cache la carte de tempo etc. par révision.
- **Couleurs** : des morceaux voisins sont séparés d’au moins 0,15 en teinte (`separateNeighbourColors`).
- **Pas de double chargement** : jugé à la fois sur le chemin (normalisé) et l’empreinte. Un morceau déposé sur la timeline qui est déjà en bibliothèque est déplacé de là vers le mix.
- **Platines** : un minuteur à 60 Hz contre l’horloge audio provoquait des saccades → dessiner à chaque image avec une horloge interpolée (corrige 15 % de l’erreur à chaque fois, resynchronise au-delà de 50 ms).
- **VJ auto** : changeait trop souvent → changer par phrase de 8 mesures, au début des drops, en gardant chaque rendu au moins 2 phrases.
- **Temps restant à l’export** : les premières estimations n’étaient pas fiables → n’estimer qu’à partir de la progression de la phase stable, arrondi à 5 s / 10 s.

## 8. Données de test

Dans `~/Downloads` du Mac de l’utilisateur (demandez une copie si besoin) :
- `hyperflip.djaw` (mix de l’app Mac, audio intégré), `hyperflip.wav` (son export)
- `DJAW_pv_export*.wav` (exports utilisés pour comparer aperçu et export)
- Morceaux : `chance-FINAL.wav`, `TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`, `you dont need to fall.mp3`, `01 welcome.wav` et d’autres

## 9. Ajouts de la 0.4.0

- **Où commence un changement de tempo** (`Clip.tempoStart`) : `'afterTransition'` (après la transition ; la valeur par défaut d’un nouveau changement de tempo), `'mixIn'` ou non défini (avec la transition ; mix de la 0.3 et avant), ou un nombre (mesures après l’entrée du morceau).
  Le changement commence à `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))` et atteint le BPM suivant en `tempoRampBars(c)` mesures (`Clip.tempoBars`, ou la durée de la transition s’il n’est pas défini).
- **Morceaux superposés** (`ProjectFile.layers`, `Clip.layerOf`, `layerBar`, `layerParts`) : fixés à une mesure d’un morceau du mix (l’hôte) et joués par-dessus.
  Les positions viennent de `placeLayers` dans `core/layers.ts`, l’attribution aux platines C / D de `layerDecks` (2 au plus en même temps).
  Le rendu crée une RenderSession d’un seul morceau par superposition et les additionne dans `renderNext()` (`nextChunk` est le minimum sur toutes les sessions).
  Quand `layerParts` vaut `vocals` / `instrumental`, les stems sont utilisés et `Automation.state` coupe l’autre partie.
- **Sortir d’une boucle en mixant** (`Clip.outPass`) : quand le morceau précédent boucle, à quel passage la transition a lieu. Appliqué à la mise en page via `elapsedOfSourcePass`.
- **Langues** : tables indexées par le texte anglais de `L(ja, en)` (`src/core/locales/<lang>.json`). Pour les appels dont l’anglais est un gabarit, `scripts/i18n.mjs` ajoute la clé et les valeurs à la compilation.
  Les textes enregistrés, comme les notes du mix auto, sont créés avec `captureLanguages()`, qui garde des marqueurs pour toutes les langues, et `localize()` les affiche dans la langue courante.
  Extraire les clés : `node scripts/i18n.mjs extract` ; assembler les traductions : `node scripts/i18n-merge.mjs` (`_parts/c<N>_*.json`, 200 par partie).
- **Taille des fichiers** : l’audio intégré non compressé (WAV) est stocké en FLAC (`core/flac.ts`, prédicteurs fixes + codage de Rice, identique au bit près à la source). Le MP3 et assimilés restent tels quels.
