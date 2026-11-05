// "Simplify transition" (mac/DJAW/Store/MixStore+Simplify.swift): a transition drawn over 16 bars where the
// incoming track stays silent for the first 8 (and the outgoing one plays untouched) sounds exactly like an
// 8-bar transition. Finds the bars where something actually changes and, when asked, rewrites the transition
// to just those bars — same audio, shorter. Never done automatically.
import { AutoPoint, AutoPt, Clip, Lane, LaneKind, Lanes, TransitionLanes, clipEnd, effectiveLanes, pt } from '../../core/models';
import { Automation } from '../../core/automation';
import { tempoRampBars } from '../../core/tempo';
import { MixStore } from './store';

export interface TransitionSimplification { dropBars: number; oldBars: number; newBars: number }

declare module './store' {
  interface MixStore {
    simplification(i: number): TransitionSimplification | null;
    simplifiableTransitions(): { id: string; s: TransitionSimplification }[];
    simplifyTransition(id: string, undoable?: boolean): boolean;
    simplifyAllTransitions(): number;
  }
}

const SILENT = 0.003, REST = 0.002;
const P = MixStore.prototype;
let cache: { revision: number; list: { id: string; s: TransitionSimplification }[] } | null = null;

P.simplification = function (i) {
  if (i <= 0 || i >= this.clips.length) return null;
  const c = this.clips[i], prev = this.clips[i - 1];
  if (!['crossfade', 'bassSwap', 'filter', 'custom'].includes(c.transition) || !c.tempoSync || !prev.tempoSync) return null;
  const overlapBars = (Math.min(clipEnd(prev, this.masterBPM), clipEnd(c, this.masterBPM)) - c.start) / this.barLength;
  const len = c.transitionBars;
  if (len < 2 || overlapBars <= len - 0.01) return null;
  const unit = len >= 4 ? 1 : 0.25;
  const n = 960;
  const headQuiet = (x: number) => {
    const o = Automation.outgoingCurve(c, x), inc = Automation.incomingCurve(c, x);
    return inc.volume <= SILENT && o.volume >= 1 - REST && o.lowKill <= REST && o.midKill <= REST && o.highKill <= REST && o.echo === 0
      && Math.abs(o.filter) <= REST && o.fxEcho <= REST && o.fxReverb <= REST && o.vocal >= 1 - REST && o.instrumental >= 1 - REST;
  };
  const tailQuiet = (x: number) => {
    const o = Automation.outgoingCurve(c, x), inc = Automation.incomingCurve(c, x);
    return o.volume <= SILENT && inc.volume >= 1 - REST && inc.lowKill <= REST && inc.midKill <= REST && inc.highKill <= REST
      && Math.abs(inc.filter) <= REST && inc.fxEcho <= REST && inc.fxReverb <= REST && inc.vocal >= 1 - REST && inc.instrumental >= 1 - REST;
  };
  let firstLoudHead = n + 1;
  for (let k = 0; k <= n; k++) if (!headQuiet(k / n)) { firstLoudHead = k; break; }
  let lastLoudTail = -1;
  for (let k = n; k >= 0; k--) if (!tailQuiet(k / n)) { lastLoudTail = k; break; }
  let s = 0;
  while (s + unit < len && Math.ceil((s + unit) / len * n) < firstLoudHead) s += unit;
  let e = len;
  while (e - unit > s && Math.floor((e - unit) / len * n) > lastLoudTail) e -= unit;
  if (e - s < unit || e - s >= len - 0.001) return null;
  return { dropBars: s, oldBars: len, newBars: e - s };
};

P.simplifiableTransitions = function () {
  if (cache && cache.revision === this.revision) return cache.list;
  const list: { id: string; s: TransitionSimplification }[] = [];
  for (let i = 1; i < this.clips.length; i++) { const r = this.simplification(i); if (r) list.push({ id: this.clips[i].id, s: r }); }
  cache = { revision: this.revision, list };
  return list;
};

P.simplifyTransition = function (id, undoable = true) {
  const i = this.index(id);
  const sim = i != null ? this.simplification(i) : null;
  if (i == null || !sim) return false;
  if (undoable) this.pushUndo(); else this.markDirty();
  const c = this.clips[i];
  const u0 = sim.dropBars / sim.oldBars, u1 = (sim.dropBars + sim.newBars) / sim.oldBars;
  const lanes = cutLanes(c.transition === 'custom' && c.lanes ? c.lanes : effectiveLanes(c), u0, u1);
  const next: Clip = { ...c, lanes, transition: 'custom', transitionBars: sim.newBars, mixInBar: c.mixInBar + sim.dropBars };
  if (c.tempo != null) next.tempoBars = Math.max(0, tempoRampBars(c) - sim.dropBars);
  this.clips = this.clips.map((x, k) => (k === i ? next : k === i - 1 ? { ...x, mixOutBar: x.mixOutBar + sim.dropBars } : x));
  this.finishTimingEdit();
  return true;
};

P.simplifyAllTransitions = function () {
  const ids = this.simplifiableTransitions().map(x => x.id);
  if (!ids.length) return 0;
  this.pushUndo();
  let n = 0;
  for (const id of ids) if (this.simplifyTransition(id, false)) n++;
  return n;
};

/** The bend for a segment from x0 to x1 that best follows the part of segment a → b between them. */
function fitBend(a: AutoPoint, b: AutoPoint, x0: number, x1: number) {
  const y0 = Lanes.value([a, b], x0), y1 = Lanes.value([a, b], x1);
  if (Math.abs(y1 - y0) <= 1e-6 || x1 <= x0) return 0;
  const samples = Array.from({ length: 31 }, (_, k) => { const s = (k + 1) / 32; return [s, Lanes.value([a, b], x0 + (x1 - x0) * s)]; });
  let best = { err: Infinity, bend: 0 };
  for (let bend = -1; bend <= 1.0001; bend += 0.005) {
    const p = pt(0, y0, bend), q = pt(1, y1);
    let e = 0;
    for (const [s, y] of samples) { const d = AutoPt.segmentValue(p, q, s) - y; e += d * d; }
    if (e < best.err) best = { err: e, bend };
  }
  return best.bend;
}

function cutLanes(lanes: TransitionLanes, u0: number, u1: number): TransitionLanes {
  const cut = (pts: AutoPoint[]): AutoPoint[] => {
    if (!pts.length || u1 <= u0) return pts;
    const span = u1 - u0;
    const local = (x: number) => Math.min(1, Math.max(0, (x - u0) / span));
    const out: AutoPoint[] = [];
    const add = (x: number, y: number, bend = 0) => {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - local(x)) < 1e-6) { if (bend !== 0) last.bend = bend; return; }
      out.push(pt(local(x), y, bend));
    };
    const segs: [AutoPoint, AutoPoint][] = [];
    if (pts[0].x > 0) segs.push([pt(0, pts[0].y), pt(pts[0].x, pts[0].y)]);
    for (let k = 0; k < pts.length - 1; k++) segs.push([pts[k], pts[k + 1]]);
    const l = pts[pts.length - 1];
    if (l.x < 1) segs.push([pt(l.x, l.y), pt(1, l.y)]);
    for (const [a, b] of segs) {
      if (!(b.x > u0 && a.x < u1)) continue;
      if (a.x >= u0 && b.x <= u1) { add(a.x, a.y, a.bend); add(b.x, b.y); }
      else {
        const x0 = Math.max(a.x, u0), x1 = Math.min(b.x, u1);
        add(x0, Lanes.value([a, b], x0), fitBend(a, b, x0, x1));
        add(x1, Lanes.value([a, b], x1));
      }
    }
    return out.length ? out : [pt(0, Lanes.value(pts, u0)), pt(1, Lanes.value(pts, u1))];
  };
  let l = lanes;
  for (const k of [...Lane.mixer, ...Lane.effects, ...Lane.stems] as LaneKind[]) {
    for (const inc of [true, false]) l = Lanes.setPoints(l, k, inc, cut(Lanes.points(lanes, k, inc)));
  }
  return l;
}
