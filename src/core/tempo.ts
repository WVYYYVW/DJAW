// Port of mac/DJAW/Model/TempoFX.swift.
import { L } from './i18n';
import {
  Clip, ClipFX, FXKind, FXShape, TransitionStyle, Style, elapsedAtBar, hasEdits, timelineTimeOfBar, uuid,
} from './models';

// MARK: - Tempo map

export interface TempoPoint { t: number; bpm: number }

/**
 * Mix tempo over time. The timeline is measured in *reference* seconds (seconds at the base master BPM); the map
 * warps reference time into real (heard) time for playback, export and the clocks.
 */
export class TempoMap {
  readonly reference: number;
  readonly points: TempoPoint[];
  private readonly realAt: number[];

  constructor(reference: number, points: TempoPoint[] = []) {
    const m = Math.max(reference, 1);
    this.reference = m;
    const pts = [...points].sort((a, b) => a.t - b.t).filter(p => p.t >= 0);
    if (pts.length === 0 || pts[0].t > 0) pts.unshift({ t: 0, bpm: pts[0]?.bpm ?? m });
    this.points = pts;
    const r = [0];
    for (let k = 1; k < pts.length; k++) r.push(r[k - 1] + TempoMap.span(m, pts[k - 1], pts[k], pts[k].t - pts[k - 1].t));
    this.realAt = r;
  }

  get isConstant() { return this.points.every(p => Math.abs(p.bpm - this.reference) < 0.0001); }
  get hasChanges() { return this.points.some(p => Math.abs(p.bpm - this.points[0].bpm) > 0.0001); }

  equals(o: TempoMap) {
    return this.reference === o.reference && this.points.length === o.points.length
      && this.points.every((p, i) => p.t === o.points[i].t && p.bpm === o.points[i].bpm);
  }

  /** Real seconds for `u` reference seconds into the segment a → b. */
  private static span(m: number, a: TempoPoint, b: TempoPoint, u: number) {
    const len = b.t - a.t;
    const d = b.bpm - a.bpm;
    if (len < 1e-9 || Math.abs(d) < 1e-9) return u * m / a.bpm;
    const tu = a.bpm + d * u / len;
    return m * len / d * Math.log(tu / a.bpm);
  }

  private segment(t: number) {
    let lo = 0, hi = this.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.points[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Mix BPM at reference time `t`. */
  bpm(t: number) {
    const k = this.segment(t);
    if (!(k + 1 < this.points.length && t >= this.points[k].t)) return this.points[k].bpm;
    const a = this.points[k], b = this.points[k + 1];
    const len = b.t - a.t;
    if (!(len > 1e-9)) return b.bpm;
    return a.bpm + (b.bpm - a.bpm) * Math.min(1, (t - a.t) / len);
  }

  /** Reference → real seconds. */
  real(t: number) {
    const p = this.points, m = this.reference;
    if (p.length === 1) return t * m / p[0].bpm;
    const k = this.segment(t);
    if (t < p[0].t) return this.realAt[0] + (t - p[0].t) * m / p[0].bpm;
    if (k + 1 >= p.length) return this.realAt[k] + (t - p[k].t) * m / p[k].bpm;
    return this.realAt[k] + TempoMap.span(m, p[k], p[k + 1], t - p[k].t);
  }

  /** Real → reference seconds. */
  referenceAtReal(r: number) {
    const p = this.points, m = this.reference;
    if (p.length === 1) return r * p[0].bpm / m;
    if (r < this.realAt[0]) return p[0].t + (r - this.realAt[0]) * p[0].bpm / m;
    let k = 0;
    while (k + 1 < p.length && this.realAt[k + 1] <= r) k++;
    const a = p[k];
    const dr = r - this.realAt[k];
    if (k + 1 >= p.length) return a.t + dr * a.bpm / m;
    const b = p[k + 1];
    const len = b.t - a.t;
    const d = b.bpm - a.bpm;
    if (len < 1e-9 || Math.abs(d) < 1e-9) return a.t + dr * a.bpm / m;
    const tu = a.bpm * Math.exp(d * dr / (m * len));
    return a.t + (tu - a.bpm) * len / d;
  }

  /** A track with its own `tempo` changes the mix BPM from where it comes in, ramping over `tempoBars`. */
  static build(clips: Clip[], master: number): TempoMap {
    const m = Math.max(master, 1);
    const barRef = 240 / m;
    const pts: TempoPoint[] = [{ t: 0, bpm: m }];
    let current = m;
    clips.forEach((c, i) => {
      if (i === 0) return;
      const target = c.tempo;
      if (!(target != null && target > 20 && Math.abs(target - current) > 0.0001)) return;
      const anchor = timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c), m);
      const bars = Math.max(0, tempoRampBars(c));
      const last = pts[pts.length - 1].t;
      const r0 = Math.max(anchor, last);
      const r1 = r0 + bars * barRef;
      if (r0 > last + 1e-6) pts.push({ t: r0, bpm: current });
      pts.push({ t: Math.max(r1, r0 + 1e-4), bpm: target });
      current = target;
    });
    return new TempoMap(m, pts);
  }
}

/** This track's bars from where it comes in to where its tempo change starts. */
export function tempoStartBars(c: Clip) {
  const s = c.tempoStart;
  if (s === 'afterTransition') return Style.isCutLike(c.transition) ? 0 : Math.max(0, c.transitionBars);
  if (typeof s === 'number' && s > 0) return s;
  return 0;
}

/** Bars the tempo change into this track takes (0 = instant at the switch). */
export function tempoRampBars(c: Clip) {
  if (c.tempoBars != null) return c.tempoBars;
  return Style.isCutLike(c.transition) ? 0 : c.transitionBars;
}

export interface OutroFX {
  kind: TransitionStyle;
  /** Elapsed source seconds where the effect replaces the track's audio. */
  elapsedStart: number;
  /** Source seconds the effect lasts (it ends at the switch). */
  length: number;
}

/** Turntable ending (brake / backspin) this track performs before `next` comes in. */
export function outro(c: Clip, next: Clip | undefined | null): OutroFX | null {
  if (!next || !(next.transition === 'brake' || next.transition === 'backspin') || !(c.bpm > 1)) return null;
  const beats = next.spinBeats ?? Style.defaultSpinBeats(next.transition);
  const len = beats * 60 / c.bpm;
  const eOut = elapsedAtBar(c, c.mixOutBar);
  const start = Math.max(0, eOut - len);
  if (!(eOut - start > 0.02)) return null;
  return { kind: next.transition, elapsedStart: start, length: eOut - start };
}

void hasEdits;

// MARK: - Effects

export const fxKinds: FXKind[] = ['lowPass', 'highPass', 'echo', 'reverb', 'flanger', 'phaser', 'gate', 'crush', 'roll'];

export const FX = {
  title(k: FXKind) {
    switch (k) {
      case 'lowPass': return L('ローパス', 'Low-pass');
      case 'highPass': return L('ハイパス', 'High-pass');
      case 'echo': return L('エコー', 'Echo');
      case 'reverb': return L('リバーブ', 'Reverb');
      case 'flanger': return L('フランジャー', 'Flanger');
      case 'phaser': return L('フェイザー', 'Phaser');
      case 'gate': return L('トランス（ゲート）', 'Trans (Gate)');
      case 'crush': return L('ビットクラッシャー', 'Bit Crusher');
      case 'roll': return L('ロール', 'Roll');
    }
  },
  short(k: FXKind) {
    return ({ lowPass: 'LPF', highPass: 'HPF', echo: 'ECHO', reverb: 'REVERB', flanger: 'FLANGER', phaser: 'PHASER', gate: 'TRANS', crush: 'CRUSH', roll: 'ROLL' } as const)[k];
  },
  detail(k: FXKind) {
    switch (k) {
      case 'lowPass': return L('高音を削ってこもらせます。徐々に強くすると曲が遠ざかるように聞こえます。', 'Cuts the highs; ramp it up and the track sounds like it walks away.');
      case 'highPass': return L('低音を削って軽くします。つなぎ前のビルドアップの定番。', 'Cuts the lows. The classic build-up before a drop.');
      case 'echo': return L('拍に合わせたやまびこ。', 'Beat-synced delay.');
      case 'reverb': return L('広い空間の響きを足します。', 'Adds a big-room tail.');
      case 'flanger': return L('ジェット機のようなうねり。', 'Jet-plane sweep.');
      case 'phaser': return L('シュワシュワと回るようなうねり。', 'Swirling phase sweep.');
      case 'gate': return L('拍に合わせて音を細かく切ります。', 'Chops the sound in time with the beat.');
      case 'crush': return L('音をざらつかせてローファイにします。', 'Grainy lo-fi distortion.');
      case 'roll': return L('直前の音を短く繰り返します（ループロール）。', 'Repeats a short slice (loop roll).');
    }
  },
  /** Hue for the timeline region. */
  hue(k: FXKind) {
    return ({ lowPass: 0.58, highPass: 0.50, echo: 0.78, reverb: 0.70, flanger: 0.12, phaser: 0.30, gate: 0.95, crush: 0.03, roll: 0.16 } as const)[k];
  },
  /** Beat divisions offered (beats). Empty = no rhythm setting. */
  divisions(k: FXKind): number[] {
    switch (k) {
      case 'echo': return [0.25, 0.5, 0.75, 1];
      case 'gate': case 'roll': return [0.125, 0.25, 0.5, 1];
      case 'flanger': case 'phaser': return [4, 8, 16, 32];
      default: return [];
    }
  },
  defaultDivision(k: FXKind) {
    return ({ echo: 0.75, gate: 0.25, roll: 0.25, flanger: 16, phaser: 8 } as Partial<Record<FXKind, number>>)[k] ?? 1;
  },
  defaultShape(k: FXKind): FXShape {
    if (k === 'lowPass' || k === 'highPass') return 'rise';
    if (k === 'roll' || k === 'gate' || k === 'crush') return 'hold';
    return 'swell';
  },
  defaultAmount(k: FXKind) {
    if (k === 'lowPass' || k === 'highPass') return 0.75;
    if (k === 'crush') return 0.5;
    if (k === 'roll') return 1;
    return 0.6;
  },
  defaultBars(k: FXKind) {
    if (k === 'roll') return 1;
    if (k === 'gate' || k === 'crush') return 2;
    return 4;
  },
  divisionLabel(d: number) {
    if (d >= 1) return d === Math.round(d) ? `${Math.round(d)}` : `${+d.toPrecision(2)}`;
    if (Math.abs(d - 0.75) < 0.001) return '3/4';
    return `1/${Math.round(1 / d)}`;
  },
  make(kind: FXKind, bar: number, opts: { bars?: number; amount?: number; shape?: FXShape; auto?: boolean } = {}): ClipFX {
    return {
      id: uuid(), kind, bar,
      bars: opts.bars ?? FX.defaultBars(kind),
      amount: opts.amount ?? FX.defaultAmount(kind),
      division: FX.defaultDivision(kind),
      shape: opts.shape ?? FX.defaultShape(kind),
      auto: opts.auto ?? null,
    };
  },
  /** Strength at a source bar (0 outside the region). Steady regions get short ramps so nothing clicks. */
  level(fx: ClipFX, b: number) {
    if (!(fx.bars > 0 && b >= fx.bar && b < fx.bar + fx.bars)) return 0;
    const x = (b - fx.bar) / fx.bars;
    let v = FXShapes.level(fx.shape, x);
    if (fx.shape === 'hold' && fx.kind !== 'roll' && fx.kind !== 'gate') {
      const edge = Math.min(0.03, 0.5);
      v *= Math.min(1, x / edge, (1 - x) / edge);
    }
    return Math.max(0, Math.min(1, v)) * fx.amount;
  },
};

export const FXShapes = {
  all: ['hold', 'rise', 'fall', 'swell'] as FXShape[],
  title(s: FXShape) {
    switch (s) {
      case 'hold': return L('一定', 'Steady');
      case 'rise': return L('だんだん強く', 'Build');
      case 'fall': return L('だんだん弱く', 'Fade');
      case 'swell': return L('山なり', 'Swell');
    }
  },
  /** 0...1 strength at progress x (0...1). */
  level(s: FXShape, x: number) {
    switch (s) {
      case 'hold': return 1;
      case 'rise': return x * x * (3 - 2 * x) * 0.85 + x * 0.15;
      case 'fall': return 1 - (x * x * (3 - 2 * x) * 0.85 + x * 0.15);
      case 'swell': return Math.sin(Math.PI * x);
    }
  },
};

/** Effect amounts for one track at one instant (0 = off). Values are Float in Swift. */
export interface FXState {
  /** −1 (low-pass) … +1 (high-pass). */
  filter: number;
  echo: number; echoDiv: number;
  reverb: number;
  flanger: number; flangerDiv: number;
  phaser: number; phaserDiv: number;
  gate: number; gateDiv: number;
  crush: number;
  roll: number; rollDiv: number;
}

export const quietFX = (): FXState => ({
  filter: 0, echo: 0, echoDiv: 0.75, reverb: 0, flanger: 0, flangerDiv: 16, phaser: 0, phaserDiv: 8,
  gate: 0, gateDiv: 0.25, crush: 0, roll: 0, rollDiv: 0.25,
});

export const isQuietFX = (s: FXState) =>
  s.filter === 0 && s.echo === 0 && s.reverb === 0 && s.flanger === 0 && s.phaser === 0 && s.gate === 0 && s.crush === 0 && s.roll === 0;

const f32 = Math.fround;

export function fxStateAt(c: Clip, bar: number): FXState {
  const s = quietFX();
  for (const fx of c.fx ?? []) {
    const v = f32(FX.level(fx, bar));
    if (!(v > 0)) continue;
    const d = f32(fx.division);
    switch (fx.kind) {
      case 'lowPass': if (-v < s.filter) s.filter = -v; break;
      case 'highPass': if (v > s.filter) s.filter = v; break;
      case 'echo': if (v > s.echo) { s.echo = v; s.echoDiv = d; } break;
      case 'reverb': s.reverb = Math.max(s.reverb, v); break;
      case 'flanger': if (v > s.flanger) { s.flanger = v; s.flangerDiv = d; } break;
      case 'phaser': if (v > s.phaser) { s.phaser = v; s.phaserDiv = d; } break;
      case 'gate': if (v > s.gate) { s.gate = v; s.gateDiv = d; } break;
      case 'crush': s.crush = Math.max(s.crush, v); break;
      case 'roll': if (v > s.roll) { s.roll = v; s.rollDiv = d; } break;
    }
  }
  return s;
}
