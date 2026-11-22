// The sampler panel: 8 pads (keys Q–I) under the timeline. A pad pressed is heard at once; "place" puts it on the
// mix at the playhead (snapped), and while recording, pads hit during playback are placed where they were hit.
// The hits appear in the timeline's sampler lane, where they can be moved, rolled or removed.
import React, { useEffect, useState } from 'react';
import { L } from '../../core/i18n';
import { PADS, padKeys, rollChoices, everyChoices, Sampler } from '../../core/sampler';
import { useStore } from '../hooks';
import { droppedPaths } from '../dropped';
import { clipColor } from '../format';
import { showContextMenu } from './ContextMenu';
import type { MixStore } from '../store/store';
import { sampleName } from '../store/sampler';
import { builtinSamples } from '../../core/builtinSamples';

export const samplerSnaps: { value: number; label: () => string }[] = [
  { value: 0.25, label: () => L('1/16（1/4拍）', '1/16 (¼ beat)') },
  { value: 0.5, label: () => L('1/8（1/2拍）', '1/8 (½ beat)') },
  { value: 1, label: () => L('1拍', '1 beat') },
  { value: 4, label: () => L('1小節', '1 bar') },
];

const everyLabel = (v: number) => (v >= 1 ? L(`${v}拍ごと`, `every ${v} beat${v > 1 ? 's' : ''}`) : L(`1/${Math.round(1 / v)}拍ごと`, `every 1/${Math.round(1 / v)} beat`));

/** The context menu of a placed hit (the timeline uses it too). */
export function hitMenu(s: MixStore, id: string) {
  const h = s.sampleHits.find(x => x.id === id);
  if (!h) return [];
  const sample = s.samples.find(x => x.id === h.sample);
  return [
    { label: sample ? sampleName(sample) : '', enabled: false },
    { label: L('試聴', 'Audition'), action: () => sample && s.auditionSample(sample.id) },
    { label: L('再生位置へ移動', 'Move to the Playhead'), action: () => s.moveHit(id, s.snapBeat(s.playheadBeat())) },
    { separator: true },
    { label: L('連打（ロール）', 'Roll'), submenu: rollChoices.map(n => ({ label: n ? L(`×${n + 1}`, `×${n + 1}`) : L('なし（1回）', 'None (once)'), checked: (h.repeats ?? 0) === n, action: () => s.setHitRoll(id, n) })) },
    { label: L('連打の間隔', 'Roll Spacing'), enabled: (h.repeats ?? 0) > 0, submenu: everyChoices.map(v => ({ label: everyLabel(v), checked: (h.every ?? 1) === v, action: () => s.setHitRoll(id, h.repeats ?? 0, v) })) },
    { label: L('音量', 'Level'), submenu: [6, 3, 0, -3, -6, -12].map(db => ({ label: `${db > 0 ? '+' : ''}${db} dB`, checked: (h.gainDB ?? 0) === db, action: () => s.setHitGain(id, db) })) },
    { separator: true },
    { label: L('削除', 'Delete'), action: () => s.removeHit(id) },
  ];
}

/** DJAW's own sounds as menu items, by group (a separator between groups). */
function builtinItems(pick: (file: string) => void) {
  const items: { label?: string; action?: () => void; separator?: boolean; enabled?: boolean }[] = [];
  let group = '';
  for (const b of builtinSamples) {
    if (b.group() !== group) { if (group) items.push({ separator: true }); group = b.group(); items.push({ label: group, enabled: false }); }
    items.push({ label: `　${b.title()}`, action: () => pick(b.file) });
  }
  return items;
}

/** Mixes whose empty sampler was filled once already (removing the pads afterwards is respected). */
const kitOffered = new Set<string>();

function Pad({ index }: { index: number }) {
  const s = useStore();
  const sample = s.samples[index];
  const [over, setOver] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const missing = sample && !s.samplePcm.has(sample.id);
  const count = sample ? s.sampleHits.filter(h => h.sample === sample.id).length : 0;
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!sample) {
      showContextMenu(e, [
        { label: L('音を読み込む…', 'Load a Sound…'), action: () => s.chooseSamples(index) },
        { label: L('標準サンプル', 'Built-in Sounds'), submenu: builtinItems(f => void s.addBuiltinSamples([f])) },
      ]);
      return;
    }
    showContextMenu(e, [
      { label: L('試聴', 'Audition'), action: () => s.auditionSample(sample.id) },
      { label: L('再生位置に置く', 'Place at the Playhead'), enabled: !missing, action: () => s.placeHit(sample.id) },
      { separator: true },
      { label: L('名前を変更', 'Rename'), action: () => setRenaming(true) },
      { label: L('音量', 'Level'), submenu: [6, 3, 0, -3, -6, -9, -12].map(db => ({ label: `${db > 0 ? '+' : ''}${db} dB`, checked: sample.gainDB === db, action: () => s.setSampleGain(sample.id, db) })) },
      { label: L('別の音に差し替え…', 'Replace the Sound…'), action: () => s.chooseSamples(index) },
      { label: L('標準サンプルに差し替え', 'Replace with a Built-in Sound'), submenu: builtinItems(f => void s.addBuiltinSamples([f], index)) },
      { separator: true },
      { label: count ? L(`パッドを削除（置いた${count}個も削除）`, `Remove the Pad (and its ${count} hit${count > 1 ? 's' : ''})`) : L('パッドを削除', 'Remove the Pad'), action: () => s.removeSample(sample.id) },
    ]);
  };
  const color = sample ? clipColor(sample.colorIndex, missing ? 0.25 : 0.85) : undefined;
  return (
    <div className={'pad' + (sample ? '' : ' empty') + (over ? ' over' : '')}
      style={sample ? { borderColor: color, background: clipColor(sample.colorIndex, 0.18) } : undefined}
      title={sample
        ? L(`${sampleName(sample)}\nクリック／${padKeys[index]} キーで鳴らす。録音中に再生しながら叩くと、その位置に置かれます。\n右クリック：置く・名前・音量・差し替え`, `${sampleName(sample)}\nClick or press ${padKeys[index]} to play it. While recording, pads hit during playback are placed where they were hit.\nRight-click: place, rename, level, replace`)
        : L('クリックまたは音声ファイルをドロップして読み込み', 'Click or drop an audio file to load it')}
      onMouseDown={e => { if (e.button === 0 && !renaming) s.triggerPad(index); }}
      onContextMenu={menu}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); setOver(false); void s.addSamples(droppedPaths(e.dataTransfer), index); }}>
      <div className="pad-top">
        <span className="pad-key">{padKeys[index]}</span>
        {sample && <button className="pad-place" title={L('再生位置に置く（スナップ単位で合わせます）', 'Place at the playhead (on the snap)')} disabled={missing}
          onMouseDown={e => { e.stopPropagation(); }} onClick={e => { e.stopPropagation(); s.placeHit(sample.id); }}>＋</button>}
      </div>
      {renaming && sample
        ? <input className="pad-rename" autoFocus defaultValue={sampleName(sample)} onMouseDown={e => e.stopPropagation()}
            onBlur={e => { s.renameSample(sample.id, e.target.value); setRenaming(false); }}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); }} />
        : <div className="pad-name">{sample ? sampleName(sample) : '＋'}</div>}
      {sample && <div className="pad-info">{missing ? L('ファイルなし', 'Missing') : `${count ? L(`${count}か所`, `${count} placed`) : ''}${sample.gainDB ? `  ${sample.gainDB > 0 ? '+' : ''}${sample.gainDB} dB` : ''}`}</div>}
    </div>
  );
}

function SelectedHit() {
  const s = useStore();
  const h = s.sampleHits.find(x => x.id === s.selectedHit);
  if (!h) return <div className="sampler-hint">{L('置いた音はタイムライン下の「サンプラー」レーンで選んで、ドラッグで移動・右クリックで連打や削除ができます。', 'Placed sounds are in the timeline’s Sampler lane: drag to move, right-click for rolls or to delete.')}</div>;
  const sample = s.samples.find(x => x.id === h.sample);
  const pos = s.grid.position(Sampler.timeOfBeat(h.beat, s.masterBPM, s.gridOffset));
  return (
    <div className="sampler-hit">
      <div className="hit-title"><span className="dot" style={{ background: sample ? clipColor(sample.colorIndex) : undefined }} />{sample ? sampleName(sample) : null}<span className="dim">  {L(`小節 ${pos.bar}.${pos.beat}`, `Bar ${pos.bar}.${pos.beat}`)}</span></div>
      <div className="hit-row">
        <label>{L('連打', 'Roll')}</label>
        <select value={h.repeats ?? 0} onChange={e => s.setHitRoll(h.id, Number(e.target.value))}>
          {rollChoices.map(n => <option key={n} value={n}>{n ? `×${n + 1}` : L('なし', 'None')}</option>)}
        </select>
        <select value={h.every ?? 1} disabled={!(h.repeats ?? 0)} onChange={e => s.setHitRoll(h.id, h.repeats ?? 0, Number(e.target.value))}>
          {everyChoices.map(v => <option key={v} value={v}>{everyLabel(v)}</option>)}
        </select>
        <label>{L('音量', 'Level')}</label>
        <select value={h.gainDB ?? 0} onChange={e => s.setHitGain(h.id, Number(e.target.value))}>
          {[6, 3, 0, -3, -6, -12].map(db => <option key={db} value={db}>{`${db > 0 ? '+' : ''}${db} dB`}</option>)}
        </select>
        <button className="btn small" onClick={() => s.removeHit(h.id)} title={L('削除（Delete）', 'Delete (Delete)')}>{L('削除', 'Delete')}</button>
      </div>
    </div>
  );
}

export function SamplerPanel() {
  const s = useStore();
  // A new mix (never saved) starts with the standard kit on the pads; a saved one is left as it is (the button offers it).
  useEffect(() => {
    if (!s.samples.length && !s.documentPath && !kitOffered.has(s.projectID)) { kitOffered.add(s.projectID); void s.loadStandardKit(); }
  }, [s.projectID]);
  return (
    <div className="sampler"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => { e.preventDefault(); void s.addSamples(droppedPaths(e.dataTransfer)); }}>
      <div className="sampler-side">
        <div className="sampler-title">{L('サンプラー', 'Sampler')}</div>
        <button className={'btn small rec' + (s.samplerRecording ? ' on' : '')} disabled={!s.samples.length}
          onClick={() => { s.samplerRecording = !s.samplerRecording; s.changed(); }}
          title={L('オンにして再生しながらパッドを叩くと、叩いた位置（スナップに合わせて）に置かれます', 'When on, pads hit during playback are placed where they were hit (on the snap)')}>● {L('録音', 'Record')}</button>
        <button className={'btn small' + (s.samples.length ? '' : ' primary')}
          title={L('DJAW 付属の音（すべて DJAW で作った音なので、ミックス・ライブ・SoundCloud などで自由に使えます）', 'Sounds that come with DJAW (all made for DJAW, free to use in mixes, live sets and uploads)')}
          onClick={e => showContextMenu(e, [
            { label: L('標準キットを空いたパッドに入れる', 'Fill the Empty Pads with the Standard Kit'), enabled: s.samples.length < PADS, action: () => void s.loadStandardKit() },
            ...(s.samples.length >= PADS ? [{ label: L('（パッドがいっぱいです。差し替えはパッドを右クリック）', '(All pads are used: right-click a pad to replace it)'), enabled: false }] : []),
            { separator: true },
            ...builtinItems(f => void s.addBuiltinSamples([f])),
          ])}>{L('標準サンプル', 'Built-in Sounds')} ▾</button>
        <select className="tselect small" value={s.samplerSnap} onChange={e => { s.samplerSnap = Number(e.target.value); s.changed(); }} title={L('置く位置を合わせる単位', 'What placed sounds snap to')}>
          {samplerSnaps.map(o => <option key={o.value} value={o.value}>{o.label()}</option>)}
        </select>
      </div>
      <div className="pads">{Array.from({ length: PADS }, (_, i) => <Pad key={i} index={i} />)}</div>
      <SelectedHit />
    </div>
  );
}
