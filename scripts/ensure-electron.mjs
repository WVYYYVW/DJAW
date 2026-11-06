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

/** Unpacks with the system's own tools (the extract-zip package never finishes on Node.js 26). */
function unzip(zip, to) {
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] }).status === 0;
  let ok = false;
  if (platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    ok = fs.existsSync(tar) && run(tar, ['-xf', zip, '-C', to]);
    if (!ok) ok = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${to.replace(/'/g, "''")}' -Force`]);
  } else if (platform === 'darwin') {
    ok = run('ditto', ['-x', '-k', zip, to]);
  } else {
    ok = run('unzip', ['-q', '-o', zip, '-d', to]);
  }
  if (!ok) throw new Error('ZIP を展開できませんでした');
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
    // Leftovers of an earlier run that stopped half-way.
    for (const f of fs.readdirSync(os.tmpdir())) if ((f === `${name}.${f.split('.').pop()}` && /^\d+$/.test(f.split('.').pop()) || /^djaw-\d+-/.test(f) && f.endsWith(name))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    const tmp = path.join(os.tmpdir(), `djaw-${process.pid}-${name}`);
    fs.writeFileSync(tmp, zip);
    const dist = path.join(dir, 'dist');
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    unzip(tmp, dist);
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
