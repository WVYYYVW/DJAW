// MP4 / M4A writing with WebCodecs (Chromium's AAC and H.264 encoders) and mp4-muxer (MIT): the M4A audio export
// and the video export. Runs in the render worker.
import fs from 'node:fs';
import { L } from '../i18n';
import { Muxer, StreamTarget } from 'mp4-muxer';

export interface Mp4Video { width: number; height: number; fps: number; bitrate: number }
export type Mp4Audio = 'aac' | 'opus';

export class Mp4Writer {
  private fd: number;
  private muxer: Muxer<StreamTarget>;
  private audio: AudioEncoder;
  private video: VideoEncoder | null = null;
  private samples = 0;
  private error: Error | null = null;

  private constructor(readonly path: string, readonly sampleRate: number, bitrate: number, video: Mp4Video | null, readonly audioCodec: Mp4Audio) {
    this.fd = fs.openSync(path, 'w');
    const fd = this.fd;
    this.muxer = new Muxer({
      target: new StreamTarget({ onData: (data, position) => { fs.writeSync(fd, data, 0, data.length, position); }, chunked: true }),
      audio: { codec: audioCodec, numberOfChannels: 2, sampleRate },
      video: video ? { codec: 'avc', width: video.width, height: video.height, frameRate: video.fps } : undefined,
      fastStart: false,
    });
    this.audio = new AudioEncoder({
      output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta),
      error: e => { this.error = e instanceof Error ? e : new Error(String(e)); },
    });
    this.audio.configure({ codec: audioCodec === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate, numberOfChannels: 2, bitrate });
    if (video) {
      this.video = new VideoEncoder({
        output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
        error: e => { this.error = e instanceof Error ? e : new Error(String(e)); },
      });
      this.video.configure({ codec: Mp4Writer.avcCodec(video), width: video.width, height: video.height, bitrate: video.bitrate, framerate: video.fps, avc: { format: 'avc' } });
    }
  }

  /** H.264 High profile at a level that fits the frame size. */
  static avcCodec(v: Mp4Video) { return v.width * v.height > 1920 * 1088 ? 'avc1.640033' : 'avc1.640028'; }

  /** Whether this computer can encode AAC (Chromium uses the system's encoder: Windows / macOS have one). */
  static async aacSupported(sampleRate: number, bitrate: number) {
    try { return !!(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate })).supported; } catch { return false; }
  }

  /** `audioCodec` 'opus' (48 kHz only) is the fallback for videos where AAC is not available. */
  static async create(path: string, sampleRate: number, bitrate: number, video: Mp4Video | null = null, audioCodec: Mp4Audio = 'aac') {
    if (audioCodec === 'aac' && !(await Mp4Writer.aacSupported(sampleRate, bitrate))) {
      throw new Error(L('このパソコンでは AAC（M4A）に書き出せません。WAV で書き出してください。', 'AAC (M4A) encoding is not available on this computer. Please export as WAV.'));
    }
    if (video) {
      const v = await VideoEncoder.isConfigSupported({ codec: Mp4Writer.avcCodec(video), width: video.width, height: video.height, bitrate: video.bitrate, framerate: video.fps });
      if (!v.supported) throw new Error(L('このパソコンでは H.264 の映像を書き出せません。', 'H.264 video encoding is not available on this computer.'));
    }
    return new Mp4Writer(path, sampleRate, bitrate, video, audioCodec);
  }

  private async drain(enc: { encodeQueueSize: number }) {
    while (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
    if (this.error) throw this.error;
  }

  async write(Lc: Float32Array, Rc: Float32Array, n: number, gain = 1) {
    if (n <= 0) return;
    const data = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      data[i] = Math.max(-1, Math.min(1, Lc[i] * gain));
      data[n + i] = Math.max(-1, Math.min(1, Rc[i] * gain));
    }
    const ad = new AudioData({ format: 'f32-planar', sampleRate: this.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(this.samples / this.sampleRate * 1e6), data });
    this.audio.encode(ad);
    ad.close();
    this.samples += n;
    await this.drain(this.audio);
  }

  async writeFrame(frame: VideoFrame, keyFrame: boolean) {
    if (!this.video) return;
    this.video.encode(frame, { keyFrame });
    frame.close();
    await this.drain(this.video);
  }

  async close() {
    try {
      await this.audio.flush();
      if (this.video) await this.video.flush();
      if (this.error) throw this.error;
      this.muxer.finalize();
    } finally {
      try { this.audio.close(); } catch { /* closed */ }
      try { this.video?.close(); } catch { /* closed */ }
      fs.closeSync(this.fd);
    }
  }

  /** On cancel / failure. */
  abort() {
    try { this.audio.close(); } catch { /* closed */ }
    try { this.video?.close(); } catch { /* closed */ }
    try { fs.closeSync(this.fd); } catch { /* closed */ }
  }
}
