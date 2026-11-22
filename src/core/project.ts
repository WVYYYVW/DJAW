// The .djaw file (mac/DJAW/Store/ProjectContainer.swift):
//   "DJAWPACK" (8 bytes) · version UInt32 LE · jsonLength UInt64 LE · JSON (ProjectFile) · embedded audio files back to back
// or plain JSON (older files, autosaves). Audio is stored byte-for-byte as the original files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Clip, MediaEntry, ProjectFile } from './models';

export const MAGIC = Buffer.from('DJAWPACK', 'utf8');
export const CONTAINER_VERSION = 1;

export interface OpenedProject {
  file: ProjectFile;
  /** Byte offset of the first embedded file (null for plain JSON files). */
  blobStart: number | null;
}

/** A clip's `url` as stored by the Mac app ("file:///Users/…") or by this app → a local path. */
export function urlToPath(u: string): string {
  if (!u) return u;
  if (u.startsWith('file:')) {
    try { return fileURLToPath(u); } catch { /* a Mac URL on Windows */ }
    return decodeURIComponent(u.replace(/^file:\/\//, ''));
  }
  return u;
}

export const pathToUrl = (p: string) => pathToFileURL(p).href;

export function readProject(file: string): OpenedProject {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(20);
    const n = fs.readSync(fd, head, 0, 20, 0);
    if (n === 20 && head.subarray(0, 8).equals(MAGIC)) {
      const length = Number(head.readBigUInt64LE(12));
      const json = Buffer.alloc(length);
      fs.readSync(fd, json, 0, length, 20);
      return { file: parse(json.toString('utf8')), blobStart: 20 + length };
    }
  } finally {
    fs.closeSync(fd);
  }
  return { file: parse(fs.readFileSync(file, 'utf8')), blobStart: null };
}

function parse(json: string): ProjectFile {
  const f = JSON.parse(json) as ProjectFile;
  const fix = (c: Clip) => { c.url = urlToPath(c.url); return c; };
  f.clips = (f.clips ?? []).map(fix);
  f.library = (f.library ?? []).map(fix);
  if (f.layers) f.layers = f.layers.map(fix);
  return f;
}

/** JSON as the Mac app writes it: keys sorted, pretty-printed, URLs as file URLs. */
export function encodeProject(p: ProjectFile): string {
  const out = structuredClone(p);
  const fix = (c: Clip) => { c.url = pathToUrl(c.url); return c; };
  out.clips = out.clips.map(fix);
  if (out.library) out.library = out.library.map(fix);
  if (out.layers) out.layers = out.layers.map(fix);
  return JSON.stringify(sortKeys(out), null, 2);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined || x === null) continue;   // Swift omits nil optionals
      o[k] = sortKeys(x);
    }
    return o;
  }
  return v;
}

/** Writes the project with the given audio files embedded (atomically: temp file, then rename). */
export function writeProject(p: ProjectFile, media: { id: string; file: string }[], dest: string) {
  const entries: MediaEntry[] = [];
  let offset = 0;
  for (const m of media) {
    const size = fs.statSync(m.file).size;
    entries.push({ id: m.id, fileName: storedName(m.id, m.file), offset, length: size });
    offset += size;
  }
  const json = Buffer.from(encodeProject({ ...p, media: entries.length ? entries : null }), 'utf8');
  const tmp = dest + '.saving';
  const fd = fs.openSync(tmp, 'w');
  try {
    const header = Buffer.alloc(20);
    MAGIC.copy(header, 0);
    header.writeUInt32LE(CONTAINER_VERSION, 8);
    header.writeBigUInt64LE(BigInt(json.length), 12);
    fs.writeSync(fd, header);
    fs.writeSync(fd, json);
    const chunk = Buffer.alloc(4 << 20);
    for (const [k, m] of media.entries()) {
      const src = fs.openSync(m.file, 'r');
      let copied = 0;
      while (copied < entries[k].length) {
        const n = fs.readSync(src, chunk, 0, Math.min(chunk.length, entries[k].length - copied), copied);
        if (n <= 0) break;
        fs.writeSync(fd, chunk, 0, n);
        copied += n;
      }
      fs.closeSync(src);
      if (copied !== entries[k].length) throw new Error(`could not read ${m.file}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
}

/** Copies one embedded audio file out of the package (skipped if already extracted). */
export function extractMedia(m: MediaEntry, project: string, blobStart: number, dest: string) {
  try {
    if (fs.statSync(dest).size === m.length) return;
  } catch { /* not there yet */ }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = dest + '.part';
  const src = fs.openSync(project, 'r');
  const out = fs.openSync(partial, 'w');
  try {
    const chunk = Buffer.alloc(4 << 20);
    let done = 0;
    while (done < m.length) {
      const n = fs.readSync(src, chunk, 0, Math.min(chunk.length, m.length - done), blobStart + m.offset + done);
      if (n <= 0) throw new Error('the .djaw file is damaged');
      fs.writeSync(out, chunk, 0, n);
      done += n;
    }
  } finally {
    fs.closeSync(src);
    fs.closeSync(out);
  }
  fs.renameSync(partial, dest);
}

/** The file name kept in the package, without the "<mediaID>-" prefixes that unpacking adds. */
function storedName(id: string, file: string) {
  let name = path.basename(file);
  while (name.startsWith(id + '-')) name = name.slice(id.length + 1);
  return name;
}

/** Same as `writeProject`, without blocking (the UI stays responsive while hundreds of MB are written). */
/** `name`: the file name to store (e.g. "Track.flac" for a WAV compressed on the way in); default: the file's own. */
export async function writeProjectAsync(p: ProjectFile, media: { id: string; file: string; name?: string }[], dest: string) {
  const entries: MediaEntry[] = [];
  let offset = 0;
  for (const m of media) {
    const size = (await fs.promises.stat(m.file)).size;
    entries.push({ id: m.id, fileName: m.name ?? storedName(m.id, m.file), offset, length: size });
    offset += size;
  }
  const json = Buffer.from(encodeProject({ ...p, media: entries.length ? entries : null }), 'utf8');
  const tmp = dest + '.saving';
  const out = await fs.promises.open(tmp, 'w');
  try {
    const header = Buffer.alloc(20);
    MAGIC.copy(header, 0);
    header.writeUInt32LE(CONTAINER_VERSION, 8);
    header.writeBigUInt64LE(BigInt(json.length), 12);
    await out.write(header);
    await out.write(json);
    const chunk = Buffer.alloc(4 << 20);
    for (const [k, m] of media.entries()) {
      const src = await fs.promises.open(m.file, 'r');
      let copied = 0;
      try {
        while (copied < entries[k].length) {
          const { bytesRead } = await src.read(chunk, 0, Math.min(chunk.length, entries[k].length - copied), copied);
          if (bytesRead <= 0) break;
          await out.write(chunk, 0, bytesRead);
          copied += bytesRead;
        }
      } finally {
        await src.close();
      }
      if (copied !== entries[k].length) throw new Error(`could not read ${m.file}`);
    }
  } finally {
    await out.close();
  }
  await fs.promises.rename(tmp, dest);
}

/** Same as `extractMedia`, without blocking. */
export async function extractMediaAsync(m: MediaEntry, project: string, blobStart: number, dest: string) {
  try {
    if ((await fs.promises.stat(dest)).size === m.length) return;
  } catch { /* not there yet */ }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const partial = dest + '.part';
  const src = await fs.promises.open(project, 'r');
  const out = await fs.promises.open(partial, 'w');
  try {
    const chunk = Buffer.alloc(4 << 20);
    let done = 0;
    while (done < m.length) {
      const { bytesRead } = await src.read(chunk, 0, Math.min(chunk.length, m.length - done), blobStart + m.offset + done);
      if (bytesRead <= 0) throw new Error('the .djaw file is damaged');
      await out.write(chunk, 0, bytesRead);
      done += bytesRead;
    }
  } finally {
    await src.close();
    await out.close();
  }
  await fs.promises.rename(partial, dest);
}

/** Where audio from a package is unpacked: <appData>/DJAW/Media/<project>/ */
export const mediaFolder = (appData: string, projectID: string) => path.join(appData, 'DJAW', 'Media', projectID);

/** File name of an embedded track once unpacked (as on the Mac: "<mediaID>-<file name>"). */
export const unpackedName = (m: MediaEntry) => `${m.id}-${m.fileName}`;
