# DJAW

[日本語](../../README.md) | [English](README.en.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [한국어](README.ko.md) | [Español](README.es.md) | **Français** | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md)

Un éditeur de mix DJ façon DAW (pas en temps réel). Vous enchaînez les morceaux avec des repères mesure par mesure, dessinez les mouvements de fader, d’EQ, d’effets et de voix, puis exportez le mix. Fonctionne sous Windows et Mac (Apple silicon).

- `src/` — l’application Windows / Mac (Electron + TypeScript)
- `mac/` — l’ancienne version macOS (SwiftUI), la référence d’origine du comportement
- Détails de conception → [`docs/PORTING.md`](PORTING.fr.md) (traductions dans `docs/i18n/`)

Pour un usage personnel (certains modèles fournis ont des licences non commerciales).

## Installation

Depuis les [Releases](https://github.com/WVYYYVW/DJAW/releases) :
- **Windows** : `DJAW-Setup-x.y.z.exe`
- **Mac (Apple silicon)** : `DJAW-x.y.z-mac-arm64.dmg`

Une fois installé, DJAW se met à jour tout seul au démarrage.

## Lancer depuis les sources

Il faut [Node.js](https://nodejs.org/) 22 ou plus récent (LTS) et Git.

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … compile puis lance l’application (développement).
- `npm run dist` … crée l’installeur (`dist/`).
- `npm test` … tests du moteur de rendu (aucun son n’est joué).

Les analyses et caches audio sont dans `%APPDATA%\DJAW` (`~/Library/Application Support/DJAW` sur Mac).

## Langues

日本語, English, 简体中文, 繁體中文, 한국어, Español, Français, Deutsch, Italiano, Português, Русский.
DJAW démarre dans la langue du système ; changez-la dans le menu Langue.

## Écran

Proche d’Ableton Live.
- En haut : nom du fichier, transport, temps, BPM et aimantation (au centre de la fenêtre), visuels, guide de jeu, export
- À gauche : le navigateur (ordre du mix et bibliothèque). Glissez pour changer sa largeur et la répartition entre les deux. La bibliothèque a des dossiers, une recherche, des tris (nom, BPM, tonalité, meilleure compatibilité avec le morceau sélectionné…, pour tous les morceaux ou un dossier) et le réordonnancement par glisser
- Au centre : l’arrangement (platines A / B, platines C / D pour les morceaux superposés, MIX, sampler ; la piste du sampler peut être masquée)
- En bas : le panneau de détails (Ctrl+Alt+I) avec les onglets : Vue d’ensemble, Mix, Morceau, Transition, CUE, Boucle, FX, Sampler, Platines. Agrandissez-le avec Ctrl+Alt+F. En plein écran 16:9, l’éditeur de transition tient sans défilement

## Fonctions

- Ajout et analyse des morceaux : BPM, premiers temps (Beat This!), structure (intro, drop… aussi dans l’éditeur CUE), tonalité, loudness, genre (EffNet), cues suggérés par IA (CUE-DETR). Import depuis la bibliothèque iTunes / Musique
- Édition sur la timeline : où et combien de temps les morceaux se chevauchent, cut-ins, boucles / sauts, effets
- **Changements de tempo** : changez le BPM pendant le mix. Choisissez où le changement commence (après la transition, avec elle…) et sur combien de mesures (ex. ramener un morceau à −7,5 % à 0,0 % en 8 mesures)
- **Morceaux superposés (4 platines)** : jouez un morceau entier par-dessus un autre (platines C / D), éventuellement voix seules ou instrumental seul. Les platines et la table de mixage passent à 4 voies
- **Sortir d’une boucle en mixant** : choisissez à quel passage de la boucle le morceau suivant entre
- Éditeur de transition : dessinez les courbes de fader, EQ, filtre, écho, réverb et voix / batterie / basse / mélodie. Préréglages, prises et vos propres transitions enregistrées
- Mix automatique (modèles, candidats, vérification par rendu), arrangement automatique (ordre compris), guide de jeu et liste des morceaux pour SoundCloud
- Séparation des stems : voix, batterie, basse, mélodie (Spleeter 4stems)
- Sampler : 8 pads (touches Q–I), placés sur les temps (enregistrement, rolls, niveau). Les sons intégrés (corne de brume, sirène dub, risers, impacts, kick gabber…) sont tous synthétisés pour DJAW et libres d’usage dans les mix, lives et mises en ligne
- Export : WAV (24 bits) / M4A (AAC 256 kbit/s), 44,1 / 48 kHz, MP4 avec visuels (VJ automatique), aperçu des visuels en direct (Ctrl+Alt+V)
- Enregistrement : un seul fichier `.djaw` avec l’audio (les morceaux non compressés comme le WAV sont stockés en FLAC sans perte, environ deux fois plus petits, son identique). Le dernier mix se rouvre au démarrage

La lecture d’aperçu utilise le même moteur que l’export : ce que vous entendez est exactement ce qui est écrit.

Licences des modèles : `models/ThirdPartyNotices.txt` (EffNet est non commercial).
