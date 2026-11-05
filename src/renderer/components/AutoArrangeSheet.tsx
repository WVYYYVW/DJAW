// "Auto-arrange": tick some tracks and let DJAW pick the running order and build the transitions
// (mac/DJAW/Views/AutoArrangeSheet.swift). A side tool — mixing by hand stays the main way of working.
import React, { useEffect, useMemo, useState } from 'react';
import { L } from '../../core/i18n';
import { Clip, Style } from '../../core/models';
import { Key } from '../../core/analysis/structure';
import { Arc, MixStyle, MixStyles, SetArc, mixStyles, setArcs } from '../../core/automixer';
import { useStore } from '../hooks';
import { Fmt, clipColor } from '../format';

function TrackLabel({ c, inMix }: { c: Clip; inMix: boolean }) {
  const s = useStore();
  const key = s.structures.get(c.url)?.key;
  return (
    <div className="track-text">
      <div className="track-title">{c.title}</div>
      <div className="track-sub">{Fmt.bpm(c.bpm)} BPM{key ? <span style={{ color: 'var(--purple)' }}> {Key.camelot(key)}</span> : null}{inMix ? <span className="dim"> · {L('ミックス中', 'in mix')}</span> : null}</div>
    </div>
  );
}

function Compatibility({ a, b }: { a: Clip; b: Clip }) {
  const s = useStore();
  const pct = (b.bpm / Math.max(1, a.bpm) - 1) * 100;
  const ka = s.structures.get(a.url)?.key, kb = s.structures.get(b.url)?.key;
  const keyOK = ka && kb ? Key.isCompatible(ka, kb) : null;
  return (
    <div className="compat caption">
      ↓ <span style={{ color: Math.abs(pct) > 6 ? 'var(--orange)' : undefined }}>{`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}</span>
      {keyOK != null && <span className={keyOK ? 'ok' : 'warn'}> {keyOK ? '✓ ' + L('キー相性◎', 'Keys match') : '⚠ ' + L('キー注意', 'Key clash')}</span>}
    </div>
  );
}

export function AutoArrangeSheet() {
  const s = useStore();
  const all = [...s.clips, ...s.library];
  const [selected, setSelected] = useState<Set<string>>(() => {
    const pre = s.autoArrangePreselect;
    return pre && pre.size ? new Set(pre) : new Set(all.map(c => c.id));
  });
  const [reorder, setReorder] = useState(true);
  const [replace, setReplace] = useState(() => !(s.autoArrangePreselect && s.autoArrangePreselect.size));
  const [built, setBuilt] = useState(false);
  const [depthBefore, setDepthBefore] = useState(0);
  useEffect(() => { s.autoArrangePreselect = null; }, []);
  const chosen = all.map(c => c.id).filter(id => selected.has(id));
  const preview = useMemo(() => (reorder ? s.suggestedOrder(chosen) : chosen), [reorder, chosen.join(','), s.setArc, s.revision]);
  const pendingAnalysis = chosen.some(id => { const c = s.clip(id); return c ? !s.structures.has(c.url) : false; });
  const close = () => { if (s.isPlaying) s.pause(); s.showAutoArrange = false; s.changed(); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  const toggle = (id: string, on: boolean) => { const n = new Set(selected); if (on) n.add(id); else n.delete(id); setSelected(n); };

  if (built) {
    return (
      <div className="sheet-backdrop">
        <div className="sheet arrange">
          <div className="sheet-head pad">
            <div className="grow">
              <div className="sheet-title">✓ {L('ミックスを作成しました', 'Mix built')}</div>
              <div className="caption">{L('各つなぎを試聴し、気になる所はつなぎエディタで LOW / HIGH やフェーダーの動きを描き直せます。', 'Preview each transition and redraw its LOW / HIGH and fader moves in the Transition Editor where needed.')}</div>
            </div>
            <span className="mono dim">{L(`マスター ${Fmt.bpm(s.masterBPM)} BPM`, `Master ${Fmt.bpm(s.masterBPM)} BPM`)}</span>
          </div>
          <div className="arrange-results">
            {s.clips.length < 2 && <div className="empty">{L('つなぎはありません', 'No transitions')}</div>}
            {s.clips.map((clip, i) => {
              if (i === 0) return null;
              const prev = s.clips[i - 1];
              const kind = clip.transitionBars < 0.01 ? Style.title(clip.transition) : `${Fmt.bars(clip.transitionBars)} · ${Style.title(clip.transition)}`;
              const lines = (s.autoNoteText(clip) ?? '').split('\n').filter(Boolean);
              return (
                <div key={clip.id} className="arrange-row">
                  <div className="arrange-line">
                    <span className="mono dim">{i}→{i + 1}</span>
                    <span className="dot" style={{ background: clipColor(prev.colorIndex) }} /><span className="ellipsis">{prev.title}</span>
                    <span className="dim">→</span>
                    <span className="dot" style={{ background: clipColor(clip.colorIndex) }} /><span className="ellipsis">{clip.title}</span>
                    <div className="spacer" />
                    <span className="badge">{kind}</span>
                  </div>
                  {lines.slice(0, 3).map((l, k) => <div key={k} className="caption arrange-note">• {l}</div>)}
                  <div className="button-row end small">
                    <button className="btn" onClick={() => (s.isPlaying ? s.pause() : s.previewTransition(clip.id))}>{s.isPlaying ? '■ ' + L('停止', 'Stop') : '▶ ' + L('試聴', 'Preview')}</button>
                    <button className="btn" title={L('このつなぎだけ、曲を解析して決め直します', 'Re-plans only this transition from the analysis')} onClick={() => s.autoMixTransition(clip.id)}>✦ {L('決め直す', 'Re-decide')}</button>
                    <button className="btn primary" disabled={clip.transitionBars < 0.01}
                      title={clip.transitionBars < 0.01 ? L('カットインは重なりがないため描けません', 'A cut has no overlap to draw') : L('LOW / MID / HIGH とフェーダーの時間変化を描きます', 'Draw the LOW / MID / HIGH and fader moves over time')}
                      onClick={() => { if (s.isPlaying) s.pause(); s.selectedClipID = clip.id; s.openTransitionEditor(clip.id); }}>✎ {L('つなぎエディタ…', 'Transition Editor…')}</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="sheet-footer">
            <button className="btn" onClick={() => { if (s.isPlaying) s.pause(); while (s.undoSerial > depthBefore && s.canUndo) s.undo(); setBuilt(false); }}>↶ {L('取り消して選び直す', 'Undo & Choose Again')}</button>
            <div className="spacer" />
            <button className="btn primary" onClick={close}>{L('完了', 'Done')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet arrange">
        <div className="sheet-head pad">
          <div>
            <div className="sheet-title">✦ {L('おまかせミックス', 'Auto-Arrange')}</div>
            <div className="caption">{L('選んだ曲の順番とつなぎを、BPM・キー・曲の構成から自動で組み立てます。あとから自由に手直しできます。', 'DJAW picks the running order and the transitions from BPM, key and structure. You can rework everything by hand afterwards.')}</div>
          </div>
        </div>
        <div className="arrange-body">
          <div className="arrange-left">
            <div className="button-row"><b className="grow">{L('使う曲', 'Tracks to use')}</b>
              <button className="btn small" onClick={() => setSelected(new Set(all.map(c => c.id)))}>{L('すべて', 'All')}</button>
              <button className="btn small" onClick={() => setSelected(new Set())}>{L('なし', 'None')}</button>
            </div>
            <div className="arrange-list">
              {all.map(c => (
                <label key={c.id} className="arrange-item">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={e => toggle(c.id, e.target.checked)} />
                  <TrackLabel c={c} inMix={s.index(c.id) != null} />
                </label>
              ))}
            </div>
          </div>
          <div className="arrange-right">
            <b>{reorder ? L('提案された曲順', 'Suggested order') : L('曲順（そのまま）', 'Order (as listed)')}</b>
            <div className="arrange-list">
              {preview.map((id, n) => {
                const c = s.clip(id);
                const a = n > 0 ? s.clip(preview[n - 1]) : null;
                if (!c) return null;
                return (
                  <React.Fragment key={id}>
                    {a && <Compatibility a={a} b={c} />}
                    <div className="arrange-item">
                      <span className="num" style={{ background: clipColor(c.colorIndex, 0.5) }}>{n + 1}</span>
                      <TrackLabel c={c} inMix={false} />
                    </div>
                  </React.Fragment>
                );
              })}
              {preview.length < 2 && <div className="caption">{L('2曲以上選んでください', 'Choose at least two tracks')}</div>}
            </div>
          </div>
        </div>
        <div className="sheet-footer wrap">
          <label className="check"><input type="checkbox" checked={reorder} onChange={e => setReorder(e.target.checked)} /> {L('曲順も自動で決める', 'Choose the order too')}</label>
          <select value={s.mixStyle} title={MixStyles.detail(s.mixStyle)} onChange={e => s.setMixStyle(e.target.value as MixStyle)}>{mixStyles.map(m => <option key={m} value={m}>{L('スタイル: ', 'Style: ') + MixStyles.title(m)}</option>)}</select>
          <select value={s.setArc} disabled={!reorder} title={L('曲順を決めるとき、盛り上がり（エナジー）の流れをどう作るか', 'How the energy should develop over the order')} onChange={e => s.setSetArc(e.target.value as SetArc)}>{setArcs.map(a => <option key={a} value={a}>{L('流れ: ', 'Energy: ') + Arc.title(a)}</option>)}</select>
          <select value={replace ? 'r' : 'a'} title={L('作り直す場合、選ばなかったミックスの曲はライブラリに戻ります（Ctrl+Zで元に戻せます）', 'When replacing, unchosen mix tracks go back to the library (undo with Ctrl+Z)')} onChange={e => setReplace(e.target.value === 'r')}>
            <option value="r">{L('ミックスを作り直す', 'Replace the mix')}</option>
            <option value="a">{L('今のミックスの後ろに追加', 'Append to the mix')}</option>
          </select>
          <div className="spacer" />
          {pendingAnalysis && <span className="caption warn">⌛ {L('解析中の曲があります', 'Some tracks are still being analysed')}</span>}
          <button className="btn" onClick={close}>{L('キャンセル', 'Cancel')}</button>
          <button className="btn primary" disabled={selected.size < (replace ? 2 : 1)} onClick={() => { setDepthBefore(s.undoSerial); s.autoArrange(chosen, reorder, replace); setBuilt(true); }}>{L('ミックスを作成', 'Build the Mix')}</button>
        </div>
      </div>
    </div>
  );
}
