// Pitch-preserving time-stretch (Signalsmith Stretch, MIT, WASM) driven directly, sample-exact.
// See tools/signalsmith: with the "seek" start used here, the output is delayed by exactly the output latency,
// which `start` discards — so output frame 0 is input position `p0`, and every block consumes exactly the input
// the rate asks for (no drift, no calibration).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — generated file (scripts/build.mjs)
import Factory from '../../vendor/stretch-core.mjs';

interface StretchModule {
  HEAP8: Int8Array;
  _main?: () => void;
  _presetDefault(ch: number, sr: number): void;
  _presetCheaper(ch: number, sr: number): void;
  _setBuffers(ch: number, len: number): number;
  _inputLatency(): number;
  _outputLatency(): number;
  _setTransposeSemitones(semitones: number, tonality: number): void;
  _seek(inputSamples: number, rate: number): void;
  _process(inputSamples: number, outputSamples: number): void;
  _reset(): void;
}

export const MAX_BLOCK = 4096;

export class Stretcher {
  readonly inputLatency: number;
  readonly outputLatency: number;
  private readonly len: number;
  private readonly ptr: number;
  private semitones = NaN;

  private constructor(private readonly m: StretchModule, readonly sampleRate: number) {
    m._presetDefault(2, sampleRate);
    this.inputLatency = m._inputLatency();
    this.outputLatency = m._outputLatency();
    // Room for the seek buffer and for the largest block at the fastest rate (4×).
    this.len = Math.max(this.inputLatency + this.outputLatency, MAX_BLOCK * 4 + 16);
    this.ptr = m._setBuffers(2, this.len);
  }

  static async create(sampleRate: number): Promise<Stretcher> {
    const m = (await Factory()) as StretchModule;
    m._main?.();
    return new Stretcher(m, sampleRate);
  }

  /** Input buffer of a channel (valid until the next call). */
  input(ch: number, n: number) {
    return new Float32Array(this.m.HEAP8.buffer, this.ptr + this.len * 4 * ch, n);
  }

  private output(ch: number, n: number) {
    return new Float32Array(this.m.HEAP8.buffer, this.ptr + this.len * 4 * (2 + ch), n);
  }

  setPitch(semitones: number) {
    if (semitones === this.semitones) return;
    this.semitones = semitones;
    this.m._setTransposeSemitones(semitones, 8000 / this.sampleRate);
  }

  get seekLength() { return this.inputLatency + this.outputLatency; }

  /**
   * Primes the stretch so its next output is the input that follows the seek buffer, `outputLatency` frames late.
   * `fill(L, R)` must write `seekLength` frames: the input that ends `inputLatency` frames after the start point.
   */
  seek(rate: number, fill: (L: Float32Array, R: Float32Array) => void) {
    this.m._reset();
    const n = this.seekLength;
    fill(this.input(0, n), this.input(1, n));
    this.m._seek(n, rate);
  }

  /** Processes one block: `inN` input frames (already written with `input`) into `outN` output frames. */
  process(inN: number, outN: number, L: Float32Array, R: Float32Array, offset = 0) {
    this.m._process(inN, outN);
    L.set(this.output(0, outN), offset);
    R.set(this.output(1, outN), offset);
  }
}

/** Reuses stretch instances (each is its own WASM module). */
export class StretchPool {
  private free: Stretcher[] = [];
  constructor(readonly sampleRate: number) {}

  async prepare(n: number) {
    while (this.free.length < n) this.free.push(await Stretcher.create(this.sampleRate));
  }

  take(): Stretcher | null {
    return this.free.pop() ?? null;
  }

  give(s: Stretcher) {
    this.free.push(s);
  }

  get available() { return this.free.length; }
}
