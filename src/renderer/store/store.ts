// The app state (port of mac/DJAW/Store/MixStore.swift and its extensions, stage-1 part):
// the mix, selection, playback, undo, editing operations, documents and export.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ipcRenderer, clipboard, shell } from 'electron';
import { L } from '../../core/i18n';
import { LibraryFolder,
  Clip, ClipFX, ClipEdit, CustomTransition, FXKind, Grid, LoudnessMode, loudnessModes, Mathx, ProjectFile, SnapUnit, Snap, Style,
  Take, TransitionLanes, TransitionPreset, TransitionShape, TransitionStyle, TransitionTake, Waveform, EQBand,
  barAtSource, barLabel, barSource, clipEnd, clipLength, effectiveLanes, keepsLanding, landingBar, lastBar,
  lastSoundTime, newClip, projectFormatID, projectVersion, resetToWholeTrack, sourceTimeAtBar, sourceTimeAtTimeline,
  timelineTimeOfBar, transitionPresets, transitionShape, uuid, Lanes, semitoneShift, Loudness, TempoStart, } from '../../core/models';
import { FX, OutroFX, TempoMap, outro } from '../../core/tempo';
import { layout, separateNeighbourColors, updateCutNudges } from '../../core/layout';
import { endWithLayers, layerDecks, placeLayers } from '../../core/layers';
import { extractMediaAsync, mediaFolder, readProject, writeProjectAsync, unpackedName, encodeProject } from '../../core/project';
import { BandEnergies, TempoOption, TrackAnalysis, onsetOffset, structureFor, structureTrusted } from '../../core/analysis/analyzer';
import { Key, MusicalKey, Structure, TrackStructure } from '../../core/analysis/structure';
import { NeuralResult, beatHitRate } from '../../core/analysis/neural';
import { integratedLoudness } from '../../core/analysis/loudness';
import { fingerprint } from '../../core/analysis/cache';
import { RenderSession } from '../../core/render/session';
import { Automation } from '../../core/automation';
import { analyze, analyzeQuick, cachedAnalysis, loudness as loadLoudness } from '../services/analysis';
import { enginePath, ensurePcm } from '../services/decode';
import { dataDir, isBuiltinSample } from '../services/env';
import { Player } from '../services/player';
import { Jobs } from '../services/jobs';
import { MixPeaks } from '../../core/render/offline';
import { TrackInfoSettings, defaultTrackInfo, readTrackInfo } from '../../core/visuals';
import { resolveRelative } from '../../core/paths';
import { MixWaveformChange, MixWaveformInputs, mixWaveformChange, provisionalPeaks, splicePeaks } from '../../core/render/mixWaveform';
import type { MixMessage } from '../../workers/render.worker';
import { Fmt } from '../format';
import { PerformanceGuide } from '../../core/performance';
import { TrackProfiles } from '../services/trackProfiles';
import type { GenreResult } from '../../core/genre';
import type { MixStyle, SetArc } from '../../core/automixer';
import type { TrackUse } from '../../core/models';
import type { Sample, SampleHit } from '../../core/sampler';
import type { MixPattern, TransitionVariation } from './automix';
import { DefaultName } from '../../core/defaultNames';

export const audioExtensions = new Set(['mp3', 'wav', 'wave', 'aif', 'aiff', 'aifc', 'm4a', 'aac', 'flac', 'caf', 'mp4', 'ogg', 'opus']);

export interface PendingTrack { id: string; url: string; name: string; stage?: string; fraction?: number }
export type ExportPhase = { kind: 'idle' } | { kind: 'rendering'; progress: number } | { kind: 'done'; path: string } | { kind: 'failed'; message: string };
export type InspectorTab = 'transition' | 'deck' | 'fx' | 'mixer';
/** Tabs of the detail panel under the arrangement (Ableton's detail view). */
export type PanelTab = 'overview' | 'mix' | 'track' | 'transition' | 'cue' | 'loop' | 'fx' | 'sampler' | 'deck';
export type AddDestination = { kind: 'library'; folder?: string | null } | { kind: 'mix'; index: number | null };

export interface Snapshot { clips: Clip[]; library: Clip[]; layers?: Clip[]; masterBPM: number; gridOffset: number; libraryFolders?: LibraryFolder[]; samples?: Sample[]; sampleHits?: SampleHit[] }

const settingsFile = () => dataDir('settings.json');
function loadSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

export class MixStore {
  // MARK: Document
  clips: Clip[] = [];
  library: Clip[] = [];
  /** Tracks played on top of mix tracks (decks C / D; core/layers.ts). */
  layers: Clip[] = [];
  private layerCache: { revision: number; placed: Clip[]; decks: Map<string, 2 | 3 | null> } | null = null;
  /** Folders of the library (saved with the mix). */
  libraryFolders: LibraryFolder[] = [];
  /** The sampler's pads and the hits placed on the mix (store/sampler.ts). */
  samples: Sample[] = [];
  sampleHits: SampleHit[] = [];
  masterBPM = 124;
  gridOffset = 0;
  snap: SnapUnit = 'phrase';
  defaultTransitionBars = 16;
  defaultTransitionStyle: TransitionStyle = 'bassSwap';
  documentPath: string | null = null;
  isDirty = false;
  notes = '';
  projectID = uuid();
  loudnessMode: LoudnessMode = 'match';
  /** Loudness normalization a new mix starts with (a setting; 'match' unless changed). */
  defaultLoudness: LoudnessMode = 'match';
  /** How the video visuals show each track's name (format, how long, the caption afterwards). */
  visualInfo: TrackInfoSettings = { ...defaultTrackInfo };
  missingFiles = new Set<string>();
  /** Mac analyses stored in the opened .djaw: kept as they are when saving. */
  private macAnalyses: Record<string, string> | null = null;
  private macProfiles: Record<string, unknown> | null = null;

  // Analysis results per audio file.
  waveforms = new Map<string, Waveform>();
  structures = new Map<string, TrackStructure>();
  bandEnergies = new Map<string, BandEnergies>();
  neuralResults = new Map<string, NeuralResult>();
  tempoReadings = new Map<string, TempoOption[]>();
  fingerprints = new Map<string, string>();
  /** Audio file → the file the engine reads (itself, or a decoded cache). */
  pcmPaths = new Map<string, string>();
  loudnessSegments = new Map<string, Float32Array>();
  private loudnessInFlight = new Set<string>();

  /** Genre / vocal analysis per audio file. */
  genreResults = new Map<string, GenreResult>();

  // MARK: Auto-mix settings and state (see automix.ts)
  mixStyle: MixStyle = 'auto';
  setArc: SetArc = 'none';
  trackUse: TrackUse = 'auto';
  verifyTransitions = true;
  mixPatterns: MixPattern[] = [];
  currentPatternID: string | null = null;
  /** "i / n" while the planned transitions are being rendered and checked. */
  verifyProgress: { done: number; total: number } | null = null;
  variations = new Map<string, TransitionVariation[]>();
  variationPrev = new Map<string, string>();
  replannable = new Set<string>();
  autoMixWhenReady = false;
  undoSerial = 0;
  attackCache = new Map<string, number>();

  // MARK: UI
  pending: PendingTrack[] = [];
  private _selectedClipID: string | null = null;
  /** The selected track. Choosing a track deselects a placed sampler sound (so Delete acts on what was chosen last). */
  get selectedClipID(): string | null { return this._selectedClipID; }
  set selectedClipID(id: string | null) {
    if (id && id !== this._selectedClipID) (this as { selectedHit?: string | null }).selectedHit = null;
    this._selectedClipID = id;
  }
  librarySelection = new Set<string>();
  playhead = 0;
  isPlaying = false;
  followPlayhead = true;
  pixelsPerSecond = 8;
  visibleRange: [number, number] = [0, 120];
  fitRequest = 0;
  scrollRequest: { id: number; time: number } | null = null;
  showInspector = true;
  /** The detail panel under the arrangement, its tab and height; the browser on the left. */
  showPanel = true;
  /** The grid of the transition editor and the FX lanes, in beats (1 = a beat = 1/4 bar; 0 = free). */
  editGrid = 1;
  /** The browser on the left: its width (px) and the share of its height the mix order takes (the library has the rest). */
  browserWidth = 264;
  /** Whether the timeline shows the sampler lane (when there is something to show). */
  showSamplerLane = true;
  /** Adding a track to the mix leaves it in the library too (a copy goes into the mix). */
  keepInLibrary = false;
  /** Saving with the audio: WAV tracks as lossless FLAC (the same sound, about half the size). */
  compressAudio = true;
  /** Saving with the audio: also the library's tracks that are not in the mix. */
  embedLibraryAudio = true;
  /** Reopen the last mix when DJAW starts. */
  reopenLast = true;
  private recovery: Promise<boolean> | null = null;
  browserSplit = 0.45;
  /** The detail panel fills the window (the arrangement is hidden meanwhile); not kept between launches. */
  panelMaximized = false;
  panelTab: PanelTab = 'transition';
  panelHeight = 330;
  /** The transition tab's own panel height (null: 58% of the window, so its lanes fit without scrolling). */
  transitionPanelHeight: number | null = null;
  showBrowser = true;
  /** An update being downloaded or ready to install (main/updater.ts). */
  /** The update in progress (main/updater.ts), shown by the update card and the toolbar chip. */
  updateStatus: import('../../main/updater').UpdateStatus | null = null;
  /** The card was put away (the toolbar chip brings it back). */
  updateCardHidden = false;
  /** Where the user last clicked: the editors in the panel take the keys while it is 'panel'. */
  focusArea: 'main' | 'panel' = 'main';
  showDecks = true;
  showMixer = true;
  showExport = false;
  showShortcuts = false;
  showAutoArrange = false;
  showMusicLibrary = false;
  autoArrangePreselect: Set<string> | null = null;
  artworkCache = new Map<string, ImageBitmap | null>();
  artworkLoading = new Set<string>();
  artworkRevision = 0;
  showPerformanceGuide = false;
  profileEditorTarget: string | null = null;
  cueEditorTarget: string | null = null;
  transitionEditorTarget: string | null = null;
  inspectorTab: InspectorTab = 'transition';
  focusedFX: string | null = null;
  alertMessage: string | null = null;
  exportPhase: ExportPhase = { kind: 'idle' };
  exportStartedAt = 0;
  exportSteady: { progress: number; at: number } | null = null;
  exportSampleRate = 44100;
  exportFormat: 'wav24' | 'aac256' = 'wav24';
  exportNormalize = true;
  openCueEditorOnAdd = false;
  embedMedia = true;
  customTransitions: CustomTransition[] = [];
  transitionClipboard: { style: TransitionStyle; bars: number; shape: TransitionShape | null; lanes: TransitionLanes | null } | null = null;
  showMixWaveform = true;
  mixPeaks: MixPeaks | null = null;
  mixPeaksPartial: MixPeaks | null = null;
  mixWaveformIsRendering = false;
  recentDocuments: string[] = [];
  /** True while the user drags on the timeline; playback restarts once at the end. */
  isInteracting = false;

  // MARK: Change notification
  revision = 0;
  private listeners = new Set<() => void>();
  private clockListeners = new Set<(t: number) => void>();
  private emitQueued = false;
  readonly player = new Player();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  colorCounter = 0;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private playingKey = '';
  private tempoCache: { revision: number; map: TempoMap } | null = null;
  private nudgeCache = new Map<string, number>();

  constructor() {
    const s = loadSettings();
    this.showDecks = (s.showDecks as boolean) ?? true;
    this.showMixer = (s.showMixer as boolean) ?? true;
    this.exportNormalize = (s.exportNormalize as boolean) ?? true;
    this.embedMedia = (s.embedMedia as boolean) ?? true;
    this.openCueEditorOnAdd = (s.openCueEditorOnAdd as boolean) ?? false;
    this.showMixWaveform = (s.showMixWaveform as boolean) ?? true;
    this.showPanel = (s.showPanel as boolean) ?? true;
    this.editGrid = typeof s.editGrid === 'number' ? s.editGrid : 1;
    this.panelHeight = (s.panelHeight as number) ?? 330;
    this.transitionPanelHeight = typeof s.transitionPanelHeight === 'number' ? s.transitionPanelHeight : null;
    this.browserWidth = typeof s.browserWidth === 'number' ? s.browserWidth : 264;
    this.showSamplerLane = (s.showSamplerLane as boolean) ?? true;
    this.keepInLibrary = (s.keepInLibrary as boolean) ?? false;
    this.defaultLoudness = loudnessModes.includes(s.defaultLoudness as LoudnessMode) ? (s.defaultLoudness as LoudnessMode) : 'match';
    if (!this.documentPath && !this.clips.length) this.loudnessMode = this.defaultLoudness;
    this.visualInfo = readTrackInfo(s.visualInfo);
    this.reopenLast = (s.reopenLast as boolean) ?? true;
    this.compressAudio = (s.compressAudio as boolean) ?? true;
    this.embedLibraryAudio = (s.embedLibraryAudio as boolean) ?? true;
    this.browserSplit = typeof s.browserSplit === 'number' ? s.browserSplit : 0.45;
    this.showBrowser = (s.showBrowser as boolean) ?? true;
    this.customTransitions = (s.customTransitions as CustomTransition[]) ?? [];
    this.recentDocuments = ((s.recentDocuments as string[]) ?? []).filter(p => fs.existsSync(p));
    this.defaultTransitionStyle = (s.defaultTransitionStyle as TransitionStyle) ?? 'bassSwap';
    this.mixStyle = (s.mixStyle as MixStyle) ?? 'auto';
    this.setArc = (s.setArc as SetArc) ?? 'none';
    this.trackUse = (s.trackUse as TrackUse) ?? 'auto';
    this.verifyTransitions = (s.verifyTransitions as boolean) ?? true;
    this.player.onRestartNeeded = () => this.restartPlayback(null);
  }

  saveSettings() {
    const s = {
      showPanel: this.showPanel, panelHeight: this.panelHeight, transitionPanelHeight: this.transitionPanelHeight, showBrowser: this.showBrowser, editGrid: this.editGrid,
      browserWidth: this.browserWidth, browserSplit: this.browserSplit, showSamplerLane: this.showSamplerLane, keepInLibrary: this.keepInLibrary, defaultLoudness: this.defaultLoudness, visualInfo: this.visualInfo, reopenLast: this.reopenLast, compressAudio: this.compressAudio, embedLibraryAudio: this.embedLibraryAudio,
      showDecks: this.showDecks, showMixer: this.showMixer, exportNormalize: this.exportNormalize, embedMedia: this.embedMedia,
      openCueEditorOnAdd: this.openCueEditorOnAdd, showMixWaveform: this.showMixWaveform, customTransitions: this.customTransitions,
      recentDocuments: this.recentDocuments.slice(0, 10), defaultTransitionStyle: this.defaultTransitionStyle,
      mixStyle: this.mixStyle, setArc: this.setArc, trackUse: this.trackUse, verifyTransitions: this.verifyTransitions,
      language: loadSettings().language,
    };
    try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch { /* ignore */ }
  }

  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  getRevision = () => this.revision;
  onClock(f: (t: number) => void) { this.clockListeners.add(f); return () => { this.clockListeners.delete(f); }; }

  /** Something changed: re-render (once per frame) and keep playback in step. */
  changed() {
    this.revision++;
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      for (const f of this.listeners) f();
      if (this.isPlaying && !this.isInteracting) this.syncPlayback();
      this.scheduleMixWaveform();
    });
  }

  // MARK: Derived

  get grid() { return new Grid(this.masterBPM, this.gridOffset); }
  get beatLength() { return 60 / this.masterBPM; }
  get barLength() { return 240 / this.masterBPM; }
  get mixDuration() { return endWithLayers(this.clips.reduce((m, c) => Math.max(m, clipEnd(c, this.masterBPM)), 0), this.placedLayers, this.masterBPM); }
  /** The layered tracks placed on their mix tracks (start, played range), and their decks (C / D). */
  get placedLayers(): Clip[] {
    if (this.layerCache && this.layerCache.revision === this.revision) return this.layerCache.placed;
    const placed = placeLayers(this.layers, this.clips, this.masterBPM);
    this.layerCache = { revision: this.revision, placed, decks: layerDecks(placed, this.masterBPM) };
    return placed;
  }
  layerDeck(id: string): 2 | 3 | null { void this.placedLayers; return this.layerCache?.decks.get(id) ?? null; }
  isLayer(id: string) { return this.layers.some(l => l.id === id); }
  placedLayer(id: string) { return this.placedLayers.find(l => l.id === id) ?? null; }
  get tempoMap(): TempoMap {
    if (this.tempoCache && this.tempoCache.revision === this.revision) return this.tempoCache.map;
    const m = TempoMap.build(this.clips, this.masterBPM);
    this.tempoCache = { revision: this.revision, map: m };
    return m;
  }
  get realMixDuration() { return this.tempoMap.real(this.mixDuration); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get documentTitle() { return this.documentPath ? path.basename(this.documentPath, path.extname(this.documentPath)) : L('新規ミックス', 'New Mix'); }
  get selectedIndex() { return this.selectedClipID ? this.index(this.selectedClipID) : null; }
  get selectedClip() { const i = this.selectedIndex; return i == null ? null : this.clips[i]; }
  index(id: string) { const i = this.clips.findIndex(c => c.id === id); return i < 0 ? null : i; }
  clip(id: string) { return this.clips.find(c => c.id === id) ?? this.library.find(c => c.id === id) ?? this.layers.find(c => c.id === id) ?? null; }
  isInMix(id: string) { return this.index(id) != null; }
  libraryIndex(id: string) { const i = this.library.findIndex(c => c.id === id); return i < 0 ? null : i; }
  get allTrackIDs() { return [...this.clips.map(c => c.id), ...this.library.map(c => c.id)]; }
  outros(): Map<string, OutroFX> {
    const out = new Map<string, OutroFX>();
    this.clips.forEach((c, i) => { const o = i + 1 < this.clips.length ? outro(c, this.clips[i + 1]) : null; if (o) out.set(c.id, o); });
    return out;
  }
  incomingOverlap(i: number) {
    if (i <= 0 || i >= this.clips.length) return null;
    return Math.min(clipEnd(this.clips[i - 1], this.masterBPM), clipEnd(this.clips[i], this.masterBPM)) - this.clips[i].start;
  }

  // MARK: Undo

  snapshot(): Snapshot {
    return structuredClone({ clips: this.clips, library: this.library, layers: this.layers, masterBPM: this.masterBPM, gridOffset: this.gridOffset, libraryFolders: this.libraryFolders, samples: this.samples, sampleHits: this.sampleHits });
  }

  pushUndo() {
    this.undoSerial++;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.markDirty();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.undoSerial--;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoSerial++;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  restore(s: Snapshot) {
    this.clips = s.clips;
    this.library = s.library;
    this.layers = s.layers ?? [];
    this.libraryFolders = s.libraryFolders ?? this.libraryFolders;
    this.samples = s.samples ?? this.samples;
    this.sampleHits = s.sampleHits ?? this.sampleHits;
    this.masterBPM = s.masterBPM;
    this.gridOffset = s.gridOffset;
    if (this.selectedClipID && !this.clip(this.selectedClipID)) this.selectedClipID = null;
    this.markDirty();
    this.changed();
  }

  /** Counts edits (a save only clears isDirty when nothing was edited while it ran). */
  editSerial = 0;

  markDirty() {
    this.isDirty = true;
    this.editSerial++;
    this.scheduleAutosave();
  }

  // MARK: Editing primitives

  /** Changes one clip (mix or library). */
  updateClip(id: string, undoable: boolean, change: (c: Clip) => void) {
    const i = this.index(id);
    if (i != null) {
      if (undoable) this.pushUndo(); else this.markDirty();
      const c = structuredClone(this.clips[i]);
      change(c);
      this.clips = this.clips.map((x, k) => (k === i ? c : x));
    } else if (this.libraryIndex(id) != null) {
      const k = this.libraryIndex(id)!;
      if (undoable) this.pushUndo(); else this.markDirty();
      const c = structuredClone(this.library[k]);
      change(c);
      this.library = this.library.map((x, j) => (j === k ? c : x));
    } else {
      const k = this.layers.findIndex(l => l.id === id);
      if (k < 0) return;
      if (undoable) this.pushUndo(); else this.markDirty();
      const c = structuredClone(this.layers[k]);
      change(c);
      this.layers = this.layers.map((x, j) => (j === k ? c : x));
    }
    this.changed();
  }

  private setClip(i: number, change: (c: Clip) => void) {
    const c = { ...this.clips[i] };
    change(c);
    this.clips = this.clips.map((x, k) => (k === i ? c : x));
  }

  /** Call after any edit that changes the arrangement. */
  finishTimingEdit() {
    this.clips = separateNeighbourColors(this.clips);
    this.pruneLocks();
    this.clips = updateCutNudges(this.clips, (c, from, to) => this.onsetNear(c, from, to));
    this.applyLayout();
    this.applyLoudness();
    this.changed();
  }

  private onsetNear(c: Clip, from: number, to: number) {
    const e = this.bandEnergies.get(c.url);
    if (!e) return null;
    const key = `${c.url}|${Math.round(c.bpm * 1000)}|${Math.round(c.firstBeat * 10000)}|${Math.round(from * 1000)}|${Math.round(to * 1000)}`;
    if (this.nudgeCache.has(key)) return this.nudgeCache.get(key)!;
    const v = onsetOffset(e, c.bpm, c.firstBeat, from, to, 3);
    this.nudgeCache.set(key, v ?? 0);
    return v;
  }

  applyLayout() {
    if (!this.clips.length) return;
    const r = layout(this.clips, this.masterBPM, this.gridOffset);
    this.clips = r.clips;
    this.gridOffset = r.gridOffset;
  }

  // MARK: Locks (MixStore+Locks)

  isLocked(i: number) {
    return i > 0 && i < this.clips.length && this.clips[i].lockedPrevID != null && this.clips[i].lockedPrevID === this.clips[i - 1].id;
  }
  isTransitionLocked(id: string) { const i = this.index(id); return i != null && this.isLocked(i); }
  setTransitionLocked(id: string, on: boolean) {
    const i = this.index(id);
    if (i == null || i <= 0 || this.isLocked(i) === on) return;
    const prev = this.clips[i - 1].id;
    this.updateClip(id, true, c => { c.lockedPrevID = on ? prev : null; });
  }
  toggleTransitionLock(id: string) { this.setTransitionLocked(id, !this.isTransitionLocked(id)); }
  lockSafeIndex(index: number) {
    let t = Math.min(Math.max(0, index), this.clips.length);
    while (t > 0 && t < this.clips.length && this.isLocked(t)) t++;
    return t;
  }
  lockRanges(arr: Clip[]): [number, number][] {
    if (!arr.length) return [];
    const out: [number, number][] = [];
    let s = 0;
    for (let i = 1; i <= arr.length; i++) {
      if (i === arr.length || arr[i].lockedPrevID == null || arr[i].lockedPrevID !== arr[i - 1].id) { out.push([s, i]); s = i; }
    }
    return out;
  }
  pruneLocks() {
    if (this.clips.some((c, i) => c.lockedPrevID != null && !this.isLocked(i))) {
      this.clips = this.clips.map((c, i) => (c.lockedPrevID != null && !this.isLocked(i) ? { ...c, lockedPrevID: null } : c));
    }
    if (this.library.some(c => c.lockedPrevID != null)) this.library = this.library.map(c => ({ ...c, lockedPrevID: null }));
  }

  // MARK: Adding tracks

  static expandAudioPaths(paths: string[]): string[] {
    const out: string[] = [];
    for (const p of paths) {
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        const items = fs.readdirSync(p).filter(f => !f.startsWith('.') && audioExtensions.has(path.extname(f).slice(1).toLowerCase()))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        out.push(...items.map(f => path.join(p, f)));
      } else if (audioExtensions.has(path.extname(p).slice(1).toLowerCase())) out.push(p);
    }
    return out;
  }

  /** Windows (and Linux) dialogs can't pick files and folders at once — asking for both shows a folder picker —
   *  so there they are two commands; on the Mac one dialog takes either. */
  async presentAddFiles(folders = false) {
    const mac = process.platform === 'darwin';
    const r = await ipcRenderer.invoke('dialog:open', {
      title: folders ? L('フォルダから曲を追加', 'Add Tracks from Folders') : L('曲を追加', 'Add Tracks'),
      message: L('ミックスに追加する曲（またはフォルダ）を選択してください', 'Choose tracks (or folders) to add to the mix'),
      properties: mac ? ['openFile', 'openDirectory', 'multiSelections'] : [folders ? 'openDirectory' : 'openFile', 'multiSelections'],
      filters: folders && !mac ? undefined : [{ name: L('音声', 'Audio'), extensions: [...audioExtensions] }, { name: L('すべてのファイル', 'All Files'), extensions: ['*'] }],
    });
    if (r && r.length) this.addFiles(r, { kind: 'library' });
  }

  insertionIndex(t: number) {
    const i = this.clips.findIndex(c => c.start > t);
    return i < 0 ? this.clips.length : i;
  }

  static pathKey(p: string) {
    let r = path.resolve(p);
    try { r = fs.realpathSync(r); } catch { /* keep */ }
    r = r.normalize('NFC');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  }

  /** Analyses and adds files. The same song (same file, or same content elsewhere) is never loaded twice. */
  async addFiles(paths: string[], destination: AddDestination) {
    const found = MixStore.expandAudioPaths(paths);
    if (!found.length) {
      this.alertMessage = L('対応している音声ファイルが見つかりませんでした。\nMP3・WAV・AIFF・M4A・FLAC などを追加できます。', 'No supported audio files were found.\nYou can add MP3, WAV, AIFF, M4A, FLAC and more.');
      this.changed();
      return;
    }
    const loaded = [...this.clips.map(c => c.url), ...this.library.map(c => c.url), ...this.layers.map(c => c.url), ...this.pending.map(p => p.url)];
    const byPath = new Map(loaded.map(u => [MixStore.pathKey(u), u]));
    const byFp = new Map<string, string>();
    for (const u of loaded) { const fp = this.fingerprints.get(u) ?? fingerprint(u); if (fp) { this.fingerprints.set(u, fp); byFp.set(fp, u); } }
    const files: string[] = [];
    const dupes: { file: string; existing: string | null }[] = [];
    const batch = new Set<string>(), batchFp = new Set<string>();
    for (const f of found) {
      const k = MixStore.pathKey(f);
      const fp = fingerprint(f);
      if (byPath.has(k)) dupes.push({ file: f, existing: byPath.get(k)! });
      else if (fp && byFp.has(fp)) dupes.push({ file: f, existing: byFp.get(fp)! });
      else if (batch.has(k) || (fp && batchFp.has(fp))) dupes.push({ file: f, existing: null });
      else { batch.add(k); if (fp) { batchFp.add(fp); this.fingerprints.set(f, fp); } files.push(f); }
    }
    const items: PendingTrack[] = files.map(f => ({ id: uuid(), url: f, name: path.basename(f, path.extname(f)) }));
    this.pending = [...this.pending, ...items];
    this.changed();
    const wasEmpty = this.clips.length === 0;
    let position: number | null = destination.kind === 'mix' ? destination.index : null;
    let pushed = false;
    const added: string[] = [];
    const notAdded: string[] = [];
    for (const d of dupes) {
      const li = d.existing ? this.library.findIndex(c => c.url === d.existing) : -1;
      if (destination.kind === 'mix' && li >= 0) {
        if (!pushed) { this.pushUndo(); pushed = true; }
        const clip = this.library[li];
        this.library = this.library.filter((_, k) => k !== li);
        const at = this.placeInMix(clip, Math.min(position ?? this.clips.length, this.clips.length));
        position = at + 1;
        added.push(clip.id);
      } else notAdded.push(path.basename(d.file, path.extname(d.file)));
    }
    // First every track with a quick pass (waveform and energy tempo, about a second each), placed at once; then the
    // full analyses one after another, which correct the tempo and grid of the tracks nobody has touched meanwhile.
    // (A track analysed before goes straight in with its saved analysis.)
    const progressOf = (item: PendingTrack) => (stage: string, f: number) => { item.stage = stage; item.fraction = f; this.changed(); };
    const jobs = items.map(item => {
      const saved = cachedAnalysis(item.url) != null;
      return { item, saved, job: saved ? analyze(item.url, { progress: progressOf(item) }) : analyzeQuick(item.url, progressOf(item)) };
    });
    const failed: string[] = [];
    const analyzed: string[] = [];
    const provisional: { item: PendingTrack; id: string; bpm: number; firstBeat: number; mixInBar: number; mixOutBar: number; master: number | null }[] = [];
    this.holdMixWaveform();
    try {
      for (const { item, saved, job } of jobs) {
        try {
          const { analysis, fp, pcm } = await job;
          if (!pushed) { this.pushUndo(); pushed = true; }
          this.fingerprints.set(item.url, fp);
          this.pcmPaths.set(item.url, pcm);
          const clip = this.makeClip(analysis, item.url);
          const setsMaster = destination.kind === 'mix' && this.clips.length === 0;
          if (destination.kind === 'library') this.library = [...this.library, destination.folder ? { ...clip, folder: destination.folder } : clip];
          else {
            const at = this.placeInMix(clip, Math.min(position ?? this.clips.length, this.clips.length));
            position = at + 1;
          }
          added.push(clip.id);
          analyzed.push(clip.id);
          if (saved) this.pending = this.pending.filter(p => p.id !== item.id);
          else {
            item.stage = 'beats'; item.fraction = 0;
            provisional.push({ item, id: clip.id, bpm: clip.bpm, firstBeat: clip.firstBeat, mixInBar: clip.mixInBar, mixOutBar: clip.mixOutBar, master: setsMaster ? this.masterBPM : null });
          }
        } catch (e) {
          console.error('[DJAW] could not add', item.url, e);
          failed.push(`${item.name}（${(e as Error).message}）`);
          this.pending = this.pending.filter(p => p.id !== item.id);
        }
        this.changed();
      }
    } finally {
      if (!provisional.length) this.releaseMixWaveform();
    }
    if (added.length) {
      this.selectedClipID = added[0];
      if (this.openCueEditorOnAdd && !this.cueEditorTarget && analyzed[0]) this.openCueEditor(analyzed[0]);
    } else if (dupes[0]?.existing) {
      const c = [...this.clips, ...this.library, ...this.layers].find(x => x.url === dupes[0].existing);
      if (c) { this.selectedClipID = c.id; if (this.isInMix(c.id)) this.requestScroll(c.start); }
    }
    if (wasEmpty && this.clips.length) this.fitRequest++;
    const messages: string[] = [];
    if (notAdded.length) messages.push(L('同じ曲がすでに読み込まれているため、次の曲は追加しませんでした:\n', 'These tracks are already loaded, so they were not added again:\n') + notAdded.join('\n'));
    if (failed.length) messages.push(L('次のファイルを読み込めませんでした:\n', 'These files could not be read:\n') + failed.join('\n'));
    if (messages.length) this.alertMessage = messages.join('\n\n');
    this.changed();
    if (!provisional.length) return;
    const unfinished: string[] = [];
    try {
      for (const p of provisional) {
        try {
          const { analysis } = await analyze(p.item.url, { progress: progressOf(p.item) });
          this.refineProvisional(p, analysis);
        } catch (e) {
          console.error('[DJAW] analysis failed', p.item.url, e);
          unfinished.push(`${p.item.name}（${(e as Error).message}）`);
        } finally {
          this.pending = this.pending.filter(x => x.id !== p.item.id);
          this.changed();
        }
      }
    } finally {
      this.releaseMixWaveform();
    }
    if (unfinished.length) {
      this.alertMessage = L(`次の曲は詳しい解析ができませんでした（簡易解析のテンポで追加しています。再生と書き出しはできます）：\n${unfinished.join('\n')}`,
        `These tracks could not be fully analysed (they were added with the quick tempo estimate, and still play and export):\n${unfinished.join('\n')}`);
    }
    this.applyLoudness();
    this.changed();
    this.runPendingAutoMix();
  }

  /**
   * The full analysis of a track that went in with the quick pass: its waveform, structure, readings and models' results
   * replace the quick ones, and its tempo and grid are corrected unless the track has been changed in the meantime
   * (then the AI grid is offered in the track tab, as for any track).
   */
  private refineProvisional(p: { id: string; bpm: number; firstBeat: number; mixInBar: number; mixOutBar: number; master: number | null }, a: TrackAnalysis) {
    const c = this.clip(p.id);
    if (!c) { return; }
    this.rememberAnalysis(c.url, a);
    const untouched = c.bpm === p.bpm && c.firstBeat === p.firstBeat && c.mixInBar === p.mixInBar && c.mixOutBar === p.mixOutBar && c.endBar == null;
    if (!untouched) {
      if (Math.abs(c.bpm - a.bpm) > 0.01 && a.energies) {
        const st = structureFor(a.energies, c.bpm, c.firstBeat);
        if (st) this.structures.set(c.url, st);
      }
      this.changed();
      return;
    }
    const sameGrid = Math.abs(a.bpm - c.bpm) < 0.001 && Math.abs(a.firstBeat - c.firstBeat) < 0.0005;
    if (!sameGrid) {
      this.updateClip(p.id, false, x => { x.bpm = a.bpm; x.firstBeat = a.firstBeat; resetToWholeTrack(x); });
      if (p.master != null && this.masterBPM === p.master && this.clips[0]?.id === p.id) this.masterBPM = Math.round(a.bpm * 100) / 100;
    }
    if (this.isInMix(p.id)) this.finishTimingEdit(); else this.changed();
  }

  rememberAnalysis(url: string, a: TrackAnalysis) {
    this.waveforms.set(url, a.waveform);
    if (a.structure) this.structures.set(url, a.structure); else this.structures.delete(url);
    this.tempoReadings.set(url, [{ bpm: a.bpm, firstBeat: a.firstBeat, fit: 1 }, ...a.tempoOptions]);
    if (a.energies) this.bandEnergies.set(url, a.energies);
    if (a.neural) this.neuralResults.set(url, a.neural);
    if (a.genre) this.genreResults.set(url, a.genre); else this.genreResults.delete(url);
  }

  private makeClip(a: TrackAnalysis, url: string): Clip {
    const c = newClip({ url, title: a.title || path.basename(url, path.extname(url)), artist: a.artist, duration: a.duration, bpm: a.bpm, firstBeat: a.firstBeat, trimEnd: a.duration });
    c.colorIndex = this.colorCounter++;
    const pr = TrackProfiles.load(url);
    if (pr) { c.title = pr.title; c.artist = pr.artist; }
    c.transitionBars = 0;
    c.transition = this.defaultTransitionStyle;
    resetToWholeTrack(c);
    this.rememberAnalysis(url, a);
    return c;
  }

  private placeInMix(clip: Clip, index: number): number {
    if (!this.clips.length && clip.bpm > 0) this.masterBPM = Math.round(clip.bpm * 100) / 100;
    const c = { ...clip, lockedPrevID: null };
    const at = this.lockSafeIndex(index);
    this.clips = [...this.clips.slice(0, at), c, ...this.clips.slice(at)];
    this.finishTimingEdit();
    return at;
  }

  /** Moves a library track into the mix (default: after the selected mix track, else at the end). */
  addToMix(id: string, index?: number) {
    const li = this.libraryIndex(id);
    if (li == null) return;
    this.pushUndo();
    // With "keep in library", a copy goes into the mix and the library keeps the track (in its folder).
    const clip = this.keepInLibrary ? { ...structuredClone(this.library[li]), id: uuid(), folder: null } : this.library[li];
    if (!this.keepInLibrary) this.library = this.library.filter((_, k) => k !== li);
    let target = this.clips.length;
    if (index != null) target = index;
    else if (this.selectedClipID) { const si = this.index(this.selectedClipID); if (si != null) target = si + 1; }
    const wasEmpty = !this.clips.length;
    this.placeInMix(clip, target);
    this.selectedClipID = clip.id;
    if (wasEmpty) this.fitRequest++;
    this.requestScroll(this.clip(clip.id)?.start ?? 0);
  }

  addToMixMany(ids: string[], index?: number) {
    const ordered = this.library.map(c => c.id).filter(id => ids.includes(id));
    if (!ordered.length) return;
    this.pushUndo();
    const wasEmpty = !this.clips.length;
    let target = index ?? this.clips.length;
    if (index == null && this.selectedClipID) { const si = this.index(this.selectedClipID); if (si != null) target = si + 1; }
    target = this.lockSafeIndex(target);
    for (const id of ordered) {
      const li = this.libraryIndex(id);
      if (li == null) continue;
      const clip = this.keepInLibrary ? { ...structuredClone(this.library[li]), id: uuid(), folder: null, lockedPrevID: null } : { ...this.library[li], lockedPrevID: null };
      if (!this.keepInLibrary) this.library = this.library.filter((_, k) => k !== li);
      if (!this.clips.length && clip.bpm > 0) this.masterBPM = Math.round(clip.bpm * 100) / 100;
      const at = Math.min(target, this.clips.length);
      this.clips = [...this.clips.slice(0, at), clip, ...this.clips.slice(at)];
      target++;
    }
    this.librarySelection = new Set();
    this.selectedClipID = this.clips[Math.min(target, this.clips.length) - 1]?.id ?? ordered[ordered.length - 1];
    this.finishTimingEdit();
    if (wasEmpty) this.fitRequest++;
  }

  removeFromLibrary(ids: string[]) {
    const set = new Set(ids);
    if (!this.library.some(c => set.has(c.id))) return;
    this.pushUndo();
    const first = this.library.findIndex(c => set.has(c.id));
    this.library = this.library.filter(c => !set.has(c.id));
    this.librarySelection = new Set();
    this.selectedClipID = this.library.length ? this.library[Math.min(first, this.library.length - 1)].id : null;
    this.changed();
  }

  /** Takes a track out of the mix and keeps it (with its cues) in the library. */
  removeFromMix(id: string) {
    const i = this.index(id);
    if (i == null) return;
    this.pushUndo();
    const clip = { ...this.clips[i], lockedPrevID: null };
    this.clips = this.clips.filter((_, k) => k !== i);
    // Back to the library, unless it is still there (kept when it went into the mix).
    if (!this.library.some(c => c.url === clip.url)) this.library = [clip, ...this.library];
    if (!this.clips.length) this.pause(); else this.finishTimingEdit();
    this.changed();
  }

  deleteSelected() {
    if (this.selectedHit) { this.removeHit(this.selectedHit); return; }
    if (this.librarySelection.size > 1) { this.removeFromLibrary([...this.librarySelection]); return; }
    if (this.selectedClipID && this.isLayer(this.selectedClipID)) { this.removeLayer(this.selectedClipID); return; }
    const i = this.selectedIndex;
    if (i != null) {
      this.pushUndo();
      this.clips = this.clips.filter((_, k) => k !== i);
      this.selectedClipID = this.clips.length ? this.clips[Math.min(i, this.clips.length - 1)].id : null;
      if (!this.clips.length) this.pause(); else this.finishTimingEdit();
    } else if (this.selectedClipID) {
      const li = this.libraryIndex(this.selectedClipID);
      if (li == null) return;
      this.pushUndo();
      this.library = this.library.filter((_, k) => k !== li);
      this.selectedClipID = this.library.length ? this.library[Math.min(li, this.library.length - 1)].id : null;
    }
    this.changed();
  }

  deleteClip(id: string) { this.selectedClipID = id; this.deleteSelected(); }

  moveClips(from: number[], to: number) {
    const groups = this.lockRanges(this.clips);
    const moving = new Set(from.map(k => groups.findIndex(([a, b]) => k >= a && k < b)).filter(g => g >= 0));
    const before = groups.filter(([a]) => a < to).length;
    const keep = groups.filter((_, g) => !moving.has(g));
    const mv = groups.filter((_, g) => moving.has(g));
    const insertAt = groups.slice(0, before).filter((_, g) => !moving.has(g)).length;
    const order = [...keep.slice(0, insertAt), ...mv, ...keep.slice(insertAt)].flatMap(([a, b]) => this.clips.slice(a, b));
    if (order.map(c => c.id).join() === this.clips.map(c => c.id).join()) return;
    this.pushUndo();
    this.clips = order;
    this.finishTimingEdit();
  }

  selectAdjacent(delta: number) {
    const order = this.allTrackIDs;
    if (!order.length) return;
    const cur = this.selectedClipID ? order.indexOf(this.selectedClipID) : -1;
    const current = cur >= 0 ? cur : delta > 0 ? -1 : order.length;
    const next = Math.min(Math.max(0, current + delta), order.length - 1);
    this.selectedClipID = order[next];
    const c = this.clip(order[next]);
    if (c && this.isInMix(c.id)) this.requestScroll(c.start);
    this.changed();
  }

  moveSelectedInOrder(delta: number) {
    const i = this.selectedIndex;
    if (i == null) return;
    const target = i + delta;
    if (target < 0 || target >= this.clips.length) return;
    this.moveClips([i], delta > 0 ? target + 1 : target);
  }

  // MARK: Tempo

  setMasterBPM(value: number) {
    const v = Math.min(220, Math.max(40, Math.round(value * 100) / 100));
    if (Math.abs(v - this.masterBPM) <= 0.0001) return;
    this.pushUndo();
    const ratio = this.masterBPM / v;
    this.masterBPM = v;
    this.applyLayout();
    this.playhead *= ratio;
    this.changed();
    if (this.isPlaying) this.restartPlayback(this.playhead);
  }

  setClipBPM(id: string, bpm: number) {
    const v = Math.min(300, Math.max(30, bpm));
    this.updateClip(id, true, c => { c.bpm = v; });
    this.finishTimingEdit();
  }

  scaleClipBPM(id: string, f: number) { const c = this.clip(id); if (c) this.setClipBPM(id, c.bpm * f); }

  /** Mix BPM in effect when track `i` plays (before any change it makes itself). */
  tempoBefore(i: number) {
    let t = this.masterBPM;
    for (let k = 1; k < Math.max(1, Math.min(i, this.clips.length)); k++) if (this.clips[k].tempo != null) t = this.clips[k].tempo!;
    return t;
  }

  setTrackTempo(id: string, bpm: number | null) {
    const i = this.index(id);
    if (i == null) return;
    if (i === 0) { if (bpm != null) this.setMasterBPM(bpm); return; }
    const v = bpm == null ? null : Math.min(220, Math.max(40, Math.round(bpm * 100) / 100));
    const same = v != null && Math.abs(v - this.tempoBefore(i)) < 0.005;
    this.updateClip(id, true, c => { c.tempo = same ? null : v; });
    this.finishTimingEdit();
  }

  setTempoAtTime(t: number, bpm: number) {
    let owner: number | null = null;
    for (let i = 1; i < this.clips.length; i++) {
      const c = this.clips[i];
      if (c.tempo != null && timelineTimeOfBar(c, c.mixInBar, this.masterBPM) <= t + 0.001) owner = i;
    }
    if (owner != null) this.setTrackTempo(this.clips[owner].id, bpm); else this.setMasterBPM(bpm);
  }

  setTempoStart(id: string, start: TempoStart | null) { this.updateClip(id, true, c => { c.tempoStart = start; }); this.finishTimingEdit(); }
  /** Turns a tempo change on (back to this track's own speed, starting after the transition) or off. */
  setTempoChange(id: string, on: boolean) {
    const c = this.clip(id);
    if (!c) return;
    if (!on) { this.updateClip(id, true, x => { x.tempo = null; x.tempoStart = null; }); this.finishTimingEdit(); return; }
    this.updateClip(id, true, x => {
      x.tempo = Math.round(x.bpm * 100) / 100;
      x.tempoStart = 'afterTransition';
      if (x.tempoBars == null) x.tempoBars = 8;
    });
    this.finishTimingEdit();
  }
  setTempoBars(id: string, bars: number | null) { this.updateClip(id, true, c => { c.tempoBars = bars == null ? null : Math.max(0, bars); }); this.finishTimingEdit(); }
  setSpinBeats(id: string, beats: number) { this.updateClip(id, true, c => { c.spinBeats = beats; }); }
  setTempoSync(id: string, on: boolean) { this.updateClip(id, true, c => { c.tempoSync = on; }); this.finishTimingEdit(); }
  shiftDownbeat(id: string, beats: number) {
    const c = this.clip(id);
    if (!c || !(c.bpm > 0)) return;
    this.updateClip(id, true, x => { x.firstBeat += beats * 60 / c.bpm; });
    this.finishTimingEdit();
  }
  nudgeGrid(id: string, ms: number) { this.updateClip(id, true, c => { c.firstBeat += ms / 1000; }); this.finishTimingEdit(); }

  // MARK: AI grid

  aiGrid(c: Clip) {
    const n = this.neuralResults.get(c.url);
    const g = n?.grid;
    if (!n || !g) return null;
    let bpm = g.bpm;
    for (const f of [2, 0.5, 4, 0.25]) if (Math.abs(c.bpm / (g.bpm * f) - 1) < 0.03) bpm = g.bpm * f;
    const e = this.bandEnergies.get(c.url);
    const fb0 = g.firstBeat + ((e ? onsetOffset(e, bpm, g.firstBeat) : null) ?? 0);
    const fb = Mathx.posMod(fb0, 240 / bpm);
    return { bpm, firstBeat: fb, fit: beatHitRate(n.beats, bpm, fb), currentFit: beatHitRate(n.beats, c.bpm, c.firstBeat), grid: g };
  }

  gridDiffersFromAI(c: Clip) {
    const a = this.aiGrid(c);
    if (!a) return false;
    if (Math.abs(a.bpm / c.bpm - 1) > 0.002) return a.fit > a.currentFit - 0.01;
    const bar = 240 / a.bpm;
    const d = Mathx.posMod(a.firstBeat - c.firstBeat, bar);
    return Math.min(d, bar - d) > 0.03;
  }

  applyAIGrid(id: string) {
    const c = this.clip(id);
    const a = c ? this.aiGrid(c) : null;
    if (!c || !a) return;
    this.updateClip(id, true, x => { x.bpm = a.bpm; x.firstBeat = a.firstBeat; });
    const e = this.bandEnergies.get(c.url);
    const st = e ? structureTrusted(e, a.bpm, a.firstBeat) : null;
    if (st) this.structures.set(c.url, st);
    this.finishTimingEdit();
  }

  // MARK: Effects

  addFX(id: string, kind: FXKind, atBar?: number, bars?: number): string | null {
    const c = this.clip(id);
    if (!c) return null;
    const len = bars ?? FX.defaultBars(kind);
    let start = atBar ?? (this.index(id) != null ? c.mixOutBar - len : c.mixInBar);
    start = Math.round(Math.max(c.mixInBar, Math.min(start, Math.max(c.mixInBar, lastBar(c) - len))) * 4) / 4;
    const fx = FX.make(kind, start, { bars: len });
    this.updateClip(id, true, x => { x.fx = [...(x.fx ?? []), fx]; });
    return fx.id;
  }

  updateFX(id: string, fxID: string, undoable: boolean, change: (f: ClipFX) => void) {
    this.updateClip(id, undoable, c => {
      const list = c.fx ?? [];
      const k = list.findIndex(f => f.id === fxID);
      if (k < 0) return;
      change(list[k]);
      list[k].bars = Math.max(0.25, list[k].bars);
      list[k].amount = Math.min(1, Math.max(0, list[k].amount));
      list[k].auto = null;
      c.fx = list;
    });
  }

  removeFX(id: string, fxID: string) {
    this.updateClip(id, true, c => { c.fx = (c.fx ?? []).filter(f => f.id !== fxID); if (!c.fx.length) c.fx = null; });
  }

  removeAllFX(id: string) { this.updateClip(id, true, c => { c.fx = null; }); }

  // MARK: Cues and mix points

  openCueEditor(id: string) {
    if (!this.clip(id)) return;
    this.selectedClipID = id;
    this.openPanel('cue');
  }

  /** Shows a tab of the detail panel. */
  openPanel(tab: PanelTab) {
    this.panelTab = tab;
    if (!this.showPanel) { this.showPanel = true; this.saveSettings(); }
    this.changed();
  }

  setMixOut(id: string, bar: number, undoable = true) {
    this.updateClip(id, undoable, c => { c.mixOutBar = bar; c.cueDone = true; });
    this.finishTimingEdit();
  }
  /** Inside a loop: the pass on which the next track comes in (null = the last). */
  setOutPass(id: string, pass: number | null) { this.updateClip(id, true, c => { c.outPass = pass; }); this.finishTimingEdit(); }
  /** Brings the next track in while this loop is still repeating: from the loop's start, on pass `pass`. */
  mixOutInLoop(id: string, bar: number, pass: number) { this.updateClip(id, true, c => { c.mixOutBar = bar; c.outPass = pass; c.outNudge = null; }); this.finishTimingEdit(); }

  useWholeTrack(id: string) { this.updateClip(id, true, c => resetToWholeTrack(c)); this.finishTimingEdit(); }

  addCue(id: string, bar: number) {
    const c = this.clip(id);
    if (!c) return;
    const n = (c.cues?.length ?? 0) + 1;
    this.updateClip(id, true, x => { x.cues = [...(x.cues ?? []), { id: uuid(), bar, label: DefaultName.cue(n) }]; });
  }
  renameCue(id: string, cue: string, label: string) {
    this.updateClip(id, false, c => { c.cues = (c.cues ?? []).map(q => (q.id === cue ? { ...q, label } : q)); });
  }
  removeCue(id: string, cue: string) { this.updateClip(id, true, c => { c.cues = (c.cues ?? []).filter(q => q.id !== cue); }); }

  setTransitionShape(id: string, undoable: boolean, change: (s: TransitionShape) => void) {
    const c = this.clip(id);
    if (!c) return;
    const shape = structuredClone(transitionShape(c));
    change(shape);
    shape.inRise = Math.min(1, Math.max(0.001, shape.inRise));
    shape.outFadeStart = Math.min(0.999, Math.max(0, shape.outFadeStart));
    for (const band of ['low', 'mid', 'high'] as EQBand[]) {
      const b = shape[band];
      b.point = Math.min(1, Math.max(0, b.point));
      b.ramp = Math.min(1 - b.point, Math.max(0, b.ramp));
    }
    this.updateClip(id, undoable, x => { x.shape = shape; x.transitionDone = true; });
  }

  resetTransitionShape(id: string) { this.updateClip(id, true, c => { c.shape = null; }); }

  setMixIn(id: string, bar: number, undoable = true) {
    this.updateClip(id, undoable, c => { c.mixInBar = bar; c.landingLock = false; c.cueDone = true; });
    this.finishTimingEdit();
  }

  setLandingBar(id: string, bar: number, undoable = true) {
    this.updateClip(id, undoable, c => { c.mixInBar = bar - c.transitionBars; c.landingLock = true; c.cueDone = true; });
    this.finishTimingEdit();
  }

  setLandingLock(id: string, on: boolean) { this.updateClip(id, true, c => { c.landingLock = on; }); }

  /** Trims the start of a track while its audio stays where it is on the timeline. */
  slipMixIn(id: string, bar: number) {
    const i = this.index(id);
    if (i == null) return;
    const c = this.clips[i];
    const minIn = barAtSource(c, 0) - 64;
    const newIn = Math.min(Math.max(bar, minIn), i + 1 < this.clips.length ? c.mixOutBar - 1 : lastBar(c) - 1);
    const delta = newIn - c.mixInBar;
    if (Math.abs(delta) <= 0.0001) return;
    this.markDirty();
    if (i > 0) {
      const prev = this.clips[i - 1];
      const prevOut = prev.mixOutBar + delta;
      if (!(prevOut > prev.mixInBar + 0.99 && prevOut + c.transitionBars <= lastBar(prev) + 0.01)) return;
      this.setClip(i - 1, p => { p.mixOutBar = prevOut; });
    }
    this.setClip(i, x => { x.mixInBar = newIn; });
    this.finishTimingEdit();
  }

  // Direct manipulation on the timeline (the audio under the mouse stays where it is).

  dragIncomingEdge(id: string, delta: number, origIn: number, origPrevOut: number, origBars: number) {
    const i = this.index(id);
    if (i == null || i <= 0) return 0;
    const c = this.clips[i], prev = this.clips[i - 1];
    let d = delta;
    d = Math.max(d, Math.ceil(barAtSource(c, 0) * 4 - 0.001) / 4 - origIn);
    d = Math.max(d, prev.mixInBar + 1 - origPrevOut);
    d = Math.min(d, origBars);
    d = Math.min(d, c.mixOutBar - 1 - origIn);
    this.markDirty();
    this.setClip(i, x => { x.mixInBar = origIn + d; x.transitionBars = Math.max(0, origBars - d); });
    this.setClip(i - 1, p => { p.mixOutBar = origPrevOut + d; });
    this.finishTimingEdit();
    return d;
  }

  dragFirstStart(id: string, delta: number, origIn: number) {
    const i = this.index(id);
    if (i !== 0) return 0;
    const c = this.clips[0];
    const lo = Math.ceil(barAtSource(c, 0) * 4 - 0.001) / 4;
    const hi = (this.clips.length > 1 ? c.mixOutBar : (c.endBar ?? lastBar(c))) - 1;
    const newIn = Math.min(Math.max(origIn + delta, lo), hi);
    this.markDirty();
    this.setClip(0, x => { x.mixInBar = newIn; });
    this.finishTimingEdit();
    return newIn - origIn;
  }

  slipContent(id: string, delta: number, origIn: number, origOut: number, origEnd: number | null) {
    const i = this.index(id);
    if (i == null) return 0;
    const c = this.clips[i];
    let d = delta;
    d = Math.max(d, Math.ceil(barAtSource(c, 0) * 4 - 0.001) / 4 - origIn);
    if (i + 1 < this.clips.length) d = Math.min(d, lastBar(c) - this.clips[i + 1].transitionBars - origOut);
    else if (origEnd != null) d = Math.min(d, lastBar(c) - origEnd);
    else d = Math.min(d, 0);
    this.markDirty();
    this.setClip(i, x => { x.mixInBar = origIn + d; x.mixOutBar = origOut + d; if (origEnd != null) x.endBar = origEnd + d; });
    this.finishTimingEdit();
    return d;
  }

  setEntryPoint(id: string, bar: number, undoable = true) {
    const i = this.index(id);
    if (i == null || i <= 0) return;
    if (undoable) this.pushUndo(); else this.markDirty();
    this.setClip(i - 1, p => { p.mixOutBar = bar; });
    this.finishTimingEdit();
  }

  moveEntry(id: string, deltaBars: number) {
    const i = this.index(id);
    if (i == null || i <= 0) return;
    this.setEntryPoint(id, this.clips[i - 1].mixOutBar + deltaBars);
  }

  setTransitionLength(id: string, bars: number, undoable = true, makeRoom = true) {
    const i = this.index(id);
    if (i == null || i <= 0) return;
    if (undoable) this.pushUndo(); else this.markDirty();
    if (makeRoom) this.makeRoom(i, bars);
    const prev = this.clips[i - 1];
    const available = Math.max(0, lastBar(prev) - prev.mixOutBar);
    const v = Math.min(Math.max(0, bars), Math.min(128, available));
    this.setClip(i, c => {
      if (keepsLanding(c)) { const land = landingBar(c); c.transitionBars = v; c.mixInBar = land - v; } else c.transitionBars = v;
    });
    this.finishTimingEdit();
  }

  /** Bar (on the clip's grid) where the clip's music ends. */
  private musicEndBar(c: Clip) {
    const s = this.structures.get(c.url);
    if (s) return Math.min(lastBar(c), barAtSource(c, Structure.timeOfBar(s, s.musicEnd)));
    const w = this.waveforms.get(c.url);
    const t = w ? lastSoundTime(w) : null;
    if (t != null) return Math.min(lastBar(c), Math.round(barAtSource(c, t)));
    return Math.floor(lastBar(c));
  }

  private makeRoom(i: number, bars: number) {
    if (i <= 0 || i >= this.clips.length || !(bars > 0.01)) return;
    const prev = this.clips[i - 1];
    const end = this.musicEndBar(prev);
    if (!(prev.mixOutBar + bars > end + 0.01)) return;
    let out = end - bars;
    const s = this.structures.get(prev.url);
    if (s) {
      const target = Math.floor(Structure.barAtTime(s, sourceTimeAtBar(prev, out)));
      const g = Structure.gridBars(s, target - 8, target, 4);
      if (g.length) out = barAtSource(prev, Structure.timeOfBar(s, g[g.length - 1]));
    } else out = Math.floor(out);
    const lowest = (i - 1 === 0 ? prev.mixInBar : landingBar(prev)) + 1;
    this.setClip(i - 1, p => { p.mixOutBar = Math.max(lowest, out); });
  }

  setEndBar(id: string, bar: number | null, undoable = true) { this.updateClip(id, undoable, c => { c.endBar = bar; }); this.finishTimingEdit(); }

  setTransitionStyle(id: string, style: TransitionStyle) {
    const c = this.clip(id);
    if (!c) return;
    let bars = c.transitionBars;
    if (Style.isCutLike(style)) bars = 0;
    else if (style === 'echoOut') { if (bars < 0.99 || bars > 4.01) bars = 2; }
    else if (bars < 3.99) bars = style === 'bassSwap' ? 16 : 8;
    this.applyTransition(id, style, bars);
  }

  applyPreset(id: string, p: TransitionPreset) { this.applyTransition(id, p.style, p.bars); }

  private applyTransition(id: string, style: TransitionStyle, bars: number, lanes?: TransitionLanes | null) {
    const i = this.index(id);
    if (i == null || i <= 0) return;
    this.pushUndo();
    this.makeRoom(i, bars);
    const prev = this.clips[i - 1];
    const available = Math.max(0, lastBar(prev) - prev.mixOutBar);
    this.setClip(i, c => {
      const land = landingBar(c);
      if (style === 'custom') c.lanes = lanes ?? c.lanes ?? effectiveLanes(c);
      c.transition = style;
      c.transitionDone = true;
      c.shape = null;
      c.transitionBars = Math.min(Math.max(0, bars), available);
      if (keepsLanding(c)) c.mixInBar = land - c.transitionBars;
    });
    this.finishTimingEdit();
  }

  applyPresetNumber(n: number) {
    const id = this.selectedClipID;
    const i = id ? this.index(id) : null;
    const all = transitionPresets();
    if (!id || i == null || i <= 0 || n < 1 || n > all.length) return;
    this.applyPreset(id, all[n - 1]);
  }

  copyTransition() {
    const i = this.selectedIndex;
    if (i == null || i <= 0) return;
    const c = this.clips[i];
    this.transitionClipboard = { style: c.transition, bars: c.transitionBars, shape: c.shape ?? null, lanes: c.lanes ?? null };
  }

  pasteTransition() {
    const id = this.selectedClipID, t = this.transitionClipboard;
    if (!id || !t || !this.index(id)) return;
    this.applyTransition(id, t.style, t.bars, t.lanes);
    const k = this.index(id);
    if (k != null) { this.setClip(k, c => { c.shape = t.shape; }); this.changed(); }
  }

  openTransitionEditor(id: string) {
    const i = this.index(id);
    if (i == null || i <= 0) return;
    this.selectedClipID = id;
    this.openPanel('transition');
  }

  setLanes(id: string, lanes: TransitionLanes, undoable = true) {
    this.updateClip(id, undoable, c => { c.lanes = lanes; c.transition = 'custom'; c.transitionDone = true; });
    // Vocal / instrumental lanes need the tracks' stems.
    if (Lanes.usesStemsIncoming(lanes) || Lanes.usesStemsOutgoing(lanes)) this.prepareStemsIfNeeded();
  }

  applyCustomTransition(id: string, p: CustomTransition) { this.applyTransition(id, 'custom', p.bars, p.lanes); }

  saveCustomTransition(id: string, name: string) {
    const c = this.clip(id);
    if (!c) return;
    const title = name.trim() || DefaultName.myTransition(this.customTransitions.length + 1);
    this.customTransitions = [...this.customTransitions, { id: uuid(), name: title, bars: Math.max(1, c.transitionBars), lanes: effectiveLanes(c) }];
    this.saveSettings();
    this.changed();
  }

  deleteCustomTransition(pid: string) { this.customTransitions = this.customTransitions.filter(p => p.id !== pid); this.saveSettings(); this.changed(); }

  applyPresetToAll(p: TransitionPreset) {
    if (this.clips.length <= 1) return;
    this.pushUndo();
    this.clips = this.clips.map((c, i) => (i === 0 ? c : { ...c, transition: p.style, transitionBars: p.bars }));
    this.finishTimingEdit();
  }

  trimToFirstDownbeat(id: string) { this.setMixIn(id, 0); }

  resetTrim(id: string) {
    const c = this.clip(id);
    if (!c) return;
    this.pushUndo();
    const i = this.index(id);
    if (i != null) this.setClip(i, x => { x.mixInBar = -Math.ceil(c.firstBeat / barSource(c) - 0.001); x.endBar = null; });
    this.finishTimingEdit();
  }

  setProgress(id: string, cue?: boolean, transition?: boolean) {
    this.updateClip(id, false, c => { if (cue != null) c.cueDone = cue; if (transition != null) c.transitionDone = transition; });
  }

  get progressSummary() {
    const cues = this.clips.filter(c => c.cueDone).length;
    const transitions = this.clips.slice(1).filter(c => c.transitionDone).length;
    return { cues, cueTotal: this.clips.length, transitions, transitionTotal: Math.max(0, this.clips.length - 1) };
  }

  transitionSentence(i: number): string | null {
    if (i <= 0 || i >= this.clips.length) return null;
    const prev = this.clips[i - 1], cur = this.clips[i];
    const out = L(`「${prev.title}」の ${barLabel(prev.mixOutBar)}小節目`, `bar ${barLabel(prev.mixOutBar)} of “${prev.title}”`);
    const inn = L(`「${cur.title}」の ${barLabel(cur.mixInBar)}小節目`, `bar ${barLabel(cur.mixInBar)} of “${cur.title}”`);
    switch (cur.transition) {
      case 'cut': return L(`${out}で、${inn}にカットインします。`, `At ${out}, cut in to ${inn}.`);
      case 'brake': case 'backspin': {
        const beats = Math.trunc(cur.spinBeats ?? Style.defaultSpinBeats(cur.transition));
        const what = cur.transition === 'brake' ? L('ブレーキで止め', 'brake to a stop') : L('バックスピンさせ', 'spin back');
        return L(`${out}の手前 ${beats} 拍で前の曲を${what}、${inn}を落とします。`, `Over the ${beats} beats before ${out}, ${what} the previous track, then drop ${inn}.`);
      }
      case 'echoOut':
        return L(`${out}で前の曲をエコーアウトし、同時に${inn}からカットインします（残響 ${Fmt.bars(cur.transitionBars)}）。`, `At ${out}, echo the previous track out and cut in from ${inn} (echo tail: ${Fmt.bars(cur.transitionBars)}).`);
      default:
        if (cur.transitionBars < 0.01) return L(`${out}で、${inn}に直接つなぎます。`, `At ${out}, go straight into ${inn}.`);
        return L(`${out}から${inn}を重ね、${Fmt.bars(cur.transitionBars)}かけて${Style.title(cur.transition)}で切り替えます。`, `From ${out}, bring in ${inn} and ${Style.title(cur.transition).toLowerCase()} over ${Fmt.bars(cur.transitionBars)}.`);
    }
  }

  // MARK: Takes (MixStore+Takes)

  takes(id: string): TransitionTake[] {
    const i = this.index(id);
    if (i == null || i <= 0) return [];
    const prevID = this.clips[i - 1].id;
    return (this.clips[i].takes ?? []).filter(t => t.prevID === prevID);
  }
  currentTakeID(id: string) {
    const i = this.index(id);
    if (i == null || i <= 0) return null;
    const now = Take.snapshot(this.clips[i - 1], this.clips[i]);
    return this.takes(id).find(t => Take.soundsLike(t.snapshot, now))?.id ?? null;
  }
  saveTake(id: string, name: string | null = null, undoable = true) {
    const i = this.index(id);
    if (i == null || i <= 0) return null;
    const now = Take.snapshot(this.clips[i - 1], this.clips[i]);
    const existing = this.takes(id).find(t => Take.soundsLike(t.snapshot, now));
    if (existing) { if (name) this.renameTake(id, existing.id, name); return existing.id; }
    if (undoable) this.pushUndo(); else this.markDirty();
    const n = this.takes(id).length + 1;
    const take: TransitionTake = { id: uuid(), name: name || DefaultName.take(n), created: new Date().toISOString(), prevID: this.clips[i - 1].id, snapshot: now };
    this.setClip(i, c => { c.takes = [...(c.takes ?? []), take]; });
    this.changed();
    return take.id;
  }
  useTake(id: string, takeID: string) {
    const i = this.index(id);
    const take = this.takes(id).find(t => t.id === takeID);
    if (i == null || i <= 0 || !take) return;
    this.pushUndo();
    if (this.currentTakeID(id) == null) this.saveTake(id, DefaultName.previousTake(), false);
    const prev = structuredClone(this.clips[i - 1]), clip = structuredClone(this.clips[i]);
    Take.apply(take.snapshot, prev, clip);
    this.clips = this.clips.map((c, k) => (k === i - 1 ? prev : k === i ? clip : c));
    this.finishTimingEdit();
  }
  renameTake(id: string, takeID: string, name: string) {
    const i = this.index(id);
    const t = name.trim();
    if (i == null || !t) return;
    this.pushUndo();
    this.setClip(i, c => { c.takes = (c.takes ?? []).map(x => (x.id === takeID ? { ...x, name: t } : x)); });
    this.changed();
  }
  deleteTake(id: string, takeID: string) {
    const i = this.index(id);
    if (i == null) return;
    this.pushUndo();
    this.setClip(i, c => { c.takes = (c.takes ?? []).filter(x => x.id !== takeID); if (!c.takes.length) c.takes = null; });
    this.changed();
  }

  // MARK: DJ operations

  sourceBar(id: string, t: number) {
    const c = this.clip(id);
    if (!c || this.index(id) == null || t < c.start || t >= clipEnd(c, this.masterBPM)) return null;
    return barAtSource(c, sourceTimeAtTimeline(c, t, this.masterBPM));
  }
  addLoop(id: string, bar: number, bars: number, repeats: number) {
    const unit = Math.min(bars, 1);
    this.addEdit(id, { id: uuid(), kind: 'loop', bar: Math.floor(bar / unit) * unit, bars, repeats: Math.max(1, repeats) });
  }
  addJump(id: string, bar: number, bars: number) { this.addEdit(id, { id: uuid(), kind: 'jump', bar: Math.round(bar * 4) / 4, bars, repeats: 1 }); }
  private addEdit(id: string, edit: ClipEdit) {
    const c = this.clip(id);
    if (!c || edit.bar < barAtSource(c, 0) - 0.01 || edit.bar + edit.bars > lastBar(c) + 0.01) {
      this.alertMessage = L('曲の範囲外にはループ／ジャンプを置けません。', 'Loops and jumps must be inside the track.');
      this.changed();
      return;
    }
    this.updateClip(id, true, x => {
      const list = (x.edits ?? []).filter(e => e.bar + e.bars <= edit.bar + 0.001 || e.bar >= edit.bar + edit.bars - 0.001);
      list.push(edit);
      list.sort((a, b) => a.bar - b.bar);
      x.edits = list;
    });
    this.finishTimingEdit();
  }
  removeEdit(id: string, editID: string) {
    this.updateClip(id, true, c => { c.edits = (c.edits ?? []).filter(e => e.id !== editID); if (!c.edits.length) { c.edits = null; c.playLength = null; } });
    this.finishTimingEdit();
  }
  removeAllEdits(id: string) { this.updateClip(id, true, c => { c.edits = null; c.playLength = null; }); this.finishTimingEdit(); }
  setEditRepeats(id: string, editID: string, repeats: number) {
    this.updateClip(id, true, c => { c.edits = (c.edits ?? []).map(e => (e.id === editID ? { ...e, repeats: Math.min(32, Math.max(1, repeats)) } : e)); });
    this.finishTimingEdit();
  }
  setKeyLock(id: string, on: boolean) { this.updateClip(id, true, c => { c.keyLock = on ? null : false; }); }
  setKeyShift(id: string, semis: number) { const v = Math.min(6, Math.max(-6, semis)); this.updateClip(id, true, c => { c.keyShift = v === 0 ? null : v; }); }
  playedKey(c: Clip): MusicalKey | null { const k = this.structures.get(c.url)?.key; return k ? Key.shifted(k, semitoneShift(c)) : null; }
  suggestedKeyShift(id: string) {
    const i = this.index(id);
    if (i == null || i <= 0) return null;
    const mine = this.structures.get(this.clips[i].url)?.key, theirs = this.playedKey(this.clips[i - 1]);
    if (!mine || !theirs) return null;
    for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) if (Key.isCompatible(Key.shifted(mine, d), theirs)) return d;
    return null;
  }
  matchKeyToPrevious(id: string) { const d = this.suggestedKeyShift(id); if (d != null) this.setKeyShift(id, d); }

  async reanalyze(id: string) {
    const c = this.clip(id);
    if (!c) return;
    const item: PendingTrack = { id: uuid(), url: c.url, name: c.title };
    this.pending = [...this.pending, item];
    this.changed();
    try {
      const { analysis } = await analyze(c.url, { fresh: true });
      if (this.clip(id)) {
        this.updateClip(id, true, x => { x.bpm = analysis.bpm; x.firstBeat = analysis.firstBeat; });
        this.rememberAnalysis(c.url, analysis);
        this.finishTimingEdit();
      }
    } catch (e) {
      this.alertMessage = (e as Error).message;
    } finally {
      this.pending = this.pending.filter(p => p.id !== item.id);
      this.changed();
    }
  }

  // MARK: Loudness (MixStore+Loudness)

  setLoudnessMode(m: LoudnessMode) { this.loudnessMode = m; this.markDirty(); this.applyLoudness(); this.changed(); }
  setDefaultLoudness(m: LoudnessMode) { this.defaultLoudness = m; this.saveSettings(); this.changed(); }

  applyLoudness() {
    const clear = (cs: Clip[]) => (cs.some(c => c.loudnessGainDB != null || c.lufs != null) ? cs.map(c => ({ ...c, loudnessGainDB: null, lufs: null })) : cs);
    if (this.loudnessMode === 'off') {
      this.clips = clear(this.clips);
      this.layers = clear(this.layers);
      return;
    }
    for (const url of new Set([...this.clips, ...this.layers].map(c => c.url))) {
      if (this.loudnessSegments.has(url) || this.loudnessInFlight.has(url) || this.missingFiles.has(url)) continue;
      this.loudnessInFlight.add(url);
      loadLoudness(url).then(seg => {
        this.loudnessInFlight.delete(url);
        if (seg) this.loudnessSegments.set(url, seg);
        this.applyLoudness();
        this.changed();
      });
    }
    const measure = (c: Clip) => {
      const seg = this.loudnessSegments.get(c.url);
      return seg ? integratedLoudness(seg, c.trimStart, c.trimEnd) : null;
    };
    const measured = new Map<number, number>();
    this.clips.forEach((c, i) => { const l = measure(c); if (l != null) measured.set(i, l); });
    if (!measured.size) return;
    let target = Loudness.target(this.loudnessMode);
    if (target == null) { const s = [...measured.values()].sort((a, b) => a - b); target = s[Math.floor(s.length / 2)]; }
    const level = (c: Clip, l: number | null) => {
      if (l == null) return c;
      const g = Math.round(Math.min(12, Math.max(-12, target! - l)) * 10) / 10;
      return c.loudnessGainDB === g && c.lufs === Math.round(l * 10) / 10 ? c : { ...c, loudnessGainDB: g, lufs: Math.round(l * 10) / 10 };
    };
    this.clips = this.clips.map((c, i) => level(c, measured.get(i) ?? null));
    // Layered tracks are brought to the same level as the mix's tracks.
    this.layers = this.layers.map(c => level(c, measure(c)));
  }

  // MARK: Playback

  mixMessage(clips = this.playableClips()): MixMessage {
    const tempo = TempoMap.build(clips, this.masterBPM);
    const paths: Record<string, string> = {};
    for (const c of clips) { const p = this.pcmPaths.get(c.url); if (p) paths[c.url] = p; }
    const layers = placeLayers(this.layers, clips, this.masterBPM).filter(c => !this.missingFiles.has(c.url) && this.pcmPaths.has(c.url));
    for (const c of layers) { const p = this.pcmPaths.get(c.url); if (p) paths[c.url] = p; }
    const stems = { ...this.stemPaths(clips), ...this.stemPaths(layers.map(l => ({ ...l }))) };
    return { clips, layers, master: this.masterBPM, tempo: { reference: tempo.reference, points: tempo.points }, gridOffset: this.gridOffset, paths, stems, sampler: this.samplerMessage() };
  }

  playableClips() { return this.clips.filter(c => !this.missingFiles.has(c.url) && this.pcmPaths.has(c.url)); }

  togglePlay() { if (this.isPlaying) this.pause(); else this.play(); }

  async play() {
    if (!this.clips.length) return;
    if (this.playhead >= this.mixDuration - 0.05) this.playhead = 0;
    try {
      const mix = this.mixMessage();
      this.playingKey = RenderSession.structureKey([...mix.clips, ...(mix.layers ?? [])], mix.master);
      this.isPlaying = true;
      this.changed();
      await this.player.start(mix, this.playhead);
      this.startClock();
    } catch (e) {
      this.isPlaying = false;
      this.alertMessage = L(`再生を開始できませんでした: ${(e as Error).message}`, `Could not start playback: ${(e as Error).message}`);
      this.changed();
    }
  }

  pause() {
    if (!this.isPlaying) return;
    const t = this.player.currentTime;
    this.player.stop();
    this.isPlaying = false;
    this.playhead = Math.min(Math.max(0, t), Math.max(this.mixDuration, 0));
    this.emitClock();
    this.changed();
  }

  seek(t: number) {
    this.playhead = Math.max(0, t);
    this.emitClock();
    if (this.isPlaying) this.restartPlayback(this.playhead);
    this.changed();
  }

  private wasPlayingBeforeScrub = false;
  beginScrub() { this.wasPlayingBeforeScrub = this.isPlaying; if (this.isPlaying) this.pause(); }
  scrub(t: number) { this.playhead = Math.max(0, t); this.emitClock(); }
  endScrub(t: number) { this.playhead = Math.max(0, t); this.emitClock(); if (this.wasPlayingBeforeScrub) this.play(); this.wasPlayingBeforeScrub = false; }

  restartPlayback(t: number | null) {
    if (!this.isPlaying) return;
    const time = t ?? this.player.currentTime;
    const mix = this.mixMessage();
    this.playingKey = RenderSession.structureKey([...mix.clips, ...(mix.layers ?? [])], mix.master);
    this.playhead = time;
    this.player.start(mix, time);
  }

  /** Takes over the current mix while playing: levels / curves live, timing changes restart from where we are. */
  private syncPlayback() {
    const mix = this.mixMessage();
    const key = RenderSession.structureKey([...mix.clips, ...(mix.layers ?? [])], mix.master);
    if (key === this.playingKey) { this.player.update(mix); return; }
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.restartPlayback(null); }, 60);
  }

  previewTransition(id: string) {
    const c = this.clip(id);
    if (!c) return;
    this.seek(Math.max(0, c.start - 4 * this.barLength));
    this.requestScroll(c.start);
    if (!this.isPlaying) this.play();
  }

  private clockRunning = false;
  private startClock() {
    if (this.clockRunning) return;
    this.clockRunning = true;
    const tick = () => {
      if (!this.isPlaying) { this.clockRunning = false; return; }
      const t = this.player.currentTime;
      this.playhead = t;
      this.emitClock();
      if (t > this.mixDuration + 0.3) { this.pause(); this.playhead = this.mixDuration; this.emitClock(); this.clockRunning = false; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private emitClock() { for (const f of this.clockListeners) f(this.playhead); }

  // MARK: View helpers

  zoom(factor: number) { this.pixelsPerSecond = Math.min(400, Math.max(1, this.pixelsPerSecond * factor)); this.changed(); }
  zoomToFit() { this.fitRequest++; this.changed(); }
  requestScroll(t: number) { this.scrollRequest = { id: (this.scrollRequest?.id ?? 0) + 1, time: t }; this.changed(); }
  setSnap(s: SnapUnit) { this.snap = s; this.changed(); }
  /** The detail panel over the whole arrangement area, or back to its height. */
  togglePanelMaximized(on = !this.panelMaximized) {
    this.panelMaximized = on;
    if (on && !this.showPanel) { this.showPanel = true; this.saveSettings(); }
    this.changed();
  }

  toggle(key: 'showPanel' | 'showBrowser' | 'showInspector' | 'showDecks' | 'showMixer' | 'followPlayhead' | 'showMixWaveform' | 'showSamplerLane' | 'keepInLibrary' | 'reopenLast' | 'compressAudio' | 'embedLibraryAudio' | 'exportNormalize' | 'embedMedia' | 'openCueEditorOnAdd') {
    (this as Record<string, unknown>)[key] = !(this as Record<string, unknown>)[key];
    this.saveSettings();
    this.changed();
  }

  // MARK: Mix waveform (mac/DJAW/Store/MixStore+MixWaveform.swift): the export's own render, again whenever the mix
  // changes — only the changed stretch when the rest is merely moved, and exactly in full once editing pauses.

  private peaksTimer: ReturnType<typeof setTimeout> | null = null;
  private peaksJob: { cancel(): void } | null = null;
  /** The mix `mixPeaks` shows exactly (null while it shows a provisional / older one). */
  private mixPeaksSignature: string | null = null;
  private mixPeaksInputs: MixWaveformInputs | null = null;
  private renderingSignature: string | null = null;
  /** While a partial update runs: the real-seconds stretch being rendered (shown dimmed). */
  mixStaleRange: [number, number] | null = null;
  private mixRerunPending = false;
  private exactTimer: ReturnType<typeof setTimeout> | null = null;

  /** Audio the mix plays changed outside the clips (stems became ready): render again. */
  mixInputsChanged() {
    this.scheduleMixWaveform();
    if (this.isPlaying) this.restartPlayback(null);
  }

  private mixSignature() {
    return JSON.stringify([this.masterBPM, this.gridOffset, this.stemSignature(), this.samplerKey(), this.playableClips().map(c => this.pcmPaths.has(c.url)), this.playableClips().map(c => ({ ...c, takes: null, colorIndex: 0, cues: null, cueDone: null, transitionDone: null, autoNote: null, title: null, artist: null }))]);
  }

  private setRendering(sig: string | null) {
    this.renderingSignature = sig;
    this.mixWaveformIsRendering = sig != null;
  }

  /** While tracks are being read, the mix waveform waits (drawing it then only competes with the reading). */
  private mixWaveformHold = 0;
  private holdMixWaveform() { this.mixWaveformHold++; }
  private releaseMixWaveform() { this.mixWaveformHold = Math.max(0, this.mixWaveformHold - 1); if (!this.mixWaveformHold) this.scheduleMixWaveform(); }

  scheduleMixWaveform() {
    if (!this.showMixWaveform || this.isInteracting || this.mixWaveformHold) return;
    const sig = this.mixSignature();
    if (sig === this.renderingSignature || (sig === this.mixPeaksSignature && !this.renderingSignature)) return;
    if (this.peaksTimer) clearTimeout(this.peaksTimer);
    this.peaksTimer = setTimeout(() => this.startMixRender(), 400);
  }

  private startMixRender() {
    if (!this.showMixWaveform) return;
    const sig = this.mixSignature();
    if (sig === this.mixPeaksSignature) {
      this.peaksJob?.cancel(); this.peaksJob = null;
      this.setRendering(null);
      this.mixPeaksPartial = null; this.mixStaleRange = null;
      this.redrawOnly();
      return;
    }
    if (sig === this.renderingSignature) return;
    // A partial update is running: let it finish (it is short), then update from its result.
    if (this.renderingSignature && this.mixStaleRange) { this.mixRerunPending = true; return; }
    this.peaksJob?.cancel(); this.peaksJob = null;
    if (this.exactTimer) { clearTimeout(this.exactTimer); this.exactTimer = null; }
    const clips = this.playableClips();
    if (!clips.length) {
      this.mixPeaks = null; this.mixPeaksSignature = null; this.mixPeaksInputs = null; this.setRendering(null);
      this.redrawOnly();
      return;
    }
    const mix = this.mixMessage(clips);
    const inputs: MixWaveformInputs = { clips, layers: mix.layers, master: mix.master, tempo: new TempoMap(mix.tempo.reference, mix.tempo.points), gridOffset: mix.gridOffset, sampleRate: 44100, stems: this.stemSignature() };
    // Only part of the mix changed: re-render that stretch and move the rest along.
    const old = this.mixPeaks, before = this.mixPeaksInputs;
    // (Sampler hits stay on the grid when tracks move, so with any placed the whole mix is drawn again.)
    if (old && before && !this.mixPeaksPartial && !this.sampleHits.length) {
      const ch = mixWaveformChange(before, inputs);
      const prov = ch && provisionalPeaks(ch, old, inputs);
      if (ch && prov) { this.renderChangedPart(ch, prov, inputs, mix, sig); return; }
    }
    this.renderWholeMix(inputs, mix, sig);
  }

  private redrawOnly() { for (const f of this.listeners) f(); }

  private renderWholeMix(inputs: MixWaveformInputs, mix: MixMessage, sig: string) {
    this.setRendering(sig);
    this.mixPeaksPartial = null;
    this.mixStaleRange = null;
    const job = Jobs.peaks(mix, p => { if (this.peaksJob === job) { this.mixPeaksPartial = p; this.redrawOnly(); } });
    this.peaksJob = job;
    job.promise.then(r => {
      if (this.peaksJob !== job) return;
      this.mixPeaks = r.peaks;
      this.mixPeaksSignature = sig;
      this.mixPeaksInputs = inputs;
    }, () => { /* cancelled / failed */ }).finally(() => {
      if (this.peaksJob !== job) return;
      this.peaksJob = null;
      this.mixPeaksPartial = null;
      this.setRendering(null);
      this.redrawOnly();
    });
  }

  /** Shows the old waveform moved to the new layout at once, renders only the changed stretch, then splices it in. */
  private renderChangedPart(ch: MixWaveformChange, provisional: MixPeaks, inputs: MixWaveformInputs, mix: MixMessage, sig: string) {
    this.setRendering(sig);
    this.mixPeaks = provisional;
    this.mixPeaksSignature = null;
    this.mixPeaksInputs = inputs;
    this.mixStaleRange = [ch.fromReal, ch.toReal];
    const job = Jobs.peakRange(mix, provisional.binsPerSecond, ch.fromReal, ch.toReal);
    this.peaksJob = job;
    this.redrawOnly();
    job.promise.then(r => {
      if (this.peaksJob !== job || !this.mixPeaks) return;
      this.mixPeaks = splicePeaks(this.mixPeaks, r.range);
      // Nothing moved by a fraction of a bin: exactly what a full render gives. Otherwise, render in full later.
      if (ch.exact) this.mixPeaksSignature = sig; else this.scheduleExactMixRender(sig);
    }, () => { if (this.peaksJob === job) this.mixPeaksInputs = null; }).finally(() => {
      if (this.peaksJob !== job) return;
      this.peaksJob = null;
      this.setRendering(null);
      this.mixStaleRange = null;
      this.redrawOnly();
      if (this.mixRerunPending) { this.mixRerunPending = false; this.startMixRender(); }
      else this.scheduleMixWaveform();
    });
  }

  /** After a partial update that moved the rest of the mix by a fraction of a bin, the full render once editing has
   *  paused for 20 s (without dimming the lane: what is shown is already right to within a few milliseconds). */
  private scheduleExactMixRender(sig: string) {
    if (this.exactTimer) clearTimeout(this.exactTimer);
    this.exactTimer = setTimeout(() => {
      this.exactTimer = null;
      if (!this.showMixWaveform || this.mixSignature() !== sig || this.renderingSignature) return;
      if (this.isPlaying || this.isInteracting) { this.scheduleExactMixRender(sig); return; }
      const clips = this.playableClips();
      const mix = this.mixMessage(clips);
      const inputs: MixWaveformInputs = { clips, layers: mix.layers, master: mix.master, tempo: new TempoMap(mix.tempo.reference, mix.tempo.points), gridOffset: mix.gridOffset, sampleRate: 44100, stems: this.stemSignature() };
      const job = Jobs.peaks(mix, () => {});
      this.peaksJob = job;
      job.promise.then(r => {
        if (this.peaksJob !== job || this.mixSignature() !== sig || this.renderingSignature) return;
        this.mixPeaks = r.peaks;
        this.mixPeaksSignature = sig;
        this.mixPeaksInputs = inputs;
        this.redrawOnly();
      }, () => {}).finally(() => { if (this.peaksJob === job) this.peaksJob = null; });
    }, 20000);
  }

  // MARK: Documents

  async confirmDiscard(): Promise<boolean> {
    if (!this.isDirty || (!this.clips.length && !this.library.length)) return true;
    const r = await ipcRenderer.invoke('dialog:message', {
      type: 'question', message: L('現在のミックスへの変更を保存しますか？', 'Save changes to the current mix?'),
      detail: L('保存しない場合、変更は失われます。', 'Your changes will be lost if you don’t save them.'),
      buttons: [L('保存', 'Save'), L('保存しない', 'Don’t Save'), L('キャンセル', 'Cancel')], defaultId: 0, cancelId: 2,
    });
    if (r === 0) return this.save();
    return r === 1;
  }

  async newProject() {
    if (!(await this.confirmDiscard())) return;
    this.pause();
    this.projectID = uuid();
    this.clips = []; this.library = []; this.layers = []; this.libraryFolders = []; this.samples = []; this.sampleHits = [];
    this.notes = ''; this.loudnessMode = this.defaultLoudness;
    this.masterBPM = 124; this.gridOffset = 0;
    this.documentPath = null;
    this.undoStack = []; this.redoStack = [];
    this.selectedClipID = null; this.playhead = 0;
    this.missingFiles = new Set(); this.colorCounter = 0;
    this.macAnalyses = null; this.macProfiles = null;
    this.isDirty = false;
    this.removeAutosave();
    this.changed();
    this.emitClock();
  }

  async openProject() {
    if (!(await this.confirmDiscard())) return;
    const r = await ipcRenderer.invoke('dialog:open', {
      title: L('ミックスを開く', 'Open Mix'), properties: ['openFile'],
      filters: [{ name: 'DJAW Mix', extensions: ['djaw', 'json'] }],
    });
    if (r && r[0]) await this.load(r[0]);
  }

  async openRecent(p: string) { if (await this.confirmDiscard()) await this.load(p); }

  private static relink<T extends { url: string; relativePath?: string | null }>(c: T, projectFile: string | null): T {
    if (fs.existsSync(c.url) || !c.relativePath || !projectFile) return c;
    const candidate = resolveRelative(path.dirname(projectFile), c.relativePath);
    return candidate ? { ...c, url: candidate } : c;
  }

  async load(file: string, asRecovery = false) {
    try {
      const opened = readProject(file);
      const f = opened.file;
      if (f.format && f.format !== projectFormatID) { this.alertMessage = L('DJAW のミックスファイルではありません。', 'This is not a DJAW mix file.'); this.changed(); return; }
      this.pause();
      this.masterBPM = f.masterBPM;
      this.gridOffset = f.gridOffset;
      this.snap = f.snap ?? 'phrase';
      this.defaultTransitionBars = f.defaultTransitionBars ?? 16;
      this.defaultTransitionStyle = f.defaultTransitionStyle ?? 'bassSwap';
      const base = asRecovery ? f.originalPath ?? null : file;
      this.projectID = f.projectID ?? (asRecovery ? this.projectID : uuid());
      const media = new Map((f.media ?? []).map(m => [m.id, m]));
      let unpackFailed = 0;
      const extracting: Promise<void>[] = [];
      const unpack = <T extends { url: string; relativePath?: string | null; mediaID?: string | null }>(clip: T): T => {
        const c = MixStore.relink(clip, base);
        if (fs.existsSync(c.url) || opened.blobStart == null || !c.mediaID) return c;
        const m = media.get(c.mediaID);
        if (!m) return c;
        const dest = path.join(mediaFolder(path.dirname(dataDir()), this.projectID), unpackedName(m));
        extracting.push(extractMediaAsync(m, file, opened.blobStart, dest).catch(() => { unpackFailed++; }));
        return { ...c, url: dest };
      };
      const clips = f.clips.map(unpack);
      const library = (f.library ?? []).map(unpack);
      const layers = (f.layers ?? []).map(unpack);
      const samples = (f.samples ?? []).map(unpack);
      if (extracting.length) {
        // Unpacking the audio of a large mix takes a while: show the tracks as "reading" meanwhile.
        const names = [...clips, ...library].map(c => ({ id: uuid(), url: c.url, name: path.basename(c.url, path.extname(c.url)), stage: 'decode' as const }));
        this.pending = [...this.pending, ...names];
        this.changed();
        await Promise.all(extracting);
        const ids = new Set(names.map(n => n.id));
        this.pending = this.pending.filter(p => !ids.has(p.id));
      }
      this.clips = clips;
      this.library = library;
      this.layers = layers.filter(l => clips.some(c => c.id === l.layerOf));
      this.libraryFolders = f.libraryFolders ?? [];
      this.samples = samples;
      this.sampleHits = (f.sampleHits ?? []).filter(h => samples.some(x => x.id === h.sample));
      this.samplePcm.clear();
      void this.prepareSamples();
      if (unpackFailed) this.alertMessage = L(`${unpackFailed}曲の音声をファイルから取り出せませんでした。`, `Could not unpack the audio of ${unpackFailed} track(s).`);
      this.applyLayout();
      this.notes = f.notes ?? '';
      this.loudnessMode = f.loudnessMode ?? 'off';
      for (const p of f.customTransitions ?? []) if (!this.customTransitions.some(x => x.id === p.id)) this.customTransitions.push(p);
      this.colorCounter = Math.max(-1, ...[...this.clips, ...this.library].map(c => c.colorIndex)) + 1;
      this.documentPath = asRecovery ? base : file;
      this.undoStack = []; this.redoStack = [];
      this.missingFiles = new Set([...this.clips, ...this.library, ...this.layers].map(c => c.url).filter(u => !fs.existsSync(u)));
      this.macAnalyses = f.analyses ?? null;
      this.macProfiles = f.profiles ?? null;
      TrackProfiles.importBlobs(f.profiles);
      this.applySavedProfiles();
      this.prepareStemsIfNeeded();
      this.artworkCache.clear();
      this.waveforms.clear(); this.structures.clear();
      if (f.ui) {
        this.playhead = f.ui.playhead;
        this.selectedClipID = f.ui.selectedClipID && this.clip(f.ui.selectedClipID) ? f.ui.selectedClipID : null;
        this.showDecks = f.ui.showDecks;
        if (f.ui.showMixer != null) this.showMixer = f.ui.showMixer;
        this.showInspector = f.ui.showInspector;
        this.pixelsPerSecond = f.ui.pixelsPerSecond;
        this.requestScroll(f.ui.scrollTime + (this.visibleRange[1] - this.visibleRange[0]) / 2);
      } else {
        this.selectedClipID = null;
        this.playhead = 0;
        this.fitRequest++;
      }
      this.isDirty = asRecovery;
      if (!asRecovery) this.noteRecent(file);
      if (this.missingFiles.size) this.alertMessage = L(`${this.missingFiles.size}個の音声ファイルが見つかりません。移動または削除された可能性があります。`, `${this.missingFiles.size} audio file(s) could not be found. They may have been moved or deleted.`);
      this.changed();
      this.emitClock();
      await this.loadAnalyses();
    } catch (e) {
      this.alertMessage = L(`ミックスを開けませんでした: ${(e as Error).message}`, `Could not open the mix: ${(e as Error).message}`);
      this.changed();
    }
  }

  /**
   * Waveforms / structures for every track, in this order:
   *   1. saved analyses — at once, before any audio is read;
   *   2. the audio of every track (mix order, then the library), so the mix plays, and for tracks without a saved
   *      analysis a quick pass (waveform, energy tempo, structure — about a second each);
   *   3. the full analyses (beats, cues, genre — the slow part), one track after another in mix order.
   * The mix waveform is drawn once step 2 is done.
   */
  async loadAnalyses() {
    const urls = [...new Set([...this.clips, ...this.library, ...this.layers].map(c => c.url))].filter(u => !this.missingFiles.has(u) && !this.waveforms.has(u));
    const items: (PendingTrack & { saved: boolean })[] = urls.map(u => ({ id: uuid(), url: u, name: path.basename(u, path.extname(u)), saved: false }));
    if (!items.length) { this.runPendingAutoMix(); return; }
    this.pending = [...this.pending, ...items];
    const done = (item: PendingTrack) => { this.pending = this.pending.filter(p => p.id !== item.id); };
    const show = (url: string, a: TrackAnalysis) => {
      this.rememberAnalysis(url, a);
      // The saved tempo / grid wins; rebuild the structure on that grid.
      const c = [...this.clips, ...this.library, ...this.layers].find(x => x.url === url);
      if (c && Math.abs(c.bpm - a.bpm) > 0.01 && a.energies) {
        const st = structureFor(a.energies, c.bpm, c.firstBeat);
        if (st) this.structures.set(url, st);
      }
    };
    // 1. Saved analyses.
    for (const item of items) {
      const hit = cachedAnalysis(item.url);
      if (!hit) continue;
      item.saved = true;
      this.fingerprints.set(item.url, hit.fp);
      show(item.url, hit.analysis);
      const ready = enginePath(item.url, hit.fp);
      if (ready) { this.pcmPaths.set(item.url, ready); done(item); }
    }
    this.changed();
    // 2. The audio, and a quick pass where nothing is saved.
    const failed: string[] = [];
    const deep: typeof items = [];
    this.holdMixWaveform();
    try {
      await Promise.all(items.filter(i => this.pending.some(p => p.id === i.id)).map(async item => {
        try {
          const fp = this.fingerprints.get(item.url) ?? fingerprint(item.url);
          if (!fp) throw new Error(L('読めません', 'unreadable'));
          this.fingerprints.set(item.url, fp);
          this.pcmPaths.set(item.url, await ensurePcm(item.url, fp));
          this.mixInputsChanged();
        } catch (e) {
          console.error('[DJAW] could not read', item.url, e);
          this.missingFiles.add(item.url);
          done(item);
          return;
        }
        if (item.saved) { done(item); return; }
        try {
          const { analysis } = await analyzeQuick(item.url, (stage, f) => { item.stage = stage; item.fraction = f; this.changed(); });
          if (!this.waveforms.has(item.url)) show(item.url, analysis);
          item.stage = 'beats'; item.fraction = 0;
          deep.push(item);
        } catch (e) {
          // The track still plays and exports: only the audio is needed for that.
          console.error('[DJAW] analysis failed', item.url, e);
          failed.push(`${item.name}（${(e as Error).message}）`);
          done(item);
        } finally {
          this.changed();
        }
      }));
    } finally {
      this.releaseMixWaveform();
    }
    this.applyLoudness();
    this.changed();
    // 3. The full analyses, in mix order.
    deep.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));
    for (const item of deep) {
      try {
        const { analysis, pcm, fp } = await analyze(item.url, { progress: (stage, f) => { item.stage = stage; item.fraction = f; this.changed(); } });
        this.pcmPaths.set(item.url, pcm);
        this.fingerprints.set(item.url, fp);
        show(item.url, analysis);
      } catch (e) {
        // Without the full analysis the track still plays and exports (the quick pass gave its waveform).
        console.error('[DJAW] analysis failed', item.url, e);
        failed.push(`${item.name}（${(e as Error).message}）`);
      } finally {
        done(item);
        this.changed();
      }
    }
    if (failed.length) {
      this.alertMessage = L(`次の曲を解析できませんでした（再生と書き出しはできます）：\n${failed.join('\n')}`, `These tracks could not be analysed (they still play and export):\n${failed.join('\n')}`);
    }
    this.applyLoudness();
    this.changed();
    this.runPendingAutoMix();
  }

  noteRecent(file: string) {
    this.recentDocuments = [file, ...this.recentDocuments.filter(p => p !== file)].slice(0, 10);
    this.saveSettings();
    ipcRenderer.send('recent:add', file);
  }

  private static relativePath(fromDir: string, to: string) {
    return path.relative(fromDir, to).split(path.sep).join('/');
  }

  makeProjectFile(file: string | null, originalPath: string | null = null): ProjectFile {
    const dir = file ? path.dirname(file) : null;
    const withRel = <T extends { url: string }>(c: T): T => (dir ? { ...c, relativePath: MixStore.relativePath(dir, c.url) } : c);
    const used = this.customTransitions.filter(p => this.clips.some(c => c.transition === 'custom' && JSON.stringify(c.lanes) === JSON.stringify(p.lanes)));
    return {
      format: projectFormatID, version: projectVersion, savedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), appVersion: 'win-0.1',
      originalPath, notes: this.notes,
      ui: { playhead: this.playhead, pixelsPerSecond: this.pixelsPerSecond, scrollTime: this.visibleRange[0], selectedClipID: this.selectedClipID, showDecks: this.showDecks, showMixer: this.showMixer, showInspector: this.showInspector },
      customTransitions: used, masterBPM: this.masterBPM, gridOffset: this.gridOffset,
      defaultTransitionBars: this.defaultTransitionBars, defaultTransitionStyle: this.defaultTransitionStyle,
      library: this.library.map(withRel), libraryFolders: this.libraryFolders.length ? this.libraryFolders : null,
      samples: this.samples.length ? this.samples.map(withRel) : null, sampleHits: this.sampleHits.length ? this.sampleHits : null, snap: this.snap, clips: this.clips.map(withRel), projectID: this.projectID,
      layers: this.layers.filter(l => this.clips.some(c => c.id === l.layerOf)).map(withRel),
      loudnessMode: this.loudnessMode, analyses: this.macAnalyses,
      profiles: (TrackProfiles.blobs([...this.clips, ...this.library, ...this.layers].map(c => c.url)) as Record<string, unknown> | null) ?? this.macProfiles,
    };
  }

  async save(saveAs = false): Promise<boolean> {
    let target = this.documentPath;
    if (saveAs || !target) {
      const r = await ipcRenderer.invoke('dialog:save', {
        title: L('ミックスを保存', 'Save Mix'), defaultPath: (this.documentPath ? path.basename(this.documentPath, '.djaw') : 'My Mix') + '.djaw',
        filters: [{ name: 'DJAW Mix', extensions: ['djaw'] }],
        message: this.embedMedia ? L('曲の音声も含むので、この1ファイルだけで開けます', 'Includes the audio, so this one file is all you need') : L('音声は含みません。曲ファイルは元の場所から読み込みます', 'Without audio; tracks are read from their original files'),
      });
      if (!r) return false;
      target = r;
    }
    try {
      if (this.embedMedia) {
        const ids = new Map<string, string>();
        // DJAW's own sampler sounds come with every install: not embedded (found again when opened, store/sampler.ts).
        for (const c of [...this.clips, ...this.library, ...this.layers, ...this.samples]) if (c.mediaID && !isBuiltinSample(c.url)) ids.set(c.url, c.mediaID);
        const assign = <T extends { url: string; mediaID?: string | null }>(c: T): T => {
          let id = ids.get(c.url);
          if (!id) { id = uuid().slice(0, 8); ids.set(c.url, id); }
          return c.mediaID === id ? c : { ...c, mediaID: id };
        };
        this.clips = this.clips.map(assign);
        this.library = this.library.map(assign);
        this.layers = this.layers.map(assign);
        this.samples = this.samples.map(c => (isBuiltinSample(c.url) ? (c.mediaID ? { ...c, mediaID: null } : c) : assign(c)));
        // Library tracks (not in the mix) only when wanted.
        const used = new Set([...this.clips, ...this.layers, ...this.samples].map(c => c.url));
        const wantedUrls = [...ids.entries()].filter(([u]) => fs.existsSync(u) && (this.embedLibraryAudio || used.has(u)));
        const media: { id: string; file: string; name?: string }[] = [];
        for (const [u, id] of wantedUrls) media.push(this.compressAudio ? await this.losslessCopy(u, id) : { id, file: u });
        media.sort((a, b) => a.id.localeCompare(b.id));
        // Writing into the file the media is read from: copy those out of the old package first.
        await writeProjectAsync(this.makeProjectFile(target!), media, target!);
      } else {
        fs.writeFileSync(target!, encodeProject(this.makeProjectFile(target!)));
      }
      this.documentPath = target;
      this.isDirty = false;
      this.removeAutosave();
      this.noteRecent(target!);
      this.changed();
      return true;
    } catch (e) {
      this.alertMessage = L(`保存できませんでした: ${(e as Error).message}`, `Could not save: ${(e as Error).message}`);
      this.changed();
      return false;
    }
  }

  // MARK: Autosave / recovery

  private static get autosavePath() { return dataDir('Autosave.djaw'); }

  private scheduleAutosave() {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.writeAutosave(), 20000);
  }

  private writeAutosave() {
    if (!this.isDirty || (!this.clips.length && !this.library.length)) return;
    try {
      fs.mkdirSync(path.dirname(MixStore.autosavePath), { recursive: true });
      fs.writeFileSync(MixStore.autosavePath, encodeProject(this.makeProjectFile(this.documentPath, this.documentPath)));
    } catch (e) { console.warn('[DJAW] autosave failed', e); }
  }

  /**
   * A WAV to embed, as lossless FLAC (kept in the cache, so saving again does not encode again);
   * other files (MP3, AAC, FLAC… already compressed) as they are.
   */
  private async losslessCopy(file: string, id: string): Promise<{ id: string; file: string; name?: string }> {
    if (!/\.wav$/i.test(file)) return { id, file };
    try {
      const st = fs.statSync(file);
      const key = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
      const dir = dataDir('cache', 'flac');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, key + '.flac');
      if (!fs.existsSync(dest)) {
        const r = await Jobs.flac(file, dest).promise;
        if (!r.ok) return { id, file };
      }
      return { id, file: dest, name: path.basename(file).replace(/\.wav$/i, '') + '.flac' };
    } catch (e) {
      console.warn('[DJAW] FLAC failed, embedding the WAV', e);
      return { id, file };
    }
  }

  removeAutosave() { try { fs.rmSync(MixStore.autosavePath); } catch { /* none */ } }

  /** At start (no file given): the last mix, unless unsaved work was just restored or something is open already. */
  async openLastAtStartup() {
    const restored = await (this.recovery ?? Promise.resolve(false));
    if (restored || !this.reopenLast || this.documentPath || this.clips.length || this.library.length) return;
    const last = this.recentDocuments.find(p => fs.existsSync(p));
    if (last) await this.load(last);
  }

  offerRecoveryIfNeeded() {
    this.recovery = this.offerRecovery();
    return this.recovery;
  }

  /** True when unsaved work was restored. */
  private async offerRecovery(): Promise<boolean> {
    const p = MixStore.autosavePath;
    if (!fs.existsSync(p)) return false;
    const r = await ipcRenderer.invoke('dialog:message', {
      type: 'question', message: L('保存されていない作業が見つかりました', 'Unsaved work was found'),
      detail: L('前回 DJAW が終了した時に保存されていなかったミックスがあります。復元しますか？', 'A mix was not saved when DJAW last quit. Restore it?'),
      buttons: [L('復元', 'Restore'), L('破棄', 'Discard')], defaultId: 0, cancelId: 1,
    });
    const backups = dataDir('Recovered');
    fs.mkdirSync(backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(p, path.join(backups, `Recovered-${stamp}.djaw`)); } catch { /* ignore */ }
    if (r === 0) await this.load(p, true);
    this.removeAutosave();
    return r === 0;
  }

  // MARK: Export

  async startExport(normalize: boolean) {
    const m4a = this.exportFormat === 'aac256';
    const r = await ipcRenderer.invoke('dialog:save', {
      title: L('書き出し', 'Export'), defaultPath: this.documentTitle + (m4a ? '.m4a' : '.wav'),
      filters: [m4a ? { name: 'M4A (AAC)', extensions: ['m4a'] } : { name: 'WAV', extensions: ['wav'] }],
    });
    if (!r) return;
    this.pause();
    this.exportNormalize = normalize;
    this.saveSettings();
    this.exportPhase = { kind: 'rendering', progress: 0 };
    this.exportStartedAt = Date.now();
    this.exportSteady = null;
    this.changed();
    await this.ensureStemsForExport();
    const knownPeak = this.knownMixPeak();
    const job = Jobs.export(this.mixMessage(), r, { sampleRate: this.exportSampleRate, normalize, bits: 24, format: this.exportFormat }, knownPeak, p => {
      if (this.exportPhase.kind !== 'rendering') return;
      this.exportPhase = { kind: 'rendering', progress: p };
      const steadyFrom = normalize && knownPeak == null ? 0.02 : 0.02;
      if (!this.exportSteady && p > steadyFrom) this.exportSteady = { progress: p, at: Date.now() };
      this.changed();
    });
    this.exportJob = job;
    try {
      await job.promise;
      this.exportPhase = { kind: 'done', path: r };
    } catch (e) {
      if ((e as Error).message === 'cancelled') { try { fs.rmSync(r); } catch { /* ignore */ } this.exportPhase = { kind: 'idle' }; }
      else this.exportPhase = { kind: 'failed', message: (e as Error).message };
    }
    this.exportJob = null;
    this.changed();
  }

  exportJob: { cancel(): void } | null = null;
  /** The peak of the mix waveform when it matches the mix as it is now (saves the normalize pass). */
  knownMixPeak() { return this.mixPeaksSignature != null && this.mixPeaksSignature === this.mixSignature() && this.mixPeaks ? this.mixPeaks.peak : null; }
  cancelExport() { this.exportJob?.cancel(); }

  /** Seconds left, from the steady part of the render only (null = not known yet). */
  get exportRemaining(): number | null {
    if (this.exportPhase.kind !== 'rendering' || !this.exportSteady) return null;
    const p = this.exportPhase.progress, s = this.exportSteady;
    const dt = (Date.now() - s.at) / 1000;
    if (dt < 2 || p <= s.progress) return null;
    return (1 - p) * dt / (p - s.progress);
  }

  // MARK: Misc

  copyTrackList() {
    clipboard.writeText(PerformanceGuide.trackList(this.clips, this.masterBPM, this.tempoMap, false, this.layers));
  }

  revealInFolder(id: string) { const c = this.clip(id); if (c) shell.showItemInFolder(c.url); }
  revealPath(p: string) { shell.showItemInFolder(p); }

  /** Opens the auto-arrange sheet with these tracks ticked. */
  autoArrangePreselecting(ids: string[]) { this.autoArrangePreselect = new Set(ids); this.showAutoArrange = true; this.changed(); }
}

export const store = new MixStore();
