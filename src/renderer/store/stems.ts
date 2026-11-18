// Separating tracks into vocals / drums / bass / melody when a transition's stem lanes need it (mac/DJAW/Store/MixStore+Stems.swift).
import path from 'node:path';
import { L } from '../../core/i18n';
import { Clip } from '../../core/models';
import { RenderSession } from '../../core/render/session';
import { separateStems, stemsAvailable, stemsFor } from '../services/analysis';
import type { StemFiles } from '../../core/analysis/stems';
import { MixStore } from './store';

declare module './store' {
  interface MixStore {
    stemProgress: Map<string, number>;
    stemRevision: number;
    /** Tracks whose stems the mix needs (a drawn vocal / instrumental lane in a transition in or out). */
    tracksNeedingStems(): string[];
    /** Starts separating the tracks that need it (in the background, one at a time). */
    prepareStemsIfNeeded(): void;
    prepareStems(urls: string[]): void;
    /** Before an export: separates the tracks that need it and waits for them (failures are left out). */
    ensureStemsForExport(): Promise<void>;
    /** The stem files of these clips, for those that use them and have them. */
    stemPaths(clips: Clip[]): Record<string, StemFiles>;
    /** Which of the needed stems exist (part of what the mix waveform depends on). */
    stemSignature(): string;
    stemsAvailable(): boolean;
    stemsFor(url: string): StemFiles | null;
  }
}

const P = MixStore.prototype;
const progress = new WeakMap<MixStore, Map<string, number>>();
Object.defineProperty(P, 'stemProgress', {
  get(this: MixStore) { let m = progress.get(this); if (!m) { m = new Map(); progress.set(this, m); } return m; },
});
P.stemRevision = 0;

let available: boolean | null = null;
P.stemsAvailable = () => (available ??= stemsAvailable());
P.stemsFor = url => stemsFor(url);

P.tracksNeedingStems = function () {
  const out: string[] = [];
  this.clips.forEach((c, i) => {
    if (RenderSession.usesStems(c, this.clips[i + 1]) && !out.includes(c.url)) out.push(c.url);
  });
  return out;
};

P.prepareStemsIfNeeded = function () {
  if (!this.stemsAvailable()) return;
  this.prepareStems(this.tracksNeedingStems().filter(u => !stemsFor(u)));
};

P.prepareStems = function (urls) {
  if (!this.stemsAvailable()) return;
  for (const url of urls) {
    if (this.stemProgress.has(url) || this.missingFiles.has(url)) continue;
    this.stemProgress.set(url, 0);
    this.changed();
    let last = 0;
    void separateStems(url, p => {
      if (p - last < 0.02 && p < 1) return;
      last = p;
      this.stemProgress.set(url, p);
      this.changed();
    }).then(() => true, e => { console.warn('[DJAW] stems:', (e as Error).message); return (e as Error).message; }).then(ok => {
      this.stemProgress.delete(url);
      this.stemRevision++;
      if (ok !== true) this.alertMessage = L(`ステムに分離できませんでした（${path.basename(url)}）\n${ok}`, `Could not separate the stems (${path.basename(url)})\n${ok}`);
      // The tracks now play from their stems: render again.
      this.mixInputsChanged();
      this.changed();
    });
  }
};

P.ensureStemsForExport = async function () {
  if (!this.stemsAvailable()) return;
  for (const url of this.tracksNeedingStems()) {
    if (this.missingFiles.has(url) || stemsFor(url)) continue;
    try { await separateStems(url); } catch (e) { console.warn('[DJAW] stems:', (e as Error).message); }
  }
  this.stemRevision++;
};

P.stemPaths = function (clips) {
  const out: Record<string, StemFiles> = {};
  clips.forEach((c, i) => {
    if (!RenderSession.usesStems(c, clips[i + 1])) return;
    const f = stemsFor(c.url);
    if (f) out[c.url] = f;
  });
  return out;
};

P.stemSignature = function () {
  return this.tracksNeedingStems().map(u => (stemsFor(u) ? '1' : '0')).join('');
};
