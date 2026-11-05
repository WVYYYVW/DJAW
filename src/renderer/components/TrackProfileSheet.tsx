// Edit a track's profile: artwork, title, artist, album, year, genre, label and notes
// (mac/DJAW/Views/TrackProfileSheet.swift).
import React, { useEffect, useState } from 'react';
import fs from 'node:fs';
import { clipboard, ipcRenderer, nativeImage } from 'electron';
import { L } from '../../core/i18n';
import { useStore } from '../hooks';
import { Fmt, clipColor } from '../format';
import { TrackProfile, TrackProfiles } from '../store/profiles';

export function ArtworkThumb({ url, colorIndex, size, onClick }: { url: string; colorIndex: number; size: number; onClick?: () => void }) {
  const s = useStore();
  const img = s.artwork(url);
  const ref = React.useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr; c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (img) {
      const k = Math.max(c.width / img.width, c.height / img.height);
      const w = img.width * k, h = img.height * k;
      ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    }
  }, [img, size]);
  return (
    <div className="artwork-thumb" style={{ width: size, height: size, borderColor: clipColor(colorIndex), background: clipColor(colorIndex, 0.3) }} onClick={onClick}
      title={onClick ? L('曲の情報（ジャケット・アーティスト）を編集…', 'Edit Track Info (Artwork, Artist)…') : undefined}>
      {img ? <canvas ref={ref} style={{ width: size, height: size }} /> : <span style={{ color: clipColor(colorIndex) }}>♪</span>}
    </div>
  );
}

export function TrackProfileSheet() {
  const s = useStore();
  const clip = s.profileEditorTarget ? s.clip(s.profileEditorTarget) : null;
  const [draft, setDraft] = useState<TrackProfile>({ title: '', artist: '' });
  const [fileArt, setFileArt] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const close = () => { s.profileEditorTarget = null; s.changed(); };
  useEffect(() => {
    if (!clip) return;
    setDraft({ album: '', year: '', genre: '', label: '', comment: '', ...s.trackProfile(clip.url, clip.title, clip.artist) });
    void TrackProfiles.embeddedArtwork(clip.url).then(d => setFileArt(d ? URL.createObjectURL(new Blob([d])) : null));
  }, [clip?.url]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  if (!clip) return null;
  const shown = draft.noArtwork ? null : draft.artwork ? `data:image/jpeg;base64,${draft.artwork}` : fileArt;
  const setArtwork = async (data: Uint8Array | Blob) => {
    const jpeg = await TrackProfiles.normalizedJPEG(data);
    if (!jpeg) { setMessage(L('この画像は読み込めませんでした', 'Could not read that image')); return; }
    setMessage(null);
    setDraft(d => ({ ...d, artwork: jpeg, noArtwork: null }));
  };
  const choose = async () => {
    const r = await ipcRenderer.invoke('dialog:open', { properties: ['openFile'], filters: [{ name: L('画像', 'Images'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }] });
    if (r?.[0]) await setArtwork(new Uint8Array(fs.readFileSync(r[0])));
  };
  const paste = async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) { setMessage(L('クリップボードに画像がありません', 'No image on the clipboard')); return; }
    await setArtwork(new Uint8Array(img.toPNG()));
  };
  void nativeImage;
  const field = (k: keyof TrackProfile, label: string, multi = false) => (
    <div className="form-row">
      <span className="form-label">{label}</span>
      {multi
        ? <textarea className="notes" rows={3} value={(draft[k] as string) ?? ''} onChange={e => setDraft({ ...draft, [k]: e.target.value })} onKeyDown={e => e.stopPropagation()} />
        : <input className="text" value={(draft[k] as string) ?? ''} onChange={e => setDraft({ ...draft, [k]: e.target.value })} onKeyDown={e => e.stopPropagation()} />}
    </div>
  );
  return (
    <div className="sheet-backdrop">
      <div className="sheet profile">
        <div className="sheet-title">{L('曲の情報', 'Track Info')}</div>
        <div className="profile-body">
          <div className="artwork-col">
            <div className={'artwork-well' + (dropping ? ' dropping' : '')} style={{ background: clipColor(clip.colorIndex, 0.25) }}
              onDragOver={e => { e.preventDefault(); setDropping(true); }} onDragLeave={() => setDropping(false)}
              onDrop={e => { e.preventDefault(); setDropping(false); const f = e.dataTransfer.files[0]; if (f) void setArtwork(f); }}>
              {shown ? <img src={shown} alt="" /> : <div className="dim">🖼<div className="caption">{L('画像をドロップ', 'Drop an image')}</div></div>}
            </div>
            <div className="button-row small">
              <button className="btn" onClick={choose}>{L('選ぶ…', 'Choose…')}</button>
              <button className="btn" onClick={paste}>{L('貼り付け', 'Paste')}</button>
            </div>
            <div className="button-row small">
              {(draft.artwork || draft.noArtwork) && <button className="btn" disabled={!fileArt && !draft.noArtwork} onClick={() => setDraft({ ...draft, artwork: null, noArtwork: null })}>{L('ファイルの画像に戻す', 'Use File’s Artwork')}</button>}
              {shown && <button className="btn" onClick={() => setDraft({ ...draft, artwork: null, noArtwork: true })}>{L('画像なし', 'No Artwork')}</button>}
            </div>
          </div>
          <div className="form grow">
            {field('title', L('曲名', 'Title'))}
            {field('artist', L('アーティスト', 'Artist'))}
            {field('album', L('アルバム', 'Album'))}
            {field('year', L('年', 'Year'))}
            {field('genre', L('ジャンル', 'Genre'))}
            {field('label', L('レーベル', 'Label'))}
            {field('comment', L('メモ', 'Notes'), true)}
            <div className="form-row"><span className="form-label">{L('ファイル', 'File')}</span><span className="dim ellipsis">{clip.url.split(/[\\/]/).pop()}</span></div>
            <div className="form-row"><span className="form-label">BPM</span><span className="dim mono">{Fmt.bpm(clip.bpm)}</span></div>
          </div>
        </div>
        <div className="caption">{L('ここで決めた情報は、デッキ・曲リスト・演奏手順・映像の書き出しに使われ、同じ曲を使う他のミックスにも引き継がれます（曲ファイル自体は書き換えません）。', 'This info is used on the decks, in the track list, the playing guide and video exports, and carries over to other mixes using the same track (the audio file itself is not changed).')}</div>
        <div className="button-row end">
          {message && <span className="caption warn">{message}</span>}
          <div className="spacer" />
          <button className="btn" onClick={close}>{L('キャンセル', 'Cancel')}</button>
          <button className="btn primary" onClick={() => { s.saveProfile(draft, clip.url); close(); }}>{L('保存', 'Save')}</button>
        </div>
      </div>
    </div>
  );
}
