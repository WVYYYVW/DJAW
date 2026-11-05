// Port of mac/DJAW/Audio/LoudnessAnalyzer.swift: ITU-R BS.1770-4 / EBU R128 loudness (LUFS).
// The K-weighted power of every 100 ms is measured once per file, so the loudness of any stretch is instant.
import { AudioSource } from '../render/source';

export const LOUDNESS_STEP = 0.1;

class KWeighting {
  private shelf: number[];
  private hp: number[];
  private z: number[][];
  constructor(fs: number, channels: number) {
    {
      const g = 3.99984385397, q = 0.7071752369554193, fc = 1681.9744509555319;
      const a = Math.pow(10, g / 40), w0 = 2 * Math.PI * fc / fs, alpha = Math.sin(w0) / (2 * q), cw = Math.cos(w0), sa = 2 * Math.sqrt(a) * alpha;
      const a0 = (a + 1) - (a - 1) * cw + sa;
      this.shelf = [a * ((a + 1) + (a - 1) * cw + sa) / a0, -2 * a * ((a - 1) + (a + 1) * cw) / a0,
        a * ((a + 1) + (a - 1) * cw - sa) / a0, 2 * ((a - 1) - (a + 1) * cw) / a0, ((a + 1) - (a - 1) * cw - sa) / a0];
    }
    {
      const q = 0.5003270373253953, fc = 38.13547087613982;
      const w0 = 2 * Math.PI * fc / fs, alpha = Math.sin(w0) / (2 * q), cw = Math.cos(w0);
      const a0 = 1 + alpha;
      this.hp = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - alpha) / a0];
    }
    this.z = Array.from({ length: channels }, () => [0, 0, 0, 0]);
  }
  /** Filters samples of one channel and returns the sum of squares of the result. */
  process(c: number, x: Float32Array, from: number, count: number) {
    let [s1, s2, h1, h2] = this.z[c];
    const [pb0, pb1, pb2, pa1, pa2] = this.shelf, [qb0, qb1, qb2, qa1, qa2] = this.hp;
    let sum = 0;
    for (let i = from; i < from + count; i++) {
      const v = x[i];
      const y1 = pb0 * v + s1;
      s1 = pb1 * v - pa1 * y1 + s2;
      s2 = pb2 * v - pa2 * y1;
      const y2 = qb0 * y1 + h1;
      h1 = qb1 * y1 - qa1 * y2 + h2;
      h2 = qb2 * y1 - qa2 * y2;
      sum += y2 * y2;
    }
    this.z[c] = [s1, s2, h1, h2];
    return sum;
  }
}

/** K-weighted mean-square power (summed over the channels) of every 100 ms of the file. */
export function loudnessSegments(src: AudioSource): Float32Array {
  const sr = src.sampleRate, chs = Math.min(2, src.channels);
  const k = new KWeighting(sr, chs);
  const segFrames = Math.round(sr * LOUDNESS_STEP);
  const out: number[] = [];
  let acc = 0, inSeg = 0;
  const block = 1 << 16;
  const L = new Float32Array(block), R = new Float32Array(block);
  for (let pos = 0; pos < src.frames; pos += block) {
    const n = Math.min(block, src.frames - pos);
    src.read(pos, n, L, R);
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, segFrames - inSeg);
      acc += k.process(0, L, i, take);
      if (chs > 1) acc += k.process(1, R, i, take);
      inSeg += take;
      i += take;
      if (inSeg === segFrames) { out.push(acc / segFrames); acc = 0; inSeg = 0; }
    }
  }
  if (inSeg > segFrames / 2) out.push(acc / inSeg);
  return Float32Array.from(out);
}

/** Integrated loudness (LUFS) between two source times (null = too short or silent). */
export function integratedLoudness(seg: Float32Array, a = 0, b: number | null = null): number | null {
  const i0 = Math.max(0, Math.round(a / LOUDNESS_STEP));
  const i1 = Math.min(seg.length, Math.round((b ?? seg.length * LOUDNESS_STEP) / LOUDNESS_STEP));
  if (i1 - i0 < 4) return null;
  const blocks: number[] = [];
  for (let j = i0; j <= i1 - 4; j++) blocks.push((seg[j] + seg[j + 1] + seg[j + 2] + seg[j + 3]) / 4);
  const lufs = (z: number) => -0.691 + 10 * Math.log10(Math.max(z, 1e-12));
  const abs = blocks.filter(z => lufs(z) > -70);
  if (!abs.length) return null;
  const rel = lufs(abs.reduce((s, x) => s + x, 0) / abs.length) - 10;
  const gated = abs.filter(z => lufs(z) > rel);
  if (!gated.length) return null;
  return lufs(gated.reduce((s, x) => s + x, 0) / gated.length);
}
