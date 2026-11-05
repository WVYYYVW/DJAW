// Visual-only "hardware" view (mac/DJAW/Views/DeckPanel.swift): two turntables and a DJ mixer whose knobs,
// kill lamps, channel faders and crossfader move by themselves, driven by the same automation that renders the mix.
import React, { useEffect, useRef } from 'react';
import { L } from '../../core/i18n';
import { Clip, activeLoop, barAtSource, barLabel, clipEnd, keepsKey, rate, semitoneShift, sourceTimeAtTimeline } from '../../core/models';
import { AutoState, Automation } from '../../core/automation';
import { FXState, isQuietFX } from '../../core/tempo';
import { useStore, usePlayhead } from '../hooks';
import { store } from '../store/store';
import { Fmt, clipColor } from '../format';

interface DeckInfo {
  clip: Clip | null; index: number | null; active: boolean; ended: boolean; sourceTime: number;
  state: AutoState | null; level: number; loop: { pass: number; of: number; bars: number } | null;
}

function deckInfo(lane: number, t: number): DeckInfo {
  const clips = store.clips, master = store.masterBPM;
  const indices = clips.map((_, i) => i).filter(i => i % 2 === lane);
  let chosen: number | undefined, active = false;
  const playing = indices.find(i => clips[i].start <= t && t <= clipEnd(clips[i], master));
  if (playing != null) { chosen = playing; active = true; }
  else chosen = indices.find(i => clips[i].start > t) ?? indices[indices.length - 1];
  if (chosen == null) return { clip: null, index: null, active: false, ended: false, sourceTime: 0, state: null, level: 0, loop: null };
  const clip = clips[chosen];
  const source = active ? sourceTimeAtTimeline(clip, t, master) : clip.start > t ? clip.trimStart : clip.trimEnd;
  let state: AutoState | null = null, level = 0;
  if (active) {
    state = Automation.state(clips, chosen, t, master);
    const wf = store.waveforms.get(clip.url);
    if (store.isPlaying && wf && wf.peaks.length) {
      const bin = Math.min(wf.peaks.length - 1, Math.max(0, Math.trunc(source * wf.binsPerSecond)));
      level = wf.peaks[bin] / wf.maxPeak * state.volume;
    }
  }
  const l = active ? activeLoop(clip, t, master) : null;
  return { clip, index: chosen, active, ended: !active && clipEnd(clip, master) < t, sourceTime: source, state, level, loop: l ? { pass: l.pass, of: l.of, bars: l.edit.bars } : null };
}

function activeFX(fx: FXState) {
  const out: string[] = [];
  if (fx.filter < -0.02) out.push('LPF');
  if (fx.filter > 0.02) out.push('HPF');
  if (fx.echo > 0.02) out.push('ECHO');
  if (fx.reverb > 0.02) out.push('REVERB');
  if (fx.flanger > 0.02) out.push('FLANGER');
  if (fx.phaser > 0.02) out.push('PHASER');
  if (fx.gate > 0.02) out.push('TRANS');
  if (fx.crush > 0.02) out.push('CRUSH');
  if (fx.roll > 0.5) out.push('ROLL');
  return out.slice(0, 3);
}

function JogWheel({ info, side, playing }: { info: DeckInfo; side: number; playing: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const d = Math.min(h - 8, w * 2);
    const cx = side === 0 ? w - d / 2 : d / 2;
    const cy = h / 2;
    const r = d / 2 - 6;
    const accent = info.clip ? clipColor(info.clip.colorIndex) : 'gray';
    const progress = info.clip && info.clip.duration > 0 ? Math.min(1, Math.max(0, info.sourceTime / info.clip.duration)) : 0;
    const angle = info.sourceTime * 200 * Math.PI / 180;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = accent; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); ctx.stroke();
    const pr = r - 10;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, pr);
    g.addColorStop(0, 'rgb(41,41,41)'); g.addColorStop(1, 'rgb(13,13,13)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    for (let gr = pr * 0.94; gr > pr * 0.45; gr -= Math.max(3, pr * 0.05)) { ctx.beginPath(); ctx.arc(cx, cy, gr, 0, Math.PI * 2); ctx.stroke(); }
    for (let k = 0; k < 3; k++) {
      const a = angle + k * 2 * Math.PI / 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * pr * 0.5, cy + Math.sin(a) * pr * 0.5);
      ctx.lineTo(cx + Math.cos(a) * pr * 0.92, cy + Math.sin(a) * pr * 0.92);
      ctx.strokeStyle = `rgba(255,255,255,${k === 0 ? 0.6 : 0.15})`; ctx.lineWidth = k === 0 ? 4 : 2; ctx.lineCap = 'round'; ctx.stroke();
    }
    const lr = pr * 0.4;
    ctx.fillStyle = info.clip ? accent : 'rgb(56,56,56)';
    ctx.beginPath(); ctx.arc(cx, cy, lr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = 'rgb(217,217,217)';
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    if (info.active && playing) { ctx.strokeStyle = accent; ctx.globalAlpha = 0.5; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
  });
  return <div className="jog-slot"><canvas ref={ref} className="jog" /></div>;
}

function Turntable({ info, side, playing, master }: { info: DeckInfo; side: number; playing: boolean; master: number }) {
  const accent = info.clip ? clipColor(info.clip.colorIndex) : 'gray';
  const clip = info.clip;
  const r = clip ? rate(clip, master) : 1;
  const on = info.active && playing;
  const cued = clip != null && !info.ended && !on;
  const align = side === 0 ? 'left' : 'right';
  return (
    <div className={'turntable side' + side}>
      {side === 0 && <JogWheel info={info} side={side} playing={playing} />}
      <div className="deck-details" style={{ textAlign: align }}>
        <div className="deck-head" style={{ flexDirection: side === 0 ? 'row' : 'row-reverse' }}>
          <span style={{ color: accent }} className="deck-label">{L('デッキ ', 'DECK ')}{side === 0 ? 'A' : 'B'}</span>
          <span className={'lamp ' + (on ? 'play' : cued ? 'cue' : '')}>{on ? 'PLAY' : cued ? 'CUE' : info.ended ? 'END' : '—'}</span>
        </div>
        {clip ? <>
          <div className="deck-title" title={clip.title}>{clip.title}</div>
          {clip.artist && <div className="deck-artist">{clip.artist}</div>}
          <div className="deck-bpm"><span style={{ color: accent }}>{Fmt.bpm(clip.bpm * r)}</span> <small>BPM</small></div>
          <div className="deck-pitch">
            <span style={{ color: Math.abs(r - 1) > 0.08 ? 'rgb(255,159,10)' : undefined }}>{L('ピッチ ', 'Pitch ')}{Fmt.ratePercent(r)}</span>
            {keepsKey(clip) && Math.abs(r - 1) > 0.0005 && <span className="lamp teal">KEY LOCK</span>}
            {semitoneShift(clip) !== 0 && <span className="lamp purple">KEY {semitoneShift(clip) > 0 ? '+' : ''}{semitoneShift(clip)}</span>}
          </div>
          {info.state && !isQuietFX(info.state.fx) && <div className="deck-fx">{activeFX(info.state.fx).map(n => <span key={n} className="lamp orange">{n}</span>)}</div>}
          {info.loop && <div className="deck-loop">⟲ LOOP {info.loop.bars < 1 ? `${info.loop.bars * 4}/4` : info.loop.bars}  {info.loop.pass}/{info.loop.of}</div>}
          <div className="deck-readouts" style={{ flexDirection: side === 0 ? 'row' : 'row-reverse' }}>
            <div><div className="cap">{L('小節', 'BAR')}</div><div className="mono big">{barLabel(Math.floor(barAtSource(clip, info.sourceTime)))}</div></div>
            <div><div className="cap">{L('残り', 'REMAIN')}</div><div className="mono big">−{Fmt.time(Math.max(0, clip.duration - info.sourceTime))}</div></div>
          </div>
        </> : <div className="deck-empty">{L('空き', 'Empty')}</div>}
      </div>
      {side === 1 && <JogWheel info={info} side={side} playing={playing} />}
    </div>
  );
}

function Knob({ value, label, kill }: { value: number; label: string; kill: boolean }) {
  // value: dB, −40…+6 → angle −135…135
  const v = Math.max(-26, Math.min(6, value));
  const a = -135 + (v + 26) / 32 * 270;
  return (
    <div className="knob-wrap">
      <div className={'knob' + (kill ? ' kill' : '')}><div className="knob-mark" style={{ transform: `rotate(${a}deg)` }} /></div>
      <div className={'knob-label' + (kill ? ' kill' : '')}>{kill ? 'KILL' : label}</div>
    </div>
  );
}

function Channel({ info, label }: { info: DeckInfo; label: string }) {
  const s = info.state;
  const env = info.active ? s?.envelope ?? 0 : 0;
  const color = info.clip ? clipColor(info.clip.colorIndex) : 'gray';
  return (
    <div className="channel">
      <div className="ch-label" style={{ color }}>{label}</div>
      <Knob label="HIGH" value={s?.high ?? 0} kill={(s?.high ?? 0) < -30} />
      <Knob label="MID" value={s?.mid ?? 0} kill={(s?.mid ?? 0) < -20} />
      <Knob label="LOW" value={s?.low ?? 0} kill={(s?.low ?? 0) < -30} />
      <div className="fader-row">
        <div className="meter"><div style={{ height: `${Math.min(1, info.level) * 100}%`, background: color }} /></div>
        <div className="fader"><div className="fader-cap" style={{ bottom: `${env * 100}%` }} /></div>
      </div>
    </div>
  );
}

function Mixer({ a, b }: { a: DeckInfo; b: DeckInfo }) {
  const va = a.active ? a.state?.envelope ?? 0 : 0, vb = b.active ? b.state?.envelope ?? 0 : 0;
  const pos = va + vb > 0.001 ? (vb - va) / Math.max(va, vb) : 0;
  const echo = (a.state?.echoWet ?? 0) > 50 || (b.state?.echoWet ?? 0) > 50;
  return (
    <div className="mixer">
      <div className="mixer-top">
        <Channel info={a} label="A" />
        <div className="mixer-mid"><div className="cap">MIXER</div><span className={'lamp ' + (echo ? 'purple' : '')}>ECHO</span></div>
        <Channel info={b} label="B" />
      </div>
      <div className="crossfader"><div className="xf-cap" style={{ left: `${(pos + 1) / 2 * 100}%` }} /></div>
    </div>
  );
}

export function DeckPanel() {
  const s = useStore();
  const t = usePlayhead(0);
  const a = deckInfo(0, t), b = deckInfo(1, t);
  const tempoNow = s.tempoMap.bpm(t);
  return (
    <div className="deckpanel">
      <Turntable info={a} side={0} playing={s.isPlaying} master={tempoNow} />
      {s.showMixer && <Mixer a={a} b={b} />}
      <Turntable info={b} side={1} playing={s.isPlaying} master={tempoNow} />
    </div>
  );
}
