// Update test: starts an installed (older) DJAW that sees a newer version (9.9.9) in DJAW_UPDATE_TEST_DIR, answers
// yes to everything (DJAW_UPDATE_AUTO=1), and checks that the app on disk is replaced by 9.9.9 and starts again.
//   node tests/e2e/update.cjs <app executable> <installer of 9.9.9 (.exe / .dmg)>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const [exe, installer] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-update-feed-'));
const name = path.basename(installer);
fs.copyFileSync(installer, path.join(dir, name));
const bytes = fs.readFileSync(installer);
fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
  version: '9.9.9', notes: '## Test\n- automated update test',
  asset: { name, url: '', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
}));

const version = () => {
  try {
    if (process.platform === 'darwin') {
      const app = path.resolve(exe, '..', '..', '..');
      return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')]).toString().trim();
    }
    return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`]).toString().trim();
  } catch { return null; }
};
const running = () => {
  try {
    const out = process.platform === 'darwin' ? execFileSync('pgrep', ['-fl', 'DJAW.app/Contents/MacOS/DJAW']).toString()
      : execFileSync('tasklist', ['/FI', 'IMAGENAME eq DJAW.exe']).toString();
    return /DJAW/.test(out);
  } catch { return false; }
};
const kill = () => { try { if (process.platform === 'darwin') execFileSync('pkill', ['-f', 'DJAW.app/Contents/MacOS/DJAW']); else execFileSync('taskkill', ['/F', '/IM', 'DJAW.exe']); } catch { /* none */ } };

(async () => {
  const before = version();
  console.log('installed version before:', before);
  const child = spawn(exe, [], {
    env: { ...process.env, DJAW_UPDATE_TEST_DIR: dir, DJAW_UPDATE_AUTO: '1', DJAW_MUTE: '1', DJAW_USER_DATA: path.join(dir, 'userdata') },
    stdio: 'inherit', detached: true,
  });
  child.unref();
  const t0 = Date.now();
  let after = before;
  while (Date.now() - t0 < 240000) {
    await new Promise(r => setTimeout(r, 2000));
    after = version();
    if (after === '9.9.9') break;
  }
  console.log('installed version after:', after, `(${Math.round((Date.now() - t0) / 1000)} s)`);
  // The new version is started again after the update.
  let restarted = false;
  for (let i = 0; i < 30 && after === '9.9.9'; i++) { if (running()) { restarted = true; break; } await new Promise(r => setTimeout(r, 1000)); }
  console.log('restarted:', restarted);
  kill();
  const ok = before !== '9.9.9' && after === '9.9.9' && restarted;
  console.log(ok ? 'UPDATE TEST PASSED' : 'UPDATE TEST FAILED');
  process.exit(ok ? 0 : 1);
})();
