// Chain layout (mac/DJAW/Store/MixStore.swift: layout(), updateCutNudges(), separateNeighbourColors(),
// suggestedMixOut()). Pure functions: they return new arrays and leave the input alone.
import {
  Clip, ClipPalette, Mathx, Style, Waveform, barAtSource, elapsedOfSource, hasEdits, lastBar, lastSoundTime, rate,
  rawSegments, sourceAtElapsed, sourceTimeAtBar, barSource, elapsedOfSourcePass,
} from './models';

export interface LayoutResult { clips: Clip[]; gridOffset: number }

/**
 * Derives timeline placement from the musical mix points: each track's mix-in point plays exactly at the previous
 * track's mix-out point, so every transition starts and ends on a bar line.
 */
export function layout(input: Clip[], master: number, gridOffset: number): LayoutResult {
  if (input.length === 0) return { clips: input, gridOffset };
  const m = master;
  const c = input.map(x => ({ ...x }));
  let anchor = 0;
  let firstAnchor = 0;
  for (let i = 0; i < c.length; i++) {
    const r = rate(c[i], m);
    const minIn = barAtSource(c[i], 0) - 64;
    const maxIn = lastBar(c[i]) - 1;
    c[i].mixInBar = Math.min(Math.max(c[i].mixInBar, minIn), maxIn);
    const sourceIn = sourceTimeAtBar(c[i], c[i].mixInBar) + (i > 0 ? (c[i].inNudge ?? 0) : 0);
    const trimStart = Math.min(Math.max(0, sourceIn), Math.max(0, c[i].duration - 0.5));
    c[i].trimStart = trimStart;
    c[i].start = Math.max(0, anchor + (trimStart - sourceIn) / r);
    if (i === 0) firstAnchor = c[i].start + (sourceIn - trimStart) / r;

    let sourceEnd: number;
    if (i + 1 < c.length) {
      c[i].mixOutBar = Math.min(Math.max(c[i].mixOutBar, c[i].mixInBar + 1), Math.max(c[i].mixInBar + 1, lastBar(c[i]) - 0.25));
      c[i + 1].transitionBars = Math.max(0, c[i + 1].transitionBars);
      sourceEnd = sourceTimeAtBar(c[i], c[i].mixOutBar + c[i + 1].transitionBars) + (c[i].outNudge ?? 0);
      // Cut: keep a few milliseconds of overlap so the switch is click-free.
      if (c[i + 1].transitionBars < 0.01) sourceEnd += 0.005 * r;
    } else if (c[i].endBar != null) {
      sourceEnd = sourceTimeAtBar(c[i], Math.max(c[i].endBar!, c[i].mixInBar + 1));
    } else {
      sourceEnd = c[i].duration;
    }
    c[i].trimEnd = Math.min(c[i].duration, Math.max(trimStart + 0.5, sourceEnd));

    if (hasEdits(c[i])) {
      // Loops / jumps: measure in played time, so a loop before the mix-out pushes the next track back.
      const raw = rawSegments(c[i]);
      const total = raw.reduce((a, s) => a + (s.to - s.from), 0);
      let play: number;
      if (i + 1 < c.length) {
        const eOut = elapsedOfSourcePass(sourceTimeAtBar(c[i], c[i].mixOutBar) + (c[i].outNudge ?? 0), raw, trimStart, c[i].outPass);
        play = eOut + c[i + 1].transitionBars * barSource(c[i]);
        if (c[i + 1].transitionBars < 0.01) play += 0.005 * r;
        anchor = c[i].start + eOut / r;
      } else if (c[i].endBar != null) {
        play = elapsedOfSource(sourceTimeAtBar(c[i], Math.max(c[i].endBar!, c[i].mixInBar + 1)), raw, trimStart);
      } else {
        play = total;
      }
      play = Math.min(total, Math.max(0.5, play));
      c[i].playLength = play;
      c[i].trimEnd = Math.min(c[i].duration, sourceAtElapsed(play, raw, trimStart));
    } else {
      c[i].playLength = null;
      if (i + 1 < c.length) {
        const sourceOut = sourceTimeAtBar(c[i], c[i].mixOutBar) + (c[i].outNudge ?? 0);
        anchor = c[i].start + (sourceOut - trimStart) / r;
      }
    }
  }
  return { clips: c, gridOffset: Mathx.posMod(firstAnchor, 240 / master) };
}

/** Looks up where the attacks are around a source time (BandEnergies.onsetOffset). */
export type OnsetFinder = (c: Clip, from: number, to: number) => number | null;

/**
 * Puts every cut-in exactly on the attacks: the outgoing track stops right before its next kick / snare and the
 * incoming one starts right before its own, so the two never flam or leave a gap.
 */
export function updateCutNudges(clips: Clip[], onset: OnsetFinder): Clip[] {
  if (clips.length <= 1) return clips;
  const c = clips.map(x => ({ ...x }));
  const local = (k: Clip, line: number, before: boolean) => {
    if (!(k.bpm > 1)) return null;
    const beat = 60 / k.bpm;
    return before ? onset(k, line - 6 * beat, line + 0.03) : onset(k, line - 0.03, line + 6 * beat);
  };
  for (let i = 0; i < c.length; i++) {
    const into = i > 0 ? c[i].transition : 'crossfade';
    const abrupt = i > 0 && (Style.isCutLike(into) || into === 'echoOut' || c[i].transitionBars < 0.01);
    const nx = c[i + 1];
    const nextAbrupt = !!nx && (Style.isCutLike(nx.transition) || nx.transition === 'echoOut' || nx.transitionBars < 0.01);
    const inN = abrupt ? local(c[i], sourceTimeAtBar(c[i], c[i].mixInBar), false) : null;
    const outN = nextAbrupt ? local(c[i], sourceTimeAtBar(c[i], c[i].mixOutBar), true) : null;
    c[i].inNudge = inN != null && Math.abs(inN) > 0.0005 ? inN : null;
    c[i].outNudge = outN != null && Math.abs(outN) > 0.0005 ? outN : null;
  }
  return c;
}

/** Tracks next to each other never share a colour (or two very similar ones). */
export function separateNeighbourColors(clips: Clip[]): Clip[] {
  if (clips.length <= 1) return clips;
  const c = clips.map(x => ({ ...x }));
  const n = ClipPalette.hues.length;
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1].colorIndex;
    const next = i + 1 < c.length ? c[i + 1].colorIndex : null;
    const cur = c[i].colorIndex;
    if (ClipPalette.distance(cur, prev) >= ClipPalette.minNeighbourDistance) continue;
    let best = cur, bestScore = -Infinity;
    for (let k = 0; k < n; k++) {
      let score = ClipPalette.distance(k, prev);
      if (next != null) score = Math.min(score, ClipPalette.distance(k, next));
      if (i >= 2) score += 0.3 * Math.min(0.15, ClipPalette.distance(k, c[i - 2].colorIndex));
      if (score > bestScore) { bestScore = score; best = k; }
    }
    c[i].colorIndex = best;
  }
  return c;
}

/** Phrase-aligned (8-bar) exit point so a transition of `bars` finishes before the music ends. */
export function suggestedMixOut(clip: Clip, bars: number, waveform?: Waveform | null): number {
  const musicEnd = (waveform ? lastSoundTime(waveform) : null) ?? clip.duration;
  const lb = barAtSource(clip, Math.min(musicEnd, clip.duration));
  let candidate = Math.floor((lb - bars - clip.mixInBar) / 8) * 8 + clip.mixInBar;
  if (candidate < clip.mixInBar + 8) candidate = Math.floor(lb - bars);
  return Math.max(clip.mixInBar + 1, candidate);
}
