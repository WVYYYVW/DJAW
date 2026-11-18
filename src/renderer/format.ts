// Number / time formatting (mac/DJAW/Views/Theme.swift: Fmt) and the theme colours.
import { L } from '../core/i18n';
import { ClipPalette, barLabel } from '../core/models';

const pad = (n: number, w: number) => String(n).padStart(w, '0');

export const Fmt = {
  /** 1:05.2 */
  time(t: number) {
    const s = Math.max(0, t);
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
  },
  /** 1:05.23 */
  clock(t: number) {
    const s = Math.max(0, t);
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
  },
  /** 5:32 */
  duration(t: number) {
    const s = Math.round(Math.max(0, t));
    if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60), 2)}:${pad(s % 60, 2)}`;
    return `${Math.floor(s / 60)}:${pad(s % 60, 2)}`;
  },
  bpm(b: number) {
    if (!(b > 0)) return '—';
    return Math.abs(b - Math.round(b)) < 0.005 ? b.toFixed(0) : b.toFixed(2);
  },
  db(d: number) { return Math.abs(d) < 0.05 ? '0 dB' : `${d > 0 ? '+' : ''}${d.toFixed(1)} dB`; },
  bars(bars: number) {
    if (Math.abs(bars - Math.round(bars)) < 0.05) {
      const n = Math.round(bars);
      return L(`${n}小節`, n === 1 ? '1 bar' : `${n} bars`);
    }
    return L(`${bars.toFixed(1)}小節`, `${bars.toFixed(1)} bars`);
  },
  barOrdinal(bar: number) { return L(`${barLabel(bar)}小節目`, `bar ${barLabel(bar)}`); },
  beats(beats: number) {
    if (beats < 0.01) return L('なし', 'off');
    if (Math.abs(beats / 4 - Math.round(beats / 4)) < 0.01) return Fmt.bars(beats / 4);
    if (Math.abs(beats - Math.round(beats)) < 0.01) {
      const n = Math.round(beats);
      return L(`${n}拍`, n === 1 ? '1 beat' : `${n} beats`);
    }
    return L(`${beats.toFixed(1)}拍`, `${beats.toFixed(1)} beats`);
  },
  ratePercent(rate: number) {
    const p = (rate - 1) * 100;
    if (Math.abs(p) < 0.05) return '±0%';
    return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
  },
};

export const Theme = {
  timelineBG: 'rgb(20,21,24)',
  laneBG: 'rgb(28,29,33)',
  rulerBG: 'rgb(33,34,39)',
  chipBG: 'rgb(43,45,51)',
  headerBG: 'rgb(30,31,35)',
  headerRow: 'rgb(40,42,47)',
  deckA: 'rgb(255,159,10)',
  deckB: 'rgb(64,200,224)',
  playhead: 'rgb(255,92,82)',
  accent: '#3d8bfd',
};

/** HSB → CSS rgb(a). */
export function hsb(h: number, s: number, b: number, a = 1) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = b * (1 - s), q = b * (1 - f * s), t = b * (1 - (1 - f) * s);
  const [r, g, bl] = [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][((i % 6) + 6) % 6];
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(bl * 255)},${a})`;
}

/** Track colour (NSColor.clip). */
export const clipColor = (index: number, a = 1) => hsb(ClipPalette.hue(index), 0.62, 0.96, a);
