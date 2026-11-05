// Port of mac/DJAW/Audio/AudioAnalyzer.swift: reads a track once → waveform, BPM, first downbeat, band energies,
// key and structure (with the neural beat grid when the model is available).
import { Mathx, Waveform } from '../models';
import { AudioSource } from '../render/source';
import { BeatModel, CueAssets, CueHint, NEURAL_VERSION, NeuralResult, beatHitRate, beatThis, cueDETR, estimateGrid, mergeCues, resample } from './neural';
import { GenreAssets, classifyGenre } from './genreModel';
import type { GenreResult } from '../genre';
import { ChromaAccumulator, MusicalKey, StructureHints, TrackStructure, analyzeStructure } from './structure';

export interface TempoOption { bpm: number; firstBeat: number; fit: number }

export interface BandEnergies {
  low: Float32Array;
  full: Float32Array;
  high: Float32Array;
  frameRate: number;
  duration: number;
  key: MusicalKey | null;
  hints: StructureHints | null;
  /** 2 ms RMS envelopes (below ~150 Hz and full band) for placing beats on the actual attacks. */
  fineLow: Float32Array;
  fineFull: Float32Array;
  fineRate: number;
}

export interface TrackAnalysis {
  title: string;
  artist: string;
  duration: number;
  sampleRate: number;
  bpm: number;
  firstBeat: number;
  waveform: Waveform;
  structure: TrackStructure | null;
  tempoOptions: TempoOption[];
  energies: BandEnergies | null;
  neural: NeuralResult | null;
  genre?: GenreResult | null;
}

/**
 * Median distance (seconds) from the beat lines to the nearest sharp attack within ±45 ms, over `t0`…`t1`.
 * Add it to `firstBeat` to put the grid on the attacks. Null = too few attacks.
 */
export function onsetOffset(e: BandEnergies, bpm: number, firstBeat: number, t0 = 0, t1: number | null = null, minCount = 8): number | null {
  const n = Math.min(e.fineLow.length, e.fineFull.length);
  if (n <= 10 || !(bpm > 1)) return null;
  const eps = 1e-4;
  const od = new Float32Array(n);
  for (let i = 2; i < n; i++) {
    const dl = Math.max(0, Math.log(e.fineLow[i] + eps) - Math.log(e.fineLow[i - 2] + eps));
    const df = Math.max(0, Math.log(e.fineFull[i] + eps) - Math.log(e.fineFull[i - 2] + eps));
    od[i] = dl + 0.5 * df;
  }
  const rate = e.fineRate, beat = 60 / bpm, tol = 0.045;
  const end = Math.min(t1 ?? e.duration, n / rate);
  const offs: number[] = [];
  let k = Math.ceil((t0 - firstBeat) / beat);
  for (;;) {
    const t = firstBeat + k * beat;
    k++;
    if (t > end) break;
    const a = Math.trunc((t - tol) * rate), b = Math.trunc((t + tol) * rate);
    if (!(a >= 1 && b < n - 1)) continue;
    let j = a;
    for (let q = a; q < b; q++) if (od[q] > od[j]) j = q;
    if (!(od[j] >= 0.3)) continue;
    const y0 = od[j - 1], y1 = od[j], y2 = od[j + 1];
    const den = y0 - 2 * y1 + y2;
    const frac = den < 0 ? 0.5 * (y0 - y2) / den : 0;
    // The flux compares frames two apart: the attack starts about one frame before the peak.
    offs.push((j + frac - 1) / rate - t);
  }
  if (offs.length < minCount) return null;
  offs.sort((x, y) => x - y);
  const med = offs[Math.floor(offs.length / 2)];
  return Math.abs(med) < tol ? med : null;
}

export function structureFor(e: BandEnergies, bpm: number, firstBeat: number) {
  return analyzeStructure(e.low, e.full, e.high, e.frameRate, bpm, firstBeat, e.duration, e.key, e.hints);
}

/** Structure on a grid the neural tracker found for one stretch of the track (bar lines kept as given). */
export function structureTrusted(e: BandEnergies, bpm: number, firstBeat: number) {
  const h: StructureHints = { ...(e.hints ?? { cues: [], beats: [] }), gridBPM: bpm, gridFirstBeat: firstBeat };
  return analyzeStructure(e.low, e.full, e.high, e.frameRate, bpm, firstBeat, e.duration, e.key, h);
}

export interface AnalyzeOptions {
  /** Beat This! (null = energy-based tempo only). */
  beatModel?: BeatModel | null;
  /** CUE-DETR (null = no cue suggestions). */
  cues?: CueAssets | null;
  /** Discogs-EffNet and heads (null = no genre / vocal analysis). */
  genre?: GenreAssets | null;
  progress?: (stage: 'read' | 'beats' | 'cues' | 'genre', fraction: number) => void;
}

export async function analyzeAudio(src: AudioSource, o: AnalyzeOptions = {}): Promise<TrackAnalysis> {
  const sampleRate = src.sampleRate;
  const totalFrames = src.frames;
  const duration = totalFrames / sampleRate;
  const hop = Math.max(64, Math.round(sampleRate / 100));
  const frameRate = sampleRate / hop;
  const estBins = Math.floor(totalFrames / hop) + 2;
  const peaks = new Float32Array(estBins), lows = new Float32Array(estBins);
  const eFull = new Float32Array(estBins), eLow = new Float32Array(estBins), eHigh = new Float32Array(estBins);
  let nBins = 0;
  const alpha = 1 - Math.exp(-2 * Math.PI * 150 / sampleRate);
  // One-pole high-pass at 3 kHz (hi-hats, vocals' air) for the structure analysis.
  const hpCoef = Math.exp(-2 * Math.PI * 3000 / sampleRate);
  let hpPrevIn = 0, hpOut = 0, accHighSq = 0;
  const chroma = new ChromaAccumulator(sampleRate);
  let lowpass = 0, accMax = 0, accLowMax = 0, accSq = 0, accLowSq = 0, count = 0;
  const fineHop = Math.max(16, Math.round(sampleRate / 500));
  const fineN = Math.floor(totalFrames / fineHop) + 2;
  const fineLow = new Float32Array(fineN), fineFull = new Float32Array(fineN);
  let nFine = 0, fAccL = 0, fAccF = 0, fCount = 0;
  const flush = () => {
    const n = Math.max(count, 1);
    peaks[nBins] = accMax; lows[nBins] = accLowMax;
    eFull[nBins] = Math.sqrt(accSq / n); eLow[nBins] = Math.sqrt(accLowSq / n); eHigh[nBins] = Math.sqrt(accHighSq / n);
    nBins++;
    accMax = 0; accLowMax = 0; accSq = 0; accLowSq = 0; accHighSq = 0; count = 0;
  };
  // Mono at 22.05 kHz for the beat tracker is collected along the way (only when the model is there).
  const monoAll = o.beatModel || o.genre || o.cues ? new Float32Array(totalFrames) : null;
  const block = 1 << 16;
  const L = new Float32Array(block), R = new Float32Array(block), mono = new Float32Array(block);
  for (let pos = 0, reads = 0; pos < totalFrames; pos += block, reads++) {
    const n = Math.min(block, totalFrames - pos);
    src.read(pos, n, L, R);
    if (reads % 16 === 0) o.progress?.('read', pos / Math.max(1, totalFrames));
    for (let i = 0; i < n; i++) {
      const x = Math.fround(src.channels > 1 ? (L[i] + R[i]) * 0.5 : L[i]);
      lowpass += alpha * (x - lowpass);
      hpOut = hpCoef * (hpOut + x - hpPrevIn);
      hpPrevIn = x;
      accHighSq += hpOut * hpOut;
      mono[i] = x;
      const ax = Math.abs(x), al = Math.abs(lowpass);
      if (ax > accMax) accMax = ax;
      if (al > accLowMax) accLowMax = al;
      accSq += x * x;
      accLowSq += lowpass * lowpass;
      count++;
      if (count === hop) flush();
      fAccL += lowpass * lowpass;
      fAccF += x * x;
      fCount++;
      if (fCount === fineHop) {
        fineLow[nFine] = Math.sqrt(fAccL / fineHop);
        fineFull[nFine] = Math.sqrt(fAccF / fineHop);
        nFine++;
        fAccL = 0; fAccF = 0; fCount = 0;
      }
    }
    chroma.process(mono.subarray(0, n));
    monoAll?.set(mono.subarray(0, n), pos);
  }
  if (count > 0) flush();
  o.progress?.('read', 1);

  let maxPeak = 0.0001;
  for (let i = 0; i < nBins; i++) if (peaks[i] > maxPeak) maxPeak = peaks[i];
  const waveform: Waveform = { binsPerSecond: frameRate, peaks: peaks.slice(0, nBins), lows: lows.slice(0, nBins), maxPeak };
  const classic = estimateTempo(eFull.subarray(0, nBins), eLow.subarray(0, nBins), frameRate);
  const energies: BandEnergies = {
    low: eLow.slice(0, nBins), full: eFull.slice(0, nBins), high: eHigh.slice(0, nBins),
    frameRate, duration, key: chroma.estimateKey(), hints: null,
    fineLow: fineLow.slice(0, nFine), fineFull: fineFull.slice(0, nFine), fineRate: sampleRate / fineHop,
  };

  let neural: NeuralResult | null = null;
  if ((o.beatModel || o.cues) && monoAll && duration > 5) {
    const y = resample(monoAll, sampleRate, 22050);
    const bt = o.beatModel ? await beatThis(y, o.beatModel, p => o.progress?.('beats', p)) : null;
    o.progress?.('beats', 1);
    const grid = bt && bt.beats.length >= 16 ? estimateGrid(bt.beats, bt.downbeats) : null;
    let cues: CueHint[] = [];
    if (o.cues) {
      try { cues = mergeCues((await cueDETR(y, o.cues, p => o.progress?.('cues', p))) ?? [], grid); } catch (e) { console.warn('[DJAW] cue model:', e); }
      o.progress?.('cues', 1);
    }
    if (bt || cues.length) neural = { version: NEURAL_VERSION, beats: bt?.beats ?? [], downbeats: bt?.downbeats ?? [], cues, grid };
  }
  let genre: GenreResult | null = null;
  if (o.genre && monoAll && duration > 5) {
    try { genre = await classifyGenre(resample(monoAll, sampleRate, 16000), o.genre, p => o.progress?.('genre', p)); } catch (e) { console.warn('[DJAW] genre model:', e); }
    o.progress?.('genre', 1);
  }

  const tempo = chooseGrid(classic, neural);
  // Put the beat lines on the actual attacks (the trackers are only accurate to ~10–40 ms).
  const off = onsetOffset(energies, tempo.bpm, tempo.firstBeat);
  if (off != null) tempo.firstBeat += off;
  energies.hints = {
    gridBPM: tempo.fromNeural ? tempo.bpm : null,
    gridFirstBeat: tempo.fromNeural ? tempo.firstBeat : null,
    cues: neural?.cues ?? [], beats: neural?.beats ?? [],
  };
  const structure = structureFor(energies, tempo.bpm, tempo.firstBeat);
  return {
    title: '', artist: '', duration, sampleRate, bpm: tempo.bpm,
    // The structure check may move the downbeat to where the sections really change.
    firstBeat: structure?.firstBeat ?? tempo.firstBeat,
    waveform, structure, tempoOptions: tempo.options, energies, neural, genre,
  };
}

/** Prefers the neural beat grid when it lands on the detected beats at least as well as the energy estimate. */
export function chooseGrid(classic: { bpm: number; firstBeat: number; options: TempoOption[] }, neural: NeuralResult | null) {
  const g = neural?.grid;
  if (!neural || !g) return { ...classic, fromNeural: false };
  const oldHit = beatHitRate(neural.beats, classic.bpm, classic.firstBeat);
  const newHit = beatHitRate(neural.beats, g.bpm, g.firstBeat);
  if (!(newHit >= oldHit - 0.02)) return { ...classic, fromNeural: false };
  const bpm = g.bpm;
  const fb = Mathx.posMod(g.firstBeat, 240 / bpm);
  const options: TempoOption[] = [];
  for (const f of [1, 2, 0.5]) {
    if (Math.abs(g.bpm * f - bpm) > 0.5) options.push({ bpm: g.bpm * f, firstBeat: Mathx.posMod(g.firstBeat, 240 / (g.bpm * f)), fit: f === 1 ? 1 : 0.95 });
  }
  for (const o of classic.options) {
    if (options.every(x => Math.abs(x.bpm - o.bpm) > 0.5) && Math.abs(o.bpm - bpm) > 0.5) options.push({ ...o, fit: o.fit * 0.85 });
  }
  return { bpm, firstBeat: fb, options, fromNeural: true };
}

/** Energy-based tempo and first downbeat (no neural model). */
export function estimateTempo(energyFull: Float32Array, energyLow: Float32Array, fr: number): { bpm: number; firstBeat: number; options: TempoOption[] } {
  const n = energyFull.length;
  if (n <= Math.trunc(fr * 8)) return { bpm: 120, firstBeat: 0, options: [] };
  const logFull = new Float64Array(n), logLow = new Float64Array(n);
  for (let i = 0; i < n; i++) { logFull[i] = Math.log1p(1000 * energyFull[i]); logLow[i] = Math.log1p(1000 * energyLow[i]); }
  const flux = new Float64Array(n);
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, logFull[i] - logFull[i - 1]) + 1.5 * Math.max(0, logLow[i] - logLow[i - 1]);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + flux[i];
  const w = 8;
  const onset = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    onset[i] = Math.max(0, flux[i] - (prefix[b] - prefix[a]) / (b - a));
  }
  const minLag = Math.max(1, Math.floor(fr * 60 / 200));
  const maxLag = Math.ceil(fr * 60 / 60);
  if (!(maxLag + 2 < n / 2)) return { bpm: 120, firstBeat: 0, options: [] };
  const acf = new Float64Array(maxLag + 3);
  for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) {
    let s = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) s += onset[i] * onset[i + lag];
    acf[lag] = s / limit;
  }
  let bestLag = minLag, bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = fr * 60 / lag;
    const weight = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = acf[lag] * weight;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  let lag = bestLag;
  if (bestLag > 1) {
    const y0 = acf[bestLag - 1], y1 = acf[bestLag], y2 = acf[bestLag + 1];
    const d = y0 - 2 * y1 + y2;
    if (Math.abs(d) > 1e-12) { const shift = 0.5 * (y0 - y2) / d; if (Math.abs(shift) < 1) lag += shift; }
  }
  let bpm = fr * 60 / lag;
  while (bpm < 78) bpm *= 2;
  while (bpm >= 178) bpm /= 2;

  const comb = (bpm: number, phaseStep: number) => {
    const period = fr * 60 / bpm;
    let best = -1, bestPhase = 0;
    for (let phase = 0; phase < period; phase += phaseStep) {
      let s = 0, c = 0;
      const last = n - 1;
      for (let pos = phase; pos < last; pos += period) {
        const i = Math.trunc(pos), f = pos - i;
        s += onset[i] * (1 - f) + onset[i + 1] * f;
        c++;
      }
      const mean = c > 0 ? s / c : 0;
      if (mean > best) { best = mean; bestPhase = phase; }
    }
    return { score: best, phase: bestPhase };
  };
  let bestBPM = bpm;
  let bestComb = comb(bpm, 1).score;
  for (let k = 0; k <= 60; k++) {
    const candidate = bpm - 1.5 + k * 0.05;
    const s = comb(candidate, 1).score;
    if (s > bestComb) { bestComb = s; bestBPM = candidate; }
  }
  const coarse = bestBPM;
  for (let k = 0; k <= 12; k++) {
    const candidate = coarse - 0.06 + k * 0.01;
    const s = comb(candidate, 1).score;
    if (s > bestComb) { bestComb = s; bestBPM = candidate; }
  }
  bestBPM = Math.abs(bestBPM - Math.round(bestBPM)) < 0.07 ? Math.round(bestBPM) : Math.round(bestBPM * 100) / 100;

  // Downbeat guess: the beat on which the music starts is treated as beat 1.
  const sorted = Array.from(logFull).sort((a, b) => a - b);
  const reference = sorted[Math.min(sorted.length - 1, Math.trunc(sorted.length * 0.9))];
  let startFrame = logFull.findIndex(v => v > reference * 0.5);
  if (startFrame < 0) startFrame = 0;
  const firstBeat = (bpm: number) => {
    const period = fr * 60 / bpm;
    const phase = comb(bpm, 0.25).phase;
    const beatIndex = Math.round((startFrame - phase) / period);
    const downIndex = ((beatIndex % 4) + 4) % 4;
    return (phase + downIndex * period) / fr;
  };
  const refined = (center: number) => {
    let best = { bpm: center, score: comb(center, 1).score };
    for (let k = 0; k <= 12; k++) {
      const c = center - 0.6 + k * 0.1;
      const sc = comb(c, 1).score;
      if (sc > best.score) best = { bpm: c, score: sc };
    }
    return best;
  };
  const tidy = (b: number) => (Math.abs(b - Math.round(b)) < 0.07 ? Math.round(b) : Math.round(b * 100) / 100);
  const options: TempoOption[] = [];
  const base = Math.max(bestComb, 1e-9);
  for (const ratio of [0.5, 2 / 3, 0.75, 4 / 3, 1.5, 2]) {
    const center = bestBPM * ratio;
    if (center < 70 || center > 200) continue;
    const r = refined(center);
    const fit = r.score / base;
    if (fit < 0.85) continue;
    const b = tidy(r.bpm);
    options.push({ bpm: b, firstBeat: firstBeat(b), fit });
  }
  return { bpm: bestBPM, firstBeat: firstBeat(bestBPM), options };
}
