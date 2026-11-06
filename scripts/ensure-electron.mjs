// Makes sure Electron's own program is downloaded. Newer npm versions may not run the electron package's install
// script, which leaves node_modules/electron without the app ("Electron failed to install correctly").
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const dir = path.dirname(require.resolve('electron/package.json'));
if (!existsSync(path.join(dir, 'path.txt')) || !existsSync(path.join(dir, 'dist'))) {
  console.log('Electron を準備しています（初回のみ、約 100MB のダウンロード）…');
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit', cwd: dir });
  if (r.status !== 0) {
    console.error('Electron のダウンロードに失敗しました。ネットワークを確認して、もう一度 npm start を実行してください。');
    process.exit(r.status ?? 1);
  }
}
