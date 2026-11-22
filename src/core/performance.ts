// Port of mac/DJAW/Model/PerformanceGuide.swift: step-by-step instructions for playing a finished mix live on two
// decks and a mixer, and the track list (for SoundCloud descriptions and the like).
import { L } from './i18n';
import { Automation, Curve } from './automation';
import { Clip, Edit, Style, barAtSource, barAtTimeline, clipEnd, keepsKey, playSegments, sourceTimeAtBar, timelineTimeOfBar, timelineTimeOfSource } from './models';
import { FX, TempoMap, tempoRampBars, tempoStartBars } from './tempo';

export interface GuideStep { time: number; position: string; deck: string | null; text: string; isPrep?: boolean }
export interface GuideTrack { number: number; deck: string; title: string; setup: string[]; steps: GuideStep[] }
export interface Guide { overview: string[]; tracks: GuideTrack[] }

const F = {
  time(t: number) { const s = Math.max(0, t), m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; },
  duration(t: number) {
    const s = Math.round(Math.max(0, t));
    const p = (n: number) => String(n).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
  },
  bpm(b: number) { if (!(b > 0)) return '—'; return Math.abs(b - Math.round(b)) < 0.005 ? b.toFixed(0) : b.toFixed(2); },
};

const deck = (i: number) => (i % 2 === 0 ? 'A' : 'B');
const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 0.05 ? `${Math.round(v)}` : v.toFixed(1));
const fmtBeats = (beats: number) => (beats >= 4 && Math.abs(beats / 4 - Math.round(beats / 4)) < 0.01 ? L(`${Math.round(beats / 4)}小節`, `${Math.round(beats / 4)} bars`) : L(`${fmt(beats)}拍`, `${fmt(beats)} beats`));
const pitchText = (p: number) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
const end = (c: Clip, m: number) => clipEnd(c, m);

export const PerformanceGuide = {
  timeText: (t: number) => F.time(t),

  displayName(c: Clip) {
    const title = c.title.trim(), artist = c.artist.trim();
    if (!artist || title.toLowerCase().includes(artist.toLowerCase())) return title;
    return `${artist} - ${title}`;
  },

  /** 0:00 / 1:02:03 (SoundCloud turns these into links). */
  stamp(t: number, long: boolean) {
    const s = Math.floor(Math.max(0, t));
    const p = (n: number) => String(n).padStart(2, '0');
    return long || s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
  },

  /** "0:00 Artist - Title" per track, at the moment each track takes over (Automation.switchTime). */
  trackList(clips: Clip[], master: number, tempo: TempoMap, numbered = false) {
    const long = Math.max(0, ...clips.map(c => tempo.real(end(c, master)))) >= 3600;
    return clips.map((c, k) => {
      const t = k === 0 ? 0 : tempo.real(Automation.switchTime(clips, k, master));
      return (numbered ? `${k + 1}. ` : '') + PerformanceGuide.stamp(t, long) + ' ' + PerformanceGuide.displayName(c);
    }).join('\n');
  },

  /** 1-based "bar.beat" for a 0-based bar position. */
  barBeat(b: number) {
    const bb = Math.round(b * 4) / 4;
    const bar = Math.floor(bb);
    const beat = Math.round((bb - bar) * 4) + 1;
    return `${bar + 1}.${Math.min(4, beat)}`;
  },

  /** `sampler`: the sounds placed with the sampler (timeline time), played from a sampler / pad on the gear. */
  build(clips: Clip[], master: number, tempo: TempoMap, sampler: { name: string; time: number; repeats: number; every: number }[] = []): Guide {
    const tracks = clips.map((_, i) => track(i, clips, master, tempo));
    for (const h of sampler) {
      let k = -1;
      clips.forEach((c, i) => { if (c.start <= h.time + 1e-6) k = i; });
      if (k < 0) continue;
      const roll = h.repeats > 0 ? L(`（${h.every >= 1 ? `${h.every}拍` : `1/${Math.round(1 / h.every)}拍`}ごとに${h.repeats + 1}回）`, ` (${h.repeats + 1}× every ${h.every >= 1 ? `${h.every} beat${h.every > 1 ? 's' : ''}` : `1/${Math.round(1 / h.every)} beat`})`) : '';
      tracks[k].steps.push({ time: tempo.real(h.time), position: pos(clips[k], deck(k), h.time, master), deck: null, text: L(`サンプラー：「${h.name}」${roll}`, `Sampler: “${h.name}”${roll}`) });
      tracks[k].steps.sort((a, b) => a.time - b.time);
    }
    const e = Math.max(0, ...clips.map(c => tempo.real(end(c, master))));
    const overview = [
      L(`曲数：${clips.length}曲　長さ：${F.duration(e)}　デッキ：2台（A・B を交互に使用）＋ミキサー`, `${clips.length} tracks · ${F.duration(e)} · two decks (A and B in turn) and a mixer`),
      L('位置は「デッキ 小節.拍」（例：A 57.1 = デッキAの曲の57小節目の1拍目）。小節は DJAW のグリッドの番号です。', 'Positions are “deck bar.beat” (A 57.1 = bar 57, beat 1 of the track on deck A), numbered as on DJAW’s grid.'),
      L('EQ は「12時 = 0 dB」「絞り切り = カット」。フェーダーはチャンネルフェーダー（クロスフェーダーは中央のまま）。', 'EQ: “12 o’clock” = 0 dB, “off” = fully cut. Faders are the channel faders (leave the crossfader in the middle).'),
    ];
    if (sampler.length) overview.push(L(`サンプラーの音を${new Set(sampler.map(h => h.name)).size}種類使います。機材のサンプラー（またはパッド）に読み込んでおいてください。`, `Uses ${new Set(sampler.map(h => h.name)).size} sampler sound(s): load them into the gear’s sampler (or pads) beforehand.`));
    if (tempo.points.length > 1 || clips.some(c => c.tempo != null)) {
      overview.push(L('途中で BPM が変わります。ピッチ（テンポ）フェーダーを手順どおりに動かしてください。', 'The tempo changes during the set: move the pitch faders as described.'));
    }
    return { overview, tracks };
  },

  text(g: Guide) {
    const out = [L('■ 演奏手順', '■ How to play this set'), '', ...g.overview.map(x => '・' + x)];
    for (const t of g.tracks) {
      out.push('', `${t.number}. [${L('デッキ', 'Deck')} ${t.deck}] ${t.title}`);
      out.push(...t.setup.map(x => '   - ' + x));
      for (const s of t.steps) out.push(`   ${F.time(s.time)}  ${s.position}  ${s.isPrep ? L('（準備）', '(prep) ') : ''}${s.text}`);
    }
    return out.join('\n');
  },
};

const BB = PerformanceGuide.barBeat;
const pos = (c: Clip, d: string, t: number, master: number) => `${d} ${BB(barAtTimeline(c, t, master))}`;
const pitch = (c: Clip, tempo: TempoMap, t: number) => (!c.tempoSync || c.bpm <= 1 ? 0 : (tempo.bpm(t) / c.bpm - 1) * 100);

function track(i: number, clips: Clip[], master: number, tempo: TempoMap): GuideTrack {
  const c = clips[i];
  const d = deck(i);
  const setup: string[] = [];
  const bpmHere = tempo.bpm(c.start + 0.001);
  if (c.tempoSync) {
    setup.push(L(`曲の BPM ${F.bpm(c.bpm)} → ピッチ ${pitchText(pitch(c, tempo, c.start + 0.001))}（${F.bpm(bpmHere)} BPM で再生）`, `Track BPM ${F.bpm(c.bpm)} → pitch ${pitchText(pitch(c, tempo, c.start + 0.001))} (plays at ${F.bpm(bpmHere)} BPM)`));
  } else setup.push(L('ピッチ 0%（テンポは合わせない）', 'Pitch 0% (not tempo-matched)'));
  setup.push(keepsKey(c) ? L('マスターテンポ（キーロック）ON', 'Master tempo (key lock) ON') : L('マスターテンポ（キーロック）OFF', 'Master tempo (key lock) OFF'));
  const k = c.keyShift ?? 0;
  if (k !== 0) setup.push(L(`キーを ${k > 0 ? '+' : ''}${k} 半音`, `Key ${k > 0 ? '+' : ''}${k} semitones`));
  const cueSource = playSegments(c)[0]?.from ?? c.trimStart;
  setup.push(L(`CUE：${F.time(cueSource)}（${BB(barAtSource(c, cueSource))}）`, `CUE: ${F.time(cueSource)} (${BB(barAtSource(c, cueSource))})`));
  const trim = c.gainDB + (c.loudnessGainDB ?? 0);
  if (Math.abs(trim) >= 0.5) setup.push(L(`TRIM（ゲイン）${trim >= 0 ? '+' : ''}${trim.toFixed(1)} dB`, `Trim (gain) ${trim >= 0 ? '+' : ''}${trim.toFixed(1)} dB`));
  const eqBase = ([['LOW', c.eqLow], ['MID', c.eqMid], ['HIGH', c.eqHigh]] as [string, number][]).filter(([, v]) => Math.abs(v) >= 0.5);
  if (eqBase.length) setup.push(L('EQ の基本位置：', 'EQ base: ') + eqBase.map(([n, v]) => `${n} ${v >= 0 ? '+' : ''}${v.toFixed(0)} dB`).join('・'));
  for (const e of [...(c.edits ?? [])].sort((a, b) => a.bar - b.bar)) {
    setup.push(e.kind === 'loop'
      ? L(`ループ：${BB(e.bar)}〜 ${Edit.lengthLabel(e)} を ${e.repeats + 1}回（ループ IN をホットキューに）`, `Loop: from ${BB(e.bar)}, ${Edit.lengthLabel(e)}, ${e.repeats + 1}× (put loop-in on a hot cue)`)
      : L(`ジャンプ：${BB(e.bar)} から ${BB(Edit.end(e))} へ（飛び先をホットキューに）`, `Jump: from ${BB(e.bar)} to ${BB(Edit.end(e))} (put the target on a hot cue)`));
  }
  let steps: GuideStep[] = [];
  if (i === 0) {
    steps.push({ time: tempo.real(c.start), position: pos(c, d, c.start, master), deck: d, text: L(`デッキ${d} PLAY（フェーダー 100%、EQ はすべて12時）`, `Deck ${d} PLAY (fader 100%, all EQs at 12 o’clock)`) });
    if (c.fadeInBeats > 0) steps.push({ time: tempo.real(c.start), position: pos(c, d, c.start, master), deck: d, text: L(`フェーダーを0から ${fmtBeats(c.fadeInBeats)} かけて上げる`, `Bring the fader up from 0 over ${fmtBeats(c.fadeInBeats)}`) });
  } else {
    steps.push(...transitionSteps(i, clips, master, tempo));
  }
  steps.push(...fxSteps(c, d, master, tempo), ...editSteps(c, d, master, tempo));
  if (i === clips.length - 1) {
    const e = end(c, master);
    if (c.fadeOutBeats > 0) {
      const t0 = e - c.fadeOutBeats * 60 / Math.max(master, 1);
      steps.push({ time: tempo.real(t0), position: pos(c, d, t0, master), deck: d, text: L(`フェーダーを ${fmtBeats(c.fadeOutBeats)} かけて0まで下げる`, `Fade the fader out to 0 over ${fmtBeats(c.fadeOutBeats)}`) });
    }
    steps.push({ time: tempo.real(e), position: pos(c, d, e, master), deck: d, text: L(`デッキ${d} STOP（セット終了）`, `Deck ${d} STOP (end of the set)`) });
  }
  steps = steps.map((s, k) => ({ s, k })).sort((a, b) => a.s.time - b.s.time || a.k - b.k).map(x => x.s);
  return { number: i + 1, deck: d, title: PerformanceGuide.displayName(c), setup, steps };
}

type Control = 'volume' | 'low' | 'mid' | 'high' | 'filter' | 'echo' | 'reverb' | 'vocal' | 'instrumental' | 'drums' | 'bass' | 'melody';
const controls: Control[] = ['volume', 'low', 'mid', 'high', 'filter', 'echo', 'reverb', 'vocal', 'instrumental', 'drums', 'bass', 'melody'];
const controlName = (k: Control) => ({ volume: L('フェーダー', 'fader'), low: 'LOW', mid: 'MID', high: 'HIGH', filter: L('フィルター', 'FILTER'), echo: L('エコー', 'ECHO'), reverb: L('リバーブ', 'REVERB'), vocal: L('STEMS ボーカル', 'STEMS vocals'), instrumental: L('STEMS 伴奏', 'STEMS instrumental'), drums: L('STEMS ドラム', 'STEMS drums'), bass: L('STEMS ベース', 'STEMS bass'), melody: L('STEMS メロディ', 'STEMS melody') })[k];
const value = (cv: Curve, k: Control) => ({ volume: cv.volume, low: 1 - cv.lowKill, mid: 1 - cv.midKill, high: 1 - cv.highKill, filter: cv.filter, echo: cv.fxEcho, reverb: cv.fxReverb, vocal: cv.vocal, instrumental: cv.instrumental, drums: cv.drums, bass: cv.bass, melody: cv.melody })[k];
function level(k: Control, v: number) {
  switch (k) {
    case 'volume': case 'echo': case 'reverb': case 'vocal': case 'instrumental': case 'drums': case 'bass': case 'melody':
      if ((k === 'echo' || k === 'reverb') && v <= 0.01) return 'OFF';
      return `${Math.round(v * 100)}%`;
    case 'filter':
      if (Math.abs(v) < 0.02) return L('センター', 'centre');
      return v < 0 ? L(`ローパス ${Math.round(-v * 100)}%`, `LPF ${Math.round(-v * 100)}%`) : L(`ハイパス ${Math.round(v * 100)}%`, `HPF ${Math.round(v * 100)}%`);
    default:
      if (v >= 0.97) return L('12時', '12 o’clock');
      if (v <= 0.03) return L('絞り切り', 'off');
      return `${Math.round(v * 100)}%`;
  }
}

function transitionSteps(i: number, clips: Clip[], master: number, tempo: TempoMap): GuideStep[] {
  const c = clips[i], prev = clips[i - 1];
  const dIn = deck(i), dOut = deck(i - 1);
  const start = c.start;
  const len = Math.min(end(prev, master), end(c, master)) - start;
  const at = (t: number) => `${pos(prev, dOut, t, master)} / ${pos(c, dIn, t, master)}`;
  const steps: GuideStep[] = [];
  const style = c.transition;
  const leadIn = Math.max(0, start - 16 * 240 / Math.max(master, 1));
  let ready = L(`デッキ${dIn} を準備：CUE に合わせ、ピッチ ${pitchText(pitch(c, tempo, start + 0.001))}`, `Get deck ${dIn} ready: at the cue, pitch ${pitchText(pitch(c, tempo, start + 0.001))}`);
  if (!Style.isCutLike(style) && style !== 'echoOut' && len > 0.001) {
    const cv = Automation.incomingCurve(c, 0);
    ready += L(`、フェーダー ${level('volume', value(cv, 'volume'))}、`, `, fader ${level('volume', value(cv, 'volume'))}, `)
      + (['low', 'mid', 'high'] as Control[]).map(k => `${controlName(k)} ${level(k, value(cv, k))}`).join('・');
  } else ready += L('、フェーダー 0%（EQ は12時）', ', fader 0% (EQs at 12 o’clock)');
  steps.push({ time: tempo.real(leadIn), position: pos(prev, dOut, leadIn, master), deck: dIn, text: ready, isPrep: true });
  switch (style) {
    case 'cut':
      steps.push({ time: tempo.real(start), position: at(start), deck: dIn, text: L(`デッキ${dIn} PLAY と同時にフェーダーを切り替え（${dIn} を100%、${dOut} を0%）`, `Deck ${dIn} PLAY and swap the faders at once (${dIn} to 100%, ${dOut} to 0%)`) });
      break;
    case 'echoOut': {
      const t0 = start - 60 / Math.max(master, 1);
      steps.push({ time: tempo.real(t0), position: pos(prev, dOut, t0, master), deck: dOut, text: L(`デッキ${dOut} にエコー ON（1拍前から）`, `Echo ON on deck ${dOut} (one beat early)`) });
      steps.push({ time: tempo.real(start), position: at(start), deck: dIn, text: L(`デッキ${dOut} のフェーダーを0%（エコーの残響だけ残す）＋ デッキ${dIn} PLAY・フェーダー100%`, `Deck ${dOut} fader to 0% (only the echo rings on) + deck ${dIn} PLAY, fader 100%`) });
      break;
    }
    case 'brake': case 'backspin': {
      const beats = c.spinBeats ?? Style.defaultSpinBeats(style);
      const t0 = start - beats * 60 / Math.max(master, 1);
      steps.push({ time: tempo.real(t0), position: pos(prev, dOut, t0, master), deck: dOut, text: style === 'brake'
        ? L(`デッキ${dOut} を STOP（ブレーキ：約${fmt(beats)}拍で止まる設定）`, `Deck ${dOut} STOP (brake: stops over about ${fmt(beats)} beats)`)
        : L(`デッキ${dOut} をバックスピン（ジョグを逆回し、約${fmt(beats)}拍）`, `Backspin deck ${dOut} (spin the jog backwards, about ${fmt(beats)} beats)`) });
      steps.push({ time: tempo.real(start), position: at(start), deck: dIn, text: L(`デッキ${dIn} PLAY・フェーダー100%、デッキ${dOut} のフェーダーを0%`, `Deck ${dIn} PLAY, fader 100%; deck ${dOut} fader to 0%`) });
      break;
    }
    default:
      steps.push({ time: tempo.real(start), position: at(start), deck: dIn, text: L(`デッキ${dIn} PLAY（${dOut} の ${BB(barAtTimeline(prev, start, master))} ぴったりで）`, `Deck ${dIn} PLAY (exactly on ${dOut} ${BB(barAtTimeline(prev, start, master))})`) });
      if (len > 0.001) steps.push(...curveSteps(c, prev, dIn, dOut, start, len, master, tempo));
  }
  if (c.tempo != null) {
    const target = c.tempo;
    // Where the change starts (where the track comes in, after the transition, or some bars later) and how long it takes.
    const t0 = Math.max(start, timelineTimeOfBar(c, c.mixInBar + tempoStartBars(c), master));
    const from = tempo.bpm(Math.max(0, t0 - 0.01));
    if (Math.abs(target - from) > 0.01) {
      const bars = Math.max(0, tempoRampBars(c));
      const t1 = t0 + bars * 240 / Math.max(master, 1);
      // After the transition only this track is still playing: one pitch fader.
      const prevPlaying = clipEnd(prev, master) > t0 + 0.01;
      const pa0 = pitch(prev, tempo, Math.max(0, t0 - 0.01)), pa1 = pitch(prev, tempo, t1);
      const pb0 = pitch(c, tempo, t0 + 0.001), pb1 = pitch(c, tempo, t1);
      const text = bars <= 0.01
        ? L(`BPM を ${F.bpm(from)} → ${F.bpm(target)} に一気に変更（デッキ${dIn} ピッチ ${pitchText(pb1)}）`, `Tempo jumps ${F.bpm(from)} → ${F.bpm(target)} (deck ${dIn} pitch ${pitchText(pb1)})`)
        : prevPlaying
          ? L(`BPM を ${fmt(bars)}小節かけて ${F.bpm(from)} → ${F.bpm(target)} へ：両方のピッチフェーダーを同時に動かす（${dOut} ${pitchText(pa0)}→${pitchText(pa1)}、${dIn} ${pitchText(pb0)}→${pitchText(pb1)}）`,
            `Tempo ${F.bpm(from)} → ${F.bpm(target)} over ${fmt(bars)} bars: move both pitch faders together (${dOut} ${pitchText(pa0)}→${pitchText(pa1)}, ${dIn} ${pitchText(pb0)}→${pitchText(pb1)})`)
          : L(`BPM を ${fmt(bars)}小節かけて ${F.bpm(from)} → ${F.bpm(target)} へ：デッキ${dIn} のピッチフェーダーを ${pitchText(pb0)} → ${pitchText(pb1)} にゆっくり動かす`,
            `Tempo ${F.bpm(from)} → ${F.bpm(target)} over ${fmt(bars)} bars: slowly move deck ${dIn}'s pitch fader ${pitchText(pb0)} → ${pitchText(pb1)}`);
      steps.push({ time: tempo.real(t0), position: at(t0), deck: null, text });
    }
  }
  const sw = Automation.switchTime(clips, i, master);
  steps.push({ time: tempo.real(sw), position: at(sw), deck: dIn, text: L(`ここでデッキ${dIn}の曲に切り替わる（曲リストの時刻）`, `Deck ${dIn} takes over here (the time in the track list)`) });
  const outEnd = end(prev, master);
  steps.push({ time: tempo.real(outEnd), position: pos(prev, dOut, outEnd, master), deck: dOut, text: L(`デッキ${dOut} STOP、EQ を12時に戻して次の曲を読み込む`, `Deck ${dOut} STOP, EQs back to 12 o’clock, load the next track`) });
  return steps;
}

function curveSteps(c: Clip, prev: Clip, dIn: string, dOut: string, start: number, len: number, master: number, tempo: TempoMap): GuideStep[] {
  const barsTotal = Math.max(0.25, len * Math.max(master, 1) / 240);
  const n = Math.max(64, Math.trunc(barsTotal * 16));
  const moves = (incoming: boolean, k: Control) => {
    const vals: number[] = [];
    for (let s = 0; s <= n; s++) {
      const x = s / n;
      vals.push(value(incoming ? Automation.incomingCurve(c, x) : Automation.outgoingCurve(c, x), k));
    }
    const out: { x0: number; x1: number; v0: number; v1: number }[] = [];
    let s = 0;
    const eps = 1e-5;
    const maxPause = Math.max(1, Math.trunc(n / barsTotal / 8));
    while (s < n) {
      if (Math.abs(vals[s + 1] - vals[s]) <= eps) { s++; continue; }
      const up = vals[s + 1] > vals[s];
      let e = s + 1, pause = 0, lastMoving = e;
      while (e < n) {
        const dv = vals[e + 1] - vals[e];
        if (Math.abs(dv) <= eps) { pause++; if (pause > maxPause) break; }
        else if ((dv > 0) === up) { pause = 0; lastMoving = e + 1; }
        else break;
        e++;
      }
      const v0 = vals[s], v1 = vals[lastMoving];
      const total = Math.abs(v1 - v0);
      if (total >= 0.05) {
        let a = s, b = lastMoving;
        for (let j = s; j <= lastMoving; j++) if (Math.abs(vals[j] - v0) >= 0.02 * total) { a = j; break; }
        for (let j = s; j <= lastMoving; j++) if (Math.abs(vals[j] - v0) >= 0.97 * total) { b = j; break; }
        out.push({ x0: Math.max(s, a - 1) / n, x1: b / n, v0, v1 });
      }
      s = lastMoving;
    }
    return out;
  };
  const items: { x0: number; deck: string; text: string }[] = [];
  for (const [incoming, d] of [[true, dIn], [false, dOut]] as [boolean, string][]) {
    for (const k of controls) {
      for (const m of moves(incoming, k)) {
        const raw = (m.x1 - m.x0) * barsTotal;
        const bars = raw < 1 ? Math.round(raw * 4) / 4 : Math.round(raw * 2) / 2;
        const how = raw <= 0.3 ? L('一気に', 'at once') : L(`${fmt(bars)}小節かけて`, `over ${fmt(bars)} bars`);
        items.push({ x0: m.x0, deck: d, text: L(`${controlName(k)} ${level(k, m.v0)}→${level(k, m.v1)}（${how}）`, `${controlName(k)} ${level(k, m.v0)} → ${level(k, m.v1)} (${how})`) });
      }
    }
  }
  const groups = new Map<number, typeof items>();
  for (const it of items) {
    const key = Math.round(it.x0 * barsTotal * 4) / 4;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([barOffset, g]) => {
    const t = start + barOffset / barsTotal * len;
    const parts: string[] = [];
    for (const d of [dIn, dOut]) {
      const gd = g.filter(x => x.deck === d);
      if (gd.length) parts.push(L(`デッキ${d}：`, `Deck ${d}: `) + gd.map(x => x.text).join(L('、', ', ')));
    }
    return { time: tempo.real(t), position: `${pos(prev, dOut, t, master)} / ${pos(c, dIn, t, master)}`, deck: null, text: parts.join(L('　', '  ')) };
  });
}

function fxSteps(c: Clip, d: string, master: number, tempo: TempoMap): GuideStep[] {
  if (!c.fx?.length) return [];
  const start = c.start, e = end(c, master);
  const steps: GuideStep[] = [];
  for (const f of [...c.fx].sort((a, b) => a.bar - b.bar)) {
    const t = timelineTimeOfBar(c, f.bar, master);
    if (!(t < e - 0.01 && timelineTimeOfBar(c, f.bar + f.bars, master) > start + 0.01)) continue;
    const amount = Math.round(f.amount * 100);
    const shape = ({ hold: L(`${amount}% で一定`, `steady at ${amount}%`), rise: L(`0→${amount}% へだんだん強く`, `build 0 → ${amount}%`), fall: L(`${amount}%→0 へだんだん弱く`, `fade ${amount}% → 0`), swell: L(`0→${amount}%→0 と山なりに`, `swell 0 → ${amount}% → 0`) })[f.shape];
    const t0 = Math.max(start, t);
    steps.push({ time: tempo.real(t0), position: pos(c, d, t0, master), deck: d, text: L(`デッキ${d}：${FX.title(f.kind)}（${FX.short(f.kind)}）を ${fmt(f.bars)}小節、${shape}`, `Deck ${d}: ${FX.title(f.kind)} (${FX.short(f.kind)}) for ${fmt(f.bars)} bars, ${shape}`) });
  }
  return steps;
}

function editSteps(c: Clip, d: string, master: number, tempo: TempoMap): GuideStep[] {
  if (!c.edits?.length) return [];
  const steps: GuideStep[] = [];
  for (const e of [...c.edits].sort((a, b) => a.bar - b.bar)) {
    const t = timelineTimeOfSource(c, sourceTimeAtBar(c, e.bar), master);
    if (t < c.start || t > end(c, master)) continue;
    const text = e.kind === 'loop'
      ? L(`デッキ${d}：${BB(e.bar)} から ${Edit.lengthLabel(e)} ループ ON、${e.repeats + 1}回まわしたら OFF`, `Deck ${d}: loop ${Edit.lengthLabel(e)} from ${BB(e.bar)}, release after ${e.repeats + 1} passes`)
      : L(`デッキ${d}：${BB(e.bar)} でホットキューを押して ${BB(Edit.end(e))} へ`, `Deck ${d}: at ${BB(e.bar)} hit the hot cue for ${BB(Edit.end(e))}`);
    steps.push({ time: tempo.real(t), position: `${d} ${BB(e.bar)}`, deck: d, text });
  }
  return steps;
}
