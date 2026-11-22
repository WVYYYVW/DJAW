// Large editor to draw the fader / EQ / effect / stem moves of one transition by hand
// (mac/DJAW/Views/TransitionEditorView.swift).
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { L } from '../../core/i18n';
import {
  AutoPoint, AutoPt, Clip, Lane, LaneKind, Lanes, Shape, TransitionLanes, clipEnd, effectiveLanes, pt, sourceMapper, transitionPresets,
} from '../../core/models';
import { stemPeaks, stemPeaksVersion } from '../services/stemPeaks';
import { useStore, usePlayhead, useSize } from '../hooks';
import { store } from '../store/store';
import { Fmt, clipColor } from '../format';
import { showContextMenu } from './ContextMenu';
import { GridSelect, snapBeats, gridStep, beatFraction } from './GridSelect';

type Target = 'incoming' | 'outgoing' | 'mirror';
type Grab = { kind: 'point' | 'bend'; id: string } | null;
interface Sel { kind: LaneKind; incoming: boolean; id: string }

const INSET = 10;

/**
 * What each lane shows behind its curve, per pixel column (0…1): the part of the track the lane works on — the whole
 * track for the fader and the effects, the lows for LOW, the rest for MID / HIGH, and the separated stem for the stem
 * lanes (null while that stem is not separated / read yet).
 */
function laneWave(clip: Clip, kind: LaneKind, range: [number, number], cols: number): Float32Array | null {
  const s = store;
  const toSource = sourceMapper(clip, s.masterBPM);
  const span = (k: number) => { const t0 = range[0] + (range[1] - range[0]) * k / cols, t1 = range[0] + (range[1] - range[0]) * (k + 1) / cols; const a = toSource(t0); let b = toSource(t1); if (b < a) b = a + (t1 - t0); return [a, b]; };
  const out = new Float32Array(cols);
  if (Lane.isStem(kind)) {
    const files = s.stemsFor(clip.url);
    if (!files) return null;
    const names = kind === 'vocal' ? ['vocals'] : kind === 'instrumental' ? ['drums', 'bass', 'melody'] : [kind];
    const ready = () => store.changed();
    const all = (['vocals', 'drums', 'bass', 'melody'] as const).map(n => stemPeaks(files[n], ready));
    const mine = names.map(n => all[['vocals', 'drums', 'bass', 'melody'].indexOf(n)]);
    if (mine.some(p => !p)) return null;
    // Relative to the track's loudest stem, so a quiet part looks quiet.
    const top = Math.max(1e-6, ...all.map(p => p?.max ?? 0));
    for (let k = 0; k < cols; k++) {
      const [a, b] = span(k);
      let v = 0;
      for (const p of mine) {
        const bps = p!.binsPerSecond, n = p!.peaks.length;
        const b0 = Math.min(Math.max(0, Math.floor(a * bps)), n - 1), b1 = Math.min(n, Math.max(b0 + 1, Math.floor(b * bps)));
        for (let i = b0; i < b1; i++) if (p!.peaks[i] > v) v = p!.peaks[i];
      }
      out[k] = Math.min(1, v / top);
    }
    return out;
  }
  const wf = s.waveforms.get(clip.url);
  if (!wf || !wf.peaks.length) return null;
  const norm = 1 / Math.max(wf.maxPeak, 1e-6), bps = wf.binsPerSecond, n = wf.peaks.length;
  for (let k = 0; k < cols; k++) {
    const [a, b] = span(k);
    const b0 = Math.min(Math.max(0, Math.floor(a * bps)), n - 1), b1 = Math.min(n, Math.max(b0 + 1, Math.floor(b * bps)));
    let p = 0, l = 0;
    for (let i = b0; i < b1; i++) { if (wf.peaks[i] > p) p = wf.peaks[i]; if (wf.lows[i] > l) l = wf.lows[i]; }
    p *= norm; l *= norm;
    out[k] = Math.min(1, kind === 'low' ? l : kind === 'mid' || kind === 'high' ? Math.sqrt(Math.max(0, p * p - l * l)) : p);
  }
  return out;
}

function LaneCanvas({ clipID, kind, lanes, totalBeats, colorOut, colorIn, target, sel, setSel, range, height }: {
  clipID: string; kind: LaneKind; lanes: TransitionLanes; totalBeats: number; colorOut: string; colorIn: string; target: Target;
  sel: Sel | null; setSel: (s: Sel | null) => void; range: [number, number]; height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const grab = useRef<Grab>(null);
  const began = useRef(false);
  const lastTap = useRef<{ g: string; t: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const waveCache = useRef<{ key: string; a: Float32Array | null; b: Float32Array | null } | null>(null);
  const t = usePlayhead(0);
  const editIncoming = target !== 'outgoing';
  const size = () => ({ w: ref.current!.clientWidth, h: ref.current!.clientHeight });
  const xPos = (x: number, w: number) => INSET + x * (w - INSET * 2);
  const yPos = (y: number, h: number) => INSET + (1 - y) * (h - INSET * 2);
  const xVal = (px: number, w: number) => (px - INSET) / (w - INSET * 2);
  const yVal = (py: number, h: number) => 1 - (py - INSET) / (h - INSET * 2);
  const bendHandle = (a: AutoPoint, b: AutoPoint, w: number, h: number) => ({ x: xPos((a.x + b.x) / 2, w), y: yPos(AutoPt.segmentValue(a, b, 0.5), h) });

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, 8); ctx.fill();
    // Behind the curves: the previous track's part above the middle, this track's below (see laneWave).
    const idx = store.index(clipID);
    if (idx != null && idx > 0) {
      const cols = Math.max(1, Math.round(w - INSET * 2));
      const prevClip = store.clips[idx - 1], thisClip = store.clips[idx];
      const key = [cols, range[0], range[1], kind, prevClip.id, clipID, store.masterBPM, store.stemRevision, stemPeaksVersion,
        store.waveforms.get(prevClip.url)?.maxPeak ?? 0, store.waveforms.get(thisClip.url)?.maxPeak ?? 0,
        prevClip.bpm, prevClip.firstBeat, thisClip.bpm, thisClip.firstBeat].join('|');
      if (waveCache.current?.key !== key) waveCache.current = { key, a: laneWave(prevClip, kind, range, cols), b: laneWave(thisClip, kind, range, cols) };
      const { a, b } = waveCache.current!;
      const mid = h / 2, half = mid - INSET + 2;
      const band = (vals: Float32Array | null, color: string, up: boolean) => {
        if (!vals) return;
        ctx.beginPath();
        ctx.moveTo(INSET, mid);
        for (let k = 0; k < vals.length; k++) ctx.lineTo(INSET + k, mid + (up ? -1 : 1) * vals[k] * half);
        ctx.lineTo(INSET + vals.length, mid);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      ctx.save();
      ctx.globalAlpha = 0.24;
      band(a, colorOut, true);
      band(b, colorIn, false);
      ctx.restore();
      if ((!a || !b) && Lane.isStem(kind) && h > 40) {
        ctx.font = '10px system-ui'; ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillText(L('（分離すると、この成分の波形が出ます）', '(separate the tracks to see this part’s waveform)'), INSET + 6, h - INSET - 4);
      }
    }
    // Bars, beats, and the finer grid where it is at least 6 px apart.
    const g = store.editGrid;
    const fine = g > 0 && g < 1 && (xPos(1, w) - xPos(0, w)) / totalBeats * g >= 6 ? g : 1;
    for (let k = 0; k * fine <= totalBeats + 1e-9; k++) {
      const b = k * fine;
      const isBar = Math.abs(b / 4 - Math.round(b / 4)) < 1e-9, isBeat = Math.abs(b - Math.round(b)) < 1e-9;
      if (!isBar && totalBeats > 64) continue;
      ctx.fillStyle = `rgba(255,255,255,${isBar ? 0.13 : isBeat ? 0.05 : 0.025})`;
      ctx.fillRect(xPos(b / totalBeats, w), 0, 1, h);
    }
    for (const lv of [0, 0.5, 1]) { ctx.fillStyle = `rgba(255,255,255,${lv === 0.5 ? 0.05 : 0.1})`; ctx.fillRect(0, yPos(lv, h), w, 1); }
    for (const incoming of editIncoming ? [false, true] : [true, false]) {
      const pts = Lanes.points(lanes, kind, incoming);
      const color = incoming ? colorIn : colorOut;
      const editable = target === 'outgoing' ? !incoming : incoming;
      const path = new Path2D();
      path.moveTo(xPos(pts[0].x, w), yPos(pts[0].y, h));
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const steps = Math.max(2, Math.trunc((xPos(b.x, w) - xPos(a.x, w)) / 3));
        for (let s = 1; s <= steps; s++) {
          const tt = s / steps;
          path.lineTo(xPos(a.x + (b.x - a.x) * tt, w), yPos(AutoPt.segmentValue(a, b, tt), h));
        }
      }
      const area = new Path2D(path);
      area.lineTo(xPos(pts[pts.length - 1].x, w), yPos(0, h));
      area.lineTo(xPos(pts[0].x, w), yPos(0, h));
      area.closePath();
      ctx.globalAlpha = editable ? 0.18 : 0.07; ctx.fillStyle = color; ctx.fill(area); ctx.globalAlpha = 1;
      ctx.globalAlpha = editable ? 1 : 0.45; ctx.strokeStyle = color; ctx.lineWidth = editable ? 3 : 2; ctx.stroke(path); ctx.globalAlpha = 1;
      if (!editable) continue;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        if (xPos(b.x, w) - xPos(a.x, w) <= 26 || Math.abs(b.y - a.y) <= 0.02) continue;
        const c2 = bendHandle(a, b, w, h);
        const active = hover === 'b' + a.id || (grab.current?.kind === 'bend' && grab.current.id === a.id);
        const r = active ? 8 : 6.5;
        ctx.beginPath(); ctx.moveTo(c2.x, c2.y - r); ctx.lineTo(c2.x + r, c2.y); ctx.lineTo(c2.x, c2.y + r); ctx.lineTo(c2.x - r, c2.y); ctx.closePath();
        ctx.fillStyle = active ? color : 'rgb(38,38,38)'; ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      }
      for (const p of pts) {
        const selected = sel?.id === p.id;
        const r = selected || hover === 'p' + p.id ? 10 : 8;
        ctx.beginPath(); ctx.arc(xPos(p.x, w), yPos(p.y, h), r, 0, Math.PI * 2);
        ctx.fillStyle = selected ? color : '#fff'; ctx.fill();
        ctx.strokeStyle = selected ? '#fff' : color; ctx.lineWidth = 3; ctx.stroke();
      }
    }
    // Playhead inside the transition.
    if (t >= range[0] && t <= range[1]) {
      const x = xPos((t - range[0]) / Math.max(0.001, range[1] - range[0]), w);
      ctx.fillStyle = 'rgb(255,92,82)'; ctx.fillRect(x - 0.75, 0, 1.5, h);
    }
  });

  const hitTest = (px: number, py: number, w: number, h: number): Grab => {
    const pts = Lanes.points(lanes, kind, editIncoming);
    let best: { g: Grab; d: number } | null = null;
    for (const q of pts) {
      const d = Math.hypot(xPos(q.x, w) - px, yPos(q.y, h) - py);
      if (d <= 18 && d < (best?.d ?? Infinity)) best = { g: { kind: 'point', id: q.id }, d };
    }
    if (best) return best.g;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      if (xPos(b.x, w) - xPos(a.x, w) <= 26 || Math.abs(b.y - a.y) <= 0.02) continue;
      const c = bendHandle(a, b, w, h);
      if (Math.hypot(c.x - px, c.y - py) <= 16) return { kind: 'bend', id: a.id };
    }
    return null;
  };
  const snapX = (x: number, alt: boolean) => Math.min(1, Math.max(0, snapBeats(x * totalBeats, alt) / totalBeats));
  const snapY = (y: number, alt: boolean) => {
    const v = Math.min(1, Math.max(0, y));
    if (alt) return v;
    for (const lv of [0, 0.5, 1]) if (Math.abs(v - lv) < 0.04) return lv;
    return v;
  };
  const commit = (pts: AutoPoint[]) => {
    const id = clipID;
    let l = Lanes.setPoints(lanes, kind, editIncoming, pts);
    if (target === 'mirror' && !Lane.isEffect(kind) && !Lane.isStem(kind)) l = Lanes.mirrorToOutgoing(l, kind);
    store.setLanes(id, l, false);
  };
  const begin = () => { if (!began.current) { store.pushUndo(); store.isInteracting = true; began.current = true; } };

  const down = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const { w, h } = size();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    let pts = Lanes.points(lanes, kind, editIncoming).map(p => ({ ...p }));
    let g = hitTest(sx, sy, w, h);
    const tapKey = g ? g.kind + g.id : null;
    // Double-click: delete a point, or straighten a curve.
    if (g && lastTap.current && lastTap.current.g === tapKey && Date.now() - lastTap.current.t < 400) {
      lastTap.current = null;
      if (g.kind === 'point') {
        const k = pts.findIndex(p => p.id === g!.id);
        if (k > 0 && k < pts.length - 1) { begin(); pts.splice(k, 1); commit(pts); setSel(null); }
      } else {
        const k = pts.findIndex(p => p.id === g!.id);
        if (k >= 0) { begin(); pts[k].bend = 0; commit(pts); }
      }
      began.current = false;
      store.isInteracting = false;
      return;
    }
    lastTap.current = tapKey ? { g: tapKey, t: Date.now() } : null;
    if (!g) {
      begin();
      const p = pt(snapX(xVal(sx, w), e.altKey), snapY(yVal(sy, h), e.altKey));
      pts = [...pts, p].sort((a, b) => a.x - b.x);
      commit(pts);
      g = { kind: 'point', id: p.id };
    }
    grab.current = g;
    if (g.kind === 'point') setSel({ kind, incoming: editIncoming, id: g.id });
    const target0 = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - target0.x, ev.clientY - target0.y) < 2) return;
      begin();
      const lanesNow = effectiveLanes(store.clip(clipID)!);
      const cur = Lanes.points(lanesNow, kind, editIncoming).map(p => ({ ...p }));
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      const gg = grab.current!;
      const k = cur.findIndex(p => p.id === gg.id);
      if (k < 0) return;
      if (gg.kind === 'point') {
        if (k > 0 && k < cur.length - 1) cur[k].x = Math.min(cur[k + 1].x, Math.max(cur[k - 1].x, snapX(xVal(px, w), ev.altKey)));
        cur[k].y = snapY(yVal(py, h), ev.altKey);
      } else if (k + 1 < cur.length) {
        cur[k].bend = AutoPt.bend(cur[k], cur[k + 1], Math.min(1, Math.max(0, yVal(py, h))));
      }
      let l = Lanes.setPoints(lanesNow, kind, editIncoming, cur);
      if (target === 'mirror' && !Lane.isEffect(kind) && !Lane.isStem(kind)) l = Lanes.mirrorToOutgoing(l, kind);
      store.setLanes(clipID, l, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      grab.current = null;
      if (began.current) { store.isInteracting = false; store.changed(); }
      began.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const hoverMove = (e: React.PointerEvent) => {
    if (grab.current) return;
    const r = ref.current!.getBoundingClientRect();
    const { w, h } = size();
    const g = hitTest(e.clientX - r.left, e.clientY - r.top, w, h);
    const key = g ? (g.kind === 'point' ? 'p' : 'b') + g.id : null;
    if (key !== hover) setHover(key);
    ref.current!.style.cursor = !g ? 'crosshair' : g.kind === 'point' ? 'grab' : 'ns-resize';
  };
  return <canvas ref={ref} className="lane-canvas" style={{ height }} onPointerDown={down} onPointerMove={hoverMove} onPointerLeave={() => setHover(null)} />;
}

function BarRuler({ totalBeats, range }: { totalBeats: number; range: [number, number] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const t = usePlayhead(0);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bars = totalBeats / 4;
    ctx.font = '600 10px system-ui'; ctx.textBaseline = 'top';
    for (let b = 0; b <= bars; b++) {
      const x = INSET + b / bars * (w - INSET * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(x, h - 6, 1, 6);
      if (bars <= 32 || b % 4 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillText(`${b + 1}`, x + 3, 2); }
    }
    if (t >= range[0] && t <= range[1]) {
      const x = INSET + (t - range[0]) / Math.max(0.001, range[1] - range[0]) * (w - INSET * 2);
      ctx.fillStyle = 'rgb(255,92,82)'; ctx.fillRect(x - 0.75, 0, 1.5, h);
    }
  });
  // Click / drag to listen from there (plays on release).
  const pick = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left - INSET) / (r.width - INSET * 2)));
    return range[0] + f * (range[1] - range[0]);
  };
  return <canvas ref={ref} className="bar-ruler" title={L('クリック／ドラッグでその位置から再生', 'Click or drag to play from there')}
    onPointerDown={e => {
      store.beginScrub(); store.scrub(pick(e));
      const move = (ev: PointerEvent) => store.scrub(pick(ev as unknown as React.PointerEvent));
      const up = (ev: PointerEvent) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); store.endScrub(pick(ev as unknown as React.PointerEvent)); if (!store.isPlaying) store.play(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }} />;
}

/** The transition's lanes, drawn by hand (in the detail panel's Transition tab). */
export function TransitionEditor({ id }: { id: string }) {
  const s = useStore();
  const i = s.index(id);
  const [target, setTarget] = useState<Target>('mirror');
  const [page, setPage] = useState(0);
  // The lanes fill the editor's height: they grow when there is room (up to 3× their usual height) and shrink when
  // there is not, so every lane of the page is visible without scrolling (down to about a third).
  const [lanesRef, lanesSize] = useSize<HTMLDivElement>();
  const lanesEl = useRef<HTMLDivElement | null>(null);
  const [overhead, setOverhead] = useState(60);
  const baseHeight = (kind: string) => (kind === 'volume' ? 120 : page === 2 ? 64 : 84);
  const laneScale = (ks: readonly string[]) => {
    const sum = ks.reduce((a, k) => a + baseHeight(k), 0);
    return sum > 0 && lanesSize.height > 0 ? Math.max(0.34, Math.min(3, (lanesSize.height - overhead) / sum)) : 1;
  };
  const [sel, setSel] = useState<Sel | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (store.focusArea !== 'panel' || !sel || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') { setSel(null); e.stopPropagation(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSel(); e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  // What the lanes area holds besides the lanes themselves (ruler, stem status, gaps, padding), measured after drawing.
  useLayoutEffect(() => {
    const el = lanesEl.current;
    if (!el || !el.lastElementChild) return;
    let lanesSum = 0;
    el.querySelectorAll<HTMLElement>('canvas.lane-canvas').forEach(c => { lanesSum += c.offsetHeight; });
    const content = el.lastElementChild.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop + 10;
    const o = Math.ceil(content - lanesSum);
    if (lanesSum > 0 && Math.abs(o - overhead) > 2) setOverhead(o);
  });
  if (i == null || i === 0) return null;
  const prev = s.clips[i - 1], clip = s.clips[i];
  const lanes = effectiveLanes(clip);
  const totalBeats = Math.max(1, clip.transitionBars * 4);
  const range: [number, number] = [clip.start, Math.max(clip.start + 0.001, Math.min(clipEnd(prev, s.masterBPM), clipEnd(clip, s.masterBPM)))];
  const kinds = page === 1 ? Lane.effects : page === 2 ? Lane.stems : Lane.mixer;
  const scale = laneScale(kinds);
  const laneHeight = (kind: string) => Math.floor(baseHeight(kind) * scale);
  const colorA = clipColor(prev.colorIndex), colorB = clipColor(clip.colorIndex);
  const selPoint = sel ? Lanes.points(lanes, sel.kind, sel.incoming).find(p => p.id === sel.id) : null;
  function deleteSel() {
    if (!sel) return;
    const pts = Lanes.points(lanes, sel.kind, sel.incoming);
    const k = pts.findIndex(p => p.id === sel.id);
    if (k <= 0 || k >= pts.length - 1) return;
    let l = Lanes.setPoints(lanes, sel.kind, sel.incoming, pts.filter(p => p.id !== sel.id));
    if (target === 'mirror' && !Lane.isEffect(sel.kind) && !Lane.isStem(sel.kind)) l = Lanes.mirrorToOutgoing(l, sel.kind);
    s.setLanes(id, l);
    setSel(null);
  }
  const movePoint = (dx: number, dy: number) => {
    if (!sel) return;
    const pts = Lanes.points(lanes, sel.kind, sel.incoming).map(p => ({ ...p }));
    const k = pts.findIndex(p => p.id === sel.id);
    if (k < 0) return;
    if (dx && k > 0 && k < pts.length - 1) pts[k].x = Math.min(pts[k + 1].x, Math.max(pts[k - 1].x, pts[k].x + dx));
    pts[k].y = Math.min(1, Math.max(0, pts[k].y + dy));
    let l = Lanes.setPoints(lanes, sel.kind, sel.incoming, pts);
    if (target === 'mirror' && !Lane.isEffect(sel.kind) && !Lane.isStem(sel.kind)) l = Lanes.mirrorToOutgoing(l, sel.kind);
    s.setLanes(id, l);
  };
  const posLabel = (x: number) => {
    const beats = Math.round(x * totalBeats * 8) / 8;
    const whole = Math.floor(beats + 1e-9);
    const bar = Math.floor(whole / 4) + 1, beat = whole % 4 + 1, frac = beatFraction(beats - whole);
    if (beat === 1 && !frac) return L(`${bar}小節目`, `bar ${bar}`);
    return L(`${bar}小節目 ${beat}${frac ? ` ${frac}` : ''}拍`, `bar ${bar} beat ${beat}${frac ? ` ${frac}` : ''}`);
  };
  return (
    <div className="te-embedded">
        <div className="te-header">
          <div className="te-tracks"><span className="dot" style={{ background: colorA }} />{prev.title} <span className="dim">→</span> <span className="dot" style={{ background: colorB }} />{clip.title}</div>
          <span className="dim">{L('長さ', 'Length')}</span>
          {[2, 4, 8, 16, 32].map(b => <button key={b} className={'btn small' + (Math.abs(clip.transitionBars - b) < 0.01 ? ' on' : '')} onClick={() => s.setTransitionLength(id, b)}>{b}</button>)}
          <span className="stepbtns"><button onClick={() => s.setTransitionLength(id, Math.max(1, clip.transitionBars - 1))}>−</button><button onClick={() => s.setTransitionLength(id, clip.transitionBars + 1)}>＋</button></span>
          <span className="mono">{Fmt.bars(clip.transitionBars)}</span>
          <button className="btn primary" onClick={() => s.previewTransition(id)}>▶ {s.isPlaying ? L('再生中…', 'Playing…') : L('試聴', 'Preview')}</button>
          {s.isPlaying && <button className="btn" onClick={() => s.pause()}>⏸</button>}
          <button className="btn" disabled={s.currentTakeID(id) != null} onClick={() => s.saveTake(id)}>{s.currentTakeID(id) == null ? L('候補に保存', 'Save as Take') : L('保存済み', 'Saved')}</button>
        </div>
        {clip.transitionBars < 0.01 ? (
          <div className="te-empty">
            <div>{L('重なりがありません', 'No overlap')}</div>
            <div className="caption">{L('つなぎの長さを 1小節以上にすると、フェーダーと EQ の動きを描けます。', 'Set the length to 1 bar or more to draw fader and EQ moves.')}</div>
            <button className="btn" onClick={() => s.setTransitionLength(id, 8)}>{L('8小節にする', 'Make it 8 bars')}</button>
          </div>
        ) : <>
          <div className="te-toolbar">
            <div className="segmented">
              {[L('フェーダー・EQ', 'Fader / EQ'), 'FX', L('ステム', 'Stems')].map((t, k) => <button key={k} title={k === 2 ? L('ステム（歌・ドラム・ベース・メロディ）', 'Stems (vocals · drums · bass · melody)') : undefined} className={page === k ? 'on' : ''} onClick={() => { setPage(k); if (k !== 0 && target === 'mirror') setTarget('outgoing'); }}>{t}</button>)}
            </div>
            <span className="dim">{L('描く線', 'Edit')}</span>
            <div className="segmented">
              {(['incoming', 'outgoing', 'mirror'] as Target[]).filter(x => page === 0 || x !== 'mirror').map(x => (
                <button key={x} className={target === x ? 'on' : ''} onClick={() => setTarget(x)}>
                  {x === 'incoming' ? L('入る側', 'Incoming') : x === 'outgoing' ? L('出る側', 'Outgoing') : L('対称', 'Mirrored')}
                </button>
              ))}
            </div>
            <span className="legend"><span className="dot" style={{ background: colorA }} />{L('前の曲', 'Prev')} <span className="dot" style={{ background: colorB }} />{L('この曲', 'This')}</span>
            <button className="btn" onClick={e => showContextMenu(e, [
              ...transitionPresets().map(p => ({ label: L(`「${p.title}」から始める`, `Start from “${p.title}”`), action: () => s.setLanes(id, Lanes.sampled(p.style, Shape.defaults(p.style))) })),
              ...(s.customTransitions.length ? [{ separator: true }, ...s.customTransitions.map(p => ({ label: p.name, action: () => s.applyCustomTransition(id, p) }))] : []),
            ])}>{L('ひな形', 'Start from')} ▾</button>
            <GridSelect />
          </div>
          {/* The selected point, or the hint: one row of fixed height, so selecting or deleting a point never moves the lanes. */}
          <div className="te-selbar">
            {selPoint && sel ? (
              <div className="te-sel">
                <b>{Lane.title(sel.kind)} · {sel.incoming ? L('この曲', 'This') : L('前の曲', 'Prev')}</b>
                <span className="mono">{posLabel(selPoint.x)}</span>
                <span className="stepbtns" title={L('グリッドの1目盛りずつ動かす', 'Move by one grid step')}><button onClick={() => movePoint(-gridStep() / totalBeats, 0)}>‹</button><button onClick={() => movePoint(gridStep() / totalBeats, 0)}>›</button></span>
                <span className="mono">{Math.round(selPoint.y * 100)}%</span>
                <span className="stepbtns"><button onClick={() => movePoint(0, -0.05)}>−</button><button onClick={() => movePoint(0, 0.05)}>＋</button></span>
                <button className="btn small" onClick={deleteSel}>🗑</button>
              </div>
            ) : <span className="caption grow" title={L('◆を上下にドラッグで曲線を曲げる・空いた所をクリックで点を追加・点をドラッグで移動・ダブルクリックで削除／直線に戻す（Alt で細かく）', 'Drag ◆ to bend · click empty space to add a point · drag points to move · double-click to delete / straighten (Alt: fine)')}>{L('◆を上下にドラッグで曲線を曲げる・空いた所をクリックで点を追加・点をドラッグで移動・ダブルクリックで削除／直線に戻す（Alt で細かく）', 'Drag ◆ to bend · click empty space to add a point · drag points to move · double-click to delete / straighten (Alt: fine)')}</span>}
            <SaveCustom clip={clip} />
          </div>
          <div className="te-lanes" ref={el => { lanesEl.current = el; lanesRef(el); }}>
            <div className="te-lane-row"><div className="te-lane-head" /><BarRuler totalBeats={totalBeats} range={range} /></div>
            {page === 2 && <StemStatus id={id} />}
            {kinds.map(kind => (
              <div key={kind} className="te-lane-row">
                <div className={'te-lane-head' + (laneHeight(kind) < 66 ? ' compact' : '')} title={Lane.legend(kind)}>
                  <div className="te-lane-title">{Lane.title(kind)}</div>
                  {laneHeight(kind) >= 66 && <div className="te-lane-legend">{Lane.legend(kind)}</div>}
                  <button className="btn small" onClick={e => showContextMenu(e, [
                    ...((Lane.isEffect(kind) || Lane.isStem(kind)) ? Lanes.effectPresets(kind).map(p => ({ label: p.title, action: () => s.setLanes(id, Lanes.applyEffectPreset(lanes, p, kind)) }))
                      : Lanes.templates.map(tm => ({ label: Lanes.templateTitle(tm), action: () => s.setLanes(id, Lanes.applyTemplate(lanes, tm, kind)) }))),
                    { separator: true },
                    { label: L('この線をリセット', 'Reset this lane'), action: () => s.setLanes(id, (Lane.isEffect(kind) || Lane.isStem(kind)) ? Lanes.clear(lanes, kind) : Lanes.applyTemplate(lanes, 'linear', kind)) },
                  ])}>{L('形', 'Shape')} ▾</button>
                </div>
                <LaneCanvas clipID={id} kind={kind} lanes={lanes} totalBeats={totalBeats} colorOut={colorA} colorIn={colorB} target={target} sel={sel} setSel={setSel} range={range} height={laneHeight(kind)} />
              </div>
            ))}
          </div>
        </>}
    </div>
  );
}

function SaveCustom({ clip }: { clip: Clip }) {
  const s = useStore();
  const [name, setName] = useState('');
  return (
    <div className="te-savecustom" title={L('マイつなぎとして保存：ほかの曲間でも使えます（「ひな形」から選べます）', 'Save as My Transition: use it between other tracks too (from “Start from”)')}>
      <input className="text" value={name} placeholder={L('マイつなぎの名前', 'My Transition name')} onChange={e => setName(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { s.saveCustomTransition(clip.id, name); setName(''); } }} />
      <button className="btn small" onClick={() => { s.saveCustomTransition(clip.id, name); setName(''); }}>{L('マイつなぎに保存', 'Save as My Transition')}</button>
    </div>
  );
}

/** Whether the two tracks' vocals / instrumental are separated yet (needed for the vocal lanes). */
function StemStatus({ id }: { id: string }) {
  const s = useStore();
  const i = s.index(id);
  return (
    <div className="caption stem-note stem-status" title={L('ボーカル・ドラム・ベース・メロディへの分離は1曲につき1回（4分の曲で30秒ほど）だけ行い、保存して使い回します。線を描くと自動で始まります。「伴奏」の線は、ドラム・ベース・メロディをまとめて上げ下げします。', 'Separation into vocals, drums, bass and melody runs once per track (about 30 s for 4 minutes) and is kept. Drawing a line starts it. The Instrumental lane turns drums, bass and melody up and down together.')}>
      <span>🎤</span>
      {!s.stemsAvailable() ? <span>{L('ステム分離のモデルが入っていないため、この版では使えません。', 'The stem separation model is not installed in this build.')}</span>
        : i != null && i > 0 ? [s.clips[i - 1], s.clips[i]].map(c => {
          const p = s.stemProgress.get(c.url);
          if (p != null) return <span key={c.id} className="stem-item"><progress value={p} max={1} />{L(`「${c.title}」を分離中…`, `Separating “${c.title}”…`)}</span>;
          if (s.stemsFor(c.url)) return <span key={c.id} className="stem-item ok">✓ {c.title}</span>;
          return <button key={c.id} className="btn small" onClick={() => s.prepareStems([c.url])}>{L(`「${c.title}」を分離`, `Separate “${c.title}”`)}</button>;
        }) : null}
    </div>
  );
}
