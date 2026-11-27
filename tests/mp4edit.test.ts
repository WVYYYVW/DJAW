// The edit list that makes players skip the AAC encoder's silence (src/core/render/mp4edit.ts): an MP4 written by
// mp4-muxer from real AAC frames (ffmpeg's encoder, 1024 samples of delay), patched, and decoded again with ffmpeg —
// the click must come back exactly where it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { addAudioEditList, audioEditList, delayOf } from '../src/core/render/mp4edit';

let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* not installed */ }

const SR = 48000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-mp4edit-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** An MP4 from ADTS AAC frames (mp4-muxer, no fast start), optionally with a video track of `frames` fake frames. */
function mux(adts: Buffer, file: string, frames = 0) {
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: SR },
    video: frames ? { codec: 'avc', width: 64, height: 64 } : undefined,
    fastStart: false,
  });
  const description = new Uint8Array([0x11, 0x90]); // AAC LC, 48 kHz, stereo
  let p = 0, k = 0;
  while (p + 7 <= adts.length) {
    const len = ((adts[p + 3] & 3) << 11) | (adts[p + 4] << 3) | (adts[p + 5] >> 5);
    const head = (adts[p + 1] & 1) ? 7 : 9;
    muxer.addAudioChunkRaw(adts.subarray(p + head, p + len), 'key', Math.round(k * 1024 / SR * 1e6), Math.round(1024 / SR * 1e6),
      k === 0 ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, description } } : undefined);
    p += len; k++;
  }
  const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0]);
  for (let f = 0; f < frames; f++) {
    muxer.addVideoChunkRaw(new Uint8Array([0, 0, 0, 1, 0x65]), f === 0 ? 'key' : 'delta', Math.round(f * 1e6 / 30), Math.round(1e6 / 30),
      f === 0 ? { decoderConfig: { codec: 'avc1.640028', codedWidth: 64, codedHeight: 64, description: avcC } } : undefined);
  }
  muxer.finalize();
  fs.writeFileSync(file, Buffer.from(muxer.target.buffer));
}

/** A click in silence, at `at` samples. */
function clickWav(file: string, at: number, seconds = 1) {
  const n = SR * seconds, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  const pattern = new Float32Array(480);
  let seed = 7;
  for (let i = 0; i < 480; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    pattern[i] = ((seed / 2 ** 32) * 2 - 1) * 0.6 * Math.sin(Math.PI * i / 480);
    const s = Math.round(pattern[i] * 32767);
    b.writeInt16LE(s, 44 + (at + i) * 4); b.writeInt16LE(s, 46 + (at + i) * 4);
  }
  fs.writeFileSync(file, b);
  return pattern;
}

const decode = (file: string) => {
  const raw = execFileSync('ffmpeg', ['-v', 'quiet', '-i', file, '-vn', '-map', '0:a', '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
};

test('the edit list puts the audio back at time 0 (ffmpeg decodes it in place)', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const at = 9600;
  const pattern = clickWav(path.join(dir, 'click.wav'), at);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, 'click.wav'), '-c:a', 'aac', '-b:a', '256k', '-f', 'adts', path.join(dir, 'click.aac')]);
  const adts = fs.readFileSync(path.join(dir, 'click.aac'));
  for (const frames of [0, 30]) {
    const file = path.join(dir, `click${frames}.mp4`);
    mux(adts, file, frames);
    const before = delayOf(pattern, decode(file), at, 4000);
    assert.ok(before >= 1000, `without the edit list the click is late (ffmpeg's encoder delay): ${before}`);
    assert.equal(addAudioEditList(file, before, SR), true);
    const after = delayOf(pattern, decode(file), at, 4000);
    assert.ok(Math.abs(after) <= 2, `with it the click is in place: ${after} samples`);
    const e = audioEditList(file);
    assert.ok(e && e[1] === before, JSON.stringify(e));
    // Written once only.
    assert.equal(addAudioEditList(file, before, SR), false);
    if (frames) {
      // The video track is still there and readable.
      const probe = execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]).toString();
      assert.match(probe, /video/);
    }
  }
});

test('no edit list for no delay', () => {
  const file = path.join(dir, 'none.mp4');
  fs.writeFileSync(file, Buffer.alloc(0));
  assert.equal(addAudioEditList(file, 0, SR), false);
});
