// Makes sure Electron's own program is downloaded. Newer npm / Node versions may skip or silently end the electron
// package's install script, which leaves node_modules/electron without the app ("Electron failed to install
// correctly"). Here: try that script, and if Electron is still missing, download and unpack it ourselves.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const dir = path.dirname(require.resolve('electron/package.json'));
const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const platform = process.platform;
const arch = process.arch;
const exe = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';

function installed() {
  try {
    return fs.readFileSync(path.join(dir, 'path.txt'), 'utf8') === exe
      && fs.readFileSync(path.join(dir, 'dist', 'version'), 'utf8').replace(/^v/, '').trim() === version
      && fs.existsSync(path.join(dir, 'dist', exe));
  } catch { return false; }
}

if (!installed()) {
  console.log('Electron を準備しています（初回のみ、約 100MB のダウンロード）…');
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) console.log('（環境変数 ELECTRON_SKIP_BINARY_DOWNLOAD が設定されているため、Electron 標準のダウンロードは飛ばされます）');
  spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit', cwd: dir });
}

if (!installed()) {
  const name = `electron-v${version}-${platform}-${arch}.zip`;
  const url = `https://github.com/electron/electron/releases/download/v${version}/${name}`;
  console.log(`Electron を直接ダウンロードします：${url}`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0, shown = -1;
    for await (const c of res.body) {
      chunks.push(c);
      got += c.length;
      const pct = total ? Math.floor(got / total * 100) : -1;
      if (pct >= 0 && pct >= shown + 10) { shown = pct; process.stdout.write(`  ${pct}%\n`); }
    }
    const zip = Buffer.concat(chunks);
    const sums = JSON.parse(fs.readFileSync(path.join(dir, 'checksums.json'), 'utf8'));
    const sha = createHash('sha256').update(zip).digest('hex');
    if (sums[name] && sums[name] !== sha) throw new Error('ダウンロードしたファイルが壊れています（チェックサム不一致）');
    const tmp = path.join(os.tmpdir(), `${name}.${process.pid}`);
    fs.writeFileSync(tmp, zip);
    const dist = path.join(dir, 'dist');
    fs.rmSync(dist, { recursive: true, force: true });
    const extract = require(require.resolve('extract-zip', { paths: [dir] }));
    await extract(tmp, { dir: dist });
    fs.rmSync(tmp, { force: true });
    const dts = path.join(dist, 'electron.d.ts');
    if (fs.existsSync(dts)) fs.renameSync(dts, path.join(dir, 'electron.d.ts'));
    fs.writeFileSync(path.join(dir, 'path.txt'), exe);
  } catch (e) {
    console.error(`Electron のダウンロードに失敗しました：${e.message}`);
  }
}

if (!installed()) {
  console.error('Electron を用意できませんでした。ネットワーク（セキュリティソフト・プロキシ）を確認して、もう一度 npm start を実行してください。');
  process.exit(1);
}
