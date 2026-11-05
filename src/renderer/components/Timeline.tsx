// The DAW-style arrangement view (port of mac/DJAW/Timeline/TimelineNSView.swift): two alternating lanes (A/B),
// a bar ruler, the tempo strip, waveforms, gain envelopes, transition chips and the mixed-down waveform.
// Only the visible part is drawn; the playhead lives on its own overlay so playing does not redraw the tracks.
import React, { useEffect, useRef } from 'react';
import { L } from '../../core/i18n';
import {
  Clip, FXKind, Mathx, Style, barAtSource, barLabel, barSource, clipEnd, clipLength, cueList, downbeatPhase,
  hasEdits, landingBar, lastBar, playSegments, rate, sourceMapper, sourceTimeAtBar, timelineTimeOfBar,
  timelineTimeOfSource, transitionStyles, Edit,
} from '../../core/models';
import { FX, fxKinds, outro, TempoMap } from '../../core/tempo';
import { Automation } from '../../core/automation';
import { Structure } from '../../core/analysis/structure';
import { normalizeGain } from '../../core/render/offline';
import { store, MixStore } from '../store/store';
import { Fmt, Theme, clipColor, hsb } from '../format';
import { showContextMenu, MenuItem } from './ContextMenu';

const INSET = 24, RULER = 34, LANE_GAP = 18, HEADER = 20, TEMPO_STRIP = 16, MIX_LANE = 64;
const LANES_TOP = RULER + TEMPO_STRIP + 6;
const ORANGE = 'rgb(255,159,10)', GREEN = 'rgb(48,209,88)', PURPLE = 'rgb(191,90,242)', TEAL = 'rgb(64,200,224)', RED = 'rgb(255,69,58)', PINK = 'rgb(255,55,95)', YELLOW = 'rgb(255,214,10)';

type Part = 'body' | 'trimLeft' | 'trimRight' | 'fadeIn' | 'fadeOut';
type Hit = { kind: 'none' } | { kind: 'ruler' } | { kind: 'emptyLane' } | { kind: 'clip'; id: string; part: Part } | { kind: 'transition'; id: string };

interface Drag {
  hit: Hit; startX: number; startTime: number; original: Clip | null; originalValue: number;
  moved: boolean; originalPrev: Clip | null; slip: boolean;
}

class TimelineView {
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  scroller: HTMLDivElement;
  spacer: HTMLDivElement;
  pps = store.pixelsPerSecond;
  leadShift = 0;
  drag: Drag | null = null;
  hoverClip: string | null = null;
  dropTime: number | null = null;
  dropIndex = 0;
  dragLabel: { text: string; x: number; y: number } | null = null;
  chipRects: { id: string; x: number; y: number; w: number; h: number }[] = [];
  tempo = new TempoMap(120);
  followSuspendedUntil = 0;
  lastFit = store.fitRequest;
  lastScroll = 0;
  programmatic = false;
  width = 800;
  height = 300;
  dpr = window.devicePixelRatio || 1;
  drawQueued = false;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement, scroller: HTMLDivElement, spacer: HTMLDivElement) {
    this.canvas = canvas; this.overlay = overlay; this.scroller = scroller; this.spacer = spacer;
  }

  // MARK: Geometry
  get scrollX() { return this.scroller.scrollLeft; }
  get mixLaneSpace() { return store.showMixWaveform ? MIX_LANE + 10 : 0; }
  get laneHeight() { return Math.max(64, (this.height - LANES_TOP - LANE_GAP - 14 - this.mixLaneSpace) / 2); }
  laneTop(lane: number) { return LANES_TOP + lane * (this.laneHeight + LANE_GAP); }
  get lanesBottom() { return this.laneTop(1) + this.laneHeight; }
  get mixLaneTop() { return this.lanesBottom + 8; }
  /** Document x (scrolled content) for timeline time t. */
  x(t: number) { return INSET + (t + this.leadShift) * this.pps; }
  time(x: number) { return (x - INSET) / this.pps - this.leadShift; }
  clipRect(i: number) {
    const c = store.clips[i];
    const top = this.laneTop(i % 2);
    return { x: this.x(c.start), y: top + 3, w: Math.max(3, clipLength(c, store.masterBPM) * this.pps), h: this.laneHeight - 6 };
  }

  // MARK: Sync
  resize(w: number, h: number) {
    this.width = w; this.height = h;
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(w * this.dpr); c.height = Math.round(h * this.dpr);
      c.style.width = `${w}px`; c.style.height = `${h}px`;
    }
    this.updateDocumentSize();
    this.requestDraw();
  }

  updateDocumentSize() {
    let w = Math.max(this.width, INSET * 2 + (store.mixDuration + 90) * this.pps);
    if (this.drag) w = Math.max(w, this.spacer.clientWidth);
    this.spacer.style.width = `${w}px`;
  }

  scrollTo(x: number) {
    const max = Math.max(0, this.spacer.clientWidth - this.width);
    this.programmatic = true;
    this.scroller.scrollLeft = Math.min(Math.max(0, x), max);
    this.programmatic = false;
  }

  center(t: number) { this.updateDocumentSize(); this.scrollTo(this.x(t) - this.width / 2); }

  sync() {
    if (Math.abs(store.pixelsPerSecond - this.pps) > 0.0001) {
      const px = this.x(store.playhead) - this.scrollX;
      const anchor = px >= 0 && px <= this.width ? store.playhead : this.time(this.scrollX + this.width / 2);
      this.setZoom(store.pixelsPerSecond, anchor, this.x(anchor) - this.scrollX, false);
    }
    if (store.fitRequest !== this.lastFit) { this.lastFit = store.fitRequest; this.fit(); }
    if (store.scrollRequest && store.scrollRequest.id !== this.lastScroll) { this.lastScroll = store.scrollRequest.id; this.center(store.scrollRequest.time); }
    this.updateDocumentSize();
    this.requestDraw();
  }

  reportVisible() {
    const a = Math.max(0, this.time(this.scrollX)), b = Math.max(a + 0.1, this.time(this.scrollX + this.width));
    store.visibleRange = [a, b];
  }

  setZoom(v: number, anchorTime: number, anchorViewX: number, report: boolean) {
    this.pps = Math.min(400, Math.max(1, v));
    if (report) { store.pixelsPerSecond = this.pps; store.changed(); }
    this.updateDocumentSize();
    this.scrollTo(this.x(anchorTime) - anchorViewX);
    this.requestDraw();
  }

  zoomAt(factor: number, viewX: number) { this.setZoom(this.pps * factor, this.time(this.scrollX + viewX), viewX, true); }

  fit() {
    const available = this.width - INSET * 2 - 24;
    const v = Math.min(400, Math.max(1, available / Math.max(store.mixDuration, 30)));
    this.pps = v;
    store.pixelsPerSecond = v;
    this.updateDocumentSize();
    this.scrollTo(0);
    this.requestDraw();
  }

  followPlayhead() {
    if (!store.isPlaying || !store.followPlayhead || this.drag || Date.now() < this.followSuspendedUntil) return;
    const px = this.x(store.playhead);
    if (px > this.scrollX + this.width * 0.85 || px < this.scrollX) this.scrollTo(px - this.width * 0.15);
  }

  requestDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.draw(); this.drawOverlay(); });
  }

  // MARK: Drawing
  draw() {
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, -this.scrollX * this.dpr, 0);
    const area = { x: this.scrollX, w: this.width };
    ctx.fillStyle = Theme.timelineBG;
    ctx.fillRect(area.x, 0, area.w, this.height);
    this.tempo = store.tempoMap;
    this.drawLanes(ctx, area);
    this.drawGrid(ctx, area);
    this.chipRects = [];
    const master = store.masterBPM;
    store.clips.forEach((_, i) => {
      const r = this.clipRect(i);
      if (r.x + r.w >= area.x && r.x <= area.x + area.w) this.drawClip(ctx, i, r, master, area);
    });
    this.drawTransitions(ctx, area);
    if (store.showMixWaveform) this.drawMixLane(ctx, area);
    if (!store.clips.length) this.drawEmptyState(ctx);
    this.drawRuler(ctx, area);
    this.drawTempoStrip(ctx, area);
  }

  drawOverlay() {
    const ctx = this.overlay.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, -this.scrollX * this.dpr, 0);
    ctx.clearRect(this.scrollX, 0, this.width, this.height);
    this.drawDropAndLabels(ctx);
    const px = this.x(store.playhead);
    if (px < this.scrollX - 10 || px > this.scrollX + this.width + 10) return;
    ctx.fillStyle = Theme.playhead;
    ctx.fillRect(px - 0.75, RULER - 6, 1.5, this.height);
    ctx.beginPath();
    ctx.moveTo(px - 6, RULER - 12); ctx.lineTo(px + 6, RULER - 12); ctx.lineTo(px + 6, RULER - 5); ctx.lineTo(px, RULER); ctx.lineTo(px - 6, RULER - 5);
    ctx.closePath(); ctx.fill();
  }

  private text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, font: string, color: string) {
    ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.fillText(s, x, y);
  }

  drawLanes(ctx: CanvasRenderingContext2D, area: { x: number; w: number }) {
    for (let lane = 0; lane < 2; lane++) {
      const top = this.laneTop(lane);
      ctx.fillStyle = Theme.laneBG;
      ctx.fillRect(area.x, top, area.w, this.laneHeight);
      this.text(ctx, lane === 0 ? 'A' : 'B', this.scrollX + 6, top + this.laneHeight - 16, '600 10px system-ui', 'rgba(255,255,255,0.18)');
    }
  }

  drawGrid(ctx: CanvasRenderingContext2D, area: { x: number; w: number }) {
    const g = store.grid;
    const beatPx = g.beat * this.pps, barPx = g.bar * this.pps;
    const phrase = g.bar * 4;
    const t0 = this.time(area.x) - phrase, t1 = this.time(area.x + area.w);
    const top = LANES_TOP, bottom = this.lanesBottom;
    for (let k = Math.floor((t0 - g.offset) / phrase); ; k++) {
      const ts = g.offset + k * phrase;
      if (ts > t1) break;
      if (Math.abs(k) % 2 === 1) { ctx.fillStyle = 'rgba(255,255,255,0.018)'; ctx.fillRect(this.x(ts), top, phrase * this.pps, bottom - top); }
    }
    const stepBeats = beatPx >= 7 ? 1 : barPx >= 7 ? 4 : 16;
    const step = g.beat * stepBeats;
    for (let n = Math.floor((t0 - g.offset) / step); ; n++) {
      const t = g.offset + n * step;
      if (t > t1) break;
      const bi = Math.round(n * stepBeats);
      ctx.fillStyle = `rgba(255,255,255,${bi % 16 === 0 ? 0.15 : bi % 4 === 0 ? 0.085 : 0.035})`;
      ctx.fillRect(this.x(t), top, 1, bottom - top);
    }
  }

  drawRuler(ctx: CanvasRenderingContext2D, area: { x: number; w: number }) {
    ctx.fillStyle = Theme.rulerBG;
    ctx.fillRect(area.x, 0, area.w, RULER);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(area.x, RULER - 1, area.w, 1);
    const g = store.grid;
    const barPx = g.bar * this.pps;
    let labelBars = 1;
    for (const c of [1, 2, 4, 8, 16, 32, 64, 128]) { labelBars = c; if (c * barPx >= 58) break; }
    const tickBars = barPx >= 6 ? 1 : labelBars;
    const t0 = this.time(area.x - 80), t1 = this.time(area.x + area.w);
    let n = Math.floor((t0 - g.offset) / g.bar);
    n -= ((n % tickBars) + tickBars) % tickBars;
    for (; ; n += tickBars) {
      const t = g.offset + n * g.bar;
      if (t > t1) break;
      const px = this.x(t);
      const isLabel = ((n % labelBars) + labelBars) % labelBars === 0;
      const h = isLabel ? 11 : 5;
      ctx.fillStyle = `rgba(255,255,255,${isLabel ? 0.42 : 0.18})`;
      ctx.fillRect(px, RULER - h, 1, h);
      if (isLabel && t >= -0.001) {
        this.text(ctx, `${n + 1}`, px + 4, 4, '600 11px system-ui', 'rgba(255,255,255,0.82)');
        this.text(ctx, Fmt.duration(this.tempo.real(t)), px + 4, 19, '9px ui-monospace, monospace', 'rgba(255,255,255,0.38)');
      }
    }
  }

  drawTempoStrip(ctx: CanvasRenderingContext2D, area: { x: number; w: number }) {
    const top = RULER, h = TEMPO_STRIP;
    ctx.fillStyle = 'rgb(20,20,24)';
    ctx.fillRect(area.x, top, area.w, h);
    const pts = this.tempo.points;
    const lo = Math.min(...pts.map(p => p.bpm)) - 2, hi = Math.max(...pts.map(p => p.bpm)) + 2;
    const y = (b: number) => (hi - lo < 4.01 ? top + h / 2 : top + h - 3 - (b - lo) / (hi - lo) * (h - 6));
    const t0 = this.time(area.x - 2), t1 = this.time(area.x + area.w + 2);
    const changes = this.tempo.hasChanges;
    ctx.beginPath();
    ctx.moveTo(this.x(t0), y(this.tempo.bpm(t0)));
    for (const p of pts) if (p.t > t0 && p.t < t1) ctx.lineTo(this.x(p.t), y(p.bpm));
    ctx.lineTo(this.x(t1), y(this.tempo.bpm(t1)));
    ctx.strokeStyle = changes ? TEAL : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (changes) {
      let prev = pts[0].bpm;
      for (const p of pts.slice(1)) {
        if (Math.abs(p.bpm - prev) > 0.004) {
          const px = this.x(p.t);
          if (px > area.x - 80 && px < area.x + area.w + 4) this.text(ctx, Fmt.bpm(p.bpm), px + 3, top + 3, '600 9px ui-monospace, monospace', TEAL);
        }
        prev = p.bpm;
      }
    }
    this.text(ctx, `TEMPO ${Fmt.bpm(this.tempo.bpm(Math.max(0, this.time(this.scrollX))))}`, this.scrollX + 6, top + 3, '700 8.5px system-ui', 'rgba(255,255,255,0.35)');
  }

  roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  }

  drawClip(ctx: CanvasRenderingContext2D, i: number, r: { x: number; y: number; w: number; h: number }, master: number, area: { x: number; w: number }) {
    const clip = store.clips[i];
    const selected = clip.id === store.selectedClipID, hovered = clip.id === this.hoverClip;
    const missing = store.missingFiles.has(clip.url);
    this.roundRect(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.fillStyle = clipColor(clip.colorIndex, selected ? 0.24 : 0.15);
    ctx.fill();
    const wave = { x: r.x, y: r.y + HEADER + 2, w: r.w, h: Math.max(10, r.h - HEADER - 4) };
    ctx.save();
    this.roundRect(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.clip();
    ctx.fillStyle = clipColor(clip.colorIndex, selected ? 0.55 : 0.36);
    ctx.fillRect(r.x, r.y, r.w, HEADER);
    if (missing) { ctx.fillStyle = 'rgba(255,69,58,0.18)'; ctx.fillRect(wave.x, wave.y, wave.w, wave.h); }
    else {
      this.drawWaveform(ctx, clip, wave, master, area);
      this.drawSections(ctx, clip, wave, master);
      this.drawEdits(ctx, clip, wave, master);
      this.drawOutro(ctx, i, clip, wave, master);
      this.drawFX(ctx, clip, wave, master);
    }
    this.drawEnvelope(ctx, i, wave, master, area);
    ctx.restore();
    this.roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 6);
    ctx.strokeStyle = selected ? 'rgba(255,255,255,0.92)' : clipColor(clip.colorIndex, hovered ? 0.95 : 0.55);
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();

    // Header text sticks to the left edge of the view while scrolling.
    const textX = Math.max(r.x + 8, this.scrollX + 8);
    const textWidth = r.x + r.w - textX - 8;
    if (textWidth > 24) {
      ctx.save();
      ctx.beginPath(); ctx.rect(textX, r.y, textWidth, HEADER); ctx.clip();
      ctx.font = '600 11.5px system-ui'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
      ctx.fillText(clip.title, textX, r.y + 4);
      const tw = ctx.measureText(clip.title).width;
      let info = `   ${Fmt.bpm(clip.bpm)} BPM`;
      const rr = rate(clip, this.tempo.bpm(clip.start));
      if (clip.tempoSync && Math.abs(rr - 1) > 0.0005) info += ` → ${Fmt.ratePercent(rr)}`;
      if (!clip.tempoSync) info += L('（同期オフ）', ' (sync off)');
      if (missing) info += L('   ⚠︎ ファイルが見つかりません', '   ⚠︎ File not found');
      ctx.font = '500 10px ui-monospace, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.66)';
      ctx.fillText(info, textX + tw, r.y + 5);
      ctx.restore();
    }
    // Beat-alignment warning
    if (clip.tempoSync && clip.bpm > 0) {
      const g = store.grid;
      const d = Mathx.posMod(downbeatPhase(clip, master) - g.offset, g.beat);
      const dev = Math.min(d, g.beat - d);
      if (dev > 0.008 && r.w > 90) {
        const s = L(`拍ズレ ${Math.round(dev * 1000)}ms`, `Off-beat ${Math.round(dev * 1000)} ms`);
        ctx.font = '600 9.5px system-ui';
        const wx = Math.min(r.x + r.w, this.scrollX + this.width) - ctx.measureText(s).width - 8;
        if (wx > textX + 60) this.text(ctx, s, wx, r.y + 5, '600 9.5px system-ui', ORANGE);
      }
    }
    this.drawMixMarkers(ctx, i, clip, r, wave, master);
    if (selected || hovered) this.drawHandles(ctx, i, clip, r, master);
  }

  drawWaveform(ctx: CanvasRenderingContext2D, clip: Clip, rect: { x: number; y: number; w: number; h: number }, master: number, area: { x: number; w: number }) {
    const wf = store.waveforms.get(clip.url);
    if (!wf || !wf.peaks.length) {
      this.text(ctx, L('波形を読み込み中…', 'Loading waveform…'), Math.max(rect.x, this.scrollX) + 10, rect.y + rect.h / 2 - 7, '500 11px system-ui', 'rgba(255,255,255,0.4)');
      return;
    }
    const x0 = Math.max(rect.x, area.x), x1 = Math.min(rect.x + rect.w, area.x + area.w);
    if (x1 <= x0) return;
    const toSource = sourceMapper(clip, master);
    const mid = rect.y + rect.h / 2, half = rect.h / 2 * 0.94;
    const norm = 1 / wf.maxPeak;
    const gain = Math.min(1.4, Math.pow(10, (clip.gainDB + (clip.loudnessGainDB ?? 0)) / 20));
    const n = wf.peaks.length, bps = wf.binsPerSecond;
    const tops: number[] = [], lowTops: number[] = [], xs: number[] = [];
    for (let px = Math.floor(x0); px <= x1; px++) {
      const ta = this.time(px), tb = this.time(px + 1);
      const sa = toSource(ta);
      let sb = toSource(tb);
      if (sb < sa) sb = sa + (tb - ta);
      const b0 = Math.min(Math.max(0, Math.trunc(sa * bps)), n - 1);
      const b1 = Math.min(n, Math.max(b0 + 1, Math.trunc(sb * bps)));
      let p = 0, l = 0;
      for (let b = b0; b < b1; b++) { if (wf.peaks[b] > p) p = wf.peaks[b]; if (wf.lows[b] > l) l = wf.lows[b]; }
      xs.push(px);
      tops.push(mid - Math.min(1, p * norm * gain) * half);
      lowTops.push(mid - Math.min(1, l * norm * gain) * half);
    }
    const fill = (pts: number[], color: string) => {
      ctx.beginPath();
      ctx.moveTo(xs[0], pts[0]);
      for (let k = 1; k < xs.length; k++) ctx.lineTo(xs[k], pts[k]);
      for (let k = xs.length - 1; k >= 0; k--) ctx.lineTo(xs[k], mid + (mid - pts[k]));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    fill(tops, clipColor(clip.colorIndex, 0.42));
    fill(lowTops, clipColor(clip.colorIndex, 0.95));
  }

  drawSections(ctx: CanvasRenderingContext2D, clip: Clip, wave: { x: number; y: number; w: number; h: number }, master: number) {
    const st = store.structures.get(clip.url);
    if (!st) return;
    for (const sec of st.sections) {
      const t0 = timelineTimeOfSource(clip, Structure.timeOfBar(st, sec.start), master);
      const t1 = timelineTimeOfSource(clip, Structure.timeOfBar(st, sec.end), master);
      const x0 = Math.max(wave.x, this.x(t0)), x1 = Math.min(wave.x + wave.w, this.x(t1));
      if (x1 - x0 <= 1) continue;
      ctx.fillStyle = { intro: 'rgba(255,255,255,0.28)', drop: 'rgba(255,159,10,0.95)', breakdown: 'rgba(64,200,224,0.85)', outro: 'rgba(255,255,255,0.16)' }[sec.kind];
      ctx.fillRect(x0, wave.y - 2, x1 - x0 - 1, 4);
    }
  }

  drawEdits(ctx: CanvasRenderingContext2D, clip: Clip, wave: { x: number; y: number; w: number; h: number }, master: number) {
    if (!hasEdits(clip)) return;
    const segs = playSegments(clip);
    const r = rate(clip, master);
    for (const edit of clip.edits ?? []) {
      const a = sourceTimeAtBar(clip, edit.bar), b = sourceTimeAtBar(clip, edit.bar + edit.bars);
      if (edit.kind === 'loop') {
        const passes = segs.filter(s => s.from < b - 1e-6 && s.to > a + 1e-6);
        if (passes.length <= 1) continue;
        passes.forEach((seg, n) => {
          const s0 = Math.max(seg.from, a), s1 = Math.min(seg.to, b);
          const x0 = this.x(clip.start + (seg.elapsed + s0 - seg.from) / r), x1 = this.x(clip.start + (seg.elapsed + s1 - seg.from) / r);
          if (x1 - x0 <= 1) return;
          ctx.fillStyle = `rgba(255,214,10,${n === 0 ? 0.08 : 0.16})`;
          ctx.fillRect(x0, wave.y, x1 - x0, wave.h);
          ctx.fillStyle = 'rgba(255,214,10,0.9)';
          ctx.fillRect(x0, wave.y, 1.5, wave.h);
          this.pill(ctx, `⟲ ${n + 1}/${passes.length}`, x0 + 3, wave.y + 3, YELLOW, 'rgba(0,0,0,0.85)', x1 - x0);
        });
      } else {
        const seg = segs.find(s => Math.abs(s.to - a) < 1e-4);
        if (!seg) continue;
        const px = this.x(clip.start + (seg.elapsed + seg.to - seg.from) / r);
        ctx.strokeStyle = PINK; ctx.lineWidth = 1.5;
        ctx.beginPath();
        let yy = wave.y;
        ctx.moveTo(px, yy);
        while (yy < wave.y + wave.h) { yy += 6; ctx.lineTo(px + ((Math.trunc(yy) / 6) % 2 === 0 ? -3 : 3), Math.min(yy, wave.y + wave.h)); }
        ctx.stroke();
        this.pill(ctx, `⇥ ${Edit.lengthLabel(edit)}`, px + 4, wave.y + 3, PINK, 'rgba(0,0,0,0.85)');
      }
    }
  }

  pill(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, bg: string, fg: string, maxW = Infinity) {
    ctx.font = '600 9px ui-monospace, monospace';
    const w = ctx.measureText(s).width + 6;
    if (w + 2 > maxW) return;
    this.roundRect(ctx, x, y, w, 12, 3);
    ctx.fillStyle = bg; ctx.fill();
    this.text(ctx, s, x + 3, y + 1.5, '600 9px ui-monospace, monospace', fg);
  }

  drawOutro(ctx: CanvasRenderingContext2D, i: number, clip: Clip, wave: { x: number; y: number; w: number; h: number }, master: number) {
    const o = i + 1 < store.clips.length ? outro(clip, store.clips[i + 1]) : null;
    if (!o) return;
    const r = rate(clip, master);
    const x0 = this.x(clip.start + o.elapsedStart / r), x1 = this.x(clip.start + (o.elapsedStart + o.length) / r);
    if (x1 - x0 <= 1) return;
    ctx.fillStyle = 'rgba(255,69,58,0.22)';
    ctx.fillRect(x0, wave.y, x1 - x0, wave.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, wave.y, x1 - x0, wave.h); ctx.clip();
    ctx.strokeStyle = 'rgba(255,69,58,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let hx = x0 - wave.h; hx < x1; hx += 7) { ctx.moveTo(hx, wave.y + wave.h); ctx.lineTo(hx + wave.h, wave.y); }
    ctx.stroke();
    ctx.restore();
    const label = o.kind === 'brake' ? '⏷ BRAKE' : '⟲ SPIN';
    ctx.font = '700 9px system-ui';
    const w = ctx.measureText(label).width;
    this.roundRect(ctx, Math.max(x0 + 2, x1 - w - 8), wave.y + 3, w + 6, 13, 3);
    ctx.fillStyle = RED; ctx.fill();
    this.text(ctx, label, Math.max(x0 + 2, x1 - w - 8) + 3, wave.y + 5, '700 9px system-ui', '#fff');
  }

  drawFX(ctx: CanvasRenderingContext2D, clip: Clip, wave: { x: number; y: number; w: number; h: number }, master: number) {
    const list = clip.fx ?? [];
    if (!list.length) return;
    const h = Math.min(16, wave.h * 0.3);
    list.forEach((fx, n) => {
      const x0 = this.x(timelineTimeOfBar(clip, fx.bar, master)), x1 = this.x(timelineTimeOfBar(clip, fx.bar + fx.bars, master));
      if (x1 - x0 <= 1) return;
      const row = n % 2;
      const by = wave.y + wave.h - h - row * (h + 1);
      const hue = FX.hue(fx.kind);
      this.roundRect(ctx, x0, by, x1 - x0, h, 2);
      ctx.fillStyle = hsb(hue, 0.65, 0.95, 0.22); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x0, by + h);
      const steps = Math.max(2, Math.min(60, Math.trunc((x1 - x0) / 4)));
      for (let k = 0; k <= steps; k++) {
        const b = fx.bar + fx.bars * k / steps * 0.9999;
        const lv = fx.amount > 0 ? FX.level(fx, b) / Math.max(fx.amount, 0.001) : 0;
        ctx.lineTo(x0 + (x1 - x0) * k / steps, by + h - lv * (h - 2));
      }
      ctx.lineTo(x1, by + h);
      ctx.closePath();
      ctx.fillStyle = hsb(hue, 0.65, 0.95, 0.55); ctx.fill();
      ctx.font = '700 8.5px system-ui';
      const label = FX.short(fx.kind);
      if (x1 - x0 > ctx.measureText(label).width + 6) this.text(ctx, label, x0 + 3, by + (h - 9) / 2, '700 8.5px system-ui', '#fff');
    });
  }

  drawMixMarkers(ctx: CanvasRenderingContext2D, i: number, clip: Clip, r: { x: number; y: number; w: number; h: number }, wave: { x: number; y: number; w: number; h: number }, master: number) {
    if (!(clip.bpm > 0)) return;
    const barPx = barSource(clip) / rate(clip, master) * this.pps;
    let step = 1;
    for (const c of [1, 2, 4, 8, 16, 32, 64]) { step = c; if (c * barPx >= 34) break; }
    const firstBar = barAtSource(clip, clip.trimStart), lb = barAtSource(clip, clip.trimEnd);
    let lastPx = -Infinity;
    for (let b = Math.ceil((firstBar - clip.mixInBar) / step) * step + clip.mixInBar; b <= lb; b += step) {
      const px = this.x(timelineTimeOfBar(clip, b, master));
      if (px - lastPx < 12) continue;
      lastPx = px;
      if (px >= this.scrollX - 30 && px <= this.scrollX + this.width && px >= r.x && px <= r.x + r.w - 16) {
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(px, wave.y + wave.h - 12, 1, 10);
        this.text(ctx, barLabel(b), px + 3, wave.y + wave.h - 12, '600 9px ui-monospace, monospace', 'rgba(255,255,255,0.5)');
      }
    }
    for (const cue of cueList(clip)) {
      const cx = this.x(timelineTimeOfBar(clip, cue.bar, master));
      if (cx < r.x || cx > r.x + r.w) continue;
      ctx.fillStyle = 'rgba(64,200,224,0.85)';
      ctx.fillRect(cx - 0.5, wave.y + 16, 1, wave.h - 30);
      ctx.beginPath(); ctx.moveTo(cx - 4, wave.y + 16); ctx.lineTo(cx + 4, wave.y + 16); ctx.lineTo(cx, wave.y + 22); ctx.closePath(); ctx.fill();
      this.text(ctx, cue.label, cx + 4, wave.y + 22, '600 9px system-ui', TEAL);
    }
    const inX = this.x(timelineTimeOfBar(clip, clip.mixInBar, master));
    if (inX >= r.x - 1 && inX <= r.x + r.w) this.flag(ctx, `IN ${barLabel(clip.mixInBar)}`, inX, wave.y + 1, GREEN, false);
    if (i > 0 && clip.transitionBars > 0.01) {
      const lx = this.x(timelineTimeOfBar(clip, landingBar(clip), master));
      if (lx >= r.x && lx <= r.x + r.w) {
        ctx.fillStyle = 'rgba(191,90,242,0.85)';
        ctx.fillRect(lx - 0.5, wave.y, 1.5, wave.h);
        this.flag(ctx, L('切替 ', 'SW ') + barLabel(landingBar(clip)), lx, wave.y + 1, PURPLE, false);
      }
    }
    if (i + 1 < store.clips.length) {
      const ox = this.x(timelineTimeOfBar(clip, clip.mixOutBar, master));
      if (ox >= r.x && ox <= r.x + r.w) {
        ctx.fillStyle = 'rgba(255,159,10,0.9)';
        ctx.fillRect(ox - 0.5, wave.y, 1.5, wave.h);
        this.flag(ctx, `OUT ${barLabel(clip.mixOutBar)}`, ox, wave.y + 1, ORANGE, true);
      }
    }
  }

  flag(ctx: CanvasRenderingContext2D, s: string, px: number, y: number, color: string, alignRight: boolean) {
    ctx.font = '600 9px ui-monospace, monospace';
    const w = ctx.measureText(s).width + 8;
    const x = alignRight ? px - w : px;
    this.roundRect(ctx, x, y, w, 13, 3);
    ctx.fillStyle = color; ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
    this.text(ctx, s, x + 4, y + 2, '600 9px ui-monospace, monospace', 'rgba(0,0,0,0.85)');
  }

  handlePoints(clip: Clip, r: { x: number; y: number; w: number; h: number }, master: number) {
    const beat = 60 / master;
    const y = r.y + HEADER + 26;
    const fi = Math.min(r.x + r.w - 6, Math.max(r.x + 6, this.x(clip.start + clip.fadeInBeats * beat)));
    const fo = Math.max(r.x + 6, Math.min(r.x + r.w - 6, this.x(clipEnd(clip, master) - clip.fadeOutBeats * beat)));
    return { fadeIn: { x: fi, y }, fadeOut: { x: fo, y } };
  }

  drawHandles(ctx: CanvasRenderingContext2D, i: number, clip: Clip, r: { x: number; y: number; w: number; h: number }, master: number) {
    const h = this.handlePoints(clip, r, master);
    const pts = [];
    if (i === 0) pts.push(h.fadeIn);
    if (i === store.clips.length - 1) pts.push(h.fadeOut);
    for (const p of pts) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = clipColor(clip.colorIndex); ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const gh = Math.min(24, r.h * 0.3);
    this.roundRect(ctx, r.x + 2, r.y + r.h / 2 - gh / 2, 3, gh, 1.5); ctx.fill();
    this.roundRect(ctx, r.x + r.w - 5, r.y + r.h / 2 - gh / 2, 3, gh, 1.5); ctx.fill();
  }

  drawEnvelope(ctx: CanvasRenderingContext2D, i: number, rect: { x: number; y: number; w: number; h: number }, master: number, area: { x: number; w: number }) {
    const x0 = Math.max(rect.x, area.x), x1 = Math.min(rect.x + rect.w, area.x + area.w);
    if (x1 <= x0) return;
    const ends = store.clips.map(c => clipEnd(c, master));
    const pts: [number, number][] = [];
    const kills: [number, number][] = [];
    let killStart: number | null = null, attenuated = false;
    for (let px = x0; ; px += 3) {
      const cx = Math.min(px, x1);
      const s = Automation.state(store.clips, i, this.time(cx), master, ends);
      const v = Math.min(1, Math.max(0, s.envelope));
      if (v < 0.995) attenuated = true;
      pts.push([cx, rect.y + (1 - v) * rect.h]);
      if (s.lowKilled) { if (killStart == null) killStart = cx; } else if (killStart != null) { kills.push([killStart, cx]); killStart = null; }
      if (cx >= x1) break;
    }
    if (killStart != null) kills.push([killStart, x1]);
    if (attenuated) {
      ctx.beginPath();
      ctx.moveTo(x0, rect.y);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(x1, rect.y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,159,10,0.9)';
    for (const [a, b] of kills) ctx.fillRect(a, rect.y + rect.h - 3, b - a, 3);
  }

  drawTransitions(ctx: CanvasRenderingContext2D, area: { x: number; w: number }) {
    const master = store.masterBPM, barLen = 240 / master;
    const midY = this.laneTop(0) + this.laneHeight + LANE_GAP / 2;
    store.clips.forEach((cur, i) => {
      if (i === 0) return;
      const prev = store.clips[i - 1];
      const start = cur.start, end = Math.min(clipEnd(prev, master), clipEnd(cur, master));
      if (end - start <= 0.005) return;
      const xa = this.x(start), xb = this.x(end);
      if (xb < area.x - 200 || xa > area.x + area.w + 200) return;
      const selected = cur.id === store.selectedClipID;
      ctx.fillStyle = selected ? Theme.accent : 'rgba(255,255,255,0.35)';
      ctx.fillRect(xa, midY - 0.5, xb - xa, 1);
      ctx.fillRect(xa, midY - 4, 1, 8);
      ctx.fillRect(xb - 1, midY - 4, 1, 8);
      const glyph = cur.transition === 'brake' ? '⏷' : cur.transition === 'backspin' ? '⟲' : '✂︎';
      let label = cur.transitionBars < 0.01 ? `${glyph} ${Style.title(cur.transition)}` : `${Fmt.bars((end - start) / barLen)} · ${Style.title(cur.transition)}`;
      if (cur.tempo != null) {
        const before = store.tempoBefore(i);
        if (Math.abs(cur.tempo - before) > 0.004) label += `  ♩${Fmt.bpm(before)}→${Fmt.bpm(cur.tempo)}`;
      }
      if (store.isLocked(i)) label = '🔒 ' + label;
      ctx.font = '600 10px system-ui';
      const w = ctx.measureText(label).width + 18;
      const chip = { x: (xa + xb) / 2 - w / 2, y: midY - 9, w, h: 18 };
      this.roundRect(ctx, chip.x, chip.y, chip.w, chip.h, 9);
      ctx.fillStyle = Theme.chipBG; ctx.fill();
      ctx.strokeStyle = selected ? Theme.accent : 'rgba(255,255,255,0.25)'; ctx.lineWidth = selected ? 1.5 : 1; ctx.stroke();
      this.text(ctx, label, chip.x + 9, chip.y + 4, '600 10px system-ui', 'rgba(255,255,255,0.92)');
      this.chipRects.push({ id: cur.id, ...chip });
    });
  }

  drawMixLane(ctx: CanvasRenderingContext2D, area: { x: number; w: number }) {
    const top = this.mixLaneTop, h = MIX_LANE, mid = top + h / 2;
    ctx.fillStyle = Theme.laneBG;
    ctx.fillRect(area.x, top, area.w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(area.x, mid, area.w, 0.5);
    const done = store.mixPeaks, partial = store.mixPeaksPartial, rendering = store.mixWaveformIsRendering, stale = store.mixStaleRange;
    const half = h / 2 - 3;
    const x0 = Math.max(area.x, this.x(0)), x1 = area.x + area.w;
    for (let px = Math.floor(x0); px < x1; px++) {
      const ra = this.tempo.real(this.time(px)), rb = this.tempo.real(this.time(px + 1));
      // A partial update leaves everything outside the stretch being rendered as it is.
      let src = done, fresh = !rendering || (!!stale && !(ra >= stale[0] && ra <= stale[1]) && !(rb >= stale[0] && rb <= stale[1])), isFinal = true;
      if (partial && rb <= partial.rendered) { src = partial; fresh = true; isFinal = false; }
      if (!src) continue;
      const gain = store.exportNormalize && isFinal ? normalizeGain(src.peak) : 1;
      const b0 = Math.max(0, Math.trunc(ra * src.binsPerSecond)), b1 = Math.min(src.mins.length, Math.max(b0 + 1, Math.trunc(rb * src.binsPerSecond)));
      if (b0 >= b1) continue;
      let lo = 0, hi = 0, loud = 0;
      for (let b = b0; b < b1; b++) { lo = Math.min(lo, src.mins[b]); hi = Math.max(hi, src.maxs[b]); loud = Math.max(loud, src.rms[b] ?? 0); }
      lo *= gain; hi *= gain; loud *= gain;
      const clipped = hi > 1 || lo < -1;
      lo = Math.max(-1, lo); hi = Math.min(1, hi);
      const a = fresh ? 1 : 0.35;
      ctx.fillStyle = `rgba(115,217,242,${0.4 * a})`;
      const yt = mid - hi * half, yb = mid - lo * half;
      ctx.fillRect(px, yt, 1, Math.max(1, yb - yt));
      const core = Math.min(1, loud * 1.41) * half;
      ctx.fillStyle = `rgba(115,217,242,${0.95 * a})`;
      ctx.fillRect(px, mid - core, 1, Math.max(1, 2 * core));
      if (clipped) {
        ctx.fillStyle = `rgba(255,69,58,${0.95 * a})`;
        ctx.fillRect(px, mid - half - 3, 1, 3);
        ctx.fillRect(px, mid + half, 1, 3);
      }
    }
    let text = L('MIX（書き出しと同じ波形）', 'MIX (exactly what Export writes)') + ' · 44.1 kHz';
    text += store.exportNormalize ? L(' · 正規化あり', ' · normalized') : L(' · 正規化なし', ' · not normalized');
    if (rendering && stale) text += L('  — 更新中…', '  — updating…');
    else if (rendering) {
      const pct = partial ? Math.round(100 * partial.rendered / Math.max(1, this.tempo.real(store.mixDuration))) : 0;
      text += L(`  — 更新中 ${Math.min(99, pct)}%`, `  — updating ${Math.min(99, pct)}%`);
    } else if (!done) text += L('  — 準備中…', '  — preparing…');
    this.text(ctx, text, this.scrollX + 6, top + 3, '600 10px system-ui', `rgba(255,255,255,${rendering ? 0.55 : 0.4})`);
  }

  drawEmptyState(ctx: CanvasRenderingContext2D) {
    const a = { x: this.scrollX + 24, y: LANES_TOP + 4, w: this.width - 48, h: this.lanesBottom - LANES_TOP - 8 };
    const highlight = this.dropTime != null;
    this.roundRect(ctx, a.x, a.y, a.w, a.h, 14);
    ctx.setLineDash([7, 6]); ctx.lineWidth = 2;
    ctx.strokeStyle = highlight ? Theme.accent : 'rgba(255,255,255,0.14)'; ctx.stroke(); ctx.setLineDash([]);
    if (highlight) { ctx.fillStyle = 'rgba(61,139,253,0.08)'; ctx.fill(); }
    const analyzing = store.pending.length > 0;
    const title = analyzing ? L('解析中…（BPMと波形を検出しています）', 'Analyzing… (detecting BPM and waveform)') : L('音声ファイルをここにドロップ', 'Drop audio files here');
    const sub = analyzing ? L('解析が終わると曲全体がそのまま並びます。IN / OUT とつなぎ方はあとから設定します', 'When done, whole tracks are lined up. Set IN / OUT and transitions afterwards')
      : L('MP3・WAV・AIFF・M4A・FLAC ／ フォルダごとでもOK ／ ツールバーの ＋ からも追加できます', 'MP3 · WAV · AIFF · M4A · FLAC — folders work too — or use ＋ in the toolbar');
    ctx.textAlign = 'center';
    this.text(ctx, analyzing ? '〰' : '⤓', a.x + a.w / 2, a.y + a.h / 2 - 50, '300 36px system-ui', `rgba(255,255,255,${highlight ? 0.75 : 0.38})`);
    this.text(ctx, title, a.x + a.w / 2, a.y + a.h / 2, '600 17px system-ui', 'rgba(255,255,255,0.85)');
    this.text(ctx, sub, a.x + a.w / 2, a.y + a.h / 2 + 26, '12px system-ui', 'rgba(255,255,255,0.45)');
    ctx.textAlign = 'left';
  }

  drawDropAndLabels(ctx: CanvasRenderingContext2D) {
    if (this.dropTime != null && store.clips.length) {
      const appending = this.dropIndex >= store.clips.length;
      const px = appending ? this.x(store.mixDuration) : this.x(store.clips[this.dropIndex].start);
      ctx.fillStyle = Theme.accent;
      ctx.fillRect(px - 1, LANES_TOP, 2, this.lanesBottom - LANES_TOP);
      this.bigPill(ctx, appending ? L('ミックスの末尾に追加', 'Add to the end of the mix') : L(`${this.dropIndex + 1}曲目として挿入`, `Insert as track ${this.dropIndex + 1}`), px + 6, LANES_TOP + 6, Theme.accent);
    }
    if (this.dragLabel) this.bigPill(ctx, this.dragLabel.text, this.dragLabel.x + 14, Math.max(LANES_TOP + 4, this.dragLabel.y - 30), Theme.chipBG);
  }

  bigPill(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, fill: string) {
    ctx.font = '600 11px system-ui';
    const w = ctx.measureText(s).width + 18;
    if (x + w > this.scrollX + this.width - 6) x = this.scrollX + this.width - 6 - w;
    this.roundRect(ctx, x, y, w, 22, 11);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.stroke();
    this.text(ctx, s, x + 9, y + 5, '600 11px system-ui', '#fff');
  }

  // MARK: Hit testing
  region(px: number, py: number): Hit {
    if (py < RULER) return { kind: 'ruler' };
    for (const c of this.chipRects) if (px >= c.x - 3 && px <= c.x + c.w + 3 && py >= c.y - 3 && py <= c.y + c.h + 3) return { kind: 'transition', id: c.id };
    const master = store.masterBPM;
    for (let i = store.clips.length - 1; i >= 0; i--) {
      const r = this.clipRect(i);
      if (!(px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)) continue;
      const c = store.clips[i];
      const h = this.handlePoints(c, r, master);
      if (i === 0 && Math.hypot(px - h.fadeIn.x, py - h.fadeIn.y) < 13) return { kind: 'clip', id: c.id, part: 'fadeIn' };
      if (i === store.clips.length - 1 && Math.hypot(px - h.fadeOut.x, py - h.fadeOut.y) < 13) return { kind: 'clip', id: c.id, part: 'fadeOut' };
      if (r.w > 28) {
        if (px - r.x < 7) return { kind: 'clip', id: c.id, part: 'trimLeft' };
        if (r.x + r.w - px < 7) return { kind: 'clip', id: c.id, part: 'trimRight' };
      }
      return { kind: 'clip', id: c.id, part: 'body' };
    }
    if (py >= LANES_TOP && py <= this.lanesBottom) return { kind: 'emptyLane' };
    return { kind: 'none' };
  }

  // MARK: Mouse
  mouseMove(px: number, py: number) {
    if (this.drag) return;
    const h = this.region(px, py);
    let hover: string | null = null;
    let cursor = 'default';
    if (h.kind === 'clip') {
      hover = h.id;
      cursor = h.part === 'trimLeft' || h.part === 'trimRight' ? 'ew-resize' : h.part === 'body' ? (store.index(h.id) === 0 ? 'default' : 'grab') : 'pointer';
    } else if (h.kind === 'transition') cursor = 'pointer';
    this.overlay.style.cursor = cursor;
    if (hover !== this.hoverClip) { this.hoverClip = hover; this.requestDraw(); }
  }

  mouseDown(px: number, py: number, e: MouseEvent) {
    const t = this.time(px);
    let hit = this.region(px, py);
    if (hit.kind === 'transition') {
      if (e.detail >= 2) { store.openTransitionEditor(hit.id); return; }
      store.selectedClipID = hit.id;
      store.showInspector = true;
      hit = { kind: 'clip', id: hit.id, part: 'body' };
    }
    if (hit.kind === 'ruler') {
      this.followSuspendedUntil = 0;
      store.beginScrub();
      store.scrub(t);
      this.drag = { hit, startX: px, startTime: t, original: null, originalValue: 0, moved: false, originalPrev: null, slip: false };
    } else if (hit.kind === 'emptyLane') {
      store.selectedClipID = null;
      store.seek(t);
    } else if (hit.kind === 'clip') {
      store.selectedClipID = hit.id;
      if (e.detail >= 2) { store.openCueEditor(hit.id); this.drag = null; return; }
      const i = store.index(hit.id);
      if (i == null) return;
      const clip = store.clips[i];
      let value = 0;
      switch (hit.part) {
        case 'body': value = i > 0 ? store.clips[i - 1].mixOutBar : 0; break;
        case 'trimLeft': value = clip.mixInBar; break;
        case 'trimRight': value = i + 1 < store.clips.length ? store.clips[i + 1].transitionBars : (clip.endBar ?? barAtSource(clip, clip.trimEnd)); break;
        case 'fadeIn': value = clip.fadeInBeats; break;
        case 'fadeOut': value = clip.fadeOutBeats; break;
      }
      this.drag = { hit, startX: px, startTime: t, original: clip, originalValue: value, moved: false, originalPrev: i > 0 ? store.clips[i - 1] : null, slip: e.ctrlKey || e.metaKey };
    }
    store.changed();
  }

  mouseDrag(px: number, py: number, e: MouseEvent) {
    const d = this.drag;
    if (!d) return;
    // Auto-scroll at the edges.
    const vx = px - this.scrollX;
    if (vx > this.width - 30) this.scrollTo(this.scrollX + 12); else if (vx < 30) this.scrollTo(this.scrollX - 12);
    const t = this.time(px);
    const fine = e.altKey;
    if (d.hit.kind === 'ruler') { store.scrub(t); return; }
    if (d.hit.kind !== 'clip' || !d.original) return;
    const id = d.hit.id, part = d.hit.part, orig = d.original;
    const i = store.index(id);
    if (i == null) return;
    if (!d.moved) {
      if (Math.abs(px - d.startX) < 3) return;
      d.moved = true;
      store.pushUndo();
      store.isInteracting = true;
      if (part === 'body') this.overlay.style.cursor = 'grabbing';
    }
    const master = store.masterBPM;
    const unit = fine ? 0.25 : store.snap === 'beat' ? 0.25 : store.snap === 'bar' ? 1 : store.snap === 'phrase' ? 4 : 8;
    const steps = Math.round((t - d.startTime) / store.barLength / unit) * unit;
    const isLast = i === store.clips.length - 1;
    const label = (text: string) => { this.dragLabel = { text, x: px, y: py }; };
    if (part === 'body' && d.slip) {
      store.slipContent(id, -steps, orig.mixInBar, orig.mixOutBar, orig.endBar ?? null);
      const c = store.clip(id);
      if (c) label(L(`中身をずらす · ${barLabel(c.mixInBar)}小節目から`, `Slip · from bar ${barLabel(c.mixInBar)}`));
    } else if (part === 'body') {
      if (i === 0) { label(L('最初の曲は動かせません（Ctrl+ドラッグで中身をずらす・左端で開始位置）', 'The first track stays at the start (Ctrl-drag slides its audio; drag its left edge to trim)')); }
      else {
        store.setEntryPoint(id, d.originalValue + steps, false);
        const prev = store.clips[i - 1];
        label(L(`「${prev.title}」の ${barLabel(prev.mixOutBar)}小節目から入る`, `Enter at bar ${barLabel(prev.mixOutBar)} of “${prev.title}”`));
      }
    } else if (part === 'trimLeft') {
      if (i > 0 && d.originalPrev) {
        store.dragIncomingEdge(id, steps, orig.mixInBar, d.originalPrev.mixOutBar, orig.transitionBars);
        const c = store.clip(id);
        if (c) label(c.transitionBars < 0.01 ? L(`重なりなし（${barLabel(c.mixInBar)}小節目から直結）`, `No overlap (straight in at bar ${barLabel(c.mixInBar)})`)
          : L(`重なり ${Fmt.bars(c.transitionBars)} · ${barLabel(c.mixInBar)}小節目から`, `Overlap ${Fmt.bars(c.transitionBars)} · from bar ${barLabel(c.mixInBar)}`));
      } else {
        const moved = store.dragFirstStart(id, steps, orig.mixInBar);
        this.leadShift = moved * store.barLength;
        const c = store.clip(id);
        if (c) label(L(`開始: ${barLabel(c.mixInBar)}小節目`, `Start: bar ${barLabel(c.mixInBar)}`));
      }
    } else if (part === 'trimRight') {
      if (!isLast) {
        const next = store.clips[i + 1];
        store.setTransitionLength(next.id, d.originalValue + steps, false, false);
        const n = store.clip(next.id);
        if (n) label(n.transitionBars < 0.01 ? L('直結（重ねない）', 'Direct (no overlap)') : L(`トランジション: ${Fmt.bars(n.transitionBars)}`, `Transition: ${Fmt.bars(n.transitionBars)}`));
      } else {
        const maxBar = lastBar(orig);
        const value = Math.min(maxBar, d.originalValue + steps);
        store.setEndBar(id, value >= maxBar - 0.01 ? null : value, false);
        label(L(`終了: ${barLabel(value)}小節目`, `End: bar ${barLabel(value)}`));
      }
    } else if (part === 'fadeIn' || part === 'fadeOut') {
      const beat = 60 / master;
      const other = part === 'fadeIn' ? orig.fadeOutBeats : orig.fadeInBeats;
      const maxBeats = Math.max(0, clipLength(orig, master) / beat - other);
      let beats = Math.max(0, part === 'fadeIn' ? (t - orig.start) / beat : (clipEnd(orig, master) - t) / beat);
      beats = Math.min(fine ? beats : Math.round(beats), maxBeats);
      store.updateClip(id, false, c => { if (part === 'fadeIn') c.fadeInBeats = beats; else c.fadeOutBeats = beats; });
      label(part === 'fadeIn' ? L(`フェードイン: ${Fmt.beats(beats)}`, `Fade in: ${Fmt.beats(beats)}`) : L(`フェードアウト: ${Fmt.beats(beats)}`, `Fade out: ${Fmt.beats(beats)}`));
    }
    this.requestDraw();
  }

  mouseUp(px: number) {
    const d = this.drag;
    this.dragLabel = null;
    if (!d) return;
    store.isInteracting = false;
    if (d.hit.kind === 'ruler') store.endScrub(this.time(px));
    else if (d.hit.kind === 'clip') {
      if (this.leadShift !== 0) {
        const shiftX = this.leadShift * this.pps;
        this.leadShift = 0;
        this.updateDocumentSize();
        this.scrollTo(this.scrollX - shiftX);
      }
      if (d.moved) { this.drag = null; this.updateDocumentSize(); store.finishTimingEdit(); }
    }
    this.drag = null;
    this.requestDraw();
  }

  contextMenu(px: number, py: number, e: MouseEvent) {
    const t = Math.max(0, this.time(px));
    const h = this.region(px, py);
    const items: MenuItem[] = [];
    const clip = h.kind === 'clip' ? store.clip(h.id) : null;
    if (h.kind === 'clip' && clip) {
      const id = h.id;
      store.selectedClipID = id;
      store.changed();
      const i = store.index(id);
      items.push({ label: L('CUE（IN / OUT）を編集…', 'Edit Cues (IN / OUT)…'), action: () => store.openCueEditor(id) });
      items.push({ label: L('ライブラリに戻す', 'Move Back to Library'), action: () => store.removeFromMix(id) });
      if (i != null && i > 0) items.push({ label: L('つなぎエディタで描く…', 'Draw in Transition Editor…'), action: () => store.openTransitionEditor(id) });
      items.push({ separator: true });
      items.push({ label: L('ここから再生', 'Play from Here'), action: () => { store.seek(t); if (!store.isPlaying) store.play(); } });
      items.push({ separator: true });
      items.push({ label: L(`BPMを2倍にする（${Fmt.bpm(clip.bpm * 2)}）`, `Double BPM (${Fmt.bpm(clip.bpm * 2)})`), action: () => store.scaleClipBPM(id, 2) });
      items.push({ label: L(`BPMを半分にする（${Fmt.bpm(clip.bpm / 2)}）`, `Halve BPM (${Fmt.bpm(clip.bpm / 2)})`), action: () => store.scaleClipBPM(id, 0.5) });
      items.push({ label: L('BPMを再解析', 'Re-analyze BPM'), action: () => store.reanalyze(id) });
      items.push({ separator: true });
      items.push({ label: L('入口を1小節目にする', 'Set Mix-In to Bar 1'), action: () => store.trimToFirstDownbeat(id) });
      items.push({ label: L('曲の頭から再生する', 'Play From the Very Start'), action: () => store.resetTrim(id) });
      items.push({ separator: true });
      const bar = store.sourceBar(id, t);
      if (bar != null) {
        items.push({ label: L('ここからループ', 'Loop From Here'), submenu: [0.25, 0.5, 1, 2, 4, 8, 16, 32].map(b => ({
          label: (b < 1 ? L(`${b * 4}拍`, `${b * 4} beat${b > 0.25 ? 's' : ''}`) : L(`${b}小節`, `${b} bar${b > 1 ? 's' : ''}`)) + L('（×2）', ' (×2)'),
          action: () => store.addLoop(id, bar, b, 1),
        })) });
        items.push({ label: L('ここでビートジャンプ', 'Beat Jump Here'), submenu: [1, 2, 4, 8, 16, 32].map(b => ({
          label: L(`${b}小節先へ`, `${b} bar${b > 1 ? 's' : ''} ahead`), action: () => store.addJump(id, bar, b),
        })) });
        items.push({ label: L('ここにエフェクト', 'Add Effect Here'), submenu: fxKinds.map((k: FXKind) => ({
          label: FX.title(k), action: () => { const f = store.addFX(id, k, Math.floor(bar * 4) / 4); if (f) { store.inspectorTab = 'fx'; store.focusedFX = f; store.changed(); } },
        })) });
      }
      if (clip.fx?.length) items.push({ label: L('この曲のエフェクトをすべて解除', 'Clear All Effects'), action: () => store.removeAllFX(id) });
      if (hasEdits(clip)) items.push({ label: L('この曲のループ／ジャンプをすべて解除', 'Clear All Loops / Jumps'), action: () => store.removeAllEdits(id) });
      if (i != null && i > 0) {
        items.push({ label: L('トランジションの長さ', 'Transition Length'), submenu: [0, 4, 8, 16, 32].map(b => ({
          label: b === 0 ? L('直結（重ねない）', 'Direct (no overlap)') : L(`${b}小節`, `${b} bars`), checked: Math.abs(clip.transitionBars - b) < 0.01,
          action: () => store.setTransitionLength(id, b),
        })) });
        items.push({ label: L('トランジションの種類', 'Transition Type'), submenu: transitionStyles.map(s => ({
          label: Style.title(s), checked: clip.transition === s, action: () => store.setTransitionStyle(id, s),
        })) });
      }
      items.push({ separator: true });
      items.push({ label: L('エクスプローラーで表示', 'Show in Explorer'), action: () => store.revealInFolder(id) });
      items.push({ label: L('ミックスから削除', 'Remove from Mix'), action: () => store.deleteClip(id) });
    } else {
      items.push({ label: L('再生位置をここに移動', 'Move Playhead Here'), action: () => store.seek(t) });
      items.push({ label: L('曲を追加…', 'Add Tracks…'), action: () => store.presentAddFiles() });
    }
    showContextMenu(e, items);
  }

  wheel(e: WheelEvent, vx: number) {
    this.followSuspendedUntil = Date.now() + 2500;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), vx);
      return;
    }
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // native horizontal scroll
    e.preventDefault();
    this.scrollTo(this.scrollX + e.deltaY);
  }
}

export function Timeline() {
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const v = new TimelineView(canvas.current!, overlay.current!, scroller.current!, spacer.current!);
    const w = wrap.current!, sc = scroller.current!, ov = overlay.current!;
    const SCROLLBAR = 12;
    const ro = new ResizeObserver(() => v.resize(w.clientWidth, w.clientHeight - SCROLLBAR));
    ro.observe(w);
    v.resize(w.clientWidth, w.clientHeight - SCROLLBAR);
    const unsub = store.subscribe(() => v.sync());
    const unclock = store.onClock(() => { v.followPlayhead(); v.drawOverlay(); });
    const onScroll = () => {
      if (!v.programmatic && store.isPlaying) v.followSuspendedUntil = Date.now() + 2500;
      v.reportVisible();
      v.draw();
      v.drawOverlay();
    };
    sc.addEventListener('scroll', onScroll);
    const pos = (e: MouseEvent) => { const r = w.getBoundingClientRect(); return [e.clientX - r.left + v.scrollX, e.clientY - r.top]; };
    const move = (e: MouseEvent) => { const [x, y] = pos(e); if (v.drag) v.mouseDrag(x, y, e); else v.mouseMove(x, y); };
    const up = (e: MouseEvent) => { const [x] = pos(e); v.mouseUp(x); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      w.focus();
      const [x, y] = pos(e);
      v.mouseDown(x, y, e);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };
    const hover = (e: MouseEvent) => { if (!v.drag) { const [x, y] = pos(e); v.mouseMove(x, y); } };
    const leave = () => { if (!v.drag) { v.hoverClip = null; v.requestDraw(); } };
    const ctx = (e: MouseEvent) => { e.preventDefault(); const [x, y] = pos(e); v.contextMenu(x, y, e); };
    const wheel = (e: WheelEvent) => { const r = w.getBoundingClientRect(); v.wheel(e, e.clientX - r.left); };
    ov.addEventListener('mousedown', down);
    ov.addEventListener('mousemove', hover);
    ov.addEventListener('mouseleave', leave);
    ov.addEventListener('contextmenu', ctx);
    ov.addEventListener('wheel', wheel, { passive: false });
    // Files dropped from Explorer.
    const dragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      const [x] = pos(e);
      v.dropTime = Math.max(0, v.time(x));
      v.dropIndex = store.lockSafeIndex(store.insertionIndex(v.dropTime));
      v.requestDraw();
    };
    const dragLeave = () => { v.dropTime = null; v.requestDraw(); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])].map(f => (f as File & { path: string }).path).filter(Boolean);
      const index = v.dropIndex;
      v.dropTime = null;
      v.requestDraw();
      if (files.length) store.addFiles(files, { kind: 'mix', index: index >= store.clips.length ? null : index });
    };
    w.addEventListener('dragover', dragOver);
    w.addEventListener('dragleave', dragLeave);
    w.addEventListener('drop', drop);
    return () => {
      ro.disconnect(); unsub(); unclock();
      sc.removeEventListener('scroll', onScroll);
      ov.removeEventListener('mousedown', down); ov.removeEventListener('mousemove', hover); ov.removeEventListener('mouseleave', leave);
      ov.removeEventListener('contextmenu', ctx); ov.removeEventListener('wheel', wheel);
      w.removeEventListener('dragover', dragOver); w.removeEventListener('dragleave', dragLeave); w.removeEventListener('drop', drop);
    };
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    const beat = store.beatLength;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.ctrlKey || e.metaKey) return;
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const id = store.selectedClipID;
      const i = id ? store.index(id) : null;
      if (id && i != null && i > 0) store.moveEntry(id, dir * (e.altKey ? 0.25 : e.shiftKey ? 4 : 1));
      else store.seek(store.playhead + dir * (e.shiftKey ? beat * 16 : beat * 4));
      e.preventDefault();
    } else if (e.key === 'Escape') { store.selectedClipID = null; store.changed(); }
  };

  return (
    <div className="timeline" ref={wrap} tabIndex={0} onKeyDown={onKey}>
      <canvas ref={canvas} className="timeline-canvas" />
      <canvas ref={overlay} className="timeline-canvas overlay" />
      <div className="timeline-scroll" ref={scroller}><div className="timeline-spacer" ref={spacer} /></div>
    </div>
  );
}

void MixStore; void Theme;
