// Port of mac/DJAW/Audio/NeuralAnalyzer.swift (Beat This! part; CUE-DETR comes with stage 2).
// The ONNX model takes |STFT| / √1024 frames (1, T, 513) and returns beat / downbeat logits (1, T);
// the mel filterbank and log1p(1000·x) are inside the model (tools/models/export_beatthis.py).
import { Mathx } from '../models';
import { stft } from './fft';

export interface CueHint { time: number; score: number }

export interface NeuralGrid {
  bpm: number;
  firstBeat: number;
  /** 0…1: how well one steady tempo explains the detected beats (low = tempo changes inside the track). */
  coherence: number;
  downbeatConfidence: number;
}
export const tempoVaries = (g: NeuralGrid) => g.coherence < 0.6;

export interface NeuralResult {
  version: number;
  beats: number[];
  downbeats: number[];
  grid: NeuralGrid | null;
  cues: CueHint[];
}

export const NEURAL_VERSION = 2;

/** Runs the Beat This! model on one chunk. */
export type BeatModel = (mag: Float32Array, frames: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>;

/** Resamples mono audio with a windowed-sinc filter (high quality, like AVAudioConverter's .high). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = to / from;
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);
  const cutoff = Math.min(1, ratio) * 0.95;
  const half = 32;
  const width = half / Math.min(1, ratio);
  // Kaiser window (β = 8) table.
  const I0 = (v: number) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (v / (2 * k)) ** 2; s += t; } return s; };
  const beta = 8, i0b = I0(beta);
  const TAB = 4096;
  const win = new Float32Array(TAB + 1);
  for (let i = 0; i <= TAB; i++) { const r = i / TAB; win[i] = I0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b; }
  const weights = (c: number) => {
    const a = Math.ceil(c - width), b = Math.floor(c + width);
    const w = new Float32Array(b - a + 1);
    let wsum = 0;
    for (let j = a; j <= b; j++) {
      const d = j - c;
      const r = Math.abs(d) / width;
      if (r >= 1) continue;
      const arg = Math.PI * d * cutoff;
      const sinc = arg === 0 ? 1 : Math.sin(arg) / arg;
      const v = sinc * win[Math.round(r * TAB)];
      w[j - a] = v;
      wsum += v;
    }
    if (wsum > 0) for (let k = 0; k < w.length; k++) w[k] /= wsum;
    return { a, w };
  };
  // Rational ratios (44.1 ↔ 22.05 / 48 kHz): the filter only has `L` different phases, so compute them once.
  const gcd = (u: number, v: number): number => (v ? gcd(v, u % v) : u);
  const g = Number.isInteger(from) && Number.isInteger(to) ? gcd(from, to) : 0;
  const L = g ? to / g : 0, M = g ? from / g : 0;
  if (L > 0 && L <= 4096) {
    const phases = Array.from({ length: L }, (_, k) => weights((k * M % L) / L));
    for (let i = 0; i < n; i++) {
      const base = Math.floor(i * M / L);
      const { a, w } = phases[i % L];
      const j0 = base + a;
      let s = 0;
      if (j0 >= 0 && j0 + w.length <= x.length) {
        for (let k = 0; k < w.length; k++) s += x[j0 + k] * w[k];
      } else {
        for (let k = 0; k < w.length; k++) { const j = j0 + k; if (j >= 0 && j < x.length) s += x[j] * w[k]; }
      }
      out[i] = s;
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const { a, w } = weights(i / ratio);
    let s = 0;
    for (let k = 0; k < w.length; k++) { const j = a + k; if (j >= 0 && j < x.length) s += x[j] * w[k]; }
    out[i] = s;
  }
  return out;
}

export async function beatThis(y: Float32Array, model: BeatModel, progress?: (p: number) => void) {
  const spec = stft(y, 1024, 441, true, false);
  if (spec.frames <= 0) return null;
  const scale = 1 / Math.sqrt(1024);
  for (let i = 0; i < spec.data.length; i++) spec.data[i] *= scale;
  const N = spec.frames, T = 1500, border = 6;
  const starts: number[] = [];
  for (let s = -border; s < N - border; s += T - 2 * border) starts.push(s);
  if (N > T - 2 * border && starts.length) starts[starts.length - 1] = N - (T - border);
  const beatL = new Float32Array(N).fill(-1000), downL = new Float32Array(N).fill(-1000);
  const input = new Float32Array(T * 513);
  let done = 0;
  // "keep_first": earlier chunks win, so write the chunks back to front.
  for (const s of [...starts].reverse()) {
    progress?.(done / Math.max(1, starts.length));
    done++;
    input.fill(0);
    for (let t = 0; t < T; t++) {
      const src = s + t;
      if (src < 0 || src >= N) continue;
      input.set(spec.data.subarray(src * 513, src * 513 + 513), t * 513);
    }
    const out = await model(input, T);
    for (let t = border; t < T - border; t++) {
      const dst = s + t;
      if (dst < 0 || dst >= N) continue;
      beatL[dst] = out.beat[t];
      downL[dst] = out.downbeat[t];
    }
  }
  const fps = 50;
  const peaks = (l: Float32Array) => {
    const frames: number[] = [];
    for (let i = 0; i < l.length; i++) {
      if (!(l[i] > 0)) continue;
      let m = -Infinity;
      for (let j = Math.max(0, i - 3); j <= Math.min(l.length - 1, i + 3); j++) if (l[j] > m) m = l[j];
      if (l[i] >= m) frames.push(i);
    }
    const out: number[] = [];
    let i = 0;
    while (i < frames.length) {
      let j = i, sum = frames[i];
      while (j + 1 < frames.length && frames[j + 1] - frames[j] <= 1) { j++; sum += frames[j]; }
      out.push(sum / (j - i + 1) / fps);
      i = j + 1;
    }
    return out;
  };
  const beats = peaks(beatL);
  let downs = peaks(downL);
  if (beats.length) {
    downs = downs.map(d => beats.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a)));
    downs = [...new Set(downs)].sort((a, b) => a - b);
  }
  return { beats, downbeats: downs };
}

const fold = (p: number, lo: number, hi: number) => { while (p < lo) p *= 2; while (p >= hi) p /= 2; return p; };

function hits(ph: number, per: number, pts: number[], tol: number) {
  let n = 0;
  for (const t of pts) { const r = (t - ph) / per; if (Math.abs(r - Math.round(r)) * per < tol) n++; }
  return n;
}
const argmax = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, b) => (f(b) > f(a) ? b : a));

/** Fits one steady tempo and bar line to the detected beats (robust to half / double-time passages). */
export function estimateGrid(b: number[], db: number[], loBPM = 87.5, hiBPM = 180): NeuralGrid | null {
  const iv: number[] = [];
  for (let i = 1; i < b.length; i++) { const d = b[i] - b[i - 1]; if (d > 0.12 && d < 2) iv.push(d); }
  if (iv.length < 8) return null;
  const lo = 60 / 240, hi = 60 / 120;
  const f = iv.map(x => fold(x, lo, hi));
  const binCount = 399;
  const hist = new Array(binCount).fill(0);
  for (const x of f) hist[Math.min(binCount - 1, Math.max(0, Math.trunc((x - lo) / (hi - lo) * binCount)))]++;
  let mode = 0;
  for (let k = 1; k < binCount; k++) if (hist[k] > hist[mode]) mode = k;
  const p0 = lo + (mode + 0.5) * (hi - lo) / binCount;
  const coherence = (p: number): [number, number] => {
    let c = 0, s = 0;
    for (const t of b) { const a = 2 * Math.PI * t / p; c += Math.cos(a); s += Math.sin(a); }
    const n = b.length;
    return [Math.sqrt(c * c + s * s) / n, Math.atan2(s / n, c / n)];
  };
  let best = { coh: 0, p: p0, ang: 0 };
  for (let k = 0; k <= 1200; k++) {
    const p = p0 * (0.97 + 0.06 * k / 1200);
    const [c, a] = coherence(p);
    if (c > best.coh) best = { coh: c, p, ang: a };
  }
  const pc = best.p;
  for (let k = 0; k <= 200; k++) {
    const p = pc * (0.9995 + 0.001 * k / 200);
    const [c, a] = coherence(p);
    if (c > best.coh) best = { coh: c, p, ang: a };
  }
  const pf = best.p;
  const phf = Mathx.posMod(best.ang / (2 * Math.PI) * pf, pf);
  let period = pf;
  while (60 / period > hiBPM) period *= 2;
  while (60 / period < loBPM) period /= 2;
  const m = Math.max(1, Math.round(period / pf));
  const cands = Array.from({ length: m }, (_, k) => Mathx.posMod(phf + k * pf, period));
  const ph = argmax(cands, c => hits(c, period, b, 0.04));
  const bar = 4 * period;
  const scores = [0, 1, 2, 3].map(k => hits(Mathx.posMod(ph + k * period, bar), bar, db, 0.06));
  let j = 0;
  for (let k = 1; k < 4; k++) if (scores[k] > scores[j]) j = k;
  const total = scores.reduce((a, x) => a + x, 0);
  return { bpm: 60 / period, firstBeat: Mathx.posMod(ph + j * period, bar), coherence: best.coh, downbeatConfidence: total > 0 ? scores[j] / total : 0 };
}

/** Share of detected beats a grid lands on (on the faster metrical level so half / double time counts). */
export function beatHitRate(beats: number[], bpm: number, firstBeat: number) {
  if (!beats.length || !(bpm > 1)) return 0;
  const p = fold(60 / bpm, 60 / 240, 60 / 120);
  let n = 0;
  for (const t of beats) { const r = (t - firstBeat) / p; if (Math.abs(r - Math.round(r)) * p < 0.035) n++; }
  return n / beats.length;
}

export interface TempoRegion { start: number; end: number; grid: NeuralGrid }

/** Splits the detected beats into steady-tempo stretches and fits a grid to each one. */
export function tempoRegions(b: number[], db: number[], minBeats = 24): TempoRegion[] {
  if (b.length < minBeats) return [];
  const lo = 60 / 240, hi = 60 / 120;
  const f: number[] = [];
  for (let i = 1; i < b.length; i++) f.push(fold(Math.max(0.12, b[i] - b[i - 1]), lo, hi));
  const n = f.length;
  const local = f.map((_, i) => {
    const w = f.slice(Math.max(0, i - 4), Math.min(n - 1, i + 4) + 1).sort((x, y) => x - y);
    return w[Math.floor(w.length / 2)];
  });
  const groups: [number, number][] = [];
  let s0 = 0, ref = local[0], off = 0;
  for (let i = 1; i < n; i++) {
    off = Math.abs(local[i] / ref - 1) > 0.025 ? off + 1 : 0;
    if (off >= 3) { groups.push([s0, i - 2]); s0 = i - 2; ref = local[i]; off = 0; }
  }
  groups.push([s0, n]);
  const out: TempoRegion[] = [];
  for (const [g0, g1] of groups) {
    const cnt = g1 - g0;
    if (cnt < minBeats) continue;
    const pts = b.slice(g0, g1 + 1);
    const p0 = local.slice(g0, g1).sort((x, y) => x - y)[Math.floor(cnt / 2)];
    const k = new Array(pts.length).fill(0);
    for (let i = 1; i < pts.length; i++) k[i] = k[i - 1] + Math.max(1, Math.round((pts[i] - pts[i - 1]) / p0));
    let use = new Array(pts.length).fill(true);
    let a = pts[0], p = p0;
    for (let it = 0; it < 2; it++) {
      const idx = pts.map((_, i) => i).filter(i => use[i]);
      if (idx.length < 8) break;
      const mk = idx.reduce((s, i) => s + k[i], 0) / idx.length;
      const mt = idx.reduce((s, i) => s + pts[i], 0) / idx.length;
      const sxy = idx.reduce((s, i) => s + (k[i] - mk) * (pts[i] - mt), 0);
      const sxx = idx.reduce((s, i) => s + (k[i] - mk) ** 2, 0);
      if (!(sxx > 0)) break;
      p = sxy / sxx; a = mt - p * mk;
      use = pts.map((t, i) => Math.abs(t - (a + p * k[i])) < 0.1 * p);
    }
    if (!(p > 0.2 && p < 0.55)) continue;
    const t0 = pts[0], t1 = pts[pts.length - 1] + p;
    const inDowns = db.filter(d => d >= t0 - 0.05 && d <= t1);
    let period = p;
    while (60 / period > 180) period *= 2;
    while (60 / period < 87.5) period /= 2;
    const m = Math.max(1, Math.round(period / p));
    const cands = Array.from({ length: m }, (_, q) => Mathx.posMod(a + q * p, period));
    const ph = argmax(cands, c => hits(c, period, pts, 0.04));
    const bar = 4 * period;
    const scores = [0, 1, 2, 3].map(q => hits(Mathx.posMod(ph + q * period, bar), bar, inDowns, 0.06));
    let j = 0;
    for (let q = 1; q < 4; q++) if (scores[q] > scores[j]) j = q;
    const tot = scores.reduce((s, x) => s + x, 0);
    const fit = hits(a, p, pts, 0.035) / pts.length;
    out.push({ start: t0, end: t1, grid: { bpm: 60 / period, firstBeat: Mathx.posMod(ph + j * period, bar), coherence: fit, downbeatConfidence: tot > 0 ? scores[j] / tot : 0 } });
  }
  return out;
}

// MARK: - CUE-DETR

/** Runs CUE-DETR on `batch` images (B × 3 × 128 × 355); returns score (B × 100) and boxes (B × 100 × 4). */
export type CueModel = (pixels: Float32Array, batch: number) => Promise<{ score: Float32Array; boxes: Float32Array }>;

export interface CueAssets {
  model: CueModel;
  /** 128 × 1025 mel filterbank (librosa, row-major). */
  melfb: Float32Array;
  /** viridis colour map, 256 × RGB. */
  lut: Uint8Array;
}

/** Cue points a pro DJ would set (mac NeuralAnalyzer.cueDETR): spectrogram image windows → DETR boxes → peaks. */
export async function cueDETR(y: Float32Array, a: CueAssets, progress?: (p: number) => void): Promise<CueHint[] | null> {
  const spec = stft(y, 2048, 512, false, true);
  const F = spec.frames;
  if (F <= 32) return null;
  const mel = new Float32Array(F * 128);
  for (let f = 0; f < F; f++) {
    const row = spec.data.subarray(f * 1025, f * 1025 + 1025);
    for (let m = 0; m < 128; m++) {
      const fb = a.melfb.subarray(m * 1025, m * 1025 + 1025);
      let s = 0;
      for (let k = 0; k < 1025; k++) s += row[k] * fb[k];
      mel[f * 128 + m] = s;
    }
  }
  let maxM = 1e-10;
  for (let i = 0; i < mel.length; i++) if (mel[i] > maxM) maxM = mel[i];
  const ref = 10 * Math.log10(maxM);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < mel.length; i++) {
    let v = 10 * Math.log10(Math.max(1e-10, mel[i])) - ref;
    v = Math.max(v, -80);
    mel[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = Math.max(hi - lo, 1e-6);
  const img = new Uint8Array(128 * F * 3);
  for (let f = 0; f < F; f++) {
    for (let m = 0; m < 128; m++) {
      const x = (mel[f * 128 + m] - lo) / span;
      const k = Math.min(255, Math.max(0, Math.trunc(x * 256)));
      const o = ((127 - m) * F + f) * 3;
      img[o] = a.lut[k * 3]; img[o + 1] = a.lut[k * 3 + 1]; img[o + 2] = a.lut[k * 3 + 2];
    }
  }
  const W = 355, padding = 266, step = W * 0.25;
  const nWin = Math.floor((F + padding) / step);
  if (nWin <= 0) return null;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const positions: { pos: number; score: number }[] = [];
  const batch = 8;
  for (let w0 = 0; w0 < nWin; w0 += batch) {
    const w1 = Math.min(nWin, w0 + batch);
    const n = w1 - w0;
    const px = new Float32Array(n * 3 * 128 * W);
    const borders: number[] = [];
    for (let i = w0; i < w1; i++) {
      const l = Math.floor(i * step) - padding;
      borders.push(l);
      const base = (i - w0) * 3 * 128 * W;
      const first = Math.max(0, l), last = Math.min(F - 1, l + W - 1);
      const leftPad = Math.max(0, -l);
      const inside = Math.min(F, l + W) - Math.max(0, l);
      const rightPad = W - leftPad - inside;
      for (let row = 0; row < 128; row++) {
        for (let c = 0; c < 3; c++) {
          const leftEdge = img[(row * F + first) * 3 + c], rightEdge = img[(row * F + last) * 3 + c];
          const o = base + (c * 128 + row) * W;
          for (let x = 0; x < W; x++) {
            let v: number;
            if (x < leftPad) v = Math.floor(leftEdge * x / leftPad);
            else if (x < leftPad + inside) v = img[(row * F + (l + x)) * 3 + c];
            else { const j = x - leftPad - inside + 1; v = Math.floor(rightEdge * (rightPad - j) / rightPad); }
            px[o + x] = (v / 255 - mean[c]) / std[c];
          }
        }
      }
    }
    const out = await a.model(px, n);
    progress?.(w1 / nWin);
    for (let k = 0; k < n; k++) {
      for (let q = 0; q < 100; q++) {
        const cx = out.boxes[(k * 100 + q) * 4], w = out.boxes[(k * 100 + q) * 4 + 2];
        const x0 = (cx - 0.5 * w) * W, x1 = (cx + 0.5 * w) * W;
        positions.push({ pos: Math.floor((x0 + x1) / 2) + borders[k], score: out.score[k * 100 + q] });
      }
    }
  }
  positions.sort((p, q) => (p.pos !== q.pos ? p.pos - q.pos : p.score - q.score));
  let smin = Infinity, smax = -Infinity;
  for (const p of positions) { if (p.score < smin) smin = p.score; if (p.score > smax) smax = p.score; }
  const sc = positions.map(p => (p.score - smin) / Math.max(smax - smin, 1e-9));
  return findPeaks(sc, 0.9, 16).map(k => ({ time: positions[k].pos * 512 / 22050, score: sc[k] })).filter(c => c.time >= 0);
}

/** scipy.signal.find_peaks(x, height, distance) for the parts CUE-DETR uses. */
export function findPeaks(x: number[], height: number, distance: number): number[] {
  let peaks: number[] = [];
  let i = 1;
  while (i < x.length - 1) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < x.length - 1 && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        peaks.push(Math.trunc((i + ahead - 1) / 2));
        i = ahead;
      }
    }
    i++;
  }
  peaks = peaks.filter(p => x[p] >= height);
  if (distance <= 1 || peaks.length <= 1) return peaks;
  const keep = new Array(peaks.length).fill(true);
  const order = peaks.map((_, k) => k).sort((p, q) => x[peaks[p]] - x[peaks[q]] || p - q);
  for (const idx of order.reverse()) {
    if (!keep[idx]) continue;
    for (let k = idx - 1; k >= 0 && peaks[idx] - peaks[k] < distance; k--) keep[k] = false;
    for (let k = idx + 1; k < peaks.length && peaks[k] - peaks[idx] < distance; k++) keep[k] = false;
  }
  return peaks.filter((_, k) => keep[k]);
}

/** Neighbouring windows can report the same cue twice: keep the stronger one within half a bar. */
export function mergeCues(cues: CueHint[], grid: NeuralGrid | null): CueHint[] {
  const minGap = grid ? 120 / grid.bpm : 1;
  const merged: CueHint[] = [];
  for (const c of [...cues].sort((p, q) => p.time - q.time)) {
    const last = merged[merged.length - 1];
    if (last && c.time - last.time < minGap) { if (c.score > last.score) merged[merged.length - 1] = c; }
    else merged.push(c);
  }
  return merged;
}
