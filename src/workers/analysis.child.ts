// Analysis process: a child Node process (Electron run as Node), because onnxruntime-node cannot run inside a
// renderer Web Worker. One message at a time: track analysis (waveform, tempo, Beat This! grid, structure),
// loudness, stem separation (in a second process of its own) and resampling WAV / AIFF files that are not at 44.1 kHz.
import fs from 'node:fs';
import path from 'node:path';
import { openPcmFile } from '../core/render/source';
import { analyzeAudio } from '../core/analysis/analyzer';
import { StemModel, loadBeatModel, loadCueModel, loadGenreModel, loadStemModel } from '../core/analysis/beatmodel';
import { separateStems } from '../core/analysis/stems';
import { CueAssets } from '../core/analysis/neural';
import { GenreAssets } from '../core/analysis/genreModel';
import { BeatModel, resample } from '../core/analysis/neural';
import { loudnessSegments } from '../core/analysis/loudness';
import { WavWriter } from '../core/render/wav';

let model: Promise<BeatModel | null> | null = null;
let cueModel: Promise<CueAssets | null> | null = null;
let genreModel: Promise<GenreAssets | null> | null = null;
let stemModel: Promise<StemModel | null> | null = null;
const send = (m: unknown) => { if (process.connected) process.send!(m); };

async function handle(m: any) {
  if (m.type === 'analyze') {
    if (!model) model = loadBeatModel(m.modelPath).catch(e => { send({ type: 'log', message: `beat model: ${e?.message ?? e}` }); return null; });
    const dir = path.dirname(m.modelPath);
    if (!cueModel) cueModel = loadCueModel(dir);
    if (!genreModel) genreModel = loadGenreModel(dir);
    const src = openPcmFile(m.pcm);
    if (!src) throw new Error('unreadable');
    try {
      const a = await analyzeAudio(src, {
        beatModel: m.neural === false ? null : await model,
        cues: m.neural === false ? null : await cueModel,
        genre: m.neural === false ? null : await genreModel,
        progress: (stage, f) => send({ type: 'progress', id: m.id, stage, fraction: f }),
      });
      send({ type: 'done', id: m.id, analysis: a });
    } finally {
      src.close();
    }
  } else if (m.type === 'stems') {
    if (!stemModel) stemModel = loadStemModel(m.modelDir);
    const vm = await stemModel;
    if (!vm) throw new Error('stem model unavailable');
    const src = openPcmFile(m.pcm);
    if (!src) throw new Error('unreadable');
    try {
      const stats = await separateStems(src, vm, m.files,
        p => send({ type: 'progress', id: m.id, stage: 'stems', fraction: p }));
      send({ type: 'done', id: m.id, stats });
    } finally {
      src.close();
    }
  } else if (m.type === 'loudness') {
    const src = openPcmFile(m.pcm);
    if (!src) throw new Error('unreadable');
    try { send({ type: 'done', id: m.id, segments: loudnessSegments(src) }); } finally { src.close(); }
  } else if (m.type === 'resample') {
    const pcm = openPcmFile(m.file);
    if (!pcm) throw new Error('unreadable');
    const n = pcm.frames;
    const l = new Float32Array(n), r = new Float32Array(n);
    pcm.read(0, n, l, r);
    pcm.close();
    const L = resample(l, pcm.sampleRate, m.rate), R = resample(r, pcm.sampleRate, m.rate);
    fs.mkdirSync(path.dirname(m.dest), { recursive: true });
    const w = new WavWriter(m.dest, m.rate, 16);
    const block = 1 << 16;
    for (let i = 0; i < L.length; i += block) {
      const k = Math.min(block, L.length - i);
      w.write(L.subarray(i, i + k), R.subarray(i, i + k), k);
    }
    w.close();
    send({ type: 'done', id: m.id });
  }
}

let chain: Promise<unknown> = Promise.resolve();
// Tells the app the process is up (it gives up on a process that never says so).
send({ type: 'ready' });
process.on('message', (m: any) => {
  chain = chain.then(() => handle(m)).catch(err => send({ type: 'error', id: m.id, message: (err as Error)?.message ?? String(err) }));
});
process.on('disconnect', () => process.exit(0));
