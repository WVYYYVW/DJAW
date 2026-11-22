# DJAW

[日本語](../../README.md) | [English](README.en.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | **Português** | [Русский](README.ru.md)

Um editor de mixagens de DJ no estilo DAW (não em tempo real). Você junta faixas com guias compasso a compasso, desenha os movimentos de fader, EQ, FX e vocais e exporta a mixagem. Funciona no Windows e no Mac (Apple silicon).

- `src/` — o app para Windows / Mac (Electron + TypeScript)
- `mac/` — o app anterior para macOS (SwiftUI), a referência original do comportamento
- Detalhes de projeto → [`docs/PORTING.md`](PORTING.pt.md) (traduções em `docs/i18n/`)

Para uso pessoal (alguns modelos incluídos têm licenças não comerciais).

## Instalação

Em [Releases](https://github.com/WVYYYVW/DJAW/releases):
- **Windows**: `DJAW-Setup-x.y.z.exe`
- **Mac (Apple silicon)**: `DJAW-x.y.z-mac-arm64.dmg`

Depois de instalado, o DJAW se atualiza sozinho para as novas versões ao abrir.

## Rodar a partir do código

É preciso [Node.js](https://nodejs.org/) 22 ou mais recente (LTS) e Git.

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … compila e abre o app (para desenvolvimento).
- `npm run dist` … cria o instalador (`dist/`).
- `npm test` … testes do motor de renderização (nenhum som é tocado).

As análises e os caches de áudio ficam em `%APPDATA%\DJAW` (`~/Library/Application Support/DJAW` no Mac).

## Idiomas

日本語, English, 简体中文, 繁體中文, 한국어, Español, Français, Deutsch, Italiano, Português, Русский.
O DJAW abre no idioma do sistema; troque pelo menu Idioma.

## Tela

Parecida com o Ableton Live.
- Em cima: nome do arquivo, transporte, tempo, BPM e encaixe (no centro da janela), visuais, guia de como tocar, exportação
- À esquerda: o navegador (ordem da mixagem e biblioteca). Arraste para mudar a largura e a divisão entre os dois. A biblioteca tem pastas, busca, ordenação (nome, BPM, tom, melhor combinação com a faixa selecionada…, para todas as faixas ou uma pasta) e reordenação arrastando
- No centro: o arranjo (decks A / B, decks C / D para faixas sobrepostas, MIX, sampler; a faixa do sampler pode ser ocultada)
- Embaixo: o painel de detalhes (Ctrl+Alt+I) com as abas Visão geral, Mixagem, Faixa, Transição, CUE, Loop, FX, Sampler, Decks. Maximize com Ctrl+Alt+F. Em tela cheia 16:9 o editor de transições cabe sem rolar

## Recursos

- Adicionar e analisar faixas: BPM, tempos fortes (Beat This!), estrutura (intro, drop… também no editor CUE), tom, loudness, gênero (EffNet), cues sugeridos por IA (CUE-DETR). Importação da biblioteca do iTunes / Música
- Edição na linha do tempo: onde e por quanto tempo as faixas se sobrepõem, cortes, loops / saltos, FX
- **Mudanças de tempo**: mude o BPM durante a mixagem. Escolha onde a mudança começa (depois da transição, junto com ela…) e em quantos compassos (ex.: trazer uma faixa de −7,5% de volta a 0,0% em 8 compassos)
- **Faixas sobrepostas (4 decks)**: toque uma faixa inteira por cima de outra (decks C / D), se quiser só os vocais ou só o instrumental. A tela dos decks e o mixer mostram 4 canais
- **Sair de um loop mixando**: escolha em qual volta do loop a próxima faixa entra
- Editor de transições: desenhe linhas de fader, EQ, filtro, eco, reverb e vocais / bateria / baixo / melodia. Presets, takes e suas próprias transições salvas
- Mixagem automática (padrões, candidatos, verificação renderizada), organização automática (inclusive a ordem), guia de como tocar e lista de faixas para o SoundCloud
- Separação de stems: vocais, bateria, baixo, melodia (Spleeter 4stems)
- Sampler: 8 pads (teclas Q–I), colocados nos tempos (gravação, rolls, nível). Os sons embutidos (air horn, sirene dub, risers, impactos, bumbo gabber…) são todos sintetizados para o DJAW e livres para usar em mixagens, sets ao vivo e uploads
- Exportação: WAV (24 bits) / M4A (AAC 256 kbps), 44,1 / 48 kHz, MP4 com visuais (VJ automático), prévia dos visuais ao vivo (Ctrl+Alt+V)
- Salvamento: um único arquivo `.djaw` com o áudio (faixas sem compressão como WAV são guardadas em FLAC sem perdas, cerca de metade do tamanho, mesmo som). A última mixagem reabre ao iniciar

A prévia usa o mesmo motor da exportação: o que você ouve é exatamente o que é gravado.

Licenças dos modelos: `models/ThirdPartyNotices.txt` (EffNet é não comercial).
