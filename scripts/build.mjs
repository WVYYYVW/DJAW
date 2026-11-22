// Builds everything with esbuild into build/:
//   main.js (Electron main), renderer.js (+ index.html, styles), worklet.js (AudioWorklet),
//   render.worker.js (Web Worker with Node), analysis.child.js (child Node process), tests/*.js (node --test).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');
const cli = process.argv.includes('--cli');
const out = 'build';
fs.mkdirSync(out, { recursive: true });
// The time-stretch WASM without its AudioWorklet wrapper (see tools/signalsmith).
if (!fs.existsSync('src/vendor/stretch-core.mjs')) {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['tools/signalsmith/make-core.mjs', 'node_modules/signalsmith-stretch/SignalsmithStretch.mjs', 'src/vendor/stretch-core.mjs'], { stdio: 'inherit' });
}

// Keys for the translations of texts with values in them (scripts/i18n.mjs).
const { keyed } = await import('./i18n.mjs');
const i18nPlugin = {
  name: 'i18n-keys',
  setup(b) {
    b.onLoad({ filter: /[\\/](src|tests)[\\/].*\.tsx?$/ }, async args => {
      const text = await fs.promises.readFile(args.path, 'utf8');
      const out = keyed(args.path, text);
      return out == null ? undefined : { contents: out, loader: args.path.endsWith('x') ? 'tsx' : 'ts' };
    });
  },
};
const common = { bundle: true, sourcemap: 'linked', logLevel: 'info', target: 'es2022', plugins: [i18nPlugin], define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' } };
const node = { ...common, platform: 'node', format: 'cjs', external: ['electron', 'onnxruntime-node'] };

const builds = [
  { ...node, entryPoints: ['src/main/main.ts'], outfile: `${out}/main.js` },
  // Renderer and workers run with Node integration: Node built-ins stay `require`s.
  { ...node, entryPoints: ['src/renderer/index.tsx'], outfile: `${out}/renderer.js`, loader: { '.css': 'css' } },
  { ...node, entryPoints: ['src/workers/render.worker.ts'], outfile: `${out}/render.worker.js` },
  { ...node, entryPoints: ['src/workers/analysis.child.ts'], outfile: `${out}/analysis.child.js` },
  { ...common, platform: 'browser', format: 'iife', entryPoints: ['src/renderer/worklet.ts'], outfile: `${out}/worklet.js` },
];
if (cli) {
  builds.length = 0;
  builds.push({ ...node, entryPoints: fs.readdirSync('src/cli').map(f => path.join('src/cli', f)), outdir: `${out}/cli` });
}
if (tests) {
  const files = fs.readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => path.join('tests', f));
  builds.length = 0;
  builds.push({ ...node, entryPoints: files, outdir: `${out}/tests` });
}

if (!tests && !cli) fs.copyFileSync('src/renderer/index.html', `${out}/index.html`);
// The sampler's built-in sounds are made, not stored (assets/samples is not in git): again whenever the generator changed.
if (!tests && !cli) {
  const gen = 'scripts/make-samples.mjs', stamp = 'assets/samples/.made';
  const madeFor = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '';
  const want = String(fs.statSync(gen).size) + ':' + fs.readFileSync(gen, 'utf8').length;
  if (madeFor !== want || !fs.existsSync('assets/samples/air-horn.wav')) {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [gen], { stdio: 'ignore' });
    fs.writeFileSync(stamp, want);
  }
}
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map(b => esbuild.build(b)));
}
