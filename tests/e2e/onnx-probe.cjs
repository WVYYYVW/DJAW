// Runs the analysis process the way the app does (this Electron run as Node, forked from a Node parent) on a
// generated track: track analysis (Beat This!, CUE-DETR, genre) and stem separation. Prints how each went.
//   node tests/e2e/onnx-probe.cjs <electron or DJAW executable> <folder with analysis.child.js> <models folder>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const [exe, buildDir, models] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-onnx-'));
const sr = 44100, n = sr * 60;
const pcm = path.join(dir, 'in.wav');
const b = Buffer.alloc(44 + n * 4);
b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
b.write('data', 36); b.writeUInt32LE(n * 4, 40);
for (let i = 0; i < n; i++) { const t = i / sr, ph = (t * 128 / 60) % 1; const v = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-ph * 8) * 0.8 + Math.sin(2 * Math.PI * 330 * t) * 0.1; const s = (v * 30000) | 0; b.writeInt16LE(s, 44 + i * 4); b.writeInt16LE(s, 46 + i * 4); }
fs.writeFileSync(pcm, b);

const child = fork(path.join(buildDir, 'analysis.child.js'), [], { execPath: exe, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const waiting = new Map();
child.on('message', m => {
  if (m.type === 'ready' || m.type === 'progress') return;
  if (m.type === 'log') { console.log('log:', m.message); return; }
  const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); }
});
let exited = null;
child.on('exit', (code, sig) => { exited = code ?? sig; console.log('child exit', exited); for (const w of waiting.values()) w({ type: 'error', message: 'exit ' + exited }); });
let id = 1;
const ask = msg => new Promise(res => { const i = id++; waiting.set(i, res); child.send({ ...msg, id: i }); });
(async () => {
  let t = Date.now();
  const a = await ask({ type: 'analyze', pcm, modelPath: path.join(models, 'beatthis.onnx') });
  console.log('analyze:', a.type, a.message ?? '', a.analysis ? `bpm ${a.analysis.bpm.toFixed(2)}` : '', `${(Date.now() - t) / 1000}s`);
  t = Date.now();
  const names = ['vocals', 'drums', 'bass', 'melody'];
  const files = Object.fromEntries(names.map(x => [x, path.join(dir, x + '.wav')]));
  const s = await ask({ type: 'stems', pcm, modelDir: models, files });
  console.log('stems:', s.type, s.message ?? '', `${(Date.now() - t) / 1000}s`);
  child.kill();
  const ok = a.type === 'done' && s.type === 'done';
  console.log(ok ? 'ONNX PROBE PASSED' : 'ONNX PROBE FAILED');
  process.exit(ok ? 0 : 1);
})();
