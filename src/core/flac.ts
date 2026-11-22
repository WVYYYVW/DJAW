// A small lossless FLAC encoder (fixed predictors, mid/side stereo, Rice-coded residuals) so a .djaw can carry
// WAV tracks at about half their size, bit for bit the same when decoded. Chromium decodes FLAC natively.
// Format: https://xiph.org/flac/format.html (RFC 9639).

export interface PcmInput {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Interleaved integer samples. */
  samples: Int32Array;
}

class BitWriter {
  buf = new Uint8Array(1 << 20);
  pos = 0; // bytes
  acc = 0; // pending bits (MSB first)
  n = 0; // number of pending bits (< 8)
  private grow(min: number) {
    if (this.pos + min < this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + min + 1024));
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }
  /** Writes the low `bits` bits of v (bits ≤ 32). */
  write(v: number, bits: number) {
    this.grow(8);
    while (bits > 0) {
      const take = Math.min(bits, 8 - this.n);
      const shift = bits - take;
      const part = Math.floor(v / 2 ** shift) & ((1 << take) - 1);
      this.acc = (this.acc << take) | part;
      this.n += take;
      bits -= take;
      if (this.n === 8) { this.buf[this.pos++] = this.acc; this.acc = 0; this.n = 0; }
    }
  }
  /** q zero bits then a one. */
  unary(q: number) {
    while (q >= 8) {
      if (this.n === 0) { this.grow(2); this.buf[this.pos++] = 0; q -= 8; continue; }
      const take = 8 - this.n;
      this.write(0, take);
      q -= take;
    }
    this.write(0, q);
    this.write(1, 1);
  }
  alignZero() { if (this.n) this.write(0, 8 - this.n); }
  get bytes() { return this.buf.subarray(0, this.pos); }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
const crc8 = (b: Uint8Array, from: number, to: number) => { let c = 0; for (let i = from; i < to; i++) c = CRC8[c ^ b[i]]; return c; };
const crc16 = (b: Uint8Array, from: number, to: number) => { let c = 0; for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

const BLOCK = 4096;
const zig = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);

/** Residuals of a fixed predictor of the given order (0–4). */
function residual(x: Int32Array, order: number, out: Float64Array) {
  const n = x.length;
  for (let i = order; i < n; i++) {
    let r: number;
    switch (order) {
      case 0: r = x[i]; break;
      case 1: r = x[i] - x[i - 1]; break;
      case 2: r = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: r = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: r = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    out[i] = r;
  }
}

/** Best Rice parameter for a run of residuals and its cost in bits. */
function riceCost(r: Float64Array, from: number, to: number): [number, number] {
  let sum = 0;
  for (let i = from; i < to; i++) sum += zig(r[i]);
  const n = to - from;
  if (n <= 0) return [0, 0];
  let k = sum > n ? Math.min(30, Math.floor(Math.log2(sum / n))) : 0;
  let best = Infinity, bestK = 0;
  for (const kk of [k - 1, k, k + 1]) {
    if (kk < 0 || kk > 30) continue;
    let bits = n * (kk + 1);
    const d = 2 ** kk;
    for (let i = from; i < to; i++) bits += Math.floor(zig(r[i]) / d);
    if (bits < best) { best = bits; bestK = kk; }
  }
  k = bestK;
  return [k, best];
}

function writeSubframe(w: BitWriter, x: Int32Array, bps: number, scratch: Float64Array) {
  const n = x.length;
  // Constant block (silence).
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) { w.write(0, 1); w.write(0, 6); w.write(0, 1); w.write(x[0] < 0 ? x[0] + 2 ** bps : x[0], bps); return; }
  // Fixed predictor with the smallest residuals.
  let bestOrder = 0, bestSum = Infinity;
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    residual(x, order, scratch);
    let s = 0;
    for (let i = order; i < n; i++) s += Math.abs(scratch[i]);
    if (s < bestSum) { bestSum = s; bestOrder = order; }
  }
  residual(x, bestOrder, scratch);
  // Partition order: as fine as helps (block divisible by 2^p, first partition longer than the warm-up).
  let bestP = 0, bestBits = Infinity, bestParams: number[] = [];
  for (let p = 0; p <= 8; p++) {
    const parts = 1 << p;
    if (n % parts || (n >> p) <= bestOrder) break;
    const size = n >> p;
    let bits = 0;
    const params: number[] = [];
    for (let k = 0; k < parts; k++) {
      const [rk, b] = riceCost(scratch, k === 0 ? bestOrder : k * size, (k + 1) * size);
      params.push(rk); bits += b + 5;
    }
    if (bits < bestBits) { bestBits = bits; bestP = p; bestParams = params; }
  }
  const verbatimBits = n * bps;
  if (bestBits + bestOrder * bps > verbatimBits) {
    w.write(0, 1); w.write(1, 6); w.write(0, 1);
    for (let i = 0; i < n; i++) w.write(x[i] < 0 ? x[i] + 2 ** bps : x[i], bps);
    return;
  }
  w.write(0, 1); w.write(8 | bestOrder, 6); w.write(0, 1);
  for (let i = 0; i < bestOrder; i++) w.write(x[i] < 0 ? x[i] + 2 ** bps : x[i], bps);
  const fiveBit = bestParams.some(k => k > 14);
  w.write(fiveBit ? 1 : 0, 2);
  w.write(bestP, 4);
  const size = n >> bestP;
  for (let k = 0; k < (1 << bestP); k++) {
    const rk = bestParams[k];
    w.write(rk, fiveBit ? 5 : 4);
    const d = 2 ** rk;
    for (let i = k === 0 ? bestOrder : k * size; i < (k + 1) * size; i++) {
      const u = zig(scratch[i]);
      const q = Math.floor(u / d);
      w.unary(q);
      if (rk) w.write(u - q * d, rk);
    }
  }
}

function utf8Number(w: BitWriter, v: number) {
  if (v < 0x80) { w.write(v, 8); return; }
  const bytes: number[] = [];
  let lead = 0xc0, max = 0x7ff, count = 1;
  while (v > max) { count++; max = 2 ** (5 * count + 6) - 1; lead = (lead >> 1) | 0x80; }
  for (let i = 0; i < count; i++) { bytes.unshift(0x80 | (v & 0x3f)); v = Math.floor(v / 64); }
  w.write(lead | v, 8);
  for (const b of bytes) w.write(b, 8);
}

/** Encodes PCM to a FLAC file (16 or 24 bit, 1 or 2 channels). */
export function encodeFlac(input: PcmInput): Uint8Array {
  const { sampleRate: sr, channels: ch, bitsPerSample: bps, samples } = input;
  if (!(ch === 1 || ch === 2) || !(bps === 16 || bps === 24)) throw new Error('unsupported PCM for FLAC');
  const frames = Math.floor(samples.length / ch);
  const w = new BitWriter();
  w.write(0x664c6143, 32); // "fLaC"
  // STREAMINFO (last metadata block).
  w.write(1, 1); w.write(0, 7); w.write(34, 24);
  w.write(BLOCK, 16); w.write(BLOCK, 16); w.write(0, 24); w.write(0, 24);
  w.write(sr, 20); w.write(ch - 1, 3); w.write(bps - 1, 5);
  w.write(Math.floor(frames / 2 ** 32), 4); w.write(frames % 2 ** 32, 32);
  for (let i = 0; i < 4; i++) w.write(0, 32); // MD5 unknown
  const scratch = new Float64Array(BLOCK);
  const L = new Int32Array(BLOCK), R = new Int32Array(BLOCK), M = new Int32Array(BLOCK), S = new Int32Array(BLOCK);
  for (let f = 0, number = 0; f < frames; f += BLOCK, number++) {
    const n = Math.min(BLOCK, frames - f);
    const start = w.pos;
    for (let i = 0; i < n; i++) {
      L[i] = samples[(f + i) * ch];
      if (ch === 2) R[i] = samples[(f + i) * ch + 1];
    }
    const l = L.subarray(0, n), r = R.subarray(0, n);
    // Header.
    w.write(0x3ffe, 14); w.write(0, 1); w.write(0, 1);
    w.write(n === BLOCK ? 12 : 7, 4); // 4096, or an explicit 16-bit size
    w.write(0, 4); // sample rate from STREAMINFO
    w.write(ch === 2 ? 10 : 0, 4); // mid/side, or mono
    w.write(0, 3); w.write(0, 1); // sample size from STREAMINFO
    utf8Number(w, number);
    if (n !== BLOCK) w.write(n - 1, 16);
    w.write(crc8(w.buf, start, w.pos), 8);
    if (ch === 2) {
      for (let i = 0; i < n; i++) { M[i] = (l[i] + r[i]) >> 1; S[i] = l[i] - r[i]; }
      writeSubframe(w, M.subarray(0, n), bps, scratch);
      writeSubframe(w, S.subarray(0, n), bps + 1, scratch);
    } else {
      writeSubframe(w, l, bps, scratch);
    }
    w.alignZero();
    w.write(crc16(w.buf, start, w.pos), 16);
  }
  return w.bytes.slice();
}

/** Reads a PCM WAV file (16 / 24-bit integer, mono or stereo); null for anything else. */
export function parseWav(b: Uint8Array): PcmInput | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12, fmt: { format: number; ch: number; sr: number; bits: number } | null = null;
  while (o + 8 <= b.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
      fmt = { format, ch: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data' && fmt) {
      if (fmt.format !== 1 || !(fmt.bits === 16 || fmt.bits === 24) || !(fmt.ch === 1 || fmt.ch === 2)) return null;
      const bytes = fmt.bits / 8;
      const len = Math.min(size, b.length - body);
      const count = Math.floor(len / bytes / fmt.ch) * fmt.ch;
      const samples = new Int32Array(count);
      if (fmt.bits === 16) for (let i = 0; i < count; i++) samples[i] = dv.getInt16(body + i * 2, true);
      else for (let i = 0; i < count; i++) { const p = body + i * 3; const v = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); samples[i] = v & 0x800000 ? v - 0x1000000 : v; }
      return { sampleRate: fmt.sr, channels: fmt.ch, bitsPerSample: fmt.bits, samples };
    }
    o = body + size + (size & 1);
  }
  return null;
}
