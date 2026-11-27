// Video export (mac/DJAW/Media/VideoExporter.swift): the exported audio plus visuals drawn frame by frame from the mix
// itself — its spectrum and levels, the beat grid, the tracks' colours and artwork, and a card with title / artist
// whenever a new track takes over. Runs in the render worker (WebCodecs H.264 + AAC, mp4-muxer).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CancelFlag, Cancelled, exportWav, MixInput, normalizeGain } from './offline';
import { Mp4Writer } from './mp4';
import { ExportFeatures, TrackVisual, VisualOptions, VisualPainter, VisualSection, artworkPalette } from '../visuals';

/** A track as sent to the worker (artwork as image file bytes). */
export interface TrackVisualMessage {
  title: string; artist: string; artwork: Uint8Array | null; hue: number;
  start: number; landing: number; end: number; sections: VisualSection[];
}

export interface VideoExportOptions extends VisualOptions { sampleRate: number; normalize: boolean }

/** The temporary float WAV the audio pass writes, read back in pieces. */
class FloatWavReader {
  private fd: number;
  readonly frames: number;
  constructor(file: string) {
    this.fd = fs.openSync(file, 'r');
    this.frames = Math.floor((fs.fstatSync(this.fd).size - 44) / 8);
  }
  /** Interleaved stereo frames [from, from + n), zero outside the file. */
  read(from: number, n: number): Float32Array {
    const out = new Float32Array(n * 2);
    const a = Math.max(0, from), b = Math.min(this.frames, from + n);
    if (b > a) {
      const buf = Buffer.alloc((b - a) * 8);
      fs.readSync(this.fd, buf, 0, buf.length, 44 + a * 8);
      out.set(new Float32Array(buf.buffer, buf.byteOffset, (b - a) * 2), (a - from) * 2);
    }
    return out;
  }
  close() { try { fs.closeSync(this.fd); } catch { /* closed */ } }
}

async function decodeArtwork(bytes: Uint8Array | null) {
  if (!bytes || !bytes.length) return null;
  try { return await createImageBitmap(new Blob([bytes as BlobPart])); } catch { return null; }
}

/** Seconds spent in each stage (shown in the console after an export, to see where the time goes). */
export interface VideoExportStats { audio: number; features: number; draw: number; frame: number; encodeWait: number; audioEncode: number; frames: number; total: number; hardware: number; /** Samples of encoder delay skipped with an edit list. */ audioDelay: number }

export async function exportVideo(m: MixInput, dest: string, o: VideoExportOptions, trackMsgs: TrackVisualMessage[],
  cancel: CancelFlag, progress: (p: number) => void, knownPeak?: number | null, stats?: VideoExportStats): Promise<void> {
  const st0 = performance.now();
  const lap = (() => { let t = performance.now(); return () => { const n = performance.now(); const d = (n - t) / 1000; t = n; return d; }; })();
  const tmp = path.join(os.tmpdir(), `DJAW-video-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  // AAC 320 kbps like the Mac; where the system has no AAC encoder, Opus (48 kHz) instead.
  const aac = await Mp4Writer.aacSupported(o.sampleRate || m.sampleRate, 320_000);
  const rate = aac ? o.sampleRate || m.sampleRate : 48000;
  const out: { writer: Mp4Writer | null } = { writer: null };
  let wav: FloatWavReader | null = null;
  let ok = false;
  try {
    // 1. The audio, rendered once at full level; normalizing is applied while encoding (the same result as the audio
    // export's second pass, without rendering the mix twice). The visuals don't depend on the level.
    const peak = await exportWav(m, tmp, { sampleRate: rate, normalize: false, bits: 32, raw: true }, cancel, p => progress(p * 0.35));
    const gain = o.normalize ? normalizeGain(knownPeak ?? peak) : 1;
    if (cancel.cancelled) throw new Cancelled();
    if (stats) stats.audio = lap();

    // 2. What the music does in every video frame.
    wav = new FloatWavReader(tmp);
    const r = wav;
    const piece = 1 << 20;
    const mono = new Float32Array(r.frames);
    for (let pos = 0; pos < r.frames; pos += piece) {
      const n = Math.min(piece, r.frames - pos);
      const st = r.read(pos, n);
      for (let i = 0; i < n; i++) mono[pos + i] = (st[i * 2] + st[i * 2 + 1]) * 0.5;
      if (cancel.cancelled) throw new Cancelled();
    }
    const features = new ExportFeatures((from, n) => {
      const out = new Float32Array(n);
      const a = Math.max(0, from), b = Math.min(mono.length, from + n);
      if (b > a) out.set(mono.subarray(a, b), a - from);
      return out;
    }, mono.length, rate, o.fps, p => progress(0.35 + 0.05 * p));
    if (cancel.cancelled) throw new Cancelled();
    progress(0.4);
    if (stats) stats.features = lap();

    // 3. Draw and encode.
    const tracks: TrackVisual[] = [];
    for (const t of trackMsgs) {
      const art = await decodeArtwork(t.artwork);
      tracks.push({ title: t.title, artist: t.artist, artwork: art, hue: t.hue, start: t.start, landing: t.landing, end: t.end,
        sections: t.sections, palette: artworkPalette(art) });
    }
    const bitrate = o.width * o.height >= 1920 * 1080 ? 14_000_000 : 8_000_000;
    // The whole picture stage, on the GPU's encoder if there is one; if that fails part-way (a driver problem),
    // once more with the software encoder.
    const encode = async (hardware: boolean) => {
      out.writer = await Mp4Writer.create(dest, rate, aac ? 320_000 : 256_000, { width: o.width, height: o.height, fps: o.fps, bitrate, hardware }, aac ? 'aac' : 'opus');
      const w = out.writer;
      if (stats) { stats.hardware = w.hardware ? 1 : 0; stats.audioDelay = w.audioDelay; }
      const painter = new VisualPainter(o, tracks, features, m.tempo, m.gridOffset, m.master);
      const total = features.frames;
      const audioPiece = 4096;
      let audioPos = 0;
      const audioUntil = async (until: number) => {
        while (audioPos < until) {
          const n = Math.min(audioPiece, until - audioPos);
          const st = r.read(audioPos, n);
          const Lc = new Float32Array(n), Rc = new Float32Array(n);
          for (let i = 0; i < n; i++) { Lc[i] = st[i * 2]; Rc[i] = st[i * 2 + 1]; }
          await w.write(Lc, Rc, n, gain);
          audioPos += n;
        }
      };
      for (let f = 0; f < total; f++) {
        if (cancel.cancelled) throw new Cancelled();
        painter.draw(f);
        if (stats) stats.draw += lap();
        // Straight from the canvas: on the GPU this hands the encoder the drawn picture without copying it to memory.
        const frame = new VideoFrame(painter.canvas, { timestamp: Math.round(f * 1e6 / o.fps), duration: Math.round(1e6 / o.fps) });
        if (stats) stats.frame += lap();
        await w.writeFrame(frame, f % (o.fps * 2) === 0);
        if (stats) stats.encodeWait += lap();
        // Keep the audio a little ahead of the picture (the muxer interleaves the two).
        await audioUntil(Math.min(r.frames, Math.round(((f + 1) / o.fps + 1) * rate)));
        if (stats) stats.audioEncode += lap();
        if (f % 30 === 0) progress(0.4 + 0.6 * f / Math.max(1, total));
      }
      await audioUntil(r.frames);
      await w.close();
      if (stats) stats.frames = total;
    };
    try {
      await encode(true);
    } catch (e) {
      if (e instanceof Cancelled || cancel.cancelled || !out.writer?.hardware) throw e;
      console.warn('[DJAW] hardware video encoder failed, using the software encoder:', (e as Error).message);
      out.writer?.abort();
      out.writer = null;
      await encode(false);
    }
    ok = true;
    if (stats) stats.total = (performance.now() - st0) / 1000;
    progress(1);
  } finally {
    if (!ok) out.writer?.abort();
    wav?.close();
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}
