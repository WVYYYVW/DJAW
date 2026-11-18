// The loop editor (the detail panel's Loop tab): one track's waveform on its beat grid. Drag across it to choose a range
// and turn it into a loop (or a beat jump that skips it); drag a loop to move it, its edges to change its length.
// Loops and jumps are in the track's own bars, so they stay with the music when the track moves in the mix.
import React, { useEffect, useRef, useState } from 'react';
import { L } from '../../core/i18n';
import { Clip, ClipEdit, Edit, activeLoop, barAtSource, barLabel, barSource, lastBar, sourceTimeAtBar, sourceTimeAtTimeline, clipEnd } from '../../core/models';
import { useStore, usePlayhead } from '../hooks';
import { store } from '../store/store';
import { MIN_EDIT_BARS } from '../store/loops';
import { Theme, clipColor } from '../format';
import { drawWave, useCanvas } from './CueEditor';
import { showContextMenu } from './ContextMenu';

const YELLOW = 'rgb(255,214,10)', TEAL = 'rgb(64,200,224)', GREEN = 'rgb(48,209,88)', ORANGE = 'rgb(255,159,10)', BLUE = 'rgb(61,139,253)';
const zooms = [4, 8, 16, 32, 64];
const snaps: { bars: number; label: () => string }[] = [
  { bars: 1 / 16, label: () => L('1/4拍', '¼ beat') },
  { bars: 1 / 4, label: () => L('1拍', '1 beat') },
  { bars: 1 / 2, label: () => L('2拍', '2 beats') },
  { bars: 1, label: () => L('1小節', '1 bar') },
];
const repeatChoices = [1, 2, 3, 4, 7, 15];
const TOP = 20, BOTTOM = 16;

type Part = 'move' | 'start' | 'end';
type Drag =
  | { kind: 'edit'; id: string; part: Part; x0: number; orig: ClipEdit; moved: boolean }
  | { kind: 'select'; x0: number; a: number; moved: boolean };

const lengthText = (bars: number) => Edit.lengthLabel({ id: '', kind: 'loop', bar: 0, bars, repeats: 1 });

/** The bar the main playhead is at in this track (null when the track is not playing there). */
function playheadBar(c: Clip, t: number) {
  if (store.index(c.id) == null || t < c.start || t >= clipEnd(c, store.masterBPM)) return null;
  return barAtSource(c, sourceTimeAtTimeline(c, t, store.masterBPM));
}

export function LoopEditor({ id }: { id: string }) {
  const s = useStore();
  const clip = s.clip(id);
  return clip ? <LoopEditorBody clip={clip} /> : null;
}

function LoopEditorBody({ clip }: { clip: Clip }) {
  const s = useStore();
  const id = clip.id;
  const t = usePlayhead(30);
  const [viewBars, setViewBars] = useState(16);
  const [viewStart, setViewStart] = useState<number | null>(null);
  const [snap, setSnap] = useState(1);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [repeats, setRepeats] = useState(1);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const canvasW = useRef(800);

  const editID = s.loopEditorEdit && clip?.edits?.some(e => e.id === s.loopEditorEdit) ? s.loopEditorEdit : null;
  const edit = editID ? clip!.edits!.find(e => e.id === editID)! : null;
  const selectEdit = (eid: string | null) => { s.loopEditorEdit = eid; s.changed(); };

  // Start around the selected loop, else the mix-in.
  useEffect(() => {
    if (!clip) return;
    const focus = edit ? edit.bar + edit.bars / 2 : clip.mixInBar + viewBars / 2;
    setViewStart(Math.floor(focus - viewBars / 2));
  }, [id]);
  const start = viewStart ?? (clip ? clip.mixInBar : 0);
  const minBar = clip ? Math.floor(barAtSource(clip, 0)) : 0;
  const maxBar = clip ? lastBar(clip) : 1;
  const clampStart = (v: number, span = viewBars) => Math.max(minBar - 1, Math.min(v, maxBar + 1 - span));
  const playBar = clip ? playheadBar(clip, t) : null;

  // Keep the playhead in view while playing.
  useEffect(() => {
    if (playBar == null || !s.isPlaying || drag.current) return;
    if (playBar < start || playBar > start + viewBars) setViewStart(clampStart(Math.floor(playBar - viewBars / 4)));
  }, [playBar]);

  const ref = useCanvas((ctx, w, h) => {
    canvasW.current = w;
    const bx = (bar: number) => (bar - start) / viewBars * w;
    const wf = s.waveforms.get(clip.url);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.roundRect(0, 0, w, h, 6); ctx.fill();
    // Beat grid.
    const beatPx = w / viewBars / 4;
    ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'middle';
    const every = viewBars > 32 ? 4 : viewBars > 16 ? 2 : 1;
    for (let k = Math.ceil(start * 4); k <= (start + viewBars) * 4; k++) {
      const px = bx(k / 4);
      const isBar = k % 4 === 0;
      if (!isBar && beatPx < 5) continue;
      ctx.fillStyle = `rgba(255,255,255,${isBar ? (Math.round(k / 4) % 4 === 0 ? 0.2 : 0.12) : 0.045})`;
      ctx.fillRect(px, TOP, 1, h - TOP - BOTTOM);
      if (isBar && Math.round(k / 4) % every === 0) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillText(barLabel(k / 4), px + 3, h - BOTTOM / 2); }
    }
    if (wf) drawWave(ctx, { x: 0, y: TOP + 4, w, h: h - TOP - BOTTOM - 8 }, wf, sourceTimeAtBar(clip, start), sourceTimeAtBar(clip, start + viewBars), 'rgba(200,205,215,0.75)');
    // Outside the file.
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    if (bx(minBar) > 0) ctx.fillRect(0, 0, bx(barAtSource(clip, 0)), h);
    if (bx(maxBar) < w) ctx.fillRect(bx(maxBar), 0, w - bx(maxBar), h);
    // IN / OUT.
    const marker = (bar: number, color: string, label: string) => {
      const px = bx(bar);
      if (px < -2 || px > w + 2) return;
      ctx.fillStyle = color; ctx.fillRect(px - 0.75, TOP, 1.5, h - TOP - BOTTOM);
      ctx.font = '700 9px system-ui'; ctx.fillText(label, px + 3, TOP + 7);
    };
    marker(clip.mixInBar, GREEN, 'IN');
    marker(clip.mixOutBar, ORANGE, 'OUT');
    // Loops and jumps.
    for (const e of clip.edits ?? []) {
      const x0 = bx(e.bar), x1 = bx(e.bar + e.bars);
      if (x1 < 0 || x0 > w) continue;
      const on = e.id === editID, hot = e.id === hover;
      const color = e.kind === 'loop' ? YELLOW : TEAL;
      const rgba = (a: number) => color.replace('rgb', 'rgba').replace(')', `,${a})`);
      if (e.kind === 'loop') {
        ctx.fillStyle = rgba(on ? 0.28 : hot ? 0.2 : 0.14);
        ctx.fillRect(x0, TOP, x1 - x0, h - TOP - BOTTOM);
      } else {
        // A jump skips this range: hatched.
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, TOP, x1 - x0, h - TOP - BOTTOM); ctx.clip();
        ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x0, TOP, x1 - x0, h - TOP - BOTTOM);
        ctx.strokeStyle = rgba(on ? 0.6 : 0.35); ctx.lineWidth = 1;
        for (let x = x0 - h; x < x1; x += 9) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
        ctx.restore();
      }
      ctx.fillStyle = color;
      ctx.fillRect(x0 - 1, TOP, on ? 3 : 2, h - TOP - BOTTOM);
      ctx.fillRect(x1 - (on ? 2 : 1), TOP, on ? 3 : 2, h - TOP - BOTTOM);
      // The label on top.
      ctx.beginPath(); ctx.roundRect(x0, 2, Math.max(16, x1 - x0), TOP - 4, 3); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, Math.max(16, x1 - x0), TOP); ctx.clip();
      ctx.fillStyle = '#000'; ctx.font = '700 10px system-ui';
      ctx.fillText(e.kind === 'loop' ? `⟲ ${lengthText(e.bars)} ×${e.repeats + 1}` : `⇥ ${lengthText(e.bars)} ${L('スキップ', 'skip')}`, x0 + 4, TOP / 2);
      ctx.restore();
      if (on) {
        // Edge handles.
        ctx.fillStyle = '#fff';
        for (const x of [x0, x1]) { ctx.beginPath(); ctx.roundRect(x - 3, h / 2 - 12, 6, 24, 3); ctx.fill(); }
      }
    }
    // The range being chosen.
    if (sel) {
      const x0 = bx(sel[0]), x1 = bx(sel[1]);
      ctx.fillStyle = 'rgba(61,139,253,0.22)'; ctx.fillRect(x0, TOP, x1 - x0, h - TOP - BOTTOM);
      ctx.fillStyle = BLUE; ctx.fillRect(x0, TOP, 1.5, h - TOP - BOTTOM); ctx.fillRect(x1 - 1.5, TOP, 1.5, h - TOP - BOTTOM);
      ctx.beginPath(); ctx.roundRect(x0, 2, Math.max(16, x1 - x0), TOP - 4, 3); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 10px system-ui'; ctx.fillText(lengthText(sel[1] - sel[0]), x0 + 4, TOP / 2);
    }
    // The mix's playhead, when it is in this track.
    if (playBar != null) {
      const px = bx(playBar);
      if (px >= 0 && px <= w) { ctx.fillStyle = Theme.playhead; ctx.fillRect(px - 1, 0, 2, h); }
    }
  });

  const inMix = s.index(clip.id) != null;
  const unit = snap;
  const barAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return start + (clientX - r.left) / r.width * viewBars;
  };
  const snapTo = (b: number, fine: boolean) => { const u = fine ? MIN_EDIT_BARS : unit; return Math.round(b / u) * u; };
  const hit = (clientX: number): { id: string; part: Part } | null => {
    const r = ref.current!.getBoundingClientRect();
    const px = clientX - r.left;
    const bx = (bar: number) => (bar - start) / viewBars * r.width;
    const list = [...(clip.edits ?? [])].sort((a, b) => (a.id === editID ? 1 : 0) - (b.id === editID ? 1 : 0)).reverse();
    for (const e of list) {
      const x0 = bx(e.bar), x1 = bx(e.bar + e.bars);
      if (Math.abs(px - x0) <= 6) return { id: e.id, part: 'start' };
      if (Math.abs(px - x1) <= 6) return { id: e.id, part: 'end' };
      if (px > x0 && px < x1) return { id: e.id, part: 'move' };
    }
    return null;
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const h = hit(e.clientX);
    if (h) {
      const orig = clip.edits!.find(x => x.id === h.id)!;
      selectEdit(h.id);
      setSel(null);
      if (e.detail >= 2) { s.previewBar(clip.id, orig.bar); return; }
      drag.current = { kind: 'edit', id: h.id, part: h.part, x0: e.clientX, orig, moved: false };
    } else {
      drag.current = { kind: 'select', x0: e.clientX, a: barAt(e.clientX), moved: false };
    }
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved) {
        if (Math.abs(ev.clientX - d.x0) < 3) return;
        d.moved = true;
        if (d.kind === 'edit') { s.pushUndo(); s.isInteracting = true; }
      }
      if (d.kind === 'select') {
        const b = barAt(ev.clientX), u = ev.altKey ? MIN_EDIT_BARS : unit;
        const lo = Math.max(minBar, Math.floor(Math.min(d.a, b) / u) * u), hi = Math.min(maxBar, Math.ceil(Math.max(d.a, b) / u) * u);
        setSel(hi - lo >= MIN_EDIT_BARS - 1e-9 ? [lo, hi] : null);
        selectEdit(null);
        return;
      }
      const delta = barAt(ev.clientX) - barAt(d.x0);
      const o = d.orig, fine = ev.altKey;
      let patch: Partial<ClipEdit>;
      if (d.part === 'move') patch = { bar: snapTo(o.bar + delta, fine) };
      else if (d.part === 'start') { const nb = Math.min(snapTo(o.bar + delta, fine), o.bar + o.bars - MIN_EDIT_BARS); patch = { bar: nb, bars: o.bar + o.bars - nb }; }
      else patch = { bars: Math.max(MIN_EDIT_BARS, snapTo(o.bar + o.bars + delta, fine) - o.bar) };
      s.changeEdit(clip.id, d.id, patch, false);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.kind === 'edit' && d.moved) { s.isInteracting = false; s.changed(); return; }
      if (d.kind === 'select' && !d.moved) {
        // A click: nothing selected, and the mix jumps there (to listen from it).
        setSel(null); selectEdit(null);
        if (inMix) { const b = barAt(ev.clientX); s.previewBar(clip.id, b, 0); if (!s.isPlaying) s.pause(); }
      }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const hoverMove = (e: React.PointerEvent) => {
    if (drag.current) return;
    const h = hit(e.clientX);
    setHover(h?.id ?? null);
    (e.currentTarget as HTMLElement).style.cursor = !h ? 'crosshair' : h.part === 'move' ? 'grab' : 'ew-resize';
  };
  const wheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const k = zooms.indexOf(viewBars);
      const next = zooms[Math.max(0, Math.min(zooms.length - 1, k + (e.deltaY > 0 ? 1 : -1)))];
      const at = barAt(e.clientX);
      setViewBars(next);
      setViewStart(clampStart(at - (at - start) * next / viewBars, next));
    } else setViewStart(clampStart(start + (e.deltaY + e.deltaX) / canvasW.current * viewBars));
  };

  const makeLoop = () => { if (!sel) return; const nid = s.createEdit(clip.id, 'loop', sel[0], sel[1] - sel[0], repeats); if (nid) { setSel(null); selectEdit(nid); } };
  const makeJump = () => { if (!sel) return; const nid = s.createEdit(clip.id, 'jump', sel[0], sel[1] - sel[0]); if (nid) { setSel(null); selectEdit(nid); } };
  const removeEdit = (eid: string) => { s.removeEdit(clip.id, eid); selectEdit(null); };
  const change = (patch: Partial<ClipEdit>) => {
    if (!edit) return;
    if (!s.changeEdit(clip.id, edit.id, patch)) { s.alertMessage = L('そこには動かせません（曲の外か、ほかのループ／ジャンプと重なります）', 'Cannot go there (outside the track, or overlapping another loop / jump)'); s.changed(); }
  };
  const editMenu = (e: React.MouseEvent, ed: ClipEdit) => showContextMenu(e, [
    { label: L('ここから試聴', 'Preview from Here'), enabled: inMix, action: () => s.previewBar(clip.id, ed.bar) },
    ...(ed.kind === 'loop' ? [{ label: L('くり返し', 'Repeats'), submenu: repeatChoices.map(n => ({ label: `×${n + 1}`, checked: ed.repeats === n, action: () => s.changeEdit(clip.id, ed.id, { repeats: n }) })) }] : []),
    { label: L('長さを半分に', 'Halve the Length'), enabled: ed.bars / 2 >= MIN_EDIT_BARS, action: () => s.changeEdit(clip.id, ed.id, { bars: ed.bars / 2 }) },
    { label: L('長さを2倍に', 'Double the Length'), action: () => s.changeEdit(clip.id, ed.id, { bars: ed.bars * 2 }) },
    { separator: true },
    { label: L('削除', 'Delete'), action: () => removeEdit(ed.id) },
  ]);

  // Keys (while the panel has the focus).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (store.focusArea !== 'panel' || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.ctrlKey || e.metaKey) return;
      let handled = true;
      const k = e.key.toLowerCase();
      if (k === 'l' && sel) makeLoop();
      else if (k === 'j' && sel) makeJump();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && edit) removeEdit(edit.id);
      else if (e.key === 'Escape' && (sel || edit)) { setSel(null); selectEdit(null); }
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && edit) change({ bar: edit.bar + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : e.altKey ? MIN_EDIT_BARS : unit) });
      else if (e.key === '[' && edit && edit.bars / 2 >= MIN_EDIT_BARS) change({ bars: edit.bars / 2 });
      else if (e.key === ']' && edit) change({ bars: edit.bars * 2 });
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && edit?.kind === 'loop') change({ repeats: edit.repeats + (e.key === 'ArrowUp' ? 1 : -1) });
      else if (e.key === ' ' && !s.isPlaying && inMix && (edit || sel)) s.previewBar(clip.id, edit ? edit.bar : sel![0]);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  const loop = playBar != null ? activeLoop(clip, t, s.masterBPM) : null;
  const edits = [...(clip.edits ?? [])].sort((a, b) => a.bar - b.bar);
  return (
    <div className="loop-editor">
      <div className="loop-main">
        <div className="loop-bar">
          <span className="segmented" title={L('表示する長さ（Ctrl+ホイールでも変更）', 'How much to show (Ctrl+wheel too)')}>
            {zooms.map(z => <button key={z} className={viewBars === z ? 'on' : ''} onClick={() => { const c = start + viewBars / 2; setViewBars(z); setViewStart(clampStart(Math.floor(c - z / 2), z)); }}>{L(`${z}小節`, `${z} bars`)}</button>)}
          </span>
          <span className="dim">{L('単位', 'Snap')}</span>
          <span className="segmented" title={L('範囲やループの端を合わせる単位（Alt でいちばん細かく）', 'What ranges and loop edges snap to (Alt: finest)')}>
            {snaps.map(o => <button key={o.bars} className={snap === o.bars ? 'on' : ''} onClick={() => setSnap(o.bars)}>{o.label()}</button>)}
          </span>
          <div className="spacer" />
          {loop && <span className="loop-pass">⟲ {loop.pass}/{loop.of}</span>}
          <button className="btn small" disabled={!inMix} onClick={() => s.togglePlay()} title={L('ミックスを再生 / 停止（Space）', 'Play / pause the mix (Space)')}>{s.isPlaying ? '⏸' : '▶'}</button>
        </div>
        <canvas ref={ref} className="loop-canvas" onPointerDown={down} onPointerMove={hoverMove} onPointerLeave={() => setHover(null)} onWheel={wheel}
          onContextMenu={e => { e.preventDefault(); const h = hit(e.clientX); const ed = h && clip.edits!.find(x => x.id === h.id); if (ed) { selectEdit(ed.id); editMenu(e, ed); } else if (sel) showContextMenu(e, [{ label: L('ループにする', 'Make a Loop'), action: makeLoop }, { label: L('ジャンプにする（この範囲を飛ばす）', 'Make a Jump (skip this range)'), action: makeJump }]); }} />
        <div className="loop-hint caption">{L('波形の上をドラッグして範囲を選ぶ → L でループ、J でジャンプ。ループはドラッグで移動、端をドラッグで長さを変更（Alt で細かく）。[ ] で長さを半分／2倍、↑↓ でくり返し回数、← → で移動、Delete で削除。ホイールで左右に移動。', 'Drag across the waveform to choose a range → L makes a loop, J a jump. Drag a loop to move it, its edges to resize (Alt: fine). [ ] halve / double, ↑↓ repeats, ← → move, Delete removes. Scroll to pan.')}</div>
      </div>
      <div className="loop-side">
        {sel ? (
          <div className="loop-box">
            <div className="loop-box-title">{L('選んだ範囲', 'Selected Range')}</div>
            <div className="mono">{L(`${barLabel(sel[0])} 〜 ${barLabel(sel[1])}小節目（${lengthText(sel[1] - sel[0])}）`, `Bars ${barLabel(sel[0])}–${barLabel(sel[1])} (${lengthText(sel[1] - sel[0])})`)}</div>
            <div className="button-row">
              <select value={repeats} onChange={e => setRepeats(Number(e.target.value))} title={L('ループで鳴らす回数', 'How many times the loop plays')}>{repeatChoices.map(n => <option key={n} value={n}>{L(`×${n + 1}（${n}回くり返し）`, `×${n + 1} (${n} repeat${n > 1 ? 's' : ''})`)}</option>)}</select>
              <button className="btn primary" onClick={makeLoop}>⟲ {L('ループにする', 'Make Loop')} <span className="keycap">L</span></button>
            </div>
            <button className="btn" onClick={makeJump}>⇥ {L('ジャンプにする（この範囲を飛ばす）', 'Make Jump (skip this range)')} <span className="keycap">J</span></button>
            {inMix && <button className="btn small" onClick={() => s.previewBar(clip.id, sel[0])}>▶ {L('この範囲の少し前から試聴', 'Preview from just before')}</button>}
          </div>
        ) : edit ? (
          <div className="loop-box" style={{ ['--tile' as never]: edit.kind === 'loop' ? YELLOW : TEAL }}>
            <div className="loop-box-title">{edit.kind === 'loop' ? L('ループ', 'Loop') : L('ビートジャンプ', 'Beat Jump')}</div>
            <div className="irow"><span className="irow-label">{L('開始', 'Start')}</span>
              <span className="mono">{L(`${barLabel(edit.bar)}小節目`, `bar ${barLabel(edit.bar)}`)}</span>
              <span className="stepbtns"><button onClick={() => change({ bar: edit.bar - unit })}>‹</button><button onClick={() => change({ bar: edit.bar + unit })}>›</button></span></div>
            <div className="irow"><span className="irow-label">{L('長さ', 'Length')}</span>
              <span className="mono">{lengthText(edit.bars)}</span>
              <span className="stepbtns"><button title="[" disabled={edit.bars / 2 < MIN_EDIT_BARS} onClick={() => change({ bars: edit.bars / 2 })}>½</button><button title="]" onClick={() => change({ bars: edit.bars * 2 })}>×2</button><button onClick={() => change({ bars: Math.max(MIN_EDIT_BARS, edit.bars - unit) })}>−</button><button onClick={() => change({ bars: edit.bars + unit })}>＋</button></span></div>
            {edit.kind === 'loop' && <div className="irow"><span className="irow-label">{L('回数', 'Plays')}</span>
              <span className="mono">×{edit.repeats + 1}</span>
              <span className="stepbtns"><button onClick={() => change({ repeats: edit.repeats - 1 })}>−</button><button onClick={() => change({ repeats: edit.repeats + 1 })}>＋</button></span></div>}
            <div className="caption">{edit.kind === 'loop' ? L(`この曲が ${lengthText(edit.bars * edit.repeats)} 長くなり、後ろの曲はその分ずれます。`, `The track gets ${lengthText(edit.bars * edit.repeats)} longer; later tracks move along.`) : L(`この曲が ${lengthText(edit.bars)} 短くなります。`, `The track gets ${lengthText(edit.bars)} shorter.`)}</div>
            <div className="button-row">
              {inMix && <button className="btn small" onClick={() => s.previewBar(clip.id, edit.bar)}>▶ {L('試聴', 'Preview')}</button>}
              <button className="btn small" onClick={() => removeEdit(edit.id)}>{L('削除', 'Delete')}</button>
            </div>
          </div>
        ) : (
          <div className="loop-box empty">
            <div className="loop-box-title">{L('ループ・ジャンプ', 'Loops & Jumps')}</div>
            <div className="caption">{L('波形の上をドラッグして、ループにしたい範囲を選んでください。', 'Drag across the waveform to choose the range to loop.')}</div>
            {playBar != null && <button className="btn small" onClick={() => { const a = Math.floor(playBar / unit) * unit; setSel([a, Math.min(maxBar, a + Math.max(unit, 1))]); }}>{L('再生位置から1小節を選ぶ', 'Select 1 bar from the playhead')}</button>}
          </div>
        )}
        <div className="loop-list">
          {edits.length === 0 ? <span className="caption dim">{L('この曲にはまだループもジャンプもありません', 'No loops or jumps in this track yet')}</span>
            : edits.map(e => (
              <button key={e.id} className={'btn small loop-chip' + (e.id === editID ? ' on' : '')} style={{ ['--tile' as never]: e.kind === 'loop' ? YELLOW : TEAL }}
                onClick={() => { selectEdit(e.id); setSel(null); if (e.bar < start || e.bar + e.bars > start + viewBars) setViewStart(clampStart(Math.floor(e.bar + e.bars / 2 - viewBars / 2))); }}
                onContextMenu={ev => { ev.preventDefault(); selectEdit(e.id); editMenu(ev, e); }}>
                {e.kind === 'loop' ? '⟲' : '⇥'} {barLabel(e.bar)} · {lengthText(e.bars)}{e.kind === 'loop' ? ` ×${e.repeats + 1}` : ''}
              </button>
            ))}
          {edits.length > 1 && <button className="btn small" onClick={() => { s.removeAllEdits(clip.id); selectEdit(null); }}>{L('すべて解除', 'Clear All')}</button>}
        </div>
      </div>
    </div>
  );
}

void barSource;
