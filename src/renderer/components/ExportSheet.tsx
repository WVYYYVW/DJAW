// Export the mix as a WAV file (mac/DJAW/Views/ExportSheet.swift; audio only for now).
import React, { useEffect, useState } from 'react';
import { L } from '../../core/i18n';
import { useStore } from '../hooks';
import { Fmt } from '../format';

function durationText(t: number) {
  const s = Math.round(t);
  if (s < 60) return L(`${s}秒`, `${s} s`);
  if (s < 3600) return L(`${Math.floor(s / 60)}分${s % 60}秒`, `${Math.floor(s / 60)} min ${s % 60} s`);
  return L(`${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`, `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);
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
      if (e.key === 'Enter' && phase.kind === 'idle' && s.clips.length) { s.startExport(s.exportNormalize); e.stopPropagation(); }
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
            <div className="form-row"><span className="form-label">{L('形式', 'Format')}</span><span className="segmented"><button className="on">{L('WAV（24bit）', 'WAV (24-bit)')}</button></span></div>
            <div className="form-row"><span className="form-label">{L('サンプルレート', 'Sample Rate')}</span><span className="segmented"><button className="on">44.1 kHz</button></span></div>
            <label className="check"><input type="checkbox" checked={s.exportNormalize} onChange={() => s.toggle('exportNormalize')} />{L('音割れ防止（ピークを −1 dB に正規化）', 'Prevent clipping (normalize peaks to −1 dB)')}</label>
            <div className="caption">{L('正規化をオンにすると、音量の確認のため2回処理するので少し時間がかかります（ミックス波形ができていれば1回で済みます）。', 'With normalization on, the mix is rendered twice to measure the level, so it takes a little longer (once, if the mix waveform is ready).')}</div>
            <div className="caption dim">{L('M4A・48 kHz・映像付き書き出しは、この後の段階で追加します。', 'M4A, 48 kHz and video export come in a later stage.')}</div>
          </div>
        )}
        {phase.kind === 'rendering' && (
          <div className="progress-block">
            <progress value={phase.progress} max={1} />
            <div className="button-row dim mono"><span>{L(`書き出し中… ${Math.floor(phase.progress * 100)}%`, `Exporting… ${Math.floor(phase.progress * 100)}%`)}</span><div className="spacer" /><span>{remaining()}</span></div>
          </div>
        )}
        {phase.kind === 'done' && <div className="ok">✓ {L(`書き出しが完了しました：${phase.path.split(/[\\/]/).pop()}`, `Export finished: ${phase.path.split(/[\\/]/).pop()}`)}</div>}
        {phase.kind === 'failed' && <div className="err">✕ {phase.message}</div>}
        <div className="button-row end">
          {phase.kind === 'idle' && <>
            <button className="btn" onClick={close}>{L('キャンセル', 'Cancel')}</button>
            <button className="btn primary" disabled={!s.clips.length} onClick={() => s.startExport(s.exportNormalize)}>{L('書き出す…', 'Export…')}</button>
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
