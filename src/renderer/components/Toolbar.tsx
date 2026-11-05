import React, { useEffect, useRef, useState } from 'react';
import { L } from '../../core/i18n';
import { Snap, snapUnits, clipEnd } from '../../core/models';
import { useStore, usePlayhead } from '../hooks';
import { store } from '../store/store';
import { Fmt, Theme, clipColor } from '../format';

export function TimeReadout() {
  const t = usePlayhead(33);
  const s = useStore();
  const p = s.grid.position(t);
  return (
    <div className="readout" title={L('再生位置（時間 / ミックス全体の小節.拍）', 'Playhead (time / bar.beat of the mix)')}>
      <div className="readout-main">{Fmt.clock(s.tempoMap.real(t))}</div>
      <div className="readout-sub">{L(`小節 ${p.bar}.${p.beat}`, `Bar ${p.bar}.${p.beat}`)}</div>
    </div>
  );
}

export function NumberField({ value, onCommit, width = 64, step = 1, min, max, digits = 2, title }: {
  value: number; onCommit: (v: number) => void; width?: number; step?: number; min?: number; max?: number; digits?: number; title?: string;
}) {
  const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, ''));
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(fmt(value)); }, [value]);
  const commit = () => {
    const v = parseFloat(text.replace(',', '.'));
    if (Number.isFinite(v)) onCommit(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
    else setText(fmt(value));
  };
  return (
    <span className="numfield" title={title}>
      <input style={{ width }} value={text} onChange={e => setText(e.target.value)}
        onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; commit(); }}
        onKeyDown={e => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }} />
      <span className="stepper">
        <button tabIndex={-1} onClick={() => onCommit(Math.min(max ?? Infinity, value + step))}>▴</button>
        <button tabIndex={-1} onClick={() => onCommit(Math.max(min ?? -Infinity, value - step))}>▾</button>
      </span>
    </span>
  );
}

function MasterBPMField() {
  const s = useStore();
  const t = usePlayhead(250);
  const map = s.tempoMap;
  const changes = map.hasChanges;
  const value = changes ? Math.round(map.bpm(t) * 100) / 100 : s.masterBPM;
  return (
    <span className="bpmfield" title={changes ? L('再生位置でのミックスBPM。途中でテンポが変わるミックスでは、いまの区間のテンポを変更します', 'Mix BPM at the playhead. In a mix with tempo changes, this edits the current section') : L('ミックスBPM — テンポを合わせた曲はこの速さで再生されます', 'Mix BPM — synced tracks play at this tempo')}>
      <span className="label" style={{ color: changes ? Theme.accent : undefined }}>BPM</span>
      <NumberField value={value} min={40} max={220} onCommit={v => store.setTempoAtTime(store.playhead, v)} />
    </span>
  );
}

function Toggle({ on, onClick, children, title, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string; disabled?: boolean }) {
  return <button className={'tbtn toggle' + (on ? ' on' : '')} onClick={onClick} title={title} disabled={disabled}>{children}</button>;
}

export function Toolbar() {
  const s = useStore();
  return (
    <div className="toolbar">
      <button className="tbtn" onClick={() => s.presentAddFiles()} title={L('曲を追加（Ctrl+Shift+I）— ファイルやフォルダをドロップしても追加できます', 'Add tracks (Ctrl+Shift+I) — you can also drop files or folders')}>＋ {L('曲を追加', 'Add Tracks')}</button>
      <div className="doc-title">{s.documentTitle}{s.isDirty ? <span className="edited"> — {L('編集済み', 'Edited')}</span> : null}</div>
      <div className="transport">
        <button className="tbtn icon" onClick={() => { s.seek(0); s.requestScroll(0); }} title={L('先頭へ（Home）', 'Go to start (Home)')}>⏮</button>
        <button className="tbtn icon play" onClick={() => s.togglePlay()} disabled={!s.clips.length} title={L('再生 / 一時停止（Space）', 'Play / pause (Space)')}>{s.isPlaying ? '⏸' : '▶'}</button>
        <TimeReadout />
        <div className="vsep" />
        <MasterBPMField />
      </div>
      <div className="spacer" />
      <select className="tselect" value={s.snap} onChange={e => s.setSnap(e.target.value as never)} title={L('タイムラインでドラッグした時に動く単位（Alt で1拍単位）', 'How far things move when dragging (hold Alt for 1 beat)')}>
        {snapUnits.map(u => <option key={u} value={u}>{L('単位: ', 'Step: ') + Snap.title(u)}</option>)}
      </select>
      <div className="group">
        <button className="tbtn icon" onClick={() => s.zoom(1 / 1.4)} title={L('縮小（Ctrl+−）', 'Zoom out (Ctrl+−)')}>－</button>
        <button className="tbtn icon" onClick={() => s.zoomToFit()} title={L('全体を表示（Ctrl+0）', 'Show whole mix (Ctrl+0)')}>↔</button>
        <button className="tbtn icon" onClick={() => s.zoom(1.4)} title={L('拡大（Ctrl+＋）', 'Zoom in (Ctrl+＋)')}>＋</button>
      </div>
      <Toggle on={s.showDecks} onClick={() => s.toggle('showDecks')} title={L('ターンテーブルとミキサーの表示', 'Show turntables and mixer')}>{L('デッキ', 'Decks')}</Toggle>
      <Toggle on={s.showMixer} disabled={!s.showDecks} onClick={() => s.toggle('showMixer')} title={L('デッキの間のミキサーの表示 / 非表示', 'Show or hide the mixer')}>{L('ミキサー', 'Mixer')}</Toggle>
      <Toggle on={s.followPlayhead} onClick={() => s.toggle('followPlayhead')} title={L('再生中に表示を再生位置に追従させる', 'Keep the playhead in view while playing')}>{L('追従', 'Follow')}</Toggle>
      <button className="tbtn" disabled={!s.clips.length} onClick={() => { s.showExport = true; s.changed(); }} title={L('ミックスを書き出し（Ctrl+E）', 'Export the mix (Ctrl+E)')}>⇪ {L('書き出し', 'Export')}</button>
      <Toggle on={s.showInspector} onClick={() => s.toggle('showInspector')} title={L('インスペクタの表示切替（Ctrl+Alt+I）', 'Show or hide the inspector (Ctrl+Alt+I)')}>▥</Toggle>
    </div>
  );
}

/** Whole-mix overview. Click or drag to jump the timeline there. */
export function Overview() {
  const s = useStore();
  const ref = useRef<HTMLCanvasElement>(null);
  const t = usePlayhead(50);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = Theme.rulerBG;
    ctx.fillRect(0, 0, w, h);
    const inset = 10, width = Math.max(1, w - inset * 2);
    const duration = Math.max(s.mixDuration, 1);
    const x = (v: number) => inset + v / duration * width;
    if (!s.clips.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(L('ミックス全体マップ', 'Mix overview'), w / 2, h / 2 + 4);
      return;
    }
    const laneH = (h - 14) / 2;
    s.clips.forEach((clip, i) => {
      const x0 = x(clip.start);
      ctx.fillStyle = clipColor(clip.colorIndex, clip.id === s.selectedClipID ? 0.95 : 0.55);
      ctx.beginPath(); ctx.roundRect(x0, 7 + (i % 2) * laneH, Math.max(2, x(clipEnd(clip, s.masterBPM)) - x0), laneH - 2, 3); ctx.fill();
    });
    const [a, b] = s.visibleRange;
    ctx.beginPath(); ctx.roundRect(x(a), 2, Math.max(4, x(Math.min(b, duration)) - x(a)), h - 4, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = Theme.playhead;
    ctx.fillRect(x(t) - 0.75, 0, 1.5, h);
  });
  const jump = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const v = (e.clientX - r.left - 10) / Math.max(1, r.width - 20) * Math.max(s.mixDuration, 1);
    s.requestScroll(Math.max(0, v));
  };
  return <canvas ref={ref} className="overview" onMouseDown={e => { jump(e); const move = (ev: MouseEvent) => jump(ev as unknown as React.MouseEvent); const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }} />;
}
