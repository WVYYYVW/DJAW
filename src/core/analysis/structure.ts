// Port of mac/DJAW/Audio/StructureAnalyzer.swift: musical key and track structure (intro / drop / break / outro).
import { L } from '../i18n';
import { Mathx } from '../models';
import { fft } from './fft';

export type SectionKind = 'intro' | 'drop' | 'breakdown' | 'outro';
export const sectionTitle = (k: SectionKind) =>
  ({ intro: L('イントロ', 'Intro'), drop: L('ドロップ', 'Drop'), breakdown: L('ブレイク', 'Break'), outro: L('アウトロ', 'Outro') })[k];

export interface TrackSection { start: number; end: number; kind: SectionKind; bass: number; energy: number }

export interface MusicalKey { pitchClass: number; minor: boolean; confidence: number }

const keyNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const camelotMajor: Record<number, number> = { 0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7 };
const camelotMinor: Record<number, number> = { 9: 8, 4: 9, 11: 10, 6: 11, 1: 12, 8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7 };

export const Key = {
  name: (k: MusicalKey) => keyNames[k.pitchClass] + (k.minor ? 'm' : ''),
  camelotNumber: (k: MusicalKey) => (k.minor ? camelotMinor : camelotMajor)[k.pitchClass] ?? 1,
  camelot: (k: MusicalKey) => `${Key.camelotNumber(k)}${k.minor ? 'A' : 'B'}`,
  shifted: (k: MusicalKey, semitones: number): MusicalKey => ({ ...k, pitchClass: Mathx.posModInt(k.pitchClass + semitones, 12) }),
  /** Same key, ±1 on the Camelot wheel, or the relative major / minor. */
  isCompatible(a: MusicalKey, b: MusicalKey) {
    const x = Key.camelotNumber(a), y = Key.camelotNumber(b);
    const d = Math.min((x - y + 12) % 12, (y - x + 12) % 12);
    return a.minor === b.minor ? d <= 1 : d === 0;
  },
};

export interface CueBar { bar: number; score: number }

export interface TrackStructure {
  bpm: number;
  firstBeat: number;
  barSeconds: number;
  barCount: number;
  phraseOffset: number;
  low: number[];
  full: number[];
  high: number[];
  bass: boolean[];
  musicStart: number;
  musicEnd: number;
  firstDrop: number;
  lastDropEnd: number;
  sections: TrackSection[];
  key: MusicalKey | null;
  downbeatShift: number;
  cueBars: CueBar[];
  gridFit: number[];
}

export const Structure = {
  gridFit(s: TrackStructure, a: number, b: number) {
    if (!s.gridFit.length || b <= a) return 1;
    const lo = Math.max(0, a), hi = Math.min(s.gridFit.length, b);
    if (hi <= lo) return 1;
    let sum = 0, n = 0;
    for (let i = lo; i < hi; i++) { sum += s.gridFit[i] < 0 ? 1 : s.gridFit[i]; n++; }
    return n > 0 ? sum / n : 1;
  },
  cueStrength: (s: TrackStructure, b: number, tolerance = 0.5) =>
    Math.max(0, ...s.cueBars.filter(c => Math.abs(c.bar - b) <= tolerance).map(c => c.score)),
  timeOfBar: (s: TrackStructure, b: number) => s.firstBeat + b * s.barSeconds,
  barAtTime: (s: TrackStructure, t: number) => (t - s.firstBeat) / s.barSeconds,
  hasBass: (s: TrackStructure, b: number) => (b >= 0 && b < s.bass.length ? s.bass[b] : false),
  energy: (s: TrackStructure, b: number) => (b >= 0 && b < s.full.length ? s.full[b] : -60),
  isPhraseStart: (s: TrackStructure, b: number, unit = 8) => Mathx.posModInt(b - s.phraseOffset, unit) === 0,
  sectionAt: (s: TrackStructure, b: number) => s.sections.find(x => b >= x.start && b < x.end) ?? null,
  gridBars(s: TrackStructure, lo: number, hi: number, step: number) {
    if (hi < lo) return [];
    let k = Math.ceil((lo - s.phraseOffset) / step);
    const out: number[] = [];
    while (s.phraseOffset + k * step <= hi) { out.push(s.phraseOffset + k * step); k++; }
    return out;
  },
  summary: (s: TrackStructure) => s.sections.map(x => `${sectionTitle(x.kind)} ${x.start + 1}–${x.end}`).join(' · '),
};

// MARK: - Key detection

/** Streams mono samples, low-passes and decimates them to ~11 kHz, and accumulates a 12-bin pitch-class profile. */
export class ChromaAccumulator {
  private static readonly n = 8192;
  private static readonly hop = 4096;
  private readonly decimation: number;
  private readonly window: Float64Array;
  private readonly bins: { index: number; pc: number; weight: number }[] = [];
  private ring = new Float32Array(ChromaAccumulator.n);
  private filled = 0;
  private sinceLast = 0;
  private phase = 0;
  private chroma = new Float64Array(12);
  private readonly bq: number[];
  private z = [0, 0, 0, 0];
  private re = new Float64Array(ChromaAccumulator.n);
  private im = new Float64Array(ChromaAccumulator.n);

  constructor(sampleRate: number) {
    const n = ChromaAccumulator.n;
    this.decimation = Math.max(1, Math.round(sampleRate / 11025));
    const fs = sampleRate / this.decimation;
    // vDSP_hann_window(HANN_NORM): symmetric-ish normalized Hann.
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
    for (let k = 1; k < n / 2; k++) {
      const f = k * fs / n;
      if (f < 80 || f > 2000) continue;
      const midi = 12 * Math.log2(f / 440) + 69;
      const r = Math.round(midi);
      const d = midi - r;
      this.bins.push({ index: k, pc: Mathx.posModInt(r, 12), weight: Math.pow(Math.cos(Math.PI * d), 2) });
    }
    const fc = Math.min(4000, fs * 0.42);
    const w0 = 2 * Math.PI * fc / sampleRate;
    const alpha = Math.sin(w0) / (2 * 0.70710678);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    this.bq = [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, -2 * cw / a0, (1 - alpha) / a0];
  }

  /** Feeds mono samples at the file's sample rate. */
  process(chunk: Float32Array) {
    if (!chunk.length) return;
    const [b0, b1, b2, a1, a2] = this.bq;
    const filtered = new Float32Array(chunk.length);
    let [z1, z2, y1, y2] = this.z;
    // Two cascaded identical sections (transposed direct form II).
    for (let i = 0; i < chunk.length; i++) {
      const x = chunk[i];
      const u = b0 * x + z1;
      z1 = b1 * x - a1 * u + z2;
      z2 = b2 * x - a2 * u;
      const v = b0 * u + y1;
      y1 = b1 * u - a1 * v + y2;
      y2 = b2 * u - a2 * v;
      filtered[i] = v;
    }
    this.z = [z1, z2, y1, y2];
    const n = ChromaAccumulator.n;
    let i = (this.decimation - this.phase) % this.decimation;
    while (i < filtered.length) {
      this.ring[this.filled % n] = filtered[i];
      this.filled++;
      this.sinceLast++;
      if (this.filled >= n && this.sinceLast >= ChromaAccumulator.hop) {
        this.sinceLast = 0;
        this.analyzeFrame();
      }
      i += this.decimation;
    }
    this.phase = (this.phase + filtered.length) % this.decimation;
  }

  private analyzeFrame() {
    const n = ChromaAccumulator.n;
    const start = this.filled % n;
    for (let i = 0; i < n; i++) { this.re[i] = this.ring[(start + i) % n] * this.window[i]; this.im[i] = 0; }
    fft(this.re, this.im);
    const mags = (k: number) => this.re[k] * this.re[k] + this.im[k] * this.im[k];
    const vec = new Float64Array(12);
    for (const b of this.bins) {
      const k = b.index;
      if (k <= 0 || k >= n / 2 - 1) continue;
      const m = mags(k);
      if (m > mags(k - 1) && m >= mags(k + 1)) vec[b.pc] += m * b.weight;
    }
    const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0));
    if (norm > 0) for (let i = 0; i < 12; i++) this.chroma[i] += vec[i] / norm;
  }

  /** Krumhansl–Schmuckler key estimate. */
  estimateKey(): MusicalKey | null {
    const c = Array.from(this.chroma);
    if (!(c.reduce((a, b) => a + b, 0) > 0)) return null;
    const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const minorP = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const corr = (a: number[], b: number[]) => {
      const ma = a.reduce((x, y) => x + y, 0) / 12, mb = b.reduce((x, y) => x + y, 0) / 12;
      let s = 0, sa = 0, sb = 0;
      for (let i = 0; i < 12; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
      return sa > 0 && sb > 0 ? s / Math.sqrt(sa * sb) : 0;
    };
    let best: MusicalKey | null = null;
    for (let t = 0; t < 12; t++) {
      for (const [profile, minor] of [[major, false], [minorP, true]] as const) {
        const rotated = Array.from({ length: 12 }, (_, i) => profile[Mathx.posModInt(i - t, 12)]);
        const r = corr(c, rotated);
        if (!best || r > best.confidence) best = { pitchClass: t, minor, confidence: r };
      }
    }
    return best;
  }
}

// MARK: - Structure analysis

/** What the neural analysis tells the structure analysis. */
export interface StructureHints {
  gridBPM?: number | null;
  gridFirstBeat?: number | null;
  cues: { time: number; score: number }[];
  beats: number[];
}

interface Bands { low: number; full: number; high: number }
const W = [1.5, 1.0, 0.7];
const sub = (a: Bands, b: Bands): Bands => ({ low: a.low - b.low, full: a.full - b.full, high: a.high - b.high });
const wabs = (b: Bands) => Math.abs(b.low) * W[0] + Math.abs(b.full) * W[1] + Math.abs(b.high) * W[2];
function mean(v: Bands[]): Bands {
  if (!v.length) return { low: 0, full: 0, high: 0 };
  const s = { low: 0, full: 0, high: 0 };
  for (const b of v) { s.low += b.low; s.full += b.full; s.high += b.high; }
  return { low: s.low / v.length, full: s.full / v.length, high: s.high / v.length };
}
const maxOf = (a: number[], lo: number, hi: number) => { let m = -Infinity; for (let i = lo; i <= hi; i++) m = Math.max(m, a[i]); return m; };

function percentile(values: number[], q: number) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < s.length ? s[i] * (1 - f) + s[i + 1] * f : s[i];
}

function gridFitPerBar(beats: number[], fb: number, beat: number, nb: number) {
  if (!beats.length) return [];
  let p = beat;
  while (p > 60 / 120) p /= 2;
  while (p < 60 / 240) p *= 2;
  const hit = new Array(nb).fill(0), tot = new Array(nb).fill(0);
  const barLen = 4 * beat;
  for (const t of beats) {
    const b = Math.floor((t - fb) / barLen);
    if (b < 0 || b >= nb) continue;
    tot[b]++;
    const r = (t - fb) / p;
    if (Math.abs(r - Math.round(r)) * p < 0.035) hit[b]++;
  }
  return Array.from({ length: nb }, (_, i) => (tot[i] === 0 ? -1 : hit[i] / tot[i]));
}

/** Per-hop RMS energies at `fr` frames per second → structure. */
export function analyzeStructure(eLow: Float32Array, eFull: Float32Array, eHigh: Float32Array, fr: number,
  bpm: number, firstBeat: number, duration: number, key: MusicalKey | null, hints?: StructureHints | null): TrackStructure | null {
  const count = Math.min(eLow.length, eFull.length, eHigh.length);
  if (!(bpm > 1) || count <= 0 || !(duration > 20)) return null;
  const beat = 60 / bpm;
  const barLen = 4 * beat;

  const bandDB = (t0: number, t1: number): Bands => {
    const i0 = Math.max(0, Math.trunc(t0 * fr));
    const i1 = Math.min(count, Math.max(i0 + 1, Math.trunc(t1 * fr)));
    if (i1 <= i0) return { low: -120, full: -120, high: -120 };
    let l = 0, f = 0, h = 0;
    for (let i = i0; i < i1; i++) { l += eLow[i] * eLow[i]; f += eFull[i] * eFull[i]; h += eHigh[i] * eHigh[i]; }
    const n = i1 - i0;
    return { low: 10 * Math.log10(l / n + 1e-12), full: 10 * Math.log10(f / n + 1e-12), high: 10 * Math.log10(h / n + 1e-12) };
  };

  // 1) Downbeat check: big changes in the music happen on downbeats.
  let fb = firstBeat;
  let shift = 0;
  const j0 = -Math.floor(fb / beat);
  const nbt = Math.trunc((duration - fb) / beat);
  let trusted = false;
  if (hints?.gridBPM != null && hints.gridFirstBeat != null && Math.abs(hints.gridBPM / bpm - 1) < 0.003) {
    const d = Mathx.posMod(hints.gridFirstBeat - firstBeat, barLen);
    trusted = Math.min(d, barLen - d) < 0.03;
  }
  if (nbt - j0 > 64 && !trusted) {
    const beats: Bands[] = [];
    for (let j = j0; j < nbt; j++) beats.push(bandDB(fb + j * beat, fb + (j + 1) * beat));
    const n = beats.length;
    const nov = new Array(n).fill(0);
    for (let j = 8; j < n - 8; j++) nov[j] = wabs(sub(mean(beats.slice(j, Math.min(n, j + 16))), mean(beats.slice(Math.max(0, j - 16), j))));
    const votes = [0, 0, 0, 0];
    for (let j = 0; j < n; j++) {
      if (!(nov[j] >= 3)) continue;
      const lo = Math.max(0, j - 8), hi = Math.min(n - 1, j + 8);
      if (nov[j] >= maxOf(nov, lo, hi)) votes[Mathx.posModInt(j + j0, 4)] += nov[j];
    }
    const total = votes.reduce((a, b) => a + b, 0);
    let bq = 0;
    for (let k = 1; k < 4; k++) if (votes[k] > votes[bq]) bq = k;
    if (bq !== 0 && votes[bq] > 1.5 * votes[0] && votes[bq] >= 0.3 * total) {
      shift = bq;
      fb += bq * beat;
      while (fb - barLen >= 0) fb -= barLen;
    }
  }

  // 2) Per-bar levels relative to the loud parts.
  const nb = Math.floor((duration - fb) / barLen + 0.5);
  if (nb < 8) return null;
  let bars: Bands[] = [];
  for (let b = 0; b < nb; b++) bars.push(bandDB(fb + b * barLen, fb + (b + 1) * barLen));
  const maxFull = Math.max(...bars.map(b => b.full));
  const musical = bars.filter(b => b.full > maxFull - 40);
  const ref: Bands = {
    low: percentile(musical.map(b => b.low), 0.95),
    full: percentile(musical.map(b => b.full), 0.95),
    high: percentile(musical.map(b => b.high), 0.95),
  };
  bars = bars.map(b => sub(b, ref));

  // Sustained low end per bar: the quieter quarter of the low band's 10 ms levels (a bassline, not just kicks).
  let floor = new Array(nb).fill(-120);
  for (let b = 0; b < nb; b++) {
    const i0 = Math.max(0, Math.trunc((fb + b * barLen) * fr));
    const i1 = Math.min(count, Math.trunc((fb + (b + 1) * barLen) * fr));
    if (i1 <= i0 + 4) continue;
    const q = Array.from(eLow.subarray(i0, i1)).sort((x, y) => x - y);
    floor[b] = 20 * Math.log10(q[Math.floor(q.length / 4)] + 1e-9);
  }
  const floorRef = percentile(floor.filter(v => v > -100), 0.95);
  floor = floor.map(v => v - floorRef);

  // 3) Where the music is.
  let musicStart = bars.findIndex(b => b.full > -25);
  if (musicStart < 0) musicStart = 0;
  let lastLoud = -1;
  for (let i = nb - 1; i >= 0; i--) if (bars[i].full > -20) { lastLoud = i; break; }
  const musicEnd = (lastLoud >= 0 ? lastLoud : nb - 1) + 1;

  // 4) Phrase offset: section changes and fills line up with the 8-bar grid.
  const raw = new Array(nb).fill(0);
  if (musicStart + 2 < musicEnd - 1) {
    for (let i = musicStart + 2; i < musicEnd - 1; i++) {
      const a = mean(bars.slice(Math.max(musicStart, i - 4), i));
      const b = mean(bars.slice(i, Math.min(musicEnd, i + 4)));
      raw[i] = Math.min(24, wabs(sub(b, a)));
    }
  }
  const novelty = new Array(nb).fill(0);
  for (let i = 0; i < nb; i++) {
    if (raw[i] > 0 && raw[i] >= maxOf(raw, Math.max(0, i - 2), Math.min(nb - 1, i + 2))) novelty[i] = raw[i];
  }
  if (Math.max(1, musicStart + 1) < musicEnd - 1) {
    for (let i = Math.max(1, musicStart + 1); i < musicEnd - 1; i++) {
      const neighbour = i >= 2 ? bars[i - 2].low : bars[i].low;
      const dip = Math.min(neighbour, bars[i].low) - bars[i - 1].low;
      if (dip > 5) novelty[i] += Math.min(12, 0.5 * dip);
    }
  }
  const scores = Array.from({ length: 8 }, (_, p) => { let s = 0; for (let i = p; i < nb; i += 8) s += novelty[i]; return s; });
  const cueBars: CueBar[] = [];
  for (const c of hints?.cues ?? []) {
    const b = (c.time - fb) / barLen;
    const r = Math.round(b);
    if (!(Math.abs(b - r) < 0.2 && r >= 0 && r < nb)) continue;
    cueBars.push({ bar: r, score: c.score });
    scores[Mathx.posModInt(r, 8)] += 6 * c.score;
  }
  scores[0] *= 1.05;
  let phase = 0;
  for (let k = 1; k < 8; k++) if (scores[k] > scores[phase]) phase = k;

  // 5) Sections.
  const bassOn = Array.from({ length: nb }, (_, i) => {
    const v = i === 0 ? bars[0].low : 0.5 * (bars[i].low + bars[i - 1].low);
    return v > -6 && floor[i] > -9;
  });
  const bounds = [musicStart];
  if (musicStart + 1 < musicEnd) {
    const cueSet = new Set(cueBars.map(c => Math.trunc(c.bar)));
    for (let i = musicStart + 1; i < musicEnd; i++) {
      if (!(raw[i] >= 4.5 || (cueSet.has(i) && raw[i] >= 2.5))) continue;
      if (!(raw[i] >= maxOf(raw, Math.max(0, i - 2), Math.min(nb - 1, i + 2)))) continue;
      const lo = Math.max(musicStart + 1, i - 2), hi = Math.min(musicEnd, i + 3);
      if (lo >= hi) continue;
      let j = lo, best = -1;
      for (let k = lo; k < hi; k++) {
        const step = wabs(sub(bars[k], bars[k - 1]));
        if (step > best) { best = step; j = k; }
      }
      const snapped = phase + 4 * Math.floor((j - phase) / 4 + 0.5);
      if (Math.abs(snapped - j) <= 1) j = snapped;
      const near = cueBars.filter(c => Math.abs(Math.trunc(c.bar) - j) <= 2);
      if (near.length) j = Math.trunc(near.reduce((a, b) => (b.score > a.score ? b : a)).bar);
      if (j - bounds[bounds.length - 1] >= 4 && j < musicEnd) bounds.push(j);
    }
  }
  bounds.push(musicEnd);
  const sections: TrackSection[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k], b = bounds[k + 1];
    if (b <= a) continue;
    let bassN = 0, energy = 0;
    for (let i = a; i < b; i++) { if (bassOn[i]) bassN++; energy += bars[i].full; }
    const bassFrac = bassN / (b - a);
    energy /= b - a;
    sections.push({ start: a, end: b, kind: bassFrac >= 0.6 && energy >= -4.5 ? 'drop' : 'breakdown', bass: bassFrac, energy });
  }
  // A drop starts where the bass does: move its start past silent build-up bars (up to 4).
  for (let i = 1; i < sections.length; i++) {
    if (sections[i].kind !== 'drop') continue;
    const s0 = sections[i].start;
    const lim = Math.max(s0, Math.min(s0 + 4, sections[i].end - 1));
    let k = -1;
    for (let q = s0; q < lim; q++) if (floor[q] > -9) { k = q; break; }
    if (k > s0) { sections[i].start = k; sections[i - 1].end = k; }
  }
  const drops = sections.filter(s => s.kind === 'drop');
  const firstDrop = drops[0]?.start ?? musicStart;
  const lastDropEnd = drops[drops.length - 1]?.end ?? musicEnd;
  for (const s of sections) {
    if (s.kind === 'drop') continue;
    if (s.end <= firstDrop) s.kind = 'intro';
    else if (s.start >= lastDropEnd) s.kind = 'outro';
  }
  const merged: TrackSection[] = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && last.kind === s.kind) {
      const la = last.end - last.start, lb = s.end - s.start;
      last.bass = (last.bass * la + s.bass * lb) / (la + lb);
      last.energy = (last.energy * la + s.energy * lb) / (la + lb);
      last.end = s.end;
    } else merged.push({ ...s });
  }

  return {
    bpm, firstBeat: fb, barSeconds: barLen, barCount: nb, phraseOffset: phase,
    low: bars.map(b => Math.fround(b.low)), full: bars.map(b => Math.fround(b.full)), high: bars.map(b => Math.fround(b.high)),
    bass: bassOn, musicStart, musicEnd, firstDrop, lastDropEnd, sections: merged,
    key, downbeatShift: shift, cueBars, gridFit: gridFitPerBar(hints?.beats ?? [], fb, beat, nb),
  };
}
