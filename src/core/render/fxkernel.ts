// Port of FXKernel (mac/DJAW/Audio/DJFX.swift): loop roll, colour filter, phaser, flanger, bit crusher and
// trans gate, sample-accurate. Float32 arithmetic as in Swift (Math.fround where it matters is not needed for the sound).
import { FXState, isQuietFX, quietFX } from '../tempo';

export class FXKernel {
  target: FXState = quietFX();
  /** Tempo the beat clock runs at (beats per minute, as heard). */
  bpm = 120;
  beatTarget = 0;
  resync = 0;
  beat = 0;
  private seenResync = -1;

  private sFilter = 0; private sPhaser = 0; private sFlanger = 0; private sCrush = 0;
  private sGateDepth = 0; private gateGain = 1; private rollMix = 0;
  private ic1 = [0, 0]; private ic2 = [0, 0];
  private apz = new Float32Array(8); private phFB = [0, 0];
  private held = [0, 0];
  private readonly flSize = 4096;
  private flRing: Float32Array;
  private flWrite = 0;
  private rollSize: number;
  private rollRing: Float32Array;
  private rolling = false;
  private rollLen = 1;
  private rollPos = 0;
  private holdCounter = 0;
  private idle = true;

  // Per-block scratch.
  private sFilt: Float32Array; private sGate: Float32Array; private sFlDelay: Float32Array; private sPhC: Float32Array;
  private sHold: Float32Array; private sRoll: Int32Array; private sRec: Float32Array; private sRollMix: Float32Array;
  private sRollDry: Float32Array; private sCrushMix: Float32Array; private sCrushStep: Float32Array;

  constructor(private readonly sr: number, private readonly maxFrames = 4096) {
    this.flRing = new Float32Array(this.flSize * 2);
    this.rollSize = Math.floor(sr * 4);
    this.rollRing = new Float32Array(this.rollSize * 2);
    const n = maxFrames;
    this.sFilt = new Float32Array(n * 5); this.sGate = new Float32Array(n); this.sFlDelay = new Float32Array(n);
    this.sPhC = new Float32Array(n); this.sHold = new Float32Array(n); this.sRoll = new Int32Array(n).fill(-1);
    this.sRec = new Float32Array(n); this.sRollMix = new Float32Array(n); this.sRollDry = new Float32Array(n);
    this.sCrushMix = new Float32Array(n); this.sCrushStep = new Float32Array(n);
  }

  /** In place on L / R. */
  process(L: Float32Array, R: Float32Array, n: number) {
    if (n <= 0 || n > this.maxFrames) return;
    if (this.resync !== this.seenResync) {
      this.seenResync = this.resync;
      this.beat = this.beatTarget;
    }
    const t = this.target;
    const sr = this.sr;
    const dBeat = Math.max(this.bpm, 1) / 60 / sr;
    const settled = Math.abs(this.sFilter) < 0.0005 && this.sPhaser < 0.0005 && this.sFlanger < 0.0005 && this.sCrush < 0.0005
      && this.sGateDepth < 0.0005 && this.rollMix < 0.0005 && !this.rolling;
    if (isQuietFX(t) && settled) {
      if (!this.idle) { this.ic1 = [0, 0]; this.ic2 = [0, 0]; this.phFB = [0, 0]; this.apz.fill(0); }
      this.idle = true;
      this.sFilter = 0; this.sPhaser = 0; this.sFlanger = 0; this.sCrush = 0; this.sGateDepth = 0; this.gateGain = 1; this.rollMix = 0;
      this.beat += dBeat * n;
      return;
    }
    this.idle = false;

    const kSmooth = 1 - Math.exp(-1 / (0.012 * sr));
    const kGate = 1 - Math.exp(-1 / (0.0015 * sr));
    const kRoll = 1 - Math.exp(-1 / (0.003 * sr));
    const nyq = sr * 0.45;
    const gateDiv = Math.max(t.gateDiv, 0.03125);
    const flDiv = Math.max(t.flangerDiv, 0.5);
    const phDiv = Math.max(t.phaserDiv, 0.5);
    const { sFilt, sGate, sFlDelay, sPhC, sHold, sRoll, sRec, sRollMix, sRollDry, sCrushMix, sCrushStep } = this;

    let a1 = 1, a2 = 0, a3 = 0, kq = 1.4, mode = 0, phC = 0;
    for (let i = 0; i < n; i++) {
      this.sFilter += (t.filter - this.sFilter) * kSmooth;
      this.sPhaser += (t.phaser - this.sPhaser) * kSmooth;
      this.sFlanger += (t.flanger - this.sFlanger) * kSmooth;
      this.sCrush += (t.crush - this.sCrush) * kSmooth;
      this.sGateDepth += (t.gate - this.sGateDepth) * kSmooth;
      this.beat += dBeat;

      // Colour filter: coefficients every 16 samples.
      if ((i & 15) === 0) {
        const f = this.sFilter;
        const a = Math.abs(f);
        const fc = f < 0 ? Math.min(nyq, 20000 * Math.pow(0.012, a)) : Math.max(10, 20 * Math.pow(120, a));
        const g = Math.tan(Math.PI * Math.min(fc, nyq) / sr);
        kq = 1 / (0.707 + 0.65 * a);
        a1 = 1 / (1 + g * (g + kq)); a2 = g * a1; a3 = g * a2;
        mode = Math.abs(f) < 0.0005 ? 0 : (f < 0 ? -1 : 1);
        // Phaser sweep 250 Hz…2.5 kHz.
        const ph = this.beat / phDiv;
        const lfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * (ph - Math.floor(ph)));
        const fp = 250 * Math.pow(10, lfo);
        const tp = Math.tan(Math.PI * fp / sr);
        phC = (tp - 1) / (tp + 1);
      }
      const o = i * 5;
      sFilt[o] = a1; sFilt[o + 1] = a2; sFilt[o + 2] = a3; sFilt[o + 3] = kq; sFilt[o + 4] = mode;
      sPhC[i] = phC;

      // Flanger: 0.6–4 ms delay.
      const fph = this.beat / flDiv;
      const flfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * (fph - Math.floor(fph)));
      sFlDelay[i] = (0.0006 + 0.0034 * flfo) * sr;

      // Trans gate: open on the first half of each division.
      const gph = this.beat / gateDiv;
      const open = gph - Math.floor(gph) < 0.5;
      const gTarget = open ? 1 : 1 - this.sGateDepth;
      this.gateGain += (gTarget - this.gateGain) * kGate;
      sGate[i] = this.gateGain;

      // Bit crusher.
      const c = this.sCrush;
      const holdN = 1 + Math.floor(c * c * 24);
      this.holdCounter += 1;
      if (this.holdCounter >= holdN) { this.holdCounter = 0; sHold[i] = 1; } else sHold[i] = 0;
      sCrushMix[i] = Math.min(1, c * 4);
      sCrushStep[i] = Math.pow(2, -(15 - c * 11));

      // Loop roll: record a slice of the live signal, then repeat it.
      const wantRoll = t.roll > 0.5;
      if (wantRoll && !this.rolling) {
        this.rolling = true;
        this.rollPos = 0;
        this.rollLen = Math.max(64, Math.min(this.rollSize - 1, Math.floor(Math.max(t.rollDiv, 0.03125) * 60 / Math.max(this.bpm, 1) * sr)));
      } else if (!wantRoll && this.rolling && this.rollMix < 0.01) {
        this.rolling = false;
      }
      this.rollMix += ((wantRoll ? 1 : 0) - this.rollMix) * kRoll;
      if (this.rolling) {
        const p = this.rollPos % this.rollLen;
        sRoll[i] = p;
        sRec[i] = this.rollPos < this.rollLen ? 1 : 0;
        let edge = 1;
        if (this.rollPos >= this.rollLen) {
          const fadeN = Math.max(1, Math.min(96, Math.floor(this.rollLen / 4)));
          if (p < fadeN) edge = p / fadeN; else if (p > this.rollLen - fadeN) edge = (this.rollLen - p) / fadeN;
        }
        sRollMix[i] = this.rollMix * edge;
        sRollDry[i] = 1 - this.rollMix;
        this.rollPos += 1;
      } else {
        sRoll[i] = -1;
      }
    }

    const flMix = this.sFlanger, phMix = this.sPhaser;
    const startFl = this.flWrite;
    const chans = [L, R];
    for (let ch = 0; ch < 2; ch++) {
      const x0 = chans[ch];
      const ringOff = ch * this.rollSize;
      const flOff = ch * this.flSize;
      let fw = startFl;
      let c1 = this.ic1[ch], c2 = this.ic2[ch];
      let fb = this.phFB[ch];
      let h = this.held[ch];
      const zb = ch * 4;
      for (let i = 0; i < n; i++) {
        let x = x0[i];
        const ri = sRoll[i];
        if (ri >= 0) {
          if (sRec[i] > 0) this.rollRing[ringOff + ri] = x;
          x = x * sRollDry[i] + this.rollRing[ringOff + ri] * sRollMix[i];
        }
        const o = i * 5;
        const md = sFilt[o + 4];
        if (md !== 0) {
          const v3 = x - c2;
          const v1 = sFilt[o] * c1 + sFilt[o + 1] * v3;
          const v2 = c2 + sFilt[o + 1] * c1 + sFilt[o + 2] * v3;
          c1 = 2 * v1 - c1;
          c2 = 2 * v2 - c2;
          x = md < 0 ? v2 : x - sFilt[o + 3] * v1 - v2;
        }
        if (phMix > 0.0005) {
          const cc = sPhC[i];
          let u = x + 0.45 * fb;
          for (let s = 0; s < 4; s++) {
            const y = cc * u + this.apz[zb + s];
            this.apz[zb + s] = u - cc * y;
            u = y;
          }
          fb = u;
          x = (x + phMix * u) / (1 + 0.5 * phMix);
        }
        if (flMix > 0.0005) {
          const d = sFlDelay[i];
          let rp = fw - d;
          if (rp < 0) rp += this.flSize;
          const i0 = Math.floor(rp) % this.flSize;
          const fr = rp - Math.floor(rp);
          const dly = this.flRing[flOff + i0] * (1 - fr) + this.flRing[flOff + ((i0 + 1) % this.flSize)] * fr;
          this.flRing[flOff + fw] = x + 0.6 * flMix * dly;
          fw += 1;
          if (fw >= this.flSize) fw = 0;
          x = (x + flMix * dly) / (1 + 0.45 * flMix);
        }
        const cm = sCrushMix[i];
        if (cm > 0.0005) {
          if (sHold[i] > 0) h = x;
          const step = sCrushStep[i];
          const q = Math.round(h / step) * step;
          x = x * (1 - cm) + q * cm;
        }
        x0[i] = x * sGate[i];
      }
      if (ch === 1) this.flWrite = fw;
      this.ic1[ch] = c1; this.ic2[ch] = c2; this.phFB[ch] = fb; this.held[ch] = h;
    }
  }
}
