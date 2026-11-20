// End-to-end smoke test of the real app (the packaged one on GitHub's Mac / Windows machines, or the source build):
// adds generated tracks, waits for the analysis, plays (muted — DJAW_MUTE=1) and measures that audio actually flows,
// separates stems, places a sampler hit and a loop, exports a WAV and checks it, saves and reopens the mix, checks the
// toolbar layout, and takes screenshots of every panel tab.
//
//   node tests/e2e/smoke.cjs dev                      # the source build (after `node scripts/build.mjs`)
//   node tests/e2e/smoke.cjs <path to DJAW executable> # a packaged app
// Results go to e2e-out/ (report.json + screenshots). Exits 1 when a check fails.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

const root = path.join(__dirname, '..', '..');
const out = path.join(root, 'e2e-out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-e2e-'));

// ---------- Generated audio ----------
function writeWav(file, sr, seconds, bpm, fill) {
  const n = Math.round(sr * seconds);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = fill(t, beat, rnd);
    const s = Math.max(-1, Math.min(1, v)) * 30000;
    buf.writeInt16LE(s | 0, 44 + i * 4); buf.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}
const track = (root) => (t, beat, rnd) => {
  const b = t / beat, ph = b - Math.floor(b);
  const kick = Math.sin(2 * Math.PI * 55 * ph * beat * (1 + 2 * Math.exp(-ph * beat * 30))) * Math.exp(-ph * beat * 9) * 0.9;
  const off = (b + 0.5) - Math.floor(b + 0.5);
  const hat = rnd() * Math.exp(-off * beat * 60) * 0.25;
  const bar = Math.floor(b / 4) % 4;
  const f = root * [1, 1.2, 0.89, 1.33][bar];
  const pad = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t)) * 0.12;
  return kick + hat + pad;
};
const files = [
  path.join(work, 'E2E Alpha 128.wav'),
  path.join(work, 'E2E Bravo 132.wav'),
  path.join(work, 'E2E Charlie 126 48k.wav'),
];
writeWav(files[0], 44100, 60, 128, track(220));
writeWav(files[1], 44100, 60, 132, track(196));
writeWav(files[2], 48000, 60, 126, track(247));
const horn = path.join(work, 'E2E Horn.wav');
writeWav(horn, 44100, 0.6, 120, t => Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 4) * 0.8);

function wavStats(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = { at: p + 8, size }; break; }
    p += 8 + size + (size & 1);
  }
  const bytes = fmt.bits / 8, frames = Math.floor(data.size / (bytes * fmt.channels));
  let sum = 0, peak = 0, count = 0;
  for (let i = 0; i < frames; i += 7) {
    const o = data.at + i * bytes * fmt.channels;
    const v = fmt.bits === 16 ? b.readInt16LE(o) / 32768 : fmt.bits === 24 ? b.readIntLE(o, 3) / 8388608 : b.readFloatLE(o);
    sum += v * v; count++; peak = Math.max(peak, Math.abs(v));
  }
  return { ...fmt, seconds: frames / fmt.rate, rms: Math.sqrt(sum / Math.max(1, count)), peak };
}

// ---------- Checks ----------
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

(async () => {
  const target = process.argv[2] ?? 'dev';
  const env = { ...process.env, DJAW_MUTE: '1', DJAW_USER_DATA: path.join(work, 'userdata') };
  const launch = target === 'dev'
    ? { executablePath: require(path.join(root, 'node_modules', 'electron')), args: [root], cwd: root, env }
    : { executablePath: target, args: [], env };
  if (process.platform === 'linux') launch.args.unshift('--no-sandbox');
  const app = await _electron.launch({ ...launch, timeout: 120000 });
  const errors = [];
  // The app's own output (the main process and the analysis processes write there).
  for (const [name, st] of [['stdout', app.process().stdout], ['stderr', app.process().stderr]]) st?.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => { if (!/dbus\/bus\.cc/.test(l)) console.log(`[app ${name}]`, l); }));
  const win = await app.firstWindow();
  win.on('pageerror', e => { errors.push('pageerror: ' + e.message); console.log('[pageerror]', e.stack); });
  win.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') { const t = m.text(); console.log(`[${m.type()}]`, t); if (m.type() === 'error') errors.push(t); } });
  const ev = (f, a) => win.evaluate(f, a);
  const until = async (fn, ms, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await win.evaluate(fn, arg).catch(() => false)) return true; await win.waitForTimeout(500); } return false; };
  const shot = name => win.screenshot({ path: path.join(out, name + '.png') }).catch(e => console.log('screenshot failed', e.message));
  const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; b.setContentSize(w, h); }, [w, h]);

  try {
    check('app starts', await until(() => !!window.djaw && !!document.querySelector('.toolbar'), 60000));
    check('platform', true, await app.evaluate(({ app }) => ({ platform: process.platform, arch: process.arch, version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron })));

    // Toolbar layout: everything inside the bar, nothing overlapping, at two window sizes.
    for (const [w, h] of [[1440, 900], [1280, 760], [1100, 700]]) {
      await setSize(w, h); await win.waitForTimeout(700);
      const lay = await ev(() => {
        const bar = document.querySelector('.toolbar').getBoundingClientRect();
        const kids = [...document.querySelectorAll('.toolbar > *, .tb-side > *, .transport > *, .toolbar .group > *')].filter(e => e.offsetParent);
        const boxes = kids.map(e => ({ c: e.className || e.tagName, r: e.getBoundingClientRect() }));
        const outside = boxes.filter(b => b.r.top < bar.top - 0.5 || b.r.bottom > bar.bottom + 0.5 || b.r.right > bar.right + 0.5 || b.r.left < bar.left - 0.5).map(b => b.c);
        const t = [...document.querySelectorAll('.transport > *')].map(e => e.getBoundingClientRect());
        const tr = document.querySelector('.transport').getBoundingClientRect();
        // Nothing in the transport overlaps, and nothing on either side runs into it.
        const sides = [...document.querySelectorAll('.tb-side > *, .toolbar .group > *')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect());
        const overlap = t.some((a, i) => t.some((b, j) => i < j && a.left < b.right - 0.5 && b.left < a.right - 0.5))
          || sides.some(r => r.left < tr.right - 0.5 && tr.left < r.right - 0.5);
        const centers = t.map(r => Math.round(r.top + r.height / 2));
        // The time text itself (not only its box) on the play button's centre line.
        const mid = e => { const r = document.querySelector(e)?.getBoundingClientRect(); return r ? r.top + r.height / 2 : null; };
        const textOff = Math.abs(mid('.transport .readout-main') - mid('.transport .tbtn.play'));
        // The transport in the middle of the window.
        const offCenter = Math.abs((tr.left + tr.width / 2) - (bar.left + bar.width / 2));
        return { barHeight: Math.round(bar.height), outside, overlap, transportH: Math.round(tr.height), misaligned: Math.max(...centers) - Math.min(...centers), textOff: Math.round(textOff * 10) / 10, offCenter: Math.round(offCenter), docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
      });
      check(`toolbar layout ${w}x${h}`, !lay.outside.length && !lay.overlap && lay.misaligned <= 2 && lay.textOff <= 2 && lay.offCenter <= 2 && !lay.docOverflow, lay);
    }
    await setSize(1440, 900); await win.waitForTimeout(500);
    await shot('01-empty');

    // Add tracks to the mix and wait for the analysis.
    await ev(f => window.djaw.addFiles(f, { kind: 'mix', index: null }), files);
    const analysed = await until(() => window.djaw.pending.length === 0 && window.djaw.clips.length === 3 && window.djaw.clips.every(c => window.djaw.waveforms.get(c.url)), 300000);
    const clips = await ev(() => window.djaw.clips.map(c => ({ title: c.title, bpm: c.bpm, beats: (window.djaw.beatTimes?.get?.(c.url) ?? []).length, start: c.start })));
    check('tracks added and analysed', analysed, analysed ? clips : await ev(() => ({ clips: window.djaw.clips.length, library: window.djaw.library.length, pending: window.djaw.pending, alert: window.djaw.alertMessage })));
    if (!analysed) throw new Error('no tracks: the rest cannot run');
    check('BPM detected (128 / 132 / 126)', analysed && [128, 132, 126].every((b, i) => Math.abs(clips[i].bpm - b) < 1.0), clips.map(c => c.bpm));
    await until(() => !window.djaw.structures || window.djaw.clips.every(c => window.djaw.structures.get(c.url)), 120000);
    await shot('02-mix');

    // Playback (muted): the audio has to actually flow.
    const play = await ev(async () => {
      const s = window.djaw;
      let blocks = 0, sum = 0, count = 0;
      s.player.onTap = mono => { blocks++; for (let i = 0; i < mono.length; i += 4) { sum += mono[i] * mono[i]; count++; } };
      await s.player.setTap(true);
      s.seek(s.clips[1].start + 4);
      const t0 = s.playhead;
      await s.play();
      await new Promise(r => setTimeout(r, 3500));
      const t1 = s.player.currentTime;
      const playing = s.isPlaying;
      s.pause();
      await s.player.setTap(false);
      const ctx = s.player.ctx;
      return { playing, advanced: t1 - t0, blocks, rms: Math.sqrt(sum / Math.max(1, count)), ctxState: ctx?.state, sampleRate: ctx?.sampleRate, outputLatency: ctx?.outputLatency };
    });
    check('playback: audio flows', play.playing && play.advanced > 2 && play.advanced < 5 && play.blocks > 10 && play.rms > 0.02, play);

    // Stems (ONNX in the stems process).
    const stems = await ev(async () => {
      const s = window.djaw;
      const c = s.clips[0];
      const t0 = Date.now();
      if (!s.stemsAvailable()) return { error: 'stem models not available' };
      s.prepareStems([c.url]);
      while (s.stemProgress.has(c.url) && Date.now() - t0 < 240000) await new Promise(r => setTimeout(r, 500));
      return { ok: !!s.stemsFor(c.url), seconds: (Date.now() - t0) / 1000, alert: s.alertMessage };
    });
    check('stem separation', stems.ok, stems);

    // Sampler + loop, then play across them.
    const edit = await ev(async f => {
      const s = window.djaw;
      await s.addSamples([f]);
      s.playhead = s.clips[0].start + 2;
      const hit = s.placeHit(s.samples[0].id);
      const c = s.clips[0];
      const loop = s.createEdit(c.id, 'loop', Math.round(c.mixInBar) + 4, 2, 1);
      return { samples: s.samples.length, hit: !!hit, loop: !!loop, duration: s.mixDuration };
    }, horn);
    check('sampler hit and loop', edit.samples === 1 && edit.hit && edit.loop, edit);
    for (const tab of ['mix', 'track', 'transition', 'cue', 'loop', 'fx', 'sampler', 'deck']) {
      await ev(([t, i]) => { const s = window.djaw; s.selectedClipID = s.clips[i].id; s.openPanel(t); }, [tab, tab === 'transition' ? 1 : 0]);
      await win.waitForTimeout(600);
      await shot('03-panel-' + tab);
    }
    const panelErrors = errors.length;
    check('panel tabs open without errors', panelErrors === 0, errors.slice(0, 5));

    // Export a WAV (the save dialog answers with a temp path).
    const wav = path.join(work, 'export.wav');
    await app.evaluate(({ ipcMain }, file) => { ipcMain.removeHandler('dialog:save'); ipcMain.handle('dialog:save', () => file); }, wav);
    await ev(() => { window.djaw.exportFormat = 'wav24'; window.djaw.exportSampleRate = 44100; window.djaw.startExport(true); });
    const exported = await until(() => window.djaw.exportPhase.kind === 'done' || window.djaw.exportPhase.kind === 'failed', 300000);
    const phase = await ev(() => window.djaw.exportPhase);
    const dur = await ev(() => window.djaw.mixDuration);
    let st = null;
    if (phase.kind === 'done' && fs.existsSync(wav)) st = wavStats(wav);
    check('export WAV', exported && phase.kind === 'done' && st && Math.abs(st.seconds - dur) < 0.5 && st.rms > 0.02 && st.peak <= 1.0, { phase, dur, st });
    await ev(() => { window.djaw.exportPhase = { kind: 'idle' }; window.djaw.showExport = false; window.djaw.changed(); });

    // M4A (AAC, through the system's encoder) and a video, on Windows and the Mac.
    if (process.platform !== 'linux') {
      const runExport = async (file, start) => {
        await app.evaluate(({ ipcMain }, f) => { ipcMain.removeHandler('dialog:save'); ipcMain.handle('dialog:save', () => f); }, file);
        const t0 = Date.now();
        await ev(start);
        await until(() => window.djaw.exportPhase.kind === 'done' || window.djaw.exportPhase.kind === 'failed', 900000);
        const ph = await ev(() => window.djaw.exportPhase);
        await ev(() => { window.djaw.exportPhase = { kind: 'idle' }; window.djaw.changed(); });
        const head = fs.existsSync(file) ? fs.readFileSync(file).subarray(4, 8).toString('latin1') : '';
        return { phase: ph.kind, message: ph.message, bytes: fs.existsSync(file) ? fs.statSync(file).size : 0, head, seconds: Math.round((Date.now() - t0) / 1000) };
      };
      const m4a = await runExport(path.join(work, 'export.m4a'), () => { window.djaw.exportFormat = 'aac256'; window.djaw.startExport(true); });
      // Windows Server (the CI machines) has no AAC encoder; the app then says so, which is the expected behaviour.
      const noAAC = m4a.phase === 'failed' && /AAC/.test(m4a.message ?? '');
      check(noAAC ? 'export M4A (AAC) — no AAC encoder on this machine, refused with a message' : 'export M4A (AAC)', noAAC || (m4a.phase === 'done' && m4a.head === 'ftyp' && m4a.bytes > 1e6), m4a);
      await ev(() => { window.djaw.exportFormat = 'wav24'; window.djaw.videoSize = '1280x720'; });
      const mp4 = await runExport(path.join(work, 'export.mp4'), () => window.djaw.startVideoExport());
      const stats = await ev(() => window.djaw.lastVideoStats);
      check('export video (MP4)', mp4.phase === 'done' && mp4.head === 'ftyp' && mp4.bytes > 1e6, { ...mp4, stats });
    }

    // Save, reopen, compare.
    const doc = path.join(work, 'e2e.djaw');
    const before = await ev(() => JSON.stringify(window.djaw.clips.map(c => [c.title, Math.round(c.start * 1000), c.edits?.length ?? 0])));
    const saved = await ev(async d => { const s = window.djaw; s.embedMedia = false; s.documentPath = d; return await s.save(false); }, doc);
    await ev(async d => { const s = window.djaw; s.isDirty = false; await s.load(d); }, doc);
    await until(() => window.djaw.clips.length === 3 && window.djaw.pending.length === 0, 60000);
    const after = await ev(() => JSON.stringify(window.djaw.clips.map(c => [c.title, Math.round(c.start * 1000), c.edits?.length ?? 0])));
    const samplerBack = await ev(() => [window.djaw.samples.length, window.djaw.sampleHits.length]);
    check('save and reopen', saved && before === after && samplerBack[0] === 1 && samplerBack[1] === 1, { before, after, samplerBack });

    // Undo / redo keep the mix consistent.
    const undo = await ev(() => { const s = window.djaw; const n = s.clips.length; s.selectedClipID = s.clips[2].id; s.deleteSelected(); const m = s.clips.length; s.undo(); const k = s.clips.length; return [n, m, k]; });
    check('delete and undo', undo[0] === 3 && undo[1] === 2 && undo[2] === 3, undo);

    // Play again after reopening (the stream starts from the saved state).
    const play2 = await ev(async () => {
      const s = window.djaw;
      let sum = 0, count = 0;
      s.player.onTap = mono => { for (let i = 0; i < mono.length; i += 4) { sum += mono[i] * mono[i]; count++; } };
      await s.player.setTap(true);
      s.seek(s.clips[2].start + 2); await s.play();
      await new Promise(r => setTimeout(r, 2000));
      const playing = s.isPlaying; s.pause(); await s.player.setTap(false);
      return { playing, rms: Math.sqrt(sum / Math.max(1, count)) };
    });
    check('playback after reopening', play2.playing && play2.rms > 0.02, play2);
    await shot('04-final');
    check('no errors in the window', errors.length === 0, errors.slice(0, 10));
  } catch (e) {
    check('test run', false, e.stack);
  } finally {
    await win.evaluate(() => { if (window.djaw) window.djaw.isDirty = false; }).catch(() => {});
    await app.close().catch(() => {});
    // Started with a .djaw as its argument (a file opened from the Explorer / Finder), with a fresh data folder:
    // the mix opens and plays while its tracks are still being analysed.
    const doc = path.join(work, 'e2e.djaw');
    if (fs.existsSync(doc)) {
      try {
        const env2 = { ...env, DJAW_USER_DATA: path.join(work, 'userdata2') };
        const app2 = await _electron.launch({ ...launch, args: [...launch.args, doc], env: env2, timeout: 120000 });
        const w2 = await app2.firstWindow();
        const errs2 = [];
        w2.on('console', m => { if (m.type() === 'error') errs2.push(m.text()); });
        const t0 = Date.now();
        while (Date.now() - t0 < 120000 && !(await w2.evaluate(() => !!window.djaw && window.djaw.clips.length === 3 && window.djaw.clips.every(c => window.djaw.pcmPaths.has(c.url))).catch(() => false))) await w2.waitForTimeout(500);
        const r = await w2.evaluate(async () => {
          const s = window.djaw;
          let sum = 0, count = 0;
          s.player.onTap = mono => { for (let i = 0; i < mono.length; i += 4) { sum += mono[i] * mono[i]; count++; } };
          await s.player.setTap(true);
          s.seek(s.clips[1].start + 3); await s.play();
          await new Promise(res => setTimeout(res, 2000));
          const playing = s.isPlaying; s.pause();
          return { clips: s.clips.length, playing, rms: Math.sqrt(sum / Math.max(1, count)), pending: s.pending.length, title: s.documentTitle };
        }).catch(e => ({ error: e.message }));
        check('open a .djaw given at start, play before the analysis ends', r.clips === 3 && r.playing && r.rms > 0.02 && !errs2.length, { ...r, seconds: (Date.now() - t0) / 1000, errors: errs2.slice(0, 3) });
        await w2.evaluate(() => { window.djaw.isDirty = false; }).catch(() => {});
        await app2.close().catch(() => {});
      } catch (e) { check('open a .djaw given at start', false, e.message); }
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 1));
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  }
})();
