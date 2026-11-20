// Waveforms of separated stems (the WAV files of core/analysis/stems.ts), for drawing behind the transition editor's
// lanes. Read once in the background (in pieces, so the window stays responsive) and kept in memory.
import fs from 'node:fs';

export interface StemPeaks { peaks: Float32Array; binsPerSecond: number; max: number }

const BPS = 100;
const cache = new Map<string, StemPeaks>();
const loading = new Set<string>();
/** Goes up whenever a stem's waveform has been read (part of what the drawings depend on). */
export let stemPeaksVersion = 0;

/** The peaks of a stem file if read already; otherwise starts reading it and calls `ready` when done. */
export function stemPeaks(file: string, ready: () => void): StemPeaks | null {
  const hit = cache.get(file);
  if (hit) return hit;
  if (!loading.has(file)) {
    loading.add(file);
    read(file).then(p => { cache.set(file, p); stemPeaksVersion++; ready(); }).catch(e => console.warn('[DJAW] stem waveform', file, e)).finally(() => loading.delete(file));
  }
  return null;
}

async function read(file: string): Promise<StemPeaks> {
  const fh = await fs.promises.open(file, 'r');
  try {
    // RIFF chunks: the format, then the samples.
    const head = Buffer.alloc(4096);
    await fh.read(head, 0, head.length, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let pos = 12, format = 1, channels = 2, rate = 44100, bits = 16, dataAt = -1, dataLen = 0;
    while (pos + 8 <= head.length) {
      const id = head.toString('ascii', pos, pos + 4), len = head.readUInt32LE(pos + 4);
      if (id === 'fmt ') { format = head.readUInt16LE(pos + 8); channels = head.readUInt16LE(pos + 10); rate = head.readUInt32LE(pos + 12); bits = head.readUInt16LE(pos + 22); }
      if (id === 'data') { dataAt = pos + 8; dataLen = len; break; }
      pos += 8 + len + (len & 1);
    }
    if (dataAt < 0) throw new Error('no data chunk');
    const size = (await fh.stat()).size;
    dataLen = Math.min(dataLen || size - dataAt, size - dataAt);
    const bytes = bits / 8, frame = bytes * channels;
    const frames = Math.floor(dataLen / frame);
    const per = rate / BPS;
    const peaks = new Float32Array(Math.ceil(frames / per));
    const chunk = Buffer.alloc(Math.floor((4 << 20) / frame) * frame);
    let done = 0, max = 0;
    while (done < frames) {
      const want = Math.min(chunk.length, (frames - done) * frame);
      const { bytesRead } = await fh.read(chunk, 0, want, dataAt + done * frame);
      if (!bytesRead) break;
      const n = Math.floor(bytesRead / frame);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) {
          const o = i * frame + c * bytes;
          v += format === 3 ? chunk.readFloatLE(o) : bits === 16 ? chunk.readInt16LE(o) / 32768 : chunk.readInt32LE(o) / 2147483648;
        }
        v = Math.abs(v / channels);
        const b = Math.floor((done + i) / per);
        if (v > peaks[b]) { peaks[b] = v; if (v > max) max = v; }
      }
      done += n;
      await new Promise(r => setTimeout(r, 0));
    }
    return { peaks, binsPerSecond: BPS, max };
  } finally {
    await fh.close();
  }
}
