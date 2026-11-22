// The FLAC encoder (src/core/flac.ts) must be lossless: decoded with ffmpeg, every sample is the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodeFlac } from '../src/core/flac';

let ffmpeg: string | null = null;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = 'ffmpeg'; } catch { /* not installed */ }

function signal(n: number, ch: number, bits: number) {
  const x = new Int32Array(n * ch);
  const amp = 2 ** (bits - 1) - 1;
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 - 0.5; };
  for (let i = 0; i < n; i++) {
    const s = Math.sin(i * 0.031) * 0.5 + Math.sin(i * 0.0071) * 0.3 + rnd() * 0.1;
    for (let c = 0; c < ch; c++) x[i * ch + c] = Math.max(-amp - 1, Math.min(amp, Math.round((c ? s * 0.8 + rnd() * 0.05 : s) * amp)));
    if (i > n * 0.6 && i < n * 0.65) for (let c = 0; c < ch; c++) x[i * ch + c] = 0; // silence (constant subframes)
  }
  return x;
}

for (const [bits, ch] of [[16, 2], [24, 2], [16, 1]] as const) {
  test(`FLAC ${bits}-bit ${ch}ch decodes to the same samples`, { skip: !ffmpeg }, () => {
    const n = 44100 * 3 + 123; // not a whole number of blocks
    const samples = signal(n, ch, bits);
    const flac = encodeFlac({ sampleRate: 44100, channels: ch, bitsPerSample: bits, samples });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-flac-'));
    const f = path.join(dir, 'a.flac');
    fs.writeFileSync(f, flac);
    const out = execFileSync(ffmpeg!, ['-loglevel', 'error', '-i', f, '-f', 's32le', '-'], { maxBuffer: 1 << 28 });
    fs.rmSync(dir, { recursive: true, force: true });
    const got = new Int32Array(out.buffer, out.byteOffset, out.byteLength / 4);
    assert.equal(got.length, samples.length);
    const shift = 32 - bits;
    for (let i = 0; i < samples.length; i++) if (got[i] >> shift !== samples[i]) assert.fail(`sample ${i}: ${got[i] >> shift} ≠ ${samples[i]}`);
    assert.ok(flac.length < samples.length * bits / 8, `${flac.length} bytes`);
  });
}
