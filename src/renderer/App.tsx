// Main window: toolbar, mix order / library, timeline with decks and overview, inspector, and the sheets
// (mac/DJAW/ContentView.swift). Menu commands come from the main process; keys are handled here
// (MixStore.handleKey on the Mac).
import React, { useEffect, useRef, useState } from 'react';
import { ipcRenderer } from 'electron';
import fs from 'node:fs';
import { AppLanguage, L, isEnglish, setLanguage } from '../core/i18n';
import { useStore, useSize } from './hooks';
import { store } from './store/store';
import { dataDir, env } from './services/env';
import { Toolbar, ArrangementBar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { Timeline } from './components/Timeline';
import { DetailPanel } from './components/Panel';
import { ExportSheet } from './components/ExportSheet';
import { Shortcuts } from './components/Shortcuts';
import { ContextMenuHost } from './components/ContextMenu';
import { AutoArrangeSheet } from './components/AutoArrangeSheet';
import { PerformanceGuideSheet } from './components/PerformanceGuideSheet';
import { VisualPreviewWindow } from './components/VisualPreview';
import { MusicLibrarySheet } from './components/MusicLibrarySheet';
import { TrackProfileSheet } from './components/TrackProfileSheet';
import { padKeys } from '../core/sampler';
import { UpdateCard } from './components/UpdateCard';

function readLanguage(): AppLanguage {
  try { return (JSON.parse(fs.readFileSync(dataDir('settings.json'), 'utf8')).language as AppLanguage) ?? 'system'; } catch { return 'system'; }
}

function writeLanguage(lang: AppLanguage) {
  let s: Record<string, unknown> = {};
  try { s = JSON.parse(fs.readFileSync(dataDir('settings.json'), 'utf8')); } catch { /* new */ }
  s.language = lang;
  try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(dataDir('settings.json'), JSON.stringify(s, null, 2)); } catch { /* ignore */ }
}

setLanguage(readLanguage(), env.locale);

const isTextField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

function Alert() {
  const s = useStore();
  if (!s.alertMessage) return null;
  const close = () => { s.alertMessage = null; s.changed(); };
  return (
    <div className="sheet-backdrop" onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') close(); }}>
      <div className="sheet alert">
        <div className="sheet-title">DJAW</div>
        <div className="alert-text">{s.alertMessage}</div>
        <div className="button-row end"><button className="btn primary" autoFocus onClick={close}>OK</button></div>
      </div>
    </div>
  );
}

export function App() {
  const s = useStore();
  const [lang, setLang] = useState(0);
  const [mainRef, mainSize] = useSize<HTMLDivElement>();
  const titleRef = useRef('');

  // Window title.
  const title = `${s.documentTitle}${s.isDirty ? L(' — 編集済み', ' — Edited') : ''} — DJAW`;
  if (title !== titleRef.current) { titleRef.current = title; ipcRenderer.send('window:title', title); }

  useEffect(() => {
    const onMenu = async (_e: unknown, command: string, arg?: unknown) => {
      const sel = s.selectedClipID;
      switch (command) {
        case 'new': await s.newProject(); break;
        case 'open': await s.openProject(); break;
        case 'openRecent': await s.openRecent(arg as string); break;
        case 'openFile': if (await s.confirmDiscard()) await s.load(arg as string); break;
        case 'openLast': await s.openLastAtStartup(); break;
        case 'addTracks': await s.presentAddFiles(); break;
        case 'addFolder': await s.presentAddFiles(true); break;
        case 'musicLibrary': s.showMusicLibrary = true; s.changed(); break;
        case 'save': await s.save(false); break;
        case 'saveAs': await s.save(true); break;
        case 'toggleEmbed': s.toggle('embedMedia'); break;
        case 'export': if (s.clips.length) { s.showExport = true; s.changed(); } break;
        case 'copyTrackList': s.copyTrackList(); break;
        case 'visualPreview': s.showVisualPreview = true; s.changed(); break;
        case 'performanceGuide': if (s.clips.length) { s.showPerformanceGuide = true; s.changed(); } break;
        case 'autoMix': s.autoMixAll(); break;
        case 'autoArrange': if (s.clips.length + s.library.length >= 2) { s.showAutoArrange = true; s.changed(); } break;
        case 'undo': if (!isTextField(document.activeElement)) s.undo(); else document.execCommand('undo'); break;
        case 'redo': if (!isTextField(document.activeElement)) s.redo(); else document.execCommand('redo'); break;
        case 'delete': s.deleteSelected(); break;
        case 'cueEditor': if (sel) s.openCueEditor(sel); break;
        case 'togglePlay': s.togglePlay(); break;
        case 'toStart': if (!isTextField(document.activeElement)) { s.seek(0); s.requestScroll(0); } break;
        case 'previewTransition': if (sel && (s.index(sel) ?? 0) > 0) s.previewTransition(sel); break;
        case 'selectPrev': s.selectAdjacent(-1); break;
        case 'selectNext': s.selectAdjacent(1); break;
        case 'moveEarlier': s.moveSelectedInOrder(-1); break;
        case 'moveLater': s.moveSelectedInOrder(1); break;
        case 'transitionEditor': if (sel && (s.index(sel) ?? 0) > 0) s.openTransitionEditor(sel); break;
        case 'copyTransition': s.copyTransition(); break;
        case 'pasteTransition': s.pasteTransition(); break;
        case 'zoomIn': s.zoom(1.4); break;
        case 'zoomOut': s.zoom(1 / 1.4); break;
        case 'zoomFit': s.zoomToFit(); break;
        case 'toggleInspector': s.toggle('showPanel'); break;
        case 'toggleBrowser': s.toggle('showBrowser'); break;
        case 'toggleDecks': if (s.showPanel && s.panelTab === 'deck') s.toggle('showPanel'); else s.openPanel('deck'); break;
        case 'loopEditor': if (sel && s.index(sel) != null) s.openPanel('loop'); break;
        case 'panelTab': s.openPanel(arg as never); break;
        case 'maximizePanel': s.togglePanelMaximized(); break;
        // The overview is best seen big: it opens maximized (the same command goes back).
        case 'overview': if (s.panelTab === 'overview' && s.panelMaximized && s.showPanel) s.togglePanelMaximized(false); else { s.openPanel('overview'); s.togglePanelMaximized(true); } break;
        case 'toggleMixer': s.toggle('showMixer'); break;
        case 'toggleMixWaveform': s.toggle('showMixWaveform'); break;
        case 'toggleSamplerLane': s.toggle('showSamplerLane'); break;
        case 'toggleSampler': if (s.showPanel && s.panelTab === 'sampler') s.toggle('showPanel'); else s.openPanel('sampler'); break;
        case 'shortcuts': s.showShortcuts = true; s.changed(); break;
        case 'language': {
          const l = arg as AppLanguage;
          writeLanguage(l);
          setLanguage(l, env.locale);
          document.documentElement.lang = isEnglish() ? 'en' : 'ja';
          ipcRenderer.send('app:relaunchMenu');
          setLang(n => n + 1);
          s.changed();
          break;
        }
        case 'requestClose':
          if (await s.confirmDiscard()) { s.pause(); s.removeAutosave(); ipcRenderer.send('app:close'); }
          break;
      }
    };
    ipcRenderer.on('menu', onMenu);
    // The update in progress (main/updater.ts): the card and the toolbar chip. A new stage brings the card back.
    const onUpdate = (_e: unknown, u: import('../main/updater').UpdateStatus | null) => {
      if (!u || u.stage !== s.updateStatus?.stage) s.updateCardHidden = false;
      s.updateStatus = u; s.changed();
    };
    ipcRenderer.on('update:status', onUpdate);
    void ipcRenderer.invoke('update:status').then(u => { if (u) onUpdate(null, u); }).catch(() => {});
    return () => { ipcRenderer.removeListener('menu', onMenu); ipcRenderer.removeListener('update:status', onUpdate); };
  }, []);

  // Keys that are not menu items (MixStore.handleKey on the Mac).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTextField(e.target)) return;
      if (s.showExport || s.alertMessage) return;
      // Sheets take the keys while open.
      if (s.showShortcuts || s.showAutoArrange || s.showPerformanceGuide || s.profileEditorTarget || s.showMusicLibrary) return;
      // Space in the Transition tab plays the transition (from a little before it, unless already near).
      if (e.key === ' ' && s.focusArea === 'panel' && s.showPanel && s.panelTab === 'transition' && !s.isPlaying && s.selectedClipID && (s.index(s.selectedClipID) ?? 0) > 0) {
        const c = s.clip(s.selectedClipID)!;
        e.preventDefault();
        if (s.playhead >= c.start - 4 * s.barLength && s.playhead < c.start + c.transitionBars * s.barLength + 2 * s.barLength) s.play();
        else s.previewTransition(c.id);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) { s.redo(); e.preventDefault(); return; }
      if (mod && e.key === 'Enter') {
        const ids = s.librarySelection.size ? [...s.librarySelection] : s.selectedClipID && s.libraryIndex(s.selectedClipID) != null ? [s.selectedClipID] : [];
        if (ids.length) { s.addToMixMany(ids); e.preventDefault(); }
        return;
      }
      if (mod && e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (s.selectedClipID && s.isInMix(s.selectedClipID)) { s.removeFromMix(s.selectedClipID); e.preventDefault(); }
        return;
      }
      if (mod && !e.shiftKey && e.altKey && (e.key === 'a' || e.key === 'A')) {
        s.librarySelection = new Set(s.library.map(c => c.id)); s.changed(); e.preventDefault(); return;
      }
      if (mod || e.altKey) return;
      switch (e.key) {
        case ' ': s.togglePlay(); break;
        case 'Delete': case 'Backspace':
          if (!s.selectedHit && !s.selectedClipID && !s.librarySelection.size) return;
          // In the detail panel, Delete never removes the track being edited there.
          if (s.focusArea === 'panel' && !s.selectedHit) return;
          s.deleteSelected(); break;
        case 'Home': s.seek(0); s.requestScroll(0); break;
        case 'End': s.seek(s.mixDuration); s.requestScroll(s.mixDuration); break;
        case '1': case '2': case '3': case '4': case '5': case '6': {
          const id = s.selectedClipID;
          if (!id || (s.index(id) ?? 0) <= 0) return;
          s.applyPresetNumber(Number(e.key));
          break;
        }
        case 'Escape': if (!s.selectedHit) return; s.selectedHit = null; s.changed(); break;
        default: {
          // Sampler pads (while the sampler is shown).
          const pad = s.showPanel && s.panelTab === 'sampler' && !e.repeat ? padKeys.indexOf(e.key.toUpperCase()) : -1;
          if (pad < 0 || e.shiftKey) return;
          s.triggerPad(pad);
        }
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    document.documentElement.lang = isEnglish() ? 'en' : 'ja';
    s.offerRecoveryIfNeeded();
    // Which part of the window has the keys: the detail panel's editors, or the rest.
    const focus = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      // Menus and sheets opened from the panel leave the keys where they were.
      if (el?.closest?.('.cm-backdrop, .sheet-backdrop')) return;
      s.focusArea = el?.closest?.('.detail-panel') ? 'panel' : 'main';
    };
    window.addEventListener('pointerdown', focus, true);
    // Files dropped anywhere else must not navigate the window away.
    const prevent = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); window.removeEventListener('pointerdown', focus, true); };
  }, []);

  return (
    <div className="app" key={lang}>
      <Toolbar />
      <div className="body">
        {s.showBrowser && <Sidebar />}
        <div className="main" ref={mainRef}>
          {/* While the panel is maximized the arrangement stays mounted (its scroll and zoom are kept), only hidden. */}
          <div className={'arrangement' + (s.showPanel && s.panelMaximized ? ' hidden' : '')}>
            <ArrangementBar />
            <div className="timeline-area"><Timeline /></div>
          </div>
          {s.showPanel && mainSize.height > 0 && <DetailPanel maximized={s.panelMaximized} maxHeight={Math.max(170, Math.min(mainSize.height - 280, mainSize.height * 0.58))} />}
        </div>
      </div>
      {s.showAutoArrange && <AutoArrangeSheet />}
      {s.showMusicLibrary && <MusicLibrarySheet />}
      {s.showExport && <ExportSheet />}
      {s.showPerformanceGuide && <PerformanceGuideSheet />}
      <VisualPreviewWindow />
      {s.profileEditorTarget && <TrackProfileSheet />}
      <UpdateCard />
      {s.showShortcuts && <Shortcuts />}
      <Alert />
      <ContextMenuHost />
    </div>
  );
}
