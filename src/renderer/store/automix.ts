// The auto-mix part of the store (mac/DJAW/Store/MixStore.swift "Auto-mix", "Genre", "Quick-cut style",
// "Variations", "Whole-mix patterns", "Render check", "Tempo readings", "Auto-arrange").
import { L, captureLanguages, localize } from '../../core/i18n';
import {
  Clip, ClipFX, Mathx, Style, TransitionStyle, barAtSource, landingBar, resetToWholeTrack, sourceTimeAtBar,
} from '../../core/models';
import { FX } from '../../core/tempo';
import { suggestedMixOut } from '../../core/layout';
import { Key, Structure, TrackStructure } from '../../core/analysis/structure';
import { tempoRegions, tempoVaries } from '../../core/analysis/neural';
import { onsetOffset, structureFor, structureTrusted } from '../../core/analysis/analyzer';
import { Genre, Genres, MixGenre } from '../../core/genre';
import {
  AutoMixPlan, AutoMixer, Highlight, MixProfile, MixStyle, MixStyles, MixTuning, OrderItem, Profiles, SetArc, Vocals, setMixTuning,
} from '../../core/automixer';
import { Jobs } from '../services/jobs';
import { Fmt } from '../format';
import { MixStore, Snapshot } from './store';

export interface TransitionVariation { id: string; plan: AutoMixPlan; problems: string[] | null }

export interface MixPattern {
  id: string;
  title: string;
  detail: string;
  state: Snapshot;
  structures: Map<string, TrackStructure>;
  blends: number;
  cuts: number;
  averageBars: number;
  duration: number;
}

interface PlanContext { aMin: number; aLanding: number; ratio: number; profile: MixProfile; vocals: Vocals }

let nextID = 1;
const newID = () => `p${nextID++}`;

declare module './store' {
  interface MixStore {
    clipBar(c: Clip, s: TrackStructure, bar: number): number;
    structureBar(c: Clip, s: TrackStructure, bar: number): number;
    keyClash(a: TrackStructure, b: TrackStructure): boolean;
    applyAutoTransition(i: number, earliestOut: number | null, option?: number, force?: boolean): number | null;
    planContext(i: number, earliestOut: number | null): PlanContext | null;
    applyPlan(plan: AutoMixPlan, i: number): number | null;
    lockedLanding(i: number): number | null;
    fixLockedEntries(): void;
    isLockMember(i: number): boolean;
    lockUnits(ids: string[]): string[][];
    planTempos(start: number, end?: number | null, instant?: boolean): void;
    autoMixAll(): void;
    runPendingAutoMix(): void;
    profileFor(a: Clip, b: Clip): MixProfile;
    genreFor(c: Clip): MixGenre | null;
    genreSource(c: Clip): string | null;
    vocalBars(c: Clip): number[] | null;
    energyLevel(c: Clip): number | null;
    genreSummary(): { genre: MixGenre; count: number }[];
    setGenre(id: string, g: MixGenre | null): void;
    genreLine(a: MixGenre | null, b: MixGenre | null): string | null;
    looksQuick(c: Clip): boolean;
    resolvedStyle(indices: number[]): MixStyle;
    isQuickTrack(c: Clip): boolean;
    styleSummary(indices: number[]): string;
    plan(start: number): void;
    planOnly(start: number): void;
    variationList(id: string): TransitionVariation[] | null;
    computeVariations(id: string): void;
    applyVariation(id: string, k: number): void;
    previewVariation(id: string, k: number): void;
    isCurrentVariation(id: string, k: number): boolean;
    checkVariations(id: string): Promise<void>;
    planPatterns(start: number): void;
    computeReplannable(): void;
    restoreQuietly(s: Snapshot, st: Map<string, TrackStructure>): void;
    usePattern(id: string): void;
    startVerification(start: number): void;
    verifyAndRepair(start: number): Promise<void>;
    refitFollowing(i: number): void;
    noteCheck(i: number, tried: { option: number; problems: string[] }[]): void;
    planTransitionsMixed(start: number): void;
    quickHighlight(c: Clip): { highlight: Highlight; bpm: number; firstBeat: number; structure: TrackStructure } | null;
    planTransitionsQuick(start: number): void;
    readings(c: Clip): { bpm: number; firstBeat: number; penalty: number }[];
    harmonizeTempos(): void;
    orderItem(c: Clip): OrderItem;
    suggestedOrder(ids: string[]): string[];
    autoArrange(ids: string[], reorder: boolean, replace: boolean): void;
    planTransitions(start: number): void;
    autoMixTransition(id: string): void;
    autoNoteText(c: Clip): string | null;
    attackAligned(url: string, bpm: number, firstBeat: number, t0?: number, t1?: number | null): number;
    alignGridsToAI(ids: string[], undoable?: boolean): void;
    alignAllGridsToAI(): void;
    aiGridMismatches(): number;
    aiCues(c: Clip): { bar: number; score: number }[];
    preserveTransitionBeforeReplacing(i: number): void;
    previewTake(id: string, takeID: string): void;
    newTakeFromAuto(id: string): void;
    checkOne(i: number): Promise<{ problems: string[] } | null>;
    editableClips(): void;
    setMixStyle(s: MixStyle): void;
    setSetArc(a: SetArc): void;
    setTrackUse(u: import('../../core/models').TrackUse): void;
    setVerifyTransitions(on: boolean): void;
  }
}

const P = MixStore.prototype;
const S = Structure;

/** Fresh copies of the clip objects, so the planner can change fields in place (undo snapshots are deep copies). */
P.editableClips = function () { this.clips = this.clips.map(c => ({ ...c })); };

P.clipBar = function (c, s, bar) { return Math.round(barAtSource(c, S.timeOfBar(s, bar)) * 4) / 4; };
P.structureBar = function (c, s, bar) { return Math.round(S.barAtTime(s, sourceTimeAtBar(c, bar))); };
P.keyClash = function (a, b) {
  const ka = a.key, kb = b.key;
  if (!ka || !kb || ka.confidence <= 0.5 || kb.confidence <= 0.5) return false;
  return !Key.isCompatible(ka, kb);
};

P.isLockMember = function (i) { return this.isLocked(i) || this.isLocked(i + 1); };
P.lockUnits = function (ids) {
  const set = new Set(ids), used = new Set<string>();
  const units: string[][] = [];
  for (const id of ids) {
    if (used.has(id)) continue;
    const i = this.index(id);
    if (i == null) { units.push([id]); used.add(id); continue; }
    let a = i;
    while (this.isLocked(a) && set.has(this.clips[a - 1].id) && !used.has(this.clips[a - 1].id)) a--;
    let b = i;
    while (b + 1 < this.clips.length && this.isLocked(b + 1) && set.has(this.clips[b + 1].id)) b++;
    const u = this.clips.slice(a, b + 1).map(c => c.id).filter(x => !used.has(x));
    units.push(u);
    for (const x of u) used.add(x);
  }
  return units;
};

P.applyAutoTransition = function (i, earliestOut, option = 0, force = false) {
  if (i <= 0 || i >= this.clips.length) return null;
  if (this.isLocked(i) && !force) return this.lockedLanding(i);
  const a = this.clips[i - 1], b = this.clips[i];
  const sa = this.structures.get(a.url), sb = this.structures.get(b.url);
  if (!sa || !sb) {
    // Not analysed (yet): an 8-bar phrase exit with a 16-bar bass swap.
    Object.assign(this.clips[i], { transition: 'bassSwap', transitionBars: 16, shape: null, lanes: null, autoNote: null });
    this.clips[i - 1].mixOutBar = suggestedMixOut(this.clips[i - 1], 16, this.waveforms.get(a.url));
    return null;
  }
  const ctx = this.planContext(i, earliestOut);
  if (!ctx) return null;
  const plans = AutoMixer.planOptions(sa, sb, ctx.aMin, this.keyClash(sa, sb), ctx.ratio, ctx.profile, ctx.vocals, option + 1, ctx.aLanding);
  if (plans.length <= option) return null;
  return this.applyPlan(plans[option], i);
};

P.planContext = function (i, earliestOut) {
  if (i <= 0 || i >= this.clips.length) return null;
  const a = this.clips[i - 1], b = this.clips[i];
  const sa = this.structures.get(a.url), sb = this.structures.get(b.url);
  if (!sa || !sb) return null;
  const aLanding = this.structureBar(a, sa, i - 1 === 0 ? a.mixInBar : landingBar(a));
  return {
    aMin: earliestOut ?? aLanding + 8, aLanding,
    ratio: Math.max(sa.bpm, sb.bpm) / Math.max(1, Math.min(sa.bpm, sb.bpm)),
    profile: this.profileFor(a, b),
    vocals: new Vocals(this.vocalBars(a), this.vocalBars(b)),
  };
};

const fx = (kind: ClipFX['kind'], bar: number, bars: number, o: { amount?: number; shape?: ClipFX['shape']; division?: number } = {}): ClipFX => {
  const f = FX.make(kind, bar, { bars, amount: o.amount, shape: o.shape, auto: true });
  if (o.division != null) f.division = o.division;
  return f;
};

P.applyPlan = function (plan, i) {
  if (i <= 0 || i >= this.clips.length) return null;
  const a = this.clips[i - 1], b = this.clips[i];
  const sa = this.structures.get(a.url), sb = this.structures.get(b.url);
  if (!sa || !sb) return null;
  const ga = this.genreFor(a), gb = this.genreFor(b);
  const profile = this.profileFor(a, b);
  this.replannable.add(b.id);
  const prev = this.clips[i - 1], cur = this.clips[i];
  prev.mixOutBar = this.clipBar(a, sa, plan.outBar);
  cur.mixInBar = this.clipBar(b, sb, plan.inBar);
  cur.transitionBars = plan.length;
  cur.transition = plan.style;
  cur.shape = plan.shape;
  cur.lanes = null;
  cur.landingLock = null;
  const reasons = [...plan.reasons];
  const line = this.genreLine(ga, gb);
  if (line) reasons.unshift(line);
  if (plan.label) reasons.unshift(L(`つなぎ方：${plan.label}`, `Variation: ${plan.label}`));
  // Effects that go with the chosen transition (replaced whenever it is planned again).
  prev.fx = (prev.fx ?? []).filter(f => f.auto !== true);
  const out = prev.mixOutBar;
  const aFull = S.hasBass(sa, plan.outBar - 1);
  const add = (f: ClipFX) => { prev.fx = [...(prev.fx ?? []), f]; };
  if (plan.style === 'bassSwap' && plan.length >= 16 && profile.thinOut) {
    const half = plan.length / 2;
    add(fx('highPass', out + half, half, { amount: 0.5, shape: 'rise' }));
    reasons.push(L('後半は前の曲にハイパスをかけて軽くしながら抜く', 'The previous track is thinned out with a high-pass in the second half'));
  } else if (plan.style === 'cut' && aFull) {
    add(fx('roll', out - 0.5, 0.5, { division: 0.25 }));
    reasons.push(L('切り替え直前の2拍をロールで刻んで次のドロップへ', 'A short roll over the last two beats leads into the drop'));
  } else if (plan.style === 'echoOut' || plan.style === 'backspin') {
    add(fx('reverb', out - 1, 2, { amount: 0.45, shape: 'rise' }));
  } else if (profile.reverbTail && plan.style === 'crossfade' && plan.length >= 8) {
    const half = plan.length / 2;
    add(fx('reverb', out + half, half, { amount: 0.4, shape: 'rise' }));
    reasons.push(L('前の曲はリバーブで余韻を残しながら消える', 'The previous track fades into a reverb tail'));
  }
  if (!prev.fx?.length) prev.fx = null;
  cur.autoNote = { text: reasons.join('\n'), style: plan.style, bars: plan.length, inBar: cur.mixInBar };
  return plan.inBar + plan.length;
};

P.lockedLanding = function (i) {
  const s = this.structures.get(this.clips[i].url);
  return s ? this.structureBar(this.clips[i], s, landingBar(this.clips[i])) : null;
};

P.fixLockedEntries = function () {
  for (let i = 0; i + 1 < this.clips.length; i++) {
    if (!this.isLocked(i + 1)) continue;
    const c = this.clips[i];
    const exit = c.mixOutBar;
    const firstBar = Math.ceil(barAtSource(c, 0));
    const latest = exit - 2;
    if (landingBar(c) <= latest) continue;
    if (i === 0) c.mixInBar = Math.max(firstBar, Math.floor(exit - 8));
    else if (this.isLocked(i)) c.transitionBars = Math.max(0, latest - c.mixInBar);
    else {
      const inBar = Math.max(firstBar, Math.floor(latest - c.transitionBars));
      c.mixInBar = inBar;
      if (landingBar(c) > latest) c.transitionBars = Math.max(0, latest - inBar);
    }
  }
};

P.planTempos = function (start, end = null, instant = false) {
  if (!this.clips.length) return;
  const c0 = this.clips[0];
  if (start === 0 && end == null && c0.tempoSync && c0.bpm > 1 && Math.abs(c0.bpm / this.masterBPM - 1) > 0.04) this.masterBPM = Math.round(c0.bpm * 100) / 100;
  let current = this.tempoBefore(Math.max(1, start + 1));
  for (let i = 1; i < this.clips.length; i++) {
    if (!(i > start && i <= (end ?? this.clips.length))) continue;
    const c = this.clips[i];
    if (this.isLocked(i)) { if (c.tempo != null) current = c.tempo; continue; }
    c.tempo = null;
    c.tempoBars = null;
    const native = c.bpm;
    if (!c.tempoSync || native <= 1) continue;
    const dev = Math.abs(native / current - 1);
    if (dev <= (instant ? 0.015 : 0.04)) continue;
    const target = Math.round(native * 100) / 100;
    c.tempo = target;
    if (instant) c.tempoBars = 0;
    if (!instant && !Style.isCutLike(c.transition) && c.transitionBars < 8) c.tempoBars = 8;
    const line = Style.isCutLike(c.transition) || instant
      ? L(`BPM を ${Fmt.bpm(current)} → ${Fmt.bpm(target)} に切り替えと同時に変更（曲を無理に伸縮しない）`, `Mix BPM switches ${Fmt.bpm(current)} → ${Fmt.bpm(target)} with the cut (no heavy stretching)`)
      : L(`BPM をつなぎの間に ${Fmt.bpm(current)} → ${Fmt.bpm(target)} へ徐々に変更`, `Mix BPM moves ${Fmt.bpm(current)} → ${Fmt.bpm(target)} during the blend`);
    if (c.autoNote) c.autoNote = { ...c.autoNote, text: c.autoNote.text + '\n' + line };
    current = target;
  }
};

P.autoMixAll = function () {
  if (this.clips.length < 2) return;
  // Right after opening a mix the analysis is still running: plan once it is done.
  if (this.pending.length && this.clips.some(c => !this.structures.has(c.url) && !this.missingFiles.has(c.url))) {
    this.autoMixWhenReady = true;
    this.changed();
    return;
  }
  this.pushUndo();
  this.alignGridsToAI(this.clips.map((c, i) => (this.isLockMember(i) ? null : c.id)).filter((x): x is string => !!x), false);
  this.editableClips();
  this.harmonizeTempos();
  this.plan(0);
};

P.runPendingAutoMix = function () {
  if (!this.autoMixWhenReady || this.pending.length) return;
  this.autoMixWhenReady = false;
  this.autoMixAll();
};

P.profileFor = function (a, b) {
  const p = Profiles.pair(this.genreFor(a), this.genreFor(b));
  switch (this.trackUse) {
    case 'auto': break;
    case 'full': p.pacing = null; p.dropToDrop = 0; break;
    case 'energetic': p.pacing = p.pacing ?? 150; p.dropToDrop = Math.max(p.dropToDrop, 0.8); break;
  }
  return p;
};

// MARK: Genre

P.genreFor = function (c) {
  if (c.genre) return c.genre;
  const r = this.genreResults.get(c.url);
  return r ? Genres.best(r) : null;
};
P.genreSource = function (c) {
  if (c.genre) return L('手動で指定', 'Set by you');
  const r = this.genreResults.get(c.url);
  if (!r) return null;
  if (r.tag && Genres.tagFamily(r)) return L(`ファイルのジャンルタグ「${r.tag}」`, `File genre tag “${r.tag}”`);
  if (Genres.detected(r)) return L('AI のジャンル判定', 'AI genre detection');
  return null;
};
P.vocalBars = function (c) {
  const s = this.structures.get(c.url), r = this.genreResults.get(c.url);
  if (!s || !r || !r.voice) return null;
  return Array.from({ length: s.barCount }, (_, b) => Genres.vocal(r, S.timeOfBar(s, b), S.timeOfBar(s, b + 1)) ?? 0);
};
P.energyLevel = function (c) {
  const t = this.genreResults.get(c.url)?.traits;
  if (!t || t.length !== 4) return null;
  let e = 0.4 * t[1] + 0.35 * t[2] + 0.25 * t[3];
  const s = this.structures.get(c.url);
  if (s) {
    const bars: number[] = [];
    for (const d of s.sections) if (d.kind === 'drop') for (let b = d.start; b < d.end; b++) bars.push(b);
    if (bars.length) {
      const db = bars.reduce((x, b) => x + Math.max(-20, S.energy(s, b)), 0) / bars.length;
      e = 0.75 * e + 0.25 * Math.min(1, Math.max(0, (db + 20) / 20));
    }
  }
  return e + 0.1 * Math.min(1, Math.max(0, (c.bpm - 100) / 80));
};
P.genreSummary = function () {
  const n = new Map<MixGenre, number>();
  for (const c of this.clips) { const g = this.genreFor(c); if (g) n.set(g, (n.get(g) ?? 0) + 1); }
  return [...n.entries()].map(([genre, count]) => ({ genre, count })).sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre));
};
P.setGenre = function (id, g) { this.updateClip(id, true, c => { c.genre = g; }); };
P.genreLine = function (a, b) {
  if (a && b && a === b) return L(`ジャンル：${Genre.title(b)} → ${Genre.mixSummary(b)}`, `Genre: ${Genre.title(b)} → ${Genre.mixSummary(b)}`);
  if (a && b && Genre.isNeighbor(a, b)) return L(`ジャンル：${Genre.title(a)} → ${Genre.title(b)}（近いジャンルなので両方の流儀の中間でつなぐ）`, `Genre: ${Genre.title(a)} → ${Genre.title(b)} (related, so a mix of both styles)`);
  if (a && b) return L(`ジャンル：${Genre.title(a)} → ${Genre.title(b)}（大きく変わるので短めのつなぎ・カットイン寄り）`, `Genre: ${Genre.title(a)} → ${Genre.title(b)} (a big change: shorter blend or a cut)`);
  if (!a && b) return L(`ジャンル：${Genre.title(b)} → ${Genre.mixSummary(b)}`, `Genre: ${Genre.title(b)} → ${Genre.mixSummary(b)}`);
  return null;
};

// MARK: Quick-cut style

P.looksQuick = function (c) {
  const s = this.structures.get(c.url);
  if (!s) return false;
  const g = this.neuralResults.get(c.url)?.grid;
  return AutoMixer.looksQuick(s, g ? tempoVaries(g) : false);
};
P.resolvedStyle = function (indices) {
  if (this.mixStyle !== 'auto') return this.mixStyle;
  const tracks = indices.map(i => this.clips[i]).filter(c => c && this.structures.has(c.url));
  if (!tracks.length) return 'long';
  const quick = tracks.filter(c => this.isQuickTrack(c)).length;
  if (quick === 0) return 'long';
  if (quick === tracks.length) return 'quick';
  return 'auto';
};
P.isQuickTrack = function (c) {
  const g = this.genreFor(c);
  if (g === 'breakcore') return true;
  if (c.genre) return false;
  if (g && (['house', 'techno', 'trance', 'ukg', 'dnb', 'chill'] as MixGenre[]).includes(g)) {
    const grid = this.neuralResults.get(c.url)?.grid;
    return grid ? tempoVaries(grid) : false;
  }
  return this.looksQuick(c);
};
P.styleSummary = function (indices) {
  const s = this.resolvedStyle(indices);
  return s === 'auto' ? L('カットイン向きの曲はカットイン、それ以外はジャンルに合わせてブレンド', 'cut-ins for fast-changing tracks, genre-style blends for the rest') : MixStyles.title(s);
};

const allIndices = (s: MixStore) => s.clips.map((_, i) => i);

P.plan = function (start) {
  if (this.resolvedStyle(allIndices(this)) === 'quick' || this.clips.length < 2) {
    this.mixPatterns = [];
    this.currentPatternID = null;
    this.planOnly(start);
  } else {
    this.planPatterns(start);
  }
  this.computeReplannable();
  this.finishTimingEdit();
  this.startVerification(start);
};

P.planOnly = function (start) {
  this.editableClips();
  this.replannable.clear();
  switch (this.resolvedStyle(allIndices(this))) {
    case 'quick': this.planTransitionsQuick(start); break;
    case 'auto': this.planTransitionsMixed(start); break;
    case 'long': this.planTransitions(start); break;
  }
  this.editableClips();
  this.fixLockedEntries();
  this.applyLayout();
};

// MARK: Variations of one transition

P.variationList = function (id) {
  const i = this.index(id);
  if (i == null || i <= 0) return null;
  const v = this.variations.get(id);
  return v && this.variationPrev.get(id) === this.clips[i - 1].id ? v : null;
};
P.computeVariations = function (id) {
  const i = this.index(id);
  const sa = i != null && i > 0 ? this.structures.get(this.clips[i - 1].url) : undefined;
  const sb = i != null ? this.structures.get(this.clips[i].url) : undefined;
  const ctx = i != null ? this.planContext(i, null) : null;
  if (i == null || i <= 0 || !sa || !sb || !ctx) { this.variations.set(id, []); this.variationPrev.delete(id); this.changed(); return; }
  const plans = AutoMixer.planVariations(sa, sb, ctx.aMin, this.keyClash(sa, sb), ctx.ratio, ctx.profile, ctx.vocals, ctx.aLanding);
  this.variationPrev.set(id, this.clips[i - 1].id);
  this.variations.set(id, plans.map(plan => ({ id: newID(), plan, problems: null })));
  this.changed();
};
P.applyVariation = function (id, k) {
  const i = this.index(id);
  const v = this.variationList(id);
  if (i == null || i <= 0 || !v || k >= v.length) return;
  this.pushUndo();
  this.editableClips();
  this.preserveTransitionBeforeReplacing(i);
  this.editableClips();
  this.applyPlan(v[k].plan, i);
  this.refitFollowing(i);
  this.planTempos(i - 1, Math.min(this.clips.length - 1, i + 1));
  this.finishTimingEdit();
};
P.previewVariation = function (id, k) { this.applyVariation(id, k); this.previewTransition(id); };
P.isCurrentVariation = function (id, k) {
  const i = this.index(id);
  const v = this.variationList(id);
  if (i == null || i <= 0 || !v || k >= v.length) return false;
  const s = this.structures.get(this.clips[i].url), sa = this.structures.get(this.clips[i - 1].url);
  if (!s || !sa) return false;
  const p = v[k].plan, c = this.clips[i];
  return c.transition === p.style && Math.round(c.transitionBars) === p.length
    && this.structureBar(c, s, c.mixInBar) === p.inBar && this.structureBar(this.clips[i - 1], sa, this.clips[i - 1].mixOutBar) === p.outBar;
};

P.checkOne = async function (i) {
  try { return (await Jobs.check(this.mixMessage(this.clips), i).promise).result; } catch { return null; }
};

P.checkVariations = async function (id) {
  const list = this.variationList(id);
  if (!list?.length) return;
  for (let k = 0; k < list.length; k++) {
    const i = this.index(id);
    const v = this.variationList(id);
    if (i == null || i <= 0 || !v || k >= v.length || v[k].id !== list[k].id) return;
    // Try the variation on a copy of the mix.
    const saved = this.clips;
    this.editableClips();
    this.applyPlan(v[k].plan, i);
    this.refitFollowing(i);
    this.applyLayout();
    const trial = this.clips;
    this.clips = saved;
    let r: { problems: string[] } | null = null;
    try { r = (await Jobs.check(this.mixMessage(trial), i).promise).result; } catch { r = null; }
    const cur = this.variations.get(id);
    if (!cur || k >= cur.length || cur[k].id !== list[k].id) return;
    this.variations.set(id, cur.map((x, j) => (j === k ? { ...x, problems: r?.problems ?? [] } : x)));
    this.changed();
  }
};

// MARK: Whole-mix patterns

const recipes = () => [
  { title: L('おすすめ', 'Recommended'), detail: L('ジャンルと曲の構成から選んだ標準の案', 'The standard plan for these genres and structures'), params: {} },
  { title: L('じっくり長め', 'Long & Smooth'), detail: L('16〜32小節の長いブレンド中心', 'Mostly 16–32-bar blends'),
    params: { len32: 0.8, len16: 0.4, len8: -0.3, len4: -0.7, switchBias: -0.8, echoBias: -0.3, spinBias: -0.6, maxBars: 32 } },
  { title: L('テンポよく短め', 'Short & Snappy'), detail: L('4〜8小節の短いつなぎとエコーアウト', '4–8-bar mixes and echo-outs'),
    params: { len32: -1.2, len16: -0.4, len8: 0.5, len4: 0.6, switchBias: 0.6, echoBias: 0.5 } },
  { title: L('カットイン多め', 'Cut-Heavy'), detail: L('ドロップ頭のカットイン・バックスピン中心', 'Mostly cut-ins on the drop and backspins'),
    params: { len32: -1, len16: -0.5, switchBias: 1.8, echoBias: 0.4, spinBias: 0.6 } },
] as { title: string; detail: string; params: NonNullable<MixTuning['params']>[string] }[];

let baseTuning: MixTuning = {};
export function setBaseTuning(t: MixTuning | null) { baseTuning = t ?? {}; setMixTuning(baseTuning); }

P.planPatterns = function (start) {
  const base = this.snapshot(), baseStructures = new Map(this.structures);
  const made: MixPattern[] = [];
  for (const r of recipes()) {
    this.restoreQuietly(structuredClone(base), new Map(baseStructures));
    const t: MixTuning = structuredClone(baseTuning);
    t.params = t.params ?? {};
    const star = { ...(t.params['*'] ?? {}) } as Record<string, number | undefined>;
    for (const [k, v] of Object.entries(r.params)) {
      if (v == null) continue;
      if (k === 'maxBars') star.maxBars = v; else star[k] = (star[k] ?? 0) + v;
    }
    t.params['*'] = star;
    setMixTuning(t);
    this.planOnly(start);
    setMixTuning(baseTuning);
    const tr = this.clips.slice(1);
    const blends = tr.filter(c => !Style.isCutLike(c.transition) && c.transitionBars >= 1);
    const p: MixPattern = {
      id: newID(), title: r.title, detail: r.detail, state: this.snapshot(), structures: new Map(this.structures),
      blends: blends.length, cuts: tr.length - blends.length,
      averageBars: blends.length ? blends.reduce((x, c) => x + c.transitionBars, 0) / blends.length : 0,
      duration: this.realMixDuration,
    };
    const sig = (s: Snapshot) => JSON.stringify(s.clips.map(c => [c.mixInBar, c.transition]));
    if (!made.some(m => sig(m.state) === sig(p.state))) made.push(p);
  }
  this.mixPatterns = made;
  if (made[0]) {
    this.restoreQuietly(structuredClone(made[0].state), new Map(made[0].structures));
    this.currentPatternID = made[0].id;
  }
};

P.computeReplannable = function () {
  this.replannable.clear();
  if (this.resolvedStyle(allIndices(this)) === 'quick') return;
  for (let i = 1; i < this.clips.length; i++) {
    const c = this.clips[i];
    if (!Style.isCutLike(c.transition) && c.transition !== 'echoOut' && !this.isQuickTrack(c) && !this.isQuickTrack(this.clips[i - 1]) && !this.isLocked(i)) {
      this.replannable.add(c.id);
    }
  }
};

P.restoreQuietly = function (s, st) {
  this.clips = s.clips;
  this.library = s.library;
  this.masterBPM = s.masterBPM;
  this.gridOffset = s.gridOffset;
  this.structures = st;
  this.applyLayout();
};

P.usePattern = function (id) {
  const p = this.mixPatterns.find(x => x.id === id);
  if (!p || id === this.currentPatternID) return;
  this.pushUndo();
  this.restoreQuietly(structuredClone(p.state), new Map(p.structures));
  this.currentPatternID = id;
  this.computeReplannable();
  this.finishTimingEdit();
  this.startVerification(0);
};

// MARK: Render check

let verifyRun = 0;
P.startVerification = function (start) {
  verifyRun++;
  if (!this.verifyTransitions || this.clips.length < 2) { this.verifyProgress = null; this.changed(); return; }
  void this.verifyAndRepair(start);
};

P.verifyAndRepair = async function (start) {
  const run = verifyRun;
  const serial = this.undoSerial;
  const first = Math.max(1, start + 1);
  if (first >= this.clips.length) return;
  const stale = () => run !== verifyRun || this.undoSerial !== serial;
  this.verifyProgress = { done: 0, total: this.clips.length - first };
  this.changed();
  try {
    for (let i = first; i < this.clips.length; i++) {
      if (stale()) return;
      if (this.isLocked(i)) { this.verifyProgress = { done: i - first + 1, total: this.clips.length - first }; this.changed(); continue; }
      const id = this.clips[i].id;
      const tried: { option: number; problems: string[] }[] = [];
      for (let option = 0; option < 4; option++) {
        if (option > 0) {
          if (!this.replannable.has(id)) break;
          this.editableClips();
          if (this.applyAutoTransition(i, null, option) == null) break;
          this.refitFollowing(i);
          this.planTempos(i - 1, Math.min(this.clips.length - 1, i + 1));
          this.finishTimingEdit();
        }
        const r = await this.checkOne(i);
        if (stale()) return;
        if (!r) break;
        tried.push({ option, problems: r.problems });
        if (!r.problems.length || !this.replannable.has(id)) break;
      }
      this.editableClips();
      this.noteCheck(i, tried);
      this.verifyProgress = { done: i - first + 1, total: this.clips.length - first };
      this.changed();
    }
    const k = this.mixPatterns.findIndex(p => p.id === this.currentPatternID);
    if (k >= 0) this.mixPatterns[k] = { ...this.mixPatterns[k], state: this.snapshot(), structures: new Map(this.structures) };
  } finally {
    if (run === verifyRun) { this.verifyProgress = null; this.changed(); }
  }
};

P.refitFollowing = function (i) {
  for (let j = i + 1; j < this.clips.length; j++) {
    const s = this.structures.get(this.clips[j - 1].url);
    if (!s || !this.replannable.has(this.clips[j].id)) break;
    const land = this.structureBar(this.clips[j - 1], s, landingBar(this.clips[j - 1]));
    if (this.structureBar(this.clips[j - 1], s, this.clips[j - 1].mixOutBar) >= land + 8) break;
    this.applyAutoTransition(j, land + 8);
  }
  this.fixLockedEntries();
};

P.noteCheck = function (i, tried) {
  const last = tried[tried.length - 1];
  let note = this.clips[i].autoNote;
  if (!last || !note) return;
  const lines: string[] = [];
  if (tried.length === 1 && !last.problems.length) {
    lines.push(L('書き出して確認：問題なし', 'Rendered and checked: no problems'));
  } else if (!last.problems.length) {
    const first = tried[0].problems.join('、');
    lines.push(L(`書き出して確認：最初の案は「${first}」ため、${last.option + 1}番目の案に変更`, `Rendered and checked: the first plan had problems (${tried[0].problems.join(', ')}), so option ${last.option + 1} is used`));
  } else if (tried.length > 1) {
    const best = tried.reduce((x, y) => (y.problems.length < x.problems.length ? y : x));
    if (best.option !== last.option && this.replannable.has(this.clips[i].id)) {
      this.applyAutoTransition(i, null, best.option);
      this.refitFollowing(i);
      this.finishTimingEdit();
      this.editableClips();
      note = this.clips[i].autoNote ?? note;
    }
    lines.push(L(`書き出して確認：どの案にも気になる点あり（${best.problems.join('、')}）。手で調整すると良くなるかもしれません`,
      `Rendered and checked: every option has an issue (${best.problems.join(', ')}); a manual touch-up may help`));
  } else {
    lines.push(L(`書き出して確認：${last.problems.join('、')}`, `Rendered and checked: ${last.problems.join(', ')}`));
  }
  this.clips[i].autoNote = { ...note, text: note.text + '\n' + lines.join('\n') };
};

// MARK: Mixed / quick-cut planning

const roll = (bar: number) => fx('roll', bar, 0.5, { division: 0.25 });

P.planTransitionsMixed = function (start) {
  if (!this.clips.length) return;
  const windows = new Map<number, Highlight>();
  for (let i = start; i < this.clips.length; i++) {
    const c = this.clips[i];
    if (!this.isQuickTrack(c)) continue;
    if (this.isLockMember(i)) {
      const s = this.structures.get(c.url);
      const h = s ? AutoMixer.highlight(s, AutoMixer.quickWindowBars(s)) : null;
      if (h) windows.set(i, h);
      continue;
    }
    const pick = this.quickHighlight(c);
    if (!pick) continue;
    if (Math.abs(pick.bpm - c.bpm) > 0.005 || Math.abs(pick.firstBeat - c.firstBeat) > 0.001) {
      c.bpm = pick.bpm; c.firstBeat = pick.firstBeat;
      this.structures.set(c.url, pick.structure);
    }
    windows.set(i, pick.highlight);
  }
  const s0 = this.structures.get(this.clips[0].url);
  if (start === 0 && s0) this.clips[0].mixInBar = this.clipBar(this.clips[0], s0, windows.get(0)?.start ?? s0.musicStart);
  let earliest: number | null = start === 0 && s0 ? windows.get(0)?.end ?? s0.musicStart + 8 : null;
  for (let i = start + 1; i < this.clips.length; i++) {
    if (this.isLocked(i)) { const l = this.lockedLanding(i); earliest = l != null ? l + 8 : null; continue; }
    const a = this.clips[i - 1], b = this.clips[i];
    a.fx = (a.fx ?? []).filter(f => f.auto !== true);
    if (!windows.has(i - 1) && !windows.has(i)) {
      const l = this.applyAutoTransition(i, earliest);
      earliest = l != null ? l + 8 : null;
      continue;
    }
    const sa = this.structures.get(a.url), sb = this.structures.get(b.url);
    if (!sa || !sb) { earliest = null; continue; }
    let out: number;
    const ha = windows.get(i - 1);
    if (ha) out = ha.end;
    else {
      const floor = earliest ?? this.structureBar(a, sa, landingBar(a)) + 16;
      const exits = [sa.lastDropEnd, sa.musicEnd, ...S.gridBars(sa, floor, sa.musicEnd, 8)].filter(x => x >= floor);
      out = exits.length ? Math.min(...exits) : sa.musicEnd;
    }
    const inBar = windows.get(i)?.start ?? sb.firstDrop;
    a.mixOutBar = this.clipBar(a, sa, out);
    a.endBar = null;
    b.mixInBar = this.clipBar(b, sb, inBar);
    const t = AutoMixer.quickTransition(sa, out, sb, i);
    Object.assign(b, { transition: t.style, transitionBars: t.bars, shape: null, lanes: null, landingLock: null, spinBeats: null });
    if (t.roll) a.fx = [...(a.fx ?? []), roll(a.mixOutBar - 0.5)];
    if (!a.fx?.length) a.fx = null;
    const lines: string[] = [];
    const g = this.genreLine(this.genreFor(a), this.genreFor(b));
    if (g) lines.push(g);
    const h = windows.get(i);
    if (h) {
      lines.push(L(`展開の速い曲なので ${h.end - h.start} 小節だけ使う`, `A fast-changing track: ${h.end - h.start} bars of it are used`));
      lines.push(...h.reasons);
    } else {
      lines.push(L(`カットイン向きの曲の後なので、次の曲はドロップ頭（${inBar + 1}小節目）から入る`, `After a quick-cut track, the next one comes in on its drop (bar ${inBar + 1})`));
    }
    lines.push(...t.reasons);
    b.autoNote = { text: lines.join('\n'), style: t.style, bars: t.bars, inBar: b.mixInBar };
    earliest = h?.end ?? inBar + 16;
  }
  const last = this.clips.length - 1;
  const sl = this.structures.get(this.clips[last].url);
  if (sl) {
    const h = windows.get(last);
    if (h) { this.clips[last].endBar = this.clipBar(this.clips[last], sl, Math.min(sl.musicEnd, h.end + 8)); this.clips[last].fadeOutBeats = 16; }
    else this.clips[last].endBar = this.clipBar(this.clips[last], sl, sl.musicEnd);
  }
  this.planTempos(start);
  this.finishTimingEdit();
  this.editableClips();
};

P.quickHighlight = function (c) {
  const base = this.structures.get(c.url);
  if (!base) return null;
  let best: { highlight: Highlight; bpm: number; firstBeat: number; structure: TrackStructure } | null = null;
  const h0 = AutoMixer.highlight(base, AutoMixer.quickWindowBars(base));
  if (h0) best = { highlight: h0, bpm: c.bpm, firstBeat: c.firstBeat, structure: base };
  const n = this.neuralResults.get(c.url), energies = this.bandEnergies.get(c.url);
  if (!n || !energies) return best;
  for (const r of tempoRegions(n.beats, n.downbeats)) {
    let bpm = r.grid.bpm;
    for (const f of [2, 0.5]) if (Math.abs(c.bpm / (r.grid.bpm * f) - 1) < 0.06) bpm = r.grid.bpm * f;
    const fb = Mathx.posMod(this.attackAligned(c.url, bpm, r.grid.firstBeat, r.start, r.end), 240 / bpm);
    const st = structureTrusted(energies, bpm, fb);
    if (!st) continue;
    const a = Math.ceil(S.barAtTime(st, r.start) - 0.05), b = Math.floor(S.barAtTime(st, r.end) + 0.05);
    if (b - a < 8) continue;
    const h = AutoMixer.highlight(st, AutoMixer.quickWindowBars(st), [a, b]);
    if (!h) continue;
    if (!best || h.score > best.highlight.score + 0.2) best = { highlight: h, bpm, firstBeat: fb, structure: st };
  }
  return best;
};

P.planTransitionsQuick = function (start) {
  if (!this.clips.length) return;
  const windows = new Map<number, Highlight>();
  for (let i = start; i < this.clips.length; i++) {
    const c = this.clips[i];
    if (this.isLockMember(i)) {
      const s = this.structures.get(c.url);
      const h = s ? AutoMixer.highlight(s, AutoMixer.quickWindowBars(s)) : null;
      if (h) windows.set(i, h);
      continue;
    }
    const pick = this.quickHighlight(c);
    if (!pick) continue;
    if (Math.abs(pick.bpm - c.bpm) > 0.005 || Math.abs(pick.firstBeat - c.firstBeat) > 0.001) {
      c.bpm = pick.bpm; c.firstBeat = pick.firstBeat;
      this.structures.set(c.url, pick.structure);
    }
    windows.set(i, pick.highlight);
  }
  for (let i = start; i < this.clips.length; i++) {
    const c = this.clips[i];
    const st = this.structures.get(c.url), h = windows.get(i);
    if (!st || !h) continue;
    const outLocked = this.isLocked(i + 1);
    if (!outLocked) c.fx = (c.fx ?? []).filter(f => f.auto !== true);
    if ((i > start || start === 0) && !this.isLocked(i)) c.mixInBar = this.clipBar(c, st, h.start);
    if (i + 1 < this.clips.length) {
      if (!outLocked) { c.mixOutBar = this.clipBar(c, st, h.end); c.endBar = null; }
    } else {
      c.endBar = this.clipBar(c, st, Math.min(st.musicEnd, h.end + 8));
      c.fadeOutBeats = 16;
    }
    if (i <= 0 || this.isLocked(i)) continue;
    const p = this.clips[i - 1];
    const pst = this.structures.get(p.url);
    if (!pst) continue;
    const ph = windows.get(i - 1) ?? (i - 1 < start ? { start: 0, end: this.structureBar(p, pst, p.mixOutBar), score: 0, reasons: [] } : null);
    if (!ph) continue;
    const t = AutoMixer.quickTransition(pst, ph.end, st, i);
    Object.assign(c, { transition: t.style, transitionBars: t.bars, shape: null, lanes: null, landingLock: null, spinBeats: null });
    if (t.roll) p.fx = [...(p.fx ?? []), roll(p.mixOutBar - 0.5)];
    if (!p.fx?.length) p.fx = null;
    const lead = L(`カットイン主体のミックス（Dariacore・マッシュアップ向け）：この曲は ${h.end - h.start} 小節だけ使う`, `Quick-cut mix (Dariacore / mashups): ${h.end - h.start} bars of this track`);
    c.autoNote = { text: [lead, ...h.reasons, ...t.reasons].join('\n'), style: t.style, bars: t.bars, inBar: c.mixInBar };
  }
  this.planTempos(start, null, true);
  this.finishTimingEdit();
  this.editableClips();
};

// MARK: Tempo readings

P.readings = function (c) {
  const out = [{ bpm: c.bpm, firstBeat: c.firstBeat, penalty: 0 }];
  for (const t of this.tempoReadings.get(c.url) ?? []) {
    if (Math.abs(t.bpm - c.bpm) > 0.5) out.push({ bpm: t.bpm, firstBeat: t.firstBeat, penalty: 0.03 + 0.1 * Math.max(0, 1 - t.fit) });
  }
  const g = this.genreFor(c);
  const range = g ? Genre.tempoRange(g) : null;
  if (range && out.some(o => o.bpm >= range[0] && o.bpm <= range[1])) {
    for (const o of out) if (!(o.bpm >= range[0] && o.bpm <= range[1])) o.penalty += 0.5;
  }
  return out;
};

P.harmonizeTempos = function () {
  if (!this.clips.length) return;
  const opts = this.clips.map((c, i) => { const r = this.readings(c); return this.isLockMember(i) ? r.slice(0, 1) : r; });
  const masters = new Set<number>(opts.flatMap(o => o.map(x => x.bpm)));
  masters.add(this.masterBPM);
  const cost = (o: { bpm: number; penalty: number }, m: number) => Math.abs(Math.log(o.bpm / m)) + o.penalty;
  let best: { m: number; cost: number; pick: number[] } | null = null;
  for (const m of [this.masterBPM, ...[...masters].sort((x, y) => x - y)]) {
    if (!(m > 1)) continue;
    let total = 0;
    const pick: number[] = [];
    for (const o of opts) {
      let k = 0;
      for (let j = 1; j < o.length; j++) if (cost(o[j], m) < cost(o[k], m)) k = j;
      total += cost(o[k], m);
      pick.push(k);
    }
    if (!best || total < best.cost - 1e-6) best = { m, cost: total, pick };
  }
  if (!best) return;
  best.pick.forEach((k, i) => {
    if (k <= 0) return;
    const o = opts[i][k];
    const c = this.clips[i];
    c.bpm = o.bpm;
    const fbA = this.attackAligned(c.url, o.bpm, o.firstBeat);
    const e = this.bandEnergies.get(c.url);
    const st = e ? structureFor(e, o.bpm, fbA) : null;
    if (st) { this.structures.set(c.url, st); c.firstBeat = st.firstBeat; } else c.firstBeat = fbA;
    resetToWholeTrack(c);
  });
  this.masterBPM = Math.round(best.m * 100) / 100;
};

// MARK: Auto-arrange

P.orderItem = function (c) {
  const s = this.structures.get(c.url);
  return {
    bpm: c.bpm, bpmOptions: this.readings(c).map(r => r.bpm), key: s?.key ?? null,
    introBars: s ? Math.max(0, s.firstDrop - s.musicStart) : 0,
    outroBars: s ? Math.max(0, s.musicEnd - s.lastDropEnd) : 0,
    genre: this.genreFor(c), energy: this.energyLevel(c),
  };
};

P.suggestedOrder = function (ids) {
  const units = this.lockUnits(ids.filter(id => this.clip(id)));
  const items = units.map(u => {
    const item = this.orderItem(this.clip(u[0])!);
    const last = this.clip(u[u.length - 1]);
    if (u.length > 1 && last) {
      item.outroBars = this.orderItem(last).outroBars;
      const es = u.map(id => this.clip(id)).filter((c): c is Clip => !!c).map(c => this.energyLevel(c)).filter((e): e is number => e != null);
      if (es.length) item.energy = es.reduce((x, y) => x + y, 0) / es.length;
    }
    return item;
  });
  return AutoMixer.bestOrder(items, this.setArc).flatMap(k => units[k]);
};

P.autoArrange = function (ids, reorder, replace) {
  if (!ids.length) return;
  this.pushUndo();
  const members = new Set(this.clips.filter((_, i) => this.isLockMember(i)).map(c => c.id));
  this.alignGridsToAI(ids.filter(id => !members.has(id)), false);
  const chosen = reorder ? this.suggestedOrder(ids) : ids;
  const picked: Clip[] = [];
  for (const id of chosen) {
    const i = this.index(id);
    if (i != null) picked.push({ ...this.clips[i] });
    else { const k = this.libraryIndex(id); if (k != null) picked.push({ ...this.library[k] }); }
  }
  const chosenSet = new Set(chosen);
  const keptInMix = this.clips.filter(c => !chosenSet.has(c.id));
  this.library = this.library.filter(c => !chosenSet.has(c.id));
  for (const c of picked) {
    if (members.has(c.id)) continue;
    resetToWholeTrack(c);
    c.autoNote = null;
  }
  let startIndex: number;
  if (replace) {
    this.library = [...keptInMix.map(c => ({ ...c, lockedPrevID: null })), ...this.library];
    this.clips = picked;
    startIndex = 0;
  } else {
    this.clips = [...keptInMix, ...picked];
    startIndex = Math.max(0, keptInMix.length - 1);
  }
  this.editableClips();
  this.harmonizeTempos();
  this.plan(startIndex);
  this.selectedClipID = null;
  this.librarySelection = new Set();
  this.fitRequest++;
  this.changed();
};

P.planTransitions = function (start) {
  if (!this.clips.length) return;
  const s0 = this.structures.get(this.clips[0].url);
  if (start === 0 && s0) this.clips[0].mixInBar = this.clipBar(this.clips[0], s0, s0.musicStart);
  let earliest: number | null = start === 0 && s0 ? s0.musicStart + 8 : null;
  for (let i = start + 1; i < this.clips.length; i++) {
    const landing = this.applyAutoTransition(i, earliest);
    earliest = landing != null ? landing + 8 : null;
  }
  const last = this.clips.length - 1;
  const sl = this.structures.get(this.clips[last].url);
  if (sl) this.clips[last].endBar = this.clipBar(this.clips[last], sl, sl.musicEnd);
  this.planTempos(start);
  this.finishTimingEdit();
  this.editableClips();
};

P.autoMixTransition = function (id) {
  const i = this.index(id);
  if (i == null || i <= 0) return;
  this.pushUndo();
  this.editableClips();
  this.preserveTransitionBeforeReplacing(i);
  this.editableClips();
  let landing = this.applyAutoTransition(i, null, 0, true);
  let j = i + 1;
  while (j < this.clips.length && landing != null) {
    const s = this.structures.get(this.clips[j - 1].url);
    if (!s || this.structureBar(this.clips[j - 1], s, this.clips[j - 1].mixOutBar) >= landing + 8) break;
    landing = this.applyAutoTransition(j, landing + 8);
    j++;
  }
  this.fixLockedEntries();
  this.planTempos(i - 1, j - 1);
  this.finishTimingEdit();
};

P.autoNoteText = function (c) {
  const n = c.autoNote;
  if (!n || n.style !== c.transition || Math.abs((n.bars ?? -1) - c.transitionBars) >= 0.01 || Math.abs((n.inBar ?? -1e9) - c.mixInBar) >= 0.01) return null;
  return localize(n.text);
};

// MARK: AI grid / cues

P.attackAligned = function (url, bpm, fb, t0 = 0, t1 = null) {
  const key = `${url}|${Math.round(bpm * 1000)}|${Math.round(fb * 10000)}|${Math.trunc(t0)}|${Math.trunc(t1 ?? -1)}`;
  const hit = this.attackCache.get(key);
  if (hit != null) return hit;
  const e = this.bandEnergies.get(url);
  const v = fb + ((e ? onsetOffset(e, bpm, fb, t0, t1) : null) ?? 0);
  this.attackCache.set(key, v);
  return v;
};

P.alignGridsToAI = function (ids, undoable = true) {
  const targets = ids.map(id => this.clip(id)).filter((c): c is Clip => !!c && this.gridDiffersFromAI(c));
  if (!targets.length) return;
  if (undoable) this.pushUndo();
  for (const c of targets) {
    const a = this.aiGrid(c);
    if (!a) continue;
    this.updateClip(c.id, false, x => { x.bpm = a.bpm; x.firstBeat = a.firstBeat; });
    const e = this.bandEnergies.get(c.url);
    const st = e ? structureTrusted(e, a.bpm, a.firstBeat) : null;
    if (st) this.structures.set(c.url, st);
  }
  this.finishTimingEdit();
};
P.alignAllGridsToAI = function () { this.alignGridsToAI([...this.clips, ...this.library].map(c => c.id)); };
P.aiGridMismatches = function () { return [...this.clips, ...this.library].filter(c => this.gridDiffersFromAI(c)).length; };

P.aiCues = function (c) {
  const n = this.neuralResults.get(c.url);
  if (!n || c.bpm <= 1) return [];
  const lo = barAtSource(c, 0) - 0.01, hi = barAtSource(c, c.duration);
  return n.cues.map(h => {
    const b = barAtSource(c, h.time);
    return { bar: Math.abs(b - Math.round(b)) < 0.15 ? Math.round(b) : Math.round(b * 4) / 4, score: h.score };
  }).filter(x => x.bar >= lo && x.bar <= hi);
};

// MARK: Takes

P.preserveTransitionBeforeReplacing = function (i) {
  if (i <= 0 || i >= this.clips.length) return;
  const c = this.clips[i];
  if (c.transition !== 'custom' && c.transitionDone !== true && !(c.takes ?? []).length) return;
  this.saveTake(c.id, null, false);
};
P.previewTake = function (id, takeID) {
  if (this.currentTakeID(id) !== takeID) this.useTake(id, takeID);
  this.previewTransition(id);
};
P.newTakeFromAuto = function (id) {
  if (this.index(id) == null) return;
  this.saveTake(id, null, true);
  this.autoMixTransition(id);
};

// MARK: Settings

P.setMixStyle = function (s) { this.mixStyle = s; this.saveSettings(); this.changed(); };
P.setSetArc = function (a) { this.setArc = a; this.saveSettings(); this.changed(); };
P.setTrackUse = function (u) { this.trackUse = u; this.saveSettings(); this.changed(); };
P.setVerifyTransitions = function (on) { this.verifyTransitions = on; this.saveSettings(); this.changed(); };

export type { TransitionStyle };

// The explanations an auto-mix leaves in the mix (Clip.autoNote, variation labels) are made in every language, so
// they read right after the language is changed (core/i18n.ts captureLanguages / localize).
for (const name of ['applyAutoTransition', 'computeVariations', 'planTempos', 'noteCheck', 'planTransitionsMixed', 'planTransitionsQuick'] as const) {
  const f = P[name] as (...a: unknown[]) => unknown;
  (P as unknown as Record<string, unknown>)[name] = function (this: MixStore, ...a: unknown[]) { return captureLanguages(() => f.apply(this, a)); };
}
