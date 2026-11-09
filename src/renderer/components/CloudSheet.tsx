// Mixes in the cloud (MEGA sync folder): the folder, saving by itself, and the mixes there to open.
import path from 'node:path';
import React, { useEffect, useMemo, useState } from 'react';
import { L } from '../../core/i18n';
import { Presence, deviceName } from '../../core/cloud';
import { useStore } from '../hooks';

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function CloudSheet() {
  const s = useStore();
  const [tick, setTick] = useState(0);
  // The list follows what the sync app brings in.
  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 4000); return () => clearInterval(t); }, []);
  const mixes = useMemo(() => s.cloudMixes(), [s.cloudRoot, tick, s.cloudLastSaved]);
  const close = () => { s.showCloud = false; s.changed(); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  const current = s.documentPath;
  return (
    <div className="sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet cloud-sheet">
        <div className="sheet-head">
          <span className="sheet-icon">☁</span>
          <div>
            <div className="sheet-title">{L('クラウド（MEGA）', 'Cloud (MEGA)')}</div>
            <div className="dim">{L('MEGA のアプリが同期するフォルダにミックスを保存して、Windows と Mac のどちらでも続きから作業できます。曲の音声は「DJAW/曲」に1回だけコピーされ、ミックス本体は小さいファイルなので、保存のたびのアップロードはすぐ終わります。', 'Save mixes into the folder the MEGA app syncs, and carry on from either Windows or Mac. Track audio is copied once into “DJAW/曲”; the mix itself is a small file, so each save uploads quickly.')}</div>
          </div>
        </div>

        <div className="form">
          <div className="form-row">
            <span className="form-label">{L('同期フォルダ', 'Sync folder')}</span>
            <div className="cloud-root">
              {s.cloudRoot
                ? <span className="mono cloud-path" title={s.cloudRoot}>{s.cloudRoot}{s.cloudRootDetected && <span className="pill">{L('自動で検出', 'detected')}</span>}</span>
                : <span className="warn-text">{L('MEGA の同期フォルダが見つかりません', 'No MEGA sync folder found')}</span>}
              <button className="btn small" onClick={() => s.chooseCloudRoot()}>{s.cloudRoot ? L('変更…', 'Change…') : L('フォルダを選ぶ…', 'Choose Folder…')}</button>
            </div>
          </div>
          {!s.cloudRoot && (
            <div className="caption">{L('MEGA の公式アプリ（MEGA Desktop App）を入れてログインし、同期するフォルダ（ふつうはホームフォルダの「MEGA」）を作ってから、そのフォルダを選んでください。Mac 側でも同じアカウントで同期すると、同じミックスが見えるようになります。', 'Install the MEGA Desktop App, sign in and set up a sync folder (usually “MEGA” in your home folder), then choose it here. Sync the same account on the Mac to see the same mixes there.')}</div>
          )}
          <label className="check"><input type="checkbox" checked={s.cloudAutoSave} onChange={() => s.setCloudAutoSave(!s.cloudAutoSave)} />{L('クラウドのミックスは自動で保存する（最後の操作から20秒後）', 'Save cloud mixes automatically (20 s after the last edit)')}</label>
          <div className="caption">{L(`このパソコンは「${deviceName()}」として表示されます。別のパソコンで保存された新しい版は、こちらで未保存の変更がなければ自動で読み込みます。`, `This computer appears as “${deviceName()}”. A newer version saved on another computer is loaded automatically when there are no unsaved changes here.`)}</div>
        </div>

        {s.cloudRoot && (
          <div className="cloud-list">
            <div className="cloud-list-head">
              <span>{L(`クラウドのミックス（${mixes.length}）`, `Mixes in the cloud (${mixes.length})`)}</span>
              <div className="spacer" />
              <button className="btn small" disabled={!s.clips.length && !s.library.length} onClick={() => s.saveToCloudAs()}>☁ {L('今のミックスをクラウドに保存…', 'Save Current Mix to Cloud…')}</button>
            </div>
            {!mixes.length && <div className="dim cloud-empty">{L('まだありません。「今のミックスをクラウドに保存…」で、開いているミックスを置けます。', 'None yet. “Save Current Mix to Cloud…” puts the open mix here.')}</div>}
            {mixes.map(m => {
              const others = m.projectID ? Presence.others(s.cloudRoot!, m.projectID) : [];
              const isOpen = current != null && path.resolve(current) === path.resolve(m.path);
              return (
                <div key={m.path} className={`cloud-item ${isOpen ? 'open' : ''}`} onDoubleClick={() => !isOpen && s.openCloudMix(m.path)}>
                  <div className="cloud-item-main">
                    <div className="cloud-item-title">{m.name}{isOpen && <span className="pill">{L('開いています', 'Open')}</span>}</div>
                    <div className="dim small">
                      {L(`${m.tracks}曲 ・ ${when(m.modified)} に保存`, `${m.tracks} tracks · saved ${when(m.modified)}`)}
                      {m.savedOn ? L(`（${m.savedOn}）`, ` (${m.savedOn})`) : ''}
                      {m.waiting > 0 && <span className="warn-text"> ・ {L(`同期待ち ${m.waiting}曲`, `${m.waiting} tracks still syncing`)}</span>}
                      {others.length > 0 && <span className="warn-text"> ・ {L(`${others.map(o => o.device).join('、')}で使用中`, `open on ${others.map(o => o.device).join(', ')}`)}</span>}
                    </div>
                  </div>
                  {!isOpen && <button className="btn small" onClick={() => s.openCloudMix(m.path)}>{L('開く', 'Open')}</button>}
                </div>
              );
            })}
          </div>
        )}

        <div className="button-row end">
          <span className="dim small">{L('MEGA のアプリが動いていないと、ほかのパソコンには届きません。', 'Changes reach the other computer only while the MEGA app is running.')}</span>
          <div className="spacer" />
          <button className="btn primary" onClick={close}>{L('閉じる', 'Close')}</button>
        </div>
      </div>
    </div>
  );
}

/** A thin bar under the toolbar while something about the open cloud mix needs saying. */
export function CloudBar() {
  const s = useStore();
  if (!s.isCloudDocument()) return null;
  const items: React.ReactNode[] = [];
  if (s.cloudRemote) {
    items.push(<span key="remote" className="cloud-msg warn">
      {L(`${s.cloudRemote.savedOn ?? '別のパソコン'}で保存された新しい版があります（こちらにも未保存の変更があります）`, `A newer version was saved on ${s.cloudRemote.savedOn ?? 'another computer'} (this one has unsaved changes too)`)}
      <button className="btn small" onClick={() => s.reloadCloudDocument()}>{L('新しい版を読み込む', 'Load Newer Version')}</button>
      <button className="btn small" onClick={() => s.saveCloud(s.documentPath!, false, true)}>{L('こちらで上書き保存', 'Save This Version')}</button>
    </span>);
  }
  if (s.cloudReloaded) items.push(<span key="reloaded" className="cloud-msg ok">✓ {L(`${s.cloudReloaded.savedOn ?? '別のパソコン'}で保存された新しい版を読み込みました`, `Loaded the newer version saved on ${s.cloudReloaded.savedOn ?? 'another computer'}`)}</span>);
  if (s.cloudOthers.length) items.push(<span key="others" className="cloud-msg">👥 {L(`${s.cloudOthers.map(o => o.device).join('、')}でも開いています。両方で編集すると、後から保存した方だけが残ります。`, `Also open on ${s.cloudOthers.map(o => o.device).join(', ')}. If both are edited, only the one saved last is kept.`)}</span>);
  if (s.cloudWaiting > 0) items.push(<span key="waiting" className="cloud-msg"><span className="spinner" /> {L(`MEGA の同期を待っています：${s.cloudWaiting}曲（届いたものから読み込みます）`, `Waiting for MEGA to sync ${s.cloudWaiting} track(s) (loaded as they arrive)`)}</span>);
  if (s.cloudCopy) items.push(<span key="copy" className="cloud-msg"><progress value={s.cloudCopy.done} max={s.cloudCopy.total} /> {L(`曲をクラウドフォルダにコピー中 ${s.cloudCopy.done + 1}/${s.cloudCopy.total}：${s.cloudCopy.name}`, `Copying tracks to the cloud folder ${s.cloudCopy.done + 1}/${s.cloudCopy.total}: ${s.cloudCopy.name}`)}</span>);
  if (s.cloudError) items.push(<span key="err" className="cloud-msg warn">✕ {L(`クラウドフォルダに保存できませんでした：${s.cloudError}`, `Could not save to the cloud folder: ${s.cloudError}`)}</span>);
  if (!items.length) return null;
  return <div className="cloud-bar">{items}</div>;
}

/** "☁ Saved" next to the mix name. */
export function CloudChip() {
  const s = useStore();
  if (!s.isCloudDocument()) return null;
  const text = s.cloudSaving ? L('保存中…', 'Saving…')
    : s.cloudRemote ? L('別の版あり', 'Newer version')
      : s.isDirty ? (s.cloudAutoSave ? L('まもなく自動保存', 'Saving soon') : L('未保存', 'Not saved'))
        : L('保存済み', 'Saved');
  return (
    <button className={`cloud-chip ${s.cloudRemote ? 'warn' : ''}`} onClick={() => { s.showCloud = true; s.changed(); }}
      title={L('MEGA の同期フォルダにあるミックスです（クリックでクラウドの画面）', 'This mix is in the MEGA sync folder (click for the cloud window)')}>
      ☁ {text}
    </button>
  );
}
