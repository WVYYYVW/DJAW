// Mix order (drag to reorder; transitions follow automatically) and the library of prepared tracks
// (mac/DJAW/Views/SidebarView.swift).
import React, { useState } from 'react';
import { L } from '../../core/i18n';
import { Clip, Style, barLabel } from '../../core/models';
import { Key } from '../../core/analysis/structure';
import { useStore } from '../hooks';
import { store } from '../store/store';
import { Fmt, clipColor } from '../format';
import { showContextMenu } from './ContextMenu';

function TrackRow({ clip, index, inMix }: { clip: Clip; index: number; inMix: boolean }) {
  const s = useStore();
  const selected = s.selectedClipID === clip.id || s.librarySelection.has(clip.id);
  const key = s.structures.get(clip.url)?.key;
  const prev = inMix && index > 0 ? s.clips[index - 1] : null;
  const select = (e: React.MouseEvent) => {
    if (!inMix && (e.ctrlKey || e.metaKey)) {
      const set = new Set(s.librarySelection.size ? s.librarySelection : s.selectedClipID && s.libraryIndex(s.selectedClipID) != null ? [s.selectedClipID] : []);
      if (set.has(clip.id)) set.delete(clip.id); else set.add(clip.id);
      s.librarySelection = set;
      s.selectedClipID = clip.id;
    } else if (!inMix && e.shiftKey && s.selectedClipID && s.libraryIndex(s.selectedClipID) != null) {
      const a = s.libraryIndex(s.selectedClipID)!, b = index;
      s.librarySelection = new Set(s.library.slice(Math.min(a, b), Math.max(a, b) + 1).map(c => c.id));
    } else {
      s.librarySelection = new Set();
      s.selectedClipID = clip.id;
      if (inMix) s.requestScroll(clip.start);
    }
    s.changed();
  };
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (inMix) {
      showContextMenu(e, [
        { label: clip.cueDone ? L('CUE を未完了に戻す', 'Mark Cues as Not Done') : L('CUE を完了にする', 'Mark Cues as Done'), action: () => s.setProgress(clip.id, !clip.cueDone) },
        ...(index > 0 ? [{ label: s.isTransitionLocked(clip.id) ? L('前の曲とのつなぎの固定を解除', 'Unlock Transition from Previous Track') : L('前の曲とのつなぎを固定', 'Lock Transition from Previous Track'), action: () => s.toggleTransitionLock(clip.id) }] : []),
        { separator: true },
        { label: L('CUE（IN / OUT）を編集…', 'Edit Cues (IN / OUT)…'), action: () => s.openCueEditor(clip.id) },
        { label: L('ライブラリに戻す', 'Move Back to Library'), action: () => s.removeFromMix(clip.id) },
        { label: L('ここから再生', 'Play from Here'), action: () => { s.seek(clip.start); if (!s.isPlaying) s.play(); } },
        { separator: true },
        { label: L('エクスプローラーで表示', 'Show in Explorer'), action: () => s.revealInFolder(clip.id) },
        { label: L('ミックスから削除', 'Remove from Mix'), action: () => s.deleteClip(clip.id) },
      ]);
    } else {
      const ids = s.librarySelection.size > 1 ? [...s.librarySelection] : [clip.id];
      showContextMenu(e, ids.length > 1 ? [
        { label: L(`${ids.length}曲をミックスの末尾に入れる`, `Add ${ids.length} Tracks to End of Mix`), action: () => s.addToMixMany(ids, s.clips.length) },
        { label: L(`${ids.length}曲をライブラリから削除`, `Remove ${ids.length} Tracks from Library`), action: () => s.removeFromLibrary(ids) },
      ] : [
        { label: L('CUE（IN / OUT）を編集…', 'Edit Cues (IN / OUT)…'), action: () => s.openCueEditor(clip.id) },
        { label: L('ミックスの末尾に入れる', 'Add to End of Mix'), action: () => s.addToMix(clip.id, s.clips.length) },
        { label: L('選択中の曲の後に入れる', 'Add After Selected Track'), action: () => s.addToMix(clip.id) },
        { separator: true },
        { label: L('エクスプローラーで表示', 'Show in Explorer'), action: () => s.revealInFolder(clip.id) },
        { label: L('ライブラリから削除', 'Remove from Library'), action: () => s.removeFromLibrary([clip.id]) },
      ]);
    }
  };
  let transition: string | null = null;
  if (prev) {
    transition = clip.transitionBars < 0.01
      ? L(`直結 · ${barLabel(prev.mixOutBar)} → ${barLabel(clip.mixInBar)}`, `Direct · ${barLabel(prev.mixOutBar)} → ${barLabel(clip.mixInBar)}`)
      : `${Fmt.bars(clip.transitionBars)} · ${Style.title(clip.transition)} · ${barLabel(prev.mixOutBar)} → ${barLabel(clip.mixInBar)}`;
  }
  return (
    <>
      {transition && (
        <div className={'transition-row' + (selected ? ' sel' : '')} onClick={() => { s.selectedClipID = clip.id; s.inspectorTab = 'transition'; s.showInspector = true; s.changed(); }}
          onDoubleClick={() => s.openTransitionEditor(clip.id)} title={L('クリックでつなぎを編集、ダブルクリックでつなぎエディタ', 'Click to edit the transition, double-click for the transition editor')}>
          {s.isLocked(index) ? '🔒 ' : '↘ '}{transition}{clip.transitionDone ? ' ✓' : ''}
        </div>
      )}
      <div className={'track-row' + (selected ? ' sel' : '')} onMouseDown={select} onDoubleClick={() => s.openCueEditor(clip.id)} onContextMenu={menu}
        draggable onDragStart={e => { e.dataTransfer.setData('text/djaw-track', JSON.stringify({ id: clip.id, inMix, index })); }}>
        <span className="swatch" style={{ background: clipColor(clip.colorIndex) }} />
        <div className="track-text">
          <div className="track-title">{inMix ? `${index + 1}. ` : ''}{clip.title}{clip.cueDone ? ' ✓' : ''}</div>
          <div className="track-sub">
            {clip.artist ? `${clip.artist} · ` : ''}IN {barLabel(clip.mixInBar)} · OUT {barLabel(clip.mixOutBar)} · {Fmt.bpm(clip.bpm)} BPM{key ? ` · ${Key.camelot(key)}` : ''}
          </div>
        </div>
        {!inMix && <button className="mini" title={L('ミックスに入れる', 'Add to mix')} onClick={e => { e.stopPropagation(); s.addToMix(clip.id); }}>＋</button>}
      </div>
    </>
  );
}

export function Sidebar() {
  const s = useStore();
  const [dropAt, setDropAt] = useState<number | null>(null);
  const p = s.progressSummary;
  const onDragOverMix = (e: React.DragEvent, k: number) => {
    if (!e.dataTransfer.types.includes('text/djaw-track') && !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropAt(k);
  };
  const onDropMix = (e: React.DragEvent, k: number) => {
    e.preventDefault();
    setDropAt(null);
    const files = [...e.dataTransfer.files].map(f => (f as File & { path: string }).path).filter(Boolean);
    if (files.length) { s.addFiles(files, { kind: 'mix', index: k }); return; }
    const raw = e.dataTransfer.getData('text/djaw-track');
    if (!raw) return;
    const d = JSON.parse(raw) as { id: string; inMix: boolean; index: number };
    if (d.inMix) s.moveClips([d.index], k); else s.addToMix(d.id, k);
  };
  return (
    <div className="sidebar"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => {
        const files = [...e.dataTransfer.files].map(f => (f as File & { path: string }).path).filter(Boolean);
        if (files.length) { e.preventDefault(); s.addFiles(files, { kind: 'library' }); }
      }}>
      <div className="side-section">
        <div className="side-head">
          <span>{L('ミックス順（ドラッグで並べ替え）', 'Mix order (drag to reorder)')}</span>
        </div>
        {s.clips.length ? (
          <div className="side-meta">
            {L(`${s.clips.length}曲 · ${Fmt.duration(s.realMixDuration)}`, `${s.clips.length} tracks · ${Fmt.duration(s.realMixDuration)}`)}
            <span className="dim"> · {L(`CUE ${p.cues}/${p.cueTotal} · つなぎ ${p.transitions}/${p.transitionTotal}`, `Cues ${p.cues}/${p.cueTotal} · Transitions ${p.transitions}/${p.transitionTotal}`)}</span>
          </div>
        ) : null}
        <div className="track-list" onDragLeave={() => setDropAt(null)}>
          {s.clips.map((c, i) => (
            <div key={c.id} onDragOver={e => onDragOverMix(e, i)} onDrop={e => onDropMix(e, i)} className={dropAt === i ? 'drop-before' : ''}>
              <TrackRow clip={c} index={i} inMix />
            </div>
          ))}
          <div className={'drop-end' + (dropAt === s.clips.length ? ' drop-before' : '')} onDragOver={e => onDragOverMix(e, s.clips.length)} onDrop={e => onDropMix(e, s.clips.length)}>
            {!s.clips.length && <div className="empty">{L('音声ファイルやフォルダをここかタイムラインにドロップしてください', 'Drop audio files or folders here or on the timeline')}</div>}
          </div>
        </div>
      </div>
      <div className="side-section grow">
        <div className="side-head">
          <span>{L('ライブラリ（未配置）', 'Library (not in mix)')}</span>
          {s.library.length > 1 && (
            <button className="link" onClick={() => { s.librarySelection = s.librarySelection.size > 1 ? new Set() : new Set(s.library.map(c => c.id)); s.changed(); }}>
              {s.librarySelection.size > 1 ? L('選択解除', 'Deselect') : L('全選択', 'Select All')}
            </button>
          )}
        </div>
        <div className="track-list">
          {s.library.map((c, i) => <TrackRow key={c.id} clip={c} index={i} inMix={false} />)}
          {s.pending.map(p => (
            <div key={p.id} className="track-row pending">
              <span className="spinner" />
              <div className="track-text">
                <div className="track-title">{p.name}</div>
                <div className="track-sub">{p.stage === 'decode' ? L('読み込み中…', 'Reading…') : p.stage === 'beats' ? L(`拍を解析中 ${Math.round((p.fraction ?? 0) * 100)}%`, `Finding beats ${Math.round((p.fraction ?? 0) * 100)}%`) : L(`解析中 ${Math.round((p.fraction ?? 0) * 100)}%`, `Analysing ${Math.round((p.fraction ?? 0) * 100)}%`)}</div>
              </div>
            </div>
          ))}
          {!s.library.length && !s.pending.length && (
            <div className="empty">
              {L('ここに音声ファイルをドロップすると、ミックスに入れる前の曲として準備できます', 'Drop audio files here to prepare tracks before they go into the mix')}
              <div><button className="tbtn" onClick={() => s.presentAddFiles()}>{L('曲を追加…', 'Add Tracks…')}</button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
void store;
