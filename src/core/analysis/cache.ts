// Content fingerprint and the analysis cache (mac/DJAW/Audio/AnalysisCache.swift).
// Key = SHA-256 of "<size>" + first 256 KB (+ last 256 KB when the file is bigger than 512 KB), the same as on the
// Mac, so caches, profiles and stems are found again for copied, moved or unpacked files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const keys = new Map<string, { stamp: string; key: string }>();

export function fingerprint(file: string): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const stamp = `${st.size}|${st.mtimeMs}`;
  const k = keys.get(file);
  if (k && k.stamp === stamp) return k.key;
  const chunk = 256 << 10;
  const h = crypto.createHash('sha256');
  h.update(`${st.size}`);
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(chunk, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (st.size > 2 * chunk) {
      const tail = Buffer.alloc(chunk);
      fs.readSync(fd, tail, 0, chunk, st.size - chunk);
      h.update(tail);
    }
  } finally {
    fs.closeSync(fd);
  }
  const key = h.digest('hex');
  keys.set(file, { stamp, key });
  return key;
}

// MARK: Binary packing of objects with typed arrays (analysis results are mostly Float32Arrays).

/** Object → buffer: JSON with every Float32Array / Float64Array moved to a binary tail. */
export function pack(value: unknown): Buffer {
  const blobs: Buffer[] = [];
  let offset = 0;
  const json = JSON.stringify(value, (_k, v) => {
    if (v instanceof Float32Array || v instanceof Float64Array) {
      const b = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      const ref = { $t: v instanceof Float32Array ? 'f32' : 'f64', o: offset, n: v.length };
      blobs.push(Buffer.from(b));
      offset += b.length;
      return ref;
    }
    return v;
  });
  const head = Buffer.from(json, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(head.length, 0);
  return Buffer.concat([Buffer.from('DJAWPK1\0'), len, head, ...blobs]);
}

export function unpack<T>(buf: Buffer): T {
  if (buf.subarray(0, 8).toString('latin1') !== 'DJAWPK1\0') throw new Error('not a packed analysis');
  const n = buf.readUInt32LE(8);
  const json = buf.subarray(12, 12 + n).toString('utf8');
  const base = 12 + n;
  return JSON.parse(json, (_k, v) => {
    if (v && typeof v === 'object' && (v.$t === 'f32' || v.$t === 'f64')) {
      const bytes = v.n * (v.$t === 'f32' ? 4 : 8);
      const copy = new Uint8Array(bytes);
      copy.set(buf.subarray(base + v.o, base + v.o + bytes));
      return v.$t === 'f32' ? new Float32Array(copy.buffer) : new Float64Array(copy.buffer);
    }
    return v;
  }) as T;
}

/** Bump when the analysis itself changes (older entries are then analysed again). */
export const ANALYSIS_VERSION = 1;

export class AnalysisStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  private file(key: string, kind: string) { return path.join(this.dir, `${key}.${kind}`); }
  load<T>(key: string, kind = 'analysis'): T | null {
    try {
      const v = unpack<{ version: number; value: T }>(fs.readFileSync(this.file(key, kind)));
      return v.version === ANALYSIS_VERSION ? v.value : null;
    } catch { return null; }
  }
  store(key: string, value: unknown, kind = 'analysis') {
    const tmp = this.file(key, kind) + '.tmp';
    fs.writeFileSync(tmp, pack({ version: ANALYSIS_VERSION, value }));
    fs.renameSync(tmp, this.file(key, kind));
  }
  /** Raw blob (to save inside a .djaw). */
  blob(key: string, kind = 'analysis'): Buffer | null {
    try { return fs.readFileSync(this.file(key, kind)); } catch { return null; }
  }
  importBlob(key: string, data: Buffer, kind = 'analysis') {
    if (fs.existsSync(this.file(key, kind))) return;
    try {
      const v = unpack<{ version: number }>(data);
      if (v.version === ANALYSIS_VERSION) fs.writeFileSync(this.file(key, kind), data);
    } catch { /* not ours */ }
  }
}
