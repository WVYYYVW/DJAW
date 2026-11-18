// Updates from GitHub Releases of WVYYYVW/DJAW-releases (public; the release workflow copies each version there). At start (and from the menu) the latest release is checked; when it is
// newer, the user is asked, the installer for this computer is downloaded (checked against GitHub's SHA-256), and it
// is installed when the app closes — at once, with a restart, if the user chooses so.
//   Windows: the NSIS installer runs silently over the installed app (same place, settings kept).
//   Mac:     the app is taken from the .dmg and put in place of this one (no Developer ID signature, so the usual
//            Squirrel updater cannot be used; the copy is checked with codesign before it replaces anything).
// For the automated tests, DJAW_UPDATE_TEST_DIR points at a folder with latest.json and the installer instead of
// GitHub, and DJAW_UPDATE_AUTO=1 answers every question with yes.
import { app, BrowserWindow, dialog, net } from 'electron';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Lang = (ja: string, en: string) => string;

interface Release { version: string; notes: string; asset: { name: string; url: string; size: number; sha256: string | null } | null }

/** A public repository holding only the installers (the source repository is private, so the app cannot read it). */
const REPO = 'WVYYYVW/DJAW-releases';
const testDir = process.env.DJAW_UPDATE_TEST_DIR || null;
const auto = process.env.DJAW_UPDATE_AUTO === '1';

/** 1 when a is newer than b ("0.3.10" > "0.3.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const assetPattern = () => (process.platform === 'win32' ? /^DJAW-Setup-.*\.exe$/ : process.platform === 'darwin' ? /mac-arm64\.dmg$/ : null);

async function getJSON(url: string): Promise<unknown> {
  const r = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DJAW' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function latest(): Promise<Release> {
  if (testDir) return JSON.parse(fs.readFileSync(path.join(testDir, 'latest.json'), 'utf8'));
  const j = await getJSON(`https://api.github.com/repos/${REPO}/releases/latest`) as {
    tag_name: string; body?: string; assets: { name: string; browser_download_url: string; size: number; digest?: string }[];
  };
  const pat = assetPattern();
  const a = pat ? j.assets.find(x => pat.test(x.name)) : null;
  return {
    version: j.tag_name.replace(/^v/, ''),
    notes: j.body ?? '',
    asset: a ? { name: a.name, url: a.browser_download_url, size: a.size, sha256: a.digest?.startsWith('sha256:') ? a.digest.slice(7) : null } : null,
  };
}

/** Downloads to a file, reporting progress (0…1). */
async function download(rel: NonNullable<Release['asset']>, dest: string, progress: (p: number) => void) {
  if (testDir) { fs.copyFileSync(path.join(testDir, rel.name), dest); progress(1); return; }
  const r = await net.fetch(rel.url, { headers: { 'User-Agent': 'DJAW' } });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const out = fs.createWriteStream(dest);
  const reader = r.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(value)) await new Promise<void>(res => out.once('drain', () => res()));
      progress(rel.size ? got / rel.size : 0);
    }
  } finally {
    await new Promise<void>(res => out.end(() => res()));
  }
  if (rel.size && got !== rel.size) throw new Error(`incomplete download (${got} / ${rel.size} bytes)`);
}

function sha256(file: string) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** The .app this process runs from (Mac). */
const macBundle = () => path.resolve(app.getPath('exe'), '..', '..', '..');

export class Updater {
  private checking = false;
  /** A downloaded, checked update waiting for the app to close. */
  private ready: { version: string; file: string; restart: boolean } | null = null;

  constructor(private readonly L: Lang, private readonly window: () => BrowserWindow | null,
    private readonly requestClose: () => void, private readonly settings: { get: (k: string) => unknown; set: (k: string, v: unknown) => void }) {}

  get supported() { return (app.isPackaged || !!testDir) && assetPattern() != null; }

  private async ask(opts: Electron.MessageBoxOptions): Promise<number> {
    if (auto) return 0;
    const w = this.window();
    return (w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)).response;
  }

  /** `manual`: from the menu (says so when there is nothing new, and ignores "skip this version"). */
  async check(manual: boolean) {
    const L = this.L;
    if (!this.supported) {
      if (manual) await this.ask({ type: 'info', message: L('この環境では自動更新を使えません', 'Updates are not available here'), detail: L('配布版（インストールした DJAW）で使えます。', 'They work in the installed app.') });
      return;
    }
    if (this.checking) return;
    if (this.ready) { if (manual) await this.offerRestart(); return; }
    this.checking = true;
    try {
      const rel = await latest();
      const current = app.getVersion();
      if (compareVersions(rel.version, current) <= 0) {
        if (manual) await this.ask({ type: 'info', message: L('最新の DJAW です', 'DJAW is up to date'), detail: L(`いまの版：${current}`, `This version: ${current}`) });
        return;
      }
      if (!manual && this.settings.get('skipUpdate') === rel.version) return;
      if (!rel.asset) {
        if (manual) await this.ask({ type: 'warning', message: L(`新しい版 ${rel.version} がありますが、この環境用のファイルがまだありません`, `Version ${rel.version} is out, but not yet for this computer`) });
        return;
      }
      const notes = rel.notes.replace(/\r/g, '').split('\n').filter(l => l.trim() && !/^#+\s*ダウンロード|^#+\s*Download/i.test(l)).slice(0, 18).join('\n');
      const r = await this.ask({
        type: 'info', buttons: [L('更新する', 'Update'), L('あとで', 'Later'), L('この版はスキップ', 'Skip This Version')], defaultId: 0, cancelId: 1,
        message: L(`新しい DJAW（${rel.version}）があります`, `A new DJAW (${rel.version}) is available`),
        detail: L(`いまの版：${current}\n\n`, `This version: ${current}\n\n`) + notes,
      });
      if (r === 2) { this.settings.set('skipUpdate', rel.version); return; }
      if (r !== 0) return;
      await this.fetch(rel);
    } catch (e) {
      console.warn('[DJAW] update check failed:', (e as Error).message);
      if (manual) await this.ask({ type: 'warning', message: L('更新を確認できませんでした', 'Could not check for updates'), detail: (e as Error).message });
    } finally {
      this.checking = false;
    }
  }

  private async fetch(rel: Release) {
    const L = this.L;
    const w = this.window();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-update-'));
    const file = path.join(dir, rel.asset!.name);
    try {
      w?.webContents.send('update:progress', { version: rel.version, progress: 0 });
      await download(rel.asset!, file, p => { w?.setProgressBar(p); w?.webContents.send('update:progress', { version: rel.version, progress: p }); });
      w?.setProgressBar(-1);
      if (rel.asset!.sha256 && sha256(file) !== rel.asset!.sha256.toLowerCase()) throw new Error(L('ダウンロードしたファイルが壊れています（SHA-256 が一致しません）', 'The download is damaged (SHA-256 mismatch)'));
      if (process.platform === 'darwin') this.prepareMac(file, dir);
      this.ready = { version: rel.version, file, restart: false };
      w?.webContents.send('update:progress', { version: rel.version, progress: 1, ready: true });
      await this.offerRestart();
    } catch (e) {
      w?.setProgressBar(-1);
      w?.webContents.send('update:progress', null);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      await this.ask({ type: 'warning', message: L('更新をダウンロードできませんでした', 'Could not download the update'), detail: (e as Error).message });
    }
  }

  /** Takes the app out of the disk image and checks it, so closing the app only has to move it into place. */
  private prepareMac(dmg: string, dir: string) {
    const mnt = path.join(dir, 'mnt');
    fs.mkdirSync(mnt);
    execFileSync('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt], { stdio: 'ignore' });
    try {
      const appName = fs.readdirSync(mnt).find(n => n.endsWith('.app'));
      if (!appName) throw new Error('no app in the disk image');
      execFileSync('ditto', [path.join(mnt, appName), path.join(dir, 'DJAW.app')]);
    } finally {
      try { execFileSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(dir, 'DJAW.app')], { stdio: 'ignore' });
    fs.rmSync(dmg, { force: true });
    // The place this app is in has to be writable to be replaced.
    const target = macBundle();
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
  }

  private async offerRestart() {
    const L = this.L;
    if (!this.ready) return;
    const r = await this.ask({
      type: 'info', buttons: [L('今すぐ再起動して更新', 'Restart and Update Now'), L('あとで（終了するときに更新）', 'Later (update when DJAW quits)')], defaultId: 0, cancelId: 1,
      message: L(`DJAW ${this.ready.version} の準備ができました`, `DJAW ${this.ready.version} is ready`),
      detail: L('保存していない変更がある場合は、先に保存するか確認します。', 'If there are unsaved changes, you will be asked to save them first.'),
    });
    if (r === 0) { this.ready.restart = true; this.requestClose(); }
  }

  /** Called when the app quits: hands over to the installer. */
  installOnQuit() {
    const u = this.ready;
    if (!u) return;
    this.ready = null;
    if (process.platform === 'win32') {
      // Silent install over this one; --force-run starts the new version afterwards.
      const args = ['/S', '--updated'];
      if (u.restart) args.push('--force-run');
      spawn(u.file, args, { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      const src = path.join(path.dirname(u.file), 'DJAW.app');
      const target = macBundle();
      const script = path.join(path.dirname(u.file), 'install.sh');
      fs.writeFileSync(script, [
        '#!/bin/bash',
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
        `target=${JSON.stringify(target)}`,
        `old="$target.old-$$"`,
        `mv "$target" "$old" && mv ${JSON.stringify(src)} "$target" || { [ -d "$old" ] && mv "$old" "$target"; exit 1; }`,
        'rm -rf "$old"',
        'xattr -dr com.apple.quarantine "$target" 2>/dev/null',
        u.restart ? 'open "$target"' : '',
        `rm -rf ${JSON.stringify(path.dirname(u.file))}`,
      ].join('\n'), { mode: 0o755 });
      spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
    }
  }
}
