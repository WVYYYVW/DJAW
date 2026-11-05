// Streaming stereo resampler for exports at another rate (44.1 → 48 kHz): the same windowed-sinc (Kaiser β = 8,
// 32 zero crossings) as analysis/neural.ts `resample`, polyphase for rational ratios, fed block by block.

export class StreamResampler {
  private readonly L: number;
  private readonly M: number;
  private readonly phases: { a: number; w: Float32Array }[];
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);
  /** Absolute input index of bufL[0]. */
  private start = 0;
  private filled = 0;
  private outIndex = 0;
  private readonly reach: number;

  constructor(readonly from: number, readonly to: number) {
    const gcd = (u: number, v: number): number => (v ? gcd(v, u % v) : u);
    const g = gcd(from, to);
    this.L = to / g;
    this.M = from / g;
    const ratio = to / from;
    const cutoff = Math.min(1, ratio) * 0.95;
    const half = 32;
    const width = half / Math.min(1, ratio);
    const I0 = (v: number) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (v / (2 * k)) ** 2; s += t; } return s; };
    const i0b = I0(8);
    this.reach = Math.ceil(width) + 2;
    this.phases = Array.from({ length: this.L }, (_, k) => {
      const c = (k * this.M % this.L) / this.L;
      const a = Math.ceil(c - width), b = Math.floor(c + width);
      const w = new Float32Array(b - a + 1);
      let sum = 0;
      for (let j = a; j <= b; j++) {
        const d = j - c, r = Math.abs(d) / width;
        if (r >= 1) continue;
        const arg = Math.PI * d * cutoff;
        const v = (arg === 0 ? 1 : Math.sin(arg) / arg) * I0(8 * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
        w[j - a] = v;
        sum += v;
      }
      if (sum > 0) for (let j = 0; j < w.length; j++) w[j] /= sum;
      return { a, w };
    });
  }

  private append(l: Float32Array, r: Float32Array, n: number) {
    if (this.filled + n > this.bufL.length) {
      const cap = Math.max(1 << 16, (this.filled + n) * 2);
      const nl = new Float32Array(cap), nr = new Float32Array(cap);
      nl.set(this.bufL.subarray(0, this.filled)); nr.set(this.bufR.subarray(0, this.filled));
      this.bufL = nl; this.bufR = nr;
    }
    this.bufL.set(l.subarray(0, n), this.filled);
    this.bufR.set(r.subarray(0, n), this.filled);
    this.filled += n;
  }

  /** Feeds n input frames; calls `out` with the output frames that are complete. */
  push(l: Float32Array, r: Float32Array, n: number, out: (L: Float32Array, R: Float32Array, n: number) => void, final = false) {
    this.append(l, r, n);
    const available = this.start + this.filled;   // absolute input frames known
    const oL: number[] = [], oR: number[] = [];
    for (;;) {
      const base = Math.floor(this.outIndex * this.M / this.L);
      const ph = this.phases[this.outIndex % this.L];
      const last = base + ph.a + ph.w.length - 1;
      if (!final && last >= available) break;
      if (final && base >= available) break;
      let sl = 0, sr = 0;
      for (let k = 0; k < ph.w.length; k++) {
        const j = base + ph.a + k - this.start;
        if (j < 0 || j >= this.filled) continue;
        sl += this.bufL[j] * ph.w[k];
        sr += this.bufR[j] * ph.w[k];
      }
      oL.push(sl); oR.push(sr);
      this.outIndex++;
    }
    if (oL.length) out(Float32Array.from(oL), Float32Array.from(oR), oL.length);
    // Drop input no output needs any more.
    const keepFrom = Math.floor(this.outIndex * this.M / this.L) - this.reach;
    const drop = Math.max(0, Math.min(this.filled, keepFrom - this.start));
    if (drop > 4096) {
      this.bufL.copyWithin(0, drop, this.filled);
      this.bufR.copyWithin(0, drop, this.filled);
      this.filled -= drop;
      this.start += drop;
    }
  }

  /** Output frames for the whole input so far (call at the end). */
  finish(out: (L: Float32Array, R: Float32Array, n: number) => void) {
    const empty = new Float32Array(0);
    // Stop at the output frame matching the last input frame.
    const totalOut = Math.floor((this.start + this.filled) * this.L / this.M);
    const wrapped = (L: Float32Array, R: Float32Array, n: number) => out(L, R, n);
    this.push(empty, empty, 0, (L, R, n) => {
      const keep = Math.max(0, Math.min(n, totalOut - (this.outIndex - n)));
      if (keep > 0) wrapped(L.subarray(0, keep), R.subarray(0, keep), keep);
    }, true);
  }
}
