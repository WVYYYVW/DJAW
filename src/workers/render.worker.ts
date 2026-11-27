// Render worker (Web Worker with Node): the preview stream, exports and the mix waveform — all through the same
// RenderSession, so what you hear is what gets exported.
import { Clip } from '../core/models';
import { TempoMap, TempoPoint } from '../core/tempo';
import { openPcmFile } from '../core/render/source';
import { StretchPool } from '../core/render/stretch';
import { RenderSession } from '../core/render/session';
import { CancelFlag, Cancelled, exportWav, renderPeakRange, renderPeaks } from '../core/render/offline';
import { checkTransition } from '../core/render/check';
import { exportVideo } from '../core/render/video';
import type { SamplerInput } from '../core/sampler';
import { STEM_NAMES, StemFiles } from '../core/analysis/stems';
import type { StemSources } from '../core/render/session';
import fs from 'node:fs';
import '../core/locales';
import { encodeFlac, parseWav } from '../core/flac';

const SR = 44100;
const pool = new StretchPool(SR);

export interface MixMessage {
  clips: Clip[];
  /** Layered tracks, placed (core/layers.ts). */
  layers?: Clip[] | null;
  master: number;
  tempo: { reference: number; points: TempoPoint[] };
  gridOffset: number;
  /** Clip url → the file the engine reads (a decoded PCM cache for compressed files). */
  paths: Record<string, string>;
  /** Clip url → its separated stems, for tracks whose transitions use them. */
  stems?: Record<string, StemFiles>;
  /** Sampler plays, and sample id → the file the engine reads. */
  sampler?: { input: SamplerInput; paths: Record<string, string> } | null;
}

/** Sample files the preview can open: new pads loaded while playing are added by 'update'. */
const samplerPaths = new WeakMap<object, Record<string, string>>();
let previewSampler: object | null = null;

const mixInput = (m: MixMessage) => ({
  clips: m.clips, layers: m.layers ?? null, master: m.master, tempo: new TempoMap(m.tempo.reference, m.tempo.points), gridOffset: m.gridOffset,
  sampleRate: SR, pool, open: (c: Clip) => openPcmFile(m.paths[c.url] ?? c.url),
  openStems: (c: Clip) => {
    const f = m.stems?.[c.url];
    if (!f) return null;
    const srcs = STEM_NAMES.map(n => openPcmFile(f[n]));
    if (srcs.every(x => x && x.sampleRate === SR)) return srcs as unknown as StemSources;
    for (const x of srcs) x?.close();
    return null;
  },
  sampler: m.sampler ? {
    input: m.sampler.input,
    open: (id: string) => { const p = (samplerPaths.get(m.sampler!) ?? m.sampler!.paths)[id]; const src = p ? openPcmFile(p) : null; if (src && src.sampleRate !== SR) { src.close(); return null; } return src; },
  } : null,
});

// MARK: Preview

let gen = 0;
let session: RenderSession | null = null;
let port: MessagePort | null = null;
let sent = 0, played = 0;
/** The visuals preview listens to the audio about to be heard (mono, with its mix frame). */
let tap = false;
const AHEAD = 0.3 * SR;

async function startPreview(m: MixMessage & { from: number; gen: number }) {
  stopPreview();
  gen = m.gen;
  const my = gen;
  previewSampler = m.sampler ?? null;
  if (m.sampler) samplerPaths.set(m.sampler, { ...m.sampler.paths });
  const s = await RenderSession.create({ ...mixInput(m), from: m.from });
  if (my !== gen) { s.stop(); return; }
  session = s;
  sent = 0; played = 0;
  pump(my);
}

function pump(my: number) {
  if (my !== gen || !session || !port) return;
  let n = 0;
  // Render in batches of ~23 ms (1024 frames) up to the target.
  while (sent - played < AHEAD && n < 32) {
    const parts: Float32Array[][] = [];
    const f0 = session.absoluteFrame;
    let total = 0;
    while (total < 1024) {
      const k = session.renderNext();
      parts.push([session.L.slice(0, k), session.R.slice(0, k)]);
      total += k;
    }
    const L = new Float32Array(total), R = new Float32Array(total);
    let o = 0;
    for (const [l, r] of parts) { L.set(l, o); R.set(r, o); o += l.length; }
    if (tap) {
      const mono = new Float32Array(total);
      for (let i = 0; i < total; i++) mono[i] = (L[i] + R[i]) * 0.5;
      postMessage({ type: 'tap', gen: my, start: f0, mono }, [mono.buffer]);
    }
    port.postMessage({ type: 'chunk', gen: my, L, R }, [L.buffer, R.buffer]);
    sent += total;
    n++;
  }
  setTimeout(() => pump(my), 4);
}

function stopPreview() {
  gen++;
  session?.stop();
  session = null;
}

// MARK: Jobs

const jobs = new Map<number, CancelFlag>();

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'port':
        port = m.port as MessagePort;
        port.onmessage = ev => { if (ev.data.type === 'played' && ev.data.gen === gen) played = ev.data.played; };
        break;
      case 'play': await startPreview(m); break;
      case 'update':
        if (session && !session.update(m.clips, m.master, m.layers)) postMessage({ type: 'restart' });
        else if (session && m.sampler) {
          if (previewSampler) samplerPaths.set(previewSampler, { ...(samplerPaths.get(previewSampler) ?? {}), ...m.sampler.paths });
          session.updateSampler(m.sampler.input);
        }
        break;
      case 'stop': stopPreview(); break;
      case 'tap': tap = !!m.on; break;
      case 'export': {
        const flag = new CancelFlag();
        jobs.set(m.job, flag);
        let last = 0;
        await exportWav(mixInput(m), m.dest, m.options, flag, p => {
          const now = Date.now();
          if (now - last > 100 || p >= 1) { last = now; postMessage({ type: 'progress', job: m.job, progress: p }); }
        }, m.knownPeak);
        postMessage({ type: 'done', job: m.job });
        break;
      }
      case 'video': {
        const flag = new CancelFlag();
        jobs.set(m.job, flag);
        let last = 0;
        const stats = { audio: 0, features: 0, draw: 0, frame: 0, encodeWait: 0, audioEncode: 0, frames: 0, total: 0, hardware: 0, audioDelay: 0 };
        await exportVideo(mixInput(m), m.dest, m.options, m.tracks, flag, p => {
          const now = Date.now();
          if (now - last > 100 || p >= 1) { last = now; postMessage({ type: 'progress', job: m.job, progress: p }); }
        }, m.knownPeak, stats);
        postMessage({ type: 'done', job: m.job, stats });
        break;
      }
      case 'peaks': {
        const flag = new CancelFlag();
        jobs.set(m.job, flag);
        const res = await renderPeaks(mixInput(m), flag, p => postMessage({ type: 'partial', job: m.job, peaks: p }));
        postMessage({ type: 'done', job: m.job, peaks: res });
        break;
      }
      case 'peakRange': {
        const flag = new CancelFlag();
        jobs.set(m.job, flag);
        const r = await renderPeakRange(mixInput(m), m.binsPerSecond, m.a, m.b, flag);
        postMessage({ type: 'done', job: m.job, range: r });
        break;
      }
      case 'flac': {
        // A WAV for a .djaw: lossless FLAC (null when the WAV is not 16 / 24-bit integer PCM).
        const pcm = parseWav(new Uint8Array(fs.readFileSync(m.src)));
        if (!pcm) { postMessage({ type: 'done', job: m.job, ok: false }); break; }
        const tmp = m.dest + '.part';
        fs.writeFileSync(tmp, encodeFlac(pcm));
        fs.renameSync(tmp, m.dest);
        postMessage({ type: 'done', job: m.job, ok: true });
        break;
      }
      case 'check': {
        const inp = mixInput(m);
        const r = await checkTransition({ ...inp, index: m.index, engineRate: SR });
        postMessage({ type: 'done', job: m.job, result: r });
        break;
      }
      case 'cancel': jobs.get(m.job)?.cancel(); break;
    }
  } catch (err) {
    if (err instanceof Cancelled) postMessage({ type: 'cancelled', job: m.job });
    else postMessage({ type: 'error', job: m.job, message: (err as Error).message ?? String(err) });
  } finally {
    if (m.job != null && m.type !== 'cancel') jobs.delete(m.job);
  }
};
