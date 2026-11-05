// Large editor to draw the fader / EQ / effect / stem moves of one transition by hand
// (mac/DJAW/Views/TransitionEditorView.swift).
import React, { useEffect, useRef, useState } from 'react';
import { L } from '../../core/i18n';
import {
  AutoPoint, AutoPt, Clip, Lane, LaneKind, Lanes, Shape, TransitionLanes, clipEnd, effectiveLanes, pt, transitionPresets,
} from '../../core/models';
import { useStore, usePlayhead } from '../hooks';
import { store } from '../store/store';
import { Fmt, clipColor } from '../format';
import { showContextMenu } from './ContextMenu';

type Target = 'incoming' | 'outgoing' | 'mirror';
type Grab = { kind: 'point' | 'bend'; id: string } | null;
interface Sel { kind: LaneKind; incoming: boolean; id: string }

const INSET = 10;

function LaneCanvas({ kind, lanes, totalBeats, colorOut, colorIn, target, sel, setSel, range, height }: {
  kind: LaneKind; lanes: TransitionLanes; totalBeats: number; colorOut: string; colorIn: string; target: Target;
  sel: Sel | null; setSel: (s: Sel | null) => void; range: [number, number]; height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const grab = useRef<Grab>(null);
  const began = useRef(false);
  const lastTap = useRef<{ g: string; t: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
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
    for (let b = 0; b <= totalBeats; b++) {
      const isBar = b % 4 === 0;
      if (!isBar && totalBeats > 64) continue;
      ctx.fillStyle = `rgba(255,255,255,${isBar ? 0.13 : 0.04})`;
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
  const snapX = (x: number, alt: boolean) => (alt ? Math.min(1, Math.max(0, x)) : Math.min(1, Math.max(0, Math.round(x * totalBeats) / totalBeats)));
  const snapY = (y: number, alt: boolean) => {
    const v = Math.min(1, Math.max(0, y));
    if (alt) return v;
    for (const lv of [0, 0.5, 1]) if (Math.abs(v - lv) < 0.04) return lv;
    return v;
  };
  const commit = (pts: AutoPoint[]) => {
    const id = store.transitionEditorTarget!;
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
      const lanesNow = effectiveLanes(store.clip(store.transitionEditorTarget!)!);
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
      store.setLanes(store.transitionEditorTarget!, l, false);
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

export function TransitionEditor() {
  const s = useStore();
  const id = s.transitionEditorTarget!;
  const i = s.index(id);
  const [target, setTarget] = useState<Target>('mirror');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Sel | null>(null);
  const close = () => { s.isInteracting = false; s.transitionEditorTarget = null; s.changed(); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); e.stopPropagation(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { deleteSel(); e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  if (i == null || i === 0) return null;
  const prev = s.clips[i - 1], clip = s.clips[i];
  const lanes = effectiveLanes(clip);
  const totalBeats = Math.max(1, clip.transitionBars * 4);
  const range: [number, number] = [clip.start, Math.max(clip.start + 0.001, Math.min(clipEnd(prev, s.masterBPM), clipEnd(clip, s.masterBPM)))];
  const kinds = page === 1 ? Lane.effects : page === 2 ? Lane.stems : Lane.mixer;
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
    const beats = Math.round(x * totalBeats);
    const bar = Math.floor(beats / 4) + 1, beat = beats % 4 + 1;
    return beat === 1 ? L(`${bar}小節目`, `bar ${bar}`) : L(`${bar}小節目 ${beat}拍`, `bar ${bar} beat ${beat}`);
  };
  return (
    <div className="sheet-backdrop">
      <div className="sheet transition-editor">
        <div className="te-header">
          <div>
            <div className="sheet-title">{L('つなぎエディタ', 'Transition Editor')}</div>
            <div className="te-tracks"><span className="dot" style={{ background: colorA }} />{prev.title} <span className="dim">→</span> <span className="dot" style={{ background: colorB }} />{clip.title}</div>
          </div>
          <div className="spacer" />
          <span className="dim">{L('長さ', 'Length')}</span>
          {[2, 4, 8, 16, 32].map(b => <button key={b} className={'btn small' + (Math.abs(clip.transitionBars - b) < 0.01 ? ' on' : '')} onClick={() => s.setTransitionLength(id, b)}>{b}</button>)}
          <span className="stepbtns"><button onClick={() => s.setTransitionLength(id, Math.max(1, clip.transitionBars - 1))}>−</button><button onClick={() => s.setTransitionLength(id, clip.transitionBars + 1)}>＋</button></span>
          <span className="mono">{Fmt.bars(clip.transitionBars)}</span>
          <button className="btn primary" onClick={() => s.previewTransition(id)}>▶ {s.isPlaying ? L('再生中…', 'Playing…') : L('試聴', 'Preview')}</button>
          {s.isPlaying && <button className="btn" onClick={() => s.pause()}>⏸</button>}
          <button className="btn" disabled={s.currentTakeID(id) != null} onClick={() => s.saveTake(id)}>{s.currentTakeID(id) == null ? L('候補に保存', 'Save as Take') : L('保存済み', 'Saved')}</button>
          <button className="btn primary" onClick={close}>{L('完了', 'Done')}</button>
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
              {[L('フェーダー・EQ', 'Fader / EQ'), 'FX', L('ボーカル', 'Vocals')].map((t, k) => <button key={k} className={page === k ? 'on' : ''} onClick={() => { setPage(k); if (k !== 0 && target === 'mirror') setTarget('outgoing'); }}>{t}</button>)}
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
            <div className="spacer" />
            {selPoint && sel ? (
              <div className="te-sel">
                <b>{Lane.title(sel.kind)} · {sel.incoming ? L('この曲', 'This') : L('前の曲', 'Prev')}</b>
                <span className="mono">{posLabel(selPoint.x)}</span>
                <span className="stepbtns"><button onClick={() => movePoint(-1 / totalBeats, 0)}>‹</button><button onClick={() => movePoint(1 / totalBeats, 0)}>›</button></span>
                <span className="mono">{Math.round(selPoint.y * 100)}%</span>
                <span className="stepbtns"><button onClick={() => movePoint(0, -0.05)}>−</button><button onClick={() => movePoint(0, 0.05)}>＋</button></span>
                <button className="btn small" onClick={deleteSel}>🗑</button>
              </div>
            ) : <span className="caption">{L('◆を上下にドラッグで曲線を曲げる・空いた所をクリックで点を追加・点をドラッグで移動・ダブルクリックで削除／直線に戻す（Alt で細かく）', 'Drag ◆ to bend · click empty space to add a point · drag points to move · double-click to delete / straighten (Alt: fine)')}</span>}
          </div>
          <div className="te-lanes">
            <div className="te-lane-row"><div className="te-lane-head" /><BarRuler totalBeats={totalBeats} range={range} /></div>
            {page === 2 && <StemStatus id={id} />}
            {kinds.map(kind => (
              <div key={kind} className="te-lane-row">
                <div className="te-lane-head">
                  <div className="te-lane-title">{Lane.title(kind)}</div>
                  <div className="te-lane-legend">{Lane.legend(kind)}</div>
                  <button className="btn small" onClick={e => showContextMenu(e, [
                    ...((Lane.isEffect(kind) || Lane.isStem(kind)) ? Lanes.effectPresets(kind).map(p => ({ label: p.title, action: () => s.setLanes(id, Lanes.applyEffectPreset(lanes, p, kind)) }))
                      : Lanes.templates.map(tm => ({ label: Lanes.templateTitle(tm), action: () => s.setLanes(id, Lanes.applyTemplate(lanes, tm, kind)) }))),
                    { separator: true },
                    { label: L('この線をリセット', 'Reset this lane'), action: () => s.setLanes(id, (Lane.isEffect(kind) || Lane.isStem(kind)) ? Lanes.clear(lanes, kind) : Lanes.applyTemplate(lanes, 'linear', kind)) },
                  ])}>{L('形', 'Shape')} ▾</button>
                </div>
                <LaneCanvas kind={kind} lanes={lanes} totalBeats={totalBeats} colorOut={colorA} colorIn={colorB} target={target} sel={sel} setSel={setSel} range={range} height={kind === 'volume' ? 150 : 110} />
              </div>
            ))}
          </div>
        </>}
        <div className="te-footer">
          <SaveCustom clip={clip} />
        </div>
      </div>
    </div>
  );
}

function SaveCustom({ clip }: { clip: Clip }) {
  const s = useStore();
  const [name, setName] = useState('');
  return (
    <div className="button-row">
      <span className="dim">{L('マイつなぎとして保存（ほかの曲間でも使えます）', 'Save as My Transition (use it between other tracks too)')}</span>
      <input className="text" value={name} placeholder={L('名前', 'Name')} onChange={e => setName(e.target.value)} onKeyDown={e => e.stopPropagation()} />
      <button className="btn" onClick={() => { s.saveCustomTransition(clip.id, name); setName(''); }}>{L('保存', 'Save')}</button>
    </div>
  );
}

/** Whether the two tracks' vocals / instrumental are separated yet (needed for the vocal lanes). */
function StemStatus({ id }: { id: string }) {
  const s = useStore();
  const i = s.index(id);
  return (
    <div className="caption stem-note stem-status" title={L('ボーカルと伴奏の分離は1曲につき1回（数十秒）だけ行い、保存して使い回します。線を描くと自動で始まります。', 'Vocals and instrumental are separated once per track (tens of seconds) and kept. Drawing a line starts it automatically.')}>
      <span>🎤</span>
      {!s.stemsAvailable() ? <span>{L('ボーカル分離のモデルが入っていないため、この版では使えません。', 'The vocal separation model is not installed in this build.')}</span>
        : i != null && i > 0 ? [s.clips[i - 1], s.clips[i]].map(c => {
          const p = s.stemProgress.get(c.url);
          if (p != null) return <span key={c.id} className="stem-item"><progress value={p} max={1} />{L(`「${c.title}」を分離中…`, `Separating “${c.title}”…`)}</span>;
          if (s.stemsFor(c.url)) return <span key={c.id} className="stem-item ok">✓ {c.title}</span>;
          return <button key={c.id} className="btn small" onClick={() => s.prepareStems([c.url])}>{L(`「${c.title}」を分離`, `Separate “${c.title}”`)}</button>;
        }) : null}
    </div>
  );
}
