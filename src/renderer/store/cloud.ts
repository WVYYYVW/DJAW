// Mixes in a cloud sync folder (MEGA), shared between computers: saving there, saving by itself, noticing a version
// saved on the other computer, "open on the other computer" notes, and tracks still on their way.
import fs from 'node:fs';
import path from 'node:path';
import { ipcRenderer } from 'electron';
import { L } from '../../core/i18n';
import { Clip } from '../../core/models';
import { encodeProject } from '../../core/project';
import {
  CloudMixInfo, PresenceNote, Presence, cloudPaths, copyTracksIntoCloud, detectMegaRoots, deviceName, fileStamp,
  isInside, listCloudMixes, readCloudMix, resolveRelative, writeFileAtomic,
} from '../../core/cloud';
import { dataDir } from '../services/env';
import { MixStore, store } from './store';

declare module './store' {
  interface MixStore {
    /** The sync folder (e.g. C:\Users\…\MEGA); mixes go into its DJAW folder. */
    cloudRoot: string | null;
    /** Whether the root was found automatically (not chosen). */
    cloudRootDetected: boolean;
    /** Save a mix in the cloud folder by itself, 20 s after the last edit. */
    cloudAutoSave: boolean;
    showCloud: boolean;
    /** Size / time of the open cloud mix as last read or written here. */
    cloudStamp: string | null;
    /** A newer version saved on another computer (shown while this one has unsaved edits). */
    cloudRemote: { savedOn: string | null; savedAt: string | null } | null;
    /** A newer version was just loaded by itself. */
    cloudReloaded: { savedOn: string | null; at: number } | null;
    cloudOthers: PresenceNote[];
    cloudCopy: { done: number; total: number; name: string } | null;
    cloudSaving: boolean;
    cloudLastSaved: number | null;
    cloudError: string | null;
    /** Tracks of the open cloud mix not on this computer yet. */
    cloudWaiting: number;

    cloudFolder(): string | null;
    isCloudPath(p: string | null | undefined): boolean;
    isCloudDocument(): boolean;
    setCloudRoot(p: string | null): void;
    chooseCloudRoot(): Promise<void>;
    setCloudAutoSave(on: boolean): void;
    cloudMixes(): CloudMixInfo[];
    /** quiet: autosave (never asks; never replaces a newer version). force: replace a newer version without asking. */
    saveCloud(target: string, quiet: boolean, force?: boolean): Promise<boolean>;
    /** Save the current mix into the cloud folder under a name. */
    saveToCloudAs(): Promise<boolean>;
    openCloudMix(file: string): Promise<void>;
    reloadCloudDocument(): Promise<void>;
    cloudDidOpen(): void;
    cloudTick(): void;
    cloudReleasePresence(): void;
  }
}

const settingsFile = () => dataDir('cloud.json');
function loadCloudSettings(): { root?: string | null; autoSave?: boolean } {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveCloudSettings(s: MixStore) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ root: s.cloudRootDetected ? null : s.cloudRoot, autoSave: s.cloudAutoSave }, null, 2));
  } catch { /* ignore */ }
}

const P = MixStore.prototype;
{
  const saved = loadCloudSettings();
  const root = saved.root && fs.existsSync(saved.root) ? saved.root : null;
  const detected = root ? null : detectMegaRoots()[0] ?? null;
  Object.assign(P, {
    cloudRoot: root ?? detected, cloudRootDetected: !root && !!detected, cloudAutoSave: saved.autoSave ?? true,
    showCloud: false, cloudStamp: null, cloudRemote: null, cloudReloaded: null, cloudOthers: [], cloudCopy: null,
    cloudSaving: false, cloudLastSaved: null, cloudError: null, cloudWaiting: 0,
  });
}

P.cloudFolder = function () { return this.cloudRoot ? cloudPaths(this.cloudRoot).dir : null; };
P.isCloudPath = function (p) { return isInside(this.cloudRoot, p); };
P.isCloudDocument = function () { return this.isCloudPath(this.documentPath); };

P.setCloudRoot = function (p) {
  this.cloudReleasePresence();
  this.cloudRoot = p;
  this.cloudRootDetected = false;
  saveCloudSettings(this);
  this.cloudDidOpen();
  this.changed();
};

P.chooseCloudRoot = async function () {
  const r: string[] | null = await ipcRenderer.invoke('dialog:open', {
    title: L('MEGA の同期フォルダを選ぶ', 'Choose the MEGA sync folder'), properties: ['openDirectory'],
    defaultPath: this.cloudRoot ?? undefined,
  });
  if (!r || !r[0]) return;
  // Choosing the DJAW folder itself means its parent.
  const chosen = path.basename(r[0]) === 'DJAW' ? path.dirname(r[0]) : r[0];
  this.setCloudRoot(chosen);
};

P.setCloudAutoSave = function (on) { this.cloudAutoSave = on; saveCloudSettings(this); this.changed(); };

P.cloudMixes = function () { return this.cloudRoot ? listCloudMixes(this.cloudRoot) : []; };

const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? '' : d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

P.saveCloud = async function (target, quiet, force = false) {
  const root = this.cloudRoot;
  if (!root || this.cloudSaving) return false;
  if (quiet && this.cloudRemote) return false;
  // Saved meanwhile on the other computer?
  const now = fileStamp(target);
  if (!force && target === this.documentPath && this.cloudStamp && now && now !== this.cloudStamp) {
    const info = readCloudMix(target);
    if (info && info.savedOn !== deviceName()) {
      this.cloudRemote = { savedOn: info.savedOn, savedAt: info.savedAt };
      if (quiet) { this.changed(); return false; }
      const r = await ipcRenderer.invoke('dialog:message', {
        type: 'warning',
        message: L(`${info.savedOn ?? '別のパソコン'}で保存された新しい版があります`, `A newer version was saved on ${info.savedOn ?? 'another computer'}`),
        detail: L(`保存日時：${when(info.savedAt)}\nこちらで上書きすると、そちらでの変更は失われます。`, `Saved: ${when(info.savedAt)}\nSaving here replaces the changes made there.`),
        buttons: [L('こちらで上書き', 'Replace with This Version'), L('新しい版を開く（こちらの変更は破棄）', 'Open the Newer Version (discard changes here)'), L('キャンセル', 'Cancel')],
        defaultId: 2, cancelId: 2,
      });
      if (r === 1) { await this.reloadCloudDocument(); return false; }
      if (r !== 0) return false;
    }
  }
  this.cloudSaving = true;
  this.cloudError = null;
  const serial = this.editSerial;
  this.changed();
  try {
    const all = [...this.clips, ...this.library];
    const map = await copyTracksIntoCloud(all.map(c => c.url), root, (done, total, name) => {
      this.cloudCopy = total && done < total ? { done, total, name } : null;
      this.changed();
    });
    const pf = this.makeProjectFile(target);
    const dir = path.dirname(target);
    const fix = (c: Clip): Clip => {
      const u = map.get(c.url) ?? c.url;
      return { ...c, url: u, relativePath: path.relative(dir, u).split(path.sep).join('/'), mediaID: undefined };
    };
    pf.clips = pf.clips.map(fix);
    pf.library = (pf.library ?? []).map(fix);
    pf.media = null;
    pf.originalPath = null;
    pf.savedOn = deviceName();
    // The old Mac app's own analyses (often over 10 MB) are not used by this version: left out so saves stay small.
    pf.analyses = null;
    writeFileAtomic(target, encodeProject(pf));
    this.cloudStamp = fileStamp(target);
    this.cloudRemote = null;
    this.cloudLastSaved = Date.now();
    remoteStamp = null;
    const switched = this.documentPath !== target;
    this.documentPath = target;
    if (this.editSerial === serial) { this.isDirty = false; this.removeAutosave(); }
    if (switched) { this.noteRecent(target); this.cloudDidOpen(); }
    else Presence.write(root, this.projectID, path.basename(target, '.djaw'));
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    this.cloudError = msg;
    if (!quiet) this.alertMessage = L(`クラウドフォルダに保存できませんでした: ${msg}`, `Could not save to the cloud folder: ${msg}`);
    return false;
  } finally {
    this.cloudSaving = false;
    this.cloudCopy = null;
    this.changed();
  }
};

P.saveToCloudAs = async function () {
  const dir = this.cloudFolder();
  if (!dir) { this.showCloud = true; this.changed(); return false; }
  fs.mkdirSync(dir, { recursive: true });
  const name = (this.documentPath ? path.basename(this.documentPath, '.djaw') : this.documentTitle || 'My Mix') + '.djaw';
  const r: string | null = await ipcRenderer.invoke('dialog:save', {
    title: L('クラウド（MEGA）に保存', 'Save to the Cloud (MEGA)'), defaultPath: path.join(dir, name),
    filters: [{ name: 'DJAW Mix', extensions: ['djaw'] }],
  });
  if (!r) return false;
  if (!this.isCloudPath(r)) return this.save(false);
  return this.saveCloud(r, false);
};

P.openCloudMix = async function (file) {
  const info = readCloudMix(file);
  const others = this.cloudRoot && info?.projectID ? Presence.others(this.cloudRoot, info.projectID) : [];
  if (others.length) {
    const r = await ipcRenderer.invoke('dialog:message', {
      type: 'warning',
      message: L(`このミックスは${others.map(o => o.device).join('、')}で開かれています`, `This mix is open on ${others.map(o => o.device).join(', ')}`),
      detail: L('両方で編集すると、後から保存した方の内容だけが残ります。開きますか？', 'If both are edited, only the one saved last is kept. Open it?'),
      buttons: [L('開く', 'Open'), L('キャンセル', 'Cancel')], defaultId: 0, cancelId: 1,
    });
    if (r !== 0) return;
  }
  if (!(await this.confirmDiscard())) return;
  this.showCloud = false;
  await this.load(file);
};

P.reloadCloudDocument = async function () {
  const doc = this.documentPath;
  if (!doc) return;
  const info = readCloudMix(doc);
  this.isDirty = false;
  await this.load(doc);
  this.cloudReloaded = { savedOn: info?.savedOn ?? null, at: Date.now() };
  this.changed();
};

let presence: { root: string; projectID: string } | null = null;
/** The newer version already reported (not reported again every tick). */
let remoteStamp: string | null = null;
let presenceAt = 0;

P.cloudReleasePresence = function () {
  if (presence) Presence.remove(presence.root, presence.projectID);
  presence = null;
};

/** After a mix was opened / saved / closed. */
P.cloudDidOpen = function () {
  const doc = this.documentPath;
  if (!this.cloudRoot || !doc || !this.isCloudDocument()) {
    this.cloudReleasePresence();
    this.cloudStamp = null; this.cloudRemote = null; this.cloudOthers = []; this.cloudWaiting = 0;
    return;
  }
  if (presence && (presence.projectID !== this.projectID || presence.root !== this.cloudRoot)) this.cloudReleasePresence();
  this.cloudStamp = fileStamp(doc);
  this.cloudRemote = null;
  remoteStamp = null;
  try { Presence.write(this.cloudRoot, this.projectID, path.basename(doc, '.djaw')); presence = { root: this.cloudRoot, projectID: this.projectID }; presenceAt = Date.now(); } catch { /* read-only */ }
  this.cloudOthers = Presence.others(this.cloudRoot, this.projectID);
  this.cloudWaiting = this.missingFiles.size;
};

/** Every few seconds while a cloud mix is open. */
P.cloudTick = function () {
  const doc = this.documentPath, root = this.cloudRoot;
  if (!root || !doc || !this.isCloudDocument()) return;
  let changed = false;
  // 1. A version saved on the other computer has arrived.
  const st = fileStamp(doc);
  if (st && this.cloudStamp && st !== this.cloudStamp && st !== remoteStamp && !this.cloudSaving) {
    const info = readCloudMix(doc);
    if (info) {
      if (info.savedOn && info.savedOn !== deviceName()) {
        if (!this.isDirty && !this.isPlaying) { void this.reloadCloudDocument(); return; }
        // Keep cloudStamp (the version these edits are based on), so saving here still asks first.
        remoteStamp = st;
        this.cloudRemote = { savedOn: info.savedOn, savedAt: info.savedAt };
        changed = true;
      } else this.cloudStamp = st;   // our own save, touched by the sync app
    }
  }
  // 2. Tracks that were still syncing.
  if (this.missingFiles.size) {
    const dir = path.dirname(doc);
    const found = new Map<string, string>();
    for (const c of [...this.clips, ...this.library]) {
      if (!this.missingFiles.has(c.url) || !c.relativePath || found.has(c.url)) continue;
      const p = resolveRelative(dir, c.relativePath);
      if (p) found.set(c.url, p);
    }
    if (found.size) {
      const fix = (c: Clip) => (found.has(c.url) ? { ...c, url: found.get(c.url)! } : c);
      this.clips = this.clips.map(fix);
      this.library = this.library.map(fix);
      for (const u of found.keys()) this.missingFiles.delete(u);
      this.applyLayout();
      void this.loadAnalyses();
      changed = true;
    }
  }
  if (this.cloudWaiting !== this.missingFiles.size) { this.cloudWaiting = this.missingFiles.size; changed = true; }
  // 3. Who else has it open (and say we still do).
  if (Date.now() - presenceAt > 60_000) {
    try { Presence.write(root, this.projectID, path.basename(doc, '.djaw')); presence = { root, projectID: this.projectID }; } catch { /* ignore */ }
    presenceAt = Date.now();
  }
  const others = Presence.others(root, this.projectID);
  if (others.map(o => o.device).join('|') !== this.cloudOthers.map(o => o.device).join('|')) { this.cloudOthers = others; changed = true; }
  if (this.cloudReloaded && Date.now() - this.cloudReloaded.at > 8000) { this.cloudReloaded = null; changed = true; }
  if (changed) this.changed();
};

setInterval(() => { try { store.cloudTick(); } catch (e) { console.warn('[DJAW] cloud:', e); } }, 4000);
window.addEventListener('beforeunload', () => store.cloudReleasePresence());
