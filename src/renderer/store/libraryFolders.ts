// Folders for the library (the tracks not in the mix), so a long list stays manageable. Folders can be nested;
// a track is filed in at most one folder (Clip.folder). Saved with the mix; every change can be undone.
import { L } from '../../core/i18n';
import { Clip, LibraryFolder, uuid } from '../../core/models';
import { Key } from '../../core/analysis/structure';
import { MixStore } from './store';

/** One line of the library list: a folder or a track, with its depth. */
export type LibraryRow = { kind: 'folder'; folder: LibraryFolder; depth: number; count: number } | { kind: 'track'; clip: Clip; depth: number };

declare module './store' {
  interface MixStore {
    /** Text typed in the library's search box. */
    libraryQuery: string;
    /** A folder being renamed in place. */
    renamingFolder: string | null;
    createFolder(parent?: string | null, name?: string): string;
    renameFolder(id: string, name: string): void;
    /** Removes the folder; its tracks and folders move up a level. */
    deleteFolder(id: string): void;
    toggleFolder(id: string): void;
    setAllFoldersCollapsed(collapsed: boolean): void;
    /** Files tracks (in the library or the mix) into a folder (null = top level). */
    moveTracksToFolder(ids: string[], folder: string | null): void;
    moveFolder(id: string, parent: string | null): void;
    folderPath(id: string | null | undefined): string;
    /** Tracks in a folder and its subfolders. */
    tracksInFolder(id: string): Clip[];
    /** The library as shown: folders and tracks in order, collapsed folders closed, filtered by the search. */
    libraryRows(): LibraryRow[];
    /**
     * Sorts the library — every track (`scope` 'all') or only one folder's own tracks (the rest keep their places).
     * 'match' puts the tracks that go best with `reference` (key, tempo, genre) first.
     */
    sortLibrary(key: LibrarySort, scope: 'all' | string | null, descending?: boolean, reference?: string | null): void;
    /** Moves library tracks to just before another one (into its folder). */
    moveLibraryTracks(ids: string[], beforeID: string | null, folder?: string | null): void;
    /** How well a track goes after / with another (0 = perfect; key, tempo and genre). */
    matchScore(a: Clip, b: Clip): number;
  }
}

export type LibrarySort = 'title' | 'artist' | 'bpm' | 'key' | 'duration' | 'match';
export const librarySorts: LibrarySort[] = ['match', 'title', 'artist', 'bpm', 'key', 'duration'];
export const LibrarySorts = {
  title: (k: LibrarySort) => ({
    match: L('選んだ曲との相性順', 'Best match with the selected track'), title: L('曲名', 'Title'), artist: L('アーティスト', 'Artist'),
    bpm: 'BPM', key: L('キー（Camelot）', 'Key (Camelot)'), duration: L('長さ', 'Length'),
  })[k],
};

declare module './store' {
  interface MixStore {
  }
}

const P = MixStore.prototype;
Object.assign(P, { libraryQuery: '', renamingFolder: null });

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

P.createFolder = function (parent = null, name) {
  this.pushUndo();
  const id = uuid();
  const base = name ?? L('新しいフォルダ', 'New Folder');
  let n = base, k = 2;
  while (this.libraryFolders.some(f => (f.parent ?? null) === parent && f.name === n)) n = `${base} ${k++}`;
  this.libraryFolders = [...this.libraryFolders.map(f => (f.id === parent ? { ...f, collapsed: false } : f)), { id, name: n, parent }];
  if (!name) this.renamingFolder = id;
  this.changed();
  return id;
};

P.renameFolder = function (id, name) {
  const t = name.trim();
  this.renamingFolder = null;
  const f = this.libraryFolders.find(x => x.id === id);
  if (!f || !t || t === f.name) { this.changed(); return; }
  this.pushUndo();
  this.libraryFolders = this.libraryFolders.map(x => (x.id === id ? { ...x, name: t } : x));
  this.changed();
};

P.deleteFolder = function (id) {
  const f = this.libraryFolders.find(x => x.id === id);
  if (!f) return;
  this.pushUndo();
  const up = f.parent ?? null;
  this.libraryFolders = this.libraryFolders.filter(x => x.id !== id).map(x => (x.parent === id ? { ...x, parent: up } : x));
  const refile = (c: Clip) => (c.folder === id ? { ...c, folder: up } : c);
  this.library = this.library.map(refile);
  this.clips = this.clips.map(refile);
  this.changed();
};

P.toggleFolder = function (id) {
  // A view setting: saved with the mix but not an undo step.
  this.libraryFolders = this.libraryFolders.map(f => (f.id === id ? { ...f, collapsed: !f.collapsed } : f));
  this.markDirty();
  this.changed();
};

P.setAllFoldersCollapsed = function (collapsed) {
  this.libraryFolders = this.libraryFolders.map(f => ({ ...f, collapsed }));
  this.markDirty();
  this.changed();
};

P.moveTracksToFolder = function (ids, folder) {
  const set = new Set(ids);
  if (![...this.library, ...this.clips].some(c => set.has(c.id) && (c.folder ?? null) !== folder)) return;
  this.pushUndo();
  // Tracks dragged out of the mix go back to the library, into that folder.
  const fromMix = this.clips.filter(c => set.has(c.id));
  if (fromMix.length) {
    this.clips = this.clips.filter(c => !set.has(c.id));
    this.library = [...fromMix.map(c => ({ ...c, lockedPrevID: null })), ...this.library];
    if (!this.clips.length) this.pause(); else this.finishTimingEdit();
  }
  this.library = this.library.map(c => (set.has(c.id) ? { ...c, folder } : c));
  if (folder) this.libraryFolders = this.libraryFolders.map(f => (f.id === folder ? { ...f, collapsed: false } : f));
  this.changed();
};

P.moveFolder = function (id, parent) {
  if (id === parent) return;
  // Not into itself or one of its own subfolders.
  for (let p = parent; p; p = this.libraryFolders.find(f => f.id === p)?.parent ?? null) if (p === id) return;
  this.pushUndo();
  this.libraryFolders = this.libraryFolders.map(f => (f.id === id ? { ...f, parent } : f));
  this.changed();
};

P.folderPath = function (id) {
  const names: string[] = [];
  for (let p = id ?? null; p; p = this.libraryFolders.find(f => f.id === p)?.parent ?? null) {
    const f = this.libraryFolders.find(x => x.id === p);
    if (!f) break;
    names.unshift(f.name);
  }
  return names.join(' / ');
};

P.tracksInFolder = function (id) {
  const inside = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of this.libraryFolders) if (f.parent && inside.has(f.parent) && !inside.has(f.id)) { inside.add(f.id); grew = true; }
  }
  return this.library.filter(c => c.folder && inside.has(c.folder));
};

P.matchScore = function (a, b) {
  // Tempo: the smallest change needed (also at double / half time), in percent.
  const bpm = Math.min(...[1, 2, 0.5].map(f => Math.abs(Math.log((b.bpm * f) / Math.max(1, a.bpm))))) * 100;
  // Key: steps on the Camelot wheel (relative major / minor counts as one).
  const ka = this.structures.get(a.url)?.key, kb = this.structures.get(b.url)?.key;
  let key = 3;
  if (ka && kb) {
    const x = Key.camelotNumber(ka), y = Key.camelotNumber(kb);
    const d = Math.min((x - y + 12) % 12, (y - x + 12) % 12);
    key = d + (ka.minor === kb.minor ? 0 : 1);
  }
  const genre = a.genre && b.genre && a.genre !== b.genre ? 2 : 0;
  return bpm + key * 1.5 + genre;
};

P.sortLibrary = function (key, scope, descending = false, reference = null) {
  const ref = reference ? this.clip(reference) : null;
  if (key === 'match' && !ref) return;
  const camelot = (c: Clip) => { const k = this.structures.get(c.url)?.key; return k ? Key.camelotNumber(k) * 2 + (k.minor ? 0 : 1) : 99; };
  const value = (c: Clip): number | string => {
    switch (key) {
      case 'title': return c.title;
      case 'artist': return c.artist || '\uffff';
      case 'bpm': return c.bpm;
      case 'key': return camelot(c);
      case 'duration': return c.duration;
      case 'match': return c.id === ref!.id ? -1 : this.matchScore(ref!, c);
    }
  };
  const cmp = (a: Clip, b: Clip) => {
    const x = value(a), y = value(b);
    const r = typeof x === 'string' && typeof y === 'string' ? byName(x, y) : (x as number) - (y as number);
    return descending && key !== 'match' ? -r : r;
  };
  const known = new Set(this.libraryFolders.map(f => f.id));
  const inScope = (c: Clip) => scope === 'all' || ((c.folder && known.has(c.folder) ? c.folder : null) === scope);
  const slots = this.library.map((c, k) => (inScope(c) ? k : -1)).filter(k => k >= 0);
  if (slots.length < 2) return;
  this.pushUndo();
  const sorted = slots.map(k => this.library[k]).sort(cmp);
  const next = [...this.library];
  slots.forEach((k, j) => { next[k] = sorted[j]; });
  this.library = next;
  this.changed();
};

P.moveLibraryTracks = function (ids, beforeID, folder) {
  const moving = this.library.filter(c => ids.includes(c.id));
  if (!moving.length) return;
  this.pushUndo();
  const target = beforeID ? this.library.find(c => c.id === beforeID) : null;
  const dest = folder !== undefined ? folder : target ? target.folder ?? null : undefined;
  const rest = this.library.filter(c => !ids.includes(c.id));
  const at = target && !ids.includes(target.id) ? rest.findIndex(c => c.id === target.id) : rest.length;
  const moved = moving.map(c => (dest !== undefined ? { ...c, folder: dest } : c));
  this.library = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  this.changed();
};

P.libraryRows = function () {
  const folders = this.libraryFolders;
  const known = new Set(folders.map(f => f.id));
  const folderOf = (c: Clip) => (c.folder && known.has(c.folder) ? c.folder : null);
  const words = this.libraryQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (c: Clip) => {
    if (!words.length) return true;
    const key = this.structures.get(c.url)?.key;
    const hay = `${c.title} ${c.artist} ${Math.round(c.bpm)} ${key ? `${Key.camelot(key)} ${Key.name(key)}` : ''} ${this.folderPath(folderOf(c))}`.toLowerCase();
    return words.every(w => hay.includes(w));
  };
  const rows: LibraryRow[] = [];
  const count = (id: string): number => this.tracksInFolder(id).filter(matches).length;
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter(x => (x.parent && known.has(x.parent) ? x.parent : null) === parent).sort((a, b) => byName(a.name, b.name))) {
      const n = count(f.id);
      // While searching, folders without matches are hidden and the others shown open.
      if (words.length && n === 0) continue;
      rows.push({ kind: 'folder', folder: f, depth, count: n });
      if (!f.collapsed || words.length) walk(f.id, depth + 1);
    }
    for (const c of this.library) if (folderOf(c) === parent && matches(c)) rows.push({ kind: 'track', clip: c, depth });
  };
  walk(null, 0);
  return rows;
};
