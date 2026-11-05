// Drives the raw Signalsmith Stretch WASM directly: pitch-preserving tempo change with an exact number of input
// samples per output block (this is how the render engine should use it — no AudioWorklet, no timing guesswork).
//   node tools/signalsmith/test-node.mjs path/to/stretch-core.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const core = process.argv[2] ?? 'src/vendor/stretch-core.mjs';
const { default: Factory } = await import(pathToFileURL(path.resolve(core)).href);
const m = await Factory();
m._main?.();
const ch = 2, sr = 44100;
m._presetDefault(ch, sr);
console.log('latency in/out', m._inputLatency(), m._outputLatency(), 'block', m._blockSamples(), 'interval', m._intervalSamples());
const len = 8192;                       // per-channel buffer length (≥ the largest block in or out)
const ptr = m._setBuffers(ch, len);     // layout: in ch0, in ch1, out ch0, out ch1 (each len floats)
m._setTransposeSemitones(0, 8000 / sr);

let phase = 0;
const out = [];
const rate = 0.9;
for (let b = 0; b < 200; b++) {
  const outN = 512, inN = Math.round(512 * rate);
  for (let c = 0; c < ch; c++) {
    const a = new Float32Array(m.HEAP8.buffer, ptr + len * 4 * c, inN);
    for (let i = 0; i < inN; i++) a[i] = Math.sin(phase + i * 2 * Math.PI * 440 / sr) * 0.5;
  }
  phase += inN * 2 * Math.PI * 440 / sr;
  m._process(inN, outN);
  const o = new Float32Array(m.HEAP8.buffer, ptr + len * 4 * ch, outN);
  out.push(...o);
}
const seg = out.slice(50000, 90000);
let z = 0;
for (let i = 1; i < seg.length; i++) if (seg[i - 1] < 0 && seg[i] >= 0) z++;
console.log('frequency', (z / (seg.length / sr)).toFixed(2), 'Hz (expect ~440)',
  'rms', Math.sqrt(seg.reduce((a, b) => a + b * b, 0) / seg.length).toFixed(4), '(expect ~0.354)');
