// The inspector (mac/DJAW/Views/InspectorView.swift): transition / deck / FX / mixer for the selected track,
// the library track, several library tracks, or the mix as a whole.
import React, { useRef, useState } from 'react';
import { L, localize } from '../../core/i18n';
import {
  Clip, CurveShape, Curve, EQBand, Lanes, Loudness, Style, TransitionStyle, barAtSource, barLabel, clipEnd, cueList,
  curveShapes, hasEdits, keepsLanding, landingBar, lastBar, loudnessModes, rate, transitionPresets, transitionShape,
  effectiveLanes, Edit, Take, passesAtBar,
} from '../../core/models';
import { FX, FXShapes, fxKinds } from '../../core/tempo';
import { Key, Structure, sectionTitle } from '../../core/analysis/structure';
import { Automation } from '../../core/automation';
import { deckName, layerLengthBars } from '../../core/layers';
import { Genre, Genres, MixGenre, mixGenres } from '../../core/genre';
import { Arc, MixStyle, MixStyles, SetArc, mixStyles, setArcs } from '../../core/automixer';
import { tempoVaries } from '../../core/analysis/neural';
import { TrackUse, TrackUses, trackUses } from '../../core/models';
import { useStore } from '../hooks';
import { store, InspectorTab } from '../store/store';
import { Fmt, Theme, clipColor } from '../format';
import { NumberField } from './Toolbar';
import { ArtworkThumb } from './TrackProfileSheet';
import { showContextMenu } from './ContextMenu';
import { FXWave } from './FXWave';

export function Section({ title, footer, children }: { title?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="isection">
      {title && <div className="isection-title">{title}</div>}
      <div className="isection-body">{children}</div>
      {footer && <div className="isection-footer">{footer}</div>}
    </div>
  );
}

export function Row({ label, children, title }: { label: React.ReactNode; children: React.ReactNode; title?: string }) {
  return <div className="irow" title={title}><span className="irow-label">{label}</span><span className="irow-value">{children}</span></div>;
}

/** Slider with a value readout; double-click resets. One undo step per drag. */
export function ValueSlider({ title, value, min, max, step = 0.1, def, format, onBegin, onChange }: {
  title: string; value: number; min: number; max: number; step?: number; def: number; format: (v: number) => string;
  onBegin: () => void; onChange: (v: number) => void;
}) {
  const dragging = useRef(false);
  return (
    <div className="vslider">
      <span className="vslider-title">{title}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onPointerDown={() => { dragging.current = true; onBegin(); }}
        onPointerUp={() => { dragging.current = false; }}
        onChange={e => onChange(parseFloat(e.target.value))}
        onDoubleClick={() => { onBegin(); onChange(def); }} />
      <span className="vslider-value">{format(value)}</span>
    </div>
  );
}

/** ‹ › one bar, « » four bars (Alt: one beat). */
function PositionRow({ title, value, color, help, onDelta }: { title: string; value: number; color: string; help?: string; onDelta: (d: number) => void }) {
  const d = (e: React.MouseEvent, n: number) => onDelta(e.altKey ? Math.sign(n) * 0.25 : n);
  return (
    <div className="posrow" title={help}>
      <span className="dot" style={{ background: color }} />
      <span className="posrow-title">{title}</span>
      <span className="posrow-value">{Fmt.barOrdinal(value)}</span>
      <span className="posrow-buttons">
        <button onClick={e => d(e, -4)}>«</button><button onClick={e => d(e, -1)}>‹</button>
        <button onClick={e => d(e, 1)}>›</button><button onClick={e => d(e, 4)}>»</button>
      </span>
    </div>
  );
}

export function Tabs({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: [string, string][] }) {
  return <div className="segmented">{items.map(([k, label]) => <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}</button>)}</div>;
}

/** Small picture of both tracks' volume through the transition. */
function TransitionDiagram({ clip, prev }: { clip: Clip; prev: Clip }) {
  const ref = useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, 6); ctx.fill();
    const draw = (incoming: boolean, color: string) => {
      ctx.beginPath();
      for (let k = 0; k <= 120; k++) {
        const x = k / 120;
        const cv = incoming ? Automation.incomingCurve(clip, x) : Automation.outgoingCurve(clip, x);
        const y = h - 6 - cv.volume * (h - 12);
        if (k === 0) ctx.moveTo(4 + x * (w - 8), y); else ctx.lineTo(4 + x * (w - 8), y);
      }
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      // Low kill as a band along the bottom.
      for (let k = 0; k < 120; k++) {
        const x = k / 120;
        const cv = incoming ? Automation.incomingCurve(clip, x) : Automation.outgoingCurve(clip, x);
        if (cv.lowKill > 0.5) { ctx.fillStyle = color; ctx.globalAlpha = 0.35; ctx.fillRect(4 + x * (w - 8), incoming ? h - 4 : h - 8, (w - 8) / 120 + 0.5, 3); ctx.globalAlpha = 1; }
      }
    };
    draw(false, clipColor(prev.colorIndex));
    draw(true, clipColor(clip.colorIndex));
    const sp = Automation.switchPoint(clip);
    ctx.fillStyle = 'rgba(191,90,242,0.8)';
    ctx.fillRect(4 + sp * (w - 8), 4, 1.5, h - 8);
  });
  return <canvas ref={ref} className="tdiagram" title={L('音量の動き（細い帯＝低音を切っている所、紫の線＝曲が切り替わる所）', 'Volume through the transition (bands = low end cut, purple line = where the new track takes over)')} />;
}

const styleOrder: TransitionStyle[] = ['crossfade', 'bassSwap', 'filter', 'echoOut', 'cut', 'brake', 'backspin', 'custom'];
const styleIcon: Record<TransitionStyle, string> = { crossfade: '⇄', bassSwap: '◖◗', filter: '⏚', echoOut: '◌))', cut: '✂', brake: '⏷', backspin: '⟲', custom: '✎' };

export function TransitionSection({ clip, index }: { clip: Clip; index: number }) {
  const s = useStore();
  const prev = s.clips[index - 1];
  const [fine, setFine] = useState(false);
  const [band, setBand] = useState<EQBand>('low');
  const shape = transitionShape(clip);
  const total = Math.max(1, clip.transitionBars * 4);
  const step = 1 / total;
  const posLabel = (x: number) => {
    const beats = Math.round(x * total);
    const bar = Math.floor(beats / 4) + 1, beat = beats % 4 + 1;
    return beat === 1 ? L(`${bar}小節目`, `bar ${bar}`) : L(`${bar}小節目 ${beat}拍`, `bar ${bar} beat ${beat}`);
  };
  const b = shape[band];
  const setB = (f: (x: typeof b) => void) => s.setTransitionShape(clip.id, true, sh => f(sh[band]));
  const lengths = Style.lengthChoices(clip.transition);
  return (
    <>
      <Section title={L('前の曲からのつなぎ', 'Transition from Previous Track')}>
        <div className="sentence">{s.transitionSentence(index)}</div>
        <label className="switch" title={L('2曲の間に曲が入らず、並べ替えでは2曲まとめて動きます', 'Nothing is put between the two, and reordering moves them together')}>
          <input type="checkbox" checked={s.isTransitionLocked(clip.id)} onChange={e => s.setTransitionLocked(clip.id, e.target.checked)} />
          <span>🔒 {L('このつなぎを固定', 'Lock This Transition')}</span>
        </label>
        <TransitionDiagram clip={clip} prev={prev} />
        <SimplifyHint clip={clip} index={index} />
        <div className="button-row">
          <button className="btn purple grow" onClick={() => s.autoMixTransition(clip.id)} title={L('2曲のイントロ・ドロップ・アウトロとキーを解析して、出口・入口・長さ・つなぎ方をまとめて決めます', 'Analyses both tracks’ intro, drops, outro and key, and sets mix-out, mix-in, length and style')}>✦ {L('自動で決める', 'Auto')}</button>
          <button className="btn primary grow" onClick={() => s.previewTransition(clip.id)} title={L('つなぎの4小節前から再生します', 'Plays from 4 bars before the transition')}>▶ {L('試聴', 'Preview')}</button>
        </div>
        <div className="caption">✎ {L('右側の線で、フェーダー・EQ・FX・ステムの動きを描き直せます。', 'Redraw the fader, EQ, FX and stem moves in the lanes on the right.')}</div>
        {s.autoNoteText(clip) && (
          <div className="autonote">
            <div className="autonote-title">✦ {L('自動ミックスの判断', 'Why the auto-mix chose this')}</div>
            {s.autoNoteText(clip)!.split('\n').map((l, k) => <div key={k}>• {l}</div>)}
          </div>
        )}
      </Section>
      <Section title={L('つなぎ方', 'Style')}>
        <div className="style-grid">
          {styleOrder.map(st => (
            <button key={st} className={'style-tile' + (clip.transition === st ? ' on' : '')} onClick={() => s.setTransitionStyle(clip.id, st)} title={Style.detail(st)}>
              <span className="style-icon">{styleIcon[st]}</span>
              <span>{Style.title(st)}</span>
            </button>
          ))}
        </div>
        <div className="caption">{Style.detail(clip.transition)}</div>
        {Style.usesLength(clip.transition) && (
          <div className="chooser">
            <span>{L('重ねる長さ', 'Overlap')}</span>
            {lengths.map(n => <button key={n} className={Math.abs(clip.transitionBars - n) < 0.01 ? 'on' : ''} onClick={() => s.setTransitionLength(clip.id, n)}>{n}</button>)}
            <NumberField value={Math.round(clip.transitionBars * 100) / 100} width={44} min={0} max={128} onCommit={v => s.setTransitionLength(clip.id, v)} />
            <span className="dim">{L('小節', 'bars')}</span>
          </div>
        )}
        {Style.spinChoices(clip.transition).length > 0 && (
          <div className="chooser">
            <span>{clip.transition === 'brake' ? L('止まるまで', 'Stop over') : L('回す長さ', 'Spin over')}</span>
            {Style.spinChoices(clip.transition).map(n => <button key={n} className={(clip.spinBeats ?? 2) === n ? 'on' : ''} onClick={() => s.setSpinBeats(clip.id, n)}>{n}</button>)}
            <span className="dim">{L('拍', 'beats')}</span>
          </div>
        )}
        <div className="presets">
          {transitionPresets().map((p, k) => (
            <button key={p.id} className="chip" title={p.detail + ` (${k + 1})`} onClick={() => s.applyPreset(clip.id, p)}>{p.title}</button>
          ))}
        </div>
        {s.customTransitions.length > 0 && (
          <div className="presets">
            <span className="dim">{L('マイつなぎ', 'My Transitions')}</span>
            {s.customTransitions.map(p => (
              <button key={p.id} className={'chip' + (clip.transition === 'custom' && JSON.stringify(clip.lanes) === JSON.stringify(p.lanes) ? ' on' : '')}
                onClick={() => s.applyCustomTransition(clip.id, p)}
                onContextMenu={e => { e.preventDefault(); showContextMenu(e, [{ label: L('削除', 'Delete'), action: () => s.deleteCustomTransition(p.id) }]); }}>★ {p.name} · {p.bars}</button>
            ))}
          </div>
        )}
      </Section>
      <Section title={L('位置', 'Positions')} footer={L('‹ › で1小節、« » で4小節（Alt を押しながらで1拍）。タイムラインでは曲のドラッグで出口、左端で入口、右端で長さを変えられます。', '‹ › move 1 bar, « » 4 bars (hold Alt for 1 beat). On the timeline, drag a track to move the mix-out, its left edge for the mix-in, the right edge for the length.')}>
        <PositionRow title={L('前の曲の出口', 'Previous mix-out')} value={prev.mixOutBar} color="rgb(255,159,10)" help={L('ここから2曲が重なり始めます', 'The two tracks start overlapping here')} onDelta={d => s.setEntryPoint(clip.id, prev.mixOutBar + d)} />
        {passesAtBar(prev, prev.mixOutBar) > 1 && (
          <Row label={L('ループの何回目で', 'On loop pass')} title={L('前の曲の出口がループの中にあります。何回目のくり返しで、この曲を入れ始めるか（ループはこの曲と重なったまま続きます）', 'The previous mix-out is inside a loop: on which pass this track starts coming in (the loop keeps repeating under it)')}>
            <select value={prev.outPass ?? 0} onChange={e => s.setOutPass(prev.id, Number(e.target.value) || null)}>
              {Array.from({ length: passesAtBar(prev, prev.mixOutBar) }, (_, k) => k + 1).map(n => <option key={n} value={n}>{L(`${n}回目`, `pass ${n}`)}</option>)}
              <option value={0}>{L('最後の回（標準）', 'The last pass (default)')}</option>
            </select>
          </Row>
        )}
        <PositionRow title={L('この曲の入口', 'This track’s mix-in')} value={clip.mixInBar} color="rgb(48,209,88)" help={L('この曲のどこから鳴らし始めるか', 'Where in this track playback starts')} onDelta={d => s.setMixIn(clip.id, clip.mixInBar + d)} />
        {clip.transitionBars > 0.01 && <>
          <PositionRow title={L('切替完了', 'Switch done')} value={landingBar(clip)} color="rgb(191,90,242)" help={L('前の曲が消えて、この曲だけになる位置（ドロップ頭が定番）', 'Where only this track remains (usually a drop)')} onDelta={d => s.setLandingBar(clip.id, landingBar(clip) + d)} />
          <label className="check small"><input type="checkbox" checked={keepsLanding(clip)} onChange={e => s.setLandingLock(clip.id, e.target.checked)} /> {L('長さを変えても「切替完了」を動かさない', 'Keep “switch done” when changing the length')}</label>
        </>}
      </Section>
      {Style.editableVolume(clip.transition) && clip.transitionBars > 0.01 && (
        <Section>
          <button className="disclosure" onClick={() => setFine(!fine)}>{fine ? '▾' : '▸'} {L('音量カーブとEQを細かく調整', 'Fine-tune volume curves & EQ')}</button>
          {fine && <div className="fine">
            <Row label={L('音量カーブ', 'Volume curve')}>
              <select value={shape.volumeCurve} onChange={e => s.setTransitionShape(clip.id, true, sh => { sh.volumeCurve = e.target.value as CurveShape; })}>
                {curveShapes.map(c => <option key={c} value={c}>{Curve.title(c)}</option>)}
              </select>
            </Row>
            <Row label={L('次の曲が上がりきる', 'Next track at full')}>
              {posLabel(shape.inRise)} <span className="stepbtns"><button onClick={() => s.setTransitionShape(clip.id, true, sh => { sh.inRise -= step; })}>−</button><button onClick={() => s.setTransitionShape(clip.id, true, sh => { sh.inRise += step; })}>＋</button></span>
            </Row>
            <Row label={L('前の曲が下がり始める', 'Previous starts fading')}>
              {posLabel(shape.outFadeStart)} <span className="stepbtns"><button onClick={() => s.setTransitionShape(clip.id, true, sh => { sh.outFadeStart -= step; })}>−</button><button onClick={() => s.setTransitionShape(clip.id, true, sh => { sh.outFadeStart += step; })}>＋</button></span>
            </Row>
            <Tabs value={band} onChange={v => setBand(v as EQBand)} items={(['low', 'mid', 'high'] as EQBand[]).map(k => [k, (shape[k].enabled ? '● ' : '') + k.toUpperCase()])} />
            <label className="check"><input type="checkbox" checked={b.enabled} onChange={e => setB(x => { x.enabled = e.target.checked; })} /> {L(`${band.toUpperCase()} を入れ替える`, `Swap ${band.toUpperCase()}`)}</label>
            {b.enabled && <>
              <label className="check small"><input type="checkbox" checked={b.affectsIncoming !== false} onChange={e => setB(x => { x.affectsIncoming = e.target.checked; })} /> {L(`次の曲の ${band.toUpperCase()} も入れる（オフ＝前の曲を削るだけ）`, `Bring in the next track’s ${band.toUpperCase()} too (off = only cut the previous)`)}</label>
              <Row label={L('入れ替え開始', 'Swap starts')}>{posLabel(b.point)} <span className="stepbtns"><button onClick={() => setB(x => { x.point -= step; })}>−</button><button onClick={() => setB(x => { x.point += step; })}>＋</button></span></Row>
              <Row label={L('かける長さ', 'Takes')}>{b.ramp < step * 0.5 ? L('瞬時', 'Instant') : Fmt.beats(Math.round(b.ramp * total))} <span className="stepbtns"><button onClick={() => setB(x => { x.ramp = Math.max(0, x.ramp - step); })}>−</button><button onClick={() => setB(x => { x.ramp += step; })}>＋</button></span></Row>
              <Row label={L('カーブ', 'Curve')}>
                <select value={b.curve} onChange={e => setB(x => { x.curve = e.target.value as CurveShape; })}>{curveShapes.map(c => <option key={c} value={c}>{Curve.title(c)}</option>)}</select>
              </Row>
              <div className="button-row small">
                <button className="btn" onClick={() => setB(x => { x.point = 0; x.ramp = 1; x.curve = 'smooth'; })}>{L('全体で徐々に', 'Gradual, whole')}</button>
                <button className="btn" onClick={() => setB(x => { x.point = 0.5; x.ramp = 0; x.curve = 'linear'; })}>{L('中間で瞬時', 'Instant, middle')}</button>
                <button className="btn" onClick={() => setB(x => { x.point = 0.5; x.ramp = 0.5; x.curve = 'smooth'; })}>{L('後半で徐々に', 'Gradual, 2nd half')}</button>
              </div>
            </>}
            {clip.shape && <button className="btn" onClick={() => s.resetTransitionShape(clip.id)}>↺ {L('カーブを既定に戻す', 'Reset curve')}</button>}
          </div>}
        </Section>
      )}
    </>
  );
}

export function TakesSection({ clip }: { clip: Clip }) {
  const s = useStore();
  const list = s.takes(clip.id);
  const current = s.currentTakeID(clip.id);
  const [name, setName] = useState('');
  return (
    <Section title={L(`保存したつなぎ（${list.length}）`, `Saved Takes (${list.length})`)}
      footer={L('いまのつなぎを候補として保存しておくと、別のつなぎ方を作っても消えません。いくつか作って聴き比べ、最後に使うものを選べます。', 'Save the current transition as a take and it stays when you make another one. Make a few, compare them, and pick the one to keep.')}>
      {list.map(t => (
        <div key={t.id} className={'take' + (t.id === current ? ' on' : '')}>
          <div className="take-text">
            <div className="take-name">{t.id === current ? '● ' : ''}{localize(t.name)}</div>
            <div className="take-sub">{Take.summary(t)}</div>
          </div>
          <button className="btn small" onClick={() => s.useTake(clip.id, t.id)} disabled={t.id === current}>{L('使う', 'Use')}</button>
          <button className="btn small" title={L('この候補にして試聴', 'Use this take and listen')} onClick={() => s.previewTake(clip.id, t.id)}>▶</button>
          <button className="btn small" title={L('削除', 'Delete')} onClick={() => s.deleteTake(clip.id, t.id)}>✕</button>
        </div>
      ))}
      <div className="button-row">
        <input className="text" placeholder={L('名前（省略可）', 'Name (optional)')} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.stopPropagation()} />
        <button className="btn" disabled={current != null} onClick={() => { s.saveTake(clip.id, name || null); setName(''); }}>{current ? L('保存済み', 'Saved') : L('いまのつなぎを保存', 'Save Current')}</button>
      </div>
      {list.length > 0 && current == null && <div className="caption warn">✎ {L('いまのつなぎはまだ保存されていません', 'The current transition is not saved yet')}</div>}
      <button className="btn" onClick={() => s.newTakeFromAuto(clip.id)} title={L('いまのつなぎを保存してから、おすすめのつなぎで新しく作り直します。気に入らなければ一覧から戻せます', 'Saves the current transition, then starts a new one from the recommended plan. Switch back from the list at any time')}>⧉ {L('新しい候補を作る', 'New Take')}</button>
    </Section>
  );
}

export function TempoChangeSection({ clip, index }: { clip: Clip; index: number }) {
  const s = useStore();
  if (index === 0) {
    return (
      <Section title={L('テンポ（ミックスBPM）', 'Tempo (Mix BPM)')} footer={L('2曲目以降で「この曲からテンポを変える」を使うと、途中でBPMを変えられます。', 'From the second track on, “Change tempo from this track” changes the BPM mid-mix.')}>
        <Row label={L('ミックスBPM', 'Mix BPM')}><NumberField value={s.masterBPM} min={40} max={220} onCommit={v => s.setMasterBPM(v)} /></Row>
      </Section>
    );
  }
  const before = s.tempoBefore(index);
  const own = clip.tempo != null;
  const bpmHere = clip.tempo ?? before;
  const rateBefore = rate(clip, before), rateNow = rate(clip, bpmHere);
  const startValue = clip.tempoStart == null || clip.tempoStart === 'mixIn' ? 'mixIn' : clip.tempoStart === 'afterTransition' ? 'afterTransition' : String(clip.tempoStart);
  return (
    <Section title={L('テンポ（ミックスBPM）', 'Tempo (Mix BPM)')}>
      <label className="check"><input type="checkbox" checked={own} onChange={e => s.setTempoChange(clip.id, e.target.checked)} /> {L('この曲でテンポを変える', 'Change the tempo in this track')}</label>
      {own ? <>
        <div className="tempo-summary">
          <span className="mono">{Fmt.ratePercent(rateBefore)}</span><span className="dim">→</span><span className="mono">{Fmt.ratePercent(rateNow)}</span>
          <span className="dim">({Fmt.bpm(before)} → {Fmt.bpm(bpmHere)} BPM)</span>
        </div>
        <Row label={L('変えた後の BPM', 'BPM after')}>
          <NumberField value={clip.tempo!} min={40} max={220} onCommit={v => s.setTrackTempo(clip.id, v)} />
          <button className="btn small" title={L('この曲の元の速さ（ピッチ 0.0%）にする', 'This track at its own speed (pitch 0.0%)')} onClick={() => s.setTrackTempo(clip.id, Math.round(clip.bpm * 100) / 100)}>{L('元の速さ 0.0%', 'Own speed 0.0%')}</button>
        </Row>
        <Row label={L('始める所', 'Starts')}>
          <select value={startValue} onChange={e => { const v = e.target.value; s.setTempoStart(clip.id, v === 'mixIn' ? null : v === 'afterTransition' ? 'afterTransition' : Number(v)); }}>
            <option value="afterTransition">{L('つなぎが終わってから', 'After the transition')}</option>
            <option value="mixIn">{L('曲が入る所から', 'Where the track comes in')}</option>
            {[1, 2, 4, 8, 16, 32, 64].map(n => <option key={n} value={String(n)}>{L(`入ってから ${n}小節後`, `${n} bars after it comes in`)}</option>)}
          </select>
        </Row>
        <Row label={L('かける長さ', 'Takes')}>
          <select value={clip.tempoBars == null ? -1 : clip.tempoBars} onChange={e => s.setTempoBars(clip.id, Number(e.target.value) < 0 ? null : Number(e.target.value))}>
            <option value={-1}>{L('つなぎの長さ', 'The transition length')}</option>
            <option value={0}>{L('一瞬で', 'Instantly')}</option>
            {[1, 2, 4, 8, 16, 32, 64].map(n => <option key={n} value={n}>{L(`${n}小節`, `${n} bars`)}</option>)}
          </select>
        </Row>
        <div className="caption">{L('ミックス全体のテンポがこの曲の所から変わり、後の曲もこの BPM で続きます。BPM が大きく変わるときは、つなぎ方を「カットイン」「ブレーキ」「バックスピン」にすると自然です。', 'The whole mix changes tempo from here, and the tracks after carry on at this BPM. For big tempo jumps, Cut In, Brake or Backspin sound natural.')}</div>
      </> : <div className="caption">{L(`前の曲と同じ ${Fmt.bpm(before)} BPM で再生（この曲の速さ ${Fmt.ratePercent(rateBefore)}）。チェックを入れると、例えば ${Fmt.ratePercent(rateBefore)} から元の速さ 0.0% へ、つなぎの後に小節単位で戻せます。`, `Plays at the previous ${Fmt.bpm(before)} BPM (this track at ${Fmt.ratePercent(rateBefore)}). Tick the box to bring it back, e.g. from ${Fmt.ratePercent(rateBefore)} to its own speed 0.0%, over some bars after the transition.`)}</div>}
    </Section>
  );
}

export function DeckTab({ clip, index }: { clip: Clip; index: number }) {
  const s = useStore();
  const r = rate(clip, s.masterBPM);
  const keySug = s.suggestedKeyShift(clip.id);
  return (
    <>
      <GenreSection clip={clip} />
      <AIAnalysisSection clip={clip} />
      <Section title={L('キー', 'Key')}>
        <label className="check"><input type="checkbox" checked={clip.keyLock ?? true} onChange={e => s.setKeyLock(clip.id, e.target.checked)} /> {L('キーロック（オフにするとテンポに合わせて音程も変わる、レコード風）', 'Key lock (off: pitch follows the tempo, like vinyl)')}</label>
        <Row label={L('キーシフト', 'Key Shift')}>
          <span className="stepbtns"><button onClick={() => s.setKeyShift(clip.id, (clip.keyShift ?? 0) - 1)}>−</button></span>
          <span className="mono">{(clip.keyShift ?? 0) > 0 ? '+' : ''}{clip.keyShift ?? 0}</span>
          <span className="stepbtns"><button onClick={() => s.setKeyShift(clip.id, (clip.keyShift ?? 0) + 1)}>＋</button></span>
          {s.playedKey(clip) && <span className="keybadge">{Key.camelot(s.playedKey(clip)!)} · {Key.name(s.playedKey(clip)!)}</span>}
          {index > 0 && keySug != null && keySug !== (clip.keyShift ?? 0) && <button className="btn small" onClick={() => s.matchKeyToPrevious(clip.id)}>{L(`前の曲に合わせる（${keySug > 0 ? '+' : ''}${keySug}）`, `Match previous (${keySug > 0 ? '+' : ''}${keySug})`)}</button>}
        </Row>
      </Section>
      <Section title={L('テンポ', 'Tempo')}>
        <Row label="BPM">
          <NumberField value={clip.bpm} min={30} max={300} onCommit={v => s.setClipBPM(clip.id, v)} width={70} />
          <button className="btn small" onClick={() => s.scaleClipBPM(clip.id, 2)}>×2</button>
          <button className="btn small" onClick={() => s.scaleClipBPM(clip.id, 0.5)}>÷2</button>
          <button className="btn small" onClick={() => s.reanalyze(clip.id)}>{L('再解析', 'Re-analyze')}</button>
        </Row>
        <label className="check"><input type="checkbox" checked={clip.tempoSync} onChange={e => s.setTempoSync(clip.id, e.target.checked)} /> {L('ミックスBPMに合わせる', 'Sync to Mix BPM')}</label>
        {clip.tempoSync && <Row label={L('再生速度', 'Speed')}><span style={{ color: Math.abs(r - 1) > 0.08 ? 'rgb(255,159,10)' : undefined }}>{Fmt.ratePercent(r)}</span></Row>}
        {clip.tempoSync && Math.abs(r - 1) > 0.08 && <div className="caption warn">⚠ {L('テンポ差が大きいため音質が劣化する場合があります', 'Large tempo change — sound quality may suffer')}</div>}
      </Section>
      <Section title={L('ビートグリッド', 'Beat Grid')} footer={L('小節番号が曲の展開とずれている時は「1小節目の位置」を1拍ずつ動かします。キックがずれて聞こえる時は微調整を使います。', 'If bar numbers don’t match the song’s phrases, move “Bar 1 Position” one beat at a time. If the kicks sound flammed, use fine-tune.')}>
        <Row label={L('1小節目の位置', 'Bar 1 Position')}><button className="btn small" onClick={() => s.shiftDownbeat(clip.id, -1)}>‹ {L('1拍前へ', '1 beat earlier')}</button><button className="btn small" onClick={() => s.shiftDownbeat(clip.id, 1)}>{L('1拍後ろへ', '1 beat later')} ›</button></Row>
        <Row label={L('グリッド微調整', 'Grid Fine-Tune')}><button className="btn small" onClick={() => s.nudgeGrid(clip.id, -10)}>−10ms</button><button className="btn small" onClick={() => s.nudgeGrid(clip.id, 10)}>+10ms</button><button className="btn small" onClick={() => s.nudgeGrid(clip.id, -1)}>−1ms</button><button className="btn small" onClick={() => s.nudgeGrid(clip.id, 1)}>+1ms</button></Row>
      </Section>
    </>
  );
}

export function StructureSummary({ clip }: { clip: Clip }) {
  const s = useStore();
  const st = s.structures.get(clip.url);
  if (!st) return null;
  const n = Math.max(1, st.barCount);
  const colors = { intro: 'rgba(255,255,255,0.28)', drop: 'rgb(255,159,10)', breakdown: 'rgb(64,200,224)', outro: 'rgba(255,255,255,0.16)' };
  const bar = (b: number) => barLabel(barAtSource(clip, Structure.timeOfBar(st, b)));
  return (
    <div className="structure">
      <div className="structure-bar">{st.sections.map((sec, k) => <span key={k} title={`${sectionTitle(sec.kind)} ${bar(sec.start)}–${bar(sec.end)}`} style={{ left: `${sec.start / n * 100}%`, width: `${(sec.end - sec.start) / n * 100}%`, background: colors[sec.kind] }} />)}</div>
      <div className="caption">{L(`最初のドロップ ${bar(st.firstDrop)}小節目 · アウトロ ${bar(st.lastDropEnd)}小節目〜`, `First drop bar ${bar(st.firstDrop)} · outro from bar ${bar(st.lastDropEnd)}`)}</div>
    </div>
  );
}

export function FXTab({ clip }: { clip: Clip }) {
  const s = useStore();
  return (
    <>
      <div className="span-all"><FXWave clip={clip} /></div>
      <Section title={L('エフェクトを追加', 'Add an Effect')} footer={L('再生位置に置きます（再生位置がこの曲の外なら、出口の手前）。タイムラインの曲を右クリック ▸「ここにエフェクト」でも追加できます。', 'Placed at the playhead (or before the mix-out when the playhead is outside this track). You can also right-click the track ▸ “Add Effect Here”.')}>
        <div className="fx-grid">
          {fxKinds.map(k => (
            <button key={k} className="chip" title={FX.detail(k)} onClick={() => {
              const bar = s.sourceBar(clip.id, s.playhead);
              const id = s.addFX(clip.id, k, bar != null ? Math.floor(bar * 4) / 4 : undefined);
              if (id) { s.focusedFX = id; s.changed(); }
            }}>{FX.title(k)}</button>
          ))}
        </div>
      </Section>
      {(clip.fx ?? []).map(fx => (
        <Section key={fx.id} title={<span style={{ color: `hsl(${FX.hue(fx.kind) * 360},70%,65%)` }}>{FX.title(fx.kind)}</span>}>
          <div className="caption">{L(`${barLabel(fx.bar)}〜${barLabel(fx.bar + fx.bars)}小節 · ${FXShapes.title(fx.shape)} · ${Math.round(fx.amount * 100)}%`, `Bars ${barLabel(fx.bar)}–${barLabel(fx.bar + fx.bars)} · ${FXShapes.title(fx.shape)} · ${Math.round(fx.amount * 100)}%`)}</div>
          <PositionRow title={L('開始', 'Start')} value={fx.bar} color={`hsl(${FX.hue(fx.kind) * 360},70%,60%)`} onDelta={d => s.updateFX(clip.id, fx.id, true, f => { f.bar += d; })} />
          <Row label={L('長さ', 'Length')}>
            <NumberField value={fx.bars} min={0.25} max={128} width={48} onCommit={v => s.updateFX(clip.id, fx.id, true, f => { f.bars = v; })} />
            <span className="dim">{L('小節', 'bars')}</span>
          </Row>
          <ValueSlider title={L('強さ', 'Amount')} value={fx.amount} min={0} max={1} step={0.01} def={FX.defaultAmount(fx.kind)} format={v => `${Math.round(v * 100)}%`}
            onBegin={() => s.pushUndo()} onChange={v => s.updateFX(clip.id, fx.id, false, f => { f.amount = v; })} />
          <Row label={L('かかり方', 'Shape')}>
            <select value={fx.shape} onChange={e => s.updateFX(clip.id, fx.id, true, f => { f.shape = e.target.value as never; })}>
              {FXShapes.all.map(sh => <option key={sh} value={sh}>{FXShapes.title(sh)}</option>)}
            </select>
          </Row>
          {FX.divisions(fx.kind).length > 0 && (
            <div className="chooser">
              <span>{L('リズム', 'Rhythm')}</span>
              {FX.divisions(fx.kind).map(d => <button key={d} className={Math.abs(fx.division - d) < 1e-6 ? 'on' : ''} onClick={() => s.updateFX(clip.id, fx.id, true, f => { f.division = d; })}>{FX.divisionLabel(d)}</button>)}
              <span className="dim">{L('拍', 'beats')}</span>
            </div>
          )}
          <button className="btn small" onClick={() => s.removeFX(clip.id, fx.id)}>✕ {L('削除', 'Remove')}</button>
        </Section>
      ))}
    </>
  );
}

export function MixerTab({ clip, index }: { clip: Clip; index: number }) {
  const s = useStore();
  const isLast = index === s.clips.length - 1;
  const eq = (title: string, key: 'eqLow' | 'eqMid' | 'eqHigh') => (
    <ValueSlider title={title} value={clip[key]} min={-26} max={6} def={0} format={Fmt.db} onBegin={() => s.pushUndo()} onChange={v => s.updateClip(clip.id, false, c => { c[key] = v; })} />
  );
  return (
    <>
      <Section title={L('ミキサー', 'Mixer')}>
        <ValueSlider title={L('音量', 'Volume')} value={clip.gainDB} min={-18} max={6} def={0} format={Fmt.db} onBegin={() => s.pushUndo()} onChange={v => s.updateClip(clip.id, false, c => { c.gainDB = v; })} />
        {s.loudnessMode !== 'off' && <div className="caption">{L('ラウドネス補正', 'Loudness')}: {clip.loudnessGainDB != null && clip.lufs != null ? `${clip.loudnessGainDB > 0 ? '+' : ''}${clip.loudnessGainDB.toFixed(1)} dB (${clip.lufs.toFixed(1)} LUFS)` : L('測定中…', 'Measuring…')}</div>}
        {eq('LOW', 'eqLow')}{eq('MID', 'eqMid')}{eq('HIGH', 'eqHigh')}
      </Section>
      {(index === 0 || isLast) && (
        <Section title={L('フェード', 'Fades')}>
          {index === 0 && <ValueSlider title={L('フェードイン', 'Fade In')} value={clip.fadeInBeats} min={0} max={64} step={1} def={0} format={Fmt.beats} onBegin={() => s.pushUndo()} onChange={v => s.updateClip(clip.id, false, c => { c.fadeInBeats = v; })} />}
          {isLast && <>
            <ValueSlider title={L('フェードアウト', 'Fade Out')} value={clip.fadeOutBeats} min={0} max={64} step={1} def={0} format={Fmt.beats} onBegin={() => s.pushUndo()} onChange={v => s.updateClip(clip.id, false, c => { c.fadeOutBeats = v; })} />
            <PositionRow title={L('終了位置', 'End Point') + (clip.endBar == null ? L('（曲の最後）', ' (end of track)') : '')} value={clip.endBar ?? barAtSource(clip, clip.trimEnd)} color="rgb(255,255,255)"
              onDelta={d => { const cur = clip.endBar ?? Math.floor(lastBar(clip)); const v = cur + d; s.setEndBar(clip.id, v >= lastBar(clip) - 0.01 ? null : v); }} />
          </>}
        </Section>
      )}
    </>
  );
}

/** A layered track (decks C / D): where it rides, what of it plays, its level, EQ and fades. */
export function LayerInspector({ clip }: { clip: Clip }) {
  const s = useStore();
  const host = s.clips.find(c => c.id === clip.layerOf);
  const deck = s.layerDeck(clip.id);
  const parts = clip.layerParts ?? 'all';
  const eq = (title: string, key: 'eqLow' | 'eqMid' | 'eqHigh') => (
    <ValueSlider title={title} value={clip[key]} min={-26} max={6} def={0} format={Fmt.db} onBegin={() => s.pushUndo()} onChange={v => s.updateClip(clip.id, false, c => { c[key] = v; })} />
  );
  const stemsReady = !!s.stemsFor(clip.url), separating = s.stemProgress.get(clip.url);
  return (
    <div className="panel-columns">
      <div className="iheader span-all">
        <ArtworkThumb url={clip.url} colorIndex={clip.colorIndex} size={48} onClick={() => s.openProfileEditor(clip.id)} />
        <div>
          <div className="ititle">{clip.title}</div>
          <div className="isub">{L('重ねる曲', 'Layered track')} · {deck ? L(`デッキ ${deckName(deck)}`, `Deck ${deckName(deck)}`) : L('⚠︎ デッキ C・D がいっぱい', '⚠︎ decks C and D are full')} · {Fmt.bpm(clip.bpm)} BPM → {Fmt.ratePercent(rate(clip, s.tempoMap.bpm(s.placedLayer(clip.id)?.start ?? 0)))}</div>
        </div>
        <div className="spacer" />
        <button className="btn small" onClick={() => s.removeLayer(clip.id)}>{L('重ねるのをやめる', 'Remove Layer')}</button>
      </div>
      <Section title={L('位置', 'Position')} footer={host ? L(`「${host.title}」に乗って一緒に動きます。タイムラインのデッキ C / D でドラッグしても動かせます。`, `Rides on “${host.title}” and moves with it. You can also drag it on decks C / D in the timeline.`) : undefined}>
        <PositionRow title={L('重ねる位置（土台の曲の小節）', 'Starts at (bar of the mix track)')} value={clip.layerBar ?? 0} color={Theme.deckC}
          onDelta={d => s.moveLayer(clip.id, (clip.layerBar ?? 0) + d)} />
        <PositionRow title={L('この曲の開始', 'From its bar')} value={clip.mixInBar} color="rgb(48,209,88)"
          onDelta={d => { if (s.setLayerRange(clip.id, clip.mixInBar + d, clip.mixOutBar)) s.moveLayer(clip.id, (clip.layerBar ?? 0) + d, undefined, false); }} />
        <PositionRow title={L('この曲の終了', 'Until its bar')} value={clip.mixOutBar} color="rgb(255,159,10)"
          onDelta={d => s.setLayerRange(clip.id, clip.mixInBar, clip.mixOutBar + d)} />
        <div className="caption">{L(`長さ ${Fmt.bars(layerLengthBars(clip))}`, `Length ${Fmt.bars(layerLengthBars(clip))}`)}</div>
      </Section>
      <Section title={L('鳴らす部分', 'What Plays')} footer={parts !== 'all' && !stemsReady ? (separating != null ? L('ステムを分離中…', 'Separating the stems…') : L('ステムの分離が必要です（自動で始まります）', 'Needs the stems (separated automatically)')) : undefined}>
        <div className="segmented">
          {(['all', 'vocals', 'instrumental'] as const).map(p => (
            <button key={p} className={parts === p ? 'on' : ''} onClick={() => s.setLayerParts(clip.id, p)}>
              {p === 'all' ? L('全部', 'Everything') : p === 'vocals' ? L('歌だけ', 'Vocals') : L('伴奏だけ', 'Instrumental')}
            </button>
          ))}
        </div>
      </Section>
      <Section title={L('ミキサー', 'Mixer')}>
        <ValueSlider title={L('音量', 'Volume')} value={clip.gainDB} min={-18} max={6} def={0} format={Fmt.db} onBegin={() => s.pushUndo()} onChange={v => s.updateClip(clip.id, false, c => { c.gainDB = v; })} />
        {eq('LOW', 'eqLow')}{eq('MID', 'eqMid')}{eq('HIGH', 'eqHigh')}
      </Section>
      <Section title={L('フェード', 'Fades')}>
        <ValueSlider title={L('フェードイン', 'Fade In')} value={clip.fadeInBeats} min={0} max={64} step={1} def={4} format={Fmt.beats} onBegin={() => s.pushUndo()} onChange={v => s.updateClip(clip.id, false, c => { c.fadeInBeats = v; })} />
        <ValueSlider title={L('フェードアウト', 'Fade Out')} value={clip.fadeOutBeats} min={0} max={64} step={1} def={4} format={Fmt.beats} onBegin={() => s.pushUndo()} onChange={v => s.updateClip(clip.id, false, c => { c.fadeOutBeats = v; })} />
      </Section>
    </div>
  );
}

export function LibraryInspector({ clip }: { clip: Clip }) {
  const s = useStore();
  const key = s.structures.get(clip.url)?.key;
  return (
    <div className="panel-columns">
      <div className="iheader">
        <ArtworkThumb url={clip.url} colorIndex={clip.colorIndex} size={48} onClick={() => s.openProfileEditor(clip.id)} />
        <div>
          <div className="ititle">{clip.title}</div>
          <div className="isub">{L('ライブラリ（未配置）', 'Library (not in mix)')} · {Fmt.bpm(clip.bpm)} BPM · {Fmt.duration(clip.duration)}{key ? <span className="keybadge">{Key.camelot(key)}</span> : null}</div>
        </div>
      </div>
      <StructureSummary clip={clip} />
      <Section title={L('CUE', 'Cues')}>
        <Row label="IN">{Fmt.barOrdinal(clip.mixInBar)}</Row>
        <Row label="OUT">{Fmt.barOrdinal(clip.mixOutBar)}</Row>
        {cueList(clip).map(c => <Row key={c.id} label={c.label}>{Fmt.barOrdinal(c.bar)}</Row>)}
        <button className="btn" onClick={() => s.openCueEditor(clip.id)}>{L('CUE タブで編集', 'Edit in the CUE Tab')}</button>
      </Section>
      <Section footer={L('ミックスに入れると、前の曲の OUT からこの曲の IN で直結されます。つなぎ方はそのあと選びます。', 'In the mix, it connects straight from the previous track’s OUT to this IN. Choose the transition afterwards.')}>
        <div className="button-row">
          <button className="btn primary" onClick={() => s.addToMix(clip.id, s.clips.length)}>{L('ミックスの末尾に入れる', 'Add to End of Mix')}</button>
          <button className="btn" disabled={s.selectedIndex == null} onClick={() => s.addToMix(clip.id)}>{L('選択中の曲の後に入れる', 'Add After Selected')}</button>
        </div>
      </Section>
    </div>
  );
}

export function MultiLibraryInspector() {
  const s = useStore();
  const ids = s.library.map(c => c.id).filter(id => s.librarySelection.has(id));
  return (
    <div className="panel-columns">
      <Section title={L(`${ids.length}曲を選択中`, `${ids.length} tracks selected`)}>
        <div className="button-row">
          <button className="btn primary" onClick={() => s.addToMixMany(ids, s.clips.length)}>{L(`${ids.length}曲をミックスの末尾に入れる`, `Add ${ids.length} Tracks to End of Mix`)}</button>
          <button className="btn" onClick={() => s.removeFromLibrary(ids)}>{L('ライブラリから削除', 'Remove from Library')}</button>
        </div>
      </Section>
      <Section footer={L('Ctrl+クリックで1曲ずつ、Shift+クリックで範囲を選べます。Delete で選んだ曲を削除します（Ctrl+Z で元に戻せます）。', 'Ctrl-click picks single tracks, Shift-click a range. Delete removes them (Ctrl+Z undoes it).')}>{null}</Section>
    </div>
  );
}

function SimplifyHint({ clip, index }: { clip: Clip; index: number }) {
  const s = useStore();
  const sim = s.simplification(index);
  if (!sim) return null;
  return (
    <div className="hint-row" title={L('前の曲がそのまま鳴っていて次の曲が無音の部分（またはその逆）を、つなぎから外します。聞こえる音は変わりません。Ctrl+Z で戻せます。', 'Drops the bars where only one track plays unchanged and the other is silent. What you hear stays the same. Ctrl+Z undoes it.')}>
      <span className="caption">✂ {L(`音はそのまま ${Fmt.bars(sim.oldBars)} → ${Fmt.bars(sim.newBars)} に短く書けます`, `Same sound in ${Fmt.bars(sim.newBars)} instead of ${Fmt.bars(sim.oldBars)}`)}</span>
      <button className="btn small" onClick={() => s.simplifyTransition(clip.id)}>{L('簡単にする', 'Simplify')}</button>
    </div>
  );
}

export function VariationsSection({ clip, index }: { clip: Clip; index: number }) {
  const s = useStore();
  const [checking, setChecking] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const prev = s.clips[index - 1];
  const list = s.variationList(clip.id) ?? [];
  React.useEffect(() => { if (!s.variationList(clip.id) && s.structures.has(clip.url) && s.structures.has(prev.url)) s.computeVariations(clip.id); }, [clip.id, prev.id, s.structures.has(clip.url) && s.structures.has(prev.url)]);
  const select = (k: number) => { if (k > 0 && k < s.clips.length) { s.selectedClipID = s.clips[k].id; s.changed(); } };
  const summary = (p: { style: TransitionStyle; length: number; outBar: number; inBar: number }) => {
    const how = Style.isCutLike(p.style) || p.length === 0 ? Style.title(p.style) : L(`${Style.title(p.style)} ${p.length}小節`, `${Style.title(p.style)}, ${p.length} bars`);
    return L(`${how}・前の曲 ${p.outBar + 1}小節目で抜け始め・この曲は ${p.inBar + 1}小節目から`, `${how} · out from bar ${p.outBar + 1} · in at bar ${p.inBar + 1}`);
  };
  return (
    <Section title={L('この2曲のつなぎ方（候補）', 'Ways to Connect These Two')}>
      <div className="pair-row">
        <button className="btn small" disabled={index < 2} title={L('ひとつ前のつなぎ', 'Previous transition')} onClick={() => select(index - 1)}>‹</button>
        <div className="grow"><div className="caption ellipsis">{prev.title}</div><div className="ellipsis"><b>→ {clip.title}</b></div></div>
        <button className="btn small" disabled={index + 1 >= s.clips.length} title={L('次のつなぎ', 'Next transition')} onClick={() => select(index + 1)}>›</button>
      </div>
      {list.length === 0 ? (
        <button className="btn" onClick={() => s.computeVariations(clip.id)}>⧉ {L('つなぎ方の候補を出す', 'Show Variations')}</button>
      ) : <>
        {list.map((v, k) => {
          const current = s.isCurrentVariation(clip.id, k);
          return (
            <div key={v.id} className={'variation' + (current ? ' on' : '')} onClick={() => setExpanded(expanded === v.id ? null : v.id)}>
              <div className="variation-head">
                <span className="radio">{current ? '●' : '○'}</span>
                <div className="grow">
                  <div className="take-name">{localize(v.plan.label ?? '')}</div>
                  <div className="take-sub wrap">{summary(v.plan)}</div>
                </div>
                <button className="btn small" title={L('この案に切り替えて試聴', 'Switch to this variation and listen')} onClick={e => { e.stopPropagation(); s.previewVariation(clip.id, k); }}>▶</button>
                <button className="btn small" disabled={current} onClick={e => { e.stopPropagation(); s.applyVariation(clip.id, k); }}>{L('使う', 'Use')}</button>
              </div>
              {v.problems && <div className={'caption ' + (v.problems.length ? 'warn' : 'ok')}>{v.problems.length ? '⚠ ' + v.problems.join('、') : '✓ ' + L('書き出して確認：問題なし', 'Checked: no problems')}</div>}
              {expanded === v.id && <div className="caption pre">{localize(v.plan.reasons.join('\n'))}</div>}
            </div>
          );
        })}
        <div className="button-row">
          <button className="btn" disabled={checking} onClick={async () => { setChecking(true); await s.checkVariations(clip.id); setChecking(false); }}>🔍 {L('すべて書き出して確認', 'Render & Check All')}</button>
          {checking && <span className="spinner" />}
          <div className="spacer" />
          <button className="btn small" title={L('いまの曲の状態から候補を出し直す', 'Recompute the variations')} onClick={() => s.computeVariations(clip.id)}>↻</button>
        </div>
        <div className="caption">{L('「試聴」はその案に切り替えてつなぎの4小節前から再生します。Ctrl+Z で元の案に戻せます。', '“Listen” switches to that variation and plays from 4 bars before it. Ctrl+Z goes back.')}</div>
      </>}
    </Section>
  );
}

function GenreSection({ clip }: { clip: Clip }) {
  const s = useStore();
  const result = s.genreResults.get(clip.url);
  const used = s.genreFor(clip);
  const src = s.genreSource(clip);
  const t = result?.traits;
  return (
    <Section title={L('ジャンル（おまかせミックスのつなぎ方）', 'Genre (How the Auto-Mix Connects)')}>
      <Row label={L('ジャンル', 'Genre')}>
        <select value={clip.genre ?? ''} onChange={e => s.setGenre(clip.id, (e.target.value || null) as MixGenre | null)}>
          <option value="">{L(`自動（${used ? Genre.title(used) : '不明'}）`, `Auto (${used ? Genre.title(used) : 'unknown'})`)}</option>
          {mixGenres.map(g => <option key={g} value={g}>{Genre.title(g)}</option>)}
        </select>
      </Row>
      {used && <div className="caption">{Genre.mixSummary(used)}</div>}
      {src && <Row label={L('判定の根拠', 'Based on')}><span className="caption">{src}</span></Row>}
      {t && t.length === 4 && (
        <Row label={L('歌・盛り上がり', 'Vocals · Energy')} title={L('歌：歌・ラップが聞こえる区間の割合（つなぎで歌同士が重ならないようにするのに使います）。エナジー：パーティー感・激しさ・踊りやすさとドロップの音量（曲順の流れに使います）', 'Vocals: share of the track with singing / rapping (used to keep vocals from overlapping). Energy: party / aggressive / danceable feel and drop loudness (used for the set\'s energy curve)')}>
          <span className="caption mono">{L(`歌 ${Math.round(t[0] * 100)}%・エナジー ${Math.round((s.energyLevel(clip) ?? 0) * 100)}`, `vocals ${Math.round(t[0] * 100)}% · energy ${Math.round((s.energyLevel(clip) ?? 0) * 100)}`)}</span>
        </Row>
      )}
      {result && result.styles.length > 0 ? (
        <div className="styles">
          <div className="caption"><b>{L('AI が聴き取ったスタイル（Discogs）', 'Styles the AI hears (Discogs)')}</b></div>
          {result.styles.slice(0, 4).map(st => (
            <div key={st.label} className="style-row">
              <span className="caption grow">{Genres.styleName(st)}</span>
              <progress value={Math.min(1, st.score)} max={1} />
              <span className="caption mono">{Math.round(st.score * 100)}%</span>
            </div>
          ))}
        </div>
      ) : !result && s.pending.some(p => p.url === clip.url) ? <div className="caption"><span className="spinner" /> {L('解析中…', 'Analysing…')}</div> : null}
    </Section>
  );
}

function AIAnalysisSection({ clip }: { clip: Clip }) {
  const s = useStore();
  const a = s.aiGrid(clip);
  const differs = s.gridDiffersFromAI(clip);
  const cues = s.aiCues(clip);
  const st = s.structures.get(clip.url);
  return (
    <Section title={L('AI 解析（拍・小節・CUE）', 'AI Analysis (Beats, Bars, Cues)')}>
      {a ? <>
        <Row label={L('拍の一致', 'Beat match')} title={L('AI が聴き取った拍のうち、いまの拍グリッドに乗っている割合', 'Share of the beats the AI heard that sit on the current grid')}>
          <span className="mono" style={{ color: a.currentFit < 0.6 ? 'var(--orange)' : undefined }}>{Math.round(a.currentFit * 100)}%</span>
          {differs && <><span className="dim">→</span><span className="mono ok">{Math.round(a.fit * 100)}%</span></>}
        </Row>
        {differs && <button className="btn primary" onClick={() => s.applyAIGrid(clip.id)}>♩ {L(`AI の拍・小節に合わせる（${Fmt.bpm(a.bpm)} BPM）`, `Match the AI Grid (${Fmt.bpm(a.bpm)} BPM)`)}</button>}
        {!differs && <div className="caption ok">✓ {L('グリッドは AI 解析と一致しています', 'The grid matches the AI analysis')}</div>}
        {tempoVaries(a.grid) && <div className="caption warn">〰 {L('曲の途中でテンポが変わる（またはハーフ／倍テンになる）部分があります。拍がずれる区間ではループや長いつなぎを避けるのが安全です。', 'The tempo changes (or goes half / double time) inside this track. Avoid loops and long blends where the grid drifts.')}</div>}
        {cues.length > 0 && <>
          <div className="caption"><b>{L('プロDJならここに CUE（AI予測）', 'Where a pro DJ would cue (AI)')}</b></div>
          <div className="presets">
            {cues.map(c => (
              <button key={c.bar} className="chip cue-chip" style={{ ['--a' as never]: 0.4 + 0.6 * c.score }}
                title={L(`${barLabel(c.bar)}小節目（強さ ${Math.round(c.score * 100)}%）`, `Bar ${barLabel(c.bar)} (strength ${Math.round(c.score * 100)}%)`)}
                onClick={e => showContextMenu(e, [
                  { label: L('入口（IN）にする', 'Use as Mix-In'), action: () => s.setMixIn(clip.id, c.bar) },
                  { label: L('切替完了にする', 'Use as Switch Point'), action: () => s.setLandingBar(clip.id, c.bar) },
                  { label: L('出口（OUT）にする', 'Use as Mix-Out'), action: () => s.setMixOut(clip.id, c.bar) },
                ])}>◆ {barLabel(c.bar)}</button>
            ))}
          </div>
        </>}
      </> : <div className="caption">{s.pending.some(p => p.url === clip.url) ? L('解析中…', 'Analysing…') : L('AI の拍解析はありません（エネルギーから推定した BPM を使用）', 'No AI beat analysis (BPM estimated from the energy)')}</div>}
      {st && <StructureSummary clip={clip} />}
    </Section>
  );
}

function MixPatternsSection() {
  const s = useStore();
  if (!s.mixPatterns.length && !s.verifyProgress) return null;
  const v = s.verifyProgress;
  return (
    <Section title={L('おまかせミックスの案', 'Auto-Mix Patterns')} footer={L('案を選んでから、気になるつなぎを選ぶと「この2曲のつなぎ方」で個別に差し替えられます。', 'Pick a pattern, then select a track to swap the transition into it under “Ways to Connect These Two”.')}>
      {s.mixPatterns.map(p => (
        <div key={p.id} className={'variation' + (p.id === s.currentPatternID ? ' on' : '')}>
          <div className="variation-head">
            <span className="radio">{p.id === s.currentPatternID ? '●' : '○'}</span>
            <div className="grow">
              <div className="take-name">{p.title}</div>
              <div className="take-sub wrap">{p.detail}</div>
              <div className="take-sub mono">{L(`ブレンド ${p.blends}・カット ${p.cuts}・平均 ${Math.round(p.averageBars)}小節・全長 ${Fmt.duration(p.duration)}`, `${p.blends} blends · ${p.cuts} cuts · avg ${Math.round(p.averageBars)} bars · ${Fmt.duration(p.duration)}`)}</div>
            </div>
            <button className="btn small" disabled={p.id === s.currentPatternID} onClick={() => s.usePattern(p.id)}>{L('この案にする', 'Use')}</button>
          </div>
        </div>
      ))}
      {v && <div className="button-row"><progress value={v.done} max={Math.max(1, v.total)} style={{ width: 90 }} /><span className="caption">{L(`つなぎを書き出して確認中（${v.done}/${v.total}）`, `Rendering & checking transitions (${v.done}/${v.total})`)}</span></div>}
    </Section>
  );
}

function AutoMixSection() {
  const s = useStore();
  const simple = s.simplifiableTransitions().length;
  const all = s.clips.map((_, i) => i);
  return (
    <Section title={L('自動ミックス', 'Auto-Mix')} footer={L('各曲のイントロ・ドロップ・ブレイク・アウトロ、フレーズ（8小節）の区切り、キーを波形から解析し、曲間ごとに出口・入口・重ねる長さ・つなぎ方を決めます。次の曲のドロップで切り替わり、低音がぶつからないように組み立てます（Ctrl+Z で取り消し可）。曲を追加しただけでは自動でミックスされません。', 'Analyses each track’s intro, drops, breaks and outro, its 8-bar phrases and its key, then picks the mix-out, mix-in, overlap length and style for every transition — landing on the next track’s drop without clashing bass (undo with Ctrl+Z). Adding tracks never mixes them on its own.')}>
      <Row label={L('スタイル', 'Style')}>
        <select value={s.mixStyle} onChange={e => s.setMixStyle(e.target.value as MixStyle)}>{mixStyles.map(m => <option key={m} value={m}>{MixStyles.title(m)}</option>)}</select>
      </Row>
      <Row label={L('曲順の流れ', 'Set Energy')} title={L('曲順も自動で決めるとき、盛り上がりの流れをどう作るか', 'When the order is chosen automatically: how the energy should develop')}>
        <select value={s.setArc} onChange={e => s.setSetArc(e.target.value as SetArc)}>{setArcs.map(a => <option key={a} value={a}>{Arc.title(a)}</option>)}</select>
      </Row>
      <Row label={L('曲の使い方', 'Track Use')} title={TrackUses.detail(s.trackUse)}>
        <select value={s.trackUse} onChange={e => s.setTrackUse(e.target.value as TrackUse)}>{trackUses.map(u => <option key={u} value={u}>{TrackUses.title(u)}</option>)}</select>
      </Row>
      <button className="btn" disabled={simple === 0} onClick={() => s.simplifyAllTransitions()}
        title={L('片方の曲が無音で、もう片方がそのまま鳴っているだけの部分をつなぎから外して、同じ音のまま短く表します（Ctrl+Z で戻せます）', 'Drops the bars of each transition where one track is silent and the other plays unchanged — same sound, shorter transitions (Ctrl+Z undoes)')}>
        ✂ {simple > 0 ? L(`短く書けるつなぎを簡単にする（${simple}か所）`, `Simplify Transitions (${simple})`) : L('短く書けるつなぎはありません', 'No transitions to simplify')}
      </button>
      <label className="check" title={L('A / B の下に、書き出しと同じ処理で作った最終的な波形を表示します（編集のたびに裏で作り直します）', 'Shows the final mix under the A / B lanes, rendered exactly like an export (re-rendered in the background after edits)')}>
        <input type="checkbox" checked={s.showMixWaveform} onChange={() => s.toggle('showMixWaveform')} /> {L('ミックス後の波形を表示', 'Show the mixed-down waveform')}
      </label>
      <label className="check" title={L('おまかせミックスの後、つなぎを1つずつ書き出して音量の落ち込み・低音の濁り・キックの二重を調べ、問題があれば次の案に差し替えます', 'After auto-mixing, each transition is rendered and checked for level holes, muddy bass and flamming kicks; failing ones get the next-best plan')}>
        <input type="checkbox" checked={s.verifyTransitions} onChange={e => s.setVerifyTransitions(e.target.checked)} /> {L('つなぎを書き出して確認する', 'Render & check transitions')}
      </label>
      <div className="caption">{MixStyles.detail(s.mixStyle)}{s.mixStyle === 'auto' && s.clips.length > 1 ? L(`（いまの曲なら「${s.styleSummary(all)}」）`, ` (now: “${s.styleSummary(all)}”)`) : ''}</div>
      {s.autoMixWhenReady && <div className="caption"><span className="spinner" /> {L('解析が終わったら自動ミックスします', 'Auto-mixes as soon as the analysis is done')}</div>}
      <button className="btn primary wide" disabled={s.clips.length < 2} onClick={() => s.autoMixAll()}>✦ {L('曲を解析して全体を自動ミックス', 'Analyse & Auto-Mix Everything')}</button>
      <button className="btn wide" disabled={s.clips.length + s.library.length < 2} onClick={() => { s.showAutoArrange = true; s.changed(); }}>☰ {L('曲を選んでおまかせミックス（曲順も）…', 'Pick Tracks & Auto-Arrange (Order Too)…')}</button>
    </Section>
  );
}

function AIStatusSection() {
  const s = useStore();
  const n = s.aiGridMismatches();
  if (n === 0 && !s.pending.length) return null;
  return (
    <Section title={L('AI 解析', 'AI Analysis')}>
      {s.pending.length > 0 && <div className="caption"><span className="spinner" /> {L(`曲を解析中（残り${s.pending.length}曲・各曲の進み具合は左のリストに表示）`, `Analysing tracks (${s.pending.length} left; progress is shown next to each track)`)}</div>}
      {n > 0 && <>
        <div className="caption warn">⚠ {L(`${n}曲で、保存されている拍・小節が AI の解析とずれています。`, `${n} tracks have a beat grid that disagrees with the AI analysis.`)}</div>
        <button className="btn primary" onClick={() => s.alignAllGridsToAI()}>♩ {L('すべて AI の拍・小節に合わせる', 'Match All to the AI Grid')}</button>
        <div className="caption">{L('つなぎの位置（小節）はそのまま、拍の位置だけを正しくします。Ctrl+Z で戻せます。', 'Mix points stay on the same bars; only the beat positions are corrected. Ctrl+Z undoes it.')}</div>
      </>}
    </Section>
  );
}

export function MixInspector() {
  const s = useStore();
  const p = s.progressSummary;
  return (
    <div className="panel-columns">
      <AIStatusSection />
      <Section title={L('進捗とメモ', 'Progress & Notes')}>
        <div className="caption">{L(`CUE ${p.cues}/${p.cueTotal} · つなぎ ${p.transitions}/${p.transitionTotal}`, `Cues ${p.cues}/${p.cueTotal} · Transitions ${p.transitions}/${p.transitionTotal}`)}</div>
        <textarea className="notes" placeholder={L('構成案・やることなど', 'Ideas, to-dos…')} value={s.notes}
          onKeyDown={e => e.stopPropagation()} onChange={e => { s.notes = e.target.value; s.markDirty(); s.changed(); }} />
      </Section>
      <MixPatternsSection />
      <Section title={L('ミックス', 'Mix')}>
        <Row label={L('曲数・長さ', 'Tracks · Length')}><span className="mono">{L(`${s.clips.length}曲 · ${Fmt.duration(s.realMixDuration)}`, `${s.clips.length} · ${Fmt.duration(s.realMixDuration)}`)}</span></Row>
        {s.genreSummary().length > 0 && <Row label={L('ジャンル', 'Genres')} title={L('おまかせミックスは曲のジャンルに合わせてつなぎ方を変えます（曲を選んで「デッキ」で変更できます）', 'The auto-mix connects each track the way its genre is usually mixed (change it per track under Deck).')}><span className="caption">{s.genreSummary().map(g => `${Genre.short(g.genre)} ×${g.count}`).join('  ')}</span></Row>}
        <Row label={L('ミックスBPM', 'Mix BPM')}><NumberField value={s.masterBPM} min={40} max={220} onCommit={v => s.setMasterBPM(v)} /></Row>
        <Row label={L('音量をそろえる', 'Loudness')} title={Loudness.detail(s.loudnessMode)}>
          <select value={s.loudnessMode} onChange={e => s.setLoudnessMode(e.target.value as never)}>
            {loudnessModes.map(m => <option key={m} value={m}>{Loudness.title(m)}</option>)}
          </select>
        </Row>
        <div className="caption">{Loudness.detail(s.loudnessMode)}</div>
        <Row label={L('起動時に前回のミックスを開く', 'Open the last mix at start')}><input type="checkbox" checked={s.reopenLast} onChange={() => s.toggle('reopenLast')} /></Row>
        <Row label={L('ミックスに入れてもライブラリに残す', 'Keep tracks in the library when adding them to the mix')} title={L('オンにすると、ライブラリの曲をミックス順に入れても、ライブラリ（とそのフォルダ）からは消えません', 'When on, tracks stay in the library (and its folders) after you add them to the mix order')}><input type="checkbox" checked={s.keepInLibrary} onChange={() => s.toggle('keepInLibrary')} /></Row>
        <Row label={L('曲を追加したら CUE タブを開く', 'Open the CUE tab after adding')}><input type="checkbox" checked={s.openCueEditorOnAdd} onChange={() => s.toggle('openCueEditorOnAdd')} /></Row>
        <Row label={L('曲の音声をファイルに含めて保存', 'Include audio when saving')}><input type="checkbox" checked={s.embedMedia} onChange={() => s.toggle('embedMedia')} /></Row>
        {s.embedMedia && <>
          <Row label={L('WAV を可逆圧縮（FLAC）して小さく', 'Compress WAVs losslessly (FLAC)')} title={L('音は1ビットも変わらず、WAV の曲は半分前後の大きさになります。MP3 などはそのまま入れます', 'Not a single bit of the sound changes; WAV tracks shrink to about half. MP3 and the like go in as they are')}><input type="checkbox" checked={s.compressAudio} onChange={() => s.toggle('compressAudio')} /></Row>
          <Row label={L('ミックスに入れていないライブラリの曲も含める', 'Also include library tracks not in the mix')} title={L('オフにすると、ミックス（と重ねる曲・サンプラー）で使う曲だけを含めます。ライブラリの曲は元のファイルから読みます', 'When off, only the tracks the mix uses (and layered tracks, sampler sounds) go in; library tracks are read from their files')}><input type="checkbox" checked={s.embedLibraryAudio} onChange={() => s.toggle('embedLibraryAudio')} /></Row>
        </>}
      </Section>
      <Section title={L('標準のつなぎ', 'Default Transition')} footer={L('新しく入れた曲のつなぎ方。下のボタンで、いまのミックスのすべてのつなぎを同じにできます（Ctrl+Z で戻せます）。', 'Used for newly added tracks. The buttons below apply a recipe to every transition in the mix (Ctrl+Z undoes it).')}>
        <Row label={L('つなぎ方', 'Style')}>
          <select value={s.defaultTransitionStyle} onChange={e => { s.defaultTransitionStyle = e.target.value as TransitionStyle; s.saveSettings(); s.changed(); }}>
            {styleOrder.filter(x => x !== 'custom').map(st => <option key={st} value={st}>{Style.title(st)}</option>)}
          </select>
        </Row>
        <div className="presets">
          {transitionPresets().map(p => <button key={p.id} className="chip" disabled={s.clips.length < 2} onClick={() => s.applyPresetToAll(p)}>{L('全部を', 'All: ')}{p.title}</button>)}
        </div>
      </Section>
      <AutoMixSection />
      <Section title={L('操作', 'Controls')}>
        <div className="shortcuts-mini">
          <div><kbd>Space</kbd> {L('再生 / 停止', 'Play / pause')}</div>
          <div><kbd>← →</kbd> {L('選んだ曲の入る位置を1小節ずつ', 'Move the selected entry by a bar')}</div>
          <div><kbd>1</kbd>–<kbd>6</kbd> {L('つなぎのレシピ', 'Transition recipes')}</div>
          <div><kbd>Ctrl+T</kbd> {L('つなぎタブ', 'Transition tab')}</div>
          <div><kbd>Ctrl+K</kbd> {L('CUE タブ', 'CUE tab')}</div>
          <div><kbd>Ctrl+L</kbd> {L('ループタブ', 'Loop tab')}</div>
          <div><kbd>Ctrl+/</kbd> {L('ショートカット一覧', 'All shortcuts')}</div>
        </div>
      </Section>
    </div>
  );
}

void clipEnd; void hasEdits; void Lanes; void effectiveLanes;
