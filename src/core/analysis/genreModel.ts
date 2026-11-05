// Genre / vocal analysis with Discogs-EffNet (MTG-UPF, CC BY-NC-SA 4.0) and its classifier heads
// (mac/DJAW/Audio/GenreAnalyzer.swift, inference part). Input: mono 16 kHz.
import { GENRE_VERSION, Genre, GenreResult } from '../genre';
import { fft } from './fft';

/** EffNet: melspectrogram (B × 128 × 96) → activations (B × 400) and embeddings (B × 1280). */
export type EffNet = (mel: Float32Array, batch: number) => Promise<{ activations: Float32Array; embeddings: Float32Array }>;
/** A head: embeddings (B × 1280) → 2 class probabilities (B × 2). */
export type Head = (emb: Float32Array, batch: number) => Promise<Float32Array>;

export interface GenreAssets {
  effnet: EffNet;
  /** [voice_instrumental, mood_party, mood_aggressive, danceability] and the class index that means "yes". */
  heads: { run: Head; positive: number }[];
  /** 96 × 257 mel filterbank (Slaney, unit_tri), row-major. */
  melfb: Float32Array;
  labels: string[];
}

const patchFrames = 128, bands = 96, frameSize = 512, hop = 256, patchHop = 124, maxPatches = 300;

/** Essentia TensorflowInputMusiCNN: symmetric Hann 512, |FFT|², 96 Slaney mel bands, log10(1 + 10000·x). */
export function logMel(y: Float32Array, firstFrame: number, count: number, melfb: Float32Array, dst: Float32Array, offset: number) {
  const n = frameSize, half = n / 2, bins = half + 1;
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  const re = new Float64Array(n), im = new Float64Array(n);
  const power = new Float32Array(bins);
  for (let f = 0; f < count; f++) {
    const s = (firstFrame + f) * hop;
    const o = offset + f * bands;
    if (s + n > y.length) { dst.fill(0, o, o + bands); continue; }
    for (let i = 0; i < n; i++) { re[i] = y[s + i] * window[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < bins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < bands; m++) {
      const fb = melfb.subarray(m * bins, m * bins + bins);
      let v = 0;
      for (let k = 0; k < bins; k++) v += power[k] * fb[k];
      dst[o + m] = Math.log10(1 + 10000 * v);
    }
  }
}

export async function classifyGenre(y: Float32Array, a: GenreAssets, progress?: (p: number) => void): Promise<GenreResult | null> {
  if (a.labels.length !== 400 || y.length <= 16000 * 5) return null;
  const frames = 1 + Math.floor((y.length - frameSize) / hop);
  if (frames < patchFrames) return null;
  const positions: number[] = [];
  for (let s = 0; s <= frames - patchFrames; s += patchHop) positions.push(s);
  const picked = positions.length <= maxPatches ? positions
    : Array.from({ length: maxPatches }, (_, k) => positions[Math.trunc((k + 0.5) * positions.length / maxPatches)]);
  const sum = new Float64Array(400);
  const traitSum = [0, 0, 0, 0];
  const voice: number[] = [], times: number[] = [];
  let used = 0;
  const batch = 16;
  for (let k = 0; k < picked.length; k += batch) {
    const chunk = picked.slice(k, k + batch);
    progress?.(k / Math.max(1, picked.length));
    const mel = new Float32Array(chunk.length * patchFrames * bands);
    chunk.forEach((start, b) => logMel(y, start, patchFrames, a.melfb, mel, b * patchFrames * bands));
    const out = await a.effnet(mel, chunk.length);
    const traits = await Promise.all(a.heads.map(h => h.run(out.embeddings, chunk.length)));
    for (let b = 0; b < chunk.length; b++) {
      for (let j = 0; j < 400; j++) sum[j] += out.activations[b * 400 + j];
      const t = a.heads.map((h, j) => traits[j][b * 2 + h.positive]);
      for (let j = 0; j < 4; j++) traitSum[j] += t[j] ?? 0;
      voice.push(t[0]);
      times.push((chunk[b] * hop + patchFrames * hop / 2) / 16000);
    }
    used += chunk.length;
  }
  if (!used) return null;
  const mean = Array.from(sum, v => v / used);
  const fam: Record<string, number> = {};
  mean.forEach((v, j) => {
    const f = Genre.familyOfDiscogs(a.labels[j]);
    if (f) fam[f] = (fam[f] ?? 0) + v;
  });
  const total = Object.values(fam).reduce((x, y) => x + y, 0);
  if (total > 0) for (const key of Object.keys(fam)) fam[key] /= total;
  const top = mean.map((_, j) => j).sort((p, q) => mean[q] - mean[p]).slice(0, 6).map(j => ({ label: a.labels[j], score: mean[j] }));
  progress?.(1);
  return {
    version: GENRE_VERSION, styles: top, families: fam, tag: null,
    traits: voice.length ? traitSum.map(v => v / voice.length) : null,
    voice: voice.length ? voice : null, voiceTimes: voice.length ? times : null,
  };
}
