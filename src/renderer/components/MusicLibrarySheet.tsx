// Browse the iTunes / Music library and add songs (purchased or imported, DRM-free) to DJAW
// (mac/DJAW/Views/MusicLibrarySheet.swift; read from the library XML instead of the iTunesLibrary framework).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ipcRenderer } from 'electron';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { L } from '../../core/i18n';
import { MusicLibrarySnapshot, MusicLibraryTrack, findLibraryXML, loadMusicLibrary } from '../../core/musicLibrary';
import { Fmt } from '../format';
import { useStore } from '../hooks';

type Phase = { kind: 'loading' } | { kind: 'missing' } | { kind: 'failed'; message: string } | { kind: 'ready'; snapshot: MusicLibrarySnapshot };
type SortKey = 'title' | 'artist' | 'genre' | 'bpm' | 'duration';
const SAVED = 'djaw.musicLibraryXML';

export function MusicLibrarySheet() {
  const s = useStore();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [source, setSource] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'title', asc: true });
  const [previewID, setPreviewID] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const lastClick = useRef<string | null>(null);

  const load = (file: string | null) => {
    if (!file) { setPhase({ kind: 'missing' }); return; }
    setPhase({ kind: 'loading' });
    setTimeout(() => {
      try {
        const snapshot = loadMusicLibrary(file);
        try { localStorage.setItem(SAVED, file); } catch { /* ignore */ }
        setPhase({ kind: 'ready', snapshot });
      } catch (e) { setPhase({ kind: 'failed', message: (e as Error).message }); }
    }, 30);
  };
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(SAVED); } catch { /* ignore */ }
    load(findLibraryXML() ?? saved);
    return () => stopPreview();
  }, []);

  const chooseFile = async () => {
    const r: string[] | null = await ipcRenderer.invoke('dialog:open', {
      title: L('ライブラリの XML を選ぶ', 'Choose the Library XML'), properties: ['openFile'],
      filters: [{ name: 'iTunes / Music Library XML', extensions: ['xml'] }],
    });
    if (r && r[0]) load(r[0]);
  };

  const close = () => { stopPreview(); s.showMusicLibrary = false; s.changed(); };
  const snapshot = phase.kind === 'ready' ? phase.snapshot : null;
  const addedPaths = useMemo(() => new Set([...s.clips, ...s.library].map(c => path.normalize(c.url).toLowerCase())), [s.clips, s.library]);
  const isAdded = (t: MusicLibraryTrack) => addedPaths.has(path.normalize(t.path).toLowerCase());

  const rows = useMemo(() => {
    if (!snapshot) return [];
    let tracks = snapshot.tracks;
    if (source !== 'all') {
      const p = snapshot.playlists.find(x => x.id === source);
      if (p) { const byID = new Map(tracks.map(t => [t.id, t])); tracks = p.trackIDs.map(id => byID.get(id)).filter((t): t is MusicLibraryTrack => !!t); }
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) tracks = tracks.filter(t => { const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.bpm > 0 ? t.bpm : ''}`.toLowerCase(); return words.every(w => hay.includes(w)); });
    const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
    const k = sort.key;
    return [...tracks].sort((a, b) => {
      const d = typeof a[k] === 'number' ? (a[k] as number) - (b[k] as number) : cmp(String(a[k]), String(b[k]));
      return sort.asc ? d : -d;
    });
  }, [snapshot, source, query, sort]);

  const newSelection = snapshot ? snapshot.tracks.filter(t => selection.has(t.id) && !isAdded(t)) : [];
  const add = (ids?: Set<string>) => {
    if (!snapshot) return;
    const chosen = ids ?? selection;
    const paths = snapshot.tracks.filter(t => chosen.has(t.id) && !isAdded(t)).map(t => t.path);
    if (!paths.length) return;
    stopPreview();
    void s.addFiles(paths, { kind: 'library' });
    close();
  };

  function stopPreview() {
    audio.current?.pause();
    audio.current = null;
    setPreviewID(null);
  }
  const togglePreview = (t: MusicLibraryTrack) => {
    if (previewID === t.id) { stopPreview(); return; }
    stopPreview();
    if (s.isPlaying) s.togglePlay();
    const a = new Audio(pathToFileURL(t.path).href);
    a.addEventListener('loadedmetadata', () => { if (isFinite(a.duration)) a.currentTime = a.duration * 0.4; void a.play().catch(() => {}); }, { once: true });
    a.addEventListener('ended', () => setPreviewID(null));
    audio.current = a;
    setPreviewID(t.id);
  };

  const clickRow = (e: React.MouseEvent, t: MusicLibraryTrack) => {
    const next = new Set(selection);
    if (e.shiftKey && lastClick.current) {
      const a = rows.findIndex(r => r.id === lastClick.current), b = rows.findIndex(r => r.id === t.id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i].id);
    } else if (e.ctrlKey || e.metaKey) {
      if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
    } else { next.clear(); next.add(t.id); }
    lastClick.current = t.id;
    setSelection(next);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); e.stopPropagation(); }
      if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'INPUT' && newSelection.length) { add(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  const header = (k: SortKey, title: string, cls = '') => (
    <th className={cls} onClick={() => setSort(sort.key === k ? { key: k, asc: !sort.asc } : { key: k, asc: true })}>
      {title}{sort.key === k ? (sort.asc ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const n = newSelection.length;
  const skipped = snapshot ? snapshot.protectedCount + snapshot.cloudOnlyCount : 0;

  return (
    <div className="sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet music-sheet">
        <div className="sheet-head music-head">
          <span className="sheet-icon">♫</span>
          <div className="music-head-text">
            <div className="sheet-title">{L('ミュージックから追加', 'Add from Music')}</div>
            <div className="dim">{L('iTunes／ミュージックのライブラリから、購入した曲や自分で取り込んだ曲を、ミックス前の「ライブラリ」に追加します。Apple Music の配信曲は保護（DRM）されているため使えません。', 'Adds purchased or imported songs from the iTunes / Music library to the library. Apple Music subscription songs are copy-protected (DRM) and can’t be used.')}</div>
          </div>
          {snapshot && <input className="music-search" placeholder={L('曲名・アーティスト・ジャンル・BPM', 'Title, artist, genre, BPM')} value={query} onChange={e => setQuery(e.target.value)} autoFocus />}
        </div>
        <div className="music-body">
          {phase.kind === 'loading' && <div className="music-center"><span className="spinner" /> {L('ミュージックのライブラリを読み込み中…', 'Reading the Music library…')}</div>}
          {(phase.kind === 'missing' || phase.kind === 'failed') && (
            <div className="music-center col">
              <div className="sheet-title">{L('ライブラリを読み込めません', 'Can’t read the library')}</div>
              <div className="dim pre">{phase.kind === 'failed' ? phase.message : L('ライブラリの XML ファイルが見つかりませんでした。\niTunes の「編集 ▸ 環境設定 ▸ 詳細」で「iTunes ライブラリ XML をほかのアプリケーションと共有」をオンにするか、XML ファイルを選んでください。\n（Windows の「Apple Music」アプリは XML を書き出さないため、曲のファイルやフォルダを直接ドロップしてください。）', 'No library XML file was found.\nIn iTunes, turn on Edit ▸ Preferences ▸ Advanced ▸ “Share iTunes Library XML with other applications”, or choose the XML file.\n(The Windows “Apple Music” app doesn’t write the XML: drop the song files or folders instead.)')}</div>
              <div className="button-row"><button className="btn" onClick={chooseFile}>{L('XML ファイルを選ぶ…', 'Choose XML File…')}</button><button className="btn" onClick={() => load(findLibraryXML())}>{L('もう一度読み込む', 'Try Again')}</button></div>
            </div>
          )}
          {snapshot && <>
            <div className="music-sources">
              <div className={`music-source ${source === 'all' ? 'on' : ''}`} onClick={() => { setSource('all'); setSelection(new Set()); }}>♪ {L(`すべての曲（${snapshot.tracks.length}）`, `All Songs (${snapshot.tracks.length})`)}</div>
              {snapshot.playlists.length > 0 && <div className="music-section">{L('プレイリスト', 'Playlists')}</div>}
              {snapshot.playlists.map(p => (
                <div key={p.id} className={`music-source ${source === p.id ? 'on' : ''}`} title={p.unavailable > 0 ? L(`このプレイリストの ${p.unavailable} 曲は使えないため除いています`, `${p.unavailable} songs in this playlist can’t be used`) : p.name}
                  onClick={() => { setSource(p.id); setSelection(new Set()); }}>
                  <span className="music-source-name">{p.isSmart ? '⚙' : '≡'} {p.name}</span><span className="dim mono">{p.trackIDs.length}</span>
                </div>
              ))}
            </div>
            <div className="music-main">
              <div className="music-table-wrap">
                <table className="music-table">
                  <thead><tr><th className="w-play" />{header('title', L('曲名', 'Title'))}{header('artist', L('アーティスト', 'Artist'))}{header('genre', L('ジャンル', 'Genre'))}{header('bpm', 'BPM', 'num')}{header('duration', L('時間', 'Time'), 'num')}</tr></thead>
                  <tbody>
                    {rows.map(t => (
                      <tr key={t.id} className={`${selection.has(t.id) ? 'sel' : ''} ${isAdded(t) ? 'added' : ''}`} onMouseDown={e => clickRow(e, t)} onDoubleClick={() => add(new Set([t.id]))}>
                        <td className="w-play"><button className="play-mini" title={L('試聴（曲の中盤から）', 'Preview (from the middle)')} onMouseDown={e => e.stopPropagation()} onClick={() => togglePreview(t)}>{previewID === t.id ? '■' : '▶'}</button></td>
                        <td className="title">{t.title}{isAdded(t) && <span className="pill">{L('追加済み', 'Added')}</span>}</td>
                        <td className="dim">{t.artist}</td>
                        <td className="dim">{t.genre}</td>
                        <td className={`num mono ${t.bpm > 0 ? '' : 'dim'}`}>{t.bpm > 0 ? t.bpm : '–'}</td>
                        <td className="num mono dim">{Fmt.duration(t.duration)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rows.length && <div className="music-center col"><div>{query ? L('見つかりません', 'No matches') : L('使える曲がありません', 'No usable songs')}</div><div className="dim">{query ? L('別の言葉で検索してください。', 'Try a different search.') : L('購入した曲や、ファイルから取り込んだ曲が表示されます。', 'Purchased and imported songs appear here.')}</div></div>}
              </div>
              <div className="music-bar">
                <button className="link" disabled={!rows.length} onClick={() => setSelection(new Set(rows.map(r => r.id)))}>{L('表示中をすべて選択', 'Select All Shown')}</button>
                {selection.size > 0 && <button className="link" onClick={() => setSelection(new Set())}>{L('選択解除', 'Deselect')}</button>}
                <div className="spacer" />
                <span className="dim">{L(`${rows.length}曲 ・ ${selection.size}曲を選択中`, `${rows.length} songs · ${selection.size} selected`)}</span>
              </div>
            </div>
          </>}
        </div>
        <div className="button-row end music-foot">
          {snapshot && skipped > 0 && <span className="dim small" title={L('未ダウンロードの曲は、iTunes／ミュージックでダウンロードすると表示されます。', 'Songs that aren’t downloaded appear once you download them in iTunes / Music.')}>🔒 {L(`使えない曲 ${skipped} 曲（保護 ${snapshot.protectedCount}・未ダウンロード ${snapshot.cloudOnlyCount}）は表示していません`, `${skipped} songs hidden (${snapshot.protectedCount} protected, ${snapshot.cloudOnlyCount} not downloaded)`)}</span>}
          {snapshot && <button className="link small" onClick={chooseFile}>{L('別の XML を選ぶ…', 'Other XML…')}</button>}
          <div className="spacer" />
          <button className="btn" onClick={close}>{L('キャンセル', 'Cancel')}</button>
          <button className="btn primary" disabled={!n} onClick={() => add()}>{n === 0 ? L('ライブラリに追加', 'Add to Library') : L(`${n}曲をライブラリに追加`, `Add ${n} to Library`)}</button>
        </div>
      </div>
    </div>
  );
}
