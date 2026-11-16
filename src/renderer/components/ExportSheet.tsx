// Export the mix as audio (WAV / M4A) or as an MP4 with visuals (mac/DJAW/Views/ExportSheet.swift).
import React, { useEffect, useState } from 'react';
import { L } from '../../core/i18n';
import { useStore } from '../hooks';
import { Fmt } from '../format';
import { VisualStyles, visualStyles, VisualStyle } from '../../core/visuals';
import type { VideoSize } from '../store/video';
import { Mp4Writer } from '../../core/render/mp4';

function durationText(t: number) {
  const s = Math.round(t);
  if (s < 60) return L(`${s}秒`, `${s} s`);
  if (s < 3600) return L(`${Math.floor(s / 60)}分${s % 60}秒`, `${Math.floor(s / 60)} min ${s % 60} s`);
  return L(`${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`, `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);
}

/** Whether the GPU draws and encodes (Chromium's feature status + whether the GPU's H.264 encoder takes this size). */
function GPUStatus() {
  const s = useStore();
  const [hw, setHW] = useState<boolean | null>(null);
  useEffect(() => { void s.loadGPUStatus(); }, []);
  useEffect(() => {
    const [w, h] = s.videoSize.split('x').map(Number);
    let live = true;
    setHW(null);
    void Mp4Writer.hardwareVideoSupported({ width: w, height: h, fps: 30, bitrate: w * h >= 1920 * 1080 ? 14_000_000 : 8_000_000 }).then(v => { if (live) setHW(v); });
    return () => { live = false; };
  }, [s.videoSize]);
  const f = s.gpuStatus?.features ?? {};
  const on = (k: string) => (f[k] ?? '').startsWith('enabled');
  const draw = on('2d_canvas') && on('gpu_compositing');
  const name = s.gpuStatus?.devices[0];
  return (
    <div className="gpu-status">
      <span className="gpu-title">GPU{name ? `：${name}` : ''}</span>
      <span className={draw ? 'ok' : 'warn-text'}>{draw ? '✓' : '✕'} {L('映像の描画', 'Drawing')}</span>
      <span className={hw ? 'ok' : hw === false ? 'warn-text' : 'dim'}>{hw == null ? '…' : hw ? '✓' : '✕'} {L('映像のエンコード', 'Encoding')}{hw === false ? L('（ソフトウェアで処理）', ' (software)') : ''}</span>
      {s.gpuStatus && !draw && <span className="dim">{L('GPU が使えないため CPU で描画します（時間がかかります）。グラフィックドライバの更新で使えるようになることがあります。', 'The GPU is not available, so drawing runs on the CPU (slower). Updating the graphics driver may help.')}</span>}
    </div>
  );
}

function VideoOptions() {
  const s = useStore();
  const sizes: [VideoSize, string][] = [['1920x1080', '1920×1080（HD）'], ['1280x720', '1280×720'], ['1080x1920', L('1080×1920（縦・SNS）', '1080×1920 (vertical)')]];
  return <>
    <div className="form-row"><span className="form-label">{L('映像', 'Visuals')}</span>
      <select value={s.visualStyle} onChange={e => { s.visualStyle = e.target.value as VisualStyle; s.changed(); }}>
        {visualStyles.map(v => <option key={v} value={v}>{VisualStyles.title(v)}</option>)}
      </select></div>
    <div className="form-row"><span className="form-label">{L('サイズ', 'Size')}</span>
      <select value={s.videoSize} onChange={e => { s.videoSize = e.target.value as VideoSize; s.changed(); }}>
        {sizes.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select></div>
    <label className="check"><input type="checkbox" checked={s.visualShowInfo} onChange={() => { s.visualShowInfo = !s.visualShowInfo; s.changed(); }} />{L('曲が変わるたびにジャケット・曲名・アーティストを表示', 'Show artwork, title and artist when each track starts')}</label>
    <label className="check"><input type="checkbox" checked={s.visualShowTitle} onChange={() => { s.visualShowTitle = !s.visualShowTitle; s.changed(); }} />{L('最初にミックス名を表示', 'Show the mix name at the start')}</label>
    <GPUStatus />
    <div className="caption">{L('映像は曲の音（スペクトラム・低音のキック）とビートのグリッドに合わせて動き、色は各曲の色、中央やカードには「曲の情報」で設定したジャケットを使います。音声は AAC 320kbps で入ります。', 'The visuals follow the mix’s spectrum, kicks and beat grid, use each track’s colour, and show the artwork set in Track Info. Audio is AAC 320 kbps.')}</div>
  </>;
}

export function ExportSheet() {
  const s = useStore();
  const [, tick] = useState(0);
  const phase = s.exportPhase;
  useEffect(() => {
    if (phase.kind !== 'rendering') return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [phase.kind]);
  const close = () => {
    if (phase.kind === 'rendering') return;
    s.exportPhase = { kind: 'idle' };
    s.showExport = false;
    s.changed();
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); e.stopPropagation(); }
      if (e.key === 'Enter' && phase.kind === 'idle' && s.clips.length) { (s.exportVideo ? s.startVideoExport() : s.startExport(s.exportNormalize)); e.stopPropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  const remaining = () => {
    const elapsed = (Date.now() - s.exportStartedAt) / 1000;
    const head = L(`経過 ${durationText(elapsed)}`, `elapsed ${durationText(elapsed)}`);
    const r = s.exportRemaining;
    if (!s.exportSteady) return head + L('・準備中…', ' · preparing…');
    if (r == null) return head + L('・残り時間を計算中…', ' · estimating…');
    // In steps (5 s, or 10 s above a minute) so it doesn't jitter.
    const step = r > 60 ? 10 : 5;
    return head + L(`・残り 約${durationText(Math.ceil(r / step) * step)}`, ` · about ${durationText(Math.ceil(r / step) * step)} left`);
  };
  return (
    <div className="sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet export-sheet">
        <div className="sheet-head">
          <span className="sheet-icon">⇪</span>
          <div>
            <div className="sheet-title">{L('ミックスを書き出し', 'Export Mix')}</div>
            <div className="dim mono">{L(`${s.clips.length}曲 · ${Fmt.duration(s.realMixDuration)} · ${Fmt.bpm(s.masterBPM)} BPM`, `${s.clips.length} tracks · ${Fmt.duration(s.realMixDuration)} · ${Fmt.bpm(s.masterBPM)} BPM`)}</div>
          </div>
        </div>
        {phase.kind === 'idle' && (
          <div className="form">
            <div className="form-row"><span className="form-label">{L('書き出すもの', 'Export')}</span><span className="segmented">
              <button className={!s.exportVideo ? 'on' : ''} onClick={() => { s.exportVideo = false; s.changed(); }}>{L('音声のみ', 'Audio only')}</button>
              <button className={s.exportVideo ? 'on' : ''} onClick={() => { s.exportVideo = true; s.changed(); }}>{L('映像付き（MP4）', 'With visuals (MP4)')}</button>
            </span></div>
            {s.exportVideo ? <VideoOptions /> : (
              <div className="form-row"><span className="form-label">{L('形式', 'Format')}</span><span className="segmented">
                <button className={s.exportFormat === 'wav24' ? 'on' : ''} onClick={() => { s.exportFormat = 'wav24'; s.changed(); }}>{L('WAV（24bit）', 'WAV (24-bit)')}</button>
                <button className={s.exportFormat === 'aac256' ? 'on' : ''} onClick={() => { s.exportFormat = 'aac256'; s.changed(); }}>{L('M4A（AAC 256kbps）', 'M4A (AAC 256 kbps)')}</button>
              </span></div>
            )}
            <div className="form-row"><span className="form-label">{L('サンプルレート', 'Sample Rate')}</span><span className="segmented">
              {[44100, 48000].map(r => <button key={r} className={s.exportSampleRate === r ? 'on' : ''} onClick={() => { s.exportSampleRate = r; s.changed(); }}>{r === 44100 ? '44.1 kHz' : '48 kHz'}</button>)}
            </span></div>
            <label className="check"><input type="checkbox" checked={s.exportNormalize} onChange={() => s.toggle('exportNormalize')} />{L('音割れ防止（ピークを −1 dB に正規化）', 'Prevent clipping (normalize peaks to −1 dB)')}</label>
            <div className="caption">{L('正規化をオンにすると、音量の確認のため2回処理するので少し時間がかかります（ミックス波形ができていれば1回で済みます）。', 'With normalization on, the mix is rendered twice to measure the level, so it takes a little longer (once, if the mix waveform is ready).')}</div>
          </div>
        )}
        {phase.kind === 'rendering' && (
          <div className="progress-block">
            <progress value={phase.progress} max={1} />
            <div className="button-row dim mono"><span>{L(`書き出し中… ${Math.floor(phase.progress * 100)}%`, `Exporting… ${Math.floor(phase.progress * 100)}%`)}</span><div className="spacer" /><span>{remaining()}</span></div>
          </div>
        )}
        {phase.kind === 'done' && <div className="ok">✓ {L(`書き出しが完了しました：${phase.path.split(/[\\/]/).pop()}`, `Export finished: ${phase.path.split(/[\\/]/).pop()}`)}</div>}
        {phase.kind === 'done' && s.lastVideoStats && s.lastVideoStats.total > 0 && (
          <div className="dim mono small">{L(`かかった時間 ${durationText(s.lastVideoStats.total)}（曲の長さの ${(s.lastVideoStats.total / Math.max(1, s.lastVideoStats.seconds)).toFixed(2)} 倍）・1コマ ${((s.lastVideoStats.draw + s.lastVideoStats.frame) / Math.max(1, s.lastVideoStats.frames) * 1000).toFixed(1)}ms・エンコード ${s.lastVideoStats.hardware ? 'GPU' : 'CPU'}`, `Took ${durationText(s.lastVideoStats.total)} (${(s.lastVideoStats.total / Math.max(1, s.lastVideoStats.seconds)).toFixed(2)}× the mix length) · ${((s.lastVideoStats.draw + s.lastVideoStats.frame) / Math.max(1, s.lastVideoStats.frames) * 1000).toFixed(1)} ms per frame · encoded on the ${s.lastVideoStats.hardware ? 'GPU' : 'CPU'}`)}</div>
        )}
        {phase.kind === 'failed' && <div className="err">✕ {phase.message}</div>}
        <div className="button-row end">
          {phase.kind === 'idle' && <>
            <button className="btn" onClick={close}>{L('キャンセル', 'Cancel')}</button>
            <button className="btn primary" disabled={!s.clips.length} onClick={() => (s.exportVideo ? s.startVideoExport() : s.startExport(s.exportNormalize))}>{L('書き出す…', 'Export…')}</button>
          </>}
          {phase.kind === 'rendering' && <button className="btn" onClick={() => s.cancelExport()}>{L('中止', 'Cancel')}</button>}
          {phase.kind === 'done' && <>
            <button className="btn" onClick={() => s.revealPath(phase.path)}>{L('エクスプローラーで表示', 'Show in Explorer')}</button>
            <button className="btn primary" onClick={close}>{L('閉じる', 'Close')}</button>
          </>}
          {phase.kind === 'failed' && <button className="btn primary" onClick={close}>{L('閉じる', 'Close')}</button>}
        </div>
      </div>
    </div>
  );
}
