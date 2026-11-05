// Live preview of the video visuals, following playback — the same drawing as the video export, without exporting
// (mac/DJAW/Views/VisualPreviewView.swift). Opens in its own window so it can go on a second screen.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { L } from '../../core/i18n';
import { RenderSession } from '../../core/render/session';
import { LiveFeatures, VisualPainter, VisualStyle, VisualStyles, visualStyles } from '../../core/visuals';
import { store } from '../store/store';
import { useStore } from '../hooks';

/** Rebuilt only when the mix itself or the settings change, so the trails and the Auto VJ scenes carry on smoothly. */
function painterKey() {
  const s = store;
  return JSON.stringify([
    RenderSession.structureKey(s.clips, s.masterBPM),
    s.clips.map(c => [c.title, c.artist, c.colorIndex, c.lanes ?? null, c.transition]),
    s.gridOffset, s.visualStyle, s.visualShowInfo, s.artworkRevision, s.structures.size,
  ]);
}

function Preview({ win }: { win: Window }) {
  const s = useStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const live = new LiveFeatures();
    s.player.onTap = (mono, start) => live.feed(mono, start);
    void s.player.setTap(true);
    let painter: VisualPainter | null = null, key = '', raf = 0, lastDraw = 0;
    const draw = (now: number) => {
      raf = win.requestAnimationFrame(draw);
      if (now - lastDraw < 1000 / 31) return;
      lastDraw = now;
      const k = painterKey();
      const tempo = store.tempoMap;
      if (!painter || k !== key) {
        key = k;
        painter = new VisualPainter({ width: 960, height: 540, fps: 30, style: store.visualStyle, showTrackInfo: store.visualShowInfo, mixTitle: '' },
          store.previewTrackVisuals(), live, tempo, store.gridOffset, store.masterBPM);
      }
      const t = store.isPlaying ? store.player.currentTime : store.playhead;
      painter.draw(Math.trunc(tempo.real(t) * 30));
      const c = canvas.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      if (c.width !== 960) { c.width = 960; c.height = 540; }
      ctx.drawImage(painter.canvas, 0, 0);
    };
    raf = win.requestAnimationFrame(draw);
    return () => {
      win.cancelAnimationFrame(raf);
      void s.player.setTap(false);
      s.player.onTap = undefined;
    };
  }, [win]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000', color: '#ddd', font: '13px "Yu Gothic UI", "Segoe UI", system-ui, sans-serif' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <canvas ref={canvas} width={960} height={540} style={{ maxWidth: '100%', maxHeight: '100%', aspectRatio: '16 / 9' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, background: '#111' }}>
        <label>{L('映像', 'Visuals')}{' '}
          <select value={s.visualStyle} onChange={e => { s.visualStyle = e.target.value as VisualStyle; s.changed(); }} style={{ maxWidth: 380 }}>
            {visualStyles.map(v => <option key={v} value={v}>{VisualStyles.title(v)}</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={s.visualShowInfo} onChange={() => { s.visualShowInfo = !s.visualShowInfo; s.changed(); }} />{L('曲名カード', 'Track cards')}</label>
        <div style={{ flex: 1 }} />
        {!s.isPlaying && <span style={{ color: '#888', fontSize: 12 }}>{L('再生すると音に合わせて動きます', 'Plays along when you press Play')}</span>}
        <button onClick={() => s.togglePlay()} style={{ minWidth: 40 }}>{s.isPlaying ? '❚❚' : '▶'}</button>
      </div>
    </div>
  );
}

/** Opens the preview window while `store.showVisualPreview` is on (closing the window turns it off). */
export function VisualPreviewWindow() {
  const s = useStore();
  const [win, setWin] = useState<Window | null>(null);
  useEffect(() => {
    if (!s.showVisualPreview) return;
    const w = window.open('', 'djaw-visuals', 'width=960,height=600');
    if (!w) { s.showVisualPreview = false; s.changed(); return; }
    w.document.title = L('映像プレビュー', 'Visuals Preview');
    w.document.body.style.margin = '0';
    w.document.body.style.background = '#000';
    // Space plays / pauses there too.
    const key = (e: KeyboardEvent) => {
      if (e.key === ' ' && (e.target as HTMLElement | null)?.tagName !== 'SELECT') { e.preventDefault(); store.togglePlay(); }
      if (e.key === 'Escape') w.close();
    };
    w.addEventListener('keydown', key);
    const closed = () => { if (store.showVisualPreview) { store.showVisualPreview = false; store.changed(); } };
    w.addEventListener('beforeunload', closed);
    setWin(w);
    return () => {
      w.removeEventListener('beforeunload', closed);
      setWin(null);
      if (!w.closed) w.close();
    };
  }, [s.showVisualPreview]);
  if (!win || !s.showVisualPreview) return null;
  return createPortal(<Preview win={win} />, win.document.body);
}
