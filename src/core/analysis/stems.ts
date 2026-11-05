// Vocal / instrumental separation (mac/DJAW/Audio/StemSeparator.swift): Deezer's Spleeter 2-stems network
// (MIT License, models/vocalsplit.onnx) estimates a vocal mask on a 4096-point spectrogram; the vocals are the
// masked spectrum and the instrumental is the track minus the vocals, so both together give back the original.
// Runs in the analysis child process; the stems are float WAVs next to the analysis cache.
import fs from 'node:fs';
import path from 'node:path';
import { L } from '../i18n';
import { AudioSource } from '../render/source';
import { WavWriter } from '../render/wav';
import { fft } from './fft';
import type { VocalModel } from './beatmodel';

export const STEM_VERSION = 1;
const N = 4096, HOP = 1024, BINS = 1024, BLOCK = 512;

export function stemFiles(dir: string, fingerprint: string) {
  return {
    vocals: path.join(dir, `${fingerprint}.v${STEM_VERSION}.vocals.wav`),
    instrumental: path.join(dir, `${fingerprint}.v${STEM_VERSION}.inst.wav`),
  };
}

export interface StemStats { maskMean: number; maskNaN: number; vocalsDB: number; instrumentalDB: number }

export async function separateStems(src: AudioSource, model: VocalModel, out: { vocals: string; instrumental: string },
  progress?: (p: number) => void, cancelled?: () => boolean): Promise<StemStats> {
  const frames = src.frames;
  if (!(frames > 0)) throw new Error(L('曲を読めません', 'Cannot read the track'));
  // Two channels, padded with one frame of silence at the start and end.
  const padded = frames + 2 * N;
  const x = [new Float32Array(padded), new Float32Array(padded)];
  {
    const piece = 1 << 18;
    const l = new Float32Array(piece), r = new Float32Array(piece);
    for (let p = 0; p < frames; p += piece) {
      const n = Math.min(piece, frames - p);
      src.read(p, n, l, r);
      x[0].set(l.subarray(0, n), N + p);
      x[1].set(r.subarray(0, n), N + p);
    }
  }
  const nFrames = Math.floor((padded - N) / HOP) + 1;
  const vocals = [new Float32Array(padded), new Float32Array(padded)];
  const wsum = new Float32Array(padded);
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);   // periodic Hann
  for (let k = 0; k < nFrames; k++) for (let i = 0; i < N; i++) wsum[k * HOP + i] += window[i] * window[i];

  const half = N / 2;
  let maskSum = 0, maskN = 0, maskNaN = 0;
  // Spectra of one block, per channel (bins 0 … half-1).
  const re = [new Float64Array(BLOCK * half), new Float64Array(BLOCK * half)];
  const im = [new Float64Array(BLOCK * half), new Float64Array(BLOCK * half)];
  const fr = new Float64Array(N), fi = new Float64Array(N);
  const input = new Float32Array(2 * BLOCK * BINS);
  const blocks = Math.ceil(nFrames / BLOCK);
  for (let b = 0; b < blocks; b++) {
    if (cancelled?.()) throw new Error('cancelled');
    const f0 = b * BLOCK;
    const count = Math.min(BLOCK, nFrames - f0);
    input.fill(0);
    for (let c = 0; c < 2; c++) {
      for (let t = 0; t < count; t++) {
        const start = (f0 + t) * HOP;
        for (let i = 0; i < N; i++) { fr[i] = x[c][start + i] * window[i]; fi[i] = 0; }
        fft(fr, fi);
        const o = t * half;
        for (let f = 0; f < half; f++) { re[c][o + f] = fr[f]; im[c][o + f] = fi[f]; }
        const base = (c * BLOCK + t) * BINS;
        input[base] = Math.abs(fr[0]);
        for (let f = 1; f < BINS; f++) input[base + f] = Math.hypot(fr[f], fi[f]);
      }
    }
    const mask = await model(input);
    for (let t = 0; t < count; t += 8) for (let f = 0; f < BINS; f += 16) {
      const m = mask[t * BINS + f];
      if (Number.isNaN(m)) maskNaN++; else { maskSum += m; maskN++; }
    }
    for (let c = 0; c < 2; c++) {
      for (let t = 0; t < count; t++) {
        const o = t * half;
        // Masked spectrum (conjugate-symmetric): bins above the model's range (≈ 11 kHz) stay with the instrumental.
        fr.fill(0); fi.fill(0);
        for (let f = 0; f < BINS; f++) {
          const m = mask[(c * BLOCK + t) * BINS + f];
          const a = re[c][o + f] * m, q = f === 0 ? 0 : im[c][o + f] * m;
          fr[f] = a; fi[f] = -q;            // conj for the inverse via the forward transform
          if (f > 0) { fr[N - f] = a; fi[N - f] = q; }
        }
        fft(fr, fi);
        const start = (f0 + t) * HOP;
        for (let i = 0; i < N; i++) vocals[c][start + i] += (fr[i] / N) * window[i];
      }
    }
    progress?.((b + 1) / blocks);
  }

  // Overlap-add normalisation, cut back to the track's length, then the instrumental = track − vocals.
  const vo = [new Float32Array(frames), new Float32Array(frames)];
  const io = [new Float32Array(frames), new Float32Array(frames)];
  let eo = 0, ev = 0, ei = 0;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < frames; i++) {
      const w = wsum[N + i];
      const v = w > 1e-6 ? vocals[c][N + i] / w : 0;
      const s = x[c][N + i];
      vo[c][i] = v;
      io[c][i] = s - v;
      if ((i & 3) === 0) { eo += s * s; ev += v * v; ei += (s - v) * (s - v); }
    }
  }
  const db = (e: number) => 10 * Math.log10(Math.max(e, 1e-20) / Math.max(eo, 1e-20));
  const stats: StemStats = { maskMean: maskN > 0 ? maskSum / maskN : -1, maskNaN, vocalsDB: db(ev), instrumentalDB: db(ei) };
  // Sanity check: the vocals must be a part of the track, not all of it (or noise).
  if (maskNaN > 0 || !Number.isFinite(ev) || db(ev) > -0.5) {
    throw new Error(L('ボーカルの分離結果がおかしいため使いません', 'The vocal separation came out wrong, so it is not used'));
  }
  // Written to temporary names first, so a half-written stem is never used.
  fs.mkdirSync(path.dirname(out.vocals), { recursive: true });
  const tmp = (p: string) => path.join(path.dirname(p), 'writing-' + path.basename(p));
  const write = (file: string, ch: Float32Array[]) => {
    const w = new WavWriter(tmp(file), src.sampleRate, 32);
    const piece = 1 << 16;
    for (let i = 0; i < frames; i += piece) {
      const n = Math.min(piece, frames - i);
      w.write(ch[0].subarray(i, i + n), ch[1].subarray(i, i + n), n);
    }
    w.close();
  };
  write(out.vocals, vo);
  write(out.instrumental, io);
  for (const f of [out.vocals, out.instrumental]) { try { fs.rmSync(f, { force: true }); } catch { /* none */ } fs.renameSync(tmp(f), f); }
  return stats;
}
