// The Music app library (mac/DJAW/Audio/MusicLibrary.swift). The Mac app reads it through the iTunesLibrary
// framework; here it is read from the library XML that iTunes for Windows writes (and that the Mac Music app writes
// when "Share Library XML with other applications" is on): only local, DRM-free songs DJAW can actually play.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MusicLibraryTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  /** BPM tag (0 = not set). */
  bpm: number;
  duration: number;
  path: string;
  added: number | null;
}

export interface MusicLibraryPlaylist {
  id: string;
  name: string;
  isSmart: boolean;
  trackIDs: string[];
  /** Songs in the playlist DJAW cannot use (subscription / cloud-only / protected). */
  unavailable: number;
}

export interface MusicLibrarySnapshot {
  tracks: MusicLibraryTrack[];
  playlists: MusicLibraryPlaylist[];
  protectedCount: number;
  cloudOnlyCount: number;
  file: string;
}

/** Where iTunes / Music keep the library XML. */
export function libraryXMLCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'Music', 'iTunes', 'iTunes Music Library.xml'),
    path.join(home, 'Music', 'iTunes', 'iTunes Library.xml'),
    path.join(home, 'Music', 'Music', 'Library.xml'),
    path.join(home, 'Music', 'Library.xml'),
  ];
}

export const findLibraryXML = () => libraryXMLCandidates().find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;

type Plist = string | number | boolean | Date | Plist[] | { [k: string]: Plist };

/** A small streaming-free plist (XML) reader: enough for library files of tens of MB. */
export function parsePlist(xml: string): Plist {
  let i = 0;
  const n = xml.length;
  const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    switch (e.toLowerCase()) {
      case 'lt': return '<'; case 'gt': return '>'; case 'amp': return '&'; case 'quot': return '"'; case 'apos': return "'";
    }
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
  const nextTag = (): { name: string; close: boolean; empty: boolean } | null => {
    for (;;) {
      const a = xml.indexOf('<', i);
      if (a < 0) return null;
      if (xml.startsWith('<?', a) || xml.startsWith('<!', a)) { i = xml.indexOf('>', a) + 1; continue; }
      const b = xml.indexOf('>', a);
      let body = xml.slice(a + 1, b).trim();
      i = b + 1;
      const close = body.startsWith('/');
      const empty = body.endsWith('/');
      if (close) body = body.slice(1);
      if (empty) body = body.slice(0, -1);
      return { name: body.split(/\s/)[0], close, empty };
    }
  };
  const text = (name: string) => {
    const end = xml.indexOf(`</${name}>`, i);
    const s = xml.slice(i, end);
    i = end + name.length + 3;
    return decode(s);
  };
  const value = (t: { name: string; close: boolean; empty: boolean }): Plist => {
    switch (t.name) {
      case 'dict': {
        const o: { [k: string]: Plist } = {};
        if (t.empty) return o;
        for (;;) {
          const k = nextTag();
          if (!k || (k.close && k.name === 'dict')) return o;
          const key = k.name === 'key' ? text('key') : '';
          const v = nextTag();
          if (!v) return o;
          o[key] = value(v);
        }
      }
      case 'array': {
        const a: Plist[] = [];
        if (t.empty) return a;
        for (;;) {
          const v = nextTag();
          if (!v || (v.close && v.name === 'array')) return a;
          a.push(value(v));
        }
      }
      case 'true': return true;
      case 'false': return false;
      case 'integer': return t.empty ? 0 : Number(text('integer'));
      case 'real': return t.empty ? 0 : Number(text('real'));
      case 'date': return new Date(text('date'));
      case 'string': return t.empty ? '' : text('string');
      case 'data': return t.empty ? '' : text('data');
      case 'plist': { const v = nextTag(); return v ? value(v) : ''; }
      default: return t.empty ? '' : text(t.name);
    }
  };
  while (i < n) {
    const t = nextTag();
    if (!t) break;
    if (!t.close) return value(t);
  }
  return {};
}

/** Library XML locations are file:// URLs (file://localhost/C:/… on Windows). */
function locationPath(loc: string): string | null {
  try {
    const u = loc.replace(/^file:\/\/localhost\//i, 'file:///');
    return fileURLToPath(u);
  } catch { return null; }
}

export function loadMusicLibrary(file: string): MusicLibrarySnapshot {
  const root = parsePlist(fs.readFileSync(file, 'utf8')) as Record<string, Plist>;
  const all = (root['Tracks'] ?? {}) as Record<string, Record<string, Plist>>;
  const tracks: MusicLibraryTrack[] = [];
  const usable = new Set<string>();
  const songIDs = new Set<string>();
  let protectedCount = 0, cloudOnlyCount = 0;
  for (const [key, t] of Object.entries(all)) {
    // Songs only (no podcasts, videos, audiobooks…).
    if (t['Podcast'] || t['Movie'] || t['Music Video'] || t['TV Show'] || t['Has Video'] || t['Audiobook']) continue;
    const kind = String(t['Kind'] ?? '');
    if (/book|podcast|video|movie|pdf/i.test(kind)) continue;
    const id = String(t['Persistent ID'] ?? t['Track ID'] ?? key);
    songIDs.add(id);
    if (t['Protected'] || /protected/i.test(kind)) { protectedCount++; continue; }
    const loc = typeof t['Location'] === 'string' ? locationPath(t['Location'] as string) : null;
    if (!loc || t['Track Type'] === 'Remote' || t['Track Type'] === 'URL' || !fs.existsSync(loc)) { cloudOnlyCount++; continue; }
    tracks.push({
      id,
      title: String(t['Name'] ?? path.basename(loc, path.extname(loc))),
      artist: String(t['Artist'] ?? ''),
      album: String(t['Album'] ?? ''),
      genre: String(t['Genre'] ?? ''),
      bpm: Number(t['BPM'] ?? 0) || 0,
      duration: Number(t['Total Time'] ?? 0) / 1000,
      path: loc,
      added: t['Date Added'] instanceof Date ? (t['Date Added'] as Date).getTime() : null,
    });
    usable.add(id);
  }
  const byTrackID = new Map<string, string>();
  for (const [key, t] of Object.entries(all)) byTrackID.set(String(t['Track ID'] ?? key), String(t['Persistent ID'] ?? t['Track ID'] ?? key));
  const playlists: MusicLibraryPlaylist[] = [];
  for (const p of ((root['Playlists'] ?? []) as Record<string, Plist>[])) {
    if (p['Master'] || p['Visible'] === false || p['Folder'] || p['Distinguished Kind'] != null) continue;
    const items = (p['Playlist Items'] ?? []) as Record<string, Plist>[];
    const ids = items.map(it => byTrackID.get(String(it['Track ID'])) ?? String(it['Track ID']));
    const songs = ids.filter(x => songIDs.has(x));
    if (!songs.length) continue;
    const ok = songs.filter(x => usable.has(x));
    playlists.push({ id: String(p['Playlist Persistent ID'] ?? p['Playlist ID'] ?? p['Name']), name: String(p['Name'] ?? ''),
      isSmart: p['Smart Info'] != null, trackIDs: ok, unavailable: songs.length - ok.length });
  }
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  tracks.sort((a, b) => cmp(a.title, b.title));
  playlists.sort((a, b) => cmp(a.name, b.name));
  return { tracks, playlists, protectedCount, cloudOnlyCount, file };
}
