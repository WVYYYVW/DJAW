// Encoder delay ("priming") in the MP4s DJAW writes.
//
// An AAC encoder puts some silence in front of the music (Apple's: 2112 samples, ~44 ms at 48 kHz); a player only
// skips it when the file says so, with an edit list on the audio track. mp4-muxer writes none, so the sound came that
// much later than the pictures (and than the mix's own time). `encoderDelay` measures the delay of this computer's
// encoder once (encode a click, decode it, see where it lands) and `addAudioEditList` writes the edit list into the
// finished file. Opus carries its own pre-skip in its header (the decoders apply it), so it measures as no delay.
import fs from 'node:fs';

// MARK: Measuring

// WebCodecs' decoder (in Chromium, not in this TypeScript's DOM types).
interface DecoderConfig { codec: string; sampleRate: number; numberOfChannels: number; description?: BufferSource }
interface Decoder { configure(c: DecoderConfig): void; decode(c: EncodedAudioChunk): void; flush(): Promise<void>; close(): void }
const AudioDecoderClass = () => (globalThis as unknown as { AudioDecoder?: new (init: { output: (a: AudioData) => void; error: (e: unknown) => void }) => Decoder }).AudioDecoder;

const measured = new Map<string, Promise<number>>();

/** Samples of delay the encoder adds in front (as decoded), for this codec / rate / bitrate; 0 when unknown. */
export function encoderDelay(codec: string, sampleRate: number, bitrate: number): Promise<number> {
  const key = `${codec}/${sampleRate}/${bitrate}`;
  let p = measured.get(key);
  if (!p) { p = measure(codec, sampleRate, bitrate).catch(() => 0); measured.set(key, p); }
  return p;
}

async function measure(codec: string, sampleRate: number, bitrate: number): Promise<number> {
  const n = Math.round(sampleRate * 0.6), at = Math.round(sampleRate * 0.2), burst = 480;
  // A short burst of noise (the same every time) in silence: its place after decoding is easy to find exactly.
  const sig = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < burst; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    sig[at + i] = ((seed / 2 ** 32) * 2 - 1) * 0.6 * Math.sin(Math.PI * i / burst);
  }
  const chunks: EncodedAudioChunk[] = [];
  let config: DecoderConfig | null = null;
  let failed: unknown = null;
  const enc = new AudioEncoder({
    output: (c, m) => { chunks.push(c); if (m?.decoderConfig) config = m.decoderConfig as DecoderConfig; },
    error: e => { failed = e; },
  });
  enc.configure({ codec, sampleRate, numberOfChannels: 2, bitrate });
  const piece = 4096;
  for (let pos = 0; pos < n; pos += piece) {
    const k = Math.min(piece, n - pos), data = new Float32Array(k * 2);
    data.set(sig.subarray(pos, pos + k)); data.set(sig.subarray(pos, pos + k), k);
    const a = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: k, numberOfChannels: 2, timestamp: Math.round(pos / sampleRate * 1e6), data });
    enc.encode(a); a.close();
  }
  await enc.flush(); enc.close();
  const Dec = AudioDecoderClass();
  if (failed || !config || !Dec) return 0;
  const out: Float32Array[] = [];
  const dec = new Dec({
    output: a => { const f = new Float32Array(a.numberOfFrames); (a as unknown as { copyTo(d: Float32Array, o: { planeIndex: number; format: string }): void }).copyTo(f, { planeIndex: 0, format: "f32-planar" }); out.push(f); a.close(); },
    error: e => { failed = e; },
  });
  dec.configure(config);
  for (const c of chunks) dec.decode(c);
  await dec.flush(); dec.close();
  if (failed) return 0;
  const total = out.reduce((s, f) => s + f.length, 0), y = new Float32Array(total);
  let o = 0; for (const f of out) { y.set(f, o); o += f.length; }
  return delayOf(sig.subarray(at, at + burst), y, at, Math.round(sampleRate * 0.25));
}

/** Where `pattern` (placed at `at` in the original) lands in `y`, as samples later (0…maxDelay); 0 if not found. */
export function delayOf(pattern: Float32Array, y: Float32Array, at: number, maxDelay: number) {
  let best = -Infinity, bestD = 0, energy = 0;
  for (const v of pattern) energy += v * v;
  for (let d = -64; d <= maxDelay; d++) {
    const s = at + d;
    if (s < 0 || s + pattern.length > y.length) continue;
    let c = 0;
    for (let i = 0; i < pattern.length; i++) c += pattern[i] * y[s + i];
    if (c > best) { best = c; bestD = d; }
  }
  // Too weak a match (a broken decoder): leave the file as it is.
  return best > energy * 0.3 ? Math.max(0, bestD) : 0;
}

// MARK: The edit list

interface Box { type: string; start: number; size: number; header: number }

function boxes(b: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = b.readUInt32BE(p), header = 8;
    const type = b.toString('latin1', p + 4, p + 8);
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); header = 16; } else if (size === 0) size = to - p;
    if (size < header || p + size > to) break;
    out.push({ type, start: p, size, header });
    p += size;
  }
  return out;
}
const child = (b: Buffer, box: Box, type: string) => boxes(b, box.start + box.header, box.start + box.size).find(x => x.type === type);

/** The top-level boxes of a file, read from their headers only (the media data is not read). */
function topLevel(fd: number, length: number) {
  const out: Box[] = [];
  const h = Buffer.alloc(16);
  let p = 0;
  while (p + 8 <= length) {
    fs.readSync(fd, h, 0, 16, p);
    let size = h.readUInt32BE(0), header = 8;
    if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16; } else if (size === 0) size = length - p;
    if (size < header) break;
    out.push({ type: h.toString('latin1', 4, 8), start: p, size, header });
    p += size;
  }
  return out;
}

/**
 * Makes players skip the first `skip` samples (at `sampleRate`) of the audio track of an MP4 / M4A whose `moov` is
 * the last box (as mp4-muxer writes it without fast start). Returns whether it was written.
 */
export function addAudioEditList(path: string, skip: number, sampleRate: number): boolean {
  if (skip <= 0) return false;
  const fd = fs.openSync(path, 'r+');
  try {
    const length = fs.fstatSync(fd).size;
    const top = topLevel(fd, length);
    const moovBox = top.find(x => x.type === 'moov');
    if (!moovBox || moovBox.start + moovBox.size !== length || moovBox.header !== 8) return false;
    const moov = Buffer.alloc(moovBox.size);
    fs.readSync(fd, moov, 0, moov.length, moovBox.start);
    const m: Box = { type: 'moov', start: 0, size: moov.length, header: 8 };
    const mvhd = child(moov, m, 'mvhd');
    if (!mvhd) return false;
    const mv = mvhd.start + mvhd.header, movieScale = moov.readUInt32BE(mv + (moov[mv] === 1 ? 20 : 12));
    for (const trak of boxes(moov, 8, moov.length).filter(x => x.type === 'trak')) {
      const mdia = child(moov, trak, 'mdia'), tkhd = child(moov, trak, 'tkhd');
      const hdlr = mdia && child(moov, mdia, 'hdlr'), mdhd = mdia && child(moov, mdia, 'mdhd');
      if (!mdia || !tkhd || !hdlr || !mdhd || child(moov, trak, 'edts')) continue;
      if (moov.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) !== 'soun') continue;
      if (trak.header !== 8) return false;
      const md = mdhd.start + mdhd.header, v1 = moov[md] === 1;
      const mediaScale = moov.readUInt32BE(md + (v1 ? 20 : 12));
      const mediaDur = v1 ? Number(moov.readBigUInt64BE(md + 24)) : moov.readUInt32BE(md + 16);
      const mediaTime = Math.round(skip * mediaScale / sampleRate);
      if (mediaTime >= mediaDur) return false;
      const segment = Math.round((mediaDur - mediaTime) * movieScale / mediaScale);
      // edts { elst v0: one entry (segment duration, media time, rate 1.0) }
      const edts = Buffer.alloc(36);
      edts.writeUInt32BE(36, 0); edts.write('edts', 4, 'latin1');
      edts.writeUInt32BE(28, 8); edts.write('elst', 12, 'latin1');
      edts.writeUInt32BE(0, 16); edts.writeUInt32BE(1, 20);
      edts.writeUInt32BE(segment, 24); edts.writeInt32BE(mediaTime, 28); edts.writeUInt16BE(1, 32); edts.writeUInt16BE(0, 34);
      // The track lasts as long as what is shown of it.
      const tk = tkhd.start + tkhd.header;
      if (moov[tk] === 1) moov.writeBigUInt64BE(BigInt(segment), tk + 28); else moov.writeUInt32BE(segment, tk + 20);
      const at = tkhd.start + tkhd.size;
      const out = Buffer.concat([moov.subarray(0, at), edts, moov.subarray(at)]);
      out.writeUInt32BE(out.length, 0);
      out.writeUInt32BE(trak.size + 36, trak.start);
      fs.writeSync(fd, out, 0, out.length, moovBox.start);
      return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** The edit list of the audio track (for tests): [segment duration, media time] or null. */
export function audioEditList(path: string): [number, number] | null {
  const b = fs.readFileSync(path);
  const moovBox = boxes(b, 0, b.length).find(x => x.type === 'moov');
  if (!moovBox) return null;
  for (const trak of boxes(b, moovBox.start + 8, moovBox.start + moovBox.size).filter(x => x.type === 'trak')) {
    const mdia = child(b, trak, 'mdia'), hdlr = mdia && child(b, mdia, 'hdlr');
    if (!hdlr || b.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) !== 'soun') continue;
    const edts = child(b, trak, 'edts'), elst = edts && child(b, edts, 'elst');
    if (!elst) return null;
    const e = elst.start + elst.header;
    return [b.readUInt32BE(e + 8), b.readInt32BE(e + 12)];
  }
  return null;
}
