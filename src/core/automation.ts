// Port of mac/DJAW/Model/Automation.swift: per-clip volume, EQ, effects and stem levels at a timeline time.
// Shared by the preview, the export and the drawings, so all of them agree.
import {
  BandSwap, Clip, Curve as CurveFn, Lanes, Mathx, TransitionLanes, TransitionShape, TransitionStyle,
  barAtTimeline, clipEnd, transitionShape,
} from './models';
import { FXState, fxStateAt, isQuietFX, quietFX } from './tempo';

export interface AutoState {
  /** Final linear volume (gain × envelope). */
  volume: number;
  /** Envelope only (0...1), without the clip gain. Used for drawing. */
  envelope: number;
  low: number;
  mid: number;
  high: number;
  lowKilled: boolean;
  /** Input level into the echo unit (1 = normal, 0 = stop feeding). */
  send: number;
  /** Echo wet/dry mix 0...100. */
  echoWet: number;
  fx: FXState;
  vocal: number;
  instrumental: number;
}

export interface Curve {
  volume: number;
  lowKill: number;
  midKill: number;
  highKill: number;
  echo: number;
  /** −1 low-pass … 0 off … +1 high-pass. */
  filter: number;
  fxEcho: number;
  fxReverb: number;
  vocal: number;
  instrumental: number;
}

const curve = (volume: number, lowKill: number, midKill: number, extra: Partial<Curve> = {}): Curve => ({
  volume, lowKill, midKill, highKill: 0, echo: 0, filter: 0, fxEcho: 0, fxReverb: 0, vocal: 1, instrumental: 1, ...extra,
});

const f32 = Math.fround;

function laneCurve(l: TransitionLanes, incoming: boolean, x: number): Curve {
  return {
    volume: Lanes.valueOf(l, 'volume', incoming, x),
    lowKill: 1 - Lanes.valueOf(l, 'low', incoming, x),
    midKill: 1 - Lanes.valueOf(l, 'mid', incoming, x),
    highKill: 1 - Lanes.valueOf(l, 'high', incoming, x),
    echo: 0,
    filter: (Lanes.valueOf(l, 'filter', incoming, x) - 0.5) * 2,
    fxEcho: Lanes.valueOf(l, 'echo', incoming, x),
    fxReverb: Lanes.valueOf(l, 'reverb', incoming, x),
    vocal: Lanes.valueOf(l, 'vocal', incoming, x),
    instrumental: Lanes.valueOf(l, 'instrumental', incoming, x),
  };
}

/** Kill amount (0 = band open, 1 = band cut) for one band. */
function bandKill(band: BandSwap, x: number, incoming: boolean) {
  if (!band.enabled) return 0;
  if (incoming && band.affectsIncoming === false) return 0;
  const progress = band.ramp < 0.002 ? (x < band.point ? 0 : 1) : CurveFn.rise(band.curve, (x - band.point) / band.ramp);
  return incoming ? 1 - progress : progress;
}

export const Automation = {
  killDB: -40,

  /** Curve for the clip that comes in. x = 0...1 progress through the overlap. */
  incoming(style: TransitionStyle, shape: TransitionShape, x: number): Curve {
    x = Mathx.clamp01(x);
    switch (style) {
      case 'crossfade': case 'bassSwap': case 'filter': {
        const v = CurveFn.rise(shape.volumeCurve, x / Math.max(shape.inRise, 0.001));
        return curve(v, bandKill(shape.low, x, true), bandKill(shape.mid, x, true), { highKill: bandKill(shape.high, x, true) });
      }
      case 'echoOut': return curve(Mathx.clamp01(x / 0.02), 0, 0);
      // Fully open from the first sample: the click-free 3 ms fade-in is baked into the audio read.
      case 'cut': case 'brake': case 'backspin': return curve(1, 0, 0);
      case 'custom': return curve(Math.sin(Math.PI / 2 * x), 0, 0);
    }
  },

  /** Curve for the clip that goes out. x = 0...1 progress through the overlap. */
  outgoing(style: TransitionStyle, shape: TransitionShape, x: number): Curve {
    x = Mathx.clamp01(x);
    switch (style) {
      case 'crossfade': case 'bassSwap': case 'filter': {
        const span = Math.max(1 - shape.outFadeStart, 0.001);
        const v = x <= shape.outFadeStart ? 1 : CurveFn.fall(shape.volumeCurve, (x - shape.outFadeStart) / span);
        return curve(v, bandKill(shape.low, x, false), bandKill(shape.mid, x, false), { highKill: bandKill(shape.high, x, false) });
      }
      // Dry signal stops at the mix-out point, only the echo tail remains and decays.
      case 'echoOut': return curve(x <= 0 ? 1 : Math.cos(Math.PI / 2 * x), 0, 0, { echo: x > 0 ? 1 : 0 });
      // The outgoing audio itself ends at the cut with a 5 ms fade, sample-accurately.
      case 'cut': return curve(1, 0, 0);
      case 'brake': case 'backspin': return curve(1 - Mathx.clamp01((x - 0.5) / 0.004), 0, 0);
      case 'custom': return curve(Math.cos(Math.PI / 2 * x), 0, 0);
    }
  },

  /** Curve for clip `c` coming in, honouring hand-drawn lanes. */
  incomingCurve(c: Clip, x: number): Curve {
    x = Mathx.clamp01(x);
    if (c.transition === 'custom' && c.lanes) return laneCurve(c.lanes, true, x);
    return Automation.incoming(c.transition, transitionShape(c), x);
  },

  /** Curve for the clip going out while `next` comes in, honouring hand-drawn lanes. */
  outgoingCurve(next: Clip, x: number): Curve {
    x = Mathx.clamp01(x);
    if (next.transition === 'custom' && next.lanes) return laneCurve(next.lanes, false, x);
    return Automation.outgoing(next.transition, transitionShape(next), x);
  },

  /** Where in the transition into `c` (0…1) the new track takes over, judged from the transition's own curves. */
  switchPoint(c: Clip): number {
    if (c.transition === 'cut' || c.transition === 'brake' || c.transition === 'backspin' || c.transition === 'echoOut') return 0;
    const weight = (cv: Curve) => {
      const bands = 0.5 * (1 - cv.lowKill) + 0.3 * (1 - cv.midKill) + 0.2 * (1 - cv.highKill);
      const stems = 0.5 * cv.vocal + 0.5 * cv.instrumental;
      return cv.volume * cv.volume * bands * stems;
    };
    const n = 256;
    let lastBehind = -1;
    for (let k = 0; k <= n; k++) {
      const x = k / n;
      if (weight(Automation.incomingCurve(c, x)) < weight(Automation.outgoingCurve(c, x))) lastBehind = k;
    }
    return Math.min(1, (lastBehind + 1) / n);
  },

  /** Timeline time at which clip `i` takes over from the track before it (its start for the first track). */
  switchTime(clips: Clip[], i: number, master: number): number {
    const c = clips[i];
    if (i <= 0) return c.start;
    const prev = clips[i - 1];
    const len = Math.min(clipEnd(prev, master), clipEnd(c, master)) - c.start;
    if (!(len > 0.001)) return c.start;
    return c.start + Automation.switchPoint(c) * len;
  },

  /**
   * `clips` must be sorted by start time. `ends` (optional) are the clips' end times, precomputed by the caller
   * when this is evaluated many times (the render loop).
   */
  state(clips: Clip[], i: number, t: number, master: number, ends?: number[]): AutoState {
    const c = clips[i];
    const endOf = (k: number) => (ends ? ends[k] : clipEnd(clips[k], master));
    const start = c.start;
    const end = endOf(i);
    let env = 1, lowK = 0, midK = 0, highK = 0, send = 1, wet = 0;
    let laneFilter = 0, laneEcho = 0, laneReverb = 0, vocal = 1, instrumental = 1;
    const take = (cv: Curve) => {
      if (Math.abs(cv.filter) > Math.abs(laneFilter)) laneFilter = cv.filter;
      laneEcho = Math.max(laneEcho, cv.fxEcho);
      laneReverb = Math.max(laneReverb, cv.fxReverb);
      vocal *= cv.vocal;
      instrumental *= cv.instrumental;
    };

    if (t < start || t > end) env = 0;

    const beat = 60 / Math.max(master, 1);
    const fadeIn = c.fadeInBeats * beat;
    const fadeOut = c.fadeOutBeats * beat;
    if (fadeIn > 0 && t < start + fadeIn) env *= Math.sin(Math.PI / 2 * Mathx.clamp01((t - start) / fadeIn));
    if (fadeOut > 0 && t > end - fadeOut) env *= Math.sin(Math.PI / 2 * Mathx.clamp01((end - t) / fadeOut));

    // Incoming transition (overlap with previous clip)
    if (i > 0) {
      const len = Math.min(endOf(i - 1), end) - start;
      if (len > 0.001) {
        const x = (t - start) / len;
        const cv = Automation.incomingCurve(c, x);
        // Effect / stem lanes act only during the transition; fader / EQ keep their end positions.
        if (x >= 0 && x <= 1) take(cv);
        env *= cv.volume;
        lowK = Math.max(lowK, cv.lowKill);
        midK = Math.max(midK, cv.midKill);
        highK = Math.max(highK, cv.highKill);
      }
    }

    // Outgoing transition (overlap with next clip)
    if (i + 1 < clips.length) {
      const next = clips[i + 1];
      const len = Math.min(end, endOf(i + 1)) - next.start;
      if (len > 0.001) {
        const x = (t - next.start) / len;
        const cv = Automation.outgoingCurve(next, x);
        if (x >= 0 && x <= 1) take(cv);
        env *= cv.volume;
        lowK = Math.max(lowK, cv.lowKill);
        midK = Math.max(midK, cv.midKill);
        highK = Math.max(highK, cv.highKill);
        if (cv.echo > 0) {
          wet = 100;
          // Keep feeding the echo for one beat after the mix-out point, then let it ring.
          send = t - next.start < beat ? 1 : 0;
        }
      }
    }

    let fx = quietFX();
    if ((c.fx?.length ?? 0) > 0 && env > 0) fx = fxStateAt(c, barAtTimeline(c, t, master));
    // Drawn effect lanes add to the effect regions (the stronger one wins).
    if (Math.abs(laneFilter) > 0.002 && Math.abs(f32(laneFilter)) > Math.abs(fx.filter)) fx.filter = f32(laneFilter);
    if (laneEcho > 0.002 && f32(laneEcho) > fx.echo) fx.echo = f32(laneEcho);
    if (laneReverb > 0.002) fx.reverb = Math.max(fx.reverb, f32(laneReverb));
    void isQuietFX;

    const gain = Math.pow(10, (c.gainDB + (c.loudnessGainDB ?? 0)) / 20);
    const kill = Automation.killDB;
    const lowDB = c.eqLow + (kill - c.eqLow) * lowK;
    const midDB = c.eqMid + (kill * 0.6 - c.eqMid) * midK;
    const highDB = c.eqHigh + (kill - c.eqHigh) * highK;
    return {
      volume: f32(gain * env), envelope: env,
      low: f32(lowDB), mid: f32(midDB), high: f32(highDB),
      lowKilled: lowK > 0.5, send: f32(send), echoWet: f32(wet), fx,
      vocal: f32(vocal), instrumental: f32(instrumental),
    };
  },
};
