// Port of mac/DJAW/Model/Models.swift. Values and curves are kept exactly as in the Mac version.
import { L } from './i18n';
import { Automation } from './automation';

export const uuid = () => (globalThis.crypto?.randomUUID?.() ?? require('node:crypto').randomUUID()).toUpperCase();

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// MARK: - Transition

export type TransitionStyle = 'crossfade' | 'bassSwap' | 'filter' | 'echoOut' | 'cut' | 'brake' | 'backspin' | 'custom';
export const transitionStyles: TransitionStyle[] = ['crossfade', 'bassSwap', 'filter', 'echoOut', 'cut', 'brake', 'backspin', 'custom'];

export const Style = {
  title(s: TransitionStyle): string {
    switch (s) {
      case 'crossfade': return L('クロスフェード', 'Crossfade');
      case 'bassSwap': return L('ベーススワップ', 'Bass Swap');
      case 'filter': return L('フィルターアウト', 'Filter Out');
      case 'echoOut': return L('エコーアウト', 'Echo Out');
      case 'cut': return L('カットイン', 'Cut In');
      case 'brake': return L('ブレーキ', 'Brake');
      case 'backspin': return L('バックスピン', 'Backspin');
      case 'custom': return L('カスタム', 'Custom');
    }
  },
  detail(s: TransitionStyle): string {
    switch (s) {
      case 'crossfade': return L('2曲の音量をなめらかに入れ替えます。', 'Smoothly swaps the volume of the two tracks.');
      case 'bassSwap': return L('重ねている途中で低音だけを入れ替え、キックの重なりを防ぎます。', 'Swaps only the low end halfway through so the kicks never clash.');
      case 'filter': return L('前の曲の低音から削りながら抜いていきます。', 'Takes the previous track out by filtering away its low end first.');
      case 'echoOut': return L('前の曲をエコーの残響だけ残して止め、次の曲をカットインします。', 'Stops the previous track leaving only an echo tail, and cuts the next track in.');
      case 'cut': return L('出口の位置で瞬時に切り替えます（重ねません）。', 'Switches instantly at the mix-out point (no overlap).');
      case 'brake': return L('前の曲をターンテーブルを止めるように減速させ、出口で次の曲を落とします。BPM が大きく違う曲へのつなぎにも。', 'Slows the previous track to a stop like a turntable, then drops the next one at the mix-out. Good for big tempo jumps.');
      case 'backspin': return L('前の曲を手で逆回転させて止め、出口で次の曲を落とします。', 'Spins the previous track backwards, then drops the next one at the mix-out.');
      case 'custom': return L('フェーダーと EQ の動きを自分で描いたつなぎです。', 'A transition with hand-drawn fader and EQ moves.');
    }
  },
  isCutLike: (s: TransitionStyle) => s === 'cut' || s === 'brake' || s === 'backspin',
  usesLength: (s: TransitionStyle) => !Style.isCutLike(s),
  spinChoices: (s: TransitionStyle): number[] => (s === 'brake' || s === 'backspin' ? [1, 2, 4] : []),
  defaultSpinBeats: (_s: TransitionStyle) => 2,
  editableVolume: (s: TransitionStyle) => s === 'crossfade' || s === 'bassSwap' || s === 'filter',
  lengthChoices(s: TransitionStyle): number[] {
    switch (s) {
      case 'cut': case 'brake': case 'backspin': return [0];
      case 'echoOut': return [1, 2, 4];
      default: return [4, 8, 16, 32];
    }
  },
};

export interface TransitionPreset {
  id: string; title: string; detail: string; symbol: string; style: TransitionStyle; bars: number;
}

export function transitionPresets(): TransitionPreset[] {
  return [
    { id: 'cut', title: L('カットイン', 'Cut In'), detail: L('出口で瞬時に切替。次の曲のドロップ頭を入口にすると効果的', 'Instant switch at the mix-out. Works best with the mix-in on the next track’s drop'), symbol: 'scissors', style: 'cut', bars: 0 },
    { id: 'echo', title: L('エコーアウト', 'Echo Out'), detail: L('前の曲をエコーで残して次の曲をカットイン（2小節）', 'Echo the previous track out and cut the next one in (2 bars)'), symbol: 'echo', style: 'echoOut', bars: 2 },
    { id: 'quick', title: L('クイックミックス', 'Quick Mix'), detail: L('4小節で素早くクロスフェード', 'Fast 4-bar crossfade'), symbol: 'hare', style: 'crossfade', bars: 4 },
    { id: 'filter', title: L('フィルターアウト', 'Filter Out'), detail: L('8小節で前の曲の低音から抜いていく', 'Filter the previous track out over 8 bars'), symbol: 'filter', style: 'filter', bars: 8 },
    { id: 'bass', title: L('ベーススワップ', 'Bass Swap'), detail: L('16小節重ね、途中で低音を入れ替える定番のつなぎ', 'The classic: 16 bars of overlap with a bass swap'), symbol: 'speaker', style: 'bassSwap', bars: 16 },
    { id: 'long', title: L('ロングミックス', 'Long Mix'), detail: L('32小節かけてゆっくり混ぜる', 'Slow blend over 32 bars'), symbol: 'tortoise', style: 'crossfade', bars: 32 },
  ];
}

export function matchingPreset(style: TransitionStyle, bars: number) {
  return transitionPresets().find(p => p.style === style && Math.abs(p.bars - bars) < 0.01);
}

// MARK: - Loudness / snap

export type LoudnessMode = 'off' | 'match' | 'lufs14' | 'lufs11' | 'lufs9';
export const loudnessModes: LoudnessMode[] = ['off', 'match', 'lufs14', 'lufs11', 'lufs9'];
export const Loudness = {
  title(m: LoudnessMode) {
    switch (m) {
      case 'off': return L('オフ', 'Off');
      case 'match': return L('曲どうしをそろえる', 'Match the tracks');
      case 'lufs14': return '−14 LUFS';
      case 'lufs11': return '−11 LUFS';
      case 'lufs9': return '−9 LUFS';
    }
  },
  detail(m: LoudnessMode) {
    switch (m) {
      case 'off': return L('曲の音量はそのまま', 'Tracks play at their own level');
      case 'match': return L('全体の音量感は保ったまま、曲ごとの差だけをなくします', 'Evens out the tracks around their average level');
      case 'lufs14': return L('配信サービスの基準くらい', 'About streaming-service level');
      case 'lufs11': return L('やや大きめ', 'A bit louder');
      case 'lufs9': return L('クラブ向けの大きめの音量（書き出しの正規化で音割れを防ぎます）', 'Club-loud (export normalization keeps it from clipping)');
    }
  },
  target(m: LoudnessMode): number | null {
    switch (m) {
      case 'lufs14': return -14;
      case 'lufs11': return -11;
      case 'lufs9': return -9;
      default: return null;
    }
  },
};

export type SnapUnit = 'beat' | 'bar' | 'phrase' | 'phrase8';
export const snapUnits: SnapUnit[] = ['beat', 'bar', 'phrase', 'phrase8'];
export const Snap = {
  title(s: SnapUnit) {
    switch (s) {
      case 'beat': return L('1拍', '1 beat');
      case 'bar': return L('1小節', '1 bar');
      case 'phrase': return L('4小節', '4 bars');
      case 'phrase8': return L('8小節', '8 bars');
    }
  },
  bars(s: SnapUnit) {
    switch (s) {
      case 'beat': return 0.25;
      case 'bar': return 1;
      case 'phrase': return 4;
      case 'phrase8': return 8;
    }
  },
};

// MARK: - Effects (TempoFX.swift types used by Clip)

export type FXKind = 'lowPass' | 'highPass' | 'echo' | 'reverb' | 'flanger' | 'phaser' | 'gate' | 'crush' | 'roll';
export type FXShape = 'hold' | 'rise' | 'fall' | 'swell';

export interface ClipFX {
  id: string;
  kind: FXKind;
  bar: number;
  bars: number;
  amount: number;
  division: number;
  shape: FXShape;
  auto?: boolean | null;
}

export type MixGenre = string;

/** Why the auto-mix chose a transition (AutoMixer.swift). Kept as data. */
export interface AutoMixNote {
  text: string;
  style?: TransitionStyle;
  bars?: number;
  inBar?: number;
  [k: string]: unknown;
}

// MARK: - Clip

export interface ClipEdit {
  id: string;
  kind: 'loop' | 'jump';
  /** loop: first bar of the loop. jump: bar where it jumps. */
  bar: number;
  /** loop: loop length. jump: bars skipped. */
  bars: number;
  /** loop: extra passes (1 = the section plays twice in total). */
  repeats: number;
}

export interface CuePoint { id: string; bar: number; label: string }

export interface PlaySegment {
  from: number;
  to: number;
  /** Source seconds played before this piece. */
  elapsed: number;
}

/** One song in the mix. See Models.swift for the meaning of every field. */
export interface Clip {
  id: string;
  /** Absolute path of the audio file on this computer. */
  url: string;
  title: string;
  artist: string;
  duration: number;
  bpm: number;
  firstBeat: number;
  mixInBar: number;
  mixOutBar: number;
  endBar?: number | null;
  transitionBars: number;
  start: number;
  trimStart: number;
  trimEnd: number;
  gainDB: number;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  fadeInBeats: number;
  fadeOutBeats: number;
  tempoSync: boolean;
  transition: TransitionStyle;
  colorIndex: number;
  shape?: TransitionShape | null;
  lanes?: TransitionLanes | null;
  relativePath?: string | null;
  cueDone?: boolean | null;
  transitionDone?: boolean | null;
  autoNote?: AutoMixNote | null;
  mediaID?: string | null;
  edits?: ClipEdit[] | null;
  playLength?: number | null;
  keyLock?: boolean | null;
  keyShift?: number | null;
  tempo?: number | null;
  tempoBars?: number | null;
  spinBeats?: number | null;
  fx?: ClipFX[] | null;
  genre?: MixGenre | null;
  inNudge?: number | null;
  outNudge?: number | null;
  lockedPrevID?: string | null;
  loudnessGainDB?: number | null;
  lufs?: number | null;
  cues?: CuePoint[] | null;
  landingLock?: boolean | null;
  takes?: TransitionTake[] | null;
}

export function newClip(p: { url: string; title: string; artist: string; duration: number; bpm: number; firstBeat: number; trimEnd: number }): Clip {
  return {
    id: uuid(), ...p,
    mixInBar: 0, mixOutBar: 0, endBar: null, transitionBars: 16,
    start: 0, trimStart: 0,
    gainDB: 0, eqLow: 0, eqMid: 0, eqHigh: 0, fadeInBeats: 0, fadeOutBeats: 0,
    tempoSync: true, transition: 'crossfade', colorIndex: 0,
  };
}

export const placeholderClip: Clip = newClip({ url: '', title: '', artist: '', duration: 1, bpm: 120, firstBeat: 0, trimEnd: 1 });

/** Length of one bar in source seconds. */
export const barSource = (c: Clip) => (c.bpm > 1 ? 240 / c.bpm : 2);
export const sourceTimeAtBar = (c: Clip, bar: number) => c.firstBeat + bar * barSource(c);
export const barAtSource = (c: Clip, s: number) => (s - c.firstBeat) / barSource(c);
export const lastBar = (c: Clip) => barAtSource(c, c.duration);
export const hasEdits = (c: Clip) => (c.edits ?? []).length > 0;
export const keepsKey = (c: Clip) => c.keyLock ?? true;
export const semitoneShift = (c: Clip) => c.keyShift ?? 0;
export const landingBar = (c: Clip) => c.mixInBar + c.transitionBars;
export const keepsLanding = (c: Clip) => c.landingLock ?? false;
export const cueList = (c: Clip) => [...(c.cues ?? [])].sort((a, b) => a.bar - b.bar);
export const transitionShape = (c: Clip) => c.shape ?? Shape.defaults(c.transition);

/** Bar of the track (0-based) as a 1-based label, e.g. "97". */
export function barLabel(bar: number): string {
  const n = bar + 1;
  if (Math.abs(n - Math.round(n)) < 0.01) return `${Math.round(n)}`;
  return n.toFixed(2);
}

/** Neutral mix points: play the whole file, no transition. */
export function resetToWholeTrack(c: Clip) {
  c.mixInBar = -Math.ceil(c.firstBeat / barSource(c) - 0.001);
  c.mixOutBar = Math.max(c.mixInBar + 1, Math.floor(lastBar(c)));
  c.endBar = null;
}

/** Playback-rate factor (1 = original speed). */
export function rate(c: Clip, master: number) {
  if (!c.tempoSync || c.bpm <= 1 || master <= 1) return 1;
  return master / c.bpm;
}

/** Pitch change for the time-pitch unit, in cents (key shift, plus the tempo change in vinyl mode). */
export function pitchCents(c: Clip, master: number) {
  let cents = semitoneShift(c) * 100;
  if (!keepsKey(c)) cents += 1200 * Math.log2(rate(c, master));
  return cents;
}

/** Path from `trimStart` through every loop and jump to the end of the file (not cut yet). */
export function rawSegments(c: Clip): PlaySegment[] {
  const events: { trigger: number; target: number; count: number }[] = [];
  for (const e of c.edits ?? []) {
    if (!(e.bars > 0.01)) continue;
    const a = sourceTimeAtBar(c, e.bar), b = sourceTimeAtBar(c, e.bar + e.bars);
    if (e.kind === 'loop') {
      if (!(e.repeats > 0 && a >= -0.001 && b <= c.duration + 0.001)) continue;
      events.push({ trigger: b, target: Math.max(0, a), count: e.repeats });
    } else {
      if (!(a >= 0 && b < c.duration)) continue;
      events.push({ trigger: a, target: b, count: 1 });
    }
  }
  const remaining = events.map(e => e.count);
  const segs: PlaySegment[] = [];
  let pos = c.trimStart;
  let elapsed = 0;
  for (let n = 0; n < 512; n++) {
    let best: number | null = null;
    events.forEach((ev, k) => {
      if (remaining[k] > 0 && ev.trigger > pos + 0.0005) {
        if (best === null || ev.trigger < events[best].trigger) best = k;
      }
    });
    if (best === null) break;
    const k: number = best;
    segs.push({ from: pos, to: events[k].trigger, elapsed });
    elapsed += events[k].trigger - pos;
    remaining[k] -= 1;
    pos = events[k].target;
  }
  segs.push({ from: pos, to: Math.max(pos, c.duration), elapsed });
  return segs;
}

/** Elapsed play time at source time `s`, using its LAST occurrence (an OUT inside a loop = on the final pass). */
export function elapsedOfSource(s: number, segs: PlaySegment[], trimStart: number): number {
  const first = segs[0];
  if (!first) return s - trimStart;
  for (let k = segs.length - 1; k >= 0; k--) {
    const seg = segs[k];
    if (s >= seg.from - 1e-6 && s <= seg.to + 1e-6) return seg.elapsed + (s - seg.from);
  }
  if (s < first.from) return s - first.from;
  let k = -1;
  for (let j = segs.length - 1; j >= 0; j--) if (segs[j].from <= s) { k = j; break; }
  if (k >= 0) {
    const seg = segs[k];
    if (k === segs.length - 1) return seg.elapsed + (s - seg.from);
    return seg.elapsed + (seg.to - seg.from); // skipped by a jump: the jump point
  }
  return s - trimStart;
}

/** What is actually played, in order. */
export function playSegments(c: Clip): PlaySegment[] {
  if (!hasEdits(c)) return [{ from: c.trimStart, to: Math.max(c.trimStart, c.trimEnd), elapsed: 0 }];
  const raw = rawSegments(c);
  const limit = c.playLength ?? elapsedOfSource(c.trimEnd, raw, c.trimStart);
  const out: PlaySegment[] = [];
  for (const seg of raw) {
    if (seg.elapsed >= limit - 1e-6) break;
    const len = seg.to - seg.from;
    if (seg.elapsed + len <= limit) out.push(seg);
    else { out.push({ from: seg.from, to: seg.from + (limit - seg.elapsed), elapsed: seg.elapsed }); break; }
  }
  return out;
}

/** Source seconds actually played (loops counted, jumps removed). */
export function playedSource(c: Clip) {
  if (!hasEdits(c)) return Math.max(0, c.trimEnd - c.trimStart);
  return playSegments(c).reduce((a, s) => a + (s.to - s.from), 0);
}

export function sourceAtElapsed(e: number, segs: PlaySegment[], trimStart: number): number {
  const last = segs[segs.length - 1];
  if (!(e > 0) || !last) return trimStart + e;
  for (const seg of segs) if (e < seg.elapsed + (seg.to - seg.from)) return seg.from + (e - seg.elapsed);
  return last.to + (e - last.elapsed - (last.to - last.from));
}

export const clipLength = (c: Clip, master: number) => playedSource(c) / rate(c, master);
export const clipEnd = (c: Clip, master: number) => c.start + clipLength(c, master);

/** Fast timeline → source mapping for drawing (segments computed once). */
export function sourceMapper(c: Clip, master: number): (t: number) => number {
  const r = rate(c, master);
  const st = c.start, ts = c.trimStart;
  if (!hasEdits(c)) return t => ts + (t - st) * r;
  const segs = playSegments(c);
  return t => sourceAtElapsed((t - st) * r, segs, ts);
}

/** The loop being played at timeline time t (null when not looping). */
export function activeLoop(c: Clip, t: number, master: number): { edit: ClipEdit; pass: number; of: number } | null {
  if (!hasEdits(c)) return null;
  const segs = playSegments(c);
  const e = (t - c.start) * rate(c, master);
  const k = segs.findIndex(s => e >= s.elapsed && e < s.elapsed + (s.to - s.from));
  if (k < 0) return null;
  const s = segs[k].from + (e - segs[k].elapsed);
  for (const edit of c.edits ?? []) {
    if (edit.kind !== 'loop') continue;
    const a = sourceTimeAtBar(c, edit.bar), b = sourceTimeAtBar(c, edit.bar + edit.bars);
    if (!(s >= a - 1e-6 && s < b)) continue;
    const passes = segs.map((_, i) => i).filter(i => segs[i].from < b - 1e-6 && segs[i].to > a + 1e-6);
    const pass = passes.indexOf(k);
    if (passes.length <= 1 || pass < 0) return null;
    return { edit, pass: pass + 1, of: passes.length };
  }
  return null;
}

export function timelineTimeOfSource(c: Clip, s: number, master: number) {
  if (!hasEdits(c)) return c.start + (s - c.trimStart) / rate(c, master);
  return c.start + elapsedOfSource(s, playSegments(c), c.trimStart) / rate(c, master);
}

export const timelineTimeOfBar = (c: Clip, bar: number, master: number) => timelineTimeOfSource(c, sourceTimeAtBar(c, bar), master);

export function sourceTimeAtTimeline(c: Clip, t: number, master: number) {
  if (!hasEdits(c)) return c.trimStart + (t - c.start) * rate(c, master);
  return sourceAtElapsed((t - c.start) * rate(c, master), playSegments(c), c.trimStart);
}

/** Timeline time at which this clip's first downbeat falls (its bar phase). */
export const downbeatPhase = (c: Clip, master: number) => timelineTimeOfSource(c, c.firstBeat, master);

/** Duration of one of this clip's beats on the timeline. */
export function timelineBeat(c: Clip, master: number) {
  if (c.bpm <= 1) return 60 / Math.max(master, 1);
  return 60 / c.bpm / rate(c, master);
}

/** Source bar playing at reference time `t`. */
export const barAtTimeline = (c: Clip, t: number, master: number) => barAtSource(c, sourceTimeAtTimeline(c, t, master));

/** Elapsed (played) source seconds at a bar of this track, counting loops. */
export function elapsedAtBar(c: Clip, bar: number) {
  const s = sourceTimeAtBar(c, bar);
  return hasEdits(c) ? elapsedOfSource(s, rawSegments(c), c.trimStart) : s - c.trimStart;
}

export const Edit = {
  end: (e: ClipEdit) => e.bar + e.bars,
  deltaBars: (e: ClipEdit) => (e.kind === 'loop' ? e.bars * e.repeats : -e.bars),
  lengthLabel(e: ClipEdit) {
    const bars = e.bars;
    if (bars >= 1) {
      const n = Math.abs(bars - Math.round(bars)) < 0.05 ? `${Math.round(bars)}` : bars.toFixed(1);
      return L(`${n}小節`, bars === 1 ? '1 bar' : `${n} bars`);
    }
    const b = Math.round(bars * 4);
    return L(`${b}拍`, `${b} beat` + (bars * 4 > 1 ? 's' : ''));
  },
  summary(e: ClipEdit) {
    if (e.kind === 'loop') {
      return L(`${barLabel(e.bar)}小節目から ${Edit.lengthLabel(e)}ループ ×${e.repeats + 1}`,
        `${Edit.lengthLabel(e)} loop from bar ${barLabel(e.bar)} ×${e.repeats + 1}`);
    }
    return L(`${barLabel(e.bar)}小節目で ${Edit.lengthLabel(e)}先へジャンプ`, `Jump ahead ${Edit.lengthLabel(e)} at bar ${barLabel(e.bar)}`);
  },
};

// MARK: - Transition curves

export type CurveShape = 'linear' | 'smooth' | 'equalPower' | 'fast' | 'slow';
export const curveShapes: CurveShape[] = ['linear', 'smooth', 'equalPower', 'fast', 'slow'];
export const Curve = {
  title(c: CurveShape) {
    switch (c) {
      case 'linear': return L('直線', 'Linear');
      case 'smooth': return L('なめらか（S字）', 'Smooth (S-curve)');
      case 'equalPower': return L('等パワー', 'Equal power');
      case 'fast': return L('速く立ち上がる', 'Fast start');
      case 'slow': return L('ゆっくり立ち上がる', 'Slow start');
    }
  },
  /** Rising curve 0→1 for x in 0...1. */
  rise(c: CurveShape, x: number) {
    x = clamp01(x);
    switch (c) {
      case 'linear': return x;
      case 'smooth': return (1 - Math.cos(Math.PI * x)) / 2;
      case 'equalPower': return Math.sin(Math.PI / 2 * x);
      case 'fast': return 1 - (1 - x) * (1 - x);
      case 'slow': return x * x;
    }
  },
  fall: (c: CurveShape, x: number) => Curve.rise(c, 1 - x),
};

export type EQBand = 'low' | 'mid' | 'high';

export interface BandSwap {
  enabled: boolean;
  point: number;
  ramp: number;
  curve: CurveShape;
  affectsIncoming?: boolean;
}
export const bandOff = (): BandSwap => ({ enabled: false, point: 0.5, ramp: 0.25, curve: 'smooth', affectsIncoming: true });

export interface TransitionShape {
  inRise: number;
  outFadeStart: number;
  volumeCurve: CurveShape;
  low: BandSwap;
  mid: BandSwap;
  high: BandSwap;
}

export const Shape = {
  layered(p: number): TransitionShape {
    p = Math.min(0.85, Math.max(0.15, p));
    return {
      inRise: p, outFadeStart: p, volumeCurve: 'slow',
      low: { enabled: true, point: p, ramp: 0, curve: 'linear', affectsIncoming: true },
      mid: { enabled: true, point: Math.max(0, p - 0.15), ramp: 0.3, curve: 'smooth', affectsIncoming: true },
      high: bandOff(),
    };
  },
  filterOut(p: number): TransitionShape {
    p = Math.min(0.85, Math.max(0.15, p));
    return {
      inRise: p, outFadeStart: p, volumeCurve: 'slow',
      low: { enabled: true, point: Math.max(0, p - 0.3), ramp: 0.4, curve: 'smooth', affectsIncoming: true },
      mid: { enabled: true, point: Math.max(0, p - 0.15), ramp: 0.35, curve: 'smooth', affectsIncoming: true },
      high: { enabled: true, point: p, ramp: 1 - p, curve: 'smooth', affectsIncoming: false },
    };
  },
  blend(p: number): TransitionShape {
    p = Math.min(0.85, Math.max(0.15, p));
    return {
      inRise: p, outFadeStart: p, volumeCurve: 'slow',
      low: { enabled: true, point: Math.max(0, p - 0.1), ramp: 0.2, curve: 'smooth', affectsIncoming: true },
      mid: { enabled: true, point: Math.max(0, p - 0.2), ramp: 0.4, curve: 'smooth', affectsIncoming: true },
      high: bandOff(),
    };
  },
  defaults(style: TransitionStyle): TransitionShape {
    switch (style) {
      case 'crossfade': return { inRise: 1, outFadeStart: 0, volumeCurve: 'equalPower', low: bandOff(), mid: bandOff(), high: bandOff() };
      case 'bassSwap': return Shape.layered(0.5);
      case 'filter': return Shape.filterOut(0.5);
      case 'echoOut': return { inRise: 0.02, outFadeStart: 0, volumeCurve: 'equalPower', low: bandOff(), mid: bandOff(), high: bandOff() };
      case 'cut': case 'brake': case 'backspin':
        return { inRise: 0.004, outFadeStart: 0.5, volumeCurve: 'linear', low: bandOff(), mid: bandOff(), high: bandOff() };
      case 'custom': return { inRise: 1, outFadeStart: 0, volumeCurve: 'equalPower', low: bandOff(), mid: bandOff(), high: bandOff() };
    }
  },
  band: (s: TransitionShape, b: EQBand) => s[b],
};

// MARK: - Hand-drawn automation

export interface AutoPoint { id: string; x: number; y: number; bend: number }

export const pt = (x: number, y: number, bend = 0): AutoPoint => ({ id: uuid(), x, y, bend });

export const AutoPt = {
  /** Exponent used for the segment shape: t^e (bend 1 → 0.2, bend −1 → 5). */
  exponent: (p: AutoPoint) => Math.pow(5, -Math.min(1, Math.max(-1, p.bend ?? 0))),
  segmentValue(a: AutoPoint, next: AutoPoint, t: number) {
    t = clamp01(t);
    return a.y + (next.y - a.y) * Math.pow(t, AutoPt.exponent(a));
  },
  /** The bend that makes the segment pass through `mid` at its halfway point. */
  bend(a: AutoPoint, b: AutoPoint, mid: number) {
    const span = b.y - a.y;
    if (Math.abs(span) <= 0.02) return 0;
    const ratio = Math.min(0.97, Math.max(0.03, (mid - a.y) / span));
    const e = Math.log(ratio) / Math.log(0.5);
    return Math.min(1, Math.max(-1, -Math.log(e) / Math.log(5)));
  },
};

export type LaneKind = 'volume' | 'high' | 'mid' | 'low' | 'filter' | 'echo' | 'reverb' | 'vocal' | 'instrumental';
export const Lane = {
  title(k: LaneKind) {
    switch (k) {
      case 'volume': return L('フェーダー', 'Fader');
      case 'high': return 'HIGH';
      case 'mid': return 'MID';
      case 'low': return 'LOW';
      case 'filter': return L('フィルター', 'Filter');
      case 'echo': return L('エコー', 'Echo');
      case 'reverb': return L('リバーブ', 'Reverb');
      case 'vocal': return L('ボーカル', 'Vocals');
      case 'instrumental': return L('伴奏', 'Instrumental');
    }
  },
  legend(k: LaneKind) {
    switch (k) {
      case 'volume': return L('上＝100%\n下＝0%', 'Top 100%\nBottom 0%');
      case 'high': case 'mid': case 'low': return L('上＝開く\n下＝KILL', 'Top open\nBottom kill');
      case 'filter': return L('上＝ハイパス\n中＝なし\n下＝ローパス', 'Top high-pass\nMiddle off\nBottom low-pass');
      case 'echo': case 'reverb': return L('上＝強い\n下＝なし', 'Top full\nBottom off');
      case 'vocal': return L('上＝そのまま\n下＝ボーカルを消す', 'Top as is\nBottom vocals cut');
      case 'instrumental': return L('上＝そのまま\n下＝伴奏を消す\n（アカペラ）', 'Top as is\nBottom cut\n(a cappella)');
    }
  },
  neutral(k: LaneKind) {
    if (k === 'filter') return 0.5;
    if (k === 'echo' || k === 'reverb') return 0;
    return 1;
  },
  isEffect: (k: LaneKind) => k === 'filter' || k === 'echo' || k === 'reverb',
  isStem: (k: LaneKind) => k === 'vocal' || k === 'instrumental',
  mixer: ['volume', 'high', 'mid', 'low'] as LaneKind[],
  effects: ['filter', 'echo', 'reverb'] as LaneKind[],
  stems: ['vocal', 'instrumental'] as LaneKind[],
};

export interface TransitionLanes {
  outVolume: AutoPoint[]; outHigh: AutoPoint[]; outMid: AutoPoint[]; outLow: AutoPoint[];
  inVolume: AutoPoint[]; inHigh: AutoPoint[]; inMid: AutoPoint[]; inLow: AutoPoint[];
  outFilter?: AutoPoint[] | null; inFilter?: AutoPoint[] | null;
  outEcho?: AutoPoint[] | null; inEcho?: AutoPoint[] | null;
  outReverb?: AutoPoint[] | null; inReverb?: AutoPoint[] | null;
  outVocal?: AutoPoint[] | null; inVocal?: AutoPoint[] | null;
  outInstrumental?: AutoPoint[] | null; inInstrumental?: AutoPoint[] | null;
}

const laneKey = (kind: LaneKind, incoming: boolean) =>
  ((incoming ? 'in' : 'out') + kind[0].toUpperCase() + kind.slice(1)) as keyof TransitionLanes;

const laneTemplates = ['linear', 'equalPower', 'instantMiddle', 'secondHalf', 'open'] as const;
export type LaneTemplate = typeof laneTemplates[number];

export const Lanes = {
  flat: (kind: LaneKind): AutoPoint[] => [pt(0, Lane.neutral(kind)), pt(1, Lane.neutral(kind))],
  points(l: TransitionLanes, kind: LaneKind, incoming: boolean): AutoPoint[] {
    return (l[laneKey(kind, incoming)] as AutoPoint[] | null | undefined) ?? Lanes.flat(kind);
  },
  isActive(l: TransitionLanes, kind: LaneKind, incoming: boolean): boolean {
    return Lanes.points(l, kind, incoming).some(p => Math.abs(p.y - Lane.neutral(kind)) > 0.002);
  },
  /** Returns a copy with the lane set (an effect / stem lane back at neutral is stored as "not drawn"). */
  setPoints(l: TransitionLanes, kind: LaneKind, incoming: boolean, pts: AutoPoint[]): TransitionLanes {
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    const optional = Lane.isEffect(kind) || Lane.isStem(kind);
    const flat = optional && !sorted.some(p => Math.abs(p.y - Lane.neutral(kind)) > 0.002);
    return { ...l, [laneKey(kind, incoming)]: optional ? (flat ? null : sorted) : sorted };
  },
  value(pts: AutoPoint[], x: number): number {
    const first = pts[0], last = pts[pts.length - 1];
    if (!first || !last) return 1;
    if (x <= first.x) return first.y;
    if (x >= last.x) return last.y;
    for (let k = 1; k < pts.length; k++) {
      if (x <= pts[k].x) {
        const a = pts[k - 1], b = pts[k];
        const span = b.x - a.x;
        if (span < 1e-9) return b.y;
        return AutoPt.segmentValue(a, b, (x - a.x) / span);
      }
    }
    return last.y;
  },
  valueOf: (l: TransitionLanes, kind: LaneKind, incoming: boolean, x: number): number => Lanes.value(Lanes.points(l, kind, incoming), x),

  /** Converts a preset style into editable points (sampled, then simplified). */
  sampled(style: TransitionStyle, shape: TransitionShape): TransitionLanes {
    let xs: number[] = [];
    for (let k = 0; k <= 96; k++) xs.push(k / 96);
    const critical = [shape.inRise, shape.outFadeStart];
    for (const b of [shape.low, shape.mid, shape.high]) if (b.enabled) critical.push(b.point, b.point + b.ramp);
    for (const c of critical) xs.push(c - 0.0005, c, c + 0.0005);
    xs = [...new Set(xs.map(x => Math.min(1, Math.max(0, x))))].sort((a, b) => a - b);
    const lane = (kind: LaneKind, incoming: boolean) => {
      const pts = xs.map(x => {
        const c = incoming ? Automation.incoming(style, shape, x) : Automation.outgoing(style, shape, x);
        let y: number;
        switch (kind) {
          case 'volume': y = c.volume; break;
          case 'high': y = 1 - c.highKill; break;
          case 'mid': y = 1 - c.midKill; break;
          case 'low': y = 1 - c.lowKill; break;
          default: y = Lane.neutral(kind);
        }
        return pt(x, Math.min(1, Math.max(0, y)));
      });
      return Lanes.fitCurve(pts);
    };
    return {
      outVolume: lane('volume', false), outHigh: lane('high', false), outMid: lane('mid', false), outLow: lane('low', false),
      inVolume: lane('volume', true), inHigh: lane('high', true), inMid: lane('mid', true), inLow: lane('low', true),
    };
  },
  /** Reduces a densely sampled curve to a few points with bends, so it is easy to edit. */
  fitCurve(samples: AutoPoint[]): AutoPoint[] {
    const pts = Lanes.simplify(samples, 0.07).map(p => ({ ...p }));
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const real = Lanes.value(samples, (a.x + b.x) / 2);
      pts[k].bend = AutoPt.bend(a, b, real);
    }
    return pts;
  },
  /** Ramer–Douglas–Peucker simplification (keeps the first and last point). */
  simplify(pts: AutoPoint[], epsilon: number): AutoPoint[] {
    if (pts.length <= 2) return pts;
    const keep = new Array(pts.length).fill(false);
    keep[0] = true; keep[pts.length - 1] = true;
    const stack: [number, number][] = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      if (b <= a + 1) continue;
      let maxD = 0, idx = a;
      for (let k = a + 1; k < b; k++) {
        const y = pts[a].y + (pts[b].y - pts[a].y) * (pts[k].x - pts[a].x) / Math.max(1e-9, pts[b].x - pts[a].x);
        const d = Math.abs(pts[k].y - y);
        if (d > maxD) { maxD = d; idx = k; }
      }
      if (maxD > epsilon) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  },

  templates: laneTemplates,
  templateTitle(t: LaneTemplate): string {
    switch (t) {
      case 'linear': return L('直線で入れ替え', 'Linear swap');
      case 'equalPower': return L('等パワーで入れ替え', 'Equal-power swap');
      case 'instantMiddle': return L('中間で瞬時に入れ替え', 'Instant swap in the middle');
      case 'secondHalf': return L('後半で入れ替え', 'Swap in the second half');
      case 'open': return L('両方とも開いたまま', 'Both stay open');
    }
  },
  applyTemplate(l: TransitionLanes, template: LaneTemplate, kind: LaneKind): TransitionLanes {
    let incoming: AutoPoint[] = [];
    switch (template) {
      case 'linear': incoming = [pt(0, 0), pt(1, 1)]; break;
      case 'equalPower': incoming = [pt(0, 0, 0.45), pt(1, 1)]; break;
      case 'instantMiddle': incoming = [pt(0, 0), pt(0.5, 0), pt(0.5005, 1), pt(1, 1)]; break;
      case 'secondHalf': incoming = [pt(0, 0), pt(0.5, 0), pt(1, 1)]; break;
      case 'open':
        l = Lanes.setPoints(l, kind, true, [pt(0, 1), pt(1, 1)]);
        return Lanes.setPoints(l, kind, false, [pt(0, 1), pt(1, 1)]);
    }
    l = Lanes.setPoints(l, kind, true, incoming);
    const outgoing = template === 'equalPower'
      ? [pt(0, 1, -0.45), pt(1, 0)]
      : incoming.map(p => pt(p.x, 1 - p.y, p.bend));
    return Lanes.setPoints(l, kind, false, outgoing);
  },
  /** Outgoing = mirror image (1 − y) of incoming for one lane. */
  mirrorToOutgoing(l: TransitionLanes, kind: LaneKind): TransitionLanes {
    return Lanes.setPoints(l, kind, false, Lanes.points(l, kind, true).map(p => pt(p.x, 1 - p.y, p.bend)));
  },

  effectPresets(kind: LaneKind): EffectPreset[] {
    const p = (v: [number, number][], bend = 0) => v.map(([x, y], k) => pt(x, y, k === v.length - 2 ? bend : 0));
    switch (kind) {
      case 'filter': return [
        { id: 'outHP', title: L('前の曲をハイパスで抜く（後半）', 'High-pass the previous track out (second half)'), incoming: null, outgoing: p([[0, 0.5], [0.5, 0.5], [1, 1]], 0.3) },
        { id: 'inLP', title: L('この曲をローパスから開く（前半）', 'Open this track from a low-pass (first half)'), incoming: p([[0, 0], [0.5, 0.5], [1, 0.5]]), outgoing: null },
        { id: 'both', title: L('両方（入る側ローパス・出る側ハイパス）', 'Both (in from low-pass, out to high-pass)'), incoming: p([[0, 0], [0.5, 0.5], [1, 0.5]]), outgoing: p([[0, 0.5], [0.5, 0.5], [1, 1]], 0.3) },
      ];
      case 'echo': return [
        { id: 'outEnd', title: L('最後の1/4で前の曲にエコー', 'Echo the previous track in the last quarter'), incoming: null, outgoing: p([[0, 0], [0.75, 0], [1, 0.8]]) },
        { id: 'outHalf', title: L('後半ずっと前の曲にエコー', 'Echo the previous track through the second half'), incoming: null, outgoing: p([[0, 0], [0.5, 0], [0.6, 0.6], [1, 0.6]]) },
      ];
      case 'reverb': return [
        { id: 'outTail', title: L('前の曲をリバーブで遠ざける', 'Wash the previous track out with reverb'), incoming: null, outgoing: p([[0, 0], [0.6, 0], [1, 0.8]], -0.3) },
        { id: 'inFromVerb', title: L('この曲をリバーブの中から出す', 'Bring this track in out of a reverb'), incoming: p([[0, 0.7], [0.5, 0]]), outgoing: null },
      ];
      case 'vocal': return [
        { id: 'outCut', title: L('前の曲のボーカルを途中で消す', 'Cut the previous track’s vocals halfway'), incoming: null, outgoing: p([[0, 1], [0.4, 1], [0.5, 0], [1, 0]]) },
        { id: 'inLater', title: L('この曲は伴奏だけで入り、最後にボーカルを入れる', 'This track comes in without vocals; vocals at the end'), incoming: p([[0, 0], [0.74, 0], [0.75, 1], [1, 1]]), outgoing: null },
        { id: 'swap', title: L('ボーカルを入れ替える（真ん中）', 'Swap the vocals in the middle'), incoming: p([[0, 0], [0.49, 0], [0.5, 1], [1, 1]]), outgoing: p([[0, 1], [0.49, 1], [0.5, 0], [1, 0]]) },
      ];
      case 'instrumental': return [
        { id: 'inAcapella', title: L('この曲のボーカルだけ（アカペラ）を先に重ねる', 'Lay this track’s a cappella over first'), incoming: p([[0, 0], [0.74, 0], [0.75, 1], [1, 1]]), outgoing: null },
        { id: 'outAcapella', title: L('前の曲はボーカルだけ残して抜ける', 'Leave the previous track’s a cappella at the end'), incoming: null, outgoing: p([[0, 1], [0.5, 1], [0.6, 0], [1, 0]]) },
      ];
      default: return [];
    }
  },
  applyEffectPreset(l: TransitionLanes, preset: EffectPreset, kind: LaneKind): TransitionLanes {
    l = Lanes.setPoints(l, kind, true, preset.incoming ?? Lanes.flat(kind));
    return Lanes.setPoints(l, kind, false, preset.outgoing ?? Lanes.flat(kind));
  },
  clear(l: TransitionLanes, kind: LaneKind): TransitionLanes {
    l = Lanes.setPoints(l, kind, true, Lanes.flat(kind));
    return Lanes.setPoints(l, kind, false, Lanes.flat(kind));
  },
  usesStemsOutgoing: (l: TransitionLanes): boolean => Lanes.isActive(l, 'vocal', false) || Lanes.isActive(l, 'instrumental', false),
  usesStemsIncoming: (l: TransitionLanes): boolean => Lanes.isActive(l, 'vocal', true) || Lanes.isActive(l, 'instrumental', true),
  usesReverb: (l: TransitionLanes): boolean => Lanes.isActive(l, 'reverb', true) || Lanes.isActive(l, 'reverb', false),
};


export interface EffectPreset { id: string; title: string; incoming: AutoPoint[] | null; outgoing: AutoPoint[] | null }

/** The lanes this transition is (or would be) drawn with. */
export function effectiveLanes(c: Clip): TransitionLanes {
  if (c.transition === 'custom' && c.lanes) return c.lanes;
  return Lanes.sampled(c.transition, transitionShape(c));
}

/** A user-made transition saved app-wide ("My Transitions"). */
export interface CustomTransition { id: string; name: string; bars: number; lanes: TransitionLanes }

// MARK: - Waveform

export interface Waveform {
  binsPerSecond: number;
  peaks: Float32Array;
  lows: Float32Array;
  maxPeak: number;
}

/** Source time of the last bin that is louder than `fraction` of the peak. */
export function lastSoundTime(w: Waveform, fraction = 0.04): number | null {
  const threshold = w.maxPeak * fraction;
  for (let i = w.peaks.length - 1; i >= 0; i--) if (w.peaks[i] > threshold) return (i + 1) / w.binsPerSecond;
  return null;
}

// MARK: - Grid

export class Grid {
  constructor(public bpm: number, public offset: number) {}
  get beat() { return 60 / Math.max(this.bpm, 1); }
  get bar() { return this.beat * 4; }
  snap(t: number, unitBeats: number) {
    const u = this.beat * unitBeats;
    return this.offset + Math.round((t - this.offset) / u) * u;
  }
  /** 1-based bar and beat at timeline time t. */
  position(t: number) {
    const rel = (t - this.offset) / this.beat;
    const b = Math.floor(rel + 1e-6);
    const bar = Math.floor(b / 4) + 1;
    const beat = (((b % 4) + 4) % 4) + 1;
    return { bar, beat };
  }
}

export const Mathx = {
  posModInt: (a: number, m: number) => (m > 0 ? ((a % m) + m) % m : 0),
  posMod(a: number, m: number) {
    if (!(m > 0)) return 0;
    const r = a % m;
    return r < 0 ? r + m : r;
  },
  clamp01,
};

// MARK: - Track use

export type TrackUse = 'auto' | 'full' | 'energetic';

// MARK: - Takes

export interface TakeSnapshot {
  prevMixOutBar: number;
  prevOutNudge?: number | null;
  prevFadeOutBeats: number;
  prevAutoFX: ClipFX[];
  mixInBar: number;
  transitionBars: number;
  transition: TransitionStyle;
  shape?: TransitionShape | null;
  lanes?: TransitionLanes | null;
  tempo?: number | null;
  tempoBars?: number | null;
  spinBeats?: number | null;
  inNudge?: number | null;
  fadeInBeats: number;
  landingLock?: boolean | null;
  autoNote?: AutoMixNote | null;
}

export interface TransitionTake {
  id: string;
  name: string;
  created: string;
  prevID: string;
  snapshot: TakeSnapshot;
}

export const Take = {
  snapshot(prev: Clip, clip: Clip): TakeSnapshot {
    return structuredClone({
      prevMixOutBar: prev.mixOutBar,
      prevOutNudge: prev.outNudge ?? null,
      prevFadeOutBeats: prev.fadeOutBeats,
      prevAutoFX: (prev.fx ?? []).filter(f => f.auto === true),
      mixInBar: clip.mixInBar,
      transitionBars: clip.transitionBars,
      transition: clip.transition,
      shape: clip.shape ?? null,
      lanes: clip.transition === 'custom' ? clip.lanes ?? null : null,
      tempo: clip.tempo ?? null,
      tempoBars: clip.tempoBars ?? null,
      spinBeats: clip.spinBeats ?? null,
      inNudge: clip.inNudge ?? null,
      fadeInBeats: clip.fadeInBeats,
      landingLock: clip.landingLock ?? null,
      autoNote: clip.autoNote ?? null,
    });
  },
  /** Same transition (ignoring the explanation text and point ids). */
  soundsLike(a: TakeSnapshot, b: TakeSnapshot) {
    const norm = (s: TakeSnapshot) => JSON.stringify({ ...s, autoNote: null }, (k, v) => (k === 'id' ? undefined : v));
    return norm(a) === norm(b);
  },
  apply(s: TakeSnapshot, prev: Clip, clip: Clip) {
    const c = structuredClone(s);
    prev.mixOutBar = c.prevMixOutBar;
    prev.outNudge = c.prevOutNudge;
    prev.fadeOutBeats = c.prevFadeOutBeats;
    const fx = [...(prev.fx ?? []).filter(f => f.auto !== true), ...c.prevAutoFX];
    prev.fx = fx.length ? fx : null;
    clip.mixInBar = c.mixInBar;
    clip.transitionBars = c.transitionBars;
    clip.transition = c.transition;
    clip.shape = c.shape;
    clip.lanes = c.lanes;
    clip.tempo = c.tempo;
    clip.tempoBars = c.tempoBars;
    clip.spinBeats = c.spinBeats;
    clip.inNudge = c.inNudge;
    clip.fadeInBeats = c.fadeInBeats;
    clip.landingLock = c.landingLock;
    clip.autoNote = c.autoNote;
  },
  summary(t: TransitionTake) {
    const s = t.snapshot;
    const bars = (v: number) => (Math.abs(v - Math.round(v)) < 0.01 ? `${Math.round(v)}` : v.toFixed(2));
    const how = Style.isCutLike(s.transition) || s.transitionBars < 0.01
      ? Style.title(s.transition)
      : L(`${Style.title(s.transition)} ${bars(s.transitionBars)}小節`, `${Style.title(s.transition)}, ${bars(s.transitionBars)} bars`);
    return L(`${how}・前の曲 ${bars(s.prevMixOutBar + 1)}小節目まで・この曲は ${bars(s.mixInBar + 1)}小節目から`,
      `${how} · previous until bar ${bars(s.prevMixOutBar + 1)} · in at bar ${bars(s.mixInBar + 1)}`);
  },
};

// MARK: - Palette

export const ClipPalette = {
  hues: [0.53, 0.92, 0.08, 0.75, 0.36, 0.60, 0.14, 0.99, 0.45, 0.84],
  hue(index: number) {
    const n = ClipPalette.hues.length;
    return ClipPalette.hues[((index % n) + n) % n];
  },
  /** Distance between two colours on the colour wheel (0 = same hue, 0.5 = opposite). */
  distance(a: number, b: number) {
    const d = Math.abs(ClipPalette.hue(a) - ClipPalette.hue(b)) % 1;
    return Math.min(d, 1 - d);
  },
  minNeighbourDistance: 0.15,
};

// MARK: - Project file

export interface ProjectUIState {
  playhead: number;
  pixelsPerSecond: number;
  scrollTime: number;
  selectedClipID?: string | null;
  showDecks: boolean;
  showMixer?: boolean | null;
  showInspector: boolean;
}

export interface MediaEntry { id: string; fileName: string; offset: number; length: number }

export interface ProjectFile {
  format?: string;
  version: number;
  savedAt?: string;
  appVersion?: string;
  originalPath?: string | null;
  notes?: string | null;
  ui?: ProjectUIState | null;
  customTransitions?: CustomTransition[] | null;
  masterBPM: number;
  gridOffset: number;
  defaultTransitionBars: number;
  defaultTransitionStyle?: TransitionStyle | null;
  library?: Clip[] | null;
  snap: SnapUnit;
  clips: Clip[];
  projectID?: string | null;
  media?: MediaEntry[] | null;
  /** Mac analyses (LZFSE binary plists, base64) — kept untouched so the Mac app can still use them. */
  analyses?: Record<string, string> | null;
  /** Analyses made by this (Electron) version, keyed by fingerprint. */
  analysesJS?: Record<string, string> | null;
  loudnessMode?: LoudnessMode | null;
  profiles?: Record<string, unknown> | null;
}

export const projectFormatID = 'DJAW-Mix';
export const projectVersion = 2;
