// electron-builder afterPack: keeps only this platform's onnxruntime binaries in the package (the npm package carries
// Windows, Mac and Linux builds, ~240 MB), then signs the Mac app ad hoc.
//
// Why the signing is here: there is no Apple Developer ID certificate, and electron-builder skips signing without
// one. An unsigned bundle still carries Electron's own signature, which renaming the app and changing its files
// breaks — macOS then says the app "is damaged and can't be opened". An ad-hoc signature over the finished bundle
// is valid, so macOS only asks once (System Settings ▸ Privacy & Security ▸ Open Anyway).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;            // 'win32' | 'darwin' | 'linux'
  const arch = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch] ?? 'x64';
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const bin = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  if (fs.existsSync(bin)) {
    for (const p of fs.readdirSync(bin)) {
      const dir = path.join(bin, p);
      if (p !== platform) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      for (const a of fs.readdirSync(dir)) if (a !== arch) fs.rmSync(path.join(dir, a), { recursive: true, force: true });
    }
    console.log(`  • kept onnxruntime for ${platform}-${arch} only`);
  }
  if (platform === 'darwin') {
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
    // Fails the build if the signature does not hold for the whole bundle.
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
    console.log('  • signed the app ad hoc and verified the signature');
  }
};
