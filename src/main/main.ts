// Electron main process: the window, the menu bar, file dialogs and the recent-documents list.
import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

app.setName('DJAW');
let win: BrowserWindow | null = null;
let lang: 'ja' | 'en' = 'ja';
let canClose = false;

const L = (ja: string, en: string) => (lang === 'en' ? en : ja);
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readLanguage() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (s.language === 'english') return 'en';
    if (s.language === 'japanese') return 'ja';
  } catch { /* defaults */ }
  return app.getLocale().startsWith('ja') ? 'ja' : 'en';
}

function send(command: string, arg?: unknown) {
  win?.webContents.send('menu', command, arg);
}

function buildMenu() {
  const item = (label: string, command: string, accelerator?: string, arg?: unknown): MenuItemConstructorOptions =>
    ({ label, accelerator, click: () => send(command, arg) });
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  const recent = app.isReady() ? (JSON.parse((() => { try { return fs.readFileSync(settingsPath(), 'utf8'); } catch { return '{}'; } })()).recentDocuments ?? []) as string[] : [];
  const template: MenuItemConstructorOptions[] = [
    {
      label: L('ファイル', 'File'),
      submenu: [
        item(L('新規ミックス', 'New Mix'), 'new', 'CmdOrCtrl+N'),
        item(L('開く…', 'Open…'), 'open', 'CmdOrCtrl+O'),
        item(L('クラウドのミックス（MEGA）…', 'Cloud Mixes (MEGA)…'), 'cloud', 'CmdOrCtrl+Shift+O'),
        {
          label: L('最近使ったミックスを開く', 'Open Recent'),
          submenu: recent.length ? recent.map(p => item(path.basename(p, '.djaw'), 'openRecent', undefined, p)) : [{ label: L('なし', 'None'), enabled: false }],
        },
        sep,
        item(L('曲を追加…', 'Add Tracks…'), 'addTracks', 'CmdOrCtrl+Shift+I'),
        item(L('ミュージックから追加…', 'Add from Music…'), 'musicLibrary', 'CmdOrCtrl+Alt+Shift+I'),
        sep,
        item(L('保存', 'Save'), 'save', 'CmdOrCtrl+S'),
        item(L('別名で保存…', 'Save As…'), 'saveAs', 'CmdOrCtrl+Shift+S'),
        item(L('クラウド（MEGA）に保存…', 'Save to Cloud (MEGA)…'), 'saveToCloud', 'CmdOrCtrl+Alt+S'),
        item(L('曲の音声をファイルに含めて保存（切替）', 'Include Audio When Saving (toggle)'), 'toggleEmbed'),
        sep,
        item(L('書き出し…', 'Export…'), 'export', 'CmdOrCtrl+E'),
        item(L('曲リストをコピー（SoundCloud 用）', 'Copy Track List (for SoundCloud)'), 'copyTrackList', 'CmdOrCtrl+Alt+C'),
        item(L('演奏手順と曲リスト…', 'How to Play & Track List…'), 'performanceGuide', 'CmdOrCtrl+Shift+P'),
        sep,
        { role: 'quit', label: L('終了', 'Quit') },
      ],
    },
    {
      label: L('編集', 'Edit'),
      submenu: [
        item(L('取り消す', 'Undo'), 'undo', 'CmdOrCtrl+Z'),
        item(L('やり直す', 'Redo'), 'redo', 'CmdOrCtrl+Shift+Z'),
        sep,
        { role: 'cut', label: L('カット', 'Cut') },
        { role: 'copy', label: L('コピー', 'Copy') },
        { role: 'paste', label: L('ペースト', 'Paste') },
        { role: 'selectAll', label: L('すべてを選択', 'Select All') },
        sep,
        item(L('選択した曲を削除', 'Delete Selected Track'), 'delete'),
        item(L('CUE（IN / OUT）を編集…', 'Edit Cues (IN / OUT)…'), 'cueEditor', 'CmdOrCtrl+K'),
      ],
    },
    {
      label: L('再生', 'Playback'),
      submenu: [
        item(L('再生 / 一時停止（Space）', 'Play / Pause (Space)'), 'togglePlay'),
        item(L('先頭へ戻る', 'Go to Start'), 'toStart', 'Home'),
        item(L('選択した曲のつなぎを試聴', 'Preview Selected Transition'), 'previewTransition', 'CmdOrCtrl+P'),
        sep,
        item(L('再生位置に追従（切替）', 'Follow Playhead (toggle)'), 'toggleFollow'),
      ],
    },
    {
      label: L('曲', 'Track'),
      submenu: [
        item(L('前の曲を選択', 'Select Previous Track'), 'selectPrev', 'CmdOrCtrl+Up'),
        item(L('次の曲を選択', 'Select Next Track'), 'selectNext', 'CmdOrCtrl+Down'),
        sep,
        item(L('曲順を前へ', 'Move Earlier'), 'moveEarlier', 'CmdOrCtrl+['),
        item(L('曲順を後ろへ', 'Move Later'), 'moveLater', 'CmdOrCtrl+]'),
        sep,
        item(L('つなぎエディタを開く…', 'Open Transition Editor…'), 'transitionEditor', 'CmdOrCtrl+T'),
        item(L('つなぎ方をコピー', 'Copy Transition'), 'copyTransition', 'CmdOrCtrl+Alt+Shift+C'),
        item(L('つなぎ方をペースト', 'Paste Transition'), 'pasteTransition', 'CmdOrCtrl+Alt+Shift+V'),
        sep,
        item(L('曲を解析して全体を自動ミックス', 'Analyse & Auto-Mix Everything'), 'autoMix', 'CmdOrCtrl+Shift+M'),
        item(L('おまかせミックス（曲順も）…', 'Auto-Arrange (Order Too)…'), 'autoArrange', 'CmdOrCtrl+Shift+A'),
      ],
    },
    {
      label: L('表示', 'View'),
      submenu: [
        item(L('映像プレビュー', 'Visuals Preview'), 'visualPreview', 'CmdOrCtrl+Alt+V'),
        sep,
        item(L('拡大', 'Zoom In'), 'zoomIn', 'CmdOrCtrl+='),
        item(L('縮小', 'Zoom Out'), 'zoomOut', 'CmdOrCtrl+-'),
        item(L('全体を表示', 'Fit Mix'), 'zoomFit', 'CmdOrCtrl+0'),
        sep,
        item(L('インスペクタ（切替）', 'Inspector (toggle)'), 'toggleInspector', 'CmdOrCtrl+Alt+I'),
        item(L('デッキ（切替）', 'Decks (toggle)'), 'toggleDecks', 'CmdOrCtrl+Shift+D'),
        item(L('ミキサー（切替）', 'Mixer (toggle)'), 'toggleMixer', 'CmdOrCtrl+Shift+X'),
        item(L('ミックス波形（切替）', 'Mix Waveform (toggle)'), 'toggleMixWaveform'),
        sep,
        {
          label: L('言語', 'Language'),
          submenu: [
            item(L('システムに合わせる', 'System'), 'language', undefined, 'system'),
            item('日本語', 'language', undefined, 'japanese'),
            item('English', 'language', undefined, 'english'),
          ],
        },
        sep,
        { role: 'toggleDevTools', label: L('開発者ツール', 'Developer Tools') },
      ],
    },
    {
      label: L('ヘルプ', 'Help'),
      submenu: [item(L('キーボードショートカット', 'Keyboard Shortcuts'), 'shortcuts', 'CmdOrCtrl+/')],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(fileToOpen?: string) {
  lang = readLanguage();
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640,
    backgroundColor: '#121316', title: 'DJAW', show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInWorker: true,
      backgroundThrottling: false,
      additionalArguments: [
        `--djaw-user-data=${app.getPath('userData')}`,
        `--djaw-app-root=${app.getAppPath()}`,
        `--djaw-locale=${app.getLocale()}`,
      ],
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win?.show();
    if (fileToOpen) send('openFile', fileToOpen);
  });
  win.on('close', e => {
    if (canClose) return;
    e.preventDefault();
    send('requestClose');
  });
  // The visuals preview (a window the renderer draws into, so it can go on a second screen).
  win.webContents.setWindowOpenHandler(d => d.frameName === 'djaw-visuals'
    ? { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 600, minWidth: 480, minHeight: 320, backgroundColor: '#000000', autoHideMenuBar: true, title: L('映像プレビュー', 'Visuals Preview') } }
    : { action: 'deny' });
  win.webContents.on('did-create-window', w => w.setMenu(null));
  win.webContents.on('render-process-gone', (_e, d) => console.error('[DJAW] renderer gone:', d.reason, d.exitCode));
  win.on('closed', () => { win = null; });
  buildMenu();
}

ipcMain.handle('dialog:open', async (_e, opts) => {
  const r = await dialog.showOpenDialog(win!, opts);
  return r.canceled ? null : r.filePaths;
});
ipcMain.handle('dialog:save', async (_e, opts) => {
  const r = await dialog.showSaveDialog(win!, opts);
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:message', async (_e, opts) => (await dialog.showMessageBox(win!, opts)).response);
ipcMain.on('recent:add', (_e, file: string) => { app.addRecentDocument(file); buildMenu(); });
ipcMain.on('window:title', (_e, title: string) => win?.setTitle(title));
ipcMain.on('app:close', () => { canClose = true; win?.close(); });
ipcMain.on('app:relaunchMenu', () => { lang = readLanguage(); buildMenu(); });
ipcMain.on('shell:show', (_e, p: string) => shell.showItemInFolder(p));

const fileArg = process.argv.find(a => a.toLowerCase().endsWith('.djaw'));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const f = argv.find(a => a.toLowerCase().endsWith('.djaw'));
  if (f) send('openFile', f);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.whenReady().then(() => createWindow(fileArg));
app.on('window-all-closed', () => app.quit());
