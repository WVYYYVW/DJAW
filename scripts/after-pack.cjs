// electron-builder afterPack: keeps only this platform's onnxruntime binaries in the package (the npm package carries
// Windows, Mac and Linux builds, ~240 MB). Runs before the Mac app is signed.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;            // 'win32' | 'darwin' | 'linux'
  const arch = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch] ?? 'x64';
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const bin = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  if (!fs.existsSync(bin)) return;
  for (const p of fs.readdirSync(bin)) {
    const dir = path.join(bin, p);
    if (p !== platform) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
    for (const a of fs.readdirSync(dir)) if (a !== arch) fs.rmSync(path.join(dir, a), { recursive: true, force: true });
  }
  console.log(`  • kept onnxruntime for ${platform}-${arch} only`);
};
