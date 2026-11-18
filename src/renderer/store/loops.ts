// The loop editor (components/LoopEditor.tsx): loops and beat jumps of one track, placed and changed afterwards
// on its waveform. Every change goes through here so loops never leave the track or overlap each other.
import { L } from '../../core/i18n';
import { ClipEdit, barAtSource, lastBar, timelineTimeOfBar, uuid } from '../../core/models';
import { MixStore } from './store';

/** Shortest loop / jump: a quarter beat. */
export const MIN_EDIT_BARS = 1 / 16;

declare module './store' {
  interface MixStore {
    /** Track whose loops are being edited (the loop editor is open while set). */
    loopEditorTarget: string | null;
    /** The loop / jump selected in the editor. */
    loopEditorEdit: string | null;
    openLoopEditor(id: string, editID?: string | null): void;
    closeLoopEditor(): void;
    /** Why a loop / jump cannot go there (null when it can). */
    editProblem(id: string, edit: ClipEdit): string | null;
    /** Adds a loop or jump; returns its id (null when it does not fit). */
    createEdit(id: string, kind: ClipEdit['kind'], bar: number, bars: number, repeats?: number): string | null;
    /** Changes a loop / jump. `undoable` false while dragging (the drag pushes one undo step at its start). */
    changeEdit(id: string, editID: string, patch: Partial<Pick<ClipEdit, 'bar' | 'bars' | 'repeats'>>, undoable?: boolean): boolean;
    /** Plays the mix from a little before this bar of the track. */
    previewBar(id: string, bar: number, leadBars?: number): void;
  }
}

const P = MixStore.prototype;
Object.assign(P, { loopEditorTarget: null, loopEditorEdit: null });

P.openLoopEditor = function (id, editID = null) {
  if (!this.clip(id)) return;
  this.loopEditorTarget = id;
  this.loopEditorEdit = editID;
  this.selectedClipID = id;
  this.openPanel('loop');
};

P.closeLoopEditor = function () {
  this.loopEditorTarget = null;
  this.loopEditorEdit = null;
  this.changed();
};

P.editProblem = function (id, edit) {
  const c = this.clip(id);
  if (!c) return L('曲が見つかりません', 'Track not found');
  if (!(edit.bars >= MIN_EDIT_BARS - 1e-9)) return L('短すぎます', 'Too short');
  if (edit.bar < barAtSource(c, 0) - 0.001 || edit.bar + edit.bars > lastBar(c) + 0.001) return L('曲の範囲外です', 'Outside the track');
  const other = (c.edits ?? []).find(e => e.id !== edit.id && e.bar < edit.bar + edit.bars - 0.001 && edit.bar < e.bar + e.bars - 0.001);
  if (other) return other.kind === 'loop' ? L('ほかのループと重なっています', 'Overlaps another loop') : L('ジャンプと重なっています', 'Overlaps a jump');
  return null;
};

P.createEdit = function (id, kind, bar, bars, repeats = 1) {
  const edit: ClipEdit = { id: uuid(), kind, bar, bars, repeats: kind === 'loop' ? Math.min(32, Math.max(1, Math.round(repeats))) : 1 };
  const problem = this.editProblem(id, edit);
  if (problem) { this.alertMessage = L(`ここには置けません：${problem}`, `Cannot go here: ${problem}`); this.changed(); return null; }
  this.updateClip(id, true, c => { c.edits = [...(c.edits ?? []), edit].sort((a, b) => a.bar - b.bar); });
  this.finishTimingEdit();
  return edit.id;
};

P.changeEdit = function (id, editID, patch, undoable = true) {
  const c = this.clip(id);
  const e = c?.edits?.find(x => x.id === editID);
  if (!c || !e) return false;
  const next: ClipEdit = { ...e, ...patch };
  if (next.kind === 'loop') next.repeats = Math.min(32, Math.max(1, Math.round(next.repeats)));
  if (next.bar === e.bar && next.bars === e.bars && next.repeats === e.repeats) return true;
  if (this.editProblem(id, next)) return false;
  this.updateClip(id, undoable, x => { x.edits = (x.edits ?? []).map(y => (y.id === editID ? next : y)).sort((a, b) => a.bar - b.bar); });
  this.finishTimingEdit();
  return true;
};

P.previewBar = function (id, bar, leadBars = 1) {
  const c = this.clips.find(x => x.id === id);
  if (!c) return;
  const t = timelineTimeOfBar(c, bar - leadBars, this.masterBPM);
  this.seek(Math.max(c.start, Math.min(t, this.mixDuration - 0.1)));
  this.requestScroll(this.playhead);
  if (!this.isPlaying) void this.play();
};
