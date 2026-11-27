// Sound and pictures in step in the exported files: exports a click track as WAV, MP4 (video) and, where the
// system has an AAC encoder, M4A, decodes them with ffmpeg and finds how far each file's sound is from the WAV's
// (cross-correlation, to the sample). The MP4's pictures are timed from the mix's time 0, so its sound must be too.
//
//   node tests/e2e/av-sync.cjs dev | <path to DJAW executable>
// Needs ffmpeg on the PATH. Exits 1 when a file is more than 2 ms off.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');

const root = path.join(__dirname, '..', '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-avsync-'));
const SR = 48000;

function clickTrack(file, seconds, bpm) {
  const sr = 44100, n = sr * seconds, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const beat = 60 / bpm;
  let seed = 3;
  for (let i = 0; i < n; i++) {
    const t = i / sr, b = Math.floor(t / beat), ph = t - b * beat;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = seed / 0x7fffffff * 2 - 1;
    // A kick and a sharp click on every beat, a little louder on the bar.
    const v = (Math.sin(2 * Math.PI * 55 * ph) * Math.exp(-ph * 18) * 0.7 + noise * Math.exp(-ph * 400) * 0.5) * (b % 4 === 0 ? 1 : 0.75)
      + Math.sin(2 * Math.PI * 330 * t) * 0.03;
    const s = Math.max(-1, Math.min(1, v)) * 30000 | 0;
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

const decode = file => {
  const raw = execFileSync('ffmpeg', ['-v', 'quiet', '-i', file, '-vn', '-map', '0:a', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
};

/** Samples by which `y` is later than `x` (search ±range), from a 3 s window starting at `from`. */
function lagOf(x, y, from, range) {
  const len = 3 * SR;
  const corr = d => { let c = 0; for (let i = 0; i < len; i += 1) { const j = from + i + d; if (j >= 0 && j < y.length) c += x[from + i] * y[j]; } return c; };
  let best = -Infinity, bestD = 0;
  for (let d = -range; d <= range; d += 8) { const c = corr(d); if (c > best) { best = c; bestD = d; } }
  const coarse = bestD;
  for (let d = coarse - 12; d <= coarse + 12; d++) { const c = corr(d); if (c > best) { best = c; bestD = d; } }
  return bestD;
}

(async () => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { console.log('ffmpeg not found: skipped'); process.exit(0); }
  const target = process.argv[2] ?? 'dev';
  const env = { ...process.env, DJAW_MUTE: '1', DJAW_USER_DATA: path.join(work, 'userdata') };
  const launch = target === 'dev'
    ? { executablePath: require(path.join(root, 'node_modules', 'electron')), args: [root], cwd: root, env }
    : { executablePath: target, args: [], env };
  if (process.platform === 'linux') launch.args.unshift('--no-sandbox');
  const track = path.join(work, 'Click 128.wav');
  clickTrack(track, 40, 128);
  const app = await _electron.launch({ ...launch, timeout: 120000 });
  const win = await app.firstWindow();
  const ev = (f, a) => win.evaluate(f, a);
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await win.evaluate(fn).catch(() => false)) return true; await win.waitForTimeout(500); } return false; };
  const results = [];
  let ok = true;
  try {
    await until(() => !!window.djaw && !!document.querySelector('.toolbar'), 60000);
    await ev(f => { void window.djaw.addFiles([f], { kind: 'mix', index: null }); }, track);
    if (!await until(() => window.djaw.pending.length === 0 && window.djaw.clips.length === 1 && window.djaw.clips.every(c => window.djaw.waveforms.get(c.url)), 300000)) throw new Error('track not ready');
    const run = async (file, start) => {
      await app.evaluate(({ ipcMain }, f) => { ipcMain.removeHandler('dialog:save'); ipcMain.handle('dialog:save', () => f); }, file);
      await ev(start);
      await until(() => window.djaw.exportPhase.kind === 'done' || window.djaw.exportPhase.kind === 'failed', 900000);
      const ph = await ev(() => window.djaw.exportPhase);
      await ev(() => { window.djaw.exportPhase = { kind: 'idle' }; window.djaw.changed(); });
      return ph;
    };
    await ev(() => { const s = window.djaw; s.exportSampleRate = 48000; s.exportNormalize = false; s.videoSize = '1280x720'; s.visualStyle = 'spectrum'; });
    const wav = path.join(work, 'ref.wav');
    const p0 = await run(wav, () => { window.djaw.exportFormat = 'wav24'; window.djaw.startExport(false); });
    if (p0.kind !== 'done') throw new Error('WAV export: ' + JSON.stringify(p0));
    const ref = decode(wav);
    const files = [['MP4 (video)', path.join(work, 'v.mp4'), () => window.djaw.startVideoExport()]];
    const aac = await ev(() => window.djaw.exportFormat !== undefined && typeof AudioEncoder !== 'undefined'
      ? AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 256000 }).then(r => !!r.supported, () => false) : false);
    if (aac) files.push(['M4A (AAC)', path.join(work, 'a.m4a'), () => { window.djaw.exportFormat = 'aac256'; window.djaw.startExport(false); }]);
    for (const [name, file, start] of files) {
      const ph = await run(file, start);
      if (ph.kind !== 'done') { ok = false; results.push({ name, failed: ph }); continue; }
      const y = decode(file);
      const lags = [4, 15, 30].map(t => lagOf(ref, y, t * SR, Math.round(0.2 * SR)));
      const stats = name.startsWith('MP4') ? await ev(() => window.djaw.lastVideoStats) : null;
      const probe = execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'stream=codec_type,codec_name,start_time,duration', '-of', 'compact=p=0', file]).toString().trim().split(/\r?\n/);
      const ms = lags.map(l => +(l / SR * 1000).toFixed(2));
      const good = lags.every(l => Math.abs(l) <= SR * 0.002);
      if (!good) ok = false;
      results.push({ name, lagMs: ms, encoderDelay: stats?.audioDelay, streams: probe, good });
      console.log(`${good ? 'ok  ' : 'FAIL'} ${name}: sound ${ms.join(' / ')} ms from the WAV${stats ? ` (encoder delay ${stats.audioDelay} samples)` : ''}  ${probe.join(' | ')}`);
    }
  } catch (e) { ok = false; console.log('FAIL', String(e)); }
  try { await ev(() => { window.djaw.isDirty = false; }); } catch { /* gone */ }
  await app.close().catch(() => {});
  fs.mkdirSync(path.join(root, 'e2e-out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'e2e-out', 'av-sync.json'), JSON.stringify(results, null, 1));
  fs.rmSync(work, { recursive: true, force: true });
  console.log(ok ? 'av sync: in step' : 'av sync FAILED');
  process.exit(ok ? 0 : 1);
})();
