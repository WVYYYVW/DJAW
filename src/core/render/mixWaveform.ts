// Which stretch of the mix waveform an edit changes (mac/DJAW/Store/MixStore+MixWaveform.swift MixWaveformInputs),
// so only that part is rendered again and the rest is moved along.
import { Clip, clipEnd } from '../models';
import { TempoMap } from '../tempo';
import type { MixPeaks } from './offline';
import { TAIL } from './session';

export interface MixWaveformInputs {
  clips: Clip[];
  master: number;
  tempo: TempoMap;
  gridOffset: number;
  sampleRate: number;
  /** Which stems were ready (a track starting to play from its stems sounds different). */
  stems: string;
}

const endReal = (i: MixWaveformInputs) => i.tempo.real(Math.max(0, ...i.clips.map(c => clipEnd(c, i.master))));

/** A clip as far as the sound is concerned (names, colours, notes and saved takes don't matter). */
function audible(c: Clip): string {
  const { takes, colorIndex, autoNote, cueDone, transitionDone, cues, title, artist, ...rest } = c as Clip & Record<string, unknown>;
  void takes; void colorIndex; void autoNote; void cueDone; void transitionDone; void cues; void title; void artist;
  const r = rest as Record<string, unknown>;
  delete r.genre; delete r.lufs;
  return JSON.stringify(r);
}

export interface MixWaveformChange {
  /** Stretch to render again (real seconds of the new mix). */
  fromReal: number;
  toReal: number;
  /** From `toReal` on, the new mix is the old one moved by this much (real seconds). */
  shiftReal: number;
  /** The move is a whole number of bins (the result needs no exact re-render afterwards). */
  exact: boolean;
}

/** Which stretch of the mix differs between two renders' inputs; null = render everything again. */
export function mixWaveformChange(a: MixWaveformInputs, b: MixWaveformInputs): MixWaveformChange | null {
  if (a.master !== b.master || a.gridOffset !== b.gridOffset || a.sampleRate !== b.sampleRate || a.stems !== b.stems) return null;
  const x = a.clips.map(audible), y = b.clips.map(audible);
  // Unchanged tracks at the start.
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  if (p === x.length && p === y.length) return null;
  // Tracks at the end that are only moved in time (same track, same settings).
  const moved = (c: Clip, d: number) => audible({ ...c, start: c.start + d });
  let ia = x.length - 1, ib = y.length - 1;
  let shiftRef: number | null = null;
  while (ia > p && ib > p && a.clips[ia].id === b.clips[ib].id) {
    const d = b.clips[ib].start - a.clips[ia].start;
    if (shiftRef != null && Math.abs(shiftRef - d) > 1e-9) break;
    if (moved(a.clips[ia], d) !== y[ib]) break;
    shiftRef = d;
    ia--; ib--;
  }
  const changedA = p <= ia ? a.clips.slice(p, ia + 1) : [];
  const changedB = p <= ib ? b.clips.slice(p, ib + 1) : [];
  const starts = [...changedA, ...changedB].map(c => c.start);
  const startRef = starts.length ? Math.min(...starts) : 0;
  const fromReal = Math.max(0, Math.min(a.tempo.real(startRef), b.tempo.real(startRef)));
  const whole = { fromReal, toReal: endReal(b) + 0.3, shiftReal: 0, exact: true };
  // With no moved tail, render to the end of the mix.
  if (shiftRef == null || ib + 1 >= b.clips.length) return whole;
  const shift = shiftRef;
  // The moved part must also keep its tempo: same tempo curve from where it starts on.
  const firstMovedNew = b.clips[ib + 1].start;
  const endChangedNew = changedB.length ? Math.max(...changedB.map(c => clipEnd(c, b.master))) : firstMovedNew;
  const cutRef = Math.max(firstMovedNew, endChangedNew) + TAIL * b.master / Math.max(1, b.tempo.bpm(endChangedNew));
  const last = Math.max(cutRef, ...b.clips.map(c => clipEnd(c, b.master)));
  for (let t = cutRef; t <= last + 1; t += 1) {
    if (Math.abs(b.tempo.bpm(t) - a.tempo.bpm(t - shift)) > 1e-6) return whole;
  }
  const toReal = b.tempo.real(cutRef);
  const shiftReal = toReal - a.tempo.real(cutRef - shift);
  const bins = shiftReal * a.sampleRate / Math.max(1, Math.round(a.sampleRate / 200));
  return { fromReal, toReal, shiftReal, exact: Math.abs(bins - Math.round(bins)) < 1e-6 };
}

const peakOf = (mins: Float32Array, maxs: Float32Array) => {
  let pk = 0;
  for (let i = 0; i < mins.length; i++) pk = Math.max(pk, -mins[i], maxs[i]);
  return pk;
};

/** The old waveform rearranged to the new layout (the changed stretch still shows the old one until it is rendered). */
export function provisionalPeaks(ch: MixWaveformChange, old: MixPeaks, inputs: MixWaveformInputs): MixPeaks | null {
  const bps = old.binsPerSecond;
  const n = Math.ceil((endReal(inputs) + 0.3) * bps) + 1;
  if (!(n > 0)) return null;
  const p: MixPeaks = { sampleRate: old.sampleRate, binsPerSecond: bps, mins: new Float32Array(n), maxs: new Float32Array(n),
    rms: new Float32Array(n), rendered: endReal(inputs) + 0.3, peak: 0 };
  const cut = Math.trunc(ch.toReal * bps);
  const shift = Math.round(ch.shiftReal * bps);
  for (let b = 0; b < n; b++) {
    const src = b < cut ? b : b - shift;
    if (src < 0 || src >= old.mins.length) continue;
    p.mins[b] = old.mins[src]; p.maxs[b] = old.maxs[src];
    if (src < old.rms.length) p.rms[b] = old.rms[src];
  }
  p.peak = peakOf(p.mins, p.maxs);
  return p;
}

/** Puts a rendered stretch into the waveform. */
export function splicePeaks(peaks: MixPeaks, part: { firstBin: number; mins: Float32Array; maxs: Float32Array; rms: Float32Array }): MixPeaks {
  const p = { ...peaks, mins: Float32Array.from(peaks.mins), maxs: Float32Array.from(peaks.maxs), rms: Float32Array.from(peaks.rms) };
  for (let k = 0; k < part.mins.length; k++) {
    const b = part.firstBin + k;
    if (b >= p.mins.length) break;
    p.mins[b] = part.mins[k]; p.maxs[b] = part.maxs[k]; p.rms[b] = part.rms[k];
  }
  p.peak = peakOf(p.mins, p.maxs);
  return p;
}
