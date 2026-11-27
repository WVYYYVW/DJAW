// Master peak limiter (stereo-linked, look-ahead), so that loud moments are turned down smoothly instead of being
// cut off at full scale (hard clipping = audible distortion).
//
// Why it is needed: a time-stretch (phase vocoder) re-builds the sound from its spectrum and loses the phase
// relations a mastering limiter had set, so the peaks of a loud, limited track grow by up to ~6 dB at any speed other
// than its own (while its loudness stays the same). Two tracks overlapping in a transition add up the same way.
//
// The output is `lookahead` frames late; RenderSession renders that much ahead, so nothing moves in time.

export class Limiter {
  readonly lookahead: number;
  private readonly ceiling: number;
  private readonly release: number;
  // Delay line for the audio, and the look-ahead minimum of the needed gain (monotonic deque) and its running mean.
  private readonly dL: Float32Array;
  private readonly dR: Float32Array;
  private readonly box: Float32Array;
  private readonly dqVal: Float32Array;
  private readonly dqPos: Float64Array;
  private dqHead = 0;
  private dqTail = 0;
  private boxSum = 0;
  private pos = 0;
  private gain = 1;
  /** Deepest gain reduction since the last read (for meters / tests), as a factor ≤ 1. */
  minGain = 1;

  constructor(readonly sampleRate: number, ceilingDb = -0.5, lookaheadMs = 3, releaseMs = 40) {
    this.ceiling = Math.pow(10, ceilingDb / 20);
    this.lookahead = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
    this.release = 1 - Math.exp(-1 / ((sampleRate * releaseMs) / 1000));
    const n = this.lookahead + 1;
    this.dL = new Float32Array(n);
    this.dR = new Float32Array(n);
    this.box = new Float32Array(this.lookahead).fill(1);
    this.boxSum = this.lookahead;
    this.dqVal = new Float32Array(n + 1);
    this.dqPos = new Float64Array(n + 1);
  }

  /** Limits n frames in place (the result is `lookahead` frames late). */
  process(L: Float32Array, R: Float32Array, n: number) {
    const D = this.lookahead, size = D + 1, cap = this.dqVal.length;
    for (let i = 0; i < n; i++) {
      const p = this.pos;
      const l = L[i], r = R[i];
      const a = Math.max(Math.abs(l), Math.abs(r));
      const g = a > this.ceiling ? this.ceiling / a : 1;
      // Sliding minimum of the needed gain over the last D + 1 input frames (= the next D frames of the output).
      while (this.dqTail !== this.dqHead && this.dqVal[(this.dqTail - 1 + cap) % cap] >= g) this.dqTail = (this.dqTail - 1 + cap) % cap;
      this.dqVal[this.dqTail] = g; this.dqPos[this.dqTail] = p; this.dqTail = (this.dqTail + 1) % cap;
      while (this.dqPos[this.dqHead] <= p - size) this.dqHead = (this.dqHead + 1) % cap;
      const hold = this.dqVal[this.dqHead];
      // Mean of the held minimum over D frames: a smooth ramp down that reaches the needed gain at the peak itself.
      const k = p % D;
      this.boxSum += hold - this.box[k];
      this.box[k] = hold;
      const target = Math.min(1, this.boxSum / D);
      // Down at once (the ramp is already smooth), back up slowly.
      this.gain = target < this.gain ? target : this.gain + (target - this.gain) * this.release;
      if (this.gain < this.minGain) this.minGain = this.gain;
      // Delayed audio × gain.
      const j = p % size;
      const oL = this.dL[(j + 1) % size], oR = this.dR[(j + 1) % size];
      this.dL[j] = l; this.dR[j] = r;
      L[i] = oL * this.gain;
      R[i] = oR * this.gain;
      this.pos = p + 1;
    }
  }
}
