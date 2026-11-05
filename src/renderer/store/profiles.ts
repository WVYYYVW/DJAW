// Track profiles in the store (mac/DJAW/Store/MixStore+Profiles.swift); the files themselves: services/trackProfiles.ts.
import path from 'node:path';
import { MixStore } from './store';
import { TrackProfile, TrackProfiles } from '../services/trackProfiles';

export { TrackProfiles };
export type { TrackProfile };

declare module './store' {
  interface MixStore {
    trackProfile(url: string, title: string, artist: string): TrackProfile;
    openProfileEditor(id: string): void;
    saveProfile(p: TrackProfile, url: string): void;
    artwork(url: string): ImageBitmap | null;
    artworkData(url: string): Promise<Uint8Array | null>;
    applySavedProfiles(): void;
  }
}

const P = MixStore.prototype;

P.trackProfile = function (url, title, artist) { return TrackProfiles.load(url) ?? { title, artist }; };
P.openProfileEditor = function (id) { if (this.clip(id)) { this.profileEditorTarget = id; this.changed(); } };

P.saveProfile = function (p, url) {
  const q = { ...p, title: p.title.trim(), artist: p.artist.trim() };
  if (!q.title) q.title = path.basename(url, path.extname(url));
  this.pushUndo();
  TrackProfiles.store(q, url);
  this.clips = this.clips.map(c => (c.url === url ? { ...c, title: q.title, artist: q.artist } : c));
  this.library = this.library.map(c => (c.url === url ? { ...c, title: q.title, artist: q.artist } : c));
  this.artworkCache.delete(url);
  this.artworkRevision++;
  this.changed();
};

P.artworkData = async function (url) {
  const p = TrackProfiles.load(url);
  if (p?.noArtwork) return null;
  if (p?.artwork) return new Uint8Array(Buffer.from(p.artwork, 'base64'));
  return TrackProfiles.embeddedArtwork(url);
};

P.artwork = function (url) {
  if (this.artworkCache.has(url)) return this.artworkCache.get(url)!;
  if (this.artworkLoading.has(url)) return null;
  this.artworkLoading.add(url);
  void (async () => {
    let img: ImageBitmap | null = null;
    try {
      const d = await this.artworkData(url);
      if (d) {
        const bmp = await createImageBitmap(new Blob([d]));
        const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
        img = k < 1 ? await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' }) : bmp;
      }
    } catch { img = null; }
    this.artworkLoading.delete(url);
    this.artworkCache.set(url, img);
    this.artworkRevision++;
    this.changed();
  })();
  return null;
};

P.applySavedProfiles = function () {
  const cache = new Map<string, TrackProfile | null>();
  const p = (u: string) => { if (!cache.has(u)) cache.set(u, TrackProfiles.load(u)); return cache.get(u)!; };
  const fix = (c: (typeof this.clips)[number]) => { const pr = p(c.url); return pr && (c.title !== pr.title || c.artist !== pr.artist) ? { ...c, title: pr.title, artist: pr.artist } : c; };
  this.clips = this.clips.map(fix);
  this.library = this.library.map(fix);
};
