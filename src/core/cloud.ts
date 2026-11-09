// Mixes shared between computers through a cloud sync folder (MEGA's desktop app keeps a local folder in step
// with the cloud). DJAW only reads and writes files there:
//   <root>/DJAW/<mix>.djaw      the mix, without embedded audio (small, so saving uploads only a few kB)
//   <root>/DJAW/曲/…            each track's audio file, copied once and shared by all mixes
//   <root>/DJAW/使用中/…        "open on <computer>" notes, refreshed while a mix is open
// Tracks are found again on the other computer through each clip's relativePath. Temporary files start with "."
// so the sync app ignores them (MEGA excludes names starting with "." by default).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint } from './analysis/cache';
import { readProject } from './project';

export const CLOUD_FOLDER = 'DJAW';
export const TRACKS_FOLDER = '曲';
export const PRESENCE_FOLDER = '使用中';
/** A computer counts as having the mix open while its note is younger than this. */
export const PRESENCE_TIMEOUT = 5 * 60 * 1000;

export function cloudPaths(root: string) {
  const dir = path.join(root, CLOUD_FOLDER);
  return { dir, tracks: path.join(dir, TRACKS_FOLDER), presence: path.join(dir, PRESENCE_FOLDER) };
}

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase().normalize('NFC') : r.normalize('NFC');
};

/** Whether `p` is inside the folder `root`. */
export function isInside(root: string | null | undefined, p: string | null | undefined): boolean {
  if (!root || !p) return false;
  const rel = path.relative(norm(root), norm(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** "SASAKI-PC（Windows）" — how this computer is named to the others. */
export function deviceName(): string {
  const host = os.hostname().replace(/\.local$/i, '').replace(/\.lan$/i, '');
  const kind = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac' : 'Linux';
  return `${host}（${kind}）`;
}

/** MEGA sync folders in the home folder: the app keeps a ".debris" folder in each sync root; the default names
 *  are "MEGA" and (older versions) "MEGAsync". Best guesses first. */
export function detectMegaRoots(home = os.homedir()): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (!out.some(x => norm(x) === norm(p))) out.push(p); };
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const tops: string[] = [];
  try { for (const n of fs.readdirSync(home)) tops.push(path.join(home, n)); } catch { /* unreadable */ }
  for (const d of [...tops, path.join(home, 'Documents', 'MEGA'), path.join(home, 'Documents', 'MEGAsync')]) {
    if (isDir(d) && isDir(path.join(d, '.debris'))) add(d);
  }
  for (const n of ['MEGA', 'MEGAsync', 'MEGA Sync']) {
    const d = path.join(home, n);
    if (isDir(d)) add(d);
  }
  return out;
}

/** Size and modification time: changes when the sync app brings in a version saved on another computer. */
export function fileStamp(p: string): string | null {
  try { const st = fs.statSync(p); return `${st.size}|${Math.round(st.mtimeMs)}`; } catch { return null; }
}

/** Writes a file so that the sync app never sees it half-written. */
export function writeFileAtomic(dest: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.saving`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest);
}

/** The same relative path in both Unicode forms (macOS often stores names decomposed, Windows composed). */
export function resolveRelative(dir: string, relativePath: string): string | null {
  for (const form of ['NFC', 'NFD'] as const) {
    const p = path.resolve(dir, relativePath.normalize(form).split('/').join(path.sep));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Copies the tracks that are not in the cloud folder yet into <root>/DJAW/曲 (a file already there with the same
 *  content is reused). Returns original path → path in the cloud folder for every file given. */
export async function copyTracksIntoCloud(files: string[], root: string,
  progress?: (done: number, total: number, name: string) => void): Promise<Map<string, string>> {
  const { tracks } = cloudPaths(root);
  const out = new Map<string, string>();
  const todo = [...new Set(files)].filter(f => {
    if (isInside(root, f)) { out.set(f, f); return false; }
    return fs.existsSync(f);
  });
  if (!todo.length) return out;
  fs.mkdirSync(tracks, { recursive: true });
  let done = 0;
  for (const src of todo) {
    progress?.(done, todo.length, path.basename(src));
    const fp = fingerprint(src);
    const ext = path.extname(src), base = path.basename(src, ext);
    let dest: string | null = null;
    for (let k = 1; k < 1000; k++) {
      const cand = path.join(tracks, k === 1 ? base + ext : `${base} (${k})${ext}`);
      if (!fs.existsSync(cand)) { dest = cand; break; }
      // Same content already there (copied from this or another computer): use it.
      if (fp && fingerprint(cand) === fp) { out.set(src, cand); dest = null; break; }
    }
    if (dest) {
      const tmp = path.join(tracks, `.${path.basename(dest)}.${process.pid}.copying`);
      await fs.promises.copyFile(src, tmp);
      // Keep the modification time, so the copy has the same fingerprint (analysis, artwork) as the original.
      const st = fs.statSync(src);
      fs.utimesSync(tmp, st.atime, st.mtime);
      fs.renameSync(tmp, dest);
      out.set(src, dest);
    }
    done++;
  }
  progress?.(done, todo.length, '');
  return out;
}

export interface CloudMixInfo {
  path: string;
  name: string;
  savedAt: string | null;
  savedOn: string | null;
  tracks: number;
  /** Tracks whose audio has not arrived on this computer yet (still syncing). */
  waiting: number;
  modified: number;
  projectID: string | null;
}

export function readCloudMix(file: string): CloudMixInfo | null {
  try {
    const f = readProject(file).file;
    const dir = path.dirname(file);
    const all = [...f.clips, ...(f.library ?? [])];
    const urls = new Set<string>();
    let waiting = 0;
    for (const c of all) {
      if (urls.has(c.url)) continue;
      urls.add(c.url);
      const here = fs.existsSync(c.url) || (!!c.relativePath && !!resolveRelative(dir, c.relativePath));
      if (!here && !c.mediaID) waiting++;
    }
    return {
      path: file, name: path.basename(file, path.extname(file)), savedAt: f.savedAt ?? null, savedOn: f.savedOn ?? null,
      tracks: f.clips.length, waiting, modified: fs.statSync(file).mtimeMs, projectID: f.projectID ?? null,
    };
  } catch { return null; }
}

/** The mixes in <root>/DJAW, newest first. */
export function listCloudMixes(root: string): CloudMixInfo[] {
  const { dir } = cloudPaths(root);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => /\.djaw$/i.test(n) && !n.startsWith('.'))
    .map(n => readCloudMix(path.join(dir, n))).filter((x): x is CloudMixInfo => !!x)
    .sort((a, b) => b.modified - a.modified);
}

export interface PresenceNote { device: string; at: number; title: string }

const presenceFile = (root: string, projectID: string, device: string) =>
  path.join(cloudPaths(root).presence, `${projectID}__${device.replace(/[\\/:*?"<>|]/g, '_')}.json`);

export const Presence = {
  write(root: string, projectID: string, title: string) {
    const device = deviceName();
    writeFileAtomic(presenceFile(root, projectID, device), JSON.stringify({ device, at: Date.now(), title } satisfies PresenceNote));
  },
  remove(root: string, projectID: string) {
    try { fs.rmSync(presenceFile(root, projectID, deviceName()), { force: true }); } catch { /* ignore */ }
  },
  /** Other computers that have this mix open now. */
  others(root: string, projectID: string, now = Date.now()): PresenceNote[] {
    const dir = cloudPaths(root).presence, me = deviceName();
    const out: PresenceNote[] = [];
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const n of names) {
      if (!n.startsWith(projectID + '__') || !n.endsWith('.json')) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as PresenceNote;
        if (p.device !== me && now - p.at < PRESENCE_TIMEOUT) out.push(p);
      } catch { /* half-synced */ }
    }
    return out;
  },
};
