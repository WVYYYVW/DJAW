// Updates from GitHub Releases of WVYYYVW/DJAW (a public repository, so the app reads it without signing in). At start (and from the menu) the latest release is checked; when it is
// newer, the user is asked, the installer for this computer is downloaded (checked against GitHub's SHA-256), and it
// is installed when the app closes — at once, with a restart, if the user chooses so.
//   Windows: the NSIS installer runs silently over the installed app (same place, settings kept).
//   Mac:     the app is taken from the .dmg and put in place of this one (no Developer ID signature, so the usual
//            Squirrel updater cannot be used; the copy is checked with codesign before it replaces anything).
// For the automated tests, DJAW_UPDATE_TEST_DIR points at a folder with latest.json and the installer instead of
// GitHub, and DJAW_UPDATE_AUTO=1 answers every question with yes.
import { app, BrowserWindow, dialog, ipcMain, net, session } from 'electron';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Lang = (ja: string, en: string, key?: string, args?: unknown[]) => string;

interface Release { version: string; notes: string; asset: { name: string; url: string; size: number; sha256: string | null } | null }

/** What the window shows about an update (the update card and the toolbar chip). */
export interface UpdateStatus {
  stage: 'checking' | 'downloading' | 'verifying' | 'preparing' | 'ready' | 'installing' | 'failed';
  version?: string;
  /** Bytes so far / in all, bytes per second, seconds left (while downloading). */
  received?: number;
  total?: number;
  speed?: number;
  eta?: number;
  error?: string;
}

/** The repository whose latest release is the newest DJAW (public: read without signing in). */
const REPO = 'WVYYYVW/DJAW';
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

/**
 * Downloads to a file, reporting the bytes received so far. Done by Chromium's download manager (the one a browser
 * uses, in its own session so nothing else is affected): as fast as downloading from the GitHub page, and the
 * progress is only read from it, never in its way.
 */
async function download(rel: NonNullable<Release['asset']>, dest: string, progress: (received: number) => void) {
  if (testDir) {
    // The test feed: copied in pieces, so the progress shows as it would for a download.
    const src = fs.openSync(path.join(testDir, rel.name), 'r'), out = fs.openSync(dest, 'w');
    const buf = Buffer.alloc(8 << 20);
    let got = 0;
    try { for (let n; (n = fs.readSync(src, buf, 0, buf.length, null)) > 0;) { fs.writeSync(out, buf, 0, n); got += n; progress(got); await new Promise(r => setTimeout(r, 10)); } } finally { fs.closeSync(src); fs.closeSync(out); }
    return;
  }
  const ses = session.fromPartition('djaw-updates');
  await new Promise<void>((resolve, reject) => {
    const onStart = (_e: Electron.Event, item: Electron.DownloadItem) => {
      ses.removeListener('will-download', onStart);
      item.setSavePath(dest);
      item.on('updated', () => progress(item.getReceivedBytes()));
      item.once('done', (_ev, state) => {
        if (state === 'completed') { progress(item.getReceivedBytes()); resolve(); }
        else reject(new Error(state === 'cancelled' ? 'cancelled' : `download ${state}`));
      });
    };
    ses.on('will-download', onStart);
    ses.downloadURL(rel.url, { headers: { 'User-Agent': 'DJAW' } });
  });
  const got = fs.statSync(dest).size;
  if (rel.size && got !== rel.size) throw new Error(`incomplete download (${got} / ${rel.size} bytes)`);
}

const run = promisify(execFile);

/** SHA-256 of a file, read as a stream (the window stays responsive). */
function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 4 << 20 }).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** The .app this process runs from (Mac). */
const macBundle = () => path.resolve(app.getPath('exe'), '..', '..', '..');

export class Updater {
  private checking = false;
  /** A downloaded, checked update waiting for the app to close. */
  private ready: { version: string; file: string; restart: boolean } | null = null;

  private status: UpdateStatus | null = null;

  constructor(private readonly L: Lang, private readonly window: () => BrowserWindow | null,
    private readonly requestClose: () => void, private readonly settings: { get: (k: string) => unknown; set: (k: string, v: unknown) => void }) {
    // The update card's buttons.
    ipcMain.on('update:restart', () => this.restartNow());
    ipcMain.on('update:retry', () => { this.show(null); void this.check(true); });
    ipcMain.handle('update:status', () => this.status);
  }

  /** Tells the window (card, toolbar chip, the progress in the Dock / taskbar). */
  private show(st: UpdateStatus | null) {
    this.status = st;
    const w = this.window();
    if (!w || w.isDestroyed()) return;
    w.webContents.send('update:status', st);
    if (st?.stage === 'downloading' && st.total) w.setProgressBar(Math.min(1, (st.received ?? 0) / st.total));
    else if (st && (st.stage === 'verifying' || st.stage === 'preparing' || st.stage === 'installing')) w.setProgressBar(2); // indeterminate
    else w.setProgressBar(-1);
  }

  /** From the card: install now (the app closes, asking about unsaved changes first). */
  private restartNow() {
    if (!this.ready) return;
    this.ready.restart = true;
    this.show({ stage: 'installing', version: this.ready.version });
    this.requestClose();
  }

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
    if (this.ready) { if (manual) { if (auto) await this.offerRestart(); else this.show({ stage: 'ready', version: this.ready.version }); } return; }
    // Already downloading: the menu brings the card back.
    if (this.status && this.status.stage !== 'failed') { if (manual) this.show(this.status); return; }
    this.checking = true;
    if (manual) this.show({ stage: 'checking' });
    try {
      const rel = await latest();
      const current = app.getVersion();
      if (manual) this.show(null);
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
      if (manual) this.show(null);
      if (manual) await this.ask({ type: 'warning', message: L('更新を確認できませんでした', 'Could not check for updates'), detail: (e as Error).message });
    } finally {
      this.checking = false;
    }
  }

  private async fetch(rel: Release) {
    const L = this.L;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-update-'));
    const file = path.join(dir, rel.asset!.name);
    const total = rel.asset!.size;
    try {
      // Download: bytes, speed (smoothed) and time left, at most ten times a second.
      const t0 = Date.now();
      let lastT = t0, lastGot = 0, speed = 0, lastSent = 0;
      this.show({ stage: 'downloading', version: rel.version, received: 0, total });
      await download(rel.asset!, file, got => {
        const now = Date.now();
        if (now - lastT >= 250) {
          const inst = (got - lastGot) / ((now - lastT) / 1000);
          speed = speed ? speed * 0.7 + inst * 0.3 : inst;
          lastT = now; lastGot = got;
        }
        if (now - lastSent >= 100 || got === total) {
          lastSent = now;
          this.show({ stage: 'downloading', version: rel.version, received: got, total, speed: speed || undefined, eta: speed > 0 && total ? Math.max(0, (total - got) / speed) : undefined });
        }
      });
      console.log(`[DJAW] update downloaded: ${(total / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      this.show({ stage: 'verifying', version: rel.version });
      await new Promise(r => setTimeout(r, 30));
      if (rel.asset!.sha256 && (await sha256(file)) !== rel.asset!.sha256.toLowerCase()) throw new Error(L('ダウンロードしたファイルが壊れています（SHA-256 が一致しません）', 'The download is damaged (SHA-256 mismatch)'));
      if (process.platform === 'darwin') {
        this.show({ stage: 'preparing', version: rel.version });
        await new Promise(r => setTimeout(r, 30));
        await this.prepareMac(file, dir);
      }
      this.ready = { version: rel.version, file, restart: false };
      this.show({ stage: 'ready', version: rel.version });
      // In the automated test nobody clicks the card: answer like the old dialog.
      if (auto || !this.window()) await this.offerRestart();
    } catch (e) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      this.show({ stage: 'failed', version: rel.version, error: (e as Error).message });
    }
  }

  /** Takes the app out of the disk image and checks it, so closing the app only has to move it into place. */
  private async prepareMac(dmg: string, dir: string) {
    const mnt = path.join(dir, 'mnt');
    fs.mkdirSync(mnt);
    await run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt]);
    try {
      const appName = fs.readdirSync(mnt).find(n => n.endsWith('.app'));
      if (!appName) throw new Error('no app in the disk image');
      await run('ditto', [path.join(mnt, appName), path.join(dir, 'DJAW.app')]);
    } finally {
      try { await run('hdiutil', ['detach', mnt, '-force']); } catch { /* ignore */ }
    }
    await run('codesign', ['--verify', '--deep', '--strict', path.join(dir, 'DJAW.app')]);
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
    if (r === 0) this.restartNow();
  }

  /** Called when the app quits: hands over to the installer. */
  installOnQuit() {
    const u = this.ready;
    if (!u) return;
    this.ready = null;
    if (process.platform === 'win32') {
      // Silently over this one (shown with its own window, the installer stops to ask about the closing app);
      // --force-run starts the new version afterwards. The card said beforehand that this takes a few seconds.
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
