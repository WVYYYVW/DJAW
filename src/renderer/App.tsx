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
import { Toolbar, Overview } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { Timeline } from './components/Timeline';
import { DeckPanel } from './components/DeckPanel';
import { Inspector } from './components/Inspector';
import { TransitionEditor } from './components/TransitionEditor';
import { CueEditor } from './components/CueEditor';
import { ExportSheet } from './components/ExportSheet';
import { Shortcuts } from './components/Shortcuts';
import { ContextMenuHost } from './components/ContextMenu';
import { AutoArrangeSheet } from './components/AutoArrangeSheet';
import { PerformanceGuideSheet } from './components/PerformanceGuideSheet';
import { VisualPreviewWindow } from './components/VisualPreview';
import { MusicLibrarySheet } from './components/MusicLibrarySheet';
import { CloudBar, CloudSheet } from './components/CloudSheet';
import { TrackProfileSheet } from './components/TrackProfileSheet';
import { SamplerPanel } from './components/SamplerPanel';
import { padKeys } from '../core/sampler';

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

const deckHeight = (available: number, mixer: boolean) => {
  if (!mixer) return Math.max(160, Math.min(Math.min(260, Math.max(160, available * 0.3)), available - 200));
  return Math.max(230, Math.min(Math.min(330, Math.max(230, available * 0.42)), available - 200));
};

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
        case 'addTracks': await s.presentAddFiles(); break;
        case 'addFolder': await s.presentAddFiles(true); break;
        case 'musicLibrary': s.showMusicLibrary = true; s.changed(); break;
        case 'save': await s.save(false); break;
        case 'saveAs': await s.save(true); break;
        case 'cloud': s.showCloud = true; s.changed(); break;
        case 'saveToCloud': await s.saveToCloudAs(); break;
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
        case 'toggleFollow': s.toggle('followPlayhead'); break;
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
        case 'toggleInspector': s.toggle('showInspector'); break;
        case 'toggleDecks': s.toggle('showDecks'); break;
        case 'toggleMixer': s.toggle('showMixer'); break;
        case 'toggleMixWaveform': s.toggle('showMixWaveform'); break;
        case 'toggleSampler': s.showSampler = !s.showSampler; s.changed(); break;
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
    return () => { ipcRenderer.removeListener('menu', onMenu); };
  }, []);

  // Keys that are not menu items (MixStore.handleKey on the Mac).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTextField(e.target)) return;
      if (s.showExport || s.alertMessage) return;
      // Inside an editor the keys belong to it; only Space in the transition editor is shared.
      if (s.cueEditorTarget || s.transitionEditorTarget || s.showShortcuts || s.showAutoArrange || s.showPerformanceGuide || s.profileEditorTarget || s.showMusicLibrary || s.showCloud) {
        if (e.key !== ' ' || s.cueEditorTarget || !s.transitionEditorTarget) return;
        const c = s.clip(s.transitionEditorTarget);
        if (!c) return;
        e.preventDefault();
        if (s.isPlaying) s.pause();
        else if (s.playhead >= c.start - 4 * s.barLength && s.playhead < c.start + c.transitionBars * s.barLength + 2 * s.barLength) s.play();
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
          const pad = s.showSampler && !e.repeat ? padKeys.indexOf(e.key.toUpperCase()) : -1;
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
    // Files dropped anywhere else must not navigate the window away.
    const prevent = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);

  const available = mainSize.height - 56 - (s.showSampler ? 93 : 0);
  return (
    <div className="app" key={lang}>
      <Toolbar />
      <CloudBar />
      <div className="body">
        <Sidebar />
        <div className="main" ref={mainRef}>
          <div className="timeline-area"><Timeline /></div>
          {s.showSampler && <div className="sampler-area"><SamplerPanel /></div>}
          {s.showDecks && mainSize.height > 0 && <div className="deck-area" style={{ height: deckHeight(available, s.showMixer) }}><DeckPanel /></div>}
          <div className="overview-area"><Overview /></div>
        </div>
        {s.showInspector && <Inspector />}
      </div>
      {s.showAutoArrange && <AutoArrangeSheet />}
      {s.showMusicLibrary && <MusicLibrarySheet />}
      {s.showCloud && <CloudSheet />}
      {s.transitionEditorTarget && <TransitionEditor />}
      {s.cueEditorTarget && <CueEditor key={s.cueEditorTarget ? 'cue' : ''} />}
      {s.showExport && <ExportSheet />}
      {s.showPerformanceGuide && <PerformanceGuideSheet />}
      <VisualPreviewWindow />
      {s.profileEditorTarget && <TrackProfileSheet />}
      {s.showShortcuts && <Shortcuts />}
      <Alert />
      <ContextMenuHost />
    </div>
  );
}
