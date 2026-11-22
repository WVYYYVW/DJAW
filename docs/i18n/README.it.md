# DJAW

[日本語](../../README.md) | [English](README.en.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | **Italiano** | [Português](README.pt.md) | [Русский](README.ru.md)

Un editor di mix DJ in stile DAW (non in tempo reale). Unisci i brani con guide battuta per battuta, disegni i movimenti di fader, EQ, FX e voce ed esporti il mix. Funziona su Windows e Mac (Apple silicon).

- `src/` — l’app per Windows / Mac (Electron + TypeScript)
- `mac/` — la precedente app macOS (SwiftUI), il riferimento originale del comportamento
- Dettagli di progetto → [`docs/PORTING.md`](PORTING.it.md) (traduzioni in `docs/i18n/`)

Per uso personale (alcuni modelli inclusi hanno licenze non commerciali).

## Installazione

Dalle [Releases](https://github.com/WVYYYVW/DJAW/releases):
- **Windows**: `DJAW-Setup-x.y.z.exe`
- **Mac (Apple silicon)**: `DJAW-x.y.z-mac-arm64.dmg`

Una volta installato, DJAW si aggiorna da solo alle nuove versioni all’avvio.

## Avvio dal codice sorgente

Servono [Node.js](https://nodejs.org/) 22 o successivo (LTS) e Git.

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … compila e poi avvia l’app (per lo sviluppo).
- `npm run dist` … crea il programma di installazione (`dist/`).
- `npm test` … test del motore di rendering (non viene riprodotto alcun suono).

Analisi e cache audio si trovano in `%APPDATA%\DJAW` (`~/Library/Application Support/DJAW` su Mac).

## Lingue

日本語, English, 简体中文, 繁體中文, 한국어, Español, Français, Deutsch, Italiano, Português, Русский.
DJAW parte nella lingua di sistema; cambiala dal menu Lingua.

## Schermata

Simile ad Ableton Live.
- In alto: nome del file, trasporto, tempo, BPM e griglia (al centro della finestra), visual, guida, esportazione
- A sinistra: il browser (ordine del mix e libreria). Trascina per cambiarne la larghezza e la divisione tra i due. La libreria ha cartelle, ricerca, ordinamento (nome, BPM, tonalità, miglior abbinamento con il brano selezionato…, per tutti i brani o una cartella) e riordino trascinando
- Al centro: l’arrangiamento (deck A / B, deck C / D per i brani sovrapposti, MIX, sampler; la corsia del sampler si può nascondere)
- In basso: il pannello dei dettagli (Ctrl+Alt+I) con le schede Panoramica, Mix, Brano, Transizione, CUE, Loop, FX, Sampler, Deck. Massimizzalo con Ctrl+Alt+F. A schermo intero 16:9 l’editor delle transizioni sta tutto senza scorrere

## Funzioni

- Aggiunta e analisi dei brani: BPM, battere (Beat This!), struttura (intro, drop… visibile anche nell’editor CUE), tonalità, loudness, genere (EffNet), cue suggeriti dall’IA (CUE-DETR). Importazione dalla libreria di iTunes / Musica
- Modifica sulla timeline: dove e quanto si sovrappongono i brani, cut-in, loop / salti, FX
- **Cambi di tempo**: cambia il BPM durante il mix. Scegli dove inizia il cambio (dopo la transizione, insieme a essa…) e in quante battute (es. riportare un brano da −7,5% a 0,0% in 8 battute)
- **Brani sovrapposti (4 deck)**: suona un brano intero sopra un altro (deck C / D), anche solo voce o solo strumentale. La vista deck e il mixer mostrano 4 canali
- **Uscire da un loop mixando**: scegli a quale giro del loop entra il brano successivo
- Editor delle transizioni: disegna le linee di fader, EQ, filtro, eco, riverbero e voce / batteria / basso / melodia. Preset, take e transizioni personali salvate
- Mix automatico (schemi, candidati, verifica col rendering), disposizione automatica (anche l’ordine), guida per suonarlo e scaletta per SoundCloud
- Separazione degli stem: voce, batteria, basso, melodia (Spleeter 4stems)
- Sampler: 8 pad (tasti Q–I), posizionati sui battiti (registrazione, roll, livello). I suoni integrati (air horn, sirena dub, riser, impatti, cassa gabber…) sono tutti sintetizzati per DJAW e liberi da usare in mix, live e upload
- Esportazione: WAV (24 bit) / M4A (AAC 256 kbps), 44,1 / 48 kHz, MP4 con visual (VJ automatico), anteprima dei visual dal vivo (Ctrl+Alt+V)
- Salvataggio: un solo file `.djaw` con l’audio (i brani non compressi come i WAV sono salvati in FLAC senza perdita, circa metà dimensione, suono identico). L’ultimo mix si riapre all’avvio

L’anteprima usa lo stesso motore dell’esportazione: quello che senti è esattamente ciò che viene scritto.

Licenze dei modelli: `models/ThirdPartyNotices.txt` (EffNet è non commerciale).
