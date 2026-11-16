// Video export and the live visual preview's track list (mac/DJAW/Store/MixStore.swift startVideoExport,
// MixStore+Profiles.swift previewTrackVisuals).
import fs from 'node:fs';
import { ipcRenderer } from 'electron';
import { L } from '../../core/i18n';
import { Automation } from '../../core/automation';
import { ClipPalette, clipEnd } from '../../core/models';
import { TrackVisual, VisualStyle, artworkPalette, visualSections } from '../../core/visuals';
import type { TrackVisualMessage } from '../../core/render/video';
import { Jobs } from '../services/jobs';
import { MixStore } from './store';

export type VideoSize = '1920x1080' | '1280x720' | '1080x1920';

declare module './store' {
  interface MixStore {
    exportVideo: boolean;
    visualStyle: VisualStyle;
    videoSize: VideoSize;
    visualShowInfo: boolean;
    visualShowTitle: boolean;
    /** Seconds per stage of the last video export, and whether the GPU encoded it. */
    lastVideoStats: { total: number; frames: number; draw: number; frame: number; hardware: number; seconds: number } | null;
    /** GPU features Chromium uses (from the main process) and the GPU's name. */
    gpuStatus: { features: Record<string, string>; devices: string[] } | null;
    loadGPUStatus(): Promise<void>;
    /** The live visuals preview window is open. */
    showVisualPreview: boolean;
    startVideoExport(): Promise<void>;
    /** Where each track comes in, takes over and ends (real seconds), its colour and structure, without artwork. */
    trackTimeline(): Omit<TrackVisual, 'artwork' | 'palette'>[];
    /** Tracks as the visuals see them, for the live preview (artwork from the cache; may still be loading). */
    previewTrackVisuals(): TrackVisual[];
  }
}

const P = MixStore.prototype;
Object.assign(P, { exportVideo: false, visualStyle: 'pulse' as VisualStyle, videoSize: '1920x1080' as VideoSize, visualShowInfo: true, visualShowTitle: true, showVisualPreview: false, lastVideoStats: null, gpuStatus: null });

P.loadGPUStatus = async function () {
  if (this.gpuStatus) return;
  try { this.gpuStatus = await ipcRenderer.invoke('gpu:status'); } catch { this.gpuStatus = { features: {}, devices: [] }; }
  this.changed();
};

P.trackTimeline = function () {
  const tempo = this.tempoMap, master = this.masterBPM;
  const all = this.playableClips();
  return all.map((c, i) => {
    const start = tempo.real(c.start);
    const landing = tempo.real(Automation.switchTime(all, i, master));
    return {
      title: c.title, artist: c.artist, hue: ClipPalette.hue(c.colorIndex),
      start, landing: Math.max(start, landing), end: tempo.real(clipEnd(c, master)),
      sections: visualSections(c, this.structures.get(c.url), master, tempo),
    };
  });
};

P.previewTrackVisuals = function () {
  const urls = this.playableClips().map(c => c.url);
  return this.trackTimeline().map((t, i) => {
    const art = this.artwork(urls[i]);
    return { ...t, artwork: art, palette: artworkPalette(art) };
  });
};

P.startVideoExport = async function () {
  const dest: string | null = await ipcRenderer.invoke('dialog:save', {
    title: L('書き出し', 'Export'), defaultPath: this.documentTitle + '.mp4',
    filters: [{ name: 'MP4', extensions: ['mp4'] }],
  });
  if (!dest) return;
  this.pause();
  this.saveSettings();
  this.exportPhase = { kind: 'rendering', progress: 0 };
  this.exportStartedAt = Date.now();
  this.exportSteady = null;
  this.lastVideoStats = null;
  this.changed();
  const [w, h] = this.videoSize.split('x').map(Number);
  await this.ensureStemsForExport();
  const knownPeak = this.exportSampleRate === 44100 ? this.knownMixPeak() : null;
  const mix = this.mixMessage();
  const timeline = this.trackTimeline();
  const tracks: TrackVisualMessage[] = [];
  for (let i = 0; i < timeline.length; i++) {
    let art: Uint8Array | null = null;
    try { art = await this.artworkData(mix.clips[i].url); } catch { art = null; }
    tracks.push({ ...timeline[i], artwork: art });
  }
  const options = {
    width: w || 1920, height: h || 1080, fps: 30, style: this.visualStyle, showTrackInfo: this.visualShowInfo,
    mixTitle: this.visualShowTitle ? this.documentTitle : '', sampleRate: this.exportSampleRate, normalize: this.exportNormalize,
  };
  const job = Jobs.video(mix, dest, options, tracks, knownPeak, p => {
    if (this.exportPhase.kind !== 'rendering') return;
    this.exportPhase = { kind: 'rendering', progress: p };
    // Only the drawing part runs at a steady pace.
    if (!this.exportSteady && p > 0.41) this.exportSteady = { progress: p, at: Date.now() };
    this.changed();
  });
  this.exportJob = job;
  try {
    const r = await job.promise;
    if (r?.stats) console.info('[DJAW] video export (s):', JSON.stringify(r.stats));
    this.lastVideoStats = r?.stats ? { ...(r.stats as never as { total: number; frames: number; draw: number; frame: number; hardware: number }), seconds: this.realMixDuration } : null;
    this.exportPhase = { kind: 'done', path: dest };
  } catch (e) {
    if ((e as Error).message === 'cancelled') { try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ } this.exportPhase = { kind: 'idle' }; }
    else this.exportPhase = { kind: 'failed', message: (e as Error).message };
  }
  this.exportJob = null;
  this.changed();
};
