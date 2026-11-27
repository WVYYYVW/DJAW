// How the video visuals show each track's name: on or off, the format, how long it stays up, and the small caption
// afterwards. The same settings in the video export sheet and the live preview window.
import React from 'react';
import { L } from '../../core/i18n';
import { TrackInfoDurations, TrackInfoStyle, TrackInfoStyles, trackInfoDurations, trackInfoStyles } from '../../core/visuals';
import { useStore } from '../hooks';

export function TrackInfoOptions({ compact }: { compact?: boolean }) {
  const s = useStore();
  const set = s.visualInfo, off = !s.visualShowInfo;
  const update = (p: Partial<typeof set>) => { s.visualInfo = { ...set, ...p }; s.saveSettings(); s.changed(); };
  const durations = trackInfoDurations.includes(set.seconds) ? trackInfoDurations : [...trackInfoDurations, set.seconds].sort((a, b) => (a || 1e9) - (b || 1e9));
  const toggle = <label className={compact ? undefined : 'check'}>
    <input type="checkbox" checked={s.visualShowInfo} onChange={() => { s.visualShowInfo = !s.visualShowInfo; s.changed(); }} />
    {compact ? L('曲名カード', 'Track cards') : L('曲が変わるたびにジャケット・曲名・アーティストを表示', 'Show artwork, title and artist when each track starts')}
  </label>;
  const style = <select className="track-info-style" value={set.style} disabled={off} title={L('曲名の表示形式', 'How the track name is shown')}
    onChange={e => update({ style: e.target.value as TrackInfoStyle })} style={compact ? { maxWidth: 260 } : undefined}>
    {trackInfoStyles.map(v => <option key={v} value={v}>{TrackInfoStyles.title(v)}</option>)}
  </select>;
  const seconds = <select className="track-info-seconds" value={set.seconds} disabled={off || set.style === 'caption'} title={L('表示する長さ', 'How long it stays up')}
    onChange={e => update({ seconds: Number(e.target.value) })}>
    {durations.map(d => <option key={d} value={d}>{TrackInfoDurations.title(d)}</option>)}
  </select>;
  const caption = <label className={compact ? undefined : 'check'} title={L('カードが消えた後、曲名を画面の隅に小さく残す', 'After the card goes, keep the name small in the corner')}>
    <input type="checkbox" checked={set.caption} disabled={off || set.style === 'caption'} onChange={() => update({ caption: !set.caption })} />
    {L('後に小さく残す', 'Keep a small caption')}
  </label>;
  if (compact) return <>{toggle}{style}{seconds}{caption}</>;
  return <>
    {toggle}
    <div className="form-row"><span className="form-label">{L('曲名の表示', 'Track names')}</span>{style}{' '}{seconds}</div>
    <div className="form-row"><span className="form-label" />{caption}</div>
  </>;
}
