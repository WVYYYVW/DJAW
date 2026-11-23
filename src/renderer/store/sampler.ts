// The sampler in the store: 8 pads of short sounds, and hits placed on the mix's beat grid (core/sampler.ts).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ipcRenderer } from 'electron';
import { L } from '../../core/i18n';
import { ShownName } from '../../core/defaultNames';
import { PADS, Sample, SampleHit, Sampler, SamplerInput } from '../../core/sampler';
import { fingerprint } from '../../core/analysis/cache';
import { openPcmFile } from '../../core/render/source';
import { ensurePcm } from '../services/decode';
import { MixStore, audioExtensions } from './store';
import { builtinByFile, standardKit } from '../../core/builtinSamples';
import { builtinSampleDir } from '../services/env';

declare module './store' {
  interface MixStore {
    showSampler: boolean;
    /** Placing a hit snaps to this many beats. */
    samplerSnap: number;
    /** While on and playing, pads hit are placed where they were hit. */
    samplerRecording: boolean;
    selectedHit: string | null;
    /** Sample id → decoded PCM file and its length (seconds). */
    samplePcm: Map<string, { path: string; seconds: number }>;
    addSamples(files: string[], pad?: number, names?: string[]): Promise<void>;
    /** DJAW's own sounds (core/builtinSamples.ts) onto a pad, or the next free ones. */
    addBuiltinSamples(files: string[], pad?: number): Promise<void>;
    /** Fills the empty pads with the standard kit. */
    loadStandardKit(): Promise<void>;
    chooseSamples(pad?: number): Promise<void>;
    removeSample(id: string): void;
    renameSample(id: string, name: string): void;
    setSampleGain(id: string, db: number): void;
    auditionSample(id: string): void;
    /** A pad pressed (click or key): heard at once; placed at the playhead while recording. */
    triggerPad(pad: number): void;
    placeHit(sample: string, beat?: number): SampleHit | null;
    moveHit(id: string, beat: number, undoable?: boolean): void;
    setHitRoll(id: string, repeats: number, every?: number): void;
    setHitGain(id: string, db: number): void;
    removeHit(id: string): void;
    snapBeat(beat: number): number;
    playheadBeat(): number;
    samplerMessage(): { input: SamplerInput; paths: Record<string, string> };
    samplerKey(): string;
    /** Decodes the samples of a loaded mix. */
    prepareSamples(): Promise<void>;
  }
}

const P = MixStore.prototype;
Object.assign(P, { showSampler: false, samplerSnap: 1, samplerRecording: false, selectedHit: null });
Object.defineProperty(P, 'samplePcm', {
  get(this: MixStore & { _samplePcm?: Map<string, { path: string; seconds: number }> }) { return (this._samplePcm ??= new Map()); },
});

/** A built-in sound saved with another install's path (another computer, another system): the same file here. */
function relinkBuiltin(url: string): string | null {
  const name = path.basename(url.replace(/\\/g, '/'));
  if (!/[\\/]assets[\\/]samples[\\/]/.test(url) || !builtinByFile(name)) return null;
  const here = path.join(builtinSampleDir(), name);
  return fs.existsSync(here) ? here : null;
}

/**
 * The name shown for a sampler sound: a built-in sound that still has its own name (in whichever language it was
 * added) shows it in the language in effect; renamed or own sounds show their name.
 */
export function sampleName(sample: { url: string; name: string }): string {
  const file = /[\\/]assets[\\/]samples[\\/]/.test(sample.url) ? path.basename(sample.url.replace(/\\/g, '/')) : null;
  return ShownName.sample(file, sample.name);
}

/** Short sounds only: longer files would be tracks. */
const MAX_SECONDS = 60;

async function decode(file: string) {
  const fp = fingerprint(file);
  if (!fp) throw new Error(L('読み込めません', 'Cannot read'));
  const pcm = await ensurePcm(file, fp);
  const src = openPcmFile(pcm);
  const seconds = src ? src.frames / src.sampleRate : 0;
  src?.close();
  return { path: pcm, seconds };
}

P.prepareSamples = async function () {
  // Built-in sounds saved on another computer point at that computer's copy: use this one's.
  if (this.samples.some(s => !fs.existsSync(s.url) && relinkBuiltin(s.url))) {
    this.samples = this.samples.map(s => { const here = !fs.existsSync(s.url) ? relinkBuiltin(s.url) : null; return here ? { ...s, url: here } : s; });
  }
  for (const s of this.samples) {
    if (this.samplePcm.has(s.id) || !fs.existsSync(s.url)) continue;
    try { this.samplePcm.set(s.id, await decode(s.url)); } catch { /* shown as missing */ }
  }
  this.changed();
};

P.addSamples = async function (files, pad, names) {
  const audio = files.filter(f => audioExtensions.has(path.extname(f).slice(1).toLowerCase()));
  const nameOf = (f: string) => names?.[files.indexOf(f)] ?? path.basename(f, path.extname(f));
  if (!audio.length) return;
  const added: Sample[] = [];
  const problems: string[] = [];
  for (const f of audio) {
    try {
      const d = await decode(f);
      if (d.seconds > MAX_SECONDS) { problems.push(L(`${path.basename(f)}（${Math.round(d.seconds)}秒：サンプラーは${MAX_SECONDS}秒までです。曲として追加してください）`, `${path.basename(f)} (${Math.round(d.seconds)} s: the sampler takes up to ${MAX_SECONDS} s; add it as a track)`)); continue; }
      const s = Sampler.newSample(f, nameOf(f), (this.samples.length + added.length) % 12);
      this.samplePcm.set(s.id, d);
      added.push(s);
    } catch (e) { problems.push(`${path.basename(f)}（${(e as Error).message}）`); }
  }
  if (added.length) {
    this.pushUndo();
    const pads = [...this.samples];
    if (pad != null && pad < pads.length) {
      // Replacing a pad keeps its hits (they now play the new sound).
      const old = pads[pad];
      pads[pad] = { ...added[0], id: old.id, colorIndex: old.colorIndex };
      this.samplePcm.set(old.id, this.samplePcm.get(added[0].id)!);
      added.shift();
    }
    for (const s of added) if (pads.length < PADS) pads.push(s); else problems.push(L(`${s.name}（パッドが空いていません）`, `${s.name} (no free pad)`));
    this.samples = pads;
    this.panelTab = 'sampler';
    this.showPanel = true;
  }
  if (problems.length) this.alertMessage = L(`サンプラーに入れられなかったファイル：\n${problems.join('\n')}`, `Not added to the sampler:\n${problems.join('\n')}`);
  this.changed();
};

P.addBuiltinSamples = async function (files, pad) {
  const dir = builtinSampleDir();
  const ok = files.filter(f => builtinByFile(f) && fs.existsSync(path.join(dir, f)));
  if (!ok.length) { this.alertMessage = L('標準サンプルが見つかりません（DJAW を入れ直してください）', 'The built-in sounds are missing (reinstall DJAW)'); this.changed(); return; }
  await this.addSamples(ok.map(f => path.join(dir, f)), pad, ok.map(f => builtinByFile(f)!.title()));
};

P.loadStandardKit = async function () {
  const free = PADS - this.samples.length;
  if (free <= 0) return;
  // The kit's sounds not on a pad yet, in kit order.
  const have = new Set(this.samples.map(s => path.basename(s.url)));
  await this.addBuiltinSamples(standardKit.filter(f => !have.has(f)).slice(0, free));
};

P.chooseSamples = async function (pad) {
  const r: string[] | null = await ipcRenderer.invoke('dialog:open', {
    title: L('サンプラーに読み込む音', 'Sounds for the Sampler'), properties: pad != null ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: [{ name: L('音声', 'Audio'), extensions: [...audioExtensions] }],
  });
  if (r && r.length) await this.addSamples(r, pad);
};

P.removeSample = function (id) {
  this.pushUndo();
  this.samples = this.samples.filter(s => s.id !== id);
  this.sampleHits = this.sampleHits.filter(h => h.sample !== id);
  this.changed();
};

P.renameSample = function (id, name) {
  const t = name.trim();
  if (!t) return;
  this.pushUndo();
  this.samples = this.samples.map(s => (s.id === id ? { ...s, name: t } : s));
  this.changed();
};

P.setSampleGain = function (id, db) {
  this.pushUndo();
  this.samples = this.samples.map(s => (s.id === id ? { ...s, gainDB: Math.max(-24, Math.min(12, db)) } : s));
  this.changed();
};

let audition: HTMLAudioElement | null = null;
P.auditionSample = function (id) {
  const s = this.samples.find(x => x.id === id);
  if (!s || !fs.existsSync(s.url)) return;
  audition?.pause();
  audition = new Audio(pathToFileURL(s.url).href);
  audition.volume = Math.min(1, Math.pow(10, s.gainDB / 20));
  void audition.play().catch(() => {});
};

P.snapBeat = function (beat) {
  const u = this.samplerSnap > 0 ? this.samplerSnap : 1;
  return Math.round(beat / u) * u;
};

P.playheadBeat = function () { return Sampler.beatOfTime(this.playhead, this.masterBPM, this.gridOffset); };

P.triggerPad = function (pad) {
  const s = this.samples[pad];
  if (!s) { void this.chooseSamples(pad); return; }
  if (this.samplerRecording && this.isPlaying) {
    // Placed where it was hit (the preview plays ahead, so it is heard from the next pass).
    this.placeHit(s.id, this.snapBeat(Sampler.beatOfTime(this.player.currentTime, this.masterBPM, this.gridOffset)));
  }
  this.auditionSample(s.id);
};

P.placeHit = function (sample, beat) {
  if (!this.samples.some(s => s.id === sample)) return null;
  const b = beat ?? this.snapBeat(this.playheadBeat());
  // Not twice at the same place.
  if (this.sampleHits.some(h => h.sample === sample && Math.abs(h.beat - b) < 1e-6)) return null;
  this.pushUndo();
  const h = Sampler.newHit(sample, b);
  this.sampleHits = [...this.sampleHits, h];
  this.selectedHit = h.id;
  this.changed();
  return h;
};

P.moveHit = function (id, beat, undoable = true) {
  if (undoable) this.pushUndo(); else this.markDirty();
  this.sampleHits = this.sampleHits.map(h => (h.id === id ? { ...h, beat } : h));
  this.changed();
};

P.setHitRoll = function (id, repeats, every) {
  this.pushUndo();
  this.sampleHits = this.sampleHits.map(h => (h.id === id ? { ...h, repeats: Math.max(0, repeats), every: every ?? h.every ?? 1 } : h));
  this.changed();
};

P.setHitGain = function (id, db) {
  this.pushUndo();
  this.sampleHits = this.sampleHits.map(h => (h.id === id ? { ...h, gainDB: Math.max(-24, Math.min(12, db)) } : h));
  this.changed();
};

P.removeHit = function (id) {
  this.pushUndo();
  this.sampleHits = this.sampleHits.filter(h => h.id !== id);
  if (this.selectedHit === id) this.selectedHit = null;
  this.changed();
};

P.samplerMessage = function () {
  // Always sent (even with no hits), so pads loaded while playing are heard without starting again.
  const paths: Record<string, string> = {};
  const ready = this.samples.filter(s => { const p = this.samplePcm.get(s.id); if (p) paths[s.id] = p.path; return !!p; });
  return { input: Sampler.expand(ready, this.sampleHits, this.masterBPM, this.gridOffset), paths };
};

P.samplerKey = function () {
  const m = this.samplerMessage();
  return m.input.hits.length ? JSON.stringify([m.input.hits, Object.keys(m.paths)]) : '';
};
