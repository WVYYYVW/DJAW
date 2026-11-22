// Layered tracks (core/layers.ts): a track played on top of a mix track, on deck C or D. Placed by bars of the mix
// track it rides on; it moves with that track. Every change goes through here.
import { L } from '../../core/i18n';
import { Clip, LayerParts, barAtSource, lastBar, uuid } from '../../core/models';
import { layerDecks, placeLayers } from '../../core/layers';
import { MixStore } from './store';

declare module './store' {
  interface MixStore {
    /**
     * Puts a track (from the library or the mix) on top of the mix track `hostID`, its first bar on the host's bar
     * `hostBar` (default: where the host has taken over). Returns the new layer's id, or null when decks C and D are
     * both busy there.
     */
    addLayer(hostID: string, trackID: string, hostBar?: number | null): string | null;
    /** Moves a layer to another bar of its mix track (or onto another mix track). */
    moveLayer(id: string, hostBar: number, hostID?: string, undoable?: boolean): boolean;
    /** The part of the layered track that plays (its own bars). */
    setLayerRange(id: string, inBar: number, outBar: number, undoable?: boolean): boolean;
    setLayerParts(id: string, parts: LayerParts): void;
    removeLayer(id: string): void;
    /** Layers riding on a mix track. */
    layersOn(hostID: string): Clip[];
    /** The mix track and its bar under timeline time t (for dropping a layer there). */
    hostAt(t: number): { id: string; bar: number } | null;
  }
}

const P = MixStore.prototype;

/** Would these layers still fit on decks C and D? */
function fits(store: MixStore, layers: Clip[]) {
  const placed = placeLayers(layers, store.clips, store.masterBPM);
  return [...layerDecks(placed, store.masterBPM).values()].every(d => d != null);
}

const tooMany = () => L('この位置ではデッキ C・D がどちらも使われています（重ねられるのは同時に2曲まで）', 'Decks C and D are both busy there (at most two layered tracks at once)');

P.layersOn = function (hostID) { return this.layers.filter(l => l.layerOf === hostID); };

P.hostAt = function (t) {
  // The track that has taken over at t (the later one in an overlap).
  for (let i = this.clips.length - 1; i >= 0; i--) {
    const c = this.clips[i];
    const bar = this.sourceBar(c.id, t);
    if (bar != null) return { id: c.id, bar };
  }
  return null;
};

P.addLayer = function (hostID, trackID, hostBar = null) {
  const host = this.clips.find(c => c.id === hostID);
  const src = this.clip(trackID);
  if (!host || !src) return null;
  const st = this.structures.get(src.url);
  // From the layered track's first drop (or its first bar) for up to 32 bars, but not past the mix track's mix-out.
  const inBar = st ? Math.max(0, Math.round(barAtSource(src, st.firstDrop * st.barSeconds + st.firstBeat))) : 0;
  const at = hostBar ?? Math.round(host.mixInBar + host.transitionBars);
  const room = Math.max(4, host.mixOutBar - at);
  const outBar = Math.min(Math.floor(lastBar(src)), inBar + Math.min(32, room));
  const layer: Clip = {
    ...structuredClone(src), id: uuid(), layerOf: hostID, layerBar: at, layerParts: 'all',
    mixInBar: inBar, mixOutBar: Math.max(inBar + 1, outBar), fadeInBeats: 4, fadeOutBeats: 4,
    transition: 'cut', transitionBars: 0, lanes: null, shape: null, tempo: null, tempoBars: null, tempoStart: null,
    edits: null, playLength: null, takes: null, lockedPrevID: null, autoNote: null, fx: null, colorIndex: this.colorCounter++,
  };
  const next = [...this.layers, layer];
  if (!fits(this, next)) { this.alertMessage = tooMany(); this.changed(); return null; }
  this.pushUndo();
  this.layers = next;
  this.selectedClipID = layer.id;
  this.changed();
  return layer.id;
};

P.moveLayer = function (id, hostBar, hostID, undoable = true) {
  const k = this.layers.findIndex(l => l.id === id);
  if (k < 0) return false;
  const l = { ...this.layers[k], layerBar: hostBar, layerOf: hostID ?? this.layers[k].layerOf };
  const next = this.layers.map((x, j) => (j === k ? l : x));
  if (!fits(this, next)) return false;
  if (undoable) this.pushUndo(); else this.markDirty();
  this.layers = next;
  this.changed();
  return true;
};

P.setLayerRange = function (id, inBar, outBar, undoable = true) {
  const k = this.layers.findIndex(l => l.id === id);
  if (k < 0) return false;
  const cur = this.layers[k];
  const a = Math.max(0, inBar), b = Math.min(Math.max(a + 0.25, outBar), lastBar(cur));
  if (!(b > a)) return false;
  const l = { ...cur, mixInBar: a, mixOutBar: b };
  const next = this.layers.map((x, j) => (j === k ? l : x));
  if (!fits(this, next)) return false;
  if (undoable) this.pushUndo(); else this.markDirty();
  this.layers = next;
  this.changed();
  return true;
};

P.setLayerParts = function (id, parts) {
  const l = this.layers.find(x => x.id === id);
  if (!l) return;
  this.updateClip(id, true, c => { c.layerParts = parts; });
  if (parts !== 'all' && !this.stemsFor(l.url)) this.prepareStems([l.url]);
};

P.removeLayer = function (id) {
  if (!this.layers.some(l => l.id === id)) return;
  this.pushUndo();
  this.layers = this.layers.filter(l => l.id !== id);
  if (this.selectedClipID === id) this.selectedClipID = null;
  this.changed();
};

