// The update in progress (main/updater.ts): a card at the bottom right with the steps, a progress bar, the amount
// downloaded, the speed and the time left, and — when it is ready — the choice of restarting now or at quit.
import React from 'react';
import { ipcRenderer } from 'electron';
import { L } from '../../core/i18n';
import { useStore } from '../hooks';
import type { UpdateStatus } from '../../main/updater';
import { Icon } from './Icons';

const mb = (b?: number) => (b == null ? '–' : (b / 1e6).toFixed(b < 1e8 ? 1 : 0));

export function timeLeft(sec?: number) {
  if (sec == null || !isFinite(sec)) return '';
  if (sec < 1) return L('まもなく', 'almost done');
  if (sec < 60) return L(`残り 約${Math.ceil(sec)}秒`, `about ${Math.ceil(sec)} s left`);
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return L(`残り 約${m}分${s ? `${s}秒` : ''}`, `about ${m} min ${s ? `${s} s ` : ''}left`);
}

/** Short text for the toolbar chip. */
export function updateChipText(u: UpdateStatus): string {
  const v = u.version ?? '';
  switch (u.stage) {
    case 'checking': return L('更新を確認中…', 'Checking…');
    case 'downloading': return L(`${v} をダウンロード中 ${u.total ? Math.floor((u.received ?? 0) / u.total * 100) : 0}%`, `Downloading ${v} ${u.total ? Math.floor((u.received ?? 0) / u.total * 100) : 0}%`);
    case 'verifying': return L(`${v} を確認中…`, `Verifying ${v}…`);
    case 'preparing': return L(`${v} を準備中…`, `Preparing ${v}…`);
    case 'ready': return L(`${v} の準備完了（終了時に更新）`, `${v} ready (installs at quit)`);
    case 'installing': return L('更新しています…', 'Updating…');
    case 'failed': return L('更新できませんでした', 'Update failed');
  }
}

export function UpdateCard() {
  const s = useStore();
  const u = s.updateStatus;
  if (!u || s.updateCardHidden) return null;
  const hide = () => { s.updateCardHidden = true; s.changed(); };
  const mac = process.platform === 'darwin';
  // The steps, in order (the Mac also takes the app out of the disk image).
  const steps: { id: UpdateStatus['stage']; title: string }[] = [
    { id: 'downloading', title: L('ダウンロード', 'Download') },
    { id: 'verifying', title: L('確認', 'Verify') },
    ...(mac ? [{ id: 'preparing' as const, title: L('準備', 'Prepare') }] : []),
    { id: 'ready', title: L('更新', 'Install') },
  ];
  const order = steps.map(x => x.id);
  const at = u.stage === 'installing' ? order.length - 1 : order.indexOf(u.stage);
  const fraction = u.stage === 'downloading' && u.total ? Math.min(1, (u.received ?? 0) / u.total) : u.stage === 'ready' || u.stage === 'installing' ? 1 : null;
  const busy = u.stage === 'checking' || u.stage === 'verifying' || u.stage === 'preparing' || u.stage === 'installing';
  const v = u.version ?? '';
  const title = (() => {
    switch (u.stage) {
      case 'checking': return L('新しい版を確認しています…', 'Checking for a new version…');
      case 'downloading': return L(`DJAW ${v} をダウンロードしています`, `Downloading DJAW ${v}`);
      case 'verifying': return L('ダウンロードしたファイルを確かめています…', 'Checking the download…');
      case 'preparing': return L('インストールの準備をしています…', 'Getting the update ready…');
      case 'ready': return L(`DJAW ${v} の準備ができました`, `DJAW ${v} is ready`);
      case 'installing': return L('DJAW を終了して更新します…', 'Closing DJAW to update…');
      case 'failed': return L('更新できませんでした', 'The update did not work');
    }
  })();
  const detail = (() => {
    switch (u.stage) {
      case 'downloading': return [
        `${mb(u.received)} / ${mb(u.total)} MB`,
        u.speed ? L(`${mb(u.speed)} MB/秒`, `${mb(u.speed)} MB/s`) : null,
        timeLeft(u.eta),
      ].filter(Boolean).join(' · ');
      case 'verifying': return L('壊れていないか（SHA-256）を確かめています。数秒かかります', 'Comparing its SHA-256 with GitHub’s. A few seconds');
      case 'preparing': return L('ディスクイメージからアプリを取り出して、署名を確かめています。数十秒かかることがあります', 'Taking the app out of the disk image and checking its signature. Can take half a minute');
      case 'ready': return L('今すぐ再起動するか、DJAW を終了するときに入れ替えます。保存していない変更は、先に保存するか確認します', 'Restart now, or it is installed when DJAW quits. You will be asked to save unsaved changes first');
      case 'installing': return mac ? L('数秒後に新しい DJAW が起動します', 'The new DJAW starts in a few seconds')
        : L('DJAW が閉じてから 10〜20 秒ほどで、新しい DJAW が起動します', 'The new DJAW starts 10–20 seconds after this one closes');
      case 'failed': return u.error ?? '';
      default: return '';
    }
  })();
  return (
    <div className={'update-card' + (u.stage === 'failed' ? ' failed' : '')} role="status">
      <div className="update-card-head">
        <Icon name={u.stage === 'failed' ? 'close' : 'export'} size={15} />
        <b>{title}</b>
        <div className="spacer" />
        {u.stage !== 'installing' && <button className="tbtn icon small" title={L('隠す（ツールバーから戻せます）', 'Hide (bring it back from the toolbar)')} onClick={hide}><Icon name="chevronDown" size={14} /></button>}
      </div>
      {u.stage !== 'checking' && u.stage !== 'failed' && (
        <div className="update-steps">
          {steps.map((st, k) => <span key={st.id} className={k < at ? 'done' : k === at ? 'now' : ''}>{k < at ? '✓ ' : `${k + 1}. `}{st.title}</span>)}
        </div>
      )}
      {u.stage !== 'failed' && (
        <div className={'update-bar' + (busy ? ' busy' : '')}>
          <div style={{ width: fraction != null ? `${fraction * 100}%` : undefined }} />
        </div>
      )}
      <div className="update-detail">
        {u.stage === 'downloading' && <b className="pct">{Math.floor((fraction ?? 0) * 100)}%</b>}
        <span>{detail}</span>
      </div>
      {u.stage === 'ready' && (
        <div className="update-actions">
          <button className="btn primary" onClick={() => ipcRenderer.send('update:restart')}>{L('今すぐ再起動して更新', 'Restart and Update Now')}</button>
          <button className="btn" onClick={hide}>{L('終了するときに更新', 'Update When DJAW Quits')}</button>
        </div>
      )}
      {u.stage === 'failed' && (
        <div className="update-actions">
          <button className="btn primary" onClick={() => ipcRenderer.send('update:retry')}>{L('もう一度', 'Try Again')}</button>
          <button className="btn" onClick={() => { s.updateStatus = null; s.changed(); }}>{L('閉じる', 'Close')}</button>
        </div>
      )}
    </div>
  );
}
