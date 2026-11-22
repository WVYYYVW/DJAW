// How to play the current set live (decks, mixer moves step by step) and the track list for SoundCloud
// (mac/DJAW/Views/PerformanceGuideView.swift).
import { Sampler } from '../../core/sampler';
import React, { useEffect, useMemo, useState } from 'react';
import fs from 'node:fs';
import { clipboard, ipcRenderer } from 'electron';
import { L } from '../../core/i18n';
import { deckName } from '../../core/layers';
import { PerformanceGuide } from '../../core/performance';
import { useStore } from '../hooks';

export function PerformanceGuideSheet() {
  const s = useStore();
  const [tab, setTab] = useState(0);
  const [numbered, setNumbered] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const guide = useMemo(() => PerformanceGuide.build(s.clips, s.masterBPM, s.tempoMap, s.sampleHits.flatMap(h => { const x = s.samples.find(y => y.id === h.sample); return x ? [{ name: x.name, time: Sampler.timeOfBeat(h.beat, s.masterBPM, s.gridOffset), repeats: Math.round(h.repeats ?? 0), every: h.every ?? 1 }] : []; }),
    s.placedLayers.map(l => ({ clip: l, deck: deckName(s.layerDeck(l.id) ?? 3) }))), [s.revision]);
  const list = useMemo(() => PerformanceGuide.trackList(s.clips, s.masterBPM, s.tempoMap, numbered, s.layers), [s.revision, numbered]);
  const close = () => { s.showPerformanceGuide = false; s.changed(); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  const copy = (text: string, message: string) => { clipboard.writeText(text); setCopied(message); };
  const save = async () => {
    const p = await ipcRenderer.invoke('dialog:save', { defaultPath: s.documentTitle + L(' 演奏手順.txt', ' - how to play.txt'), filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (!p) return;
    try { fs.writeFileSync(p, PerformanceGuide.text(guide) + '\n\n' + L('■ 曲リスト', '■ Track list') + '\n' + list, 'utf8'); }
    catch (e) { s.alertMessage = (e as Error).message; s.changed(); }
  };
  return (
    <div className="sheet-backdrop">
      <div className="sheet guide">
        <div className="sheet-head pad">
          <div className="segmented">
            <button className={tab === 0 ? 'on' : ''} onClick={() => setTab(0)}>{L('演奏手順', 'How to Play')}</button>
            <button className={tab === 1 ? 'on' : ''} onClick={() => setTab(1)}>{L('曲リスト', 'Track List')}</button>
          </div>
          <div className="spacer" />
          {copied && <span className="caption">{copied}</span>}
        </div>
        {tab === 0 ? (
          <div className="guide-body">
            <div className="guide-overview">{guide.overview.map((l, k) => <div key={k} className="dim">・{l}</div>)}</div>
            {guide.tracks.map(t => (
              <div key={t.number} className="guide-track">
                <div className="guide-track-head">
                  <span className={'guide-num deck' + t.deck}>{t.number}</span>
                  <b>{L(`デッキ${t.deck}`, `Deck ${t.deck}`)}</b>
                  <b className="ellipsis">{t.title}</b>
                </div>
                {t.setup.map((l, k) => <div key={k} className="guide-setup">・{l}</div>)}
                <div className="guide-steps">
                  {t.steps.map((st, k) => (
                    <React.Fragment key={k}>
                      <span className="mono dim">{PerformanceGuide.timeText(st.time)}</span>
                      <span className="mono dim">{st.position}</span>
                      <span className={st.isPrep ? 'dim' : ''}>{st.isPrep ? L('（準備）', '(prep) ') : ''}{st.text}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="guide-body">
            <div className="caption">{L('SoundCloud などの概要欄にそのまま貼り付けられる形です（時刻は、つなぎの線から判定した、前の曲から切り替わる位置）。', 'Ready to paste into a SoundCloud description (times are where each track takes over, read from the transition curves).')}</div>
            <pre className="track-list-text">{list}</pre>
          </div>
        )}
        <div className="sheet-footer">
          {tab === 0 ? <>
            <button className="btn" onClick={() => copy(PerformanceGuide.text(guide), L('手順をコピーしました', 'Steps copied'))}>{L('手順をコピー', 'Copy Steps')}</button>
            <button className="btn" onClick={save}>{L('テキストで保存…', 'Save as Text…')}</button>
          </> : <>
            <label className="check"><input type="checkbox" checked={numbered} onChange={e => setNumbered(e.target.checked)} /> {L('番号を付ける', 'Numbered')}</label>
            <button className="btn" onClick={() => copy(list, L('曲リストをコピーしました', 'Track list copied'))}>{L('曲リストをコピー', 'Copy Track List')}</button>
          </>}
          <div className="spacer" />
          <button className="btn primary" onClick={close}>{L('閉じる', 'Close')}</button>
        </div>
      </div>
    </div>
  );
}
