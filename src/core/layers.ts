// Layered tracks: a track played completely on top of a track of the mix (a mash-up, an acapella over an
// instrumental, a second record riding the first). The mix itself stays one line of tracks joined by transitions
// (decks A / B); a layer rides on one of them, placed by bars — "from that track's bar N" — and moves with it.
// Layers play on decks C and D, so with the two mix decks at most four tracks sound at once.
import { Clip, clipEnd, lastBar, rate, sourceTimeAtBar, timelineTimeOfBar } from './models';

/** Deck numbers: 0 = A, 1 = B (the mix, alternating), 2 = C, 3 = D (layers). */
export type DeckIndex = 0 | 1 | 2 | 3;
export const deckName = (d: number) => 'ABCD'[d] ?? '?';

/**
 * The layers placed on their mix tracks: timeline start, and the part of the file they play (from their `mixInBar`
 * to their `mixOutBar`). Layers whose track is no longer in the mix are left out.
 */
export function placeLayers(layers: readonly Clip[], clips: readonly Clip[], master: number): Clip[] {
  const out: Clip[] = [];
  for (const l of layers) {
    const host = clips.find(c => c.id === l.layerOf);
    if (!host) continue;
    const c: Clip = { ...l, edits: null, playLength: null, transition: 'cut', transitionBars: 0, lanes: null, tempo: null };
    const inBar = Math.max(0, l.mixInBar);
    const outBar = Math.max(inBar + 0.25, l.mixOutBar > inBar ? l.mixOutBar : lastBar(l));
    c.trimStart = Math.max(0, sourceTimeAtBar(l, inBar));
    c.trimEnd = Math.min(l.duration, Math.max(c.trimStart + 0.05, sourceTimeAtBar(l, outBar)));
    c.start = timelineTimeOfBar(host, l.layerBar ?? host.mixInBar, master);
    out.push(c);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Deck C or D for each placed layer (null when both are busy: more than two layers at once). */
export function layerDecks(placed: readonly Clip[], master: number): Map<string, 2 | 3 | null> {
  const free: Record<2 | 3, number> = { 2: -Infinity, 3: -Infinity };
  const out = new Map<string, 2 | 3 | null>();
  for (const c of [...placed].sort((a, b) => a.start - b.start)) {
    const end = clipEnd(c, master);
    const d = free[2] <= c.start + 1e-6 ? 2 : free[3] <= c.start + 1e-6 ? 3 : null;
    if (d) free[d] = end;
    out.set(c.id, d);
  }
  return out;
}

/** Bars of the mix track a layer covers (its own bars, played at the mix tempo). */
export function layerLengthBars(l: Clip) {
  return Math.max(0, (l.mixOutBar > l.mixInBar ? l.mixOutBar : lastBar(l)) - l.mixInBar);
}

/** End of the mix including the layers. */
export function endWithLayers(end: number, placed: readonly Clip[], master: number) {
  return placed.reduce((m, c) => Math.max(m, clipEnd(c, master)), end);
}

/** Speed of a layer relative to its own tempo at the mix's base tempo (for display). */
export const layerRate = (c: Clip, master: number) => rate(c, master);
