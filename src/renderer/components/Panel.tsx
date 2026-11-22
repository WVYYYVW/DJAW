// The detail panel under the arrangement (like Ableton Live's detail view): one place for everything about the selected
// track or transition — and the mix as a whole — switched by tabs. Its height is dragged at the top edge.
import React, { useEffect, useReducer } from 'react';
import { L } from '../../core/i18n';
import { Fmt, clipColor } from '../format';
import { Key } from '../../core/analysis/structure';
import { Style } from '../../core/models';
import { useStore } from '../hooks';
import { PanelTab, store } from '../store/store';
import { Icon, IconName } from './Icons';
import { ArtworkThumb } from './TrackProfileSheet';
import { showContextMenu } from './ContextMenu';
import {
  DeckTab, FXTab, LibraryInspector, MixerTab, MixInspector, MultiLibraryInspector, Section, StructureSummary, TakesSection,
  TempoChangeSection, TransitionSection, VariationsSection, LayerInspector,
} from './Inspector';
import { TransitionEditor } from './TransitionEditor';
import { CueEditor } from './CueEditor';
import { LoopEditor } from './LoopEditor';
import { SamplerPanel } from './SamplerPanel';
import { DeckPanel } from './DeckPanel';
import { OverviewTab } from './Overview';

const tabs: { id: PanelTab; icon: IconName; title: () => string; key?: string }[] = [
  { id: 'overview', icon: 'wave', title: () => L('全体', 'Overview'), key: 'Ctrl+Alt+O' },
  { id: 'mix', icon: 'mix', title: () => L('ミックス', 'Mix') },
  { id: 'track', icon: 'track', title: () => L('曲', 'Track') },
  { id: 'transition', icon: 'transition', title: () => L('つなぎ', 'Transition'), key: 'Ctrl+T' },
  { id: 'cue', icon: 'cue', title: () => 'CUE', key: 'Ctrl+K' },
  { id: 'loop', icon: 'loop', title: () => L('ループ', 'Loop'), key: 'Ctrl+L' },
  { id: 'fx', icon: 'fx', title: () => 'FX' },
  { id: 'sampler', icon: 'pads', title: () => L('サンプラー', 'Sampler'), key: 'Ctrl+Shift+B' },
  { id: 'deck', icon: 'deck', title: () => L('デッキ', 'Decks') },
];

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="panel-empty">{children}</div>;
}

/** Name, artwork and position of the selected track (the panel's right-hand header). */
function ClipBadge() {
  const s = useStore();
  const c = s.selectedClip ?? (s.selectedClipID ? s.clip(s.selectedClipID) : null);
  if (!c) return null;
  const i = s.index(c.id);
  const key = s.structures.get(c.url)?.key;
  return (
    <div className="clip-badge">
      <ArtworkThumb url={c.url} colorIndex={c.colorIndex} size={22} onClick={() => s.openProfileEditor(c.id)} />
      <span className="clip-badge-title" title={c.title}>{c.title}</span>
      <span className="clip-badge-sub mono">{i != null ? L(`${i + 1}曲目`, `#${i + 1}`) : s.isLayer(c.id) ? L(`重ね · デッキ ${'ABCD'[s.layerDeck(c.id) ?? 3]}`, `Layer · deck ${'ABCD'[s.layerDeck(c.id) ?? 3]}`) : L('ライブラリ', 'Library')} · {Fmt.bpm(c.bpm)}{key ? ` · ${Key.camelot(key)}` : ''}</span>
      <button className="tbtn icon small" title={L('この曲の操作', 'Track actions')} onClick={e => showContextMenu(e, [
        { label: L('曲の情報（ジャケット・アーティスト）を編集…', 'Edit Track Info (Artwork, Artist)…'), action: () => s.openProfileEditor(c.id) },
        ...(i != null ? [{ label: L('ライブラリに戻す', 'Move Back to Library'), action: () => s.removeFromMix(c.id) }] : [{ label: L('ミックスの末尾に入れる', 'Add to End of Mix'), action: () => s.addToMix(c.id, s.clips.length) }]),
        { label: L('エクスプローラーで表示', 'Show in Explorer'), action: () => s.revealInFolder(c.id) },
        { separator: true },
        { label: i != null ? L('ミックスから削除', 'Remove from Mix') : L('ライブラリから削除', 'Remove from Library'), action: () => (i != null ? s.deleteClip(c.id) : s.removeFromLibrary([c.id])) },
      ])}>⋯</button>
    </div>
  );
}

function TrackTab() {
  const s = useStore();
  if (s.librarySelection.size > 1) return <MultiLibraryInspector />;
  const id = s.selectedClipID;
  const i = id ? s.index(id) : null;
  if (id && i != null) {
    const clip = s.clips[i];
    return (
      <div className="panel-columns">
        <Section title={L('曲の構成', 'Structure')}><StructureSummary clip={clip} />{!s.structures.get(clip.url) && <div className="caption">{L('解析中…', 'Analysing…')}</div>}</Section>
        <MixerTab clip={clip} index={i} />
        <DeckTab clip={clip} index={i} />
        <TempoChangeSection clip={clip} index={i} />
      </div>
    );
  }
  if (id && s.libraryIndex(id) != null) return <LibraryInspector clip={s.library[s.libraryIndex(id)!]} />;
  const layer = id ? s.layers.find(l => l.id === id) : null;
  if (layer) return <LayerInspector clip={layer} />;
  return <Empty>{L('タイムラインかリストで曲を選んでください', 'Select a track in the timeline or the list')}</Empty>;
}

function TransitionTab() {
  const s = useStore();
  const id = s.selectedClipID;
  const i = id ? s.index(id) : null;
  if (!id || i == null) return <Empty>{L('タイムラインで、つなぎ（曲と曲の重なり）か2曲目以降の曲を選んでください', 'Select a transition (where two tracks overlap) or a track after the first')}</Empty>;
  const clip = s.clips[i];
  if (i === 0) {
    return (
      <div className="panel-columns">
        <Section title={L('つなぎ', 'Transition')}><div className="caption">⚑ {L('ミックスの1曲目です。つなぎは2曲目以降で設定します。', 'This is the first track; transitions start from the second.')}</div>
          {s.clips[1] && <button className="btn small" onClick={() => { s.selectedClipID = s.clips[1].id; s.changed(); }}>{L('2曲目へのつなぎを開く', 'Open the transition into track 2')}</button>}</Section>
        <TempoChangeSection clip={clip} index={i} />
      </div>
    );
  }
  const next = s.clips[i + 1];
  return (
    <div className="panel-split">
      <div className="panel-props">
        <TransitionSection clip={clip} index={i} />
        <TakesSection clip={clip} />
        <VariationsSection clip={clip} index={i} />
        <TempoChangeSection clip={clip} index={i} />
        <div className="trans-nav">
          <button className="btn small" disabled={i <= 1} onClick={() => { s.selectedClipID = s.clips[i - 1].id; s.requestScroll(s.clips[i - 1].start); s.changed(); }}>‹ {L('前のつなぎ', 'Previous')}</button>
          <button className="btn small" disabled={!next} onClick={() => { if (next) { s.selectedClipID = next.id; s.requestScroll(next.start); s.changed(); } }}>{L('次のつなぎ', 'Next')} ›</button>
        </div>
        {next && <div className="caption">{L(`次：「${next.title}」へ ${next.transitionBars < 0.01 ? Style.title(next.transition) : Fmt.bars(next.transitionBars) + ' ' + Style.title(next.transition)}`, `Next: into “${next.title}”, ${next.transitionBars < 0.01 ? Style.title(next.transition) : Fmt.bars(next.transitionBars) + ' ' + Style.title(next.transition)}`)}</div>}
      </div>
      <div className="panel-editor"><TransitionEditor key={clip.id} id={clip.id} /></div>
    </div>
  );
}

function needsTrack(tab: PanelTab, body: (id: string) => React.ReactNode) {
  const id = store.selectedClipID;
  if (!id || !store.clip(id)) return <Empty>{L('タイムラインかリストで曲を選んでください', 'Select a track in the timeline or the list')}</Empty>;
  void tab;
  return body(id);
}

function FXPanelTab() {
  const s = useStore();
  const id = s.selectedClipID;
  const i = id ? s.index(id) : null;
  if (!id || i == null) return <Empty>{L('ミックスの曲を選ぶと、その曲のエフェクトを置けます', 'Select a track in the mix to place effects on it')}</Empty>;
  return <div className="panel-columns"><FXTab clip={s.clips[i]} /></div>;
}

function DeckTabPanel() {
  const s = useStore();
  return (
    <div className="panel-deck">
      <DeckPanel />
      <label className="check caption deck-mixer-toggle"><input type="checkbox" checked={s.showMixer} onChange={() => s.toggle('showMixer')} />{L('ミキサーを表示', 'Show the mixer')}</label>
    </div>
  );
}

export function DetailPanel({ maxHeight, maximized = false }: { maxHeight: number; maximized?: boolean }) {
  const s = useStore();
  // Canvases inside size themselves when drawn: draw again when the window changes size.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { const f = () => redraw(); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  // The transition tab keeps its own, taller height: its lanes need the room.
  const own = s.panelTab === 'transition';
  const wanted = own ? s.transitionPanelHeight ?? Math.round(window.innerHeight * 0.58) : s.panelHeight;
  const height = Math.max(170, Math.min(wanted, maxHeight));
  const resize = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = height;
    const move = (ev: PointerEvent) => {
      const h = Math.max(170, Math.min(maxHeight, h0 - (ev.clientY - y0)));
      if (own) s.transitionPanelHeight = h; else s.panelHeight = h;
      s.changed();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); s.saveSettings(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  let body: React.ReactNode;
  switch (s.panelTab) {
    case 'overview': body = <OverviewTab />; break;
    case 'mix': body = <MixInspector />; break;
    case 'track': body = <TrackTab />; break;
    case 'transition': body = <TransitionTab />; break;
    case 'cue': body = needsTrack('cue', id => <CueEditor key={id} id={id} />); break;
    case 'loop': body = needsTrack('loop', id => (s.index(id) != null ? <LoopEditor key={id} id={id} /> : <Empty>{L('ループはミックスに入れた曲に置けます', 'Loops go on tracks in the mix')}</Empty>)); break;
    case 'fx': body = <FXPanelTab />; break;
    case 'sampler': body = <SamplerPanel />; break;
    case 'deck': body = <DeckTabPanel />; break;
  }
  const sel = s.selectedClipID ? s.clip(s.selectedClipID) : null;
  const count = (t: PanelTab) => {
    if (!sel) return null;
    if (t === 'fx') return sel.fx?.length || null;
    if (t === 'loop') return sel.edits?.length || null;
    if (t === 'cue') return sel.cues?.length || null;
    return null;
  };
  return (
    <div className={'detail-panel' + (maximized ? ' maximized' : '')} style={maximized ? undefined : { height }}>
      {!maximized && <div className="panel-resize" onPointerDown={resize} onDoubleClick={() => s.togglePanelMaximized(true)} title={L('ドラッグで高さを変更（ダブルクリックで最大化）', 'Drag to resize (double-click to maximize)')} />}
      <div className="panel-tabs" onDoubleClick={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('spacer')) s.togglePanelMaximized(); }}>
        {tabs.map(t => (
          <button key={t.id} className={'panel-tab' + (s.panelTab === t.id ? ' on' : '')} onClick={() => s.openPanel(t.id)} title={t.title() + (t.key ? `（${t.key}）` : '')}>
            <Icon name={t.icon} size={14} />{t.title()}{count(t.id) ? <span className="tab-count">{count(t.id)}</span> : null}
          </button>
        ))}
        <div className="spacer" />
        <ClipBadge />
        <button className={'tbtn small panel-max' + (maximized ? ' on' : '')} onClick={() => s.togglePanelMaximized()}
          title={maximized ? L('元の大きさに戻す（Ctrl+Alt+F／タブの空いた所をダブルクリック）', 'Restore (Ctrl+Alt+F / double-click the tab bar)') : L('大きく表示：アレンジを隠してパネルをウィンドウいっぱいに（Ctrl+Alt+F／タブの空いた所をダブルクリック）', 'Maximize: fill the window with the panel, hiding the arrangement (Ctrl+Alt+F / double-click the tab bar)')}>
          <Icon name={maximized ? 'restore' : 'maximize'} size={14} />{maximized ? L('元に戻す', 'Restore') : L('大きく表示', 'Maximize')}
        </button>
        {!maximized && <button className="tbtn icon small" title={L('パネルを隠す（Ctrl+Alt+I）', 'Hide the panel (Ctrl+Alt+I)')} onClick={() => s.toggle('showPanel')}><Icon name="chevronDown" size={14} /></button>}
      </div>
      <div className="panel-body">{body}</div>
    </div>
  );
}

void clipColor;
