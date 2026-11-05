// Port of mac/DJAW/Audio/TransitionCheck.swift: renders one planned transition (a few bars around it, only the two
// tracks involved) and listens for a hole in the level, a level bump, two low ends piling up, or flamming kicks.
import { L } from '../i18n';
import { Automation, AutoState } from '../automation';
import { Clip, clipEnd, timelineTimeOfBar } from '../models';
import { TempoMap } from '../tempo';
import { stft } from '../analysis/fft';
import { AudioSource } from './source';
import { RenderSession } from './session';
import { StretchPool } from './stretch';

/** Rendered at the engine rate and averaged down 2:1 (the check works at 22.05 kHz like the Mac version). */
const SR = 22050;

export interface CheckInput {
  clips: Clip[];
  index: number;
  master: number;
  tempo: TempoMap;
  gridOffset: number;
  open: (c: Clip) => AudioSource | null;
  openStems?: (c: Clip) => { vocals: AudioSource; instrumental: AudioSource } | null;
  pool: StretchPool;
  engineRate: number;
}

async function render(o: CheckInput, indices: number[], t0: number, t1: number, fixed?: Map<number, AutoState>): Promise<Float32Array | null> {
  const use = indices.filter(i => i >= 0 && i < o.clips.length && o.clips[i].start < t1 && clipEnd(o.clips[i], o.master) > t0);
  if (!use.length) return null;
  const s = await RenderSession.create({ clips: o.clips, indices: use, master: o.master, tempo: o.tempo, gridOffset: o.gridOffset,
    sampleRate: o.engineRate, from: t0, fixed, open: o.open, openStems: o.openStems, pool: o.pool });
  try {
    const factor = Math.max(1, Math.round(o.engineRate / SR));
    const total = Math.round((o.tempo.real(t1) - o.tempo.real(t0)) * SR);
    const out = new Float32Array(total);
    let n = 0, acc = 0, k = 0;
    while (n < total) {
      const f = s.renderNext();
      for (let i = 0; i < f && n < total; i++) {
        acc += (s.L[i] + s.R[i]) / 2;
        if (++k === factor) { out[n++] = acc / factor; acc = 0; k = 0; }
      }
    }
    return out;
  } finally {
    s.stop();
  }
}

function levels(y: Float32Array, hop: number, window: number): Float32Array {
  const n = Math.floor(y.length / hop);
  const ms = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) s += y[i] * y[i];
    ms[k] = s / hop;
  }
  const out = new Float32Array(n).fill(-120);
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - Math.floor(window / 2)), hi = Math.min(n, k + Math.floor(window / 2) + 1);
    let s = 0;
    for (let j = lo; j < hi; j++) s += ms[j];
    out[k] = 10 * Math.log10(Math.max(1e-12, s / (hi - lo)));
  }
  return out;
}

function lowpass(x: Float32Array, cutoff: number): Float32Array {
  const w = Math.tan(Math.PI * cutoff / SR), q = 1 / Math.SQRT2;
  const n = 1 / (1 + w / q + w * w);
  const b0 = w * w * n, b1 = 2 * b0, b2 = b0;
  const a1 = 2 * (w * w - 1) * n, a2 = (1 - w / q + w * w) * n;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

function onsetFlux(y: Float32Array): Float32Array {
  const spec = stft(y, 1024, 128, false, false);
  const out = new Float32Array(Math.max(0, spec.frames));
  for (let f = 1; f < spec.frames; f++) {
    let s = 0;
    for (let k = 2; k < spec.bins; k++) {
      const d = Math.log1p(spec.data[f * spec.bins + k] * 100) - Math.log1p(spec.data[(f - 1) * spec.bins + k] * 100);
      if (d > 0) s += d;
    }
    out[f] = s;
  }
  return out;
}

/** Checks the transition into clip `index`. null = could not render. */
export async function checkTransition(o: CheckInput): Promise<{ problems: string[] } | null> {
  const { clips, index: i, master, tempo, gridOffset } = o;
  if (i <= 0 || i >= clips.length) return null;
  const a = clips[i - 1], b = clips[i];
  const o0 = timelineTimeOfBar(b, b.mixInBar, master);
  const o1 = Math.max(o0, clipEnd(a, master));
  const bar = 240 / master;
  const cut = o1 - o0 < 0.25 * bar;
  const t0 = Math.max(0, o0 - 4 * bar), t1 = Math.min(clipEnd(b, master), o1 + 4 * bar);
  if (!(t1 - t0 > 2 * bar)) return null;
  const y = await render(o, [i - 1, i], t0, t1);
  if (!y) return null;
  const r0 = tempo.real(t0);
  const rs = (t: number) => tempo.real(t) - r0;
  const beat = 60 / master;
  const ov0 = cut ? rs(o0 - beat) : rs(o0), ov1 = cut ? rs(o0 + 2 * beat) : rs(o1);
  const pre: [number, number] = [0, Math.max(0, rs(o0) - 0.1)], post: [number, number] = [rs(o1) + 0.1, y.length / SR];
  const problems: string[] = [];
  const ends = clips.map(c => clipEnd(c, master));
  const soloA = Automation.state(clips, i - 1, Math.max(a.start, o0 - bar), master, ends);
  const soloB = Automation.state(clips, i, Math.min(ends[i] - 0.01, o1 + bar), master, ends);
  const ya = await render(o, [i - 1], t0, t1, new Map([[i - 1, soloA]]));
  const yb = await render(o, [i], t0, t1, new Map([[i, soloB]]));

  const hop = 1024;
  const full = levels(y, hop, 8);
  const low = levels(lowpass(y, 150), hop, 8);
  const fps = SR / hop;
  const frames = (r: [number, number]): [number, number] => {
    const x = Math.max(0, Math.trunc(r[0] * fps)), z = Math.min(full.length, Math.trunc(r[1] * fps));
    return [x, Math.max(x, z)];
  };
  const ovR = frames([ov0, ov1]);
  const beatFrames = Math.max(1, Math.trunc(60 / tempo.bpm(o0) * fps));
  const longestRun = (cond: (f: number) => boolean) => {
    let best = 0, cur = 0;
    for (let f = ovR[0]; f < ovR[1]; f++) { if (cond(f)) { cur++; best = Math.max(best, cur); } else cur = 0; }
    return best;
  };
  if (ovR[1] > ovR[0] && ya && yb) {
    const fa = levels(ya, hop, 8), fb = levels(yb, hop, 8);
    const la = levels(lowpass(ya, 150), hop, 8), lb = levels(lowpass(yb, 150), hop, 8);
    const at = (x: Float32Array, f: number) => (f < x.length ? x[f] : -120);
    const expect = (f: number) => Math.max(at(fa, f), at(fb, f));
    const expectLow = (f: number) => Math.max(at(la, f), at(lb, f));
    const range = Array.from({ length: ovR[1] - ovR[0] }, (_, k) => ovR[0] + k);
    if (!cut && longestRun(f => expect(f) > -50 && full[f] < expect(f) - 9) >= 2 * beatFrames) {
      const d = Math.round(Math.max(...range.map(f => expect(f) - full[f])));
      problems.push(L(`つなぎの途中で音が痩せる（最大 ${d} dB 下がる）`, `The level drops during the blend (up to ${d} dB)`));
    }
    if (longestRun(f => full[f] > expect(f) + 4.5) >= beatFrames) {
      const d = Math.round(Math.max(...range.map(f => full[f] - expect(f))));
      problems.push(L(`重なっている間に音量が膨らむ（+${d} dB）`, `The level swells while both play (+${d} dB)`));
    }
    if (longestRun(f => expectLow(f) > -50 && low[f] > expectLow(f) + 3.5) >= 2 * beatFrames) {
      problems.push(L('低音が重なって濁る', 'The low end piles up (muddy bass)'));
    }
  }

  if (!cut) {
    const flux = onsetFlux(y);
    const ffps = SR / 128;
    const beatTimes: number[] = [];
    for (let tb = gridOffset + Math.ceil((t0 - gridOffset) / beat) * beat; tb < t1; tb += beat) beatTimes.push(rs(tb));
    const flamRate = (r: [number, number]): number | null => {
      const bs = beatTimes.filter(t => t >= r[0] + 0.15 && t <= r[1] - 0.15);
      if (bs.length < 4) return null;
      let flams = 0;
      for (const t of bs) {
        const c = Math.trunc(t * ffps), w = Math.trunc(0.12 * ffps);
        if (c - w < 0 || c + w >= flux.length) continue;
        const seg = flux.subarray(c - w, c + w + 1);
        let p1 = 0;
        for (let k = 1; k < seg.length; k++) if (seg[k] > seg[p1]) p1 = k;
        if (!(seg[p1] > 0)) continue;
        const d0 = Math.trunc(0.025 * ffps), d1 = Math.trunc(0.11 * ffps);
        let p2 = -1;
        for (let k = 0; k < seg.length; k++) {
          const dk = Math.abs(k - p1);
          if (dk >= d0 && dk <= d1 && (p2 < 0 || seg[k] > seg[p2])) p2 = k;
        }
        if (p2 >= 0 && seg[p2] >= 0.5 * seg[p1] && seg[p2] > seg[Math.max(0, Math.min(seg.length - 1, Math.trunc((p1 + p2) / 2)))] * 1.1) flams++;
      }
      return flams / bs.length;
    };
    const fo = flamRate([ov0, ov1]);
    if (fo != null) {
      const base = Math.max(flamRate(pre) ?? 0, flamRate(post) ?? 0);
      if (fo > 0.4 && fo - base > 0.3) problems.push(L('重なっている間、キックが二重に聞こえる（拍のずれ）', 'Kicks flam during the blend (beats out of line)'));
    }
  }
  return { problems };
}
