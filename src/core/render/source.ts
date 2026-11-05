// Audio sources for the render engine: random access to a track's samples without keeping the track in memory.
//  - WAV / AIFF files at the mix sample rate are read straight from disk.
//  - Everything else (MP3, AAC, FLAC, other sample rates) is decoded once into a PCM cache file (see pcmcache.ts).
import fs from 'node:fs';

export interface AudioSource {
  readonly sampleRate: number;
  readonly frames: number;
  readonly channels: number;
  /** Reads `count` frames from `start` into L / R (zero outside the file). Mono sources fill both. */
  read(start: number, count: number, L: Float32Array, R: Float32Array, offset?: number): void;
  close(): void;
}

type Encoding = 'pcm16' | 'pcm24' | 'pcm32' | 'float32' | 'float64' | 'pcm8';

/** A PCM file read in place: little-endian WAV or big-endian AIFF. */
export class PcmFileSource implements AudioSource {
  private fd: number;
  private buf = Buffer.alloc(0);

  constructor(
    readonly path: string,
    readonly sampleRate: number,
    readonly channels: number,
    readonly frames: number,
    private readonly dataOffset: number,
    private readonly encoding: Encoding,
    private readonly bigEndian = false,
  ) {
    this.fd = fs.openSync(path, 'r');
  }

  get bytesPerSample() {
    return ({ pcm8: 1, pcm16: 2, pcm24: 3, pcm32: 4, float32: 4, float64: 8 } as const)[this.encoding];
  }

  read(start: number, count: number, L: Float32Array, R: Float32Array, offset = 0) {
    let a = start, n = count, o = offset;
    if (a < 0) {
      const z = Math.min(n, -a);
      L.fill(0, o, o + z); R.fill(0, o, o + z);
      a += z; n -= z; o += z;
    }
    const avail = Math.max(0, Math.min(n, this.frames - a));
    if (avail < n) { L.fill(0, o + avail, o + n); R.fill(0, o + avail, o + n); }
    if (avail <= 0) return;
    const bps = this.bytesPerSample, ch = this.channels, frameBytes = bps * ch;
    const bytes = avail * frameBytes;
    if (this.buf.length < bytes) this.buf = Buffer.alloc(Math.max(bytes, 1 << 16));
    fs.readSync(this.fd, this.buf, 0, bytes, this.dataOffset + a * frameBytes);
    const b = this.buf, be = this.bigEndian;
    const sample = (p: number): number => {
      switch (this.encoding) {
        case 'pcm16': return (be ? b.readInt16BE(p) : b.readInt16LE(p)) / 32768;
        case 'pcm24': return (be ? b.readIntBE(p, 3) : b.readIntLE(p, 3)) / 8388608;
        case 'pcm32': return (be ? b.readInt32BE(p) : b.readInt32LE(p)) / 2147483648;
        case 'float32': return be ? b.readFloatBE(p) : b.readFloatLE(p);
        case 'float64': return be ? b.readDoubleBE(p) : b.readDoubleLE(p);
        case 'pcm8': return be ? b.readInt8(p) / 128 : (b.readUInt8(p) - 128) / 128;
      }
    };
    if (this.encoding === 'pcm16' && !be) {
      const v = new Int16Array(b.buffer, b.byteOffset, avail * ch);
      if (b.byteOffset % 2 === 0) {
        for (let i = 0; i < avail; i++) {
          L[o + i] = v[i * ch] / 32768;
          R[o + i] = v[i * ch + (ch > 1 ? 1 : 0)] / 32768;
        }
        return;
      }
    }
    for (let i = 0; i < avail; i++) {
      const p = i * frameBytes;
      const l = sample(p);
      L[o + i] = l;
      R[o + i] = ch > 1 ? sample(p + bps) : l;
    }
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* closed */ }
  }
}

/** Parses the header of a WAV (RIFF / RF64) or AIFF / AIFF-C file. Null if it is not plain PCM / float. */
export function openPcmFile(path: string): PcmFileSource | null {
  const fd = fs.openSync(path, 'r');
  try {
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
    const id = head.toString('ascii', 0, 4);
    const size = fs.fstatSync(fd).size;
    if ((id === 'RIFF' || id === 'RF64') && head.toString('ascii', 8, 12) === 'WAVE') return parseWav(fd, path, size);
    if (id === 'FORM' && ['AIFF', 'AIFC'].includes(head.toString('ascii', 8, 12))) return parseAiff(fd, path, size, head.toString('ascii', 8, 12) === 'AIFC');
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function parseWav(fd: number, path: string, fileSize: number): PcmFileSource | null {
  let pos = 12;
  let fmt: { tag: number; ch: number; sr: number; bits: number } | null = null;
  let ds64Data = -1;
  const h = Buffer.alloc(8);
  while (pos + 8 <= fileSize) {
    fs.readSync(fd, h, 0, 8, pos);
    const cid = h.toString('ascii', 0, 4);
    let len = h.readUInt32LE(4);
    if (cid === 'ds64') {
      const b = Buffer.alloc(Math.min(len, 28));
      fs.readSync(fd, b, 0, b.length, pos + 8);
      ds64Data = Number(b.readBigUInt64LE(8));
    } else if (cid === 'fmt ') {
      const b = Buffer.alloc(Math.min(len, 40));
      fs.readSync(fd, b, 0, b.length, pos + 8);
      let tag = b.readUInt16LE(0);
      if (tag === 0xfffe && b.length >= 26) tag = b.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE: sub-format GUID
      fmt = { tag, ch: b.readUInt16LE(2), sr: b.readUInt32LE(4), bits: b.readUInt16LE(14) };
    } else if (cid === 'data') {
      if (!fmt) return null;
      if (len === 0xffffffff && ds64Data >= 0) len = ds64Data;
      len = Math.min(len, fileSize - pos - 8);
      const enc: Encoding | null = fmt.tag === 1
        ? ({ 8: 'pcm8', 16: 'pcm16', 24: 'pcm24', 32: 'pcm32' } as Record<number, Encoding>)[fmt.bits] ?? null
        : fmt.tag === 3 ? ({ 32: 'float32', 64: 'float64' } as Record<number, Encoding>)[fmt.bits] ?? null : null;
      if (!enc || fmt.ch < 1) return null;
      const frames = Math.floor(len / (fmt.ch * fmt.bits / 8));
      return new PcmFileSource(path, fmt.sr, fmt.ch, frames, pos + 8, enc);
    }
    pos += 8 + len + (len & 1);
  }
  return null;
}

/** IEEE 754 80-bit extended → number (AIFF sample rate). */
function extended(b: Buffer, p: number) {
  const exp = ((b[p] & 0x7f) << 8) | b[p + 1];
  const hi = b.readUInt32BE(p + 2), lo = b.readUInt32BE(p + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const sign = b[p] & 0x80 ? -1 : 1;
  return sign * (hi * Math.pow(2, exp - 16383 - 31) + lo * Math.pow(2, exp - 16383 - 63));
}

function parseAiff(fd: number, path: string, fileSize: number, aifc: boolean): PcmFileSource | null {
  let pos = 12;
  let comm: { ch: number; frames: number; bits: number; sr: number; comp: string } | null = null;
  const h = Buffer.alloc(8);
  while (pos + 8 <= fileSize) {
    fs.readSync(fd, h, 0, 8, pos);
    const cid = h.toString('ascii', 0, 4);
    const len = h.readUInt32BE(4);
    if (cid === 'COMM') {
      const b = Buffer.alloc(Math.min(len, 26));
      fs.readSync(fd, b, 0, b.length, pos + 8);
      comm = { ch: b.readUInt16BE(0), frames: b.readUInt32BE(2), bits: b.readUInt16BE(6), sr: extended(b, 8), comp: aifc && b.length >= 22 ? b.toString('ascii', 18, 22) : 'NONE' };
    } else if (cid === 'SSND') {
      if (!comm) return null;
      const b = Buffer.alloc(8);
      fs.readSync(fd, b, 0, 8, pos + 8);
      const offset = b.readUInt32BE(0);
      const comp = comm.comp;
      let enc: Encoding | null = null, be = true;
      if (comp === 'NONE' || comp === 'twos') enc = ({ 8: 'pcm8', 16: 'pcm16', 24: 'pcm24', 32: 'pcm32' } as Record<number, Encoding>)[comm.bits] ?? null;
      else if (comp === 'sowt') { enc = comm.bits === 16 ? 'pcm16' : comm.bits === 24 ? 'pcm24' : comm.bits === 32 ? 'pcm32' : null; be = false; }
      else if (comp === 'fl32' || comp === 'FL32') enc = 'float32';
      else if (comp === 'fl64' || comp === 'FL64') enc = 'float64';
      if (!enc) return null;
      return new PcmFileSource(path, comm.sr, comm.ch, comm.frames, pos + 16 + offset, enc, be);
    }
    pos += 8 + len + (len & 1);
  }
  return null;
}

/** A source held in memory (tests, short buffers). */
export class MemorySource implements AudioSource {
  readonly channels = 2;
  constructor(readonly sampleRate: number, readonly left: Float32Array, readonly right: Float32Array = left) {}
  get frames() { return this.left.length; }
  read(start: number, count: number, L: Float32Array, R: Float32Array, offset = 0) {
    for (let i = 0; i < count; i++) {
      const j = start + i;
      const ok = j >= 0 && j < this.left.length;
      L[offset + i] = ok ? this.left[j] : 0;
      R[offset + i] = ok ? this.right[j] : 0;
    }
  }
  close() {}
}
