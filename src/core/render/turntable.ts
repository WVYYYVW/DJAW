// Brake / backspin (TurntableFX in mac/DJAW/Audio/DJFX.swift): renders the turntable stop or backspin that
// replaces the end of the outgoing track.
import { TransitionStyle } from '../models';
import { AudioSource } from './source';

const cache = new Map<string, [Float32Array, Float32Array]>();

/** `p0`: source seconds where the effect starts. `length`: source seconds it lasts. */
export function turntableBuffer(key: string, src: AudioSource, kind: TransitionStyle, p0: number, length: number) {
  const k = `${key}|${kind}|${Math.trunc(p0 * 1000)}|${Math.trunc(length * 1000)}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const b = render(src, kind, p0, length);
  if (b) {
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    cache.set(k, b);
  }
  return b;
}

function render(src: AudioSource, kind: TransitionStyle, p0: number, D: number): [Float32Array, Float32Array] | null {
  if (!(D > 0.01)) return null;
  const sr = src.sampleRate;
  const R = 3.2;
  const backDist = kind === 'backspin' ? R * D / 2.4 + 0.15 : 0;
  const fwdDist = kind === 'backspin' ? 0.2 : D * 0.5 + 0.1;
  const w0 = Math.max(0, Math.round((p0 - backDist) * sr));
  const w1 = Math.min(src.frames, Math.round((p0 + fwdDist) * sr));
  if (!(w1 - w0 > 8)) return null;
  const n = w1 - w0;
  const sl = new Float32Array(n), srr = new Float32Array(n);
  src.read(w0, n, sl, srr);
  const outFrames = Math.floor(D * sr);
  const out: [Float32Array, Float32Array] = [new Float32Array(outFrames), new Float32Array(outFrames)];
  const start = Math.round(p0 * sr) - w0;
  const ramp = Math.min(0.07, 0.15 * D);
  for (let ch = 0; ch < 2; ch++) {
    const s = ch === 0 ? sl : srr, o = out[ch];
    let pos = start;
    let lp = 0;
    const at = (k: number) => s[Math.min(Math.max(k, 0), n - 1)];
    for (let i = 0; i < outFrames; i++) {
      const tau = i / sr;
      const u = tau / D;
      let r: number, g: number;
      if (kind === 'backspin') {
        if (tau < ramp) r = 1 - (1 + R) * tau / ramp;
        else {
          const v = (tau - ramp) / Math.max(D - ramp, 0.001);
          r = -R * Math.pow(Math.max(0, 1 - v), 1.8);
        }
        g = u > 0.6 ? Math.pow((1 - u) / 0.4, 1.5) : 1;
      } else {
        r = Math.pow(Math.max(0, 1 - u), 1.6);
        g = u > 0.9 ? (1 - u) / 0.1 : 1;
      }
      // Cubic (Hermite) read.
      const ip = Math.floor(pos);
      const f = pos - ip;
      const xm1 = at(ip - 1), x0 = at(ip), x1 = at(ip + 1), x2 = at(ip + 2);
      const c1 = 0.5 * (x1 - xm1);
      const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      const y = ((c3 * f + c2) * f + c1) * f + x0;
      // Fast spinning aliases: soften it in proportion to the speed.
      const a = Math.min(1, 1.2 / Math.max(Math.abs(r), 1));
      lp += (y - lp) * a;
      o[i] = lp * g;
      pos += r;
    }
  }
  return out;
}
