// Streaming WAV writer (24-bit PCM like the Mac export, or 16-bit / 32-bit float).
import fs from 'node:fs';

export type WavBits = 16 | 24 | 32;

export class WavWriter {
  private fd: number;
  private frames = 0;
  private buf = Buffer.alloc(0);

  constructor(readonly path: string, readonly sampleRate: number, readonly bits: WavBits = 24) {
    this.fd = fs.openSync(path, 'w');
    fs.writeSync(this.fd, this.header(0));
  }

  private header(frames: number) {
    const ch = 2, bps = this.bits / 8, float = this.bits === 32;
    const data = frames * ch * bps;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(Math.min(0xffffffff, 36 + data), 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(float ? 3 : 1, 20);
    h.writeUInt16LE(ch, 22);
    h.writeUInt32LE(this.sampleRate, 24);
    h.writeUInt32LE(this.sampleRate * ch * bps, 28);
    h.writeUInt16LE(ch * bps, 32);
    h.writeUInt16LE(this.bits, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(Math.min(0xffffffff, data), 40);
    return h;
  }

  /** Writes n frames, scaled by `gain` and clipped to full scale. */
  write(L: Float32Array, R: Float32Array, n: number, gain = 1) {
    const bps = this.bits / 8;
    const bytes = n * 2 * bps;
    if (this.buf.length < bytes) this.buf = Buffer.alloc(bytes);
    const b = this.buf;
    let p = 0;
    for (let i = 0; i < n; i++) {
      for (const x0 of [L[i] * gain, R[i] * gain]) {
        const x = x0 > 1 ? 1 : x0 < -1 ? -1 : x0;
        if (this.bits === 16) { b.writeInt16LE(Math.round(x * 32767), p); p += 2; }
        else if (this.bits === 24) { b.writeIntLE(Math.round(x * 8388607), p, 3); p += 3; }
        else { b.writeFloatLE(x0, p); p += 4; }
      }
    }
    fs.writeSync(this.fd, b, 0, bytes);
    this.frames += n;
  }

  close() {
    fs.writeSync(this.fd, this.header(this.frames), 0, 44, 0);
    fs.closeSync(this.fd);
  }
}
