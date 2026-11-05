// Keyboard shortcut list (mac/DJAW/Views/ShortcutsView.swift, with Windows keys).
import React, { useEffect } from 'react';
import { L } from '../../core/i18n';
import { store } from '../store/store';

export function Shortcuts() {
  const close = () => { store.showShortcuts = false; store.changed(); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') { close(); e.stopPropagation(); e.preventDefault(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  const groups: [string, [string, string][]][] = [
    [L('再生', 'Playback'), [
      ['Space', L('再生 / 一時停止', 'Play / pause')],
      ['Home / End', L('先頭 / 最後へ', 'Go to start / end')],
      ['Ctrl+P', L('選択した曲のつなぎを試聴', 'Preview the selected transition')],
    ]],
    [L('編集', 'Editing'), [
      ['Ctrl+Z', L('取り消す', 'Undo')],
      ['Ctrl+Shift+Z / Ctrl+Y', L('やり直す', 'Redo')],
      ['Delete', L('選択した曲を削除', 'Delete the selected track')],
      ['Ctrl+Alt+Shift+C / V', L('つなぎ方をコピー / ペースト', 'Copy / paste a transition')],
      ['1 – 6', L('つなぎ方を適用（カットイン〜ロングミックス）', 'Apply a transition recipe (Cut In … Long Mix)')],
      ['Ctrl+Shift+M', L('曲を解析して全体を自動ミックス', 'Analyse & auto-mix everything')],
      ['Ctrl+Shift+A', L('おまかせミックス（曲順も自動）', 'Auto-arrange (order too)')],
    ]],
    [L('曲', 'Tracks'), [
      ['Ctrl+↑ / Ctrl+↓', L('前 / 次の曲を選択', 'Select previous / next track')],
      ['Ctrl+[ / Ctrl+]', L('曲順を前 / 後ろへ', 'Move earlier / later in the mix')],
      ['← / →', L('つなぐ位置を1小節移動（Shift で4小節、Alt で1拍）', 'Move the entry 1 bar (Shift 4 bars, Alt 1 beat)')],
      ['Ctrl+K', L('CUE（IN / OUT）を編集', 'Edit cues (IN / OUT)')],
      ['Ctrl+T', L('つなぎエディタを開く', 'Open the transition editor')],
      ['Ctrl+Enter', L('ライブラリの曲をミックスに入れる（複数可）', 'Add library track(s) to the mix')],
      [L('Ctrl / Shift + クリック', 'Ctrl / Shift + click'), L('ライブラリの曲を複数選択', 'Select several library tracks')],
      ['Ctrl+Alt+A', L('ライブラリの曲をすべて選択', 'Select all library tracks')],
      ['Ctrl+Shift+Delete', L('ミックスの曲をライブラリに戻す', 'Move a mix track back to the library')],
    ]],
    [L('表示', 'View'), [
      ['Ctrl+= / Ctrl+− / Ctrl+0', L('拡大 / 縮小 / 全体表示', 'Zoom in / out / fit')],
      [L('Ctrl + スクロール', 'Ctrl + scroll'), L('ズーム', 'Zoom')],
      ['Ctrl+Alt+I', L('インスペクタの表示切替', 'Show / hide the inspector')],
      ['Ctrl+Shift+D', L('デッキの表示切替', 'Show / hide the decks')],
      ['Ctrl+Shift+X', L('ミキサーの表示切替', 'Show / hide the mixer')],
      ['Ctrl+Alt+V', L('映像プレビュー', 'Visuals preview')],
    ]],
    [L('ファイル', 'File'), [
      ['Ctrl+N / Ctrl+O / Ctrl+S', L('新規 / 開く / 保存', 'New / open / save')],
      ['Ctrl+Shift+I', L('曲を追加', 'Add tracks')],
      ['Ctrl+Alt+Shift+I', L('ミュージック（iTunes）から追加', 'Add from Music (iTunes)')],
      ['Ctrl+E', L('書き出し', 'Export')],
      ['Ctrl+Alt+C', L('曲リストをコピー（SoundCloud 用）', 'Copy the track list (for SoundCloud)')],
      ['Ctrl+Shift+P', L('演奏手順と曲リスト', 'How to play & track list')],
    ]],
    [L('CUE エディタ', 'CUE editor'), [
      ['I / L / O', L('入口 / 切替完了 / 出口をセット', 'Set IN / switch / OUT')],
      ['M', L('メモCUE', 'Memo cue')],
      ['← / →', L('1小節移動（Shift で4小節）', 'Move 1 bar (Shift 4 bars)')],
    ]],
    [L('つなぎエディタ', 'Transition editor'), [
      [L('◆をドラッグ', 'Drag ◆'), L('曲線を曲げる（ダブルクリックで直線）', 'Bend the curve (double-click to straighten)')],
      [L('空いた所をクリック', 'Click empty space'), L('点を追加', 'Add a point')],
      [L('点をダブルクリック / Delete', 'Double-click point / Delete'), L('点を削除', 'Delete a point')],
      [L('Alt + ドラッグ', 'Alt + drag'), L('スナップなしで動かす', 'Move without snapping')],
    ]],
  ];
  return (
    <div className="sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet shortcuts">
        <div className="sheet-head"><span className="sheet-title">⌨ {L('キーボードショートカット', 'Keyboard Shortcuts')}</span><div className="spacer" /><button className="btn primary" onClick={close}>{L('閉じる', 'Close')}</button></div>
        <div className="shortcut-grid">
          {groups.map(([title, items]) => (
            <div key={title} className="shortcut-group">
              <div className="side-head">{title}</div>
              {items.map(([k, t]) => <div key={k + t} className="shortcut-row"><span className="keycap">{k}</span><span>{t}</span></div>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
