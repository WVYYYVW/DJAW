// The whole mix at a glance: every track's waveform as it is heard — after its fader, EQ, filter, effects and stems
// (read from the same automation the renderer uses, Automation.state) — over the outline of the original, with the
// fader line, EQ cuts, effect strips and transitions on top, and the rendered mix (the exported sound) underneath.
//   Click: move the playhead · Ctrl / ⌘ + wheel: zoom · wheel: scroll · double-click a track: its FX tab,
//   double-click a transition: the transition editor.
import React, { useEffect, useRef, useState } from 'react';
import { L } from '../../core/i18n';
import { Automation, AutoState } from '../../core/automation';
import { Clip, clipEnd, FXKind, sourceMapper, Style, Waveform } from '../../core/models';
import { FX, FXState } from '../../core/tempo';
import { useSize, useStore, usePlayhead } from '../hooks';
import { store } from '../store/store';
import { clipColor, Fmt } from '../format';

const LABEL_W = 64;
const RULER_H = 22;
const FX_ROW = 13;
const EQ_ROW = 12;
const MIX_MIN = 46;

/** The effects of an automation state, strongest first, as [kind, level 0…1]. */
function activeFX(fx: FXState): [FXKind, number][] {
  const out: [FXKind, number][] = [];
  if (fx.filter < -0.01) out.push(['lowPass', -fx.filter]);
  if (fx.filter > 0.01) out.push(['highPass', fx.filter]);
  const add = (k: FXKind, v: number) => { if (v > 0.01) out.push([k, Math.min(1, v)]); };
  add('echo', fx.echo); add('reverb', fx.reverb); add('flanger', fx.flanger); add('phaser', fx.phaser);
  add('gate', fx.gate); add('crush', fx.crush); add('roll', fx.roll);
  return out;
}

const db = (v: number) => Math.pow(10, v / 20);
const hsl = (k: FXKind, a: number, l = 60) => `hsla(${FX.hue(k) * 360},72%,${l}%,${a})`;

/** Low band and the rest of a column after the EQ, filter and stems of `s` (before the fader). */
function shaped(low: number, rest: number, s: AutoState): [number, number] {
  let lo = low * db(s.low);
  let hi = rest * (db(s.mid) * 0.5 + db(s.high) * 0.5);
  const f = s.fx.filter;
  if (f < 0) hi *= Math.max(0, 1 + f * 1.15);
  if (f > 0) { lo *= Math.max(0, 1 - f * 1.3); hi *= 1 - f * 0.25; }
  // Stems: the bass carries the lows; drums, melody and vocals the rest.
  lo *= Math.min(1, s.instrumental * s.bass);
  hi *= Math.min(1, s.instrumental * (s.drums * 0.4 + s.melody * 0.3) + s.vocal * 0.3);
  if (s.fx.gate > 0) hi *= 1 - s.fx.gate * 0.35;
  return [lo, hi];
}

export function OverviewTab() {
  const s = useStore();
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  // Visible span (reference seconds); null = the whole mix.
  const [view, setView] = useState<{ from: number; to: number } | null>(null);
  const total = Math.max(1, s.mixDuration);
  const from = view ? view.from : 0, to = view ? view.to : total;
  const W = Math.max(1, size.width - LABEL_W);
  const H = size.height;
  const mixH = Math.max(MIX_MIN, Math.round(H * 0.16));
  // Two deck lanes with a gap between them for the transition labels, then the mix.
  const GAP = 20;
  const laneH = Math.max(60, Math.floor((H - RULER_H - mixH - 4 - GAP - 8) / 2));
  const laneY = (k: number) => RULER_H + 4 + k * (laneH + GAP);
  const mixY = laneY(1) + laneH + 8;
  const xOf = (t: number) => LABEL_W + (t - from) / (to - from) * W;
  const tOf = (x: number) => from + (x - LABEL_W) / W * (to - from);

  useEffect(() => {
    const c = canvas.current;
    if (!c || size.width < 10 || size.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.width * dpr); c.height = Math.round(size.height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    draw(ctx);
  });

  function draw(ctx: CanvasRenderingContext2D) {
    const clips = s.clips, master = s.masterBPM;
    const ends = clips.map(c => clipEnd(c, master));
    // Lanes and labels.
    ctx.font = '600 11px system-ui';
    for (let k = 0; k < 2; k++) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(LABEL_W, laneY(k), W, laneH);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(k === 0 ? L('デッキ A', 'Deck A') : L('デッキ B', 'Deck B'), 8, laneY(k) + 16);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(LABEL_W, mixY, W, mixH);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('MIX', 8, mixY + 16);
    ctx.font = '10px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(L('書き出す音', 'exported'), 8, mixY + 30);
    drawRuler(ctx, master);
    ctx.save();
    ctx.beginPath(); ctx.rect(LABEL_W, 0, W, size.height); ctx.clip();
    // Transitions behind the tracks.
    clips.forEach((c, i) => {
      if (i === 0) return;
      const a = c.start, b = Math.min(ends[i - 1], ends[i]);
      const xa = xOf(a), xb = xOf(b);
      if (xb < LABEL_W || xa > LABEL_W + W) return;
      if (b - a > 0.05) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(xa, laneY(0), xb - xa, laneH * 2 + GAP);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xa + 0.5, laneY(0)); ctx.lineTo(xa + 0.5, laneY(1) + laneH); ctx.stroke();
      ctx.setLineDash([]);
      const label = b - a > 0.05 ? `${Fmt.bars(c.transitionBars)} · ${Style.title(c.transition)}` : `✂ ${L('直結', 'Cut')}`;
      ctx.font = '600 10px system-ui';
      const tw = ctx.measureText(label).width + 10;
      const y = laneY(1) - GAP / 2 + 1;
      ctx.fillStyle = 'rgba(20,21,25,0.92)';
      roundRect(ctx, xa + 2, y - 9, tw, 15, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(label, xa + 7, y + 2);
    });
    clips.forEach((c, i) => drawClip(ctx, clips, i, ends, master));
    drawMix(ctx);
    ctx.restore();
  }

  function drawRuler(ctx: CanvasRenderingContext2D, master: number) {
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(LABEL_W, 0, W, RULER_H);
    const barSec = 240 / Math.max(master, 1);
    const pxPerBar = W / ((to - from) / barSec);
    let step = 1;
    while (step * pxPerBar < 46) step *= 2;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    for (let bar = Math.ceil(from / barSec / step) * step; bar * barSec <= to; bar += step) {
      const x = xOf(bar * barSec + s.gridOffset);
      if (x < LABEL_W) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(String(bar + 1), x + 3, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText(Fmt.clock(s.tempoMap.real(bar * barSec + s.gridOffset)).replace(/\.\d+$/, ''), x + 3, 20);
    }
  }

  function drawClip(ctx: CanvasRenderingContext2D, clips: Clip[], i: number, ends: number[], master: number) {
    const c = clips[i];
    const lane = i % 2;
    const x0 = Math.max(LABEL_W, xOf(c.start)), x1 = Math.min(LABEL_W + W, xOf(ends[i]));
    if (x1 <= x0) return;
    const top = laneY(lane);
    const selected = s.selectedClipID === c.id;
    // Box and name.
    ctx.fillStyle = clipColor(c.colorIndex, 0.07);
    ctx.fillRect(x0, top, x1 - x0, laneH);
    ctx.strokeStyle = selected ? 'rgba(255,255,255,0.85)' : clipColor(c.colorIndex, 0.45);
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.strokeRect(xOf(c.start) + 0.5, top + 0.5, xOf(ends[i]) - xOf(c.start) - 1, laneH - 1);
    ctx.lineWidth = 1;
    const fxTop = top + 17;
    const waveTop = fxTop + FX_ROW + 2;
    const eqTop = top + laneH - EQ_ROW - 2;
    const mid = (waveTop + eqTop - 2) / 2, half = (eqTop - 2 - waveTop) / 2;
    ctx.font = '600 11px system-ui';
    ctx.fillStyle = clipColor(c.colorIndex, 1);
    ctx.fillText(`${i + 1}. ${c.title}`, Math.max(x0, xOf(c.start)) + 6, top + 13, Math.max(20, x1 - x0 - 12));
    const wf: Waveform | undefined = s.waveforms.get(c.url);
    const toSource = sourceMapper(c, master);
    const norm = wf ? 1 / Math.max(wf.maxPeak, 1e-6) : 0;
    const gainOnly = Math.pow(10, (c.gainDB + (c.loudnessGainDB ?? 0)) / 20);
    const xs: number[] = [], orig: number[] = [], peak: number[] = [], low: number[] = [], env: number[] = [];
    const eq: [number, number, number][] = [];
    const fxCols: [FXKind, number][][] = [];
    for (let px = Math.floor(x0); px < x1; px++) {
      const ta = tOf(px), tb = tOf(px + 1);
      const st = Automation.state(clips, i, (ta + tb) / 2, master, ends);
      let p = 0, l = 0;
      if (wf && wf.peaks.length) {
        const n = wf.peaks.length, bps = wf.binsPerSecond;
        const sa = toSource(ta);
        let sb = toSource(tb);
        if (sb < sa) sb = sa + (tb - ta);
        const b0 = Math.min(Math.max(0, Math.trunc(sa * bps)), n - 1);
        const b1 = Math.min(n, Math.max(b0 + 1, Math.trunc(sb * bps)));
        for (let b = b0; b < b1; b++) { if (wf.peaks[b] > p) p = wf.peaks[b]; if (wf.lows[b] > l) l = wf.lows[b]; }
        p *= norm; l *= norm;
      }
      const rest = Math.sqrt(Math.max(0, p * p - l * l));
      const [lo, hi] = shaped(l, rest, st);
      const v = st.volume;
      xs.push(px);
      orig.push(Math.min(1, p * gainOnly));
      peak.push(Math.min(1, Math.sqrt(lo * lo + hi * hi) * v));
      low.push(Math.min(1, lo * v));
      env.push(st.envelope);
      eq.push([st.low, st.mid, st.high]);
      fxCols.push(activeFX(st.fx));
    }
    if (!xs.length) return;
    // Original outline, then the shaped sound (low band darker).
    const fill = (vals: number[], style: string) => {
      ctx.beginPath();
      ctx.moveTo(xs[0], mid - vals[0] * half);
      for (let k = 1; k < xs.length; k++) ctx.lineTo(xs[k], mid - vals[k] * half);
      for (let k = xs.length - 1; k >= 0; k--) ctx.lineTo(xs[k], mid + vals[k] * half);
      ctx.closePath();
      ctx.fillStyle = style;
      ctx.fill();
    };
    if (wf) {
      fill(orig, 'rgba(255,255,255,0.07)');
      fill(peak, clipColor(c.colorIndex, 0.55));
      fill(low, clipColor(c.colorIndex, 1));
    } else {
      ctx.font = '11px system-ui';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(L('波形を読み込み中…', 'Loading waveform…'), x0 + 8, mid + 4);
    }
    // Fader (0 at the bottom of the waveform area, 100% at its top).
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    xs.forEach((x, k) => { const y = eqTop - 2 - env[k] * (eqTop - 2 - waveTop); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.lineWidth = 1;
    // EQ: three thin rows (LOW / MID / HIGH), red where cut, green where boosted.
    const rowH = EQ_ROW / 3;
    for (let k = 0; k < xs.length; k++) {
      for (let b = 0; b < 3; b++) {
        const v = eq[k][b];
        if (Math.abs(v) < 0.5) continue;
        ctx.fillStyle = v < 0 ? `rgba(255,90,80,${Math.min(0.95, 0.15 + -v / 30)})` : `rgba(80,220,120,${Math.min(0.9, 0.2 + v / 8)})`;
        ctx.fillRect(xs[k], eqTop + (2 - b) * rowH, 1, rowH - 0.5);
      }
    }
    ctx.font = '8px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    if (x1 - x0 > 60) ['H', 'M', 'L'].forEach((t, b) => ctx.fillText(t, x1 - 9, eqTop + b * rowH + rowH - 0.5));
    // Effects: a strip per column, split between the effects at work, each faded by its strength; names where they start.
    const running = new Map<FXKind, number>();
    for (let k = 0; k < xs.length; k++) {
      const list = fxCols[k];
      const h = list.length ? FX_ROW / list.length : 0;
      list.forEach(([kind, v], j) => {
        ctx.fillStyle = hsl(kind, 0.25 + v * 0.7);
        ctx.fillRect(xs[k], fxTop + j * h, 1, h);
        // A light tint over the waveform too, so the stretch an effect works on stands out.
        ctx.fillStyle = hsl(kind, 0.05 + v * 0.1);
        ctx.fillRect(xs[k], waveTop, 1, eqTop - 2 - waveTop);
      });
      const now = new Set(list.map(([kind]) => kind));
      for (const kind of now) if (!running.has(kind)) running.set(kind, xs[k]);
      for (const [kind, start] of [...running]) {
        if (!now.has(kind) || k === xs.length - 1) {
          const end = now.has(kind) ? xs[k] : xs[k] - 1;
          if (end - start > 26) {
            ctx.font = '700 9px system-ui';
            ctx.fillStyle = 'rgba(0,0,0,0.75)';
            ctx.fillText(FX.short(kind), start + 3, fxTop + 9.5, end - start - 4);
          }
          if (!now.has(kind)) running.delete(kind);
        }
      }
    }
  }

  function drawMix(ctx: CanvasRenderingContext2D) {
    const p = s.mixPeaksPartial ?? s.mixPeaks;
    const mid = mixY + mixH / 2, half = mixH / 2 - 4;
    if (!p || !p.maxs.length) {
      ctx.font = '11px system-ui';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(s.showMixWaveform ? L('ミックス波形を描いています…', 'Drawing the mix waveform…') : L('ミックス波形はオフです（アレンジの「MIX」で表示）', 'The mix waveform is off (turn it on with “MIX” above the arrangement)'), LABEL_W + 10, mid + 4);
      return;
    }
    const scale = 1 / Math.max(p.peak, 1e-6);
    ctx.fillStyle = 'rgba(120,200,240,0.85)';
    for (let px = LABEL_W; px < LABEL_W + W; px++) {
      const ra = s.tempoMap.real(tOf(px)), rb = s.tempoMap.real(tOf(px + 1));
      if (ra > p.rendered) break;
      const b0 = Math.max(0, Math.floor(ra * p.binsPerSecond)), b1 = Math.min(p.maxs.length, Math.max(b0 + 1, Math.floor(rb * p.binsPerSecond)));
      let lo = 0, hi = 0;
      for (let b = b0; b < b1; b++) { if (p.mins[b] < lo) lo = p.mins[b]; if (p.maxs[b] > hi) hi = p.maxs[b]; }
      const y0 = mid - Math.min(1, hi * scale) * half, y1 = mid - Math.max(-1, lo * scale) * half;
      ctx.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }
  }

  // Interaction.
  const hitClip = (x: number, y: number) => {
    const t = tOf(x);
    const lane = y >= laneY(1) && y < laneY(1) + laneH ? 1 : y >= laneY(0) && y < laneY(0) + laneH ? 0 : -1;
    if (lane < 0) return null;
    return s.clips.findIndex((c, i) => i % 2 === lane && t >= c.start && t <= clipEnd(c, s.masterBPM));
  };
  const hitTransition = (x: number) => {
    const t = tOf(x);
    const ends = s.clips.map(c => clipEnd(c, s.masterBPM));
    const tol = (to - from) / W * 5;
    return s.clips.findIndex((c, i) => i > 0 && t >= c.start - tol && t <= Math.max(c.start + tol, Math.min(ends[i - 1], ends[i])));
  };
  const local = (e: React.MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onClick = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    if (x < LABEL_W) return;
    const i = hitClip(x, y);
    if (i != null && i >= 0) { s.selectedClipID = s.clips[i].id; }
    store.seek(Math.max(0, Math.min(total, tOf(x))));
    store.requestScroll(store.playhead);
    s.changed();
  };
  const onDouble = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    if (x < LABEL_W) return;
    // On the label of a transition (just above deck B) or in an overlap: the transition editor.
    const tr = hitTransition(x);
    if (tr > 0 && y < laneY(1) && y > laneY(0) + laneH) { s.selectedClipID = s.clips[tr].id; s.openPanel('transition'); return; }
    const i = hitClip(x, y);
    if (i != null && i >= 0) { s.selectedClipID = s.clips[i].id; s.openPanel('fx'); }
  };
  // Wheel: zoom with Ctrl / ⌘ around the pointer, otherwise scroll (native, so it can be non-passive).
  const wrapEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrapEl.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const span = to - from;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const k = Math.exp(e.deltaY * 0.0025);
        const ns = Math.min(total, Math.max(4, span * k));
        if (ns >= total - 1e-6) { setView(null); return; }
        const at = tOf(Math.max(LABEL_W, x));
        let a = at - (at - from) * ns / span;
        a = Math.max(0, Math.min(total - ns, a));
        setView({ from: a, to: a + ns });
        return;
      }
      if (!view) return;
      e.preventDefault();
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / W * span;
      const a = Math.max(0, Math.min(total - span, from + d));
      setView({ from: a, to: a + span });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  return (
    <div className="overview">
      <div className="overview-bar">
        <span className="legend-item"><span className="sw" style={{ background: 'rgba(255,255,255,0.18)' }} />{L('元の波形', 'Original')}</span>
        <span className="legend-item"><span className="sw" style={{ background: 'var(--accent)' }} />{L('実際に鳴る音（濃い所＝低音）', 'What plays (dark = lows)')}</span>
        <span className="legend-item"><span className="line" />{L('フェーダー', 'Fader')}</span>
        <span className="legend-item"><span className="sw" style={{ background: 'rgba(255,90,80,0.8)' }} />{L('EQ カット', 'EQ cut')}</span>
        <span className="legend-item"><span className="sw" style={{ background: 'rgba(80,220,120,0.8)' }} />{L('EQ ブースト', 'EQ boost')}</span>
        <span className="legend-item"><span className="sw fxsw" />{L('FX（濃いほど強い）', 'FX (darker = stronger)')}</span>
        <div className="spacer" />
        <button className="btn small" disabled={!view} onClick={() => setView(null)}>{L('全体を表示', 'Show All')}</button>
      </div>
      <div className="overview-canvas" title={L('クリックで再生位置を移動・Ctrl（⌘）＋ホイールで拡大・ホイールで左右に移動・曲をダブルクリックで FX、つなぎの名札をダブルクリックでつなぎエディタ', 'Click: move the playhead · Ctrl (⌘) + wheel: zoom · wheel: scroll · double-click a track: its FX · double-click a transition label: the transition editor')} ref={el => { wrapEl.current = el; wrapRef(el); }} onClick={onClick} onDoubleClick={onDouble}>
        <canvas ref={canvas} />
        <OverviewPlayhead xOf={xOf} height={H} from={from} to={to} />
      </div>
    </div>
  );
}

/** The playhead on its own layer (the tracks are not drawn again every frame). */
function OverviewPlayhead({ xOf, height, from, to }: { xOf: (t: number) => number; height: number; from: number; to: number }) {
  // The clock wakes this up while playing; the position itself is read fresh (it can also change without a tick).
  usePlayhead(30);
  const t = store.playhead;
  if (t < from || t > to) return null;
  return <div className="overview-playhead" style={{ left: Math.round(xOf(t)), height }} />;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  w = Math.max(0, w); h = Math.max(0, h); r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
