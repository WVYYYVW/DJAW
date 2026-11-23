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
const delta = path.join(work, 'E2E Delta 130.wav');
writeWav(delta, 44100, 60, 130, track(165));
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
  win.on('pageerror', e => {
    // Closing the video preview window (a window.open child) sometimes makes V8 report a bare "illegal access" (no
    // name, no stack) outside the app's own script world: the window's own error / unhandledrejection listeners never
    // see it, and nothing in the app is affected. Logged, not counted.
    if (e.message === 'illegal access' && !e.name && !e.stack) { console.log('[pageerror, ignored]', e.message); return; }
    errors.push('pageerror: ' + e.message); console.log('[pageerror]', e.name, e.message, e.stack);
  });
  win.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') { const t = m.text(); console.log(`[${m.type()}]`, t); if (m.type() === 'error') errors.push(t); } });
  const ev = (f, a) => win.evaluate(f, a);
  const until = async (fn, ms, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await win.evaluate(fn, arg).catch(() => false)) return true; await win.waitForTimeout(500); } return false; };
  const shot = name => win.screenshot({ path: path.join(out, name + '.png') }).catch(e => console.log('screenshot failed', e.message));
  // Plays (muted) `secs` seconds from timeline time t and returns the RMS of what came out.
  const measure = (t, secs = 1.5) => win.evaluate(async ([t, secs]) => {
    const s = window.djaw;
    let sum = 0, count = 0;
    s.player.onTap = mono => { for (let i = 0; i < mono.length; i += 4) { sum += mono[i] * mono[i]; count++; } };
    await s.player.setTap(true);
    s.seek(t); await s.play();
    await new Promise(r => setTimeout(r, secs * 1000));
    const playing = s.isPlaying; s.pause(); await s.player.setTap(false);
    return { playing, rms: Math.sqrt(sum / Math.max(1, count)) };
  }, [t, secs]);
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
    // Icons in the middle of their buttons (an icon-only button: its centre; next to text: the text's height).
    const icons = await ev(() => {
      const bad = [];
      for (const svg of document.querySelectorAll('svg.icon')) {
        const host = svg.closest('button');
        if (!host || !svg.getClientRects().length) continue;
        const sr = svg.getBoundingClientRect(), hr = host.getBoundingClientRect();
        const b = svg.getBBox(), k = sr.width / 16;
        const ix = sr.left + (b.x + b.width / 2) * k, iy = sr.top + (b.y + b.height / 2) * k;
        const hasText = host.textContent.trim().length > 0;
        const dx = hasText ? 0 : ix - (hr.left + hr.width / 2), dy = iy - (hr.top + hr.height / 2);
        if (Math.abs(dx) > 1.2 || Math.abs(dy) > 1.6) bad.push({ c: String(host.className).slice(0, 24), dx: +dx.toFixed(1), dy: +dy.toFixed(1) });
      }
      return bad;
    });
    check('icons centred in their buttons', icons.length === 0, icons.slice(0, 6));
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

    // Tempo change that starts after the transition (vs. with it): the ramp starts transitionBars bars later.
    const tempo = await ev(() => {
      const s = window.djaw, c = s.clips[2];
      s.setTransitionLength(c.id, 8);
      const rampStart = () => { const p = s.tempoMap.points; const i = p.findIndex((x, k) => k + 1 < p.length && Math.abs(p[k + 1].bpm - x.bpm) > 1e-6); return i < 0 ? null : p[i].t; };
      s.setTempoChange(c.id, true);
      const after = rampStart(), start = s.clip(c.id).tempoStart, bars = s.clip(c.id).tempoBars, tb = s.clip(c.id).transitionBars, cut = /cut|echo|brake|spin/i.test(s.clip(c.id).transition);
      s.setTempoStart(c.id, null);
      const withIt = rampStart();
      s.setTempoStart(c.id, 'afterTransition');
      return { start, bars, transitionBars: tb, cut, after, withIt, master: s.masterBPM, lastBPM: s.tempoMap.bpm(s.mixDuration - 1), own: c.bpm };
    });
    const expectGap = tempo.cut ? 0 : tempo.transitionBars * 240 / tempo.master;
    check('tempo change starts after the transition', tempo.start === 'afterTransition' && tempo.after != null && tempo.withIt != null
      && Math.abs((tempo.after - tempo.withIt) - expectGap) < 0.05 && Math.abs(tempo.lastBPM - tempo.own) < 0.05, { ...tempo, expectGap });

    // A layered track (deck C) on the second mix track: it is heard on top of it.
    await ev(f => window.djaw.addFiles([f], { kind: 'library' }), delta);
    await until(() => window.djaw.pending.length === 0 && window.djaw.library.some(t => t.title === 'E2E Delta 130'), 120000);
    const layer = await ev(() => {
      const s = window.djaw, host = s.clips[1];
      const track = s.library.find(t => t.title === 'E2E Delta 130') ?? s.clips.find(t => t.title === 'E2E Delta 130');
      const id = track ? s.addLayer(host.id, track.id) : null;
      const l = id ? s.layers.find(x => x.id === id) : null;
      // Timeline time of the host's bar layerBar + 2 (the layer has faded in by then).
      let t = null;
      if (l) for (let x = host.start; x < host.start + 400; x += 0.02) { const b = s.sourceBar(host.id, x); if (b != null && b >= l.layerBar + 2) { t = x; break; } }
      return { id, deck: id ? s.layerDeck(id) : null, layers: s.layers.length, t, duration: s.mixDuration };
    });
    let layerHeard = null;
    if (layer.id && layer.t != null) {
      const withLayer = await measure(layer.t);
      await ev(() => window.djaw.undo());
      const without = await measure(layer.t);
      await ev(() => window.djaw.redo());
      layerHeard = { with: +withLayer.rms.toFixed(4), without: +without.rms.toFixed(4), layersAfterRedo: await ev(() => window.djaw.layers.length) };
    }
    check('layered track plays on deck C', layer.id && layer.deck === 2 && layerHeard && layerHeard.with > layerHeard.without * 1.1 && layerHeard.layersAfterRedo === 1, { ...layer, ...layerHeard });
    // DJAW's own sounds (assets/samples, unpacked from the app): one onto a free pad, decoded and playable.
    await ev(() => window.djaw.addBuiltinSamples(['laser.wav', 'gabber-kick.wav']));
    const builtin = await until(() => window.djaw.samples.length === 3 && window.djaw.samples.every(x => window.djaw.samplePcm.has(x.id)), 30000);
    const kit = await ev(() => window.djaw.samples.map(x => ({ name: x.name, ok: window.djaw.samplePcm.has(x.id), seconds: window.djaw.samplePcm.get(x.id)?.seconds })));
    check('built-in sampler sounds', builtin && kit.slice(1).every(k => k.ok && k.seconds > 0.3), kit);
    // An effect on the first track, so the FX tab and the overview have something to show.
    await ev(() => { const s = window.djaw; s.addFX(s.clips[0].id, 'lowPass', Math.round(s.clips[0].mixInBar) + 2, 4); });
    for (const tab of ['overview', 'mix', 'track', 'transition', 'cue', 'loop', 'fx', 'sampler', 'deck']) {
      await ev(([t, i]) => { const s = window.djaw; s.selectedClipID = s.clips[i].id; s.openPanel(t); }, [tab, tab === 'transition' ? 1 : 0]);
      await win.waitForTimeout(600);
      await shot('03-panel-' + tab);
    }
    const panelErrors = errors.length;
    check('panel tabs open without errors', panelErrors === 0, errors.slice(0, 5));
    // Transition editor: selecting a point (a click on empty space adds and selects one) must not move the lanes.
    await ev(() => { const s = window.djaw; s.setTransitionLength(s.clips[1].id, 8); s.selectedClipID = s.clips[1].id; s.openPanel('transition'); });
    await win.waitForTimeout(800);
    const laneTop = () => ev(() => { const c = document.querySelector('canvas.lane-canvas'); return c ? Math.round(c.getBoundingClientRect().top) : null; });
    const lr = await ev(() => { const c = document.querySelector('canvas.lane-canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    let laneJump = null;
    if (lr) {
      const before = await laneTop();
      await win.mouse.click(lr[0] + 10 + 0.37 * (lr[2] - 20), lr[1] + lr[3] * 0.2);
      await win.waitForTimeout(300);
      const selected = await laneTop();
      await win.keyboard.press('Escape');
      await win.waitForTimeout(300);
      laneJump = { before, selected, after: await laneTop() };
      await ev(() => { window.djaw.undo(); window.djaw.undo(); });
    }
    check('transition editor lanes stay put when a point is selected', !!laneJump && laneJump.before === laneJump.selected && laneJump.selected === laneJump.after, laneJump);
    // A transition still in its preset state: its points can be deleted (double-click, and select + Delete).
    const undoDepth = await ev(() => window.djaw.undoStack.length);
    await ev(() => { const s = window.djaw; s.setTransitionLength(s.clips[1].id, 8); s.setTransitionStyle(s.clips[1].id, 'bassSwap'); s.selectedClipID = s.clips[1].id; s.openPanel('transition'); });
    await win.waitForTimeout(800);
    // A middle point of the low lane (the 4th): where the cursor turns into a hand, away from the ends.
    const lowLane = () => ev(() => { const c = document.querySelectorAll('canvas.lane-canvas')[3]; if (!c) return null; c.scrollIntoView({ block: 'center' }); const b = c.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; });
    const findMiddlePoint = async () => {
      const r = await lowLane();
      if (!r) return null;
      for (let x = r[0] + 40; x < r[0] + r[2] - 40; x += 4) {
        for (let y = r[1] + 4; y <= r[1] + r[3] - 4; y += 4) {
          await win.mouse.move(x, y);
          if (await ev(() => document.querySelectorAll('canvas.lane-canvas')[3].style.cursor) === 'grab') return [x, y];
        }
      }
      return null;
    };
    // Points of the edited lane once the transition is hand-drawn (custom).
    const lanePoints = () => ev(() => { const c = window.djaw.clips[1]; return c.transition === 'custom' && c.lanes ? (c.lanes.inLow ?? []).length : null; });
    const presetDelete = {};
    const p0 = await findMiddlePoint();
    if (p0) {
      // All points, as drawn: nudge the point up and back down (makes the transition hand-drawn, nothing removed).
      await win.mouse.click(p0[0], p0[1]); await win.waitForTimeout(250);
      await ev(() => { const b = document.querySelectorAll('.te-sel .stepbtns')[1]?.querySelectorAll('button'); b?.[1].click(); b?.[0].click(); });
      await win.waitForTimeout(250);
      presetDelete.all = await lanePoints();
      await ev(() => { const s = window.djaw; s.undo(); s.undo(); });
      await win.waitForTimeout(400);
      // Double-click the point.
      await win.mouse.click(p0[0], p0[1]); await win.waitForTimeout(80); await win.mouse.click(p0[0], p0[1]);
      await win.waitForTimeout(400);
      presetDelete.afterDouble = await lanePoints();
      await ev(() => window.djaw.undo());
      await win.waitForTimeout(400);
      // Select it, then Delete.
      await win.mouse.click(p0[0], p0[1]); await win.waitForTimeout(300);
      await win.keyboard.press('Delete'); await win.waitForTimeout(400);
      presetDelete.afterKey = await lanePoints();
    }
    await ev(d => { const s = window.djaw; while (s.undoStack.length > d) s.undo(); }, undoDepth);
    check('points of a preset transition can be deleted', presetDelete.all > 2 && presetDelete.afterDouble === presetDelete.all - 1 && presetDelete.afterKey === presetDelete.all - 1, presetDelete);
    // The video preview window fills its window when that is enlarged (maximized with the title bar's button).
    const previewFill = { opened: false };
    try {
      await ev(() => { window.djaw.showVisualPreview = true; window.djaw.changed(); });
      const t0 = Date.now();
      let pv = null;
      while (!pv && Date.now() - t0 < 10000) { pv = app.windows().find(p => p !== win); if (!pv) await win.waitForTimeout(200); }
      if (pv) {
        previewFill.opened = true;
        await app.evaluate(({ BrowserWindow }) => { for (const b of BrowserWindow.getAllWindows()) if (b.webContents.getURL() === 'about:blank') b.setContentSize(1600, 1000); });
        await pv.waitForTimeout(1200);
        Object.assign(previewFill, await pv.evaluate(() => { const c = document.querySelector('canvas'); return c ? { shownW: Math.round(c.clientWidth), shownH: Math.round(c.clientHeight), drawW: c.width, winW: innerWidth } : {}; }));
      }
      await ev(() => { window.djaw.showVisualPreview = false; window.djaw.changed(); });
    } catch (e) { previewFill.error = String(e); }
    check('video preview fills an enlarged window', previewFill.opened && previewFill.shownW >= previewFill.winW - 2 && previewFill.drawW === 1920, previewFill);
    // The panel maximized (the arrangement hidden), the overview drawn, the tabs without sideways scrolling.
    await ev(() => { window.djaw.openPanel('overview'); window.djaw.togglePanelMaximized(true); });
    await win.waitForTimeout(800);
    await shot('03-overview-maximized');
    const big = await ev(() => {
      const arr = document.querySelector('.arrangement');
      const c = document.querySelector('.overview-canvas canvas');
      let ink = 0;
      if (c && c.width) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let k = 3; k < d.length; k += 64) if (d[k] > 0) ink++; }
      return { hidden: !!arr && getComputedStyle(arr).display === 'none', panel: Math.round(document.querySelector('.detail-panel').getBoundingClientRect().height), window: innerHeight, ink };
    });
    const sideways = [];
    for (const tab of ['track', 'mix', 'fx']) {
      await ev(t => window.djaw.openPanel(t), tab);
      await win.waitForTimeout(400);
      if (await ev(() => { const b = document.querySelector('.panel-body'); return b.scrollWidth > b.clientWidth + 1; })) sideways.push(tab);
    }
    await ev(() => window.djaw.togglePanelMaximized(false));
    await win.waitForTimeout(400);
    const back = await ev(() => getComputedStyle(document.querySelector('.arrangement')).display !== 'none' && document.querySelector('.timeline-area').clientHeight > 100);
    check('panel maximize, overview, no sideways scrolling', big.hidden && big.panel > big.window * 0.8 && big.ink > 200 && !sideways.length && back && errors.length === panelErrors, { ...big, sideways, back });

    // Every language: no Japanese left on screen (kana anywhere; kanji too outside Chinese), and no English text
    // that the language's table translates. (Discogs style names, `.style-row`, are a fixed English taxonomy.)
    // Covers every panel tab, the sheets, and the right-click menus (with their submenus), with names that DJAW
    // stored in Japanese in older versions (a pad "サイレン", a folder, a take, a "My Transition").
    const tables = Object.fromEntries(['english', 'de', 'fr', 'es', 'it', 'pt', 'ko', 'zh-Hans', 'zh-Hant', 'ru'].map(l => [l, l === 'english' ? {} : JSON.parse(fs.readFileSync(path.join(root, 'src/core/locales', l + '.json'), 'utf8'))]));
    const sendMenu = (cmd, arg) => app.evaluate(({ BrowserWindow }, [c, a]) => BrowserWindow.getAllWindows()[0].webContents.send('menu', c, a), [cmd, arg]);
    const seeded = await ev(() => {
      const s = window.djaw, c0 = s.clips[0], c1 = s.clips[1];
      const builtin = s.samples.find(x => /[\\/]assets[\\/]samples[\\/]/.test(x.url));
      let pad = null;
      if (builtin) {
        const url = builtin.url.replace(/[^\\/]+\.wav$/, 'siren.wav');
        s.samples = s.samples.map(x => (x === builtin ? { ...x, url, name: 'サイレン' } : x)); pad = 'サイレン';
      }
      s.createFolder(null, '新しいフォルダ'); s.renamingFolder = null;
      s.saveTake(c1.id, '候補 3', false);
      s.saveCustomTransition(c1.id, 'マイつなぎ 2');
      s.addCue(c0.id, Math.round(c0.mixInBar) + 2);
      s.changed();
      return { pad };
    });
    await ev(() => {
      window.__scanLang = (table, cjk) => {
        // A text that is the translation of some other key is fine (Portuguese "Tempo" is also "Time").
        const values = new Set(Object.values(table));
        const out = [], jp = cjk ? /[぀-ヿ]/ : /[぀-ヿ㐀-鿿]/;
        const texts = [];
        const walk = n => {
          if (n.nodeType === 3) texts.push(n.textContent.trim());
          else if (n.nodeType === 1 && getComputedStyle(n).display !== 'none' && !n.classList.contains('style-row')
            && !n.classList.contains('keycap') && n.tagName !== 'KBD') { // key caps: names printed on the keys (core/keys.ts)
            if (n.title) texts.push(n.title.trim()); if (n.placeholder) texts.push(n.placeholder.trim());
            if (n.tagName === 'INPUT' && n.type === 'text' && n.value) texts.push(n.value.trim());
            if (n.tagName === 'OPTION') texts.push(n.textContent.trim());
            n.childNodes.forEach(walk);
          }
        };
        walk(document.body);
        for (const t of texts) {
          if (!t || /E2E|DJAW/.test(t)) continue;
          if (jp.test(t)) out.push(t.slice(0, 50));
          else if (t.length > 3 && /[a-z]{3}/.test(t) && table[t] != null && table[t] !== t && !values.has(t)) out.push('EN: ' + t.slice(0, 50));
        }
        return [...new Set(out)];
      };
    });
    const scan = (table, cjk) => ev(([t, c]) => window.__scanLang(t, c), [table, cjk]);
    // Opens every right-click menu found on the screen (and each submenu) and scans it.
    const scanMenus = async (table, cjk, where, withTimeline) => {
      const found = [];
      const targets = await ev(withTimeline => {
        const pts = [];
        const ov = document.querySelector('.timeline-canvas.overlay');
        if (ov && ov.offsetParent) {
          const r = ov.getBoundingClientRect();
          if (withTimeline) for (let fy = 0.04; fy < 1; fy += 0.09) for (const fx of [0.15, 0.5, 0.85]) pts.push({ sel: '.timeline-canvas.overlay', x: r.left + r.width * fx, y: r.top + r.height * fy });
        }
        for (const sel of ['.track-row', '.folder-row', '.pad', '.btn.small.memo', '.chip', '.loop-row', '.edit-row']) {
          const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent);
          if (el) { const r = el.getBoundingClientRect(); pts.push({ sel, x: r.left + r.width / 2, y: r.top + r.height / 2 }); }
        }
        return pts;
      }, withTimeline);
      for (const p of targets) {
        const texts = await ev(async ({ sel, x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return [];
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
          await new Promise(r => setTimeout(r, 80));
          const items = [...document.querySelectorAll('.cm-menu > .cm-item.has-sub')];
          const all = [];
          const grab = () => document.querySelectorAll('.cm-menu .cm-label').forEach(l => all.push(l.textContent.trim()));
          grab();
          for (const it of items) { it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(r => setTimeout(r, 40)); grab(); }
          document.querySelector('.cm-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          await new Promise(r => setTimeout(r, 60));
          return all;
        }, p);
        const jp = cjk ? /[぀-ヿ]/ : /[぀-ヿ㐀-鿿]/;
        for (const t of texts) {
          if (!t || /E2E|DJAW/.test(t)) continue;
          if (jp.test(t)) found.push(`${where} menu ${p.sel}: ${t.slice(0, 50)}`);
          else if (t.length > 3 && /[a-z]{3}/.test(t) && table[t] != null && table[t] !== t && !Object.values(table).includes(t)) found.push(`${where} menu ${p.sel}: EN: ${t.slice(0, 50)}`);
        }
      }
      return found;
    };
    const langIssues = {};
    for (const [lang, table] of Object.entries(tables)) {
      const cjk = lang.startsWith('zh');
      await sendMenu('language', lang); await win.waitForTimeout(400);
      const found = [];
      const views = [
        ['overview', 0], ['mix', 0], ['track', 0], ['track', 'layer'], ['transition', 1], ['cue', 0], ['loop', 0], ['fx', 0], ['sampler', 0], ['deck', 0],
      ];
      for (const [tab, which] of views) {
        await ev(([t, w]) => { const s = window.djaw; s.selectedClipID = w === 'layer' ? (s.layers[0]?.id ?? s.clips[0].id) : s.clips[w].id; s.openPanel(t); }, [tab, which]);
        await win.waitForTimeout(250);
        (await scan(table, cjk)).forEach(b => found.push(`${tab}${which === 'layer' ? ' (layer)' : ''}: ${b}`));
        // Right-click menus where a view has its own (the timeline's once per language).
        if (['overview', 'cue', 'loop', 'sampler', 'transition'].includes(tab) && which !== 'layer') found.push(...await scanMenus(table, cjk, tab, tab === 'overview'));
      }
      for (const sheet of ['showAutoArrange', 'showExport', 'showPerformanceGuide', 'showShortcuts', 'showMusicLibrary', 'profile']) {
        await ev(f => { const s = window.djaw; if (f === 'profile') s.openProfileEditor(s.clips[0].id); else { s[f] = true; s.changed(); } }, sheet);
        await win.waitForTimeout(450);
        (await scan(table, cjk)).forEach(b => found.push(`${sheet}: ${b}`));
        await ev(f => { const s = window.djaw; if (f === 'profile') s.profileEditorTarget = null; else s[f] = false; s.changed(); }, sheet);
        await win.waitForTimeout(150);
      }
      if (found.length) langIssues[lang] = [...new Set(found)].slice(0, 12);
      console.log(`  language ${lang} scanned (${found.length} issues)`);
      if (lang === 'de') await shot('05-lang-de');
    }
    await sendMenu('language', 'english'); await win.waitForTimeout(400);
    check('every language shown without leftovers (tabs, sheets, menus, old names)', seeded.pad && Object.keys(langIssues).length === 0, { seeded, langIssues });

    // Export a WAV (the save dialog answers with a temp path).
    const wav = path.join(work, 'export.wav');
    await app.evaluate(({ ipcMain }, file) => { ipcMain.removeHandler('dialog:save'); ipcMain.handle('dialog:save', () => file); }, wav);
    await ev(() => { window.djaw.exportFormat = 'wav24'; window.djaw.exportSampleRate = 44100; window.djaw.startExport(true); });
    const exported = await until(() => window.djaw.exportPhase.kind === 'done' || window.djaw.exportPhase.kind === 'failed', 300000);
    const phase = await ev(() => window.djaw.exportPhase);
    const dur = await ev(() => window.djaw.tempoMap.real(window.djaw.mixDuration));
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
    check('save and reopen', saved && before === after && samplerBack[0] === 3 && samplerBack[1] === 1, { before, after, samplerBack });

    // Saved with the audio inside: WAV tracks go in as lossless FLAC, so the file is clearly smaller than the WAVs.
    const docEmbed = path.join(work, 'e2e-embedded.djaw');
    const savedEmbed = await ev(async d => { const s = window.djaw; s.embedMedia = true; s.compressAudio = true; s.documentPath = d; const ok = await s.save(false); s.embedMedia = false; return ok; }, docEmbed);
    const rawBytes = [...files, delta, horn].reduce((n, f) => n + fs.statSync(f).size, 0);
    const embedBytes = fs.existsSync(docEmbed) ? fs.statSync(docEmbed).size : 0;
    // Move the original files away so the audio has to come out of the .djaw.
    const originals = [...files, delta];
    originals.forEach(f => fs.renameSync(f, f + '.away'));
    await ev(async d => { const s = window.djaw; s.isDirty = false; await s.load(d); }, docEmbed);
    await until(() => window.djaw.clips.length === 3 && window.djaw.pending.length === 0, 120000);
    const embedBack = await ev(() => ({ clips: window.djaw.clips.length, layers: window.djaw.layers.length, flac: window.djaw.clips.filter(c => /\.flac$/i.test(c.url)).length, missing: window.djaw.missingFiles.size }));
    const embedPlay = await measure(await ev(() => window.djaw.clips[0].start + 2), 1.2);
    originals.forEach(f => fs.renameSync(f + '.away', f));
    check('saved with the audio as FLAC, reopens and plays', savedEmbed && embedBytes > 0 && embedBytes < rawBytes * 0.85 && embedBack.clips === 3 && embedBack.layers === 1 && embedBack.flac === 3 && embedBack.missing === 0 && embedPlay.rms > 0.02,
      { embedMB: +(embedBytes / 1e6).toFixed(2), rawMB: +(rawBytes / 1e6).toFixed(2), ...embedBack, rms: +embedPlay.rms.toFixed(3) });

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
