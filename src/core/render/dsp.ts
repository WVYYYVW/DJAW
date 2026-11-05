// The per-track units the Mac version took from AVFoundation, rebuilt: DJ 3-band EQ (AVAudioUnitEQ),
// echo (AVAudioUnitDelay) and reverb (AVAudioUnitReverb, "large hall 2").

// MARK: - EQ

/** RBJ cookbook biquad, transposed direct form II, stereo. */
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private z1 = [0, 0];
  private z2 = [0, 0];

  lowShelf(fs: number, f0: number, dB: number, S = 1) { this.shelf(fs, f0, dB, S, false); }
  highShelf(fs: number, f0: number, dB: number, S = 1) { this.shelf(fs, f0, dB, S, true); }

  private shelf(fs: number, f0: number, dB: number, S: number, high: boolean) {
    const A = Math.pow(10, dB / 40);
    const w = 2 * Math.PI * f0 / fs;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const sA = 2 * Math.sqrt(A) * alpha;
    let b0, b1, b2, a0, a1, a2;
    if (!high) {
      b0 = A * ((A + 1) - (A - 1) * cw + sA);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sA);
      a0 = (A + 1) + (A - 1) * cw + sA;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - sA;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cw + sA);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - sA);
      a0 = (A + 1) - (A - 1) * cw + sA;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - sA;
    }
    this.set(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }

  /** Peaking EQ with a bandwidth in octaves. */
  peaking(fs: number, f0: number, dB: number, octaves: number) {
    const A = Math.pow(10, dB / 40);
    const w = 2 * Math.PI * f0 / fs;
    const sw = Math.sin(w), cw = Math.cos(w);
    const alpha = sw * Math.sinh(Math.LN2 / 2 * octaves * w / sw);
    const a0 = 1 + alpha / A;
    this.set((1 + alpha * A) / a0, -2 * cw / a0, (1 - alpha * A) / a0, -2 * cw / a0, (1 - alpha / A) / a0);
  }

  private set(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
  }

  process(x: Float32Array, ch: number, from: number, to: number) {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1[ch], z2 = this.z2[ch];
    for (let i = from; i < to; i++) {
      const v = x[i];
      const y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      x[i] = y;
    }
    // Flush denormals.
    this.z1[ch] = Math.abs(z1) < 1e-25 ? 0 : z1;
    this.z2[ch] = Math.abs(z2) < 1e-25 ? 0 : z2;
  }
}

/**
 * DJ EQ (DJEQ.configure): low shelf 180 Hz, peaking 1 kHz (2 octaves), high shelf 4.5 kHz. Gains in dB (kill −40).
 * Gains glide to their targets (about 10 ms) and the filters are re-tuned every 32 samples, so moves never click.
 */
export class DJEQ {
  private low = new Biquad();
  private mid = new Biquad();
  private high = new Biquad();
  private g = [0, 0, 0];
  private tuned = [NaN, NaN, NaN];
  constructor(private readonly fs: number) {}

  reset(low: number, mid: number, high: number) {
    this.g = [low, mid, high];
  }

  process(L: Float32Array, R: Float32Array, n: number, low: number, mid: number, high: number) {
    const target = [low, mid, high];
    const k = 1 - Math.exp(-32 / (0.01 * this.fs));
    for (let a = 0; a < n; a += 32) {
      const b = Math.min(n, a + 32);
      for (let j = 0; j < 3; j++) {
        this.g[j] += (target[j] - this.g[j]) * k;
        if (Math.abs(this.g[j] - target[j]) < 0.01) this.g[j] = target[j];
      }
      this.tune();
      for (const bq of [this.low, this.mid, this.high]) {
        bq.process(L, 0, a, b);
        bq.process(R, 1, a, b);
      }
    }
  }

  get isFlat() { return this.g.every(v => Math.abs(v) < 0.001); }

  private tune() {
    const [l, m, h] = this.g;
    if (l !== this.tuned[0]) { this.low.lowShelf(this.fs, 180, l); this.tuned[0] = l; }
    if (m !== this.tuned[1]) { this.mid.peaking(this.fs, 1000, m, 2); this.tuned[1] = m; }
    if (h !== this.tuned[2]) { this.high.highShelf(this.fs, 4500, h); this.tuned[2] = h; }
  }
}

// MARK: - Echo

/**
 * AVAudioUnitDelay-like: a delay line with feedback through a low-pass (7 kHz), wet/dry mix in percent
 * (0 = dry only, 100 = only the echoes). The delay line is always written, so turning the echo up repeats what
 * just played (as the echo-out transition expects).
 */
export class Echo {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private w = 0;
  private lpL = 0;
  private lpR = 0;
  private delay = 0;
  private targetDelay = 0;
  wetDry = 0;
  feedback = 55;
  private sWet = 0;
  private lpA: number;

  constructor(private readonly fs: number) {
    const size = Math.ceil(fs * 2.1) + 8;
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.lpA = 1 - Math.exp(-2 * Math.PI * 7000 / fs);
  }

  setDelay(seconds: number) {
    this.targetDelay = Math.min(2, Math.max(0.001, seconds)) * this.fs;
    if (this.delay === 0) this.delay = this.targetDelay;
  }

  /** In place. `send` scales what goes into the unit (dry and delay line alike, as the Mac's send mixer). */
  process(L: Float32Array, R: Float32Array, n: number, send: number) {
    const size = this.bufL.length;
    const fb = this.feedback / 100;
    const wetTarget = this.wetDry / 100;
    const kw = 1 - Math.exp(-1 / (0.005 * this.fs));
    const quiet = wetTarget === 0 && this.sWet < 1e-4;
    for (let i = 0; i < n; i++) {
      this.delay += (this.targetDelay - this.delay) * 0.0005;
      this.sWet += (wetTarget - this.sWet) * kw;
      const xl = L[i] * send, xr = R[i] * send;
      let rp = this.w - this.delay;
      if (rp < 0) rp += size;
      const i0 = Math.floor(rp), fr = rp - i0, i1 = i0 + 1 >= size ? 0 : i0 + 1;
      const dl = this.bufL[i0] + (this.bufL[i1] - this.bufL[i0]) * fr;
      const dr = this.bufR[i0] + (this.bufR[i1] - this.bufR[i0]) * fr;
      this.lpL += (dl - this.lpL) * this.lpA;
      this.lpR += (dr - this.lpR) * this.lpA;
      this.bufL[this.w] = xl + fb * this.lpL;
      this.bufR[this.w] = xr + fb * this.lpR;
      this.w = this.w + 1 >= size ? 0 : this.w + 1;
      if (quiet) { L[i] = xl; R[i] = xr; continue; }
      const wet = this.sWet;
      L[i] = xl * (1 - wet) + this.lpL * wet;
      R[i] = xr * (1 - wet) + this.lpR * wet;
    }
  }
}

// MARK: - Reverb

/** Freeverb (Jezar) tuned towards a large hall: long, fairly bright tail. wetDry in percent. */
export class Reverb {
  private combs: { buf: Float32Array; i: number; store: number }[][] = [[], []];
  private aps: { buf: Float32Array; i: number }[][] = [[], []];
  private pre: Float32Array[];
  private preI = 0;
  wetDry = 0;
  private sWet = 0;
  private readonly feedback = 0.89;
  private readonly damp = 0.25;

  constructor(private readonly fs: number) {
    const scale = fs / 44100;
    const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const apT = [556, 441, 341, 225];
    for (let ch = 0; ch < 2; ch++) {
      const spread = ch === 0 ? 0 : 23;
      this.combs[ch] = combT.map(t => ({ buf: new Float32Array(Math.round((t + spread) * scale * 1.35)), i: 0, store: 0 }));
      this.aps[ch] = apT.map(t => ({ buf: new Float32Array(Math.round((t + spread) * scale)), i: 0 }));
    }
    this.pre = [new Float32Array(Math.round(0.025 * fs)), new Float32Array(Math.round(0.025 * fs))];
  }

  process(L: Float32Array, R: Float32Array, n: number) {
    const target = this.wetDry / 100;
    const kw = 1 - Math.exp(-1 / (0.01 * this.fs));
    if (target === 0 && this.sWet < 1e-4) {
      // Keep the tail state decaying silently is unnecessary: nothing is heard. Still feed the pre-delay.
      this.sWet = 0;
      return;
    }
    const preLen = this.pre[0].length;
    for (let i = 0; i < n; i++) {
      this.sWet += (target - this.sWet) * kw;
      const inL = L[i], inR = R[i];
      const pi = this.preI;
      const xl = this.pre[0][pi], xr = this.pre[1][pi];
      this.pre[0][pi] = inL; this.pre[1][pi] = inR;
      this.preI = pi + 1 >= preLen ? 0 : pi + 1;
      const input = [(xl + xr) * 0.015, (xl + xr) * 0.015];
      const out = [0, 0];
      for (let ch = 0; ch < 2; ch++) {
        let acc = 0;
        for (const c of this.combs[ch]) {
          const y = c.buf[c.i];
          c.store = y * (1 - this.damp) + c.store * this.damp;
          c.buf[c.i] = input[ch] + c.store * this.feedback;
          c.i = c.i + 1 >= c.buf.length ? 0 : c.i + 1;
          acc += y;
        }
        for (const a of this.aps[ch]) {
          const b = a.buf[a.i];
          const y = -acc + b;
          a.buf[a.i] = acc + b * 0.5;
          a.i = a.i + 1 >= a.buf.length ? 0 : a.i + 1;
          acc = y;
        }
        out[ch] = acc;
      }
      const w = this.sWet;
      L[i] = inL * (1 - w) + out[0] * w * 3;
      R[i] = inR * (1 - w) + out[1] * w * 3;
    }
  }
}
