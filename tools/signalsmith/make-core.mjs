// Makes `stretch-core.mjs` from the npm package `signalsmith-stretch` (MIT): the raw Emscripten module
// (WASM embedded) without the AudioWorklet wrapper, so the time-stretch can be driven directly — sample-exact —
// from a Worker or from Node (export, preview rendering, tests).
//
//   npm i signalsmith-stretch@1.3.2
//   node tools/signalsmith/make-core.mjs node_modules/signalsmith-stretch/SignalsmithStretch.mjs src/vendor/stretch-core.mjs
//
// Checked on 2026-11-05 with 1.3.2 in Node 22: _presetDefault(2, 44100) → input/output latency 2646/2646 samples,
// a 440 Hz sine processed at rate 0.9 comes out at 439.9 Hz (pitch kept), level unchanged (see test-node.mjs).
import fs from 'node:fs';
import path from 'node:path';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node make-core.mjs <SignalsmithStretch.mjs> <out.mjs>');
  process.exit(1);
}
const s = fs.readFileSync(src, 'utf8');
const marker = "if (typeof exports === 'object' && typeof module === 'object')\n  module.exports = SignalsmithStretch;";
const i = s.indexOf(marker);
if (i < 0) throw new Error('layout of SignalsmithStretch.mjs changed: marker not found');
let core = s.slice(0, i).replace('let module = {}, exports = {};', '');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, core + '\nexport default SignalsmithStretch;\n');
console.log('wrote', dst);
