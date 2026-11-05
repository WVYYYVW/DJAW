// Track profiles (title, artist, album, artwork, …) — mac/DJAW/Media/TrackProfiles.swift and MixStore+Profiles.swift.
// Kept per audio content (fingerprint) in userData/Profiles/<fp>.json and inside every .djaw that uses the track
// (the same JSON as the Mac app: artwork is base64 JPEG).
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint } from '../../core/analysis/cache';
import { dataDir } from './env';

export interface TrackProfile {
  title: string;
  artist: string;
  album?: string;
  year?: string;
  genre?: string;
  label?: string;
  comment?: string;
  /** Base64 JPEG chosen in DJAW (null = the artwork inside the audio file, if any). */
  artwork?: string | null;
  /** The user removed the artwork (also the one inside the file). */
  noArtwork?: boolean | null;
}

const folder = () => { const d = dataDir('Profiles'); fs.mkdirSync(d, { recursive: true }); return d; };
const fileOf = (key: string) => path.join(folder(), key + '.json');

export const TrackProfiles = {
  loadKey(key: string): TrackProfile | null {
    try { return JSON.parse(fs.readFileSync(fileOf(key), 'utf8')) as TrackProfile; } catch { return null; }
  },
  load(url: string): TrackProfile | null {
    const key = fingerprint(url);
    return key ? TrackProfiles.loadKey(key) : null;
  },
  store(p: TrackProfile, url: string) {
    const key = fingerprint(url);
    if (key) try { fs.writeFileSync(fileOf(key), JSON.stringify(p)); } catch { /* ignore */ }
  },
  /** Profiles of these files, keyed by fingerprint (to save inside a .djaw). */
  blobs(urls: string[]): Record<string, TrackProfile> | null {
    const out: Record<string, TrackProfile> = {};
    for (const u of new Set(urls)) {
      const key = fingerprint(u);
      const p = key ? TrackProfiles.loadKey(key) : null;
      if (key && p) out[key] = p;
    }
    return Object.keys(out).length ? out : null;
  },
  /** Takes over profiles saved in a .djaw (a profile edited on this computer wins). */
  importBlobs(blobs: Record<string, unknown> | null | undefined) {
    for (const [key, p] of Object.entries(blobs ?? {})) {
      if (!/^[0-9a-f]{64}$/i.test(key) || fs.existsSync(fileOf(key))) continue;
      try { fs.writeFileSync(fileOf(key), JSON.stringify(p)); } catch { /* ignore */ }
    }
  },
  /** The artwork stored inside the audio file (ID3 / MP4 tags), if any. */
  async embeddedArtwork(url: string): Promise<Uint8Array | null> {
    try {
      const mm = (await import('music-metadata')) as unknown as { parseFile(f: string, o: object): Promise<{ common: { picture?: { data: Uint8Array }[] } }> };
      const m = await mm.parseFile(url, { duration: false });
      return m.common.picture?.[0]?.data ?? null;
    } catch { return null; }
  },
  /** Any image as a JPEG of at most `maxSize` px (base64), for storing. */
  async normalizedJPEG(data: Uint8Array | Blob, maxSize = 800): Promise<string | null> {
    try {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
      const out = await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
      return Buffer.from(await out.arrayBuffer()).toString('base64');
    } catch { return null; }
  },
};

