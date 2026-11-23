// Sets the IN / switch / OUT points and memo cues of one track while listening to it on its own
// (mac/DJAW/Views/CueEditorView.swift).
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { L } from '../../core/i18n';
import { Clip, Waveform, barAtSource, barLabel, barSource, cueList, keepsLanding, landingBar, rate, sourceTimeAtBar } from '../../core/models';
import { useStore } from '../hooks';
import { store } from '../store/store';
import { Player } from '../services/player';
import { Fmt, Theme, clipColor } from '../format';
import { showContextMenu } from './ContextMenu';
import { Structure, sectionTitle } from '../../core/analysis/structure';
import { ShownName } from '../../core/defaultNames';

/** Colours of the track's sections (the same as the Track tab's structure bar). */
export const sectionColors = { intro: 'rgba(255,255,255,0.28)', drop: 'rgb(255,159,10)', breakdown: 'rgb(64,200,224)', outro: 'rgba(255,255,255,0.16)' } as const;

/** The track's structure (intro / drop / break / outro) as a band, with the names where they fit. */
function drawSections(ctx: CanvasRenderingContext2D, clip: Clip, x: (s: number) => number, y: number, h: number, w: number, labels: boolean) {
  const st = store.structures.get(clip.url);
  if (!st) return;
  ctx.font = '700 9px system-ui'; ctx.textBaseline = 'middle';
  for (const sec of st.sections) {
    const a = Math.max(0, x(Structure.timeOfBar(st, sec.start))), b = Math.min(w, x(Structure.timeOfBar(st, sec.end)));
    if (b <= a) continue;
    ctx.fillStyle = sectionColors[sec.kind];
    ctx.globalAlpha = 0.85; ctx.fillRect(a, y, Math.max(1, b - a - 1), h); ctx.globalAlpha = 1;
    if (!labels) continue;
    const name = sectionTitle(sec.kind);
    if (ctx.measureText(name).width + 6 > b - a) continue;
    ctx.fillStyle = sec.kind === 'drop' || sec.kind === 'breakdown' ? '#000' : 'rgba(255,255,255,0.85)';
    ctx.fillText(name, a + 3, y + h / 2 + 0.5);
  }
}

const GREEN = 'rgb(48,209,88)', ORANGE = 'rgb(255,159,10)', PURPLE = 'rgb(191,90,242)', TEAL = 'rgb(64,200,224)';

// MARK: Single-track preview player

class CuePreview {
  private player = new Player();
  isPlaying = false;
  /** Position in source seconds. */
  position = 0;
  private rate = 1;
  private duration = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (f: () => void) => { this.listeners.add(f); return () => this.listeners.delete(f); };
  getVersion = () => this.version;
  private emit() { this.version++; for (const f of this.listeners) f(); }

  async play(clip: Clip, master: number, sync: boolean, from: number) {
    this.stopEngine();
    const pcm = store.pcmPaths.get(clip.url);
    if (!pcm) return;
    // The raw track, without edits, fades or effects.
    const c: Clip = { ...structuredClone(clip), start: 0, trimStart: 0, trimEnd: clip.duration, edits: null, fadeInBeats: 0, fadeOutBeats: 0, tempoSync: sync, fx: null };
    this.rate = rate(c, master);
    this.duration = clip.duration;
    const s = Math.min(Math.max(0, from), Math.max(0, clip.duration - 0.05));
    this.position = s;
    this.isPlaying = true;
    this.emit();
    await this.player.start({ clips: [c], master, tempo: { reference: master, points: [] }, gridOffset: 0, paths: { [clip.url]: pcm } }, s / this.rate);
    const tick = () => {
      if (!this.isPlaying) return;
      this.position = Math.min(this.player.currentTime * this.rate, this.duration);
      if (this.position >= this.duration) { this.pause(); return; }
      this.emit();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  pause() {
    if (!this.isPlaying) return;
    this.position = Math.min(this.player.currentTime * this.rate, this.duration);
    this.stopEngine();
    this.emit();
  }

  seek(s: number, clip: Clip, master: number, sync: boolean) {
    const v = Math.min(Math.max(0, s), clip.duration);
    if (this.isPlaying) this.play(clip, master, sync, v);
    else { this.position = v; this.emit(); }
  }

  setPosition(s: number) { this.position = s; this.emit(); }

  private stopEngine() { this.player.stop(); this.isPlaying = false; }
}

let shared: CuePreview | null = null;
const cuePreview = () => (shared ??= new CuePreview());

type Quantize = 'bar' | 'beat' | 'off';
const quantizeApply = (q: Quantize, bar: number) => (q === 'bar' ? Math.round(bar) : q === 'beat' ? Math.round(bar * 4) / 4 : bar);

// MARK: Waveform painting

export function drawWave(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }, wf: Waveform, s0: number, s1: number, color: string) {
  const width = Math.floor(rect.w);
  if (!(s1 > s0) || width <= 1 || !wf.peaks.length) return;
  const count = wf.peaks.length;
  const mid = rect.y + rect.h / 2, half = rect.h / 2 * 0.95, norm = 1 / (wf.maxPeak || 1);
  const tops: number[] = [], lows: number[] = [];
  for (let px = 0; px <= width; px++) {
    const a = s0 + (s1 - s0) * px / width, b = s0 + (s1 - s0) * (px + 1) / width;
    let b0 = Math.floor(a * wf.binsPerSecond), b1 = Math.floor(b * wf.binsPerSecond);
    if (b1 <= 0 || b0 >= count) { tops.push(0); lows.push(0); continue; }
    b0 = Math.max(0, b0); b1 = Math.min(count, Math.max(b0 + 1, b1));
    let p = 0, l = 0;
    for (let i = b0; i < b1; i++) { if (wf.peaks[i] > p) p = wf.peaks[i]; if (wf.lows[i] > l) l = wf.lows[i]; }
    tops.push(Math.min(1, p * norm) * half);
    lows.push(Math.min(1, l * norm) * half);
  }
  const fill = (v: number[], style: string) => {
    ctx.beginPath();
    ctx.moveTo(rect.x, mid - v[0]);
    for (let i = 1; i < v.length; i++) ctx.lineTo(rect.x + i, mid - v[i]);
    for (let i = v.length - 1; i >= 0; i--) ctx.lineTo(rect.x + i, mid + v[i]);
    ctx.closePath();
    ctx.fillStyle = style;
    ctx.fill();
  };
  ctx.save(); ctx.globalAlpha = 0.45; fill(tops, color); ctx.restore();
  fill(lows, color);
}

export function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
  });
  return ref;
}

// MARK: Overview (whole track)

function CueOverview({ clip, wf, position, outgoingBars, onSeek }: { clip: Clip; wf?: Waveform; position: number; outgoingBars: number | null; onSeek: (s: number) => void }) {
  const ref = useCanvas((ctx, w, h) => {
    const duration = Math.max(clip.duration, 0.1);
    const x = (s: number) => s / duration * w;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.roundRect(0, 0, w, h, 6); ctx.fill();
    if (wf) drawWave(ctx, { x: 0, y: 4, w, h: h - 8 }, wf, 0, duration, clipColor(clip.colorIndex));
    drawSections(ctx, clip, x, h - 22, 9, w, true);
    const sIn = Math.max(0, sourceTimeAtBar(clip, clip.mixInBar));
    const sOut = sourceTimeAtBar(clip, clip.mixOutBar);
    const sEnd = Math.min(duration, sourceTimeAtBar(clip, clip.mixOutBar + (outgoingBars ?? 0)));
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, x(sIn), h);
    if (outgoingBars != null) {
      ctx.fillRect(x(sEnd), 0, w - x(sEnd), h);
      ctx.fillStyle = ORANGE; ctx.fillRect(x(sOut), 0, Math.max(1, x(sEnd) - x(sOut)), 4);
    }
    if (clip.bpm > 0) {
      const barPx = x(barSource(clip));
      const step = barPx * 8 >= 40 ? 8 : 16;
      ctx.font = '8px ui-monospace, monospace'; ctx.textBaseline = 'middle';
      for (let b = Math.ceil(barAtSource(clip, 0) / step) * step; sourceTimeAtBar(clip, b) < duration; b += step) {
        const px = x(sourceTimeAtBar(clip, b));
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(px, h - 8, 1, 8);
        ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillText(barLabel(b), px + 2, h - 12);
      }
    }
    ctx.fillStyle = TEAL;
    for (const cue of cueList(clip)) ctx.fillRect(x(sourceTimeAtBar(clip, cue.bar)) - 0.5, 0, 1.5, h);
    const marker = (px: number, color: string, label: string) => {
      ctx.fillStyle = color; ctx.fillRect(px - 1, 0, 2, h);
      ctx.font = '700 9px system-ui'; ctx.textBaseline = 'middle'; ctx.fillText(label, px + 3, 7);
    };
    marker(x(sIn), GREEN, 'IN');
    if (keepsLanding(clip) || clip.transitionBars > 0.01) marker(x(sourceTimeAtBar(clip, landingBar(clip))), PURPLE, L('切替', 'SW'));
    marker(x(sOut), ORANGE, 'OUT');
    ctx.fillStyle = Theme.playhead; ctx.fillRect(x(position) - 1, 0, 2, h);
  });
  const pick = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * clip.duration);
  };
  return <canvas ref={ref} className="cue-overview" title={L('曲全体。クリック・ドラッグで移動', 'Whole track. Click or drag to jump')}
    onPointerDown={e => {
      pick(e.clientX);
      const move = (ev: PointerEvent) => pick(ev.clientX);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }} />;
}

// MARK: Detail (scrolling, playhead fixed in the centre)

function CueDetail({ clip, wf, position, outgoingBars, preview, onSeek, onResume }: {
  clip: Clip; wf?: Waveform; position: number; outgoingBars: number | null; preview: CuePreview; onSeek: (s: number) => void; onResume: (s: number) => void;
}) {
  const window_ = 16 * barSource(clip);
  const ref = useCanvas((ctx, w, h) => {
    const s0 = position - window_ / 2, s1 = position + window_ / 2;
    const x = (s: number) => (s - s0) / window_ * w;
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.roundRect(0, 0, w, h, 8); ctx.fill();
    const sIn = sourceTimeAtBar(clip, clip.mixInBar), sOut = sourceTimeAtBar(clip, clip.mixOutBar);
    if (clip.bpm > 0) {
      const beat = barSource(clip) / 4;
      ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'middle';
      for (let k = Math.ceil((s0 - clip.firstBeat) / beat); clip.firstBeat + k * beat < s1; k++) {
        const px = x(clip.firstBeat + k * beat);
        const isBar = ((k % 4) + 4) % 4 === 0;
        ctx.fillStyle = `rgba(255,255,255,${isBar ? 0.16 : 0.05})`; ctx.fillRect(px, 0, 1, h);
        if (isBar) { ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillText(barLabel(k / 4), px + 3, h - 9); }
      }
    }
    if (wf) drawWave(ctx, { x: 0, y: 18, w, h: h - 36 }, wf, s0, s1, clipColor(clip.colorIndex));
    drawSections(ctx, clip, x, h - 33, 12, w, true);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    if (sIn > s0) ctx.fillRect(0, 0, x(sIn), h);
    if (outgoingBars != null) {
      const sEnd = sourceTimeAtBar(clip, clip.mixOutBar + outgoingBars);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      if (sEnd < s1) ctx.fillRect(x(sEnd), 0, w - x(sEnd), h);
      if (outgoingBars > 0.01) { ctx.fillStyle = 'rgba(255,159,10,0.9)'; ctx.fillRect(x(sOut), 0, x(sEnd) - x(sOut), 5); }
    }
    const flag = (px: number, color: string, label: string) => {
      ctx.fillStyle = color; ctx.fillRect(px - 1, 0, 2, h);
      ctx.font = '600 10px system-ui';
      const tw = ctx.measureText(label).width;
      ctx.beginPath(); ctx.roundRect(px, 4, tw + 8, 16, 3); ctx.fill();
      ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.fillText(label, px + 4, 12);
    };
    for (const cue of cueList(clip)) flag(x(sourceTimeAtBar(clip, cue.bar)), TEAL, ShownName.cue(cue.label));
    flag(x(sIn), GREEN, 'IN ' + barLabel(clip.mixInBar));
    if (keepsLanding(clip) || clip.transitionBars > 0.01) {
      const sLand = sourceTimeAtBar(clip, landingBar(clip));
      if (clip.transitionBars > 0.01) { ctx.fillStyle = 'rgba(191,90,242,0.8)'; ctx.fillRect(x(sIn), h - 22, x(sLand) - x(sIn), 4); }
      flag(x(sLand), PURPLE, L('切替 ', 'SW ') + barLabel(landingBar(clip)));
    }
    flag(x(sOut), ORANGE, 'OUT ' + barLabel(clip.mixOutBar));
    ctx.fillStyle = Theme.playhead; ctx.fillRect(w / 2 - 1, 0, 2, h);
  });
  const down = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const start = position, wasPlaying = preview.isPlaying, x0 = e.clientX;
    preview.pause();
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) >= 3) moved = true;
      preview.setPosition(Math.min(Math.max(0, start - (ev.clientX - x0) / r.width * window_), clip.duration));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      // A click jumps to the clicked spot.
      const target = moved ? preview.position : start + (ev.clientX - r.left - r.width / 2) / r.width * window_;
      if (wasPlaying) onResume(target); else onSeek(target);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return <canvas ref={ref} className="cue-detail" onPointerDown={down} />;
}

// MARK: Tiles

function CueTile({ title, subtitle, keyName, color, value, info, onSet, onPlay, playLabel, onNudge, extra, disabled }: {
  title: string; subtitle: string; keyName: string; color: string; value: number; info: string | null; onSet: () => void; onPlay: () => void;
  playLabel?: string; onNudge: (d: number) => void; extra?: React.ReactNode; disabled?: boolean;
}) {
  return (
    <div className={'cue-tile' + (disabled ? ' disabled' : '')} style={{ ['--tile' as never]: color }} title={subtitle + (info ? '\n' + info : '')}>
      <div className="cue-tile-head">
        <span className="cue-tile-title">{title}</span>
        <span className="readout-num" style={{ color }}>{Fmt.barOrdinal(value)}</span>
      </div>
      <div className="cue-tile-row">
        <button className="btn small tinted" style={{ background: color }} onClick={onSet} title={L('再生位置にセット', 'Set at the playhead')}>◎ {L('セット', 'Set')} <span className="keycap">{keyName}</span></button>
        <button className="btn small" onClick={onPlay} title={playLabel ?? L('ここから試聴', 'Play from here')}>▶</button>
        <span className="stepbtns">
          <button title={L('1小節前へ', '1 bar earlier')} onClick={() => onNudge(-1)}>−1</button>
          <button title={L('1小節後ろへ', '1 bar later')} onClick={() => onNudge(1)}>+1</button>
          <button title={L('1拍前へ', '1 beat earlier')} onClick={() => onNudge(-0.25)}>‹</button>
          <button title={L('1拍後ろへ', '1 beat later')} onClick={() => onNudge(0.25)}>›</button>
        </span>
        {extra}
      </div>
      {info && <div className="caption cue-info">{info}</div>}
    </div>
  );
}

// MARK: Editor

/** IN / switch / OUT and memo cues of one track, heard on its own (the detail panel's CUE tab). */
export function CueEditor({ id }: { id: string }) {
  const s = useStore();
  const preview = cuePreview();
  useSyncExternalStore(preview.subscribe, preview.getVersion);
  const clipID = id;
  const [quantize, setQuantize] = useState<Quantize>('bar');
  const [sync, setSync] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const clip = s.clip(clipID);
  useEffect(() => {
    const c = s.clip(clipID);
    if (c) preview.setPosition(Math.max(0, sourceTimeAtBar(c, c.mixInBar)));
    return () => preview.pause();
  }, []);
  // The mix starting to play stops this track's own preview (never two at once).
  useEffect(() => store.subscribe(() => { if (store.isPlaying && preview.isPlaying) preview.pause(); }), []);

  const mixIndex = clip ? s.index(clip.id) : null;
  const next = mixIndex != null && mixIndex + 1 < s.clips.length ? s.clips[mixIndex + 1] : null;
  const prev = mixIndex != null && mixIndex > 0 ? s.clips[mixIndex - 1] : null;

  const play = (c: Clip, bar: number) => { s.pause(); preview.play(c, s.masterBPM, sync, Math.max(0, sourceTimeAtBar(c, bar))); };
  const jump = (c: Clip, bar: number) => preview.seek(Math.max(0, sourceTimeAtBar(c, bar)), c, s.masterBPM, sync);
  const posBar = (c: Clip) => barAtSource(c, preview.position);
  const moveBars = (c: Clip, bars: number) => jump(c, (quantize === 'off' ? posBar(c) : Math.round(posBar(c))) + bars);
  const togglePlay = (c: Clip) => { if (preview.isPlaying) preview.pause(); else { s.pause(); preview.play(c, s.masterBPM, sync, preview.position); } };
  const setIn = (c: Clip) => {
    const bar = quantizeApply(quantize, posBar(c));
    const idx = s.index(c.id);
    setNotice(bar >= c.mixOutBar && idx != null && idx + 1 < s.clips.length ? L('IN が OUT より後ろになっています。OUT も動かしてください。', 'IN is after OUT — move OUT as well.') : null);
    s.setMixIn(c.id, bar);
  };
  const setOut = (c: Clip) => {
    const bar = quantizeApply(quantize, posBar(c));
    if (bar <= c.mixInBar) { setNotice(L('OUT は IN より後ろに置いてください。', 'Put OUT after IN.')); return; }
    setNotice(null);
    s.setMixOut(c.id, bar);
  };
  const setLanding = (c: Clip) => { setNotice(null); s.setLandingBar(c.id, quantizeApply(quantize, posBar(c))); };
  const addMemo = (c: Clip) => s.addCue(c.id, quantizeApply(quantize, posBar(c)));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!clip || store.focusArea !== 'panel' || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      switch (e.key) {
        case 'ArrowLeft': moveBars(clip, e.shiftKey ? -4 : -1); break;
        case 'ArrowRight': moveBars(clip, e.shiftKey ? 4 : 1); break;
        case ' ': togglePlay(clip); break;
        default:
          switch (e.key.toLowerCase()) {
            case 'i': setIn(clip); break;
            case 'o': setOut(clip); break;
            case 'm': addMemo(clip); break;
            case 'l': setLanding(clip); break;
            default: handled = false;
          }
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  if (!clip) return null;
  const wf = s.waveforms.get(clip.url);
  const pb = posBar(clip);
  const beats = Math.floor(pb * 4 + 1e-6);
  const barBeat = `${Math.floor(beats / 4) + 1}.${((beats % 4) + 4) % 4 + 1}`;
  const memoMenu = (e: React.MouseEvent, bar: number, cueID?: string) => showContextMenu(e, [
    { label: L('ここから再生', 'Play from here'), action: () => play(clip, bar) },
    { separator: true },
    { label: L('IN にする', 'Use as IN'), action: () => s.setMixIn(clip.id, bar) },
    { label: L('切替完了にする', 'Use as switch point'), action: () => s.setLandingBar(clip.id, bar) },
    { label: L('OUT にする', 'Use as OUT'), action: () => s.setMixOut(clip.id, bar) },
    ...(cueID ? [{ separator: true }, { label: L('削除', 'Delete'), action: () => s.removeCue(clip.id, cueID) }] : []),
  ]);

  return (
    <div className="cue-embedded">
      <div className="cue-main">
        <CueOverview clip={clip} wf={wf} position={preview.position} outgoingBars={next ? next.transitionBars : null} onSeek={v => preview.seek(v, clip, s.masterBPM, sync)} />
        <CueDetail clip={clip} wf={wf} position={preview.position} outgoingBars={next ? next.transitionBars : null} preview={preview}
          onSeek={v => preview.seek(v, clip, s.masterBPM, sync)} onResume={v => preview.play(clip, s.masterBPM, sync, v)} />
        <div className="cue-transport">
          <div className="cue-pos">
            <span className="readout-main">{barBeat}</span>
            <span className="readout-sub">{Fmt.clock(preview.position)}</span>
          </div>
          <div className="cue-buttons">
            <button className="round" title={L('4小節戻る（Shift+←）', 'Back 4 bars (Shift+←)')} onClick={() => moveBars(clip, -4)}>⏪</button>
            <button className="round" title={L('1小節戻る（←）', 'Back 1 bar (←)')} onClick={() => moveBars(clip, -1)}>⏮</button>
            <button className={'round play' + (preview.isPlaying ? ' playing' : '')} title={L('この曲だけを再生 / 一時停止（Space）', 'Play this track alone / pause (Space)')} onClick={() => togglePlay(clip)}>{preview.isPlaying ? '⏸' : '▶'}</button>
            <button className="round" title={L('1小節進む（→）', 'Forward 1 bar (→)')} onClick={() => moveBars(clip, 1)}>⏭</button>
            <button className="round" title={L('4小節進む（Shift+→）', 'Forward 4 bars (Shift+→)')} onClick={() => moveBars(clip, 4)}>⏩</button>
          </div>
          <div className="cue-options">
            <span className="segmented" title={L('CUE を揃える単位', 'Snap cues to')}>{(['bar', 'beat', 'off'] as Quantize[]).map(q => <button key={q} className={quantize === q ? 'on' : ''} onClick={() => setQuantize(q)}>{q === 'bar' ? L('小節', 'Bar') : q === 'beat' ? L('拍', 'Beat') : L('オフ', 'Off')}</button>)}</span>
            <label className="check caption" title={L('ミックスのマスターBPMに合わせた速さで再生します', 'Play at the mix’s master BPM')}>
              <input type="checkbox" checked={sync} onChange={e => { setSync(e.target.checked); if (preview.isPlaying) preview.play(clip, s.masterBPM, e.target.checked, preview.position); }} />
              {L(`${Fmt.bpm(s.masterBPM)} BPM で`, `At ${Fmt.bpm(s.masterBPM)} BPM`)}
            </label>
          </div>
        </div>
      </div>
      <div className="cue-side">
        {notice && <div className="notice">⚠ {notice}</div>}
        <CueTile title={L('IN（入口）', 'IN')} subtitle={L('この曲が入り始める位置', 'Where this track starts')} keyName="I" color={GREEN} value={clip.mixInBar}
          info={prev ? L(`「${prev.title}」の OUT で入ります`, `Enters at the OUT of “${prev.title}”`) : null}
          onSet={() => setIn(clip)} onPlay={() => play(clip, clip.mixInBar)} onNudge={d => s.setMixIn(clip.id, clip.mixInBar + d)} />
        <CueTile title={L('切替完了', 'Switch')} subtitle={L('前の曲が消えて、この曲だけになる位置', 'Where only this track remains')} keyName="L" color={PURPLE} value={landingBar(clip)}
          disabled={!prev}
          info={!prev ? L('前の曲がないので使いません', 'Not used: there is no previous track')
            : clip.transitionBars > 0.01 ? L(`入口の ${Fmt.bars(clip.transitionBars)} 後`, `${Fmt.bars(clip.transitionBars)} after the mix-in`)
            : L('つなぎの長さを選ぶと入口が自動で決まります', 'Picking a length places the mix-in automatically')}
          onSet={() => setLanding(clip)} onPlay={() => play(clip, landingBar(clip))} onNudge={d => s.setLandingBar(clip.id, landingBar(clip) + d)}
          extra={<label className="check caption" title={L('つなぎの長さを変えてもこの位置を保つ', 'Keep this when the length changes')}><input type="checkbox" disabled={!prev} checked={keepsLanding(clip)} onChange={e => s.setLandingLock(clip.id, e.target.checked)} />{L('保つ', 'Keep')}</label>} />
        <CueTile title={L('OUT（出口）', 'OUT')} subtitle={L('次の曲へのつなぎが始まる位置', 'Where the next transition begins')} keyName="O" color={ORANGE} value={clip.mixOutBar}
          info={next ? (next.transitionBars < 0.01 ? L(`ここで「${next.title}」に切り替え`, `Switches to “${next.title}” here`) : L(`ここから「${next.title}」と ${Fmt.bars(next.transitionBars)} 重なる`, `Overlaps “${next.title}” for ${Fmt.bars(next.transitionBars)}`)) : null}
          onSet={() => setOut(clip)} onPlay={() => play(clip, clip.mixOutBar - 4)} playLabel={L('4小節前から', 'From −4 bars')} onNudge={d => s.setMixOut(clip.id, clip.mixOutBar + d)} />
        <div className="memo-strip">
          <button className="btn small" title={L('ドロップやブレイクの頭に目印を付けておくと、IN / OUT を選ぶ時に使えます', 'Mark drops and breakdowns to use them as IN / OUT later')} onClick={() => addMemo(clip)}>🔖 {L('メモ（M）', 'Memo (M)')}</button>
          {cueList(clip).map(cue => (
            <button key={cue.id} className="btn small memo" onClick={() => play(clip, cue.bar)} onContextMenu={e => { e.preventDefault(); memoMenu(e, cue.bar, cue.id); }}>
              {ShownName.cue(cue.label)} · {barLabel(cue.bar)} <span className="chev" onClick={e => { e.stopPropagation(); memoMenu(e, cue.bar, cue.id); }}>▾</span>
            </button>
          ))}
          <div className="spacer" />
          <button className="btn small" title={L('IN を曲の頭、OUT を曲の最後に戻します', 'Reset IN to the start and OUT to the end')} onClick={() => s.useWholeTrack(clip.id)}>↔ {L('曲全体', 'Whole track')}</button>
          {!s.isInMix(clip.id) && <button className="btn small primary" onClick={() => s.addToMix(clip.id)}>＋ {L('ミックスに入れる', 'Add to Mix')}</button>}
        </div>
      </div>
    </div>
  );
}
