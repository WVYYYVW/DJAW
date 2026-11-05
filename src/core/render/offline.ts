// Export and the mix waveform (mac/DJAW/Audio/OfflineRenderer.swift), on the same RenderSession as the preview.
import { Clip, clipEnd } from '../models';
import { TempoMap } from '../tempo';
import { RenderSession, SessionOptions } from './session';
import { WavBits, WavWriter } from './wav';

export class CancelFlag {
  cancelled = false;
  cancel() { this.cancelled = true; }
}

export class Cancelled extends Error {
  constructor() { super('cancelled'); }
}

export interface MixInput {
  clips: Clip[];
  master: number;
  tempo: TempoMap;
  gridOffset: number;
  sampleRate: number;
  open: SessionOptions['open'];
  pool: SessionOptions['pool'];
}

/** Gain that brings the loudest sample to −1 dBFS (at most +12 dB). */
export const normalizeGain = (peak: number) => (peak > 0.0001 ? Math.min(Math.pow(10, -1 / 20) / peak, 4) : 1);

export const mixEndReal = (m: MixInput) => m.tempo.real(Math.max(0, ...m.clips.map(c => clipEnd(c, m.master))));

const tick = () => new Promise<void>(r => setImmediate(r));

/** Renders the mix once from the start; returns the peak (after gain). */
async function pass(m: MixInput, gain: number, cancel: CancelFlag, progress: (p: number) => void,
  sink: (L: Float32Array, R: Float32Array, n: number, frame0: number) => void, clamp: boolean): Promise<number> {
  const session = await RenderSession.create({ ...m });
  try {
    const total = Math.round((mixEndReal(m) + 0.3) * m.sampleRate);
    let peak = 0, last = -1, steps = 0;
    while (session.renderedFrames < total) {
      if (cancel.cancelled) throw new Cancelled();
      const f0 = session.absoluteFrame;
      const n = Math.min(session.renderNext(), total - (f0 - session.startFrame));
      const { L, R } = session;
      for (let i = 0; i < n; i++) {
        let l = L[i] * gain, r = R[i] * gain;
        if (clamp) { l = Math.max(-1, Math.min(1, l)); r = Math.max(-1, Math.min(1, r)); }
        L[i] = l; R[i] = r;
        const a = Math.max(Math.abs(l), Math.abs(r));
        if (a > peak) peak = a;
      }
      sink(L, R, n, f0);
      const p = session.renderedFrames / total;
      if (p - last >= 0.005) { progress(p); last = p; }
      if (++steps % 64 === 0) await tick();
    }
    return peak;
  } finally {
    session.stop();
  }
}

export interface ExportOptions { sampleRate: number; normalize: boolean; bits: WavBits }

/** Writes the mix as a WAV. Normalizing renders twice (peak first) unless the peak is already known. */
export async function exportWav(m: MixInput, dest: string, o: ExportOptions, cancel: CancelFlag,
  progress: (p: number) => void, knownPeak?: number | null): Promise<void> {
  if (!(mixEndReal(m) > 0)) throw new Error('no tracks');
  let gain = 1;
  if (o.normalize && knownPeak != null) gain = normalizeGain(knownPeak);
  else if (o.normalize) gain = normalizeGain(await pass(m, 1, cancel, p => progress(p * 0.5), () => {}, false));
  const w = new WavWriter(dest, m.sampleRate, o.bits);
  try {
    const base = o.normalize ? 0.5 : 0, span = o.normalize ? 0.5 : 1;
    await pass(m, gain, cancel, p => progress(base + p * span), (L, R, n) => w.write(L, R, n), true);
  } finally {
    w.close();
  }
  progress(1);
}

/** The mix waveform exactly as an export renders it: min / max / RMS per bin, before gain and clipping. */
export interface MixPeaks {
  sampleRate: number;
  binsPerSecond: number;
  mins: Float32Array;
  maxs: Float32Array;
  rms: Float32Array;
  /** Real (heard) seconds rendered so far. */
  rendered: number;
  peak: number;
}

export async function renderPeaks(m: MixInput, cancel: CancelFlag, update: (p: MixPeaks) => void, binsPerSecond = 200): Promise<MixPeaks> {
  const sr = m.sampleRate;
  const end = mixEndReal(m);
  if (!(end > 0)) throw new Error('no tracks');
  const binFrames = Math.max(1, Math.round(sr / binsPerSecond));
  const total = Math.round((end + 0.3) * sr);
  const nBins = Math.floor(total / binFrames) + 1;
  const acc: MixPeaks = {
    sampleRate: sr, binsPerSecond: sr / binFrames,
    mins: new Float32Array(nBins), maxs: new Float32Array(nBins), rms: new Float32Array(nBins), rendered: 0, peak: 0,
  };
  const sq = new Float64Array(nBins);
  let frame = 0, lastUpdate = Date.now();
  acc.peak = await pass(m, 1, cancel, () => {}, (L, R, n) => {
    for (let i = 0; i < n; i++) {
      const b = Math.floor((frame + i) / binFrames);
      if (b >= nBins) break;
      const l = L[i], r = R[i];
      if (l < acc.mins[b]) acc.mins[b] = l;
      if (r < acc.mins[b]) acc.mins[b] = r;
      if (l > acc.maxs[b]) acc.maxs[b] = l;
      if (r > acc.maxs[b]) acc.maxs[b] = r;
      sq[b] += l * l + r * r;
    }
    const firstOpen = Math.floor((frame + n) / binFrames);
    for (let b = Math.floor(frame / binFrames); b < Math.min(firstOpen, nBins); b++) acc.rms[b] = Math.sqrt(sq[b] / (binFrames * 2));
    frame += n;
    acc.rendered = frame / sr;
    if (Date.now() - lastUpdate > 500) { lastUpdate = Date.now(); update(acc); }
  }, false);
  acc.rendered = frame / sr;
  const last = Math.floor(frame / binFrames);
  if (last < nBins) {
    const filled = frame - last * binFrames;
    if (filled > 0) acc.rms[last] = Math.sqrt(sq[last] / (filled * 2));
  }
  return acc;
}

export interface PeakRange { firstBin: number; mins: Float32Array; maxs: Float32Array; rms: Float32Array }

/**
 * Peaks of one stretch of the mix (real seconds a…b) on the same bins as `renderPeaks`, so they can replace that
 * stretch of an earlier render. Starts `preroll` seconds early so tracks already playing have settled.
 */
export async function renderPeakRange(m: MixInput, binsPerSecond: number, a: number, b: number, cancel: CancelFlag, preroll = 10): Promise<PeakRange> {
  const sr = m.sampleRate;
  const binFrames = Math.max(1, Math.round(sr / binsPerSecond));
  const firstBin = Math.max(0, Math.floor(a * sr / binFrames));
  const lastBin = Math.max(firstBin, Math.ceil(b * sr / binFrames));
  const n = lastBin - firstBin + 1;
  const out: PeakRange = { firstBin, mins: new Float32Array(n), maxs: new Float32Array(n), rms: new Float32Array(n) };
  const sq = new Float64Array(n), count = new Int32Array(n);
  const startReal = Math.max(0, firstBin * binFrames / sr - preroll);
  const session = await RenderSession.create({ ...m, from: m.tempo.referenceAtReal(startReal) });
  try {
    const endFrame = (lastBin + 1) * binFrames;
    let steps = 0;
    while (session.absoluteFrame < endFrame) {
      if (cancel.cancelled) throw new Cancelled();
      const f0 = session.absoluteFrame;
      const len = session.renderNext();
      const { L, R } = session;
      for (let i = 0; i < len; i++) {
        const k = Math.floor((f0 + i) / binFrames) - firstBin;
        if (k < 0) continue;
        if (k >= n) break;
        const l = L[i], r = R[i];
        if (l < out.mins[k]) out.mins[k] = l;
        if (r < out.mins[k]) out.mins[k] = r;
        if (l > out.maxs[k]) out.maxs[k] = l;
        if (r > out.maxs[k]) out.maxs[k] = r;
        sq[k] += l * l + r * r;
        count[k] += 2;
      }
      if (++steps % 64 === 0) await tick();
    }
  } finally {
    session.stop();
  }
  for (let k = 0; k < n; k++) if (count[k] > 0) out.rms[k] = Math.sqrt(sq[k] / count[k]);
  return out;
}
