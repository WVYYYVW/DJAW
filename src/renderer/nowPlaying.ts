// The track you hear at a moment of the mix (the loudest of the tracks playing then; the newer one on a tie) and
// where in it the mix is: the time a DJ player would show for that track.
import { Clip, clipEnd, sourceTimeAtTimeline } from '../core/models';
import { Automation } from '../core/automation';
import { store } from './store/store';

export interface NowPlaying { clip: Clip; index: number; sourceTime: number }

export function nowPlaying(t: number): NowPlaying | null {
  const clips = store.clips, master = store.masterBPM;
  let best: NowPlaying | null = null, loudest = -1;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c.start > t || t > clipEnd(c, master)) continue;
    const v = Automation.state(clips, i, t, master).volume;
    if (v >= loudest - 1e-6) { loudest = v; best = { clip: c, index: i, sourceTime: sourceTimeAtTimeline(c, t, master) }; }
  }
  return best;
}
