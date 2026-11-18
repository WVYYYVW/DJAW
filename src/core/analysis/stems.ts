// Stem separation into vocals, drums, bass and melody: Deezer's Spleeter 4-stems networks (MIT License,
// models/stem_*.onnx, one per stem) estimate each stem's magnitude on a 4096-point spectrogram; Spleeter's ratio
// masks (yᵢ² + ε/4) / (Σ yⱼ² + ε) split the track's spectrum among them. Vocals, drums and bass are the masked
// spectra; melody ("other") is the track minus those three, so the four always add up to the original exactly
// (including everything above the networks' 11 kHz range).
// Runs in the stems child process. Streams: every block of 512 frames is separated, and the samples no later
// frame overlaps are written out, so memory stays small for long tracks.
import fs from 'node:fs';
import path from 'node:path';
import { L } from '../i18n';
import { AudioSource } from '../render/source';
import { WavWriter } from '../render/wav';
import { fft } from './fft';
import type { StemModel } from './beatmodel';

export const STEM_VERSION = 2;
export const STEM_NAMES = ['vocals', 'drums', 'bass', 'melody'] as const;
export type StemName = typeof STEM_NAMES[number];
export type StemFiles = Record<StemName, string>;

const N = 4096, HOP = 1024, BINS = 1024, BLOCK = 512, HALF = N / 2;
/** Above the networks' range, each stem keeps its average share of the top bins. */
const TOP_FROM = 768;

export function stemFiles(dir: string, fingerprint: string): StemFiles {
  const f = (s: StemName) => path.join(dir, `${fingerprint}.v${STEM_VERSION}.${s}.wav`);
  return { vocals: f('vocals'), drums: f('drums'), bass: f('bass'), melody: f('melody') };
}

export interface StemStats { db: Record<StemName, number>; seconds: number }

export async function separateStems(src: AudioSource, model: StemModel, out: StemFiles,
  progress?: (p: number) => void, cancelled?: () => boolean): Promise<StemStats> {
  const t0 = Date.now();
  const frames = src.frames;
  if (!(frames > 0)) throw new Error(L('曲を読めません', 'Cannot read the track'));
  // Frames run over the track padded with N samples of silence on both sides (padded index p = sample p − N).
  const padded = frames + 2 * N;
  const nFrames = Math.floor((padded - N) / HOP) + 1;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);   // periodic Hann
  const w2 = win.map(v => v * v);
  /** Σ w² of the frames covering padded index p (overlap-add normalisation). */
  const wsum = (p: number) => {
    let s = 0;
    for (let k = Math.max(0, Math.ceil((p - N + 1) / HOP)); k <= Math.min(nFrames - 1, Math.floor(p / HOP)); k++) s += w2[p - k * HOP];
    return s;
  };

  fs.mkdirSync(path.dirname(out.vocals), { recursive: true });
  const tmp = (p: string) => path.join(path.dirname(p), 'writing-' + path.basename(p));
  const writers = STEM_NAMES.map(s => new WavWriter(tmp(out[s]), src.sampleRate, 32));
  const energy = new Float64Array(5);    // vocals, drums, bass, melody, original

  // Accumulators for vocals / drums / bass (channel-major), covering padded indices [accStart, accStart + ACC).
  const ACC = BLOCK * HOP + N;
  const acc = [0, 1, 2].map(() => [new Float32Array(ACC), new Float32Array(ACC)]);
  let accStart = 0;
  let written = 0;   // padded index up to which the output is written

  const readPadded = (from: number, n: number) => {
    const l = new Float32Array(n), r = new Float32Array(n);
    const a = Math.max(from, N), b = Math.min(from + n, N + frames);
    if (b > a) {
      const tl = new Float32Array(b - a), tr = new Float32Array(b - a);
      src.read(a - N, b - a, tl, tr);
      l.set(tl, a - from); r.set(tr, a - from);
    }
    return [l, r];
  };

  /** Writes padded [written, upTo) — final, no later frame reaches it — and moves the accumulators along. */
  const flush = (upTo: number) => {
    const a = Math.max(written, N), b = Math.min(upTo, N + frames);
    if (b > a) {
      const n = b - a;
      const [xl, xr] = readPadded(a, n);
      const st = [0, 1, 2, 3].map(() => [new Float32Array(n), new Float32Array(n)]);
      for (let i = 0; i < n; i++) {
        const p = a + i, w = wsum(p), inv = w > 1e-6 ? 1 / w : 0;
        for (let c = 0; c < 2; c++) {
          const x = c === 0 ? xl[i] : xr[i];
          let rest = x;
          for (let s = 0; s < 3; s++) {
            const v = acc[s][c][p - accStart] * inv;
            st[s][c][i] = v;
            rest -= v;
            if ((i & 3) === 0) energy[s] += v * v;
          }
          st[3][c][i] = rest;
          if ((i & 3) === 0) { energy[3] += rest * rest; energy[4] += x * x; }
        }
      }
      for (let s = 0; s < 4; s++) writers[s].write(st[s][0], st[s][1], n);
    }
    written = Math.max(written, upTo);
    // Drop what is written.
    const drop = upTo - accStart;
    if (drop > 0) {
      for (const sc of acc) for (const ch of sc) { ch.copyWithin(0, drop); ch.fill(0, ACC - drop); }
      accStart = upTo;
    }
  };

  const re = [new Float64Array(BLOCK * HALF), new Float64Array(BLOCK * HALF)];
  const im = [new Float64Array(BLOCK * HALF), new Float64Array(BLOCK * HALF)];
  const fr = new Float64Array(N), fi = new Float64Array(N);
  const input = new Float32Array(2 * BLOCK * BINS);
  const masks = [0, 1, 2].map(() => new Float32Array(2 * BLOCK * HALF));
  const blocks = Math.ceil(nFrames / BLOCK);
  let nan = 0;
  try {
    for (let b = 0; b < blocks; b++) {
      if (cancelled?.()) throw new Error('cancelled');
      const f0 = b * BLOCK;
      const count = Math.min(BLOCK, nFrames - f0);
      const [bl, br] = readPadded(f0 * HOP, (count - 1) * HOP + N);
      input.fill(0);
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? bl : br;
        for (let t = 0; t < count; t++) {
          const s0 = t * HOP;
          for (let i = 0; i < N; i++) { fr[i] = x[s0 + i] * win[i]; fi[i] = 0; }
          fft(fr, fi);
          const o = t * HALF;
          for (let f = 0; f < HALF; f++) { re[c][o + f] = fr[f]; im[c][o + f] = fi[f]; }
          const base = (c * BLOCK + t) * BINS;
          input[base] = Math.abs(fr[0]);
          for (let f = 1; f < BINS; f++) input[base + f] = Math.hypot(fr[f], fi[f]);
        }
      }
      const est = await model(input);   // [vocals, drums, bass, other], each [2, 512, 1024]
      // Ratio masks for vocals / drums / bass (melody is the remainder), extended above the networks' range.
      for (let c = 0; c < 2; c++) {
        for (let t = 0; t < count; t++) {
          const eb = (c * BLOCK + t) * BINS, mb = (c * BLOCK + t) * HALF;
          const top = [0, 0, 0];
          for (let f = 0; f < BINS; f++) {
            const y0 = est[0][eb + f], y1 = est[1][eb + f], y2 = est[2][eb + f], y3 = est[3][eb + f];
            const total = y0 * y0 + y1 * y1 + y2 * y2 + y3 * y3 + 1e-10;
            const m = [(y0 * y0 + 2.5e-11) / total, (y1 * y1 + 2.5e-11) / total, (y2 * y2 + 2.5e-11) / total];
            for (let s = 0; s < 3; s++) {
              if (Number.isNaN(m[s])) { nan++; m[s] = 0; }
              masks[s][mb + f] = m[s];
              if (f >= TOP_FROM) top[s] += m[s];
            }
          }
          for (let s = 0; s < 3; s++) masks[s][mb + BINS] = top[s] / (BINS - TOP_FROM);
        }
      }
      // Inverse transforms of the three masked spectra, overlap-added.
      for (let s = 0; s < 3; s++) {
        for (let c = 0; c < 2; c++) {
          for (let t = 0; t < count; t++) {
            const o = t * HALF, mb = (c * BLOCK + t) * HALF;
            const high = masks[s][mb + BINS];
            fr.fill(0); fi.fill(0);
            for (let f = 0; f <= HALF; f++) {
              const m = f < BINS ? masks[s][mb + f] : high;
              // Nyquist bin (f = HALF) is real; it is not in re / im (bins 0 … HALF−1), so take it as 0.
              const a = f < HALF ? re[c][o + f] * m : 0, q = f === 0 || f >= HALF ? 0 : im[c][o + f] * m;
              fr[f] = a; fi[f] = -q;           // conj, for the inverse via the forward transform
              if (f > 0 && f < HALF) { fr[N - f] = a; fi[N - f] = q; }
            }
            fft(fr, fi);
            const start = (f0 + t) * HOP - accStart;
            const dst = acc[s][c];
            for (let i = 0; i < N; i++) dst[start + i] += (fr[i] / N) * win[i];
          }
        }
      }
      // Everything before the next block's first frame is final.
      flush(Math.min((f0 + count) * HOP, padded));
      progress?.((b + 1) / blocks);
    }
    flush(padded);
  } finally {
    for (const w of writers) w.close();
  }
  const db = (e: number) => 10 * Math.log10(Math.max(e, 1e-20) / Math.max(energy[4], 1e-20));
  const stats: StemStats = {
    db: { vocals: db(energy[0]), drums: db(energy[1]), bass: db(energy[2]), melody: db(energy[3]) },
    seconds: (Date.now() - t0) / 1000,
  };
  // Sanity check: no stem may be louder than the track by much (that would mean the masks went wrong).
  if (nan > 0 || STEM_NAMES.some(s => !Number.isFinite(stats.db[s]) || stats.db[s] > 1)) {
    for (const s of STEM_NAMES) try { fs.rmSync(tmp(out[s]), { force: true }); } catch { /* ignore */ }
    throw new Error(L('ステムの分離結果がおかしいため使いません', 'The stem separation came out wrong, so it is not used'));
  }
  for (const s of STEM_NAMES) { try { fs.rmSync(out[s], { force: true }); } catch { /* none */ } fs.renameSync(tmp(out[s]), out[s]); }
  return stats;
}
