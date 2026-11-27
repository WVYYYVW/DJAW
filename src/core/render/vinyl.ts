// "Vinyl" speed change (key lock off): the track is simply played faster or slower, so its pitch follows the speed —
// a turntable or a CDJ with Master Tempo off. Done by resampling (windowed sinc), not by the time-stretch: nothing is
// re-built from the spectrum, so the sound stays exactly as it was (no smearing, no grown peaks).
//
// Reads the track at any position (ClipStream is random access), so there is no latency: output frame j is the input
// at position x0 + Σ rate, the same accounting as the time-stretch path (sample-exact timing).

const HALF = 16;           // zero crossings on each side
const PHASES = 512;        // kernel table resolution between two input frames

const tables = new Map<number, Float32Array>();

/** Kernel table for a cutoff (fraction of the input Nyquist): PHASES + 1 rows of `2·reach` taps, normalised. */
function table(cutoff: number) {
  const key = Math.round(cutoff * 1000);
  let t = tables.get(key);
  if (t) return { t, reach: reachFor(key / 1000) };
  const c = key / 1000, reach = reachFor(c), taps = 2 * reach;
  t = new Float32Array((PHASES + 1) * taps);
  const I0 = (v: number) => { let s = 1, u = 1; for (let k = 1; k < 30; k++) { u *= (v / (2 * k)) ** 2; s += u; } return s; };
  const i0b = I0(8), width = HALF / c;
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      // Tap k is input frame floor(x) - reach + 1 + k; its distance from x is (k - reach + 1) - frac.
      const d = k - reach + 1 - frac, r = Math.abs(d) / width;
      if (r >= 1) continue;
      const a = Math.PI * d * c;
      const v = (a === 0 ? 1 : Math.sin(a) / a) * I0(8 * Math.sqrt(1 - r * r)) / i0b;
      t[p * taps + k] = v;
      sum += v;
    }
    if (sum > 0) for (let k = 0; k < taps; k++) t[p * taps + k] /= sum;
  }
  tables.set(key, t);
  return { t, reach };
}
const reachFor = (c: number) => Math.ceil(HALF / c) + 1;

export class Vinyl {
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);

  /**
   * n output frames at `rate` input frames per output frame, starting at input position x (fractional), into L / R.
   * `read(i0, count, L, R)` fills input frames [i0, i0 + count). Returns the input position after the block.
   */
  render(x: number, rate: number, n: number, L: Float32Array, R: Float32Array,
    read: (i0: number, count: number, L: Float32Array, R: Float32Array) => void): number {
    // Slowing down needs no filter beyond the input's own band; speeding up must cut what would fold back.
    const cutoff = Math.min(0.97, 0.97 / Math.max(1, rate));
    const { t, reach } = table(Math.round(cutoff * 100) / 100);
    const taps = 2 * reach;
    const first = Math.floor(x) - reach + 1;
    const last = Math.floor(x + rate * (n - 1)) + reach;
    const count = last - first + 1;
    if (this.bufL.length < count) { this.bufL = new Float32Array(count * 2); this.bufR = new Float32Array(count * 2); }
    const bL = this.bufL, bR = this.bufR;
    read(first, count, bL, bR);
    for (let j = 0; j < n; j++) {
      const p = x + rate * j, i = Math.floor(p), f = (p - i) * PHASES, ph = Math.floor(f), w = f - ph;
      const o0 = ph * taps, o1 = o0 + taps, base = i - reach + 1 - first;
      let l = 0, r = 0;
      for (let k = 0; k < taps; k++) {
        const c = t[o0 + k] + (t[o1 + k] - t[o0 + k]) * w;
        l += bL[base + k] * c;
        r += bR[base + k] * c;
      }
      L[j] = l; R[j] = r;
    }
    return x + rate * n;
  }
}
