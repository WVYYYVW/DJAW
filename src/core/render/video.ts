// Video export (mac/DJAW/Media/VideoExporter.swift): the exported audio plus visuals drawn frame by frame from the mix
// itself — its spectrum and levels, the beat grid, the tracks' colours and artwork, and a card with title / artist
// whenever a new track takes over. Runs in the render worker (WebCodecs H.264 + AAC, mp4-muxer).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CancelFlag, Cancelled, exportWav, MixInput } from './offline';
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

export async function exportVideo(m: MixInput, dest: string, o: VideoExportOptions, trackMsgs: TrackVisualMessage[],
  cancel: CancelFlag, progress: (p: number) => void, knownPeak?: number | null): Promise<void> {
  const tmp = path.join(os.tmpdir(), `DJAW-video-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  // AAC 320 kbps like the Mac; where the system has no AAC encoder, Opus (48 kHz) instead.
  const aac = await Mp4Writer.aacSupported(o.sampleRate || m.sampleRate, 320_000);
  const rate = aac ? o.sampleRate || m.sampleRate : 48000;
  let writer: Mp4Writer | null = null;
  let wav: FloatWavReader | null = null;
  let ok = false;
  try {
    // 1. The audio, exactly as the audio export renders it.
    await exportWav(m, tmp, { sampleRate: rate, normalize: o.normalize, bits: 32, format: 'wav24' }, cancel, p => progress(p * 0.35), knownPeak);
    if (cancel.cancelled) throw new Cancelled();

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

    // 3. Draw and encode.
    const tracks: TrackVisual[] = [];
    for (const t of trackMsgs) {
      const art = await decodeArtwork(t.artwork);
      tracks.push({ title: t.title, artist: t.artist, artwork: art, hue: t.hue, start: t.start, landing: t.landing, end: t.end,
        sections: t.sections, palette: artworkPalette(art) });
    }
    const bitrate = o.width * o.height >= 1920 * 1080 ? 14_000_000 : 8_000_000;
    writer = await Mp4Writer.create(dest, rate, aac ? 320_000 : 256_000, { width: o.width, height: o.height, fps: o.fps, bitrate }, aac ? 'aac' : 'opus');
    const painter = new VisualPainter(o, tracks, features, m.tempo, m.gridOffset, m.master);
    const total = features.frames;
    const audioPiece = 4096;
    let audioPos = 0;
    for (let f = 0; f < total; f++) {
      if (cancel.cancelled) throw new Cancelled();
      painter.draw(f);
      const frame = new VideoFrame(painter.canvas, { timestamp: Math.round(f * 1e6 / o.fps), duration: Math.round(1e6 / o.fps) });
      await writer.writeFrame(frame, f % (o.fps * 2) === 0);
      // Keep the audio a little ahead of the picture (the muxer interleaves the two).
      const until = Math.min(r.frames, Math.round(((f + 1) / o.fps + 1) * rate));
      while (audioPos < until) {
        const n = Math.min(audioPiece, until - audioPos);
        const st = r.read(audioPos, n);
        const Lc = new Float32Array(n), Rc = new Float32Array(n);
        for (let i = 0; i < n; i++) { Lc[i] = st[i * 2]; Rc[i] = st[i * 2 + 1]; }
        await writer.write(Lc, Rc, n);
        audioPos += n;
      }
      if (f % 30 === 0) progress(0.4 + 0.6 * f / Math.max(1, total));
    }
    while (audioPos < r.frames) {
      const n = Math.min(audioPiece, r.frames - audioPos);
      const st = r.read(audioPos, n);
      const Lc = new Float32Array(n), Rc = new Float32Array(n);
      for (let i = 0; i < n; i++) { Lc[i] = st[i * 2]; Rc[i] = st[i * 2 + 1]; }
      await writer.write(Lc, Rc, n);
      audioPos += n;
    }
    await writer.close();
    ok = true;
    progress(1);
  } finally {
    if (!ok) writer?.abort();
    wav?.close();
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}
