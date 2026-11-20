// The FX tab's picture of a track: its waveform with what the effects do to it, and one lane per effect showing how
// strongly it works bar by bar (like the fader / EQ lanes of the transition editor).
//   Drag an effect to move it, its ends to change its length (snaps to beats; Alt: 1/16 bar) · click the waveform to
//   move the playhead there.
import React, { useEffect, useRef } from 'react';
import { L } from '../../core/i18n';
import { Clip, ClipFX, barAtTimeline, clipEnd, lastBar, sourceTimeAtBar, timelineTimeOfBar } from '../../core/models';
import { FX, FXShapes, fxStateAt } from '../../core/tempo';
import { useSize, useStore, usePlayhead } from '../hooks';
import { store } from '../store/store';
import { clipColor } from '../format';

const HEAD_W = 92;
const WAVE_H = 96;
const LANE_H = 30;
const RULER_H = 16;

const hsl = (k: ClipFX['kind'], a: number, l = 60) => `hsla(${FX.hue(k) * 360},72%,${l}%,${a})`;

export function FXWave({ clip }: { clip: Clip }) {
  const s = useStore();
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const list = clip.fx ?? [];
  const height = RULER_H + WAVE_H + 6 + Math.max(1, list.length) * (LANE_H + 3);
  const total = Math.max(1, lastBar(clip));
  const W = Math.max(1, size.width - HEAD_W);
  const xOf = (bar: number) => HEAD_W + bar / total * W;
  const barOf = (x: number) => (x - HEAD_W) / W * total;
  const laneTop = (k: number) => RULER_H + WAVE_H + 6 + k * (LANE_H + 3);
  const master = s.masterBPM;
  const inMix = s.index(clip.id) != null;
  const played: [number, number] | null = inMix ? [barAtTimeline(clip, clip.start, master), barAtTimeline(clip, clipEnd(clip, master), master)] : null;

  useEffect(() => {
    const c = canvas.current;
    if (!c || size.width < 10) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.width * dpr); c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, height);
    // Ruler.
    let step = 1;
    while (step * W / total < 34) step *= 2;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    for (let b = 0; b <= total; b += step) {
      const x = xOf(b);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, RULER_H - 5, 1, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillText(String(b), x + 2, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(x, RULER_H, 1, height - RULER_H);
    }
    // Waveform: the original as an outline, the sound with the effects' filtering on top; the effects' stretches tinted.
    const wy = RULER_H, mid = wy + WAVE_H / 2, half = WAVE_H / 2 - 3;
    ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(HEAD_W, wy, W, WAVE_H);
    ctx.font = '600 11px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(L('波形', 'Waveform'), 8, wy + 16);
    ctx.font = '10px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(L('FX をかけた音', 'with the FX'), 8, wy + 30);
    const wf = s.waveforms.get(clip.url);
    if (wf && wf.peaks.length) {
      const norm = 1 / Math.max(wf.maxPeak, 1e-6);
      const n = wf.peaks.length, bps = wf.binsPerSecond;
      const xs: number[] = [], orig: number[] = [], out: number[] = [], low: number[] = [];
      for (let px = HEAD_W; px < HEAD_W + W; px++) {
        const ba = barOf(px), bb = barOf(px + 1);
        const b0 = Math.min(Math.max(0, Math.trunc(sourceTimeAtBar(clip, ba) * bps)), n - 1);
        const b1 = Math.min(n, Math.max(b0 + 1, Math.trunc(sourceTimeAtBar(clip, bb) * bps)));
        let p = 0, l = 0;
        for (let b = b0; b < b1; b++) { if (wf.peaks[b] > p) p = wf.peaks[b]; if (wf.lows[b] > l) l = wf.lows[b]; }
        p *= norm; l *= norm;
        const fx = fxStateAt(clip, (ba + bb) / 2);
        let lo = l, hi = Math.sqrt(Math.max(0, p * p - l * l));
        if (fx.filter < 0) hi *= Math.max(0, 1 + fx.filter * 1.15);
        if (fx.filter > 0) { lo *= Math.max(0, 1 - fx.filter * 1.3); hi *= 1 - fx.filter * 0.25; }
        if (fx.gate > 0) { hi *= 1 - fx.gate * 0.35; lo *= 1 - fx.gate * 0.35; }
        xs.push(px); orig.push(Math.min(1, p)); out.push(Math.min(1, Math.sqrt(lo * lo + hi * hi))); low.push(Math.min(1, lo));
      }
      const fill = (vals: number[], style: string) => {
        ctx.beginPath();
        ctx.moveTo(xs[0], mid - vals[0] * half);
        for (let k = 1; k < xs.length; k++) ctx.lineTo(xs[k], mid - vals[k] * half);
        for (let k = xs.length - 1; k >= 0; k--) ctx.lineTo(xs[k], mid + vals[k] * half);
        ctx.closePath(); ctx.fillStyle = style; ctx.fill();
      };
      fill(orig, 'rgba(255,255,255,0.09)');
      fill(out, clipColor(clip.colorIndex, 0.55));
      fill(low, clipColor(clip.colorIndex, 1));
    } else {
      ctx.font = '11px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(L('波形を読み込み中…', 'Loading waveform…'), HEAD_W + 10, mid + 4);
    }
    for (const fx of list) {
      const xa = xOf(fx.bar), xb = xOf(fx.bar + fx.bars);
      ctx.fillStyle = hsl(fx.kind, s.focusedFX === fx.id ? 0.2 : 0.11);
      ctx.fillRect(xa, wy, xb - xa, WAVE_H);
      ctx.fillStyle = hsl(fx.kind, 0.9);
      ctx.fillRect(xa, wy, 1.5, WAVE_H); ctx.fillRect(xb - 1.5, wy, 1.5, WAVE_H);
    }
    // The part of the track that plays in the mix (outside it, darker).
    if (played) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const pa = xOf(Math.max(0, played[0])), pb = xOf(Math.min(total, played[1]));
      if (pa > HEAD_W) ctx.fillRect(HEAD_W, wy, pa - HEAD_W, height - wy);
      if (pb < HEAD_W + W) ctx.fillRect(pb, wy, HEAD_W + W - pb, height - wy);
    }
    // One lane per effect: its strength bar by bar.
    if (!list.length) {
      ctx.font = '11px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(L('エフェクトはまだありません。下の「エフェクトを追加」から置けます', 'No effects yet — add one below'), HEAD_W + 10, laneTop(0) + 19);
    }
    list.forEach((fx, k) => {
      const y = laneTop(k);
      ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fillRect(HEAD_W, y, W, LANE_H);
      ctx.font = '700 10.5px system-ui'; ctx.fillStyle = hsl(fx.kind, 1, 68);
      ctx.fillText(FX.title(fx.kind), 8, y + 13, HEAD_W - 12);
      ctx.font = '10px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(`${FXShapes.title(fx.shape)} · ${Math.round(fx.amount * 100)}%`, 8, y + 25, HEAD_W - 12);
      const xa = xOf(fx.bar), xb = xOf(fx.bar + fx.bars);
      ctx.fillStyle = hsl(fx.kind, s.focusedFX === fx.id ? 0.28 : 0.16);
      ctx.fillRect(xa, y, xb - xa, LANE_H);
      ctx.beginPath();
      const steps = Math.max(8, Math.ceil(xb - xa));
      for (let j = 0; j <= steps; j++) {
        const b = fx.bar + fx.bars * Math.min(j / steps, 0.99999);
        const v = FX.level(fx, b);
        const px = xa + (xb - xa) * j / steps, py = y + LANE_H - 2 - v * (LANE_H - 4);
        if (j) ctx.lineTo(px, py); else ctx.moveTo(px, y + LANE_H - 2);
      }
      ctx.lineTo(xb, y + LANE_H - 2);
      ctx.closePath();
      ctx.fillStyle = hsl(fx.kind, 0.55); ctx.fill();
      ctx.strokeStyle = hsl(fx.kind, 1, 72); ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
      if (s.focusedFX === fx.id) { ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeRect(xa + 0.5, y + 0.5, xb - xa - 1, LANE_H - 1); }
      // Grips at the ends.
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(xa, y + LANE_H / 2 - 6, 2, 12); ctx.fillRect(xb - 2, y + LANE_H / 2 - 6, 2, 12);
    });
  });

  // Dragging an effect: its body moves it, its ends change its length.
  const drag = useRef<{ fx: string; mode: 'move' | 'start' | 'end'; x0: number; bar: number; bars: number; moved: boolean } | null>(null);
  const local = (e: React.PointerEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const snap = (b: number, fine: boolean) => { const q = fine ? 1 / 16 : 1 / 4; return Math.round(b / q) * q; };
  const down = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    if (x < HEAD_W) return;
    const k = Math.floor((y - laneTop(0)) / (LANE_H + 3));
    if (y >= laneTop(0) && k >= 0 && k < list.length && y < laneTop(k) + LANE_H) {
      const fx = list[k];
      const xa = xOf(fx.bar), xb = xOf(fx.bar + fx.bars);
      s.focusedFX = fx.id;
      if (x >= xa - 6 && x <= xb + 6) {
        const mode = Math.abs(x - xa) <= 6 ? 'start' : Math.abs(x - xb) <= 6 ? 'end' : 'move';
        drag.current = { fx: fx.id, mode, x0: x, bar: fx.bar, bars: fx.bars, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      s.changed();
      return;
    }
    // On the waveform: move the playhead there (when that part plays in the mix).
    if (y >= RULER_H && y < RULER_H + WAVE_H && inMix) {
      const t = timelineTimeOfBar(clip, barOf(x), master);
      if (t >= clip.start && t <= clipEnd(clip, master)) { store.seek(t); store.requestScroll(t); }
    }
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const { x } = local(e);
    const el = e.currentTarget as HTMLElement;
    if (!d) {
      // Cursor: resize at the ends, move on the body.
      const { y } = local(e);
      const k = Math.floor((y - laneTop(0)) / (LANE_H + 3));
      const fx = y >= laneTop(0) && k >= 0 && k < list.length ? list[k] : null;
      const xa = fx ? xOf(fx.bar) : 0, xb = fx ? xOf(fx.bar + fx.bars) : 0;
      el.style.cursor = !fx ? 'default' : Math.abs(x - xa) <= 6 || Math.abs(x - xb) <= 6 ? 'ew-resize' : x > xa && x < xb ? 'grab' : 'default';
      return;
    }
    const db = (x - d.x0) / W * total;
    if (!d.moved && Math.abs(x - d.x0) < 3) return;
    if (!d.moved) { s.pushUndo(); d.moved = true; }
    const fine = e.altKey;
    s.updateFX(clip.id, d.fx, false, f => {
      if (d.mode === 'move') f.bar = Math.max(0, Math.min(total - d.bars, snap(d.bar + db, fine)));
      else if (d.mode === 'start') { const end = d.bar + d.bars; const a = Math.max(0, Math.min(end - 0.25, snap(d.bar + db, fine))); f.bar = a; f.bars = end - a; }
      else f.bars = Math.max(0.25, Math.min(total - d.bar, snap(d.bar + d.bars + db, fine) - d.bar));
    });
  };
  const up = () => { drag.current = null; };

  return (
    <div className="fx-wave" ref={wrapRef}>
      <canvas ref={canvas} style={{ height }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <FXWavePlayhead clip={clip} xOf={xOf} height={height} total={total} />
    </div>
  );
}

function FXWavePlayhead({ clip, xOf, height, total }: { clip: Clip; xOf: (bar: number) => number; height: number; total: number }) {
  usePlayhead(30);
  const s = store;
  const t = s.playhead;
  if (s.index(clip.id) == null || t < clip.start || t > clipEnd(clip, s.masterBPM)) return null;
  const bar = barAtTimeline(clip, t, s.masterBPM);
  if (bar < 0 || bar > total) return null;
  return <div className="overview-playhead" style={{ left: Math.round(xOf(bar)), top: RULER_H, height: height - RULER_H }} />;
}
