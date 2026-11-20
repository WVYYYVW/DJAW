// The editing grid shared by the transition editor and the FX lanes (store.editGrid, in beats; 0 = free).
import React from 'react';
import { L } from '../../core/i18n';
import { store } from '../store/store';
import { useStore } from '../hooks';

export const editGrids: { beats: number; label: () => string; title: () => string }[] = [
  { beats: 1, label: () => L('1拍', '1 beat'), title: () => L('1拍（1/4小節）', '1 beat (1/4 bar)') },
  { beats: 1 / 2, label: () => L('1/2拍', '½ beat'), title: () => L('1/2拍（1/8小節）', '½ beat (1/8 bar)') },
  { beats: 1 / 4, label: () => L('1/4拍', '¼ beat'), title: () => L('1/4拍（1/16小節）', '¼ beat (1/16 bar)') },
  { beats: 1 / 8, label: () => L('1/8拍', '⅛ beat'), title: () => L('1/8拍（1/32小節）', '⅛ beat (1/32 bar)') },
  { beats: 0, label: () => L('なし', 'Off'), title: () => L('グリッドなし（自由に置く）', 'No grid (free)') },
];

/** Rounds a position in beats to the grid (free with `free`, e.g. while Alt is held, or when the grid is off). */
export function snapBeats(beats: number, free = false): number {
  const g = store.editGrid;
  if (free || !g) return beats;
  return Math.round(beats / g) * g;
}

/** The step of the ‹ › buttons and arrow keys, in beats. */
export const gridStep = () => store.editGrid || 1 / 8;

/** Fraction of a beat as text (½, ¼, ¾, ⅛ …). */
export function beatFraction(f: number): string {
  const n = Math.round(f * 8);
  return ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'][((n % 8) + 8) % 8];
}

export function GridSelect() {
  const s = useStore();
  return (
    <label className="grid-select" title={L('点や FX を合わせる細かさ（Alt を押しながらだと自由に置けます）', 'What points and effects snap to (hold Alt to place freely)')}>
      <span className="dim">{L('グリッド', 'Grid')}</span>
      <select className="tselect small" value={s.editGrid} onChange={e => { s.editGrid = Number(e.target.value); s.saveSettings(); s.changed(); }}>
        {editGrids.map(g => <option key={g.beats} value={g.beats}>{g.title()}</option>)}
      </select>
    </label>
  );
}
