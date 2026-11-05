// Port of mac/DJAW/Model/AutoMixer.swift: plans DJ-style transitions from the analysed structure of two tracks,
// the running order, quick-cut highlights and the per-genre mixing profiles.
import { L } from './i18n';
import { Automation } from './automation';
import { Shape, TransitionShape, TransitionStyle } from './models';
import { Key, MusicalKey, Structure, TrackStructure } from './analysis/structure';
import { Genre, MixGenre } from './genre';

/** One planned transition from track A (outgoing) into track B (incoming), on each track's analysis grid. */
export interface AutoMixPlan {
  outBar: number;
  inBar: number;
  length: number;
  style: TransitionStyle;
  shape: TransitionShape | null;
  score: number;
  reasons: string[];
  /** Name of the variation (e.g. "長く重ねる") when offered as one of several choices. */
  label?: string | null;
}

/** Per-bar vocal probabilities (analysis-grid bars) of the two tracks, when known. */
export class Vocals {
  constructor(public a: number[] | null = null, public b: number[] | null = null) {}
  va(k: number) { const v = this.a; return v && k >= 0 && k < v.length ? v[k] : 0; }
  vb(k: number) { const v = this.b; return v && k >= 0 && k < v.length ? v[k] : 0; }
}

interface Candidate { m: number; i: number; l: number; score: number; reasons: string[]; special: TransitionStyle | null }

// MARK: - Mix profiles

export type ProfileEQ = 'swap' | 'filter' | 'smooth';

/** EQ-curve adjustments relative to the swap point p (= the shape's inRise). */
export interface ShapeTuning {
  midLead?: number | null; midRamp?: number | null; lowRamp?: number | null;
  highLead?: number | null; highRamp?: number | null;
  inRiseOffset?: number | null; outFadeOffset?: number | null;
  transitions?: number | null;
}

export const Shapes = {
  learned: (t: ShapeTuning) => (t.transitions ?? 0) > 0,
  /** Hand-made hardcore / breakcore blends (the user's own hyperflip mix). */
  handSwap: { midLead: 0.1, midRamp: 0.3, lowRamp: 0, highLead: null, highRamp: null, inRiseOffset: 0, outFadeOffset: 0, transitions: 4 } as ShapeTuning,
  apply(t: ShapeTuning, shape: TransitionShape): TransitionShape {
    if (!Shapes.learned(t)) return shape;
    const s = structuredClone(shape);
    const p = shape.inRise;
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    if (t.lowRamp != null) { s.low.ramp = Math.max(0, t.lowRamp); s.low.point = clamp(p - s.low.ramp / 2); }
    if (t.midLead != null) s.mid.point = clamp(p - t.midLead);
    if (t.midRamp != null) s.mid.ramp = Math.max(0, t.midRamp);
    if (t.highLead != null) {
      s.high.enabled = true;
      s.high.point = clamp(p - t.highLead);
      s.high.ramp = Math.max(0, t.highRamp ?? 0.3);
    }
    if (t.inRiseOffset != null) s.inRise = clamp(p + t.inRiseOffset);
    if (t.outFadeOffset != null) s.outFadeStart = clamp(p + t.outFadeOffset);
    return s;
  },
};

/** How a genre is usually mixed by DJs; tilts the transition planner's choices. */
export interface MixProfile {
  lengthBonus: Record<number, number>;
  maxBars: number;
  switchBias: number;
  echoBias: number;
  spinBias: number;
  dropWeight: number;
  blendLimit: number;
  eq: ProfileEQ;
  thinOut: boolean;
  reverbTail: boolean;
  vocalWeight: number;
  shapes: ShapeTuning;
  pacing: number | null;
  dropToDrop: number;
}

/** Values the MixScore kit found (userData/MixTuning.json). */
export interface MixTuning {
  version?: number;
  note?: string;
  params?: Record<string, {
    len32?: number; len16?: number; len8?: number; len4?: number;
    switchBias?: number; echoBias?: number; spinBias?: number;
    dropWeight?: number; vocalWeight?: number; maxBars?: number; pacing?: number; dropToDrop?: number;
  }>;
  shapes?: Record<string, ShapeTuning>;
}

let tuning: MixTuning = {};
export function setMixTuning(t: MixTuning | null) { tuning = t ?? {}; }

function applyTuning(p: MixProfile, genre: MixGenre | null): MixProfile {
  const r = { ...p, lengthBonus: { ...p.lengthBonus } };
  for (const key of ['*', genre].filter(Boolean) as string[]) {
    const t = tuning.params?.[key];
    if (!t) continue;
    for (const [l, v] of [[32, t.len32], [16, t.len16], [8, t.len8], [4, t.len4]] as [number, number | undefined][]) {
      if (v != null) r.lengthBonus[l] = (r.lengthBonus[l] ?? 0) + v;
    }
    if (t.switchBias != null) r.switchBias += t.switchBias;
    if (t.echoBias != null) r.echoBias += t.echoBias;
    if (t.spinBias != null) r.spinBias += t.spinBias;
    if (t.dropWeight != null) r.dropWeight *= t.dropWeight;
    if (t.vocalWeight != null) r.vocalWeight *= t.vocalWeight;
    if (t.maxBars != null) r.maxBars = t.maxBars;
    if (t.pacing != null) r.pacing = t.pacing > 0 ? t.pacing : null;
    if (t.dropToDrop != null) r.dropToDrop = t.dropToDrop;
  }
  const own = genre ? tuning.shapes?.[genre] : undefined;
  if (own) r.shapes = own;
  else if (!Shapes.learned(r.shapes) && tuning.shapes?.['*']) r.shapes = tuning.shapes['*'];
  return r;
}

const baseProfile = (): MixProfile => ({
  lengthBonus: { 32: 0.1, 16: 0.35, 8: 0.25, 4: 0 }, maxBars: 32, switchBias: 0, echoBias: 0, spinBias: 0, dropWeight: 1,
  blendLimit: 1.12, eq: 'swap', thinOut: true, reverbTail: false, vocalWeight: 1, shapes: {}, pacing: null, dropToDrop: 0,
});

function genreBase(g: MixGenre): MixProfile {
  const p = baseProfile();
  p.vocalWeight = ({ pop: 1.3, hiphop: 1.2, ukg: 1.1, band: 1.2, techno: 0.6, dnb: 0.8, bass: 0.8, hard: 0.9, breakcore: 0.5, chill: 0.8 } as Partial<Record<MixGenre, number>>)[g] ?? 1;
  const set = (o: Partial<MixProfile>) => Object.assign(p, o);
  switch (g) {
    case 'house': set({ lengthBonus: { 32: 0.45, 16: 0.45, 8: 0.1, 4: -0.3 }, switchBias: -0.4, spinBias: -0.6, dropWeight: 0.8, blendLimit: 1.08 }); break;
    case 'techno': set({ lengthBonus: { 32: 0.75, 16: 0.4, 8: 0, 4: -0.4 }, switchBias: -0.6, spinBias: -0.9, dropWeight: 0.6, eq: 'filter', blendLimit: 1.08 }); break;
    case 'trance': set({ lengthBonus: { 32: 0.35, 16: 0.5, 8: 0.15, 4: -0.3 }, switchBias: -0.3, spinBias: -0.6, dropWeight: 1, blendLimit: 1.08 }); break;
    case 'ukg': set({ lengthBonus: { 32: -0.3, 16: 0.45, 8: 0.4, 4: 0 }, maxBars: 16, echoBias: 0.2, dropWeight: 1.1, blendLimit: 1.06 }); break;
    case 'bass': set({ lengthBonus: { 32: -0.7, 16: 0.1, 8: 0.45, 4: 0.2 }, maxBars: 16, switchBias: 0.8, echoBias: 0.5, spinBias: 0.3, dropWeight: 1.4 }); break;
    case 'dnb': set({ lengthBonus: { 32: -0.2, 16: 0.5, 8: 0.35, 4: 0 }, switchBias: 0.3, spinBias: 0.5, dropWeight: 1.5 }); break;
    case 'breaks': set({ lengthBonus: { 32: -0.2, 16: 0.35, 8: 0.35, 4: 0.1 }, maxBars: 16, switchBias: 0.3, echoBias: 0.2 }); break;
    case 'hard': set({ lengthBonus: { 32: -0.7, 16: 0.15, 8: 0.4, 4: 0.25 }, maxBars: 16, switchBias: 0.9, echoBias: 0.3, spinBias: 0.6, dropWeight: 1.3, pacing: 150, dropToDrop: 0.8, shapes: Shapes.handSwap }); break;
    case 'breakcore': set({ lengthBonus: { 32: -1, 16: -0.3, 8: 0.2, 4: 0.4 }, maxBars: 8, switchBias: 1.5, spinBias: 0.8, echoBias: 0.3, pacing: 150, dropToDrop: 0.8, shapes: Shapes.handSwap }); break;
    case 'hiphop': set({ lengthBonus: { 32: -1, 16: -0.4, 8: 0.2, 4: 0.4 }, maxBars: 8, switchBias: 1.4, echoBias: 0.8, spinBias: 0.6, dropWeight: 0.6, thinOut: false }); break;
    case 'pop': set({ lengthBonus: { 32: -0.8, 16: 0, 8: 0.4, 4: 0.3 }, maxBars: 16, switchBias: 0.6, echoBias: 0.6, dropWeight: 0.9, thinOut: false }); break;
    case 'chill': set({ lengthBonus: { 32: 0.5, 16: 0.4, 8: 0, 4: -0.4 }, switchBias: -0.8, spinBias: -1.5, echoBias: 0.2, dropWeight: 0.5, blendLimit: 1.05, eq: 'smooth', thinOut: false, reverbTail: true }); break;
    case 'band': set({ lengthBonus: { 32: -0.6, 16: 0, 8: 0.3, 4: 0.3 }, maxBars: 16, switchBias: 0.5, echoBias: 0.7, spinBias: -0.6, dropWeight: 0.5, blendLimit: 1.04, eq: 'smooth', thinOut: false }); break;
  }
  return p;
}

export const Profiles = {
  neutral: (): MixProfile => applyTuning(baseProfile(), null),
  of: (g: MixGenre): MixProfile => applyTuning(genreBase(g), g),
  /** Profile for a transition from genre `a` into genre `b` (null = unknown). */
  pair(a: MixGenre | null, b: MixGenre | null): MixProfile {
    if (!a && !b) return Profiles.neutral();
    if (!a || !b) return Profiles.of((a ?? b)!);
    if (a === b) return Profiles.of(a);
    const p = Profiles.of(a), q = Profiles.of(b);
    const r = baseProfile();
    for (const l of [32, 16, 8, 4]) r.lengthBonus[l] = ((p.lengthBonus[l] ?? 0) + (q.lengthBonus[l] ?? 0)) / 2;
    r.maxBars = Math.min(p.maxBars, q.maxBars);
    r.switchBias = (p.switchBias + q.switchBias) / 2;
    r.echoBias = (p.echoBias + q.echoBias) / 2;
    r.spinBias = (p.spinBias + q.spinBias) / 2;
    r.dropWeight = q.dropWeight;
    r.blendLimit = Math.min(p.blendLimit, q.blendLimit);
    r.eq = p.eq === 'smooth' || q.eq === 'smooth' ? 'smooth' : (p.eq === 'filter' || q.eq === 'filter' ? 'filter' : 'swap');
    r.thinOut = p.thinOut && q.thinOut;
    r.reverbTail = p.reverbTail || q.reverbTail;
    r.vocalWeight = Math.max(p.vocalWeight, q.vocalWeight);
    r.shapes = q.shapes;
    r.pacing = p.pacing ?? q.pacing;
    r.dropToDrop = Math.max(p.dropToDrop, q.dropToDrop);
    if (!Genre.isNeighbor(a, b)) {
      r.lengthBonus[32] = (r.lengthBonus[32] ?? 0) - 0.4;
      r.lengthBonus[16] = (r.lengthBonus[16] ?? 0) - 0.15;
      r.switchBias += 0.7;
      r.echoBias += 0.4;
    }
    return r;
  },
};

// MARK: - Set arc / mix style

export type SetArc = 'none' | 'rise' | 'peak';
export const setArcs: SetArc[] = ['none', 'rise', 'peak'];
export const Arc = {
  title: (a: SetArc) => ({ none: L('つなぎやすさ優先', 'Smoothest Order'), rise: L('だんだん盛り上げる', 'Keep Building'), peak: L('山を作る（最後は落ち着ける）', 'Peak, Then Wind Down') })[a],
  target(a: SetArc, x: number): number | null {
    switch (a) {
      case 'none': return null;
      case 'rise': return 0.1 + 0.85 * x;
      case 'peak': return x < 0.7 ? 0.2 + 0.8 * x / 0.7 : 1 - 0.6 * (x - 0.7) / 0.3;
    }
  },
};

export type MixStyle = 'auto' | 'long' | 'quick';
export const mixStyles: MixStyle[] = ['auto', 'long', 'quick'];
export const MixStyles = {
  title: (s: MixStyle) => ({ auto: L('自動', 'Auto'), long: L('じっくりつなぐ', 'Long Blends'), quick: L('カットインで畳みかける', 'Quick Cuts') })[s],
  detail: (s: MixStyle) => ({
    auto: L('曲のジャンル・展開の速さ・テンポの揺れから自動で選び、つなぎ方もジャンルごとに変えます。', 'Picked from the genres, how fast the tracks change and whether their tempo moves; each genre is mixed its own way.'),
    long: L('ハウス・テクノ・UKG などで、EQ を入れ替えながら長く重ねます。', 'House / techno / UKG style: long overlaps with EQ hand-overs.'),
    quick: L('Dariacore・マッシュアップ系向け。各曲のおいしい 8〜16 小節だけを使い、小節頭のカットインでテンポごと切り替えます。', 'For Dariacore / mashups: each track\'s best 8–16 bars, switched on the downbeat with cut-ins (tempo changes with them).'),
  })[s],
};

// MARK: - Planner

const S = Structure;

export const AutoMixer = {
  planPair(a: TrackStructure, b: TrackStructure, aMin: number, keyClash: boolean, tempoRatio: number, pf = Profiles.neutral(), vocals = new Vocals()) {
    return AutoMixer.planOptions(a, b, aMin, keyClash, tempoRatio, pf, vocals, 1)[0] ?? null;
  },

  /** The best few distinct plans, best first (the checker falls back to the next one when a plan fails). */
  planOptions(a: TrackStructure, b: TrackStructure, aMin: number, keyClash: boolean, tempoRatio: number,
    pf = Profiles.neutral(), vocals = new Vocals(), count = 4, landing: number | null = null): AutoMixPlan[] {
    const all = candidates(a, b, aMin, keyClash, tempoRatio, pf, vocals, landing);
    const picked: Candidate[] = [];
    for (const c of [...all].sort((x, y) => y.score - x.score)) {
      if (picked.some(p => p.special === c.special && Math.abs(p.m - c.m) < 4 && Math.abs(p.i - c.i) < 4 && p.l === c.l)) continue;
      picked.push(c);
      if (picked.length >= count) break;
    }
    return picked.map(c => finish(c, a, b, keyClash, pf));
  },

  /** Distinct ways to connect the two tracks, each the best of its kind. */
  planVariations(a: TrackStructure, b: TrackStructure, aMin: number, keyClash: boolean, tempoRatio: number,
    profile = Profiles.neutral(), vocals = new Vocals(), landing: number | null = null): AutoMixPlan[] {
    const pf = { ...profile, maxBars: 32 };
    const all = candidates(a, b, aMin, keyClash, tempoRatio, pf, vocals, landing).sort((x, y) => y.score - x.score);
    const top = all[0];
    if (!top) return [];
    const out: [string, Candidate][] = [[L('おすすめ', 'Recommended'), top]];
    const add = (label: string, where: (c: Candidate) => boolean) => {
      const c = all.find(where);
      if (!c) return;
      if (out.some(([, o]) => o.special === c.special && o.m === c.m && o.i === c.i && o.l === c.l)) return;
      out.push([label, c]);
    };
    add(L('長く重ねる', 'Long Blend'), c => c.special == null && c.l >= 16);
    add(L('短く重ねる', 'Short Blend'), c => c.special == null && c.l <= 8);
    add(L('ドロップでカットイン', 'Cut on the Drop'), c => c.special === 'cut');
    add(L('エコーで抜く', 'Echo Out'), c => c.special === 'echoOut');
    add(L('バックスピン／ブレーキ', 'Backspin / Brake'), c => c.special === 'backspin' || c.special === 'brake');
    add(L('別の位置から入る', 'Different Entry'), c => Math.abs(c.i - top.i) >= 8);
    add(L('早めに抜ける', 'Earlier Exit'), c => c.m <= top.m - 8);
    return out.map(([label, c]) => ({ ...finish(c, a, b, keyClash, pf), label }));
  },

  /** Average number of bands per beat in which both tracks are clearly audible at similar levels during the overlap. */
  clutter(a: TrackStructure, m: number, b: TrackStructure, i: number, l: number, shape: TransitionShape): number {
    if (l <= 0) return 0;
    const steps = l * 4;
    const killDB = [-40, -24, -40], weight = [1.5, 1, 1];
    let total = 0;
    for (let s = 0; s < steps; s++) {
      const x = (s + 0.5) / steps;
      const ci = Automation.incoming('bassSwap', shape, x);
      const co = Automation.outgoing('bassSwap', shape, x);
      const ba = m + Math.floor(s / 4), bb = i + Math.floor(s / 4);
      if (ba < 0 || ba >= a.barCount || bb < 0 || bb >= b.barCount) continue;
      const la = [a.low[ba], a.full[ba], a.high[ba]], lb = [b.low[bb], b.full[bb], b.high[bb]];
      const ka = [co.lowKill, co.midKill, co.highKill], kb = [ci.lowKill, ci.midKill, ci.highKill];
      const va = 20 * Math.log10(Math.max(co.volume, 1e-4)), vb = 20 * Math.log10(Math.max(ci.volume, 1e-4));
      for (let band = 0; band < 3; band++) {
        const ea = la[band] + va + killDB[band] * ka[band];
        const eb = lb[band] + vb + killDB[band] * kb[band];
        if (ea > -24 && eb > -24 && Math.abs(ea - eb) < 8) total += weight[band];
      }
    }
    return total / steps;
  },

  // MARK: Running order

  transitionCost(a: OrderItem, b: OrderItem): number {
    let c = 0;
    const aOpts = [a.bpm, ...(a.bpmOptions ?? [])], bOpts = [b.bpm, ...(b.bpmOptions ?? [])];
    let d = Infinity;
    for (const x of aOpts) for (const y of bOpts) d = Math.min(d, Math.abs(Math.log(Math.max(1, y) / Math.max(1, x))));
    c += 25 * d;
    if (d > 0.08) c += 2;
    if (b.bpm < a.bpm - 1) c += 0.3;
    const ka = a.key, kb = b.key;
    if (ka && kb && ka.confidence > 0.5 && kb.confidence > 0.5) {
      if (!Key.isCompatible(ka, kb)) {
        const x = Key.camelotNumber(ka), y = Key.camelotNumber(kb);
        const dist = Math.min((x - y + 12) % 12, (y - x + 12) % 12);
        c += ka.minor === kb.minor ? 0.6 * dist : 0.8 + 0.4 * dist;
      }
    } else {
      c += 0.3;
    }
    if (a.genre && b.genre && a.genre !== b.genre) c += Genre.isNeighbor(a.genre, b.genre) ? 0.4 : 1.2;
    if (a.outroBars >= 8 && b.introBars >= 8) c -= 0.5;
    return c;
  },

  /** Order with the smallest total transition cost (exact up to 12 tracks, heuristic beyond). */
  bestOrder(items: OrderItem[], arc: SetArc = 'none'): number[] {
    const n = items.length;
    const known = items.map((_, k) => k).filter(k => items[k].energy != null).sort((x, y) => items[x].energy! - items[y].energy!);
    const rank: (number | null)[] = new Array(n).fill(null);
    known.forEach((k, r) => { rank[k] = known.length > 1 ? r / (known.length - 1) : 0.5; });
    const arcCost = (k: number, pos: number) => {
      const r = rank[k];
      if (n <= 1 || r == null) return 0;
      const t = Arc.target(arc, pos / (n - 1));
      return t == null ? 0 : 3 * (r - t) * (r - t);
    };
    if (n <= 2) {
      if (n === 2) {
        const ab = AutoMixer.transitionCost(items[0], items[1]) + arcCost(0, 0) + arcCost(1, 1);
        const ba = AutoMixer.transitionCost(items[1], items[0]) + arcCost(1, 0) + arcCost(0, 1);
        return ab <= ba ? [0, 1] : [1, 0];
      }
      return items.map((_, k) => k);
    }
    const cost = items.map((x, i) => items.map((y, j) => (i === j ? 0 : AutoMixer.transitionCost(x, y))));
    const minBPM = Math.min(...items.map(x => x.bpm));
    const startCost = items.map((x, k) => (arc === 'none' ? 0.05 * (x.bpm - minBPM) : 0) + arcCost(k, 0));
    if (n <= 12) {
      const full = 1 << n;
      const dp = new Float64Array(full * n).fill(Infinity);
      const parent = new Int32Array(full * n).fill(-1);
      for (let i = 0; i < n; i++) dp[(1 << i) * n + i] = startCost[i];
      const popcount = (v: number) => { let c = 0; while (v) { v &= v - 1; c++; } return c; };
      for (let mask = 1; mask < full; mask++) {
        const pos = popcount(mask);
        for (let last = 0; last < n; last++) {
          if (!(mask & (1 << last))) continue;
          const cur = dp[mask * n + last];
          if (cur === Infinity) continue;
          for (let next = 0; next < n; next++) {
            if (mask & (1 << next)) continue;
            const nm = mask | (1 << next);
            const v = cur + cost[last][next] + arcCost(next, pos);
            if (v < dp[nm * n + next]) { dp[nm * n + next] = v; parent[nm * n + next] = last; }
          }
        }
      }
      let last = 0;
      for (let k = 1; k < n; k++) if (dp[(full - 1) * n + k] < dp[(full - 1) * n + last]) last = k;
      let mask = full - 1;
      const path: number[] = [];
      while (last >= 0) {
        path.push(last);
        const p = parent[mask * n + last];
        mask &= ~(1 << last);
        last = p;
      }
      return path.reverse();
    }
    const total = (p: number[]) => {
      let t = startCost[p[0]];
      for (let k = 1; k < p.length; k++) t += cost[p[k - 1]][p[k]] + arcCost(p[k], k);
      return t;
    };
    let best = items.map((_, k) => k);
    let bestCost = total(best);
    for (let s = 0; s < n; s++) {
      const path = [s];
      const used = new Set([s]);
      while (path.length < n) {
        const last = path[path.length - 1], pos = path.length;
        let next = -1, nv = Infinity;
        for (let k = 0; k < n; k++) {
          if (used.has(k)) continue;
          const v = cost[last][k] + arcCost(k, pos);
          if (v < nv) { nv = v; next = k; }
        }
        path.push(next); used.add(next);
      }
      const c = total(path);
      if (c < bestCost) { best = path; bestCost = c; }
    }
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
          const c = total(cand);
          if (c + 1e-9 < bestCost) { best = cand; bestCost = c; improved = true; }
        }
      }
    }
    return best;
  },

  // MARK: Quick cuts

  looksQuick(s: TrackStructure, tempoVaries: boolean): boolean {
    const span = Math.max(1, s.musicEnd - s.musicStart);
    const avgSection = span / Math.max(1, s.sections.length);
    const fit = S.gridFit(s, s.musicStart, s.musicEnd);
    return tempoVaries || fit < 0.8 || (avgSection <= 10 && s.bpm >= 140);
  },

  quickWindowBars(s: TrackStructure): number[] {
    const ok = [8, 12, 16].filter(n => n * s.barSeconds >= 9 && n * s.barSeconds <= 30);
    return ok.length ? ok : [8];
  },

  highlight(s: TrackStructure, lengths: number[], within: [number, number] | null = null): Highlight | null {
    let best: Highlight | null = null;
    for (const len of lengths) {
      const h = AutoMixer.highlightBars(s, len, within);
      if (!h) continue;
      h.score += 0.08 * (len - 8);
      if (!best || h.score > best.score) best = h;
    }
    return best;
  },

  highlightBars(s: TrackStructure, len: number, within: [number, number] | null = null): Highlight | null {
    const lo = Math.max(s.musicStart, within?.[0] ?? s.musicStart);
    const hi = Math.min(s.musicEnd, within?.[1] ?? s.musicEnd) - len;
    if (hi < lo) return null;
    const starts = new Set(S.gridBars(s, lo, hi, 4));
    for (const c of s.cueBars) if (Math.trunc(c.bar) >= lo && Math.trunc(c.bar) <= hi) starts.add(Math.trunc(c.bar));
    for (const sec of s.sections) if (sec.start >= lo && sec.start <= hi) starts.add(sec.start);
    starts.add(lo);
    const boundaries = new Set([...s.sections.map(x => x.start), ...s.sections.map(x => x.end)]);
    let best: Highlight | null = null;
    for (const c of [...starts].sort((x, y) => x - y)) {
      let sc = 0;
      const why: string[] = [];
      let energy = 0, bass = 0;
      for (let b = c; b < c + len; b++) { energy += S.energy(s, b); if (S.hasBass(s, b)) bass++; }
      energy /= len;
      sc += 0.25 * Math.max(-20, energy);
      sc += 1.0 * (bass / len);
      const sec = S.sectionAt(s, c);
      if (sec) {
        if (sec.kind === 'drop' && sec.start === c) {
          sc += 1.2;
          why.push(L(`ドロップ頭（${c + 1}小節目）から`, `From the top of a drop (bar ${c + 1})`));
        } else if (sec.kind === 'drop') sc += 0.5;
        else if (sec.kind === 'intro' || sec.kind === 'outro') sc -= 0.8;
      }
      const cue = S.cueStrength(s, c);
      sc += 1.5 * cue + 0.6 * S.cueStrength(s, c + len);
      if (cue > 0.5) why.push(L('AI の CUE 候補の位置で入る', 'Enters on an AI cue point'));
      if (boundaries.has(c + len)) sc += 1;
      if (S.isPhraseStart(s, c)) sc += 0.3;
      const fit = S.gridFit(s, c, c + len);
      if (fit < 0.7) sc -= 4;
      sc += 2 * (fit - 0.85);
      sc -= 0.004 * (c - lo);
      if (!best || sc > best.score) best = { start: c, end: c + len, score: sc, reasons: why };
    }
    return best;
  },

  /** How a quick-cut mix switches from `a` (leaving at its bar `out`) to `b`. */
  quickTransition(a: TrackStructure, out: number, b: TrackStructure, index: number): { style: TransitionStyle; bars: number; roll: boolean; reasons: string[] } {
    const ratio = b.bpm / Math.max(a.bpm, 1);
    const aFull = S.hasBass(a, out - 1);
    if (ratio < 0.86) {
      return { style: 'brake', bars: 0, roll: false, reasons: [L(`BPM が大きく下がる（${Math.round(a.bpm)}→${Math.round(b.bpm)}）のでブレーキで止めてから切り替え`, `Big tempo drop (${Math.round(a.bpm)} → ${Math.round(b.bpm)}): brake, then switch`)] };
    }
    if (aFull && index % 4 === 3) return { style: 'backspin', bars: 0, roll: false, reasons: [L('盛り上がったところでバックスピンして次の曲へ', 'Spin back at full energy into the next track')] };
    if (aFull && index % 5 === 4) return { style: 'echoOut', bars: 1, roll: false, reasons: [L('エコーで残響だけ残して次の曲へ', 'Echo out into the next track')] };
    const roll = aFull && (index % 3 === 1 || ratio > 1.15);
    const why = [L('小節頭でカットイン', 'Cut in on the downbeat')];
    if (roll) why.push(L('切り替え直前の 2 拍をロールで刻む', 'A roll over the last two beats before the cut'));
    return { style: 'cut', bars: 0, roll, reasons: why };
  },
};

export interface Highlight { start: number; end: number; score: number; reasons: string[] }

export interface OrderItem {
  bpm: number;
  bpmOptions?: number[];
  key: MusicalKey | null;
  introBars: number;
  outroBars: number;
  genre?: MixGenre | null;
  energy?: number | null;
}

function candidates(a: TrackStructure, b: TrackStructure, aMin: number, keyClash: boolean, tempoRatio: number,
  pf: MixProfile, vocals: Vocals, landing: number | null): Candidate[] {
  const aEnd = a.musicEnd;
  const aLanding = landing ?? (aMin - 8);
  const pacingScore = (e: number, m: number, landsOnDrop: boolean, why: string[]) => {
    const target = pf.pacing;
    if (target == null) return 0;
    let sc = 0;
    const played = (e - aLanding) * a.barSeconds;
    sc -= 0.06 * Math.max(0, Math.abs(played - target) - 16) / Math.max(a.barSeconds, 0.5);
    const sec = S.sectionAt(a, m);
    if (sec && sec.kind === 'drop' && S.hasBass(a, m) && landsOnDrop && e <= sec.end) {
      sc += pf.dropToDrop;
      const min = Math.round(target / 60);
      why.push(L(`前の曲が盛り上がっている途中で次の曲のドロップへつなぐ（1曲あたり約${min}分）`, `Leaves the previous track while it is still in a drop and lands on the next drop (about ${min} min per track)`));
    }
    return sc;
  };
  const aOut = a.lastDropEnd;
  const bStart = b.musicStart, bDrop = b.firstDrop;
  const aFloor = Math.max(aMin, a.musicStart + 8);
  const dropStarts = new Set(b.sections.filter(x => x.kind === 'drop').map(x => x.start));
  const all: Candidate[] = [];
  const probe = Shape.layered(0.5);
  const vocalClash = (m: number, i: number, l: number) => {
    if (!vocals.a || !vocals.b || l <= 0) return 0;
    let w = 0;
    for (let k = 0; k < l; k++) {
      const x = (k + 0.5) / l;
      const open = x > 0.3 && x < 0.8 ? 1 : 0.4;
      if (vocals.va(m + k) > 0.6 && vocals.vb(i + k) > 0.6) w += open;
    }
    return w / l;
  };

  for (const l of [32, 16, 8, 4]) {
    if (tempoRatio > pf.blendLimit) continue;
    if (tempoRatio > 1.06 && l > 8) continue;
    if (l > pf.maxBars) continue;
    for (const m of S.gridBars(a, aFloor, aEnd - l, 4)) {
      for (const i of S.gridBars(b, bStart - 3, Math.min(b.barCount - l - 8, bDrop + 8), 4)) {
        let sc = 0;
        const why: string[] = [];
        const land = i + l, e = m + l;
        if (land === bDrop) {
          sc += 2.4 * pf.dropWeight;
          why.push(L(`次の曲の最初のドロップ（${bDrop + 1}小節目）で切り替え完了`, `Lands on the next track’s first drop (bar ${bDrop + 1})`));
        } else if (dropStarts.has(land)) {
          sc += 1.2 * pf.dropWeight;
          why.push(L(`次の曲のドロップ頭（${land + 1}小節目）で切り替え完了`, `Lands on a drop of the next track (bar ${land + 1})`));
        } else if (S.isPhraseStart(b, land)) {
          sc += 0.4;
          if (land < bDrop && land >= bDrop - 16) sc += 0.6;
        }
        const cueIn = S.cueStrength(b, i), cueOut = S.cueStrength(a, m), cueLand = S.cueStrength(b, land);
        sc += 0.7 * cueIn + 0.6 * cueOut + 0.4 * cueLand;
        if (cueIn > 0.5) why.push(L(`次の曲はプロDJが CUE を置きやすい位置（${i + 1}小節目・AI予測）から入る`, `The next track enters where pro DJs tend to set a cue (bar ${i + 1}, AI-predicted)`));
        if (i > bDrop) sc -= 0.15 * (i - bDrop);
        if (i > bStart) sc -= 0.02 * Math.min(i - bStart, Math.max(0, bDrop - bStart));
        if (pf.pacing == null) {
          if (Math.abs(e - aEnd) <= 1) {
            sc += 2;
            why.push(L('前の曲は音が終わるところまで使う', 'Plays the previous track to the end of its music'));
          } else if (e === aOut) {
            sc += 1.5;
            why.push(L('前の曲は最後のドロップが終わる所で抜ける', 'The previous track leaves as its last drop ends'));
          }
          if (m === aOut && aEnd - aOut >= 4) {
            sc += 1.5;
            why.push(L(`前の曲のアウトロ（${aOut + 1}小節目〜）に重ねる`, `Blends over the previous track’s outro (from bar ${aOut + 1})`));
          }
          if (e < aOut) sc -= 0.12 * (aOut - e);
        } else {
          sc += pacingScore(e, m, dropStarts.has(land), why);
        }
        sc -= 0.02 * Math.max(0, aEnd - Math.max(e, aOut));
        sc -= 3 * AutoMixer.clutter(a, m, b, i, l, probe);
        let sparse = 0;
        for (let k = 0; k < l; k++) if (!S.hasBass(a, m + k) && !S.hasBass(b, i + k)) sparse++;
        sc += 0.02 * sparse;
        sc += pf.lengthBonus[l] ?? 0;
        if (keyClash) sc -= 0.02 * l;
        if (tempoRatio > 1.06) sc -= 0.03 * l;
        if (S.isPhraseStart(a, m)) sc += 0.3;
        if (S.isPhraseStart(b, i)) sc += 0.3;
        const vc = vocalClash(m, i, l);
        if (vc > 0) {
          sc -= 2.5 * vc * pf.vocalWeight;
          if (vc > 0.3) why.push(L(`歌が少し重なる（重なりの ${Math.round(vc * 100)}%）`, `Vocals overlap a little (${Math.round(vc * 100)}% of the blend)`));
        } else if (vocals.a && vocals.b) {
          let aSings = false, bSings = false;
          for (let k = 0; k < l; k++) { if (vocals.va(m + k) > 0.6) aSings = true; if (vocals.vb(i + k) > 0.6) bSings = true; }
          if (aSings && bSings) why.push(L('両方の歌が重ならない位置で重ねる', 'Placed so the two vocals don\'t overlap'));
        }
        all.push({ m, i, l, score: sc, reasons: why, special: null });
      }
    }
  }

  // Cut or echo out on a phrase, straight into the next track.
  const bPhraseIn = b.phraseOffset + 8 * Math.floor((bStart - b.phraseOffset) / 8);
  for (const m of S.gridBars(a, aFloor, aEnd, 8)) {
    for (const i of [...new Set([bDrop, bPhraseIn])].sort((x, y) => x - y)) {
      for (const [l, style] of [[0, 'cut'], [2, 'echoOut'], [0, 'brake'], [0, 'backspin']] as [number, TransitionStyle][]) {
        let sc = -2.5 + pf.switchBias;
        if (style === 'echoOut') sc += pf.echoBias;
        if (style === 'brake' || style === 'backspin') sc += pf.spinBias;
        const why: string[] = [];
        if (i === bDrop) {
          sc += 1.2;
          why.push(L(`次の曲のドロップ頭（${bDrop + 1}小節目）へ切り替え`, `Switches straight into the next track’s drop (bar ${bDrop + 1})`));
        }
        const aInDrop = S.hasBass(a, m - 1);
        if (style === 'echoOut' && aInDrop) {
          sc += 0.6;
          why.push(L('前の曲は盛り上がったまま終わるのでエコーで抜く', 'The previous track ends at full energy, so it is echoed out'));
        }
        if (style === 'cut' && !aInDrop) sc += 0.4;
        sc += 0.6 * S.cueStrength(b, i) + 0.5 * S.cueStrength(a, m);
        if (style === 'brake' || style === 'backspin') {
          const goingDown = b.bpm < a.bpm;
          if (tempoRatio > 1.08) {
            const fits = (style === 'brake') === goingDown;
            sc += fits ? 1.9 : 1.1;
            why.push(style === 'brake'
              ? L(`BPM が大きく下がる（${Math.round(a.bpm)}→${Math.round(b.bpm)}）ので、ブレーキで止めてから次の曲へ`, `Big tempo drop (${Math.round(a.bpm)} → ${Math.round(b.bpm)}): brake to a stop, then drop the next track`)
              : L(`BPM が大きく違う（${Math.round(a.bpm)}→${Math.round(b.bpm)}）ので、バックスピンで切り替え`, `Big tempo jump (${Math.round(a.bpm)} → ${Math.round(b.bpm)}): backspin into the next track`));
            if (aInDrop) sc += 0.3;
          } else {
            sc -= 0.8;
          }
        } else if (tempoRatio > 1.08 && style === 'cut') {
          sc += 0.8;
        }
        if (pf.pacing == null) {
          if (Math.abs(m - aEnd) <= 1) sc += 1.5; else if (m === aOut) sc += 1.2;
          if (m < aOut) sc -= 0.12 * (aOut - m);
        } else {
          sc += pacingScore(m, Math.max(0, m - 1), dropStarts.has(i), why);
        }
        sc -= 0.02 * Math.max(0, aEnd - Math.max(m, aOut));
        if (style !== 'echoOut' && vocals.va(m - 1) > 0.6 && vocals.va(m) > 0.6) {
          sc -= 0.8 * pf.vocalWeight;
          why.push(L('（前の曲の歌の途中で切り替わる）', '(cuts into the previous track\'s vocal line)'));
        }
        if (vocals.vb(i - 1) > 0.6 && vocals.vb(i) > 0.6) sc -= 0.3 * pf.vocalWeight;
        all.push({ m, i, l, score: sc, reasons: why, special: style });
      }
    }
  }
  return all;
}

function finish(c: Candidate, a: TrackStructure, b: TrackStructure, keyClash: boolean, pf: MixProfile): AutoMixPlan {
  const bStart = b.musicStart, bDrop = b.firstDrop;
  const reasons = [...c.reasons];
  if (c.i > bStart + 3 && c.i < bDrop) reasons.push(L(`次の曲のイントロ前半は省略（${c.i + 1}小節目から）`, `Skips the start of the next track’s intro (enters at bar ${c.i + 1})`));
  if (keyClash && a.key && b.key) reasons.push(L(`キーの相性が良くない（${Key.camelot(a.key)}→${Key.camelot(b.key)}）ので重ねる長さは控えめ`, `Keys clash (${Key.camelot(a.key)} → ${Key.camelot(b.key)}), so the overlap is kept short`));
  if (c.special) return { outBar: c.m, inBar: c.i, length: c.l, style: c.special, shape: null, score: c.score, reasons };
  const l = c.l;
  const aBass = Array.from({ length: l }, (_, k) => S.hasBass(a, c.m + k));
  const bBass = Array.from({ length: l }, (_, k) => S.hasBass(b, c.i + k));
  let k = Math.trunc(l / 2);
  const firstBass = bBass.findIndex((v, j) => v && (j + 1 >= l || bBass[j + 1]));
  if (firstBass > 0) k = firstBass;
  if (l >= 8) k = 4 * Math.round(k / 4);
  k = Math.min(Math.max(l >= 8 ? 4 : 1, k), Math.max(1, l - (l >= 8 ? 4 : 1)));
  const p = k / l;
  let style: TransitionStyle, shape: TransitionShape;
  if (aBass.includes(true) && bBass.includes(true)) {
    style = 'bassSwap';
    shape = Shapes.apply(pf.shapes, Shape.layered(p));
    reasons.push(L(`両方に低音があるので、${k + 1}小節目で低音を一気に入れ替え`, `Both have bass, so the low end is swapped at bar ${k + 1} of the blend`));
  } else if ((keyClash || pf.eq === 'filter') && l >= 8 && pf.eq !== 'smooth') {
    style = 'filter';
    shape = Shapes.apply(pf.shapes, Shape.filterOut(p));
    reasons.push(L('前の曲をフィルターで抜いて和音のぶつかりを抑える', 'Filters the previous track out to hide the key clash'));
  } else {
    style = 'crossfade';
    shape = Shapes.apply(pf.shapes, Shape.blend(p));
    reasons.push(L('低音がぶつからないので、EQ をなだらかに入れ替えるクロスフェード', 'No clashing bass: a crossfade with a gentle EQ hand-over'));
  }
  if (Shapes.learned(pf.shapes)) reasons.push(L('EQ の動かし方は参照ミックスから学習した値', 'EQ moves follow curves learned from reference mixes'));
  reasons.push(L(`次の曲は低音・中音を切った状態で静かに入り、${k + 1}小節目までは前の曲が主役`, `The next track sneaks in with its lows and mids cut; the previous track leads until bar ${k + 1}`));
  return { outBar: c.m, inBar: c.i, length: l, style, shape, score: c.score, reasons };
}
