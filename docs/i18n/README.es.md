# DJAW

[日本語](../../README.md) | [English](README.en.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md) | [한국어](README.ko.md) | **Español** | [Français](README.fr.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [Português](README.pt.md) | [Русский](README.ru.md)

Un editor de mezclas DJ al estilo DAW (no en tiempo real). Unes pistas con guías compás a compás, dibujas los movimientos de fader, EQ, FX y voces, y exportas la mezcla. Funciona en Windows y Mac (Apple silicon).

- `src/` — la app para Windows / Mac (Electron + TypeScript)
- `mac/` — la versión anterior para macOS (SwiftUI), la referencia original del comportamiento
- Detalles de diseño → [`docs/PORTING.md`](PORTING.es.md) (traducciones en `docs/i18n/`)

Para uso personal (algunos modelos incluidos tienen licencias no comerciales).

## Instalación

Desde [Releases](https://github.com/WVYYYVW/DJAW/releases):
- **Windows**: `DJAW-Setup-x.y.z.exe`
- **Mac (Apple silicon)**: `DJAW-x.y.z-mac-arm64.dmg`

Una vez instalado, DJAW se actualiza solo a las nuevas versiones al arrancar.

## Ejecutar desde el código

Necesitas [Node.js](https://nodejs.org/) 22 o posterior (LTS) y Git.

```bat
git clone https://github.com/WVYYYVW/DJAW.git
cd DJAW
npm install
npm start
```

- `npm start` … compila y luego abre la app (para desarrollo).
- `npm run dist` … crea el instalador (`dist/`).
- `npm test` … pruebas del motor de render (no suena nada).

Los análisis y las cachés de audio se guardan en `%APPDATA%\DJAW` (`~/Library/Application Support/DJAW` en Mac).

## Idiomas

日本語, English, 简体中文, 繁體中文, 한국어, Español, Français, Deutsch, Italiano, Português, Русский.
DJAW arranca en el idioma del sistema; cámbialo en el menú Idioma.

## Pantalla

Parecida a Ableton Live.
- Arriba: nombre del archivo, transporte, tiempo, BPM y ajuste (centrados en la ventana), visuales, guía para tocar, exportar
- Izquierda: el navegador (orden de la mezcla y biblioteca). Arrastra para cambiar su ancho y el reparto entre ambos. La biblioteca tiene carpetas, búsqueda, ordenación (nombre, BPM, tonalidad, mejor combinación con la pista seleccionada…, para todas las pistas o una carpeta) y reordenación arrastrando
- Centro: el arreglo (decks A / B, decks C / D para pistas superpuestas, MIX, sampler; el carril del sampler se puede ocultar)
- Abajo: el panel de detalles (Ctrl+Alt+I) con pestañas: Vista general, Mezcla, Pista, Transición, CUE, Bucle, FX, Sampler, Decks. Maximízalo con Ctrl+Alt+F. En pantalla completa 16:9 el editor de transiciones cabe sin desplazarse

## Funciones

- Añadir y analizar pistas: BPM, primeros tiempos (Beat This!), estructura (intro, drop… también en el editor CUE), tonalidad, sonoridad, género (EffNet), cues sugeridos por IA (CUE-DETR). Importación desde la biblioteca de iTunes / Música
- Edición en la línea de tiempo: dónde y cuánto se solapan las pistas, cortes, bucles / saltos, FX
- **Cambios de tempo**: cambia el BPM durante la mezcla. Elige dónde empieza el cambio (tras la transición, con ella…) y en cuántos compases (p. ej. devolver una pista a −7,5 % al 0,0 % en 8 compases)
- **Pistas superpuestas (4 decks)**: toca una pista entera encima de otra (decks C / D), si quieres solo las voces o solo el instrumental. Los decks y el mezclador muestran 4 canales
- **Salir de un bucle mezclando**: elige en qué vuelta del bucle entra la siguiente pista
- Editor de transiciones: dibuja líneas de fader, EQ, filtro, eco, reverb y voces / batería / bajo / melodía. Preajustes, tomas y tus propias transiciones guardadas
- Mezcla automática (patrones, candidatos, comprobación renderizada), orden automático (también el orden), guía para tocar y lista de pistas para SoundCloud
- Separación de stems: voces, batería, bajo, melodía (Spleeter 4stems)
- Sampler: 8 pads (teclas Q–I), colocados en los tiempos (grabación, rolls, nivel). Los sonidos incluidos (bocina, sirena dub, risers, impactos, bombo gabber…) están sintetizados para DJAW y son libres para usar en mezclas, directos y publicaciones
- Exportación: WAV (24 bits) / M4A (AAC 256 kbps), 44,1 / 48 kHz, MP4 con visuales (VJ automático), vista previa de visuales en vivo (Ctrl+Alt+V)
- Guardado: un solo archivo `.djaw` con el audio (las pistas sin comprimir, como WAV, se guardan en FLAC sin pérdida, la mitad de tamaño aprox. y el mismo sonido). La última mezcla se abre al arrancar

La vista previa usa el mismo motor que la exportación: lo que oyes es exactamente lo que se escribe.

Licencias de los modelos: `models/ThirdPartyNotices.txt` (EffNet no es comercial).
