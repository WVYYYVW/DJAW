// Opens and closes the video preview many times in the packaged app, driven over the plain Chrome DevTools
// protocol (no Playwright: Playwright attaches to every new window and pauses it while it does, which could itself
// upset a window opened in the same renderer). Tells whether the main window's renderer survives.
//
//   node tests/e2e/preview-stress.cjs <path to DJAW executable> [rounds]
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exe = process.argv[2];
const rounds = Number(process.argv[3] || 8);
if (!exe) { console.error('give the DJAW executable'); process.exit(2); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-stress-'));
const port = 9300 + Math.floor(Math.random() * 500);

function writeWav(file, seconds, bpm, root) {
  const sr = 44100, n = sr * seconds, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr, b = t / beat, ph = b - Math.floor(b);
    const v = Math.sin(2 * Math.PI * 55 * ph * beat) * Math.exp(-ph * beat * 9) * 0.8 + Math.sin(2 * Math.PI * root * t) * 0.15;
    const s = Math.max(-1, Math.min(1, v)) * 30000 | 0;
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}
const files = [['Stress A 128', 128, 110], ['Stress B 132', 132, 147], ['Stress C 126', 126, 98]].map(([n, bpm, f]) => {
  const p = path.join(work, n + '.wav'); writeWav(p, 60, bpm, f); return p;
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const out = (...a) => { const l = a.join(' '); log.push(l); console.log(l); };

(async () => {
  // The bare Electron (development) needs the app folder; the packaged app does not.
  const appDir = /^electron(\.exe)?$/i.test(path.basename(exe)) ? [path.join(__dirname, '..', '..')] : [];
  const app = spawn(exe, ['--no-sandbox', `--remote-debugging-port=${port}`, ...appDir], {
    env: { ...process.env, DJAW_MUTE: '1', DJAW_USER_DATA: path.join(work, 'userdata'), ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let gone = null;
  const watch = d => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/\[DJAW\] (renderer gone|child process gone|renderer unresponsive)|Renderer process (killed|crashed)/.test(line)) { gone = gone ?? line; out('[app]', line); }
    }
  };
  app.stdout.on('data', watch); app.stderr.on('data', watch);
  let exited = null; app.on('exit', c => { exited = c; });

  // The main window's page target.
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
    } catch { /* not up yet */ }
  }
  if (!target) { out('FAIL no page target'); app.kill(); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  ws.onclose = () => { for (const f of waiting.values()) f({ error: { message: 'connection closed (renderer gone?)' } }); waiting.clear(); };
  const ev = (expr, ms = 30000) => new Promise((res, rej) => {
    const n = ++id;
    const timer = setTimeout(() => { waiting.delete(n); rej(new Error('timeout: ' + expr.slice(0, 60))); }, ms);
    waiting.set(n, d => { clearTimeout(timer); if (d.error) rej(new Error(d.error.message)); else if (d.result.exceptionDetails) rej(new Error(d.result.exceptionDetails.exception?.description ?? 'exception')); else res(d.result.result.value); });
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(500); } return false; };

  let ok = true;
  try {
    await until(`!!window.djaw && !!document.querySelector('.toolbar')`, 60000);
    await ev(`(window.djaw.addFiles(${JSON.stringify(files)}, { kind: 'mix', index: null }), true)`); // not awaited: analysis can take minutes
    const ready = await until(`window.djaw.pending.length === 0 && window.djaw.clips.length === 3 && window.djaw.clips.every(c => window.djaw.waveforms.get(c.url))`, 300000);
    out(ready ? 'tracks ready' : 'FAIL tracks not ready'); if (!ready) ok = false;
    // Some of what the smoke test does before it opens the preview: play, edit a transition, undo.
    await ev(`(async () => { const s = window.djaw; s.seek(s.clips[0].start + 5); await s.play(); await new Promise(r => setTimeout(r, 2000)); s.pause();
      s.selectedClipID = s.clips[1].id; s.openPanel('transition'); s.setTransitionLength(s.clips[1].id, 8); s.undo(); s.openPanel('overview'); return true; })()`);
    // The heavier state the smoke test reaches before its first preview (where Windows lost the renderer under
    // Playwright): separated stems, a tempo change, every panel tab drawn.
    await ev(`(async () => { const s = window.djaw, c = s.clips[0]; s.prepareStems([c.url]); const t0 = Date.now();
      while (s.stemProgress.has(c.url) && Date.now() - t0 < 240000) await new Promise(r => setTimeout(r, 500));
      s.setTransitionLength(s.clips[2].id, 8); s.setTempoChange(s.clips[2].id, true);
      for (const t of ['overview', 'mix', 'track', 'transition', 'cue', 'loop', 'fx', 'sampler', 'deck']) { s.openPanel(t); await new Promise(r => setTimeout(r, 300)); }
      return true; })()`, 300000);
    out('stems, tempo change, tabs done');
    for (let r = 1; r <= rounds && ok; r++) {
      const playing = r % 2 === 0;
      await ev(`(async () => { const s = window.djaw; if (${playing}) { s.seek(s.clips[1].start + 3); await s.play(); } s.showVisualPreview = true; s.changed(); return true; })()`);
      await sleep(1500 + (r % 3) * 400);
      await ev(`(() => { const s = window.djaw; s.showVisualPreview = false; s.changed(); s.pause(); return true; })()`);
      await sleep(600);
      const alive = await ev('1 + 1', 5000).catch(e => String(e));
      out(`round ${r}${playing ? ' (playing)' : ''}: ${alive === 2 ? 'ok' : 'FAIL ' + alive}`);
      if (alive !== 2 || gone) ok = false;
    }
    // The picture fills its window when that is made big (as with the title bar's maximize button), drawn at 1920.
    if (ok) {
      const fill = await ev(`(async () => {
        const s = window.djaw; s.showVisualPreview = true; s.changed();
        await new Promise(r => setTimeout(r, 1200));
        const w = window.open('', 'djaw-visuals');        // the open preview window (named), not a new one
        w.resizeTo(1600, 1000);
        await new Promise(r => setTimeout(r, 1500));
        const c = w.document.querySelector('canvas');
        const res = c ? { shownW: Math.round(c.clientWidth), shownH: Math.round(c.clientHeight), drawW: c.width, winW: w.innerWidth, winH: w.innerHeight } : { canvas: false };
        s.showVisualPreview = false; s.changed();
        return res;
      })()`);
      // (A screen smaller than 1600 px keeps the window smaller; above 1100 px shown it is drawn at 1920.)
      const good = fill.shownW >= fill.winW - 2 && fill.winW > 600 && (fill.winW > 1100 ? fill.drawW === 1920 : fill.drawW > 0);
      out(`${good ? 'ok' : 'FAIL'} preview fills an enlarged window ${JSON.stringify(fill)}`);
      if (!good) ok = false;
    }
  } catch (e) { ok = false; out('FAIL', String(e)); }
  if (gone) out('FAIL renderer:', gone);
  out(ok ? `preview stress: ${rounds} rounds, renderer alive` : 'preview stress FAILED');
  try { await ev(`window.djaw.isDirty = false; true`, 3000); } catch { /* gone */ }
  ws.close();
  app.kill();
  await sleep(1000);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
