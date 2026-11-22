# Port para Windows: detalhes de projeto, tabela de correspondência e armadilhas

[日本語](../PORTING.md) | [English](PORTING.en.md) | [简体中文](PORTING.zh-Hans.md) | [繁體中文](PORTING.zh-Hant.md) | [한국어](PORTING.ko.md) | [Español](PORTING.es.md) | [Français](PORTING.fr.md) | [Deutsch](PORTING.de.md) | [Italiano](PORTING.it.md) | **Português** | [Русский](PORTING.ru.md)

Continuação do `CLAUDE.md`. O código do app de Mac (`mac/DJAW`) é **a especificação de referência**. Copie números, curvas e limiares exatamente
(quase todos foram ajustados de ouvido pelo usuário durante muito tempo).

> Vale o original em japonês; isto é uma tradução.

---

## 1. Estrutura do app Electron

```
package.json            electron, vite, typescript, react, signalsmith-stretch, music-metadata, onnxruntime-node, electron-builder
src/main/               Electron main: janela, menus (a estrutura de menus de MyApp.swift no Mac), diálogos, salvamento automático, arquivos recentes
src/core/               TypeScript independente da UI (deve ser testável só com Node)
  models.ts             Models.swift (Clip, TransitionShape, TransitionLanes, AutoPoint, ClipEdit, CuePoint, TransitionTake, ClipPalette, ProjectFile…)
  tempo.ts              TempoFX.swift (TempoMap, OutroFX, FXKind, FXShape, ClipFX, FXState)
  automation.ts         Automation.swift
  layout.ts             MixStore.layout(), updateCutNudges(), suggestedMixOut() etc.
  project.ts            leitura/escrita de .djaw (DJAWPACK)
  analysis/*.ts         AudioAnalyzer, StructureAnalyzer, LoudnessAnalyzer, NeuralAnalyzer (ONNX), AnalysisCache
  render/*.ts           Voice (leitura → stretch → EQ → FXKernel → eco → reverb → fader), RenderSession, exportação WAV, forma de onda da mixagem
  i18n.ts               L(ja, en)
src/workers/            render.worker.ts (prévia, exportação, forma de onda; Web Worker), analysis.child.ts (análise; processo filho)
src/renderer/           UI React (store.ts = a parte de estado de UI do MixStore, components/…)
src/vendor/stretch-core.mjs   gerado por tools/signalsmith/make-core.mjs
tests/                  testes do core (Node)
```

- `BrowserWindow` pode usar `nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true`
  (app pessoal que só lida com arquivos locais; usar fs direto no Worker é uma grande vantagem).
- Estado: o MixStore é "o documento (clips, library, masterBPM, gridOffset…) + estado da UI".
  O documento é atualizado com funções puras (`core/`) e o Desfazer usa instantâneos como no Mac (até 300).
- IDs: os UUID do Swift são salvos em maiúsculas → `crypto.randomUUID().toUpperCase()`.

## 2. Dados de áudio

- **Decodificação**: no renderer, `OfflineAudioContext(2, 1, 44100).decodeAudioData(buf)` → tudo fica em 44,1 kHz.
  O Chromium não lê AIFF, então ele é analisado à mão (cabeçalho + PCM big-endian).
- **Cache PCM**: `<userData>/cache/pcm/<impressão>.pcm` (16 bits estéreo intercalado, duração e taxa de amostragem no cabeçalho).
  Só os trechos necessários são lidos, com `fs.readSync`. A duração vem do número de amostras / taxa do arquivo original (para bater com o `duration` do Mac).
- **Impressão digital** (`AnalysisCache.fingerprint`): SHA-256 de (`"<tamanho>"` + primeiros 256 KB + últimos 256 KB se o tamanho > 512 KB), hexadecimal minúsculo.
  Os caches de análise, perfis e stems usam essa chave. Dá o mesmo valor do Mac, então `profiles` etc. do `.djaw` podem ser compartilhados.
- **Metadados**: `music-metadata` (título, artista, capa, tag de gênero).

## 3. O motor de renderização (o mais importante)

Leia `MixRenderSession` / `PlaybackEngine.swift` / `DJFX.swift` / `StreamingPlayback.swift` / `OfflineRenderer.swift` do app de Mac.

### Unidades de tempo
- A linha do tempo é em **segundos de referência** (segundos no BPM base = `masterBPM`). Com mudanças de tempo, difere do tempo real.
  Converta com `TempoMap.real(t)` e `reference(atReal:)`. Posições de amostra são sempre **segundos reais × taxa de amostragem**.
- Velocidade da faixa `c`: `rate = master / c.bpm` (com `tempoSync`). Sob um mapa de tempo, `c.rate(tempo.bpm(at: t))`.
- Os trechos do original que uma faixa toca vêm de `playSegments()` (com loops e saltos). `elapsed` está em segundos do original.

### Passos
- Um passo a cada **limite de 512 frames**, contado desde o início da mixagem. Se uma faixa começa no meio de um passo, o passo é dividido ali (`nextChunk`).
- No instante central `t` de cada passo, `Automation.state(clips, i, t, master)` é avaliado e aplicado a todas as vozes.
- A voz de cada faixa começa **exatamente** no frame inicial dela (no Mac, vozes que entravam no meio e se deslocavam na unidade de stretch deram trabalho por muito tempo).
  Depois do fim, continua por `tail = 8` segundos para as caudas de eco e reverb.

### Dentro de uma voz (Chain)
1. **Leitura** (`ClipSchedule.ranges` / `BufferFeeder`): lê trecho a trecho.
   **Fade-in de 3 ms** no começo do primeiro trecho. Se a próxima faixa for um `cut`, **fade-out de 5 ms** no fim.
   Freio / backspin (`OutroFX`) substitui o final pelo resultado de `TurntableFX.render` (portado como está).
2. **Stretch / afinação**: signalsmith-stretch. `stretchRate` (exatamente 1 vira 1,00002 para sempre processar).
   Com key lock OFF (vinil), transpor `pitchCents`; mudança de tom ±6 semitons.
   Para cada bloco de saída `inN = round(outN × rate)` (o resto é levado adiante: erro acumulado zero).
   A latência (5292 amostras entre entrada e saída a 44,1 k) é **cancelada exatamente**, por ex. posicionando com a entrada anterior à posição inicial quando a voz começa e descartando saída.
   Teste: passar um trem de cliques; os cliques na saída devem estar em `(posição de entrada − posição inicial) / rate` com ±1 amostra.
3. **EQ** (`DJEQ.configure`): shelf grave 180 Hz / peaking 1 kHz, largura 2 oitavas / shelf agudo 4,5 kHz.
   Ganhos `state.low/mid/high` (dB; kill −40 dB, MID −24 dB). Biquads equivalentes ao AVAudioUnitEQ da Apple.
4. **DJ FX**: `FXKernel` (filtro, phaser, flanger, bitcrusher, gate, roll) trabalha por amostra, então é **portado como está**.
5. **Eco**: como o AVAudioUnitDelay (atraso = tempo × 0,75 (eco de saída) ou `echoDiv`, realimentação 55% (30 + 30 × quantidade como FX),
   passa-baixas 7 kHz, wet/dry). No eco de saída, `send` vai a 0 depois de 1 tempo e só sobra a cauda.
6. **Reverb**: como o largeHall2 do AVAudioUnitReverb (algo próximo, como Freeverb). wet = 55% × quantidade.
7. **Fader**: `state.volume` (ganho × correção de loudness × envelope).

- **Stems** (etapa 3): as leituras de vocal e acompanhamento são misturadas antes do stretch (`stemMix`).
- **Prévia**: a mesma sessão renderiza 0,25 s à frente no Worker e alimenta o AudioWorklet.
  Mudanças só de níveis, EQ, FX e curvas vão para a sessão em andamento (`update`). As que movem sons (muda `structureKey`) a reconstroem a partir da posição atual.
  A agulha vem dos "frames que o Worklet realmente emitiu", interpolados na tela para ficar suave (`smoothPlayhead` no Mac).
- **Exportação**: WAV 24 bits e M4A (AAC 256 kbps), 44,1 k / 48 k. A normalização leva o pico a −1 dBFS (no máximo ×4, `OfflineRenderer.normalizeGain`). A primeira passada mede o pico e a segunda grava (basta uma se o pico da forma de onda da mixagem estiver disponível). O tempo restante só é estimado quando começa a fase estável.

## 4. O formato `.djaw` (lido e gravado por Mac e Windows)

```
"DJAWPACK"            8 bytes
version               UInt32 LE (=1)
jsonLength            UInt64 LE
JSON                  ProjectFile (chaves ordenadas, datas ISO 8601)
arquivos de áudio     os bytes dos arquivos originais concatenados como estão (media[].offset é relativo ao fim do JSON)
```
- Se não começar com `DJAWPACK`, é JSON simples (formato antigo, salvamento automático).
- `ProjectFile`: `format:"DJAW-Mix"`, `version:2`, `masterBPM`, `gridOffset`, `snap`, `clips`, `library`, `media`, `analyses`,
  `profiles`, `customTransitions`, `loudnessMode`, `ui`, `projectID`, `notes` etc. (fim de `Models.swift`).
- `clips[].url` é uma URL como `file:///Users/...` (caminho do Mac). Ordem de resolução ao abrir: áudio embutido (`mediaID` → pasta de extração) → `relativePath` (relativo ao .djaw) → `url` → senão, "arquivo não encontrado" para religar.
  Caminhos do Windows são salvos como `file:///C:/...`.
- Onde o áudio embutido é extraído: Mac `~/Library/Application Support/DJAW/Media/<projectID>/<mediaID>-<nome original>`, Windows `%APPDATA%/DJAW/Media/<projectID>/`.
- `analyses`: impressão → análise do app de Mac (plist binário comprimido com LZFSE). O Windows não precisa lê-lo (reanalisa), mas
  **o mantém intacto ao salvar**, para que ao abrir no Mac não seja preciso reanalisar. A análise do Windows vai em outra chave (por ex. `analysesWin`).
- Exemplo real: o `hyperflip.djaw` do usuário (cerca de 400 MB, 9 faixas embutidas, 5 na mixagem + 4 na biblioteca, masterBPM 107, mudanças de tempo, faixas personalizadas).

## 5. Correspondência Swift → TypeScript

| Swift | Linhas | Função | Etapa | Notas |
|---|---:|---|:-:|---|
| Model/Models.swift | 1301 | clipes, curvas, faixas, takes, paleta, ProjectFile | 1 | copiar os cálculos como estão |
| Model/TempoFX.swift | 399 | mapa de tempo, definições de FX | 1 | |
| Model/Automation.swift | 260 | volume, EQ, FX e stems em cada instante; pontos de troca | 1 | comum à reprodução e à exportação |
| Model/Localization.swift | 43 | troca japonês / inglês | 1 | |
| Model/PerformanceGuide.swift | 454 | guia de como tocar, lista de faixas | 2 | |
| Model/AutoMixer.swift | 857 | planejamento da mixagem automática | 2 | |
| Audio/AudioAnalyzer.swift | 503 | carregamento, forma de onda, BPM, tempo forte, energia por banda | 1 | |
| Audio/StructureAnalyzer.swift | 517 | estrutura (intro / build / drop…), tom | 1 | base da mixagem automática e dos guias |
| Audio/NeuralAnalyzer.swift | 603 | Beat This! (tempos), CUE-DETR (cues sugeridos) | 1/2 | precisa de ONNX |
| Audio/GenreAnalyzer.swift | 487 | gênero (EffNet), presença de vocal | 2 | ONNX disponível |
| Audio/LoudnessAnalyzer.swift | 134 | LUFS (BS.1770) | 1 | |
| Audio/AnalysisCache.swift | 169 | impressão, cache de análise | 1 | |
| Audio/AnalysisProgress.swift | 216 | progresso da análise, tempo restante | 1 | |
| Audio/PlaybackEngine.swift | 662 | Chain, ClipSchedule, BufferFeeder | 1 | trocar as partes de AVFoundation por DSP próprio |
| Audio/MixRenderSession.swift | 299 | a renderização da mixagem | 1 | |
| Audio/StreamingPlayback.swift | 185 | prévia | 1 | Worker + AudioWorklet |
| Audio/OfflineRenderer.swift | 301 | exportação, forma de onda da mixagem (renderização parcial) | 1 | |
| Audio/DJFX.swift | 464 | FXKernel, freio / backspin | 1 | portar como está |
| Audio/StretchCalibration.swift | 118 | correção de deriva do AVAudioUnitTimePitch | — | **desnecessário** (signalsmith recebe o número de entradas direto) |
| Audio/TransitionCheck.swift | 187 | verificação renderizada das transições automáticas | 2 | |
| Audio/StemSeparator.swift | 231 | separação de vocal com Spleeter | 3 | precisa de ONNX |
| Audio/MusicLibrary.swift | 97 | biblioteca do Música.app | 2 | lê o XML da biblioteca do iTunes / Música (`src/core/musicLibrary.ts`) |
| Store/MixStore.swift | 3352 | estado, edições, layout, reprodução, salvamento, exportação | 1(+2) | as partes de mixagem automática na etapa 2 |
| Store/MixStore+Locks.swift | 83 | bloqueio de transições | 1 | |
| Store/MixStore+Loudness.swift | 55 | igualar loudness | 1 | |
| Store/MixStore+MixWaveform.swift | 267 | forma de onda da mixagem (redesenho parcial, completo em repouso) | 1 | |
| Store/MixStore+Simplify.swift | 169 | simplificar transições | 1 | |
| Store/MixStore+Takes.swift | 92 | takes de transição | 1 | |
| Store/MixStore+Profiles.swift | 105 | info da faixa, capa | 2 | |
| Store/MixStore+Stems.swift | 49 | preparar stems | 3 | |
| Store/ProjectContainer.swift | 136 | formato .djaw | 1 | |
| Store/DebugHarness.swift | 514 | comandos de teste automáticos para desenvolvimento | — | no Windows, substituídos por testes em Node |
| Timeline/TimelineNSView.swift | 1655 | linha do tempo (faixas A/B, régua de compassos, faixas de transição, arrastar, forma de onda da mixagem, seguir a agulha) | 1 | Canvas; desenhar só o visível, redesenhar só a agulha |
| Timeline/TimelineHost.swift | 50 | | 1 | |
| Views/InspectorView.swift | 2452 | painel direito (transição, decks, FX, mixer, takes, uso da faixa) | 1 | |
| Views/TransitionEditorView.swift | 836 | editor de transições (desenho das faixas, audição pela régua) | 1 | |
| Views/CueEditorView.swift | 891 | editor CUE (audição solo, IN/OUT, ajuste da grade) | 1 | |
| Views/DeckPanel.swift | 593 | toca-discos e mixer | 1 | girar suave com um relógio interpolado |
| Views/SidebarView.swift | 347 | ordem da mixagem, biblioteca | 1 | |
| Views/TransportViews.swift | 156 | botão de tocar, tempo, BPM | 1 | |
| Views/ExportSheet.swift | 179 | exportação | 1 (áudio) / 3 (vídeo) | |
| Views/ShortcutsView.swift | 116 | lista de atalhos | 1 | ler ⌘ como Ctrl |
| Views/AnalysisProgressView.swift | 48 | progresso da análise | 1 | |
| Views/Theme.swift | 108 | cores, formatação (Fmt) | 1 | |
| Views/AutoArrangeSheet.swift | 340 | organização automática | 2 | |
| Views/PerformanceGuideView.swift | 162 | guia de como tocar, lista de faixas | 2 | |
| Views/TrackProfileSheet.swift | 164 | editar info da faixa | 2 | |
| Views/MusicLibrarySheet.swift | 313 | Música.app | 2 | escolher um arquivo se não houver XML |
| Views/VisualPreviewView.swift | 84 | prévia dos visuais | 3 | |
| Media/TrackProfiles.swift | 123 | guardar perfis de faixas | 2 | |
| Media/VideoExporter.swift | 445 | exportação de vídeo | 3 | |
| Media/VisualPainter.swift | 583 | desenho dos visuais, VJ automático | 3 | Canvas/WebGL |
| MyApp.swift / ContentView.swift | | menus, layout geral | 1 | |

## 6. Modelos de ML (precisam de ONNX)

Licenças em `mac/DJAW/ML/ThirdPartyNotices.txt`. As matrizes de pré-processamento (`*_fbank_*.f32`, `*_melfb_*.f32`) e os rótulos estão em `mac/DJAW/ML/`.
Os originais estão em `~/Downloads` no Mac do usuário (peça que ele os copie para o Windows quando precisar; as permissões são pedidas no início).

| Modelo | Original (Mac ~/Downloads) | Forma no Windows |
|---|---|---|
| Beat This! (tempos, tempos fortes; MIT) | `final0.ckpt` (81 MB, PyTorch) | carregar com o código oficial do `beat_this` e exportar para ONNX. Pré-processamento `beatthis_fbank_513x128.f32`. Inferência com onnxruntime-node |
| CUE-DETR (cues sugeridos; MIT) | `model.safetensors` (166 MB, DETR do HF transformers) | carregar com transformers e exportar para ONNX. Pré-processamento `cuedetr_melfb_128x1025.f32` |
| Discogs-EffNet (gênero; CC BY-NC-SA) | `DJAW_genre_models/discogs-effnet-bsdynamic-1.onnx`, cabeça `genre_discogs400-...pb`, `DJAW_heads/*.onnx` | o modelo base e 4 cabeças servem como ONNX. A cabeça genre400: .pb → ONNX (tf2onnx), ou extrair os pesos e fazer o cálculo matricial |
| Spleeter 2stems (MIT) | no app de Mac, reconstruído em PyTorch e convertido em Core ML (bate com o TF com erro relativo de 8e-6) | converter para ONNX do mesmo jeito. STFT 4096/1024, 1024 bins × 512 frames, acompanhamento = original − vocal |

A inferência roda no analysis.child (processo filho que executa o Electron como Node), porque **o onnxruntime-node não funciona num Web Worker do renderer** (carregá-lo derruba o renderer inteiro). Copie exatamente o pré-processamento do Mac (`NeuralAnalyzer.swift`, `GenreAnalyzer.swift`, `StemSeparator.swift`).

## 7. Armadilhas e histórico (o que o app de Mac ensinou)

- **Exportação e prévia iguais**: no começo o Mac tinha um caminho em tempo real separado para a prévia, e as entradas das faixas se deslocavam em relação à exportação.
  No fim: "renderizar a prévia com a mesma sessão da exportação e tocá-la". O app de Windows faz assim desde o início.
- **Latência e deriva de velocidade da unidade de stretch**: vozes que entravam no meio chegavam atrasadas / adiantadas, e a diferença entre a velocidade definida e a real fazia os tempos derivarem (0,23 ms/s).
  Usando o signalsmith diretamente, nenhum dos dois acontece em princípio, mas confira sempre com testes.
- **Cortes** (`updateCutNudges`): as linhas de compasso podem estar a 10–40 ms do ataque (bumbo / caixa).
  A faixa que sai para logo antes do próximo ataque, a que entra começa logo antes do próprio ataque (detectado com um envelope de 2 ms, `BandEnergies.onsetOffset`).
  Só 5 ms de sobreposição: fade-out de 5 ms na que sai, fade-in de 3 ms na que entra.
- **Quando a automação é avaliada**: os limites dos passos contam desde o início da mixagem (os mesmos instantes mesmo tocando do meio).
- **Níveis logo antes de um início**: para uma faixa que começa em menos de 0,25 s, o valor logo após o início é definido antes (para não perder o começo de um corte).
- **Forma de onda da mixagem**: faixas muito altas clipam o tempo todo e só os picos viram uma faixa vermelha → desenhar pico + núcleo RMS.
  Redesenhar só o trecho alterado com 10 s de pré-rolagem e reaproveitar o resto deslocado no tempo. Depois de 20 s sem edições, redesenhar tudo com exatidão.
- **Peso da linha do tempo**: ficava lenta com muitas faixas → desenhar só o visível, durante a reprodução invalidar só a faixa da agulha, cachear o mapa de tempo etc. por revisão.
- **Cores**: faixas vizinhas separadas por pelo menos 0,15 de matiz (`separateNeighbourColors`).
- **Sem carregamento duplicado**: julgado pelo caminho (normalizado) e pela impressão. Uma faixa solta na linha do tempo que já está na biblioteca é movida de lá para a mixagem.
- **Toca-discos**: um timer de 60 Hz contra o relógio de áudio dava trancos → desenhar a cada quadro com um relógio interpolado (corrige 15% do erro a cada vez, ressincroniza acima de 50 ms).
- **VJ automático**: trocava rápido demais → trocar por frases de 8 compassos, no começo dos drops, mantendo cada visual por pelo menos 2 frases.
- **Tempo restante da exportação**: as primeiras estimativas não eram confiáveis → estimar só pelo avanço na fase estável, arredondado para 5 s / 10 s.

## 8. Dados de teste

Em `~/Downloads` do Mac do usuário (peça uma cópia se precisar):
- `hyperflip.djaw` (mixagem do app de Mac, áudio embutido), `hyperflip.wav` (a exportação dela)
- `DJAW_pv_export*.wav` (exportações usadas para comparar prévia e exportação)
- Faixas: `chance-FINAL.wav`, `TURN OFF THE LIGHTS REMIX FINISHED!!!.wav`, `you dont need to fall.mp3`, `01 welcome.wav` e outras

## 9. Novidades da 0.4.0

- **Onde começa uma mudança de tempo** (`Clip.tempoStart`): `'afterTransition'` (depois da transição; o padrão ao criar uma mudança de tempo), `'mixIn'` ou não definido (junto com a transição; mixagens da 0.3 e anteriores), ou um número (compassos depois que a faixa entra).
  A mudança começa em `timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c))` e chega ao próximo BPM em `tempoRampBars(c)` compassos (`Clip.tempoBars`, ou a duração da transição se não definido).
- **Faixas sobrepostas** (`ProjectFile.layers`, `Clip.layerOf`, `layerBar`, `layerParts`): presas a um compasso de uma faixa da mixagem (a anfitriã) e tocadas por cima.
  As posições vêm de `placeLayers` em `core/layers.ts`; a atribuição aos decks C / D, de `layerDecks` (no máximo 2 ao mesmo tempo).
  A renderização cria uma RenderSession de uma faixa só para cada sobreposta e as soma em `renderNext()` (`nextChunk` é o mínimo de todas as sessões).
  Quando `layerParts` é `vocals` / `instrumental`, usam-se stems e `Automation.state` zera a outra parte.
- **Sair de um loop mixando** (`Clip.outPass`): quando a faixa anterior está em loop, em qual volta acontece a transição. Aplicado no layout via `elapsedOfSourcePass`.
- **Idiomas**: tabelas com o texto em inglês de `L(ja, en)` como chave (`src/core/locales/<lang>.json`). Nas chamadas cujo inglês é um template, `scripts/i18n.mjs` acrescenta a chave e os valores na compilação.
  Textos salvos, como as notas da mixagem automática, são criados com `captureLanguages()`, que guarda marcadores para todos os idiomas, e `localize()` os mostra no idioma atual.
  Extrair chaves: `node scripts/i18n.mjs extract`; juntar traduções: `node scripts/i18n-merge.mjs` (`_parts/c<N>_*.json`, 200 por parte).
- **Tamanho dos arquivos**: o áudio embutido sem compressão (WAV, AIFF) é guardado em FLAC (`core/flac.ts`, preditores fixos + codificação Rice, idêntico bit a bit ao original). MP3 e similares ficam como estão.
