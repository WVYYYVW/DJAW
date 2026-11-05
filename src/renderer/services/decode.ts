// Makes any track readable by the render engine: WAV / AIFF at 44.1 kHz are read in place; everything else
// (MP3, AAC / M4A, FLAC, OGG, other sample rates) is decoded once by Chromium into a 16-bit WAV cache.
import fs from 'node:fs';
import path from 'node:path';
import { openPcmFile } from '../../core/render/source';
import { request } from './analysis';
import { WavWriter } from '../../core/render/wav';
import { dataDir } from './env';

export const MIX_RATE = 44100;
const inflight = new Map<string, Promise<string>>();

/** Path of a file the engine can read for `file` (fingerprint `fp`). */
export function enginePath(file: string, fp: string | null): string | null {
  const direct = openPcmFile(file);
  if (direct) {
    const ok = direct.sampleRate === MIX_RATE;
    direct.close();
    if (ok) return file;
  }
  if (!fp) return null;
  const cached = dataDir('Cache', 'PCM', `${fp}.wav`);
  return fs.existsSync(cached) ? cached : null;
}

// Decoding several long tracks at once only makes them all slow (and competes with the analysis): two at a time.
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(f: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>(r => waiting.push(r));
  active++;
  try { return await f(); } finally { active--; waiting.shift()?.(); }
}

export function ensurePcm(file: string, fp: string): Promise<string> {
  const ready = enginePath(file, fp);
  if (ready) return Promise.resolve(ready);
  let p = inflight.get(fp);
  if (!p) {
    p = limited(() => decode(file, fp)).finally(() => inflight.delete(fp));
    inflight.set(fp, p);
  }
  return p;
}

async function decode(file: string, fp: string): Promise<string> {
  const dest = dataDir('Cache', 'PCM', `${fp}.wav`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const pcm = openPcmFile(file);
  pcm?.close();
  if (pcm && /\.(aiff?|aifc)$/i.test(file)) {
    // AIFF at another sample rate: resampled in the analysis process (Chromium cannot read AIFF).
    await request({ type: 'resample', file, dest: tmp, rate: MIX_RATE });
    fs.renameSync(tmp, dest);
    return dest;
  }
  const bytes = await fs.promises.readFile(file);
  const ctx = new OfflineAudioContext(2, 1, MIX_RATE);
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const w = new WavWriter(tmp, MIX_RATE, 16);
  const block = 1 << 16;
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    w.write(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  w.close();
  fs.renameSync(tmp, dest);
  return dest;
}
