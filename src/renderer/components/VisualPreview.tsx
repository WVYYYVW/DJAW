// Live preview of the video visuals, following playback — the same drawing as the video export, without exporting
// (mac/DJAW/Views/VisualPreviewView.swift). Opens in its own window so it can go on a second screen.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { L } from '../../core/i18n';
import { RenderSession } from '../../core/render/session';
import { LiveFeatures, VisualPainter, VisualStyle, VisualStyles, visualStyles } from '../../core/visuals';
import { store } from '../store/store';
import { useStore } from '../hooks';
import { TrackInfoOptions } from './TrackInfoOptions';

/** Rebuilt only when the mix itself or the settings change, so the trails and the Auto VJ scenes carry on smoothly. */
function painterKey() {
  const s = store;
  return JSON.stringify([
    RenderSession.structureKey(s.clips, s.masterBPM),
    s.clips.map(c => [c.title, c.artist, c.colorIndex, c.lanes ?? null, c.transition]),
    s.gridOffset, s.visualStyle, s.visualShowInfo, s.visualInfo, s.artworkRevision, s.structures.size,
  ]);
}

/** Full screen in the preview window (the HTML Fullscreen API: the same on Windows and the Mac). */
export function toggleFullScreen(win: Window) {
  const d = win.document;
  if (d.fullscreenElement) void d.exitFullscreen().catch(() => {});
  else void (d.getElementById('djaw-visuals-root') ?? d.documentElement).requestFullscreen().catch(() => {});
}

/**
 * Runs `f` on the preview window unless it is closed or closing: a window that has gone away throws ("illegal
 * access") on any use, and React's clean-ups can run just after it went.
 */
function onWindow(win: Window, f: () => void) {
  try { if (!win.closed) f(); } catch { /* the window has gone */ }
}

function Preview({ win }: { win: Window }) {
  const s = useStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [full, setFull] = useState(false);
  // In full screen: the picture at full HD, the controls hidden, the pointer hidden while it rests.
  const fullRef = useRef(false);
  useEffect(() => {
    const d = win.document;
    const change = () => { fullRef.current = !!d.fullscreenElement; setFull(!!d.fullscreenElement); };
    d.addEventListener('fullscreenchange', change);
    let idle = 0;
    const moved = () => { d.body.style.cursor = ''; win.clearTimeout(idle); if (fullRef.current) idle = win.setTimeout(() => { d.body.style.cursor = 'none'; }, 2000); };
    d.addEventListener('mousemove', moved);
    return () => onWindow(win, () => { d.removeEventListener('fullscreenchange', change); d.removeEventListener('mousemove', moved); win.clearTimeout(idle); });
  }, [win]);
  useEffect(() => {
    const live = new LiveFeatures();
    s.player.onTap = (mono, start) => live.feed(mono, start);
    void s.player.setTap(true);
    let painter: VisualPainter | null = null, key = '', raf = 0, lastFrame = -1, lastNow = 0, interval = 1000 / 60;
    const draw = (now: number) => {
      if (win.closed) return;
      raf = win.requestAnimationFrame(draw);
      // The screen's refresh interval (what is drawn now is seen at the next refresh).
      if (lastNow) interval += (Math.min(100, Math.max(4, now - lastNow)) - interval) * 0.1;
      lastNow = now;
      // Drawn at full HD when shown large (full screen, or the window maximized / enlarged), otherwise at half.
      const shown = canvas.current ? canvas.current.clientWidth * (win.devicePixelRatio || 1) : 0;
      const [W, H] = fullRef.current || shown > 1100 ? [1920, 1080] : [960, 540];
      const k = painterKey() + W;
      const tempo = store.tempoMap;
      let rebuilt = false;
      if (!painter || k !== key) {
        key = k; rebuilt = true;
        painter = new VisualPainter({ width: W, height: H, fps: 30, style: store.visualStyle, showTrackInfo: store.visualShowInfo, trackInfo: store.visualInfo, mixTitle: '' },
          store.previewTrackVisuals(), live, tempo, store.gridOffset, store.masterBPM);
      }
      // The picture for the moment it will be on the screen — one refresh after this one — and the nearest of the
      // 30 pictures a second (each is shown for the half picture before and after its moment), so it is in time with
      // the sound heard then (player.currentTime already takes off the audio output's delay).
      const t = store.isPlaying ? store.player.currentTime : store.playhead;
      const lead = store.isPlaying ? Math.min(0.05, interval / 1000) : 0;
      const f = Math.round((tempo.real(t) + lead) * 30);
      if (f === lastFrame && !rebuilt && canvas.current?.width === W) return;
      lastFrame = f;
      painter.draw(f);
      const c = canvas.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      if (c.width !== W) { c.width = W; c.height = H; }
      ctx.drawImage(painter.canvas, 0, 0);
    };
    raf = win.requestAnimationFrame(draw);
    return () => {
      onWindow(win, () => win.cancelAnimationFrame(raf));
      void s.player.setTap(false);
      s.player.onTap = undefined;
    };
  }, [win]);
  return (
    <div id="djaw-visuals-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000', color: '#ddd', font: '13px "Yu Gothic UI", "Segoe UI", system-ui, sans-serif' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onDoubleClick={() => toggleFullScreen(win)} title={full ? '' : L('ダブルクリックで全画面', 'Double-click for full screen')}>
        {/* Fills the window (also when it is maximized with the title bar's button), letterboxed at 16:9. */}
        <canvas ref={canvas} width={960} height={540} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
      </div>
      {!full && <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, background: '#111' }}>
        <label>{L('映像', 'Visuals')}{' '}
          <select value={s.visualStyle} onChange={e => { s.visualStyle = e.target.value as VisualStyle; s.changed(); }} style={{ maxWidth: 380 }}>
            {visualStyles.map(v => <option key={v} value={v}>{VisualStyles.title(v)}</option>)}
          </select>
        </label>
        <TrackInfoOptions compact />
        <div style={{ flex: 1 }} />
        {!s.isPlaying && <span style={{ color: '#888', fontSize: 12 }}>{L('再生すると音に合わせて動きます', 'Plays along when you press Play')}</span>}
        <button onClick={() => s.togglePlay()} style={{ minWidth: 40 }}>{s.isPlaying ? '❚❚' : '▶'}</button>
        <button onClick={() => toggleFullScreen(win)} title={L('全画面（F／F11・ダブルクリック。戻すときは Esc）', 'Full screen (F / F11 / double-click; Esc to leave)')}>{L('⛶ 全画面', '⛶ Full Screen')}</button>
      </div>}
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
    // F / F11: full screen. Escape leaves full screen first (Electron has no browser frame doing it), then closes the window.
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === ' ' && tag !== 'SELECT') { e.preventDefault(); store.togglePlay(); }
      if ((e.key === 'F11' || ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && tag !== 'SELECT')) && !e.repeat) { e.preventDefault(); toggleFullScreen(w); }
      if (e.key === 'Escape') { e.preventDefault(); if (w.document.fullscreenElement) void w.document.exitFullscreen().catch(() => {}); else w.close(); }
    };
    w.addEventListener('keydown', key);
    const closed = () => { if (store.showVisualPreview) { store.showVisualPreview = false; store.changed(); } };
    w.addEventListener('beforeunload', closed);
    setWin(w);
    return () => {
      onWindow(w, () => w.removeEventListener('beforeunload', closed));
      setWin(null);
      // Closed after React has taken the picture out of it (the clean-ups above still use the window).
      setTimeout(() => { if (!store.showVisualPreview) onWindow(w, () => w.close()); }, 0);
    };
  }, [s.showVisualPreview]);
  if (!win || !s.showVisualPreview) return null;
  return createPortal(<Preview win={win} />, win.document.body);
}
