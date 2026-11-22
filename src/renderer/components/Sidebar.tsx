// Mix order (drag to reorder; transitions follow automatically) and the library of prepared tracks
// (mac/DJAW/Views/SidebarView.swift).
import React, { useRef, useState } from 'react';
import { L } from '../../core/i18n';
import { Clip, Style, barLabel } from '../../core/models';
import { Key } from '../../core/analysis/structure';
import { useStore } from '../hooks';
import { store } from '../store/store';
import { Fmt, clipColor } from '../format';
import { droppedPaths } from '../dropped';
import { MenuItem, showContextMenu } from './ContextMenu';
import { ArtworkThumb } from './TrackProfileSheet';
import type { LibraryRow } from '../store/libraryFolders';

const DRAG_TRACKS = 'text/djaw-track';
const DRAG_FOLDER = 'text/djaw-folder';

/** "Move to folder ▸" items for these tracks. */
function folderMenu(ids: string[]): MenuItem[] {
  const s = store;
  const walk = (parent: string | null, depth: number): MenuItem[] => s.libraryFolders
    .filter(f => (f.parent ?? null) === parent)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .flatMap(f => [{ label: `${'　'.repeat(depth)}📁 ${f.name}`, action: () => s.moveTracksToFolder(ids, f.id) }, ...walk(f.id, depth + 1)]);
  return [
    ...walk(null, 0),
    ...(s.libraryFolders.length ? [{ separator: true } as MenuItem] : []),
    { label: L('フォルダの外（いちばん上）', 'Out of folders (top level)'), action: () => s.moveTracksToFolder(ids, null) },
    { label: L('新しいフォルダを作って入れる…', 'New Folder with These…'), action: () => { const id = s.createFolder(null); s.moveTracksToFolder(ids, id); } },
  ];
}

function TrackRow({ clip, index, inMix, depth = 0, order }: { clip: Clip; index: number; inMix: boolean; depth?: number; order?: Clip[] }) {
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
      // In the order shown (folders, search).
      const list = order ?? s.library;
      const a = list.findIndex(c => c.id === s.selectedClipID), b = list.findIndex(c => c.id === clip.id);
      if (a >= 0 && b >= 0) s.librarySelection = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1).map(c => c.id));
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
        { label: L('曲の情報（ジャケット・アーティスト）を編集…', 'Edit Track Info (Artwork, Artist)…'), action: () => s.openProfileEditor(clip.id) },
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
        { label: L(`${ids.length}曲をフォルダへ移動`, `Move ${ids.length} Tracks to Folder`), submenu: folderMenu(ids) },
        { label: L(`${ids.length}曲でおまかせミックス（曲順も）…`, `Auto-Arrange ${ids.length} Tracks (Order Too)…`), action: () => s.autoArrangePreselecting(ids) },
        { label: L(`${ids.length}曲をライブラリから削除`, `Remove ${ids.length} Tracks from Library`), action: () => s.removeFromLibrary(ids) },
      ] : [
        { label: L('CUE（IN / OUT）を編集…', 'Edit Cues (IN / OUT)…'), action: () => s.openCueEditor(clip.id) },
        { label: L('曲の情報（ジャケット・アーティスト）を編集…', 'Edit Track Info (Artwork, Artist)…'), action: () => s.openProfileEditor(clip.id) },
        { label: L('ミックスの末尾に入れる', 'Add to End of Mix'), action: () => s.addToMix(clip.id, s.clips.length) },
        { label: L('選択中の曲の後に入れる', 'Add After Selected Track'), action: () => s.addToMix(clip.id) },
        { label: L('フォルダへ移動', 'Move to Folder'), submenu: folderMenu([clip.id]) },
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
        <div className={'transition-row' + (selected ? ' sel' : '')} onClick={() => { s.selectedClipID = clip.id; s.openPanel('transition'); }}
          onDoubleClick={() => s.openTransitionEditor(clip.id)} title={L('クリックで、このつなぎを下のパネルで編集', 'Click to edit this transition in the panel below')}>
          {s.isLocked(index) ? '🔒 ' : '↘ '}{transition}{clip.transitionDone ? ' ✓' : ''}
        </div>
      )}
      <div className={'track-row' + (selected ? ' sel' : '')} onMouseDown={select} onDoubleClick={() => s.openCueEditor(clip.id)} onContextMenu={menu}
        style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}
        draggable onDragStart={e => {
          // Dragging one of several selected library tracks drags them all.
          const ids = !inMix && s.librarySelection.size > 1 && s.librarySelection.has(clip.id) ? [...s.librarySelection] : [clip.id];
          e.dataTransfer.setData(DRAG_TRACKS, JSON.stringify({ id: clip.id, ids, inMix, index }));
        }}>
        <span className="swatch" style={{ background: clipColor(clip.colorIndex) }} />
        <ArtworkThumb url={clip.url} colorIndex={clip.colorIndex} size={34} />
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
    if (!e.dataTransfer.types.includes(DRAG_TRACKS) && !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropAt(k);
  };
  const onDropMix = (e: React.DragEvent, k: number) => {
    e.preventDefault();
    setDropAt(null);
    const files = droppedPaths(e.dataTransfer);
    if (files.length) { s.addFiles(files, { kind: 'mix', index: k }); return; }
    const raw = e.dataTransfer.getData(DRAG_TRACKS);
    if (!raw) return;
    const d = JSON.parse(raw) as { id: string; ids?: string[]; inMix: boolean; index: number };
    if (d.inMix) s.moveClips([d.index], k);
    else if (d.ids && d.ids.length > 1) s.addToMixMany(d.ids, k);
    else s.addToMix(d.id, k);
  };
  // Drag the right edge for the width, and the line between the two lists for their shares (double-click: back to normal).
  const sideRef = useRef<HTMLDivElement>(null);
  const dragResize = (e: React.PointerEvent, kind: 'width' | 'split') => {
    e.preventDefault();
    const el = sideRef.current!;
    const box = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      if (kind === 'width') s.browserWidth = Math.round(Math.max(200, Math.min(Math.min(640, window.innerWidth * 0.5), ev.clientX - box.left)));
      else s.browserSplit = Math.max(0.1, Math.min(0.9, (ev.clientY - box.top) / Math.max(1, box.height)));
      s.changed();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; s.saveSettings(); };
    document.body.style.cursor = kind === 'width' ? 'ew-resize' : 'ns-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="sidebar" ref={sideRef} style={{ width: s.browserWidth }}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={e => {
        const files = droppedPaths(e.dataTransfer);
        if (files.length) { e.preventDefault(); s.addFiles(files, { kind: 'library' }); }
      }}>
      <div className="side-section mix-order" style={{ flexBasis: `${s.browserSplit * 100}%` }}>
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
      <div className="side-split" onPointerDown={e => dragResize(e, 'split')} onDoubleClick={() => { s.browserSplit = 0.45; s.changed(); s.saveSettings(); }}
        title={L('ドラッグでミックス順とライブラリの高さの割合を変更（ダブルクリックで元に戻す）', 'Drag to share the height between the mix order and the library (double-click to reset)')} />
      <LibrarySection />
      <div className="side-resize" onPointerDown={e => dragResize(e, 'width')} onDoubleClick={() => { s.browserWidth = 264; s.changed(); s.saveSettings(); }}
        title={L('ドラッグで幅を変更（ダブルクリックで元に戻す）', 'Drag to change the width (double-click to reset)')} />
    </div>
  );
}

/** A folder line: open / close, rename in place, drop tracks or folders onto it. */
function FolderRow({ row, onDrop }: { row: Extract<LibraryRow, { kind: 'folder' }>; onDrop: (e: React.DragEvent, folder: string | null) => void }) {
  const s = useStore();
  const f = row.folder;
  const [over, setOver] = useState(false);
  const renaming = s.renamingFolder === f.id;
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const inside = s.tracksInFolder(f.id).map(c => c.id);
    showContextMenu(e, [
      { label: L('名前を変更', 'Rename'), action: () => { s.renamingFolder = f.id; s.changed(); } },
      { label: L('この中にフォルダを作る', 'New Folder Inside'), action: () => s.createFolder(f.id) },
      { separator: true },
      { label: L(`中の曲をすべて選択（${inside.length}曲）`, `Select All Tracks Inside (${inside.length})`), enabled: inside.length > 0, action: () => { s.librarySelection = new Set(inside); s.selectedClipID = inside[0] ?? null; s.changed(); } },
      { label: L(`中の曲をミックスの末尾に入れる（${inside.length}曲）`, `Add Tracks Inside to End of Mix (${inside.length})`), enabled: inside.length > 0, action: () => s.addToMixMany(inside, s.clips.length) },
      { label: L(`中の曲でおまかせミックス…`, `Auto-Arrange Tracks Inside…`), enabled: inside.length > 1, action: () => s.autoArrangePreselecting(inside) },
      { separator: true },
      ...(f.parent ? [{ label: L('いちばん上に出す', 'Move to Top Level'), action: () => s.moveFolder(f.id, null) }] : []),
      { label: L('フォルダを削除（中の曲は残す）', 'Delete Folder (keep its tracks)'), action: () => s.deleteFolder(f.id) },
    ]);
  };
  return (
    <div className={'folder-row' + (over ? ' drop-into' : '')} style={{ paddingLeft: 6 + row.depth * 14 }}
      onClick={() => !renaming && s.toggleFolder(f.id)} onDoubleClick={e => { e.stopPropagation(); s.renamingFolder = f.id; s.changed(); }} onContextMenu={menu}
      draggable={!renaming} onDragStart={e => e.dataTransfer.setData(DRAG_FOLDER, f.id)}
      onDragOver={e => { if ([DRAG_TRACKS, DRAG_FOLDER, 'Files'].some(t => e.dataTransfer.types.includes(t))) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { setOver(false); onDrop(e, f.id); }}>
      <span className="folder-arrow">{f.collapsed && !s.libraryQuery ? '▸' : '▾'}</span>
      <span className="folder-icon">📁</span>
      {renaming ? (
        <input className="folder-name-input" autoFocus defaultValue={f.name} onClick={e => e.stopPropagation()}
          onFocus={e => e.currentTarget.select()}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') s.renameFolder(f.id, e.currentTarget.value); if (e.key === 'Escape') { s.renamingFolder = null; s.changed(); } }}
          onBlur={e => s.renameFolder(f.id, e.currentTarget.value)} />
      ) : <span className="folder-name">{f.name}</span>}
      <span className="folder-count">{row.count}</span>
    </div>
  );
}

function LibrarySection() {
  const s = useStore();
  const [overTop, setOverTop] = useState(false);
  const rows = s.libraryRows();
  const order = rows.flatMap(r => (r.kind === 'track' ? [r.clip] : []));
  /** Tracks, folders or files dropped into a folder (null = top level). */
  const drop = (e: React.DragEvent, folder: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const files = droppedPaths(e.dataTransfer);
    if (files.length) { s.addFiles(files, { kind: 'library', folder }); return; }
    const fid = e.dataTransfer.getData(DRAG_FOLDER);
    if (fid) { s.moveFolder(fid, folder); return; }
    const raw = e.dataTransfer.getData(DRAG_TRACKS);
    if (!raw) return;
    const d = JSON.parse(raw) as { id: string; ids?: string[] };
    s.moveTracksToFolder(d.ids ?? [d.id], folder);
  };
  const visibleIDs = order.map(c => c.id);
  const allSelected = visibleIDs.length > 1 && visibleIDs.every(id => s.librarySelection.has(id));
  return (
    <div className="side-section grow">
      <div className="side-head">
        <span className="side-title" title={L('ミックスに入れる前の曲', 'Tracks not in the mix yet')}>{L('ライブラリ', 'Library')}</span>
        <div className="spacer" />
        <button className="link icon" title={L('新しいフォルダ（ドラッグで曲やフォルダを入れられます）', 'New folder (drag tracks or folders into it)')} onClick={() => s.createFolder(null)}>📁＋</button>
        <button className="link icon" title={L('iTunes／ミュージックのライブラリから追加（Ctrl+Alt+Shift+I）', 'Add from the iTunes / Music library (Ctrl+Alt+Shift+I)')} onClick={() => { s.showMusicLibrary = true; s.changed(); }}>♫</button>
        {visibleIDs.length > 1 && (
          <button className="link" onClick={() => { s.librarySelection = allSelected ? new Set() : new Set(visibleIDs); s.changed(); }}>
            {allSelected ? L('選択解除', 'Deselect') : L('全選択', 'Select All')}
          </button>
        )}
        {s.libraryFolders.length > 0 && (
          <button className="link icon" title={L('フォルダをすべて開く／閉じる', 'Open / close all folders')} onClick={() => s.setAllFoldersCollapsed(!s.libraryFolders.every(f => f.collapsed))}>
            {s.libraryFolders.every(f => f.collapsed) ? '▾▾' : '▸▸'}
          </button>
        )}
      </div>
      {(s.library.length > 6 || s.libraryQuery) && (
        <div className="library-search">
          <input type="search" placeholder={L('曲名・アーティスト・BPM・キー・フォルダで絞り込み', 'Filter by title, artist, BPM, key, folder')} value={s.libraryQuery}
            onChange={e => { s.libraryQuery = e.target.value; s.changed(); }} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { s.libraryQuery = ''; s.changed(); } }} />
        </div>
      )}
      <div className={'track-list' + (overTop ? ' drop-into' : '')}
        onDragOver={e => { if ([DRAG_TRACKS, DRAG_FOLDER].some(t => e.dataTransfer.types.includes(t))) { e.preventDefault(); setOverTop(true); } }}
        onDragLeave={e => { if (e.currentTarget === e.target) setOverTop(false); }}
        onDrop={e => { setOverTop(false); if (e.dataTransfer.types.includes(DRAG_TRACKS) || e.dataTransfer.types.includes(DRAG_FOLDER)) drop(e, null); }}>
        {rows.map(r => r.kind === 'folder'
          ? <FolderRow key={'f' + r.folder.id} row={r} onDrop={drop} />
          : <TrackRow key={r.clip.id} clip={r.clip} index={s.libraryIndex(r.clip.id) ?? 0} inMix={false} depth={r.depth} order={order} />)}
        {s.libraryQuery && !rows.length && <div className="empty">{L('見つかりません', 'No matches')}</div>}
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
            {L('ここに音声ファイルをドロップすると、ミックスに入れる前の曲として準備できます。曲が増えたら「＋📁」でフォルダに分けられます', 'Drop audio files here to prepare tracks before they go into the mix. Use “＋📁” to sort them into folders')}
            <div><button className="tbtn" onClick={() => s.presentAddFiles()}>{L('曲を追加…', 'Add Tracks…')}</button> {process.platform !== 'darwin' && <button className="tbtn" onClick={() => s.presentAddFiles(true)}>{L('フォルダから追加…', 'Add Folder…')}</button>} <button className="tbtn" onClick={() => { s.showMusicLibrary = true; s.changed(); }}>{L('ミュージックから追加…', 'Add from Music…')}</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
void store;
