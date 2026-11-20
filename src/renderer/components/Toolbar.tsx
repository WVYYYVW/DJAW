import React, { useEffect, useRef, useState } from 'react';
import { L } from '../../core/i18n';
import { Snap, snapUnits, clipEnd } from '../../core/models';
import { useStore, usePlayhead } from '../hooks';
import { CloudChip } from './CloudSheet';
import { store } from '../store/store';
import { Fmt, Theme, clipColor } from '../format';
import { Icon, IconName } from './Icons';

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

function Toggle({ on, onClick, children, title, disabled, icon }: { on: boolean; onClick: () => void; children?: React.ReactNode; title?: string; disabled?: boolean; icon?: IconName }) {
  return <button className={'tbtn toggle' + (on ? ' on' : '') + (children ? '' : ' icon')} onClick={onClick} title={title} disabled={disabled}>{icon && <Icon name={icon} />}{children}</button>;
}

function Action({ icon, label, title, onClick, disabled, primary }: { icon: IconName; label: string; title: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return <button className={'tbtn action' + (primary ? ' primary' : '')} onClick={onClick} disabled={disabled} title={title}><Icon name={icon} /><span className="action-label">{label}</span></button>;
}

/** The bar at the top: file and title on the left, transport in the middle, views and output on the right. */
export function Toolbar() {
  const s = useStore();
  return (
    <div className="toolbar">
      <div className="tb-side tb-left">
      <Toggle icon="browser" on={s.showBrowser} onClick={() => s.toggle('showBrowser')} title={L('ブラウザ（ミックス順・ライブラリ）の表示切替（Ctrl+Alt+B）', 'Show or hide the browser (Ctrl+Alt+B)')} />
      <div className="doc-title" title={s.documentPath ?? ''}>
        <span className="brand">DJAW</span>
        <span className="doc-name">{s.documentTitle}</span>{s.isDirty && !s.isCloudDocument() ? <span className="edited" title={L('保存されていない変更があります', 'Unsaved changes')}>●</span> : null}<CloudChip />
      </div>
      </div>
      <div className="transport">
        <button className="tbtn icon" onClick={() => { s.seek(0); s.requestScroll(0); }} title={L('先頭へ（Home）', 'Go to start (Home)')}><Icon name="toStart" /></button>
        <button className={'tbtn icon play' + (s.isPlaying ? ' playing' : '')} onClick={() => s.togglePlay()} disabled={!s.clips.length} title={L('再生 / 一時停止（Space）', 'Play / pause (Space)')}><Icon name={s.isPlaying ? 'pause' : 'play'} /></button>
        <TimeReadout />
        <MasterBPMField />
        <select className="tselect" value={s.snap} onChange={e => s.setSnap(e.target.value as never)} title={L('タイムラインでドラッグした時に動く単位（Alt で1拍単位）', 'How far things move when dragging (hold Alt for 1 beat)')}>
          {snapUnits.map(u => <option key={u} value={u}>{Snap.title(u)}</option>)}
        </select>
      </div>
      <div className="tb-side tb-right">
      {s.updateStatus && <span className="update-chip" title={s.updateStatus.ready ? L('DJAW を終了するときに更新されます（メニューの「アップデートを確認…」から今すぐ再起動もできます）', 'Installs when DJAW quits (or restart now from “Check for Updates…”)') : ''}>
        {s.updateStatus.ready ? L(`${s.updateStatus.version} を準備しました`, `${s.updateStatus.version} ready`) : L(`${s.updateStatus.version} をダウンロード中 ${Math.round(s.updateStatus.progress * 100)}%`, `Downloading ${s.updateStatus.version} ${Math.round(s.updateStatus.progress * 100)}%`)}
      </span>}
      <div className="group">
        <Action icon="film" label={L('映像', 'Visuals')} title={L('映像プレビュー：書き出す映像を、再生に合わせてその場で確認（Ctrl+Alt+V）', 'Visuals preview: see the video visuals live with playback (Ctrl+Alt+V)')} onClick={() => { s.showVisualPreview = true; s.changed(); }} />
        <Action icon="cloud" label={L('クラウド', 'Cloud')} title={L('クラウド（MEGA）：Windows と Mac でミックスを共有（Ctrl+Shift+O）', 'Cloud (MEGA): share mixes between Windows and Mac (Ctrl+Shift+O)')} onClick={() => { s.showCloud = true; s.changed(); }} />
        <Action icon="list" label={L('演奏手順', 'How to Play')} disabled={!s.clips.length} title={L('このセットを DJ 機材で実際に演奏する手順と、曲リスト（SoundCloud の概要用）（Ctrl+Shift+P）', 'Steps to play this set live on DJ gear, and the track list (for SoundCloud descriptions) (Ctrl+Shift+P)')} onClick={() => { s.showPerformanceGuide = true; s.changed(); }} />
        <Action icon="export" label={L('書き出し', 'Export')} primary disabled={!s.clips.length} title={L('ミックスを書き出し（Ctrl+E）', 'Export the mix (Ctrl+E)')} onClick={() => { s.showExport = true; s.changed(); }} />
      </div>
      <div className="vsep" />
      <Toggle icon="panel" on={s.showPanel} onClick={() => s.toggle('showPanel')} title={L('下の詳細パネル（つなぎ・CUE・ループ・FX・サンプラー・デッキ）の表示切替（Ctrl+Alt+I）', 'Show or hide the detail panel (Ctrl+Alt+I)')} />
      </div>
    </div>
  );
}

/** The strip above the arrangement: the whole-mix overview, zoom and follow. */
export function ArrangementBar() {
  const s = useStore();
  return (
    <div className="arrange-bar">
      <button className="tbtn small add" onClick={() => s.presentAddFiles()} title={L('曲を追加（Ctrl+Shift+I）— ファイルやフォルダをドロップしても追加できます', 'Add tracks (Ctrl+Shift+I) — you can also drop files or folders')}><Icon name="plus" size={14} />{L('曲を追加', 'Add Tracks')}</button>
      <Overview />
      <div className="group">
        <button className="tbtn icon small" onClick={() => s.zoom(1 / 1.4)} title={L('縮小（Ctrl+−）', 'Zoom out (Ctrl+−)')}><Icon name="zoomOut" size={15} /></button>
        <button className="tbtn icon small" onClick={() => s.zoomToFit()} title={L('全体を表示（Ctrl+0）', 'Show whole mix (Ctrl+0)')}><Icon name="fit" size={15} /></button>
        <button className="tbtn icon small" onClick={() => s.zoom(1.4)} title={L('拡大（Ctrl+＋）', 'Zoom in (Ctrl+＋)')}><Icon name="zoomIn" size={15} /></button>
      </div>
      <Toggle icon="wave" on={s.showMixWaveform} onClick={() => s.toggle('showMixWaveform')} title={L('MIX レーン：書き出しと同じ処理で作った最終的な波形', 'MIX lane: the final waveform, rendered exactly like an export')} />
      <Toggle icon="follow" on={s.followPlayhead} onClick={() => s.toggle('followPlayhead')} title={L('再生中に表示を再生位置に追従させる', 'Keep the playhead in view while playing')} />
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
