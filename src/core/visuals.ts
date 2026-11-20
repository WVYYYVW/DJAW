// Port of mac/DJAW/Media/VisualPainter.swift (+ the feature analysis of VideoExporter.swift / LiveFeatures):
// club-style visuals for the video export and the live preview, drawn with Canvas 2D.
// The Mac version draws in CoreGraphics' y-up space; here the canvas is flipped once per frame so the geometry
// stays the same, and images / text are drawn un-flipped.
import { L } from './i18n';
import type { SectionKind, TrackStructure } from './analysis/structure';
import { Clip, timelineTimeOfSource } from './models';
import { TempoMap } from './tempo';
import { fft } from './analysis/fft';

export type VisualStyle = 'auto' | 'pulse' | 'tunnel' | 'lasers' | 'spectrum';
export const visualStyles: VisualStyle[] = ['auto', 'pulse', 'tunnel', 'lasers', 'spectrum'];
export const VisualStyles = {
  title: (s: VisualStyle) => ({
    auto: L('オート VJ（曲の展開に合わせて切り替え）', 'Auto VJ (follows the tracks’ build-ups and drops)'),
    pulse: L('パルス（ジャケット＋円形スペクトラム）', 'Pulse (artwork + circular spectrum)'),
    tunnel: L('トンネル（ビートで奥へ流れる図形）', 'Tunnel (shapes flying on the beat)'),
    lasers: L('レーザー（クラブ照明風）', 'Lasers (club lighting)'),
    spectrum: L('スペクトラム（バー＋曲名、配信向け）', 'Spectrum (bars + titles, for uploads)'),
  })[s],
};

export interface VisualSection { start: number; end: number; kind: SectionKind; build?: boolean }

export interface TrackVisual {
  title: string;
  artist: string;
  artwork: CanvasImageSource & { width: number; height: number } | null;
  hue: number;
  start: number;
  landing: number;
  end: number;
  sections: VisualSection[];
  palette: number[];
}

export interface VisualOptions { width: number; height: number; fps: number; style: VisualStyle; showTrackInfo: boolean; mixTitle: string }

export const BANDS = 48;

export interface FeatureFrame { level: number; low: number; mid: number; high: number; kick: number; spectrum: Float32Array }
export const silentFrame: FeatureFrame = { level: 0, low: 0, mid: 0, high: 0, kick: 0, spectrum: new Float32Array(BANDS) };

export interface FeatureSource { frame(f: number): FeatureFrame | null }

// MARK: - Features

const hann = (() => { const w = new Float64Array(2048); for (let i = 0; i < 2048; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 2048); return w; })();

function spectrumOf(seg: (i: number) => number) {
  const re = new Float64Array(2048), im = new Float64Array(2048);
  for (let i = 0; i < 2048; i++) re[i] = seg(i) * hann[i];
  fft(re, im);
  const mags = new Float32Array(1024);
  for (let k = 0; k < 1024; k++) mags[k] = Math.hypot(re[k], im[k]);
  return mags;
}

function bandsOf(mags: Float32Array, sr: number) {
  const band = (lo: number, hi: number) => {
    const a = Math.max(1, Math.trunc(lo / sr * 2048)), e = Math.max(a + 1, Math.min(1024, Math.trunc(hi / sr * 2048)));
    let s = 0;
    for (let i = a; i < e; i++) s += mags[i] * mags[i];
    return Math.sqrt(s / (e - a));
  };
  const spec = new Float32Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const f0 = 40 * Math.pow(16000 / 40, b / BANDS), f1 = 40 * Math.pow(16000 / 40, (b + 1) / BANDS);
    const a = Math.max(1, Math.min(1023, Math.trunc(f0 / sr * 2048))), e = Math.max(a + 1, Math.min(1024, Math.trunc(f1 / sr * 2048)));
    let m = 0;
    for (let i = a; i < e; i++) m = Math.max(m, mags[i]);
    spec[b] = 20 * Math.log10(Math.max(m, 1e-6));
  }
  return { level: band(30, 15000), low: band(30, 150), mid: band(300, 3000), high: band(5000, 15000), spec };
}

/** What the music does in every video frame of an exported mix (mono samples at `sr`). */
export class ExportFeatures implements FeatureSource {
  frames: number;
  private level: Float32Array; private low: Float32Array; private mid: Float32Array; private high: Float32Array; private kick: Float32Array;
  private spectrum: Float32Array[];

  constructor(read: (from: number, n: number) => Float32Array, length: number, sr: number, fps: number, progress?: (p: number) => void) {
    const frames = Math.trunc(length / sr * fps) + 1;
    this.frames = frames;
    const hop = sr / fps;
    this.level = new Float32Array(frames); this.low = new Float32Array(frames); this.mid = new Float32Array(frames); this.high = new Float32Array(frames);
    this.spectrum = [];
    for (let f = 0; f < frames; f++) {
      const s0 = Math.trunc(f * hop) - 1024;
      const seg = read(s0, 2048);
      const b = bandsOf(spectrumOf(i => seg[i]), sr);
      this.level[f] = b.level; this.low[f] = b.low; this.mid[f] = b.mid; this.high[f] = b.high;
      this.spectrum.push(b.spec);
      if (f % 300 === 0) progress?.(f / frames);
    }
    const normalise = (v: Float32Array) => {
      const sorted = Float32Array.from(v).sort();
      const ref = Math.max(sorted[Math.min(sorted.length - 1, Math.trunc(sorted.length * 0.97))], 1e-6);
      for (let i = 0; i < v.length; i++) v[i] = Math.min(1.2, v[i] / ref);
    };
    normalise(this.level); normalise(this.low); normalise(this.mid); normalise(this.high);
    const all = new Float32Array(frames * BANDS);
    this.spectrum.forEach((s, f) => all.set(s, f * BANDS));
    all.sort();
    const top = all[Math.min(all.length - 1, Math.trunc(all.length * 0.995))];
    const floor = top - 60;
    for (const s of this.spectrum) for (let b = 0; b < BANDS; b++) s[b] = Math.max(0, Math.min(1, (s[b] - floor) / 60));
    this.kick = new Float32Array(frames);
    let hold = 0;
    for (let f = 0; f < frames; f++) {
      const rise = f > 0 ? Math.max(0, this.low[f] - this.low[f - 1]) : 0;
      hold = Math.max(hold * 0.82, Math.min(1, rise * 3.5));
      this.kick[f] = hold;
    }
  }

  frame(f: number): FeatureFrame | null {
    if (this.frames <= 0) return null;
    const k = Math.min(Math.max(0, f), this.frames - 1);
    return { level: this.level[k], low: this.low[k], mid: this.mid[k], high: this.high[k], kick: this.kick[k], spectrum: this.spectrum[k] };
  }
}

/** The same features computed on the fly from the preview's audio, levels scaled against what has been loud recently. */
export class LiveFeatures implements FeatureSource {
  readonly fps = 30;
  private sampleRate = 44100;
  private samples = new Float32Array(0);
  private count = 0;
  private firstSample = 0;
  private nextFrame = 0;
  private frames = new Map<number, FeatureFrame>();
  private refs = [1e-3, 1e-3, 1e-3, 1e-3];
  private top = -20;
  private lastLow = 0;
  private hold = 0;

  reset(sr: number, at: number) {
    this.sampleRate = sr;
    this.count = 0;
    this.firstSample = at;
    this.nextFrame = Math.ceil(at / sr * this.fps);
    this.frames.clear();
    this.hold = 0;
  }

  frame(f: number) { return this.frames.get(f) ?? null; }

  /** Rendered mono audio starting at mix sample `start`. */
  feed(mono: Float32Array, start: number) {
    if (start !== this.firstSample + this.count) { this.count = 0; this.firstSample = start; this.nextFrame = Math.ceil(start / this.sampleRate * this.fps); }
    if (this.count + mono.length > this.samples.length) {
      const n = new Float32Array(Math.max(1 << 16, (this.count + mono.length) * 2));
      n.set(this.samples.subarray(0, this.count));
      this.samples = n;
    }
    this.samples.set(mono, this.count);
    this.count += mono.length;
    const sr = this.sampleRate;
    for (;;) {
      const center = Math.round(this.nextFrame * sr / this.fps);
      const s0 = center - this.firstSample - 1024;
      if (s0 + 2048 > this.count) break;
      const b = bandsOf(spectrumOf(i => (s0 + i >= 0 ? this.samples[s0 + i] : 0)), sr);
      const raw = [b.level, b.low, b.mid, b.high];
      for (let k = 0; k < 4; k++) { this.refs[k] = Math.max(raw[k], this.refs[k] * 0.9993); raw[k] = Math.min(1.2, raw[k] / Math.max(this.refs[k], 1e-6)); }
      let mx = -Infinity;
      for (let i = 0; i < BANDS; i++) mx = Math.max(mx, b.spec[i]);
      this.top = Math.max(mx, this.top - 0.01);
      for (let i = 0; i < BANDS; i++) b.spec[i] = Math.max(0, Math.min(1, (b.spec[i] - (this.top - 60)) / 60));
      const rise = Math.max(0, raw[1] - this.lastLow);
      this.lastLow = raw[1];
      this.hold = Math.max(this.hold * 0.82, Math.min(1, rise * 3.5));
      this.frames.set(this.nextFrame, { level: raw[0], low: raw[1], mid: raw[2], high: raw[3], kick: this.hold, spectrum: b.spec });
      this.nextFrame++;
    }
    if (this.frames.size > this.fps * 20) { const keep = this.nextFrame - this.fps * 10; for (const k of this.frames.keys()) if (k < keep) this.frames.delete(k); }
    const needFrom = Math.round(this.nextFrame * sr / this.fps) - this.firstSample - 1024;
    if (needFrom > 4096 && needFrom < this.count) {
      this.samples.copyWithin(0, needFrom, this.count);
      this.count -= needFrom;
      this.firstSample += needFrom;
    }
  }
}

// MARK: - Track list helpers

/** The main colours of an artwork (up to two hues). */
export function artworkPalette(img: CanvasImageSource | null): number[] {
  if (!img) return [];
  const n = 24;
  const c = new OffscreenCanvas(n, n);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, n, n);
  const px = ctx.getImageData(0, 0, n, n).data;
  const bins = new Array(12).fill(0);
  for (let i = 0; i < n * n; i++) {
    const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    if (sat <= 0.25 || mx <= 0.2) continue;
    const d = mx - mn;
    let hue = mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d;
    hue = ((hue / 6 + 1) % 1);
    bins[Math.trunc(hue * 12) % 12] += sat * mx;
  }
  const order = bins.map((_, k) => k).sort((a, b) => bins[b] - bins[a]);
  const first = order[0];
  if (bins[first] <= 2) return [];
  const out = [(first + 0.5) / 12];
  const second = order.slice(1).find(k => bins[k] > bins[first] * 0.25 && Math.min(Math.abs(k - first), 12 - Math.abs(k - first)) >= 2);
  if (second != null) out.push((second + 0.5) / 12);
  return out;
}

/** A track's sections on the mix's clock, with the last 8 bars before each drop marked as the build-up. */
export function visualSections(c: Clip, s: TrackStructure | null | undefined, master: number, tempo: TempoMap): VisualSection[] {
  if (!s) return [];
  const real = (bar: number) => tempo.real(timelineTimeOfSource(c, s.firstBeat + bar * s.barSeconds, master));
  const out: VisualSection[] = [];
  s.sections.forEach((sec, k) => {
    const a = real(sec.start), b = real(sec.end);
    if (!(b > a)) return;
    const nextIsDrop = k + 1 < s.sections.length && s.sections[k + 1].kind === 'drop' && sec.kind !== 'drop';
    if (nextIsDrop && sec.end - sec.start > 8) {
      const cut = real(sec.end - 8);
      out.push({ start: a, end: cut, kind: sec.kind }, { start: cut, end: b, kind: sec.kind, build: true });
    } else out.push({ start: a, end: b, kind: sec.kind, build: nextIsDrop });
  });
  return out;
}

// MARK: - Painter

interface Moment {
  t: number; beat: number; level: number; low: number; mid: number; high: number; kick: number;
  hue: number; hue2: number; main: number; incoming: number | null; spectrum: Float32Array;
  intensity: number; kind: SectionKind; build: number; dropHit: number; preDrop: boolean; phrase: number; style: VisualStyle;
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export class VisualPainter {
  readonly w: number;
  readonly h: number;
  readonly canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private prev: OffscreenCanvas;
  private hasPrev = false;
  private bloomCanvas: OffscreenCanvas;
  private smooth = new Float32Array(BANDS);
  private lastFrame = -10;
  private flashes: number[] = [];
  private scenes: VisualStyle[] = [];
  private sceneState: { dropKey: string | null; since: number; dropCount: number } = { dropKey: null, since: 0, dropCount: 0 };

  constructor(readonly o: VisualOptions, readonly tracks: TrackVisual[], readonly fx: FeatureSource,
    readonly tempo: TempoMap, readonly gridOffset: number, readonly master: number) {
    this.w = o.width; this.h = o.height;
    this.canvas = new OffscreenCanvas(o.width, o.height);
    // Opaque canvases: lets the GPU skip blending with what is behind them.
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.prev = new OffscreenCanvas(o.width, o.height);
    this.bloomCanvas = new OffscreenCanvas(Math.max(1, Math.round(o.width / 4)), Math.max(1, Math.round(o.height / 4)));
  }

  private mixHue(a: number, b: number, x: number) {
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    let v = a + d * x;
    if (v < 0) v += 1;
    return v % 1;
  }

  color(hue: number, s: number, b: number, a = 1) {
    const hh = (((hue % 1) + 1) % 1) * 6;
    const i = Math.trunc(hh) % 6, f = hh - Math.floor(hh);
    b = Math.min(1, Math.max(0, b)); s = Math.min(1, Math.max(0, s));
    const p = b * (1 - s), q = b * (1 - s * f), u = b * (1 - s * (1 - f));
    const [r, g, bl] = [[b, u, p], [q, b, p], [p, b, u], [p, q, b], [u, p, b], [b, p, q]][i];
    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(bl * 255)},${Math.min(1, Math.max(0, a))})`;
  }

  moment(f: number): Moment {
    const t = f / this.o.fps;
    const ref = this.tempo.referenceAtReal(t);
    const beat = (ref - this.gridOffset) * this.master / 60;
    let main = 0;
    this.tracks.forEach((tr, i) => { if (tr.landing <= t) main = i; });
    const incoming = main + 1 < this.tracks.length && this.tracks[main + 1].start <= t ? main + 1 : null;
    const hues = (k: number): [number, number] => {
      const tr = this.tracks[k];
      if (tr.palette.length) return [tr.palette[0], tr.palette.length > 1 ? tr.palette[1] : (tr.palette[0] + 0.33) % 1];
      return [tr.hue, (tr.hue + 0.33) % 1];
    };
    let [hue, hue2] = this.tracks.length ? hues(main) : [0.6, 0.9];
    if (incoming != null) {
      const a = this.tracks[incoming].start, b = Math.max(a + 0.01, this.tracks[incoming].landing);
      const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
      const [h1, h2] = hues(incoming);
      hue = this.mixHue(hue, h1, x); hue2 = this.mixHue(hue2, h2, x);
    }
    const ff = this.fx.frame(f) ?? silentFrame;
    for (let i = 0; i < BANDS; i++) this.smooth[i] = Math.max(i < ff.spectrum.length ? ff.spectrum[i] : 0, this.smooth[i] - 0.035);
    let kind: SectionKind = 'drop';
    let build = 0, dropHit = 0, preDrop = false, intensity = 0.75;
    const sec = this.tracks.length ? this.tracks[main].sections.find(x => x.start <= t && t < x.end) : undefined;
    if (sec) {
      kind = sec.kind;
      const beatSec = 60 / Math.max(1, this.tempo.bpm(ref));
      intensity = sec.kind === 'drop' ? 1 : sec.kind === 'breakdown' ? 0.3 : 0.4;
      if (sec.build) {
        build = Math.min(1, Math.max(0, (t - sec.start) / Math.max(0.01, sec.end - sec.start)));
        intensity = 0.4 + 0.5 * build;
        preDrop = sec.end - t < beatSec;
      }
      if (sec.kind === 'drop') dropHit = Math.max(0, 1 - (t - sec.start) / (2 * beatSec));
    }
    intensity = Math.min(1, intensity * (0.6 + 0.5 * ff.level));
    const phrase = Math.floor(beat / 32);
    const style = this.o.style === 'auto' ? this.autoScene(phrase) : this.o.style;
    return { t, beat, level: ff.level, low: ff.low, mid: ff.mid, high: ff.high, kick: ff.kick, hue, hue2, main, incoming,
      spectrum: this.smooth, intensity, kind, build, dropHit, preDrop, phrase, style };
  }

  private autoScene(phrase: number): VisualStyle {
    const p = Math.max(0, phrase);
    while (this.scenes.length <= p) this.scenes.push(this.nextScene(this.scenes.length));
    return this.scenes[p];
  }

  private nextScene(p: number): VisualStyle {
    const midBeat = p * 32 + 16;
    const t = this.tempo.real(this.gridOffset + midBeat * 60 / Math.max(1, this.master));
    let main = 0;
    this.tracks.forEach((tr, i) => { if (tr.landing <= t) main = i; });
    const sec = this.tracks.length ? this.tracks[main].sections.find(x => x.start <= t && t < x.end) : undefined;
    const kind = sec?.kind ?? 'drop';
    const previous = this.scenes[this.scenes.length - 1];
    const held = p - this.sceneState.since;
    const rotation: VisualStyle[] = ['lasers', 'tunnel', 'pulse'];
    let wanted: VisualStyle;
    if (kind === 'drop') {
      const key = `${main}|${sec ? Math.trunc(sec.start * 10) : -1}`;
      if (key !== this.sceneState.dropKey) {
        this.sceneState.dropKey = key;
        this.sceneState.dropCount++;
        this.sceneState.since = p;
        return rotation[(this.sceneState.dropCount - 1) % rotation.length];
      }
      wanted = held >= 4 ? rotation[(rotation.indexOf(previous ?? 'lasers') + 1) % rotation.length] : (previous ?? 'lasers');
    } else {
      this.sceneState.dropKey = null;
      wanted = sec?.build ? 'tunnel' : 'pulse';
      if (previous && previous !== wanted && held < 2) return previous;
    }
    if (wanted !== previous) this.sceneState.since = p;
    return wanted;
  }

  /** Draws frame f into this.canvas. */
  draw(f: number) {
    if (Math.abs(f - this.lastFrame) > 2) { this.hasPrev = false; this.flashes = []; }
    this.lastFrame = f;
    const m = this.moment(f);
    const ctx = this.ctx, w = this.w, h = this.h;
    ctx.save();
    // y-up like CoreGraphics.
    ctx.setTransform(1, 0, 0, -1, 0, h);
    this.background(ctx, m);
    this.feedback(ctx, m);
    ctx.globalCompositeOperation = 'lighter';
    switch (m.style) {
      case 'pulse': case 'auto': this.pulse(ctx, m); break;
      case 'tunnel': this.tunnel(ctx, m); break;
      case 'lasers': this.lasers(ctx, m); break;
      case 'spectrum': this.spectrumBars(ctx, m); break;
    }
    ctx.globalCompositeOperation = 'source-over';
    if (m.style === 'pulse') this.disc(ctx, w / 2, h / 2, h * 0.2 * (1 + 0.07 * m.kick * m.intensity), m);
    ctx.restore();
    // What is fed back next time: the picture before the glow and the text.
    const pc = this.prev.getContext('2d', { alpha: false })!;
    pc.globalCompositeOperation = 'copy';
    pc.drawImage(this.canvas, 0, 0);
    pc.globalCompositeOperation = 'source-over';
    this.hasPrev = true;
    this.bloom(m);
    ctx.save();
    ctx.setTransform(1, 0, 0, -1, 0, h);
    this.flash(ctx, m);
    this.vignette(ctx);
    ctx.restore();
    if (this.o.showTrackInfo) this.trackInfo(m);
    if (this.o.mixTitle && m.t < 6) this.title(this.o.mixTitle, Math.min(1, m.t / 0.8, (6 - m.t) / 1));
  }

  // MARK: Layers

  private background(ctx: Ctx, m: Moment) {
    const w = this.w, h = this.h;
    ctx.fillStyle = 'rgb(3,3,5)';
    ctx.fillRect(0, 0, w, h);
    const glow = m.preDrop ? 0.02 : 0.08 + (0.14 + 0.22 * m.kick) * m.intensity;
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, this.color(m.hue, 0.85, glow));
    g.addColorStop(1, this.color(m.hue2, 0.9, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  private feedback(ctx: Ctx, m: Moment) {
    if (!this.hasPrev || m.preDrop) return;
    const w = this.w, h = this.h;
    const zoom = 1.006 + 0.03 * m.intensity * (0.4 + m.kick) + 0.02 * m.build;
    const turn = 0.0025 * Math.sin(m.beat * Math.PI / 16) * (m.kind === 'drop' ? 1.5 : 0.6);
    const decay = m.kind === 'drop' ? 0.82 : 0.9;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(turn);
    ctx.scale(zoom, zoom);
    ctx.globalAlpha = decay;
    ctx.imageSmoothingQuality = 'low';
    // The stored frame is already the right way up: undo the y flip for it.
    ctx.scale(1, -1);
    ctx.drawImage(this.prev, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  private bloom(m: Moment) {
    const b = this.bloomCanvas, bc = b.getContext('2d', { alpha: false })!;
    bc.globalCompositeOperation = 'copy';
    bc.filter = `blur(${Math.max(1, this.h * 0.02 / 4)}px)`;
    bc.drawImage(this.canvas, 0, 0, b.width, b.height);
    bc.filter = 'none';
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, (0.5 + 0.6 * m.intensity) * 0.55);
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(b, 0, 0, this.w, this.h);
    ctx.restore();
  }

  private flash(ctx: Ctx, m: Moment) {
    this.flashes = this.flashes.filter(x => m.t - x <= 1);
    let a = 0;
    if (m.dropHit > 0.9) a = 0.45;
    else if (m.kind === 'drop' && m.kick > 0.8 && m.intensity > 0.85) a = 0.12 * m.kick;
    if (a <= 0 || this.flashes.length >= 3) return;
    const last = this.flashes[this.flashes.length - 1];
    if (last == null || m.t - last >= 0.3) this.flashes.push(m.t);
    ctx.fillStyle = this.color(m.hue2, 0.25, 1, a);
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private vignette(ctx: Ctx) {
    const w = this.w, h = this.h;
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
    g.addColorStop(0.55, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // MARK: Looks

  private pulse(ctx: Ctx, m: Moment) {
    const w = this.w, h = this.h;
    const cx = w / 2, cy = h / 2;
    const r = h * 0.2 * (1 + 0.07 * m.kick * m.intensity);
    const rate = m.build > 0.5 ? 2 : 1;
    const p0 = m.beat * rate - Math.floor(m.beat * rate);
    if (m.intensity > 0.35) {
      for (let k = 0; k < 3; k++) {
        const p = (p0 + k) / 3;
        const rr = r * (1.1 + p * 2.4);
        ctx.strokeStyle = this.color(m.hue, 0.7, 1, (1 - p) * (0.1 + 0.4 * m.intensity));
        ctx.lineWidth = h * 0.006;
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
      }
    }
    const nb = m.spectrum.length, bars = nb * 2;
    ctx.lineCap = 'round';
    for (let i = 0; i < bars; i++) {
      const b = i < nb ? i : bars - 1 - i;
      const v = m.spectrum[b];
      const a = i / bars * 2 * Math.PI + Math.PI / 2 + m.beat * 0.02;
      const len = h * 0.02 + h * 0.22 * v * v * (0.5 + 0.5 * m.intensity);
      ctx.strokeStyle = this.color(m.hue + b / nb * 0.2, 0.75, 1, 0.45 + 0.5 * v);
      ctx.lineWidth = Math.max(2, 2 * Math.PI * r / bars * 0.55);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 1.06, cy + Math.sin(a) * r * 1.06);
      ctx.lineTo(cx + Math.cos(a) * (r * 1.06 + len), cy + Math.sin(a) * (r * 1.06 + len));
      ctx.stroke();
    }
  }

  /** Draws an image upright (cover-filled) into a rect given in the flipped (y-up) space. */
  private drawFill(ctx: Ctx, img: CanvasImageSource & { width: number; height: number }, x: number, y: number, rw: number, rh: number) {
    const s = Math.max(rw / img.width, rh / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.save();
    ctx.translate(x + rw / 2, y + rh / 2);
    ctx.scale(1, -1);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  private disc(ctx: Ctx, cx: number, cy: number, r: number, m: Moment) {
    const h = this.h;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    const art = this.tracks.length ? this.tracks[m.main].artwork : null;
    if (art) this.drawFill(ctx, art, cx - r, cy - r, r * 2, r * 2);
    else {
      const g = ctx.createLinearGradient(cx - r, cy + r, cx + r, cy - r);
      g.addColorStop(0, this.color(m.hue, 0.6, 0.9)); g.addColorStop(1, this.color(m.hue2, 0.8, 0.35));
      ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    if (m.incoming != null && this.tracks[m.incoming].artwork) {
      const tr = this.tracks[m.incoming];
      const a = tr.start, b = Math.max(a + 0.01, tr.landing);
      ctx.globalAlpha = Math.min(1, Math.max(0, (m.t - a) / (b - a)));
      this.drawFill(ctx, tr.artwork!, cx - r, cy - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.strokeStyle = this.color(m.hue, 0.5, 1, 0.9);
    ctx.lineWidth = h * 0.006;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }

  private tunnel(ctx: Ctx, m: Moment) {
    const w = this.w, h = this.h, cx = w / 2, cy = h / 2;
    const speed = m.kind === 'drop' ? 1 : (m.build > 0 ? 0.5 + 1.5 * m.build : 0.25);
    const travel = m.beat * speed;
    const phase = travel - Math.floor(travel);
    const n = 16, bar = Math.floor(m.beat / 4);
    const sides = m.phrase % 2 === 0 ? 4 : 6;
    for (let k = n - 1; k >= 0; k--) {
      const depth = (k + phase) / n;
      const size = Math.pow(depth, 2.2) * Math.max(w, h) * 1.3;
      if (size <= 4) continue;
      const rot = (m.beat * 0.06 + k * 0.1 + bar * 0.35) * (m.phrase % 2 === 0 ? 1 : -1);
      const band = m.spectrum[Math.min(m.spectrum.length - 1, Math.trunc(k * m.spectrum.length / n))];
      ctx.beginPath();
      for (let s = 0; s <= sides; s++) {
        const a = s / sides * 2 * Math.PI + rot;
        const x = cx + Math.cos(a) * size / 2, y = cy + Math.sin(a) * size / 2;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.color(m.hue + k * 0.025, 0.8, 1, depth * (0.2 + 0.8 * band) * (0.4 + 0.6 * m.intensity));
      ctx.lineWidth = h * 0.004 + h * 0.018 * depth * (0.3 + m.kick * m.intensity);
      ctx.stroke();
    }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, h * 0.35);
    g.addColorStop(0, this.color(m.hue2, 0.4, 1, 0.45 * m.kick * m.intensity + 0.08));
    g.addColorStop(1, this.color(m.hue2, 0.4, 1, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  private lasers(ctx: Ctx, m: Moment) {
    const w = this.w, h = this.h;
    const origins = [[w * 0.5, -h * 0.05], [w * 0.08, -h * 0.05], [w * 0.92, -h * 0.05]];
    const barPhase = m.beat / 4 - Math.floor(m.beat / 4);
    const beams = 3 + Math.round(m.intensity * 6);
    origins.forEach(([ox, oy], oi) => {
      if (m.intensity < 0.5 && oi > 0) return;
      for (let b = 0; b < beams; b++) {
        const spread = 0.55 + 0.25 * Math.sin(m.beat * Math.PI / 4 + oi);
        const base = (b - (beams - 1) / 2) / beams * spread * 2;
        const sweep = Math.sin(barPhase * 2 * Math.PI + oi * 2.1) * 0.35;
        const a = Math.PI / 2 + base + sweep * (oi === 0 ? 1 : -1);
        const len = Math.max(w, h) * 1.4;
        const band = m.spectrum[Math.min(m.spectrum.length - 1, (b * 5 + oi * 9) % m.spectrum.length)];
        const alpha = (0.1 + 0.6 * band * (0.4 + m.high)) * (0.4 + 0.6 * m.intensity);
        const hue = oi === 0 ? m.hue : m.hue2;
        for (const [wd, al] of [[h * 0.024, alpha * 0.22], [h * 0.005, alpha]]) {
          ctx.strokeStyle = this.color(hue, 0.85, 1, al);
          ctx.lineWidth = wd;
          ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + Math.cos(a) * len, oy + Math.sin(a) * len); ctx.stroke();
        }
      }
    });
  }

  private spectrumBars(ctx: Ctx, m: Moment) {
    const w = this.w, h = this.h;
    const nb = m.spectrum.length;
    const left = w * 0.08, right = w * 0.92, baseY = h * 0.3;
    const bw = (right - left) / nb;
    for (let b = 0; b < nb; b++) {
      const v = m.spectrum[b];
      const bh = h * 0.02 + h * 0.42 * v * v;
      const x = left + b * bw;
      ctx.fillStyle = this.color(m.hue + b / nb * 0.3, 0.75, 1, 0.9);
      ctx.fillRect(x + bw * 0.12, baseY, bw * 0.76, bh);
      ctx.fillStyle = this.color(m.hue + b / nb * 0.3, 0.75, 1, 0.16);
      ctx.fillRect(x + bw * 0.12, baseY - bh * 0.35 - h * 0.01, bw * 0.76, bh * 0.35);
    }
    const beatInBar = ((Math.floor(m.beat) % 4) + 4) % 4;
    for (let k = 0; k < 4; k++) {
      const r = h * 0.008;
      const x = w / 2 + (k - 2) * h * 0.04 + h * 0.02;
      ctx.fillStyle = this.color(m.hue, 0.5, 1, k === beatInBar ? 1 : 0.25);
      ctx.beginPath(); ctx.arc(x, h * 0.18, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // MARK: Text (drawn in the normal y-down space; y values converted from the Mac's y-up layout)

  private font(size: number, bold: boolean) { return `${bold ? '700' : '400'} ${size}px "Yu Gothic UI", "Segoe UI", "Hiragino Sans", system-ui, sans-serif`; }

  private fit(ctx: Ctx, s: string, maxWidth: number) {
    let text = s;
    while (ctx.measureText(text).width > maxWidth && text.length > 4) text = text.slice(0, -2) + '…';
    return text;
  }

  /**
   * Breaks a text into lines no wider than maxWidth: at spaces and after punctuation where it can (Latin titles), and
   * between any two characters otherwise (Japanese), never starting a line with closing punctuation.
   */
  private wrap(ctx: Ctx, text: string, maxWidth: number): string[] {
    const chars = [...text.trim()];
    const lines: string[] = [];
    let line = '', breakAt = -1; // index in `line` after which a break is good
    const closing = /[、。，．・）」』】〕〉》！？!?,.)\]}ー〜…]/;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (line === '' && ch === ' ') continue;
      const next = line + ch;
      if (ctx.measureText(next).width <= maxWidth || line === '') {
        line = next;
        if (/[\s\-–—/／(（\[「『:：]/.test(ch)) breakAt = line.length - (/[(（\[「『]/.test(ch) ? 1 : 0);
        continue;
      }
      // Too wide: break at the last good place in this line if it is not too early, else before this character
      // (moving one character down if this one may not start a line).
      let cut = breakAt > line.length * 0.4 ? breakAt : line.length;
      if (cut === line.length && closing.test(ch) && line.length > 1) cut = line.length - 1;
      lines.push(line.slice(0, cut).trimEnd());
      line = (line.slice(cut) + ch).trimStart();
      breakAt = -1;
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * The largest of `sizes` at which the text fits in `maxLines` lines; failing that the smallest, its last line ending
   * in an ellipsis.
   */
  private layoutText(ctx: Ctx, text: string, maxWidth: number, sizes: number[], maxLines: number[], bold: boolean) {
    for (let k = 0; k < sizes.length; k++) {
      ctx.font = this.font(sizes[k], bold);
      const lines = this.wrap(ctx, text, maxWidth);
      if (lines.length <= maxLines[k]) return { size: sizes[k], lines };
    }
    const size = sizes[sizes.length - 1], n = maxLines[maxLines.length - 1];
    ctx.font = this.font(size, bold);
    const lines = this.wrap(ctx, text, maxWidth);
    const kept = lines.slice(0, n);
    // The last line takes the rest, cut to fit with an ellipsis.
    let last = [...lines.slice(n - 1).join(' ')];
    while (last.length > 1 && ctx.measureText(last.join('').trimEnd() + '…').width > maxWidth) last.pop();
    kept[n - 1] = last.join('').trimEnd() + '…';
    return { size, lines: kept };
  }

  private title(s: string, alpha: number) {
    if (alpha <= 0) return;
    const ctx = this.ctx, w = this.w, h = this.h;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    const t = this.layoutText(ctx, s, w * 0.84, [h * 0.06, h * 0.05, h * 0.045, h * 0.04], [1, 1, 2, 2], true);
    ctx.font = this.font(t.size, true);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    const lh = t.size * 1.2;
    // The first line where the single line used to be, further lines below it.
    t.lines.forEach((l, k) => ctx.fillText(l, (w - ctx.measureText(l).width) / 2, h - h * 0.82 + k * lh));
    ctx.restore();
  }

  private trackInfo(m: Moment) {
    if (!this.tracks.length) return;
    const ctx = this.ctx, w = this.w, h = this.h;
    const tr = this.tracks[m.main];
    const since = m.t - tr.landing;
    const pad = h * 0.035;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    if (since >= 0 && since < 9) {
      const inT = Math.min(1, since / 0.6), outT = Math.max(0, (since - 8.2) / 0.8);
      const ease = 1 - Math.pow(1 - inT, 3);
      const a = Math.min(1, inT * 2) * (1 - outT);
      if (a > 0) {
        // The card fits its text: the title as large as it fits (one line, then two, then three at smaller sizes),
        // the artist below; wider and taller cards for long names, up to half the picture's width.
        const art = h * 0.14, maxTextW = w * 0.5;
        const title = this.layoutText(ctx, tr.title, maxTextW, [h * 0.042, h * 0.038, h * 0.038, h * 0.034, h * 0.03, h * 0.027], [1, 1, 2, 2, 2, 3], true);
        const artist = tr.artist ? this.layoutText(ctx, tr.artist, maxTextW, [h * 0.028, h * 0.025, h * 0.022], [1, 1, 1], false) : null;
        const titleLH = title.size * 1.2, artistLH = artist ? artist.size * 1.25 : 0, gap = artist ? h * 0.01 : 0;
        ctx.font = this.font(title.size, true);
        let textW = Math.max(...title.lines.map(l => ctx.measureText(l).width));
        if (artist) { ctx.font = this.font(artist.size, false); textW = Math.max(textW, ...artist.lines.map(l => ctx.measureText(l).width)); }
        textW = Math.min(maxTextW, Math.max(w * 0.16, textW));
        const textH = title.lines.length * titleLH + gap + artistLH;
        const inner = Math.max(art, textH);
        const cardW = art + pad * 1.5 + textW + pad * 0.6, cardH = inner + pad;
        const slide = (1 - ease) * -(cardW + pad);
        const x = pad + slide, y = h - pad - cardH;
        ctx.fillStyle = `rgba(0,0,0,${0.6 * a})`;
        ctx.beginPath(); ctx.roundRect(x, y, cardW, cardH, h * 0.015); ctx.fill();
        ctx.fillStyle = this.color(m.hue, 0.8, 1, a);
        ctx.fillRect(x, y + h * 0.012, h * 0.006, cardH - h * 0.024);
        const ax = x + pad / 2, ay = y + pad / 2 + (inner - art) / 2;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.roundRect(ax, ay, art, art, h * 0.01); ctx.clip();
        if (tr.artwork) {
          const s = Math.max(art / tr.artwork.width, art / tr.artwork.height);
          ctx.drawImage(tr.artwork, ax + art / 2 - tr.artwork.width * s / 2, ay + art / 2 - tr.artwork.height * s / 2, tr.artwork.width * s, tr.artwork.height * s);
        } else { ctx.fillStyle = this.color(tr.hue, 0.6, 0.8); ctx.fillRect(ax, ay, art, art); }
        ctx.restore();
        // The text block, centred on the artwork (or filling the card when it is taller).
        const tx = ax + art + pad / 2;
        let ty = y + pad / 2 + (inner - textH) / 2;
        ctx.font = this.font(title.size, true);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        for (const l of title.lines) { ty += titleLH; ctx.fillText(l, tx, ty - (titleLH - title.size) * 0.55); }
        if (artist) {
          ty += gap;
          ctx.font = this.font(artist.size, false);
          ctx.fillStyle = `rgba(255,255,255,${a * 0.8})`;
          for (const l of artist.lines) { ty += artistLH; ctx.fillText(l, tx, ty - (artistLH - artist.size) * 0.55); }
        }
      }
    } else if (since >= 9) {
      // Afterwards a small caption: as small as needed to fit (then cut), up to most of the width.
      const s = tr.artist ? `${tr.artist} – ${tr.title}` : tr.title;
      const cap = this.layoutText(ctx, s, w * 0.86, [h * 0.022, h * 0.019, h * 0.017], [1, 1, 1], false);
      ctx.font = this.font(cap.size, false);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(cap.lines[0], pad, h - pad);
    }
    ctx.restore();
  }
}
