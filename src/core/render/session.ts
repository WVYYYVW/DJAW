// The one place the mix is turned into audio (mac/DJAW/Audio/MixRenderSession.swift + PlaybackEngine.swift).
// Export, the mix waveform, the transition checks and the preview all render through this, so what you hear is
// what gets exported. Rendering goes in steps of 512 frames counted from the start of the mix (automation is
// evaluated at the same moments wherever rendering starts); every track's voice starts on its exact frame.
import { AutoState, Automation } from '../automation';
import {
  Clip, Lanes, PlaySegment, clipEnd, pitchCents, playSegments, rate, sourceAtElapsed,
} from '../models';
import { OutroFX, TempoMap, outro } from '../tempo';
import { DJEQ, Echo, Reverb } from './dsp';
import { FXKernel } from './fxkernel';
import { AudioSource } from './source';
import { MAX_BLOCK, StretchPool, Stretcher } from './stretch';
import { turntableBuffer } from './turntable';

export const CHUNK = 512;
/** A track's four separated stems (vocals, drums, bass, melody), in the order of STEM_NAMES. */
export type StemSources = [AudioSource, AudioSource, AudioSource, AudioSource];
/** A track's voice keeps running this long after the track ends (echo / reverb tails). */
export const TAIL = 8;

/** The time-stretch rate actually used: never exactly 1, so the stretch always processes the same way. */
export const stretchRate = (r: number) => (Math.abs(r - 1) < 0.00002 ? 1.00002 : r);

/** Frame ranges to play back to back (ClipSchedule.ranges): loops repeat ranges, jumps skip them. */
export function scheduleRanges(segs: PlaySegment[], e0: number, eEnd: number | null, sr: number, fileLength: number) {
  const out: { start: number; count: number }[] = [];
  for (const s of segs) {
    const seg = { ...s };
    if (eEnd != null) {
      if (!(seg.elapsed < eEnd - 1e-6)) break;
      seg.to = Math.min(seg.to, seg.from + (eEnd - seg.elapsed));
    }
    const len = seg.to - seg.from;
    if (!(seg.elapsed + len > e0 + 1e-6)) continue;
    const skip = Math.max(0, e0 - seg.elapsed);
    const a = Math.round((seg.from + skip) * sr);
    const b = Math.min(fileLength, Math.round(seg.to * sr));
    if (b > a) out.push({ start: Math.max(0, a), count: b - Math.max(0, a) });
  }
  return out;
}

/**
 * What one clip plays from `e0` on, as one stream of source frames (BufferFeeder): its pieces (3 ms fade-in at the
 * very start, 5 ms fade-out at a cut), then the brake / backspin, then silence. Index 0 = elapsed `e0`;
 * negative indices are silence.
 */
class ClipStream {
  private pieces: { start: number; count: number }[];
  private outroBuf: [Float32Array, Float32Array] | null = null;
  private total: number;
  private bounds: number[] = [];
  private readonly fadeIn: number;
  private readonly fadeOut: number;
  private readonly cutOut: boolean;

  constructor(private readonly src: AudioSource, clip: Clip, out: OutroFX | null, e0: number, cutOut: boolean, key: string) {
    const sr = src.sampleRate;
    this.pieces = scheduleRanges(playSegments(clip), e0, out?.elapsedStart ?? null, sr, src.frames);
    this.cutOut = cutOut && !out;
    if (out) {
      const p0 = sourceAtElapsed(out.elapsedStart, playSegments(clip), clip.trimStart);
      const buf = turntableBuffer(key, src, out.kind, p0, out.length);
      if (buf) {
        const skip = Math.max(0, Math.floor((e0 - out.elapsedStart) * sr));
        if (skip === 0) this.outroBuf = buf;
        else if (skip < buf[0].length) this.outroBuf = [buf[0].subarray(skip), buf[1].subarray(skip)];
      }
    }
    let acc = 0;
    for (const p of this.pieces) { this.bounds.push(acc); acc += p.count; }
    this.total = acc;
    this.fadeIn = Math.floor(0.003 * sr);
    this.fadeOut = Math.floor(0.005 * sr);
  }

  get isEmpty() { return this.pieces.length === 0 && !this.outroBuf; }

  /** Writes stream frames [i0, i0 + n) into L / R at `off`. */
  read(i0: number, n: number, L: Float32Array, R: Float32Array, off = 0) {
    let i = i0, o = off, left = n;
    if (i < 0) {
      const z = Math.min(left, -i);
      L.fill(0, o, o + z); R.fill(0, o, o + z);
      i += z; o += z; left -= z;
    }
    // Pieces.
    let k = 0;
    while (left > 0 && i < this.total) {
      while (k + 1 < this.pieces.length && this.bounds[k + 1] <= i) k++;
      const p = this.pieces[k];
      const inPiece = i - this.bounds[k];
      const m = Math.min(left, p.count - inPiece);
      this.src.read(p.start + inPiece, m, L, R, o);
      // 3 ms fade-in at the very start of the stream.
      if (k === 0 && inPiece < this.fadeIn) {
        for (let j = 0; j < m && inPiece + j < this.fadeIn; j++) {
          const g = (inPiece + j + 1) / (this.fadeIn + 1);
          L[o + j] *= g; R[o + j] *= g;
        }
      }
      // 5 ms fade-out at the end when the next track cuts in.
      if (this.cutOut && k === this.pieces.length - 1) {
        const fadeStart = p.count - Math.min(this.fadeOut, p.count);
        const m2 = p.count - fadeStart;
        for (let j = 0; j < m; j++) {
          const q = inPiece + j;
          if (q >= fadeStart) {
            const g = 1 - (q - fadeStart + 1) / (m2 + 1);
            L[o + j] *= g; R[o + j] *= g;
          }
        }
      }
      i += m; o += m; left -= m;
    }
    // Brake / backspin.
    if (left > 0 && this.outroBuf) {
      const j0 = i - this.total;
      const len = this.outroBuf[0].length;
      const m = Math.max(0, Math.min(left, len - j0));
      if (m > 0) {
        L.set(this.outroBuf[0].subarray(j0, j0 + m), o);
        R.set(this.outroBuf[1].subarray(j0, j0 + m), o);
        i += m; o += m; left -= m;
      }
    }
    if (left > 0) { L.fill(0, o, o + left); R.fill(0, o, o + left); }
  }
}

/** One track: stream → time-stretch → EQ → DJ FX → echo → reverb → fader. */
class Voice {
  readonly eq: DJEQ;
  readonly fx: FXKernel;
  readonly echo: Echo;
  readonly reverb: Reverb | null;
  private readonly stream: ClipStream;
  /** With stems: drums, bass and melody (the main stream then plays the vocals), mixed at their lane levels. */
  private readonly others: ClipStream[] = [];
  /** Levels of vocals, drums, bass, melody. */
  private stemGains = [1, 1, 1, 1];
  private vL = new Float32Array(0);
  private vR = new Float32Array(0);
  private pos: number;
  private acc = 0;
  private volume: number | null = null;
  private lastDelay = -1;
  private readonly L = new Float32Array(MAX_BLOCK);
  private readonly R = new Float32Array(MAX_BLOCK);

  constructor(
    readonly index: number,
    readonly endFrame: number,
    readonly clip: Clip,
    next: Clip | undefined,
    tempoNow: number,
    readonly sr: number,
    e0: number,
    src: AudioSource,
    readonly stretcher: Stretcher,
    usesReverb: boolean,
    stems: StemSources | null = null,
  ) {
    const out = outro(clip, next), cutOut = next?.transition === 'cut';
    this.stream = stems ? new ClipStream(stems[0], clip, out, e0, cutOut, clip.url + '|vocals')
      : new ClipStream(src, clip, out, e0, cutOut, clip.url);
    if (stems) for (const [k, name] of [[1, 'drums'], [2, 'bass'], [3, 'melody']] as const) this.others.push(new ClipStream(stems[k], clip, out, e0, cutOut, `${clip.url}|${name}`));
    this.eq = new DJEQ(sr);
    this.fx = new FXKernel(sr, MAX_BLOCK);
    this.echo = new Echo(sr);
    this.echo.setDelay(60 / Math.max(tempoNow, 1) * 0.75);
    this.reverb = usesReverb ? new Reverb(sr) : null;
    // Prime the stretch with silence before the start, then drop its latency: output frame 0 = stream frame 0.
    const r0 = stretchRate(rate(clip, tempoNow));
    const st = this.stretcher;
    st.setPitch(Math.min(24, Math.max(-24, pitchCents(clip, tempoNow) / 100)));
    const lat = st.outputLatency;
    st.seek(r0, (l, r) => this.read(-lat, st.seekLength, l, r));
    this.pos = -lat + st.seekLength;
    let drop = lat;
    while (drop > 0) {
      const n = Math.min(drop, MAX_BLOCK);
      this.pull(n, r0);
      drop -= n;
    }
  }

  get isEmpty() { return this.stream.isEmpty && this.others.every(o => o.isEmpty); }

  /** Stream frames [i0, i0 + n): the track, or its four stems at their lane levels. */
  private read(i0: number, n: number, L: Float32Array, R: Float32Array) {
    this.stream.read(i0, n, L, R);
    if (!this.others.length) return;
    const g = this.stemGains;
    if (g[0] !== 1) for (let i = 0; i < n; i++) { L[i] *= g[0]; R[i] *= g[0]; }
    if (this.vL.length < n) { this.vL = new Float32Array(n * 2); this.vR = new Float32Array(n * 2); }
    const vL = this.vL, vR = this.vR;
    this.others.forEach((o, k) => {
      o.read(i0, n, vL, vR);
      const gk = g[k + 1];
      if (gk === 0) return;
      for (let i = 0; i < n; i++) { L[i] += vL[i] * gk; R[i] += vR[i] * gk; }
    });
  }

  /** Stretched audio for n output frames into this.L / this.R. */
  private pull(n: number, r: number) {
    this.acc += n * r;
    const inN = Math.floor(this.acc);
    this.acc -= inN;
    const st = this.stretcher;
    this.read(this.pos, inN, st.input(0, inN), st.input(1, inN));
    this.pos += inN;
    st.process(inN, n, this.L, this.R);
  }

  /** Chain.apply + render: n ≤ MAX_BLOCK frames, added into outL / outR. */
  render(n: number, s: AutoState, tempo: number, beat: number, snapTolerance: number, outL: Float32Array, outR: Float32Array) {
    const c = this.clip;
    const r = stretchRate(rate(c, tempo));
    this.stretcher.setPitch(Math.min(24, Math.max(-24, pitchCents(c, tempo) / 100)));
    if (this.others.length) {
      const inst = Math.max(0, s.instrumental);
      this.stemGains = [Math.max(0, s.vocal), inst * Math.max(0, s.drums), inst * Math.max(0, s.bass), inst * Math.max(0, s.melody)];
    }
    this.pull(n, r);
    const L = this.L, R = this.R;

    if (this.volume === null) this.eq.reset(s.low, s.mid, s.high);
    this.eq.process(L, R, n, s.low, s.mid, s.high);

    const k = this.fx;
    k.target = s.fx;
    k.bpm = c.tempoSync ? tempo : c.bpm;
    if (Math.abs(k.beat - beat) > snapTolerance) { k.beatTarget = beat; k.resync += 1; }
    k.process(L, R, n);

    // Echo: the echo-out transition wins over an echo effect region.
    const beatSec = 60 / Math.max(tempo, 1);
    let wantDelay = beatSec * 0.75;
    let send: number;
    if (s.echoWet > 0) {
      send = s.send; this.echo.wetDry = s.echoWet; this.echo.feedback = 55;
    } else if (s.fx.echo > 0) {
      send = 1; this.echo.wetDry = 15 + 35 * s.fx.echo; this.echo.feedback = 30 + 30 * s.fx.echo;
      wantDelay = beatSec * s.fx.echoDiv;
    } else {
      send = s.send; this.echo.wetDry = 0;
    }
    wantDelay = Math.min(2, wantDelay);
    if (Math.abs(wantDelay - this.lastDelay) > this.lastDelay * 0.01) { this.echo.setDelay(wantDelay); this.lastDelay = wantDelay; }
    this.echo.process(L, R, n, send);

    if (this.reverb) {
      this.reverb.wetDry = 55 * s.fx.reverb;
      this.reverb.process(L, R, n);
    }

    // Fader: glide from the last step's level to this one across the step.
    const v0 = this.volume ?? s.volume, v1 = s.volume;
    this.volume = v1;
    if (v0 === v1) {
      if (v1 !== 0) for (let i = 0; i < n; i++) { outL[i] += L[i] * v1; outR[i] += R[i] * v1; }
    } else {
      for (let i = 0; i < n; i++) {
        const g = v0 + (v1 - v0) * (i + 1) / n;
        outL[i] += L[i] * g; outR[i] += R[i] * g;
      }
    }
  }
}

export interface SessionOptions {
  clips: Clip[];
  /** Only these tracks (default: all). */
  indices?: number[];
  master: number;
  tempo: TempoMap;
  gridOffset: number;
  sampleRate: number;
  /** Timeline (reference) time to start at. */
  from?: number;
  /** Automation states to hold instead of the timeline's (render checks of a track on its own). */
  fixed?: Map<number, AutoState>;
  /** Opens a track's audio (null when it cannot be read). */
  open: (clip: Clip) => AudioSource | null;
  /** Opens a track's separated stems (null when there are none). */
  openStems?: (clip: Clip) => StemSources | null;
  pool: StretchPool;
}

export class RenderSession {
  readonly sampleRate: number;
  clips: Clip[];
  private ends: number[];
  private readonly master: number;
  private readonly tempo: TempoMap;
  private readonly gridOffset: number;
  private readonly fixed: Map<number, AutoState>;
  private readonly open: (clip: Clip) => AudioSource | null;
  private readonly openStems: SessionOptions['openStems'];
  private readonly pool: StretchPool;
  private stemSources = new Map<number, StemSources | null>();
  private voices: Voice[] = [];
  private sources = new Map<number, AudioSource>();
  private waiting: { index: number; frame: number }[] = [];
  absoluteFrame: number;
  readonly startFrame: number;
  private readonly ownKey: string;
  readonly L = new Float32Array(CHUNK);
  readonly R = new Float32Array(CHUNK);

  private constructor(o: SessionOptions) {
    this.sampleRate = o.sampleRate;
    this.clips = o.clips;
    this.master = o.master;
    this.tempo = o.tempo;
    this.gridOffset = o.gridOffset;
    this.fixed = o.fixed ?? new Map();
    this.open = o.open;
    this.openStems = o.openStems;
    this.pool = o.pool;
    this.ends = o.clips.map(c => clipEnd(c, o.master));
    this.ownKey = RenderSession.structureKey(o.clips, o.master);
    const t0 = o.from ?? 0;
    this.startFrame = Math.round(o.tempo.real(t0) * o.sampleRate);
    this.absoluteFrame = this.startFrame;
    for (const i of o.indices ?? o.clips.map((_, k) => k)) {
      if (i < 0 || i >= o.clips.length) continue;
      const c = o.clips[i];
      if (!(this.ends[i] > t0)) continue;
      const frame = Math.round(o.tempo.real(c.start) * o.sampleRate);
      if (frame <= this.startFrame) this.addVoice(i, Math.max(0, t0 - c.start) * rate(c, o.master), t0);
      else this.waiting.push({ index: i, frame });
    }
    this.waiting.sort((a, b) => a.frame - b.frame);
  }

  /** Creates a session, preparing enough time-stretch units for the busiest moment of the mix. */
  static async create(o: SessionOptions): Promise<RenderSession> {
    await o.pool.prepare(RenderSession.maxConcurrent(o));
    return new RenderSession(o);
  }

  /** The most voices that ever play at once (tails included). */
  static maxConcurrent(o: SessionOptions) {
    const t0 = o.from ?? 0;
    const ev: [number, number][] = [];
    for (const i of o.indices ?? o.clips.map((_, k) => k)) {
      const c = o.clips[i];
      if (!c) continue;
      const e = o.tempo.real(clipEnd(c, o.master)) + TAIL;
      if (e <= o.tempo.real(t0)) continue;
      ev.push([o.tempo.real(c.start), 1], [e, -1]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, max = 0;
    for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
    return Math.max(1, max);
  }

  private addVoice(i: number, e0: number, t: number) {
    const c = this.clips[i];
    const end = Math.round((this.tempo.real(this.ends[i]) + TAIL) * this.sampleRate);
    const next = this.clips[i + 1];
    let src = this.sources.get(i);
    if (!src) {
      src = this.open(c) ?? undefined;
      if (!src) return;
      this.sources.set(i, src);
    }
    const st = this.pool.take();
    if (!st) { console.warn('[DJAW] no time-stretch unit free; track skipped', c.title); return; }
    const laneReverb = (c.transition === 'custom' && !!c.lanes && Lanes.usesReverb(c.lanes))
      || (!!next && next.transition === 'custom' && !!next.lanes && Lanes.usesReverb(next.lanes));
    const usesReverb = laneReverb || (c.fx ?? []).some(f => f.kind === 'reverb');
    let stems: StemSources | null = null;
    if (this.openStems && RenderSession.usesStems(c, next)) {
      if (!this.stemSources.has(i)) this.stemSources.set(i, this.openStems(c));
      stems = this.stemSources.get(i) ?? null;
    }
    const v = new Voice(i, end, c, next, this.tempo.bpm(Math.max(t, c.start)), this.sampleRate, e0, src, st, usesReverb, stems);
    if (v.isEmpty) { this.pool.give(st); return; }
    this.voices.push(v);
  }

  stop() {
    for (const v of this.voices) this.pool.give(v.stretcher);
    this.voices = [];
    for (const s of this.sources.values()) s.close();
    this.sources.clear();
    for (const s of this.stemSources.values()) for (const src of s ?? []) src.close();
    this.stemSources.clear();
  }

  /** Timeline (reference) time of the next frame. */
  get time() { return this.tempo.referenceAtReal(this.absoluteFrame / this.sampleRate); }
  get renderedFrames() { return this.absoluteFrame - this.startFrame; }
  get activeVoices() { return this.voices.length; }

  /** Length of the next step: up to the next multiple of 512 frames (shorter when a track comes in sooner). */
  get nextChunk() {
    let n = CHUNK - (((this.absoluteFrame % CHUNK) + CHUNK) % CHUNK);
    const w = this.waiting[0];
    if (w && w.frame > this.absoluteFrame && w.frame - this.absoluteFrame < n) n = w.frame - this.absoluteFrame;
    return n;
  }

  /** Renders the next step into L / R; returns the number of frames. */
  renderNext(): number {
    while (this.waiting.length && this.waiting[0].frame <= this.absoluteFrame) {
      const w = this.waiting.shift()!;
      this.addVoice(w.index, 0, this.clips[w.index].start);
    }
    if (this.voices.some(v => v.endFrame < this.absoluteFrame)) {
      for (const v of this.voices) if (v.endFrame < this.absoluteFrame) this.pool.give(v.stretcher);
      this.voices = this.voices.filter(v => v.endFrame >= this.absoluteFrame);
    }
    const n = this.nextChunk;
    const sr = this.sampleRate;
    const t = this.tempo.referenceAtReal((this.absoluteFrame + n / 2) / sr);
    const bpm = this.tempo.bpm(t);
    const beat = (t - this.gridOffset) * this.master / 60;
    this.L.fill(0, 0, n);
    this.R.fill(0, 0, n);
    for (const v of this.voices) {
      const s = this.fixed.get(v.index) ?? Automation.state(this.clips, v.index, t, this.master, this.ends);
      v.render(n, s, bpm, beat, 0.02, this.L, this.R);
    }
    this.absoluteFrame += n;
    return n;
  }

  /** Takes over changed levels / EQ / effects / curves without starting again. False when audio moves in time. */
  update(clips: Clip[], master: number): boolean {
    if (master !== this.master || clips.length !== this.clips.length || RenderSession.structureKey(clips, master) !== this.ownKey) return false;
    this.clips = clips;
    this.ends = clips.map(c => clipEnd(c, master));
    return true;
  }

  /** Whether a track's transitions use its stems (then it plays from its four stems). */
  static usesStems(c: Clip, next?: Clip) {
    return (c.transition === 'custom' && !!c.lanes && Lanes.usesStemsIncoming(c.lanes))
      || (!!next && next.transition === 'custom' && !!next.lanes && Lanes.usesStemsOutgoing(next.lanes));
  }

  /** Everything that decides *which* audio plays *when* (the rest is automation, read every step). */
  static structureKey(clips: Clip[], master: number): string {
    const parts: unknown[] = [master];
    clips.forEach((c, i) => {
      parts.push(c.transition === 'custom' && !!c.lanes && Lanes.usesReverb(c.lanes));
      // Stems in use change the voices.
      parts.push(RenderSession.usesStems(c, clips[i + 1]));
    });
    for (const c of clips) {
      parts.push(c.id, c.url, c.start, c.trimStart, c.trimEnd, c.playLength ?? null, c.edits ?? null, c.bpm, c.firstBeat,
        c.tempo ?? null, c.tempoBars ?? null, c.tempoSync, c.keyLock ?? null, c.keyShift ?? null,
        c.transition === 'cut', c.transition === 'brake', c.transition === 'backspin', c.spinBeats ?? null,
        c.mixInBar, c.mixOutBar, c.transitionBars, c.endBar ?? null, c.inNudge ?? null, c.outNudge ?? null,
        (c.fx ?? []).some(f => f.kind === 'reverb'));
    }
    return JSON.stringify(parts);
  }
}
