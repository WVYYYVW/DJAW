import test from 'node:test';
import assert from 'node:assert/strict';
import { Clip, Lanes, Shape, newClip, pt, resetToWholeTrack } from '../src/core/models';
import { layout } from '../src/core/layout';
import { TempoMap } from '../src/core/tempo';
import { MemorySource } from '../src/core/render/source';
import { StretchPool } from '../src/core/render/stretch';
import { RenderSession, type StemSources } from '../src/core/render/session';
import { Sampler } from '../src/core/sampler';
import { CancelFlag, renderPeakRange, renderPeaks } from '../src/core/render/offline';
import { mixWaveformChange, provisionalPeaks, splicePeaks } from '../src/core/render/mixWaveform';

const sr = 44100;

/** A track of short clicks on every beat (bpm), `seconds` long. */
function clickTrack(bpm: number, seconds: number, firstBeat = 0.5) {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let t = firstBeat; t < seconds - 0.1; t += 60 / bpm) {
    const c = Math.round(t * sr);
    for (let i = 0; i < 64; i++) x[c + i] = (i < 2 ? 0.9 : 0.9 * Math.exp(-i / 6)) * (i % 2 ? -1 : 1);
  }
  return x;
}

function clip(url: string, bpm: number, seconds: number, firstBeat = 0.5): Clip {
  const c = newClip({ url, title: url, artist: '', duration: seconds, bpm, firstBeat, trimEnd: seconds });
  resetToWholeTrack(c);
  return c;
}

/** Times (s) of click onsets: where a 1 ms envelope first reaches half of each burst's peak. */
function onsets(x: Float32Array) {
  const w = 44;
  const env = new Float32Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += Math.abs(x[i]) - (i >= w ? Math.abs(x[i - w]) : 0);
    env[i] = acc / w;
  }
  let max = 0;
  for (const v of env) max = Math.max(max, v);
  const out: number[] = [];
  let i = 0;
  while (i < env.length) {
    if (env[i] > max * 0.3) {
      let j = i, peak = env[i];
      while (j < env.length && j < i + sr * 0.01) { peak = Math.max(peak, env[j]); j++; }
      let k = i;
      while (k > 0 && env[k - 1] >= peak * 0.5) k--;
      while (k < j && env[k] < peak * 0.5) k++;
      out.push((k - w / 2) / sr);
      i += Math.round(sr * 0.2);
    } else i++;
  }
  return out;
}

async function render(clips: Clip[], master: number, seconds: number, sources: Record<string, Float32Array>, from = 0) {
  const { clips: laid, gridOffset } = layout(clips, master, 0);
  const tempo = TempoMap.build(laid, master);
  const session = await RenderSession.create({
    clips: laid, master, tempo, gridOffset, sampleRate: sr, from,
    open: c => new MemorySource(sr, sources[c.url]), pool: new StretchPool(sr),
  });
  const out = new Float32Array(Math.round(seconds * sr));
  let p = 0;
  while (p < out.length) {
    const n = session.renderNext();
    out.set(session.L.subarray(0, Math.min(n, out.length - p)), p);
    p += n;
  }
  session.stop();
  return { out, clips: laid, tempo };
}

test('a stretched track stays on the beat (no drift)', async () => {
  const src = clickTrack(120, 40);
  const c = clip('a', 120, 40);
  const { out, clips } = await render([c], 126, 36, { a: src });
  const got = onsets(out);
  const r = 126 / 120;
  // Click k of the source plays at start + (0.5 + k·0.5 − trimStart) / rate.
  let worst = 0;
  for (const t of got) {
    const k = Math.round(((t - clips[0].start) * r + clips[0].trimStart - 0.5) / 0.5);
    const want = clips[0].start + (0.5 + k * 0.5 - clips[0].trimStart) / r;
    worst = Math.max(worst, Math.abs(t - want));
  }
  assert.ok(got.length > 60, `clicks found: ${got.length}`);
  assert.ok(worst < 0.0015, `worst beat error ${(worst * 1000).toFixed(2)} ms`);
});

test('starting in the middle gives the same audio as from the start', async () => {
  const src = clickTrack(120, 40);
  const c = clip('a', 120, 40);
  const full = (await render([c], 120, 30, { a: src })).out;
  const part = (await render([c], 120, 10, { a: src }, 20)).out;
  const a = onsets(full).filter(t => t >= 20.2 && t < 29).map(t => t - 20);
  const b = onsets(part).filter(t => t >= 0.2 && t < 9);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.001, `click ${i}: ${a[i]} vs ${b[i]}`);
});

test('a cut-in switches on the bar with neither gap nor overlap', async () => {
  const a = clickTrack(120, 30), b = clickTrack(120, 30, 0.25);
  const ca = clip('a', 120, 30), cb = clip('b', 120, 30, 0.25);
  ca.mixOutBar = 8;            // a plays bars 0…8, b comes in at its bar 2
  cb.mixInBar = 2;
  cb.transition = 'cut';
  cb.transitionBars = 0;
  const { out, clips } = await render([ca, cb], 120, 26, { a, b });
  const cut = clips[1].start;
  const got = onsets(out);
  // Beats keep going every 0.5 s across the cut.
  const near = got.filter(t => t > cut - 2 && t < cut + 2);
  for (let i = 1; i < near.length; i++) assert.ok(Math.abs(near[i] - near[i - 1] - 0.5) < 0.0015, `beat spacing at the cut: ${near[i] - near[i - 1]}`);
  // Only one track is heard after the cut (no doubled clicks).
  const after = got.filter(t => t > cut + 0.1 && t < cut + 6);
  assert.ok(after.length >= 10 && after.length <= 12, `clicks after the cut: ${after.length}`);
});

/** Level of one frequency in x[a, b) (Goertzel, normalised). */
function tone(x: Float32Array, hz: number, a: number, b: number) {
  const k = 2 * Math.cos(2 * Math.PI * hz / sr);
  let s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { const s0 = x[i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (b - a);
}

test('stem lanes turn the separated stems down (vocals, drums, bass, melody)', async () => {
  const sine = (hz: number, n: number, amp = 0.3) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sr));
  const n = 30 * sr;
  // vocals 440 Hz, drums 1000 Hz, bass 110 Hz, melody 2500 Hz.
  const parts = [sine(440, n), sine(1000, n), sine(110, n), sine(2500, n)];
  const mixed = parts[0].map((_, i) => parts[0][i] + parts[1][i] + parts[2][i] + parts[3][i]);
  const ca = clip('a', 120, 30), cb = clip('b', 120, 30);
  ca.mixOutBar = 8;
  cb.mixInBar = 0;
  cb.transition = 'custom';
  cb.transitionBars = 8;
  let lanes = Lanes.sampled('bassSwap', Shape.defaults('bassSwap'));
  lanes.inVocal = [pt(0, 0), pt(1, 0)];
  lanes.inBass = [pt(0, 0), pt(1, 0)];
  cb.lanes = lanes;
  const run = async (withStems: boolean) => {
    const { clips: laid, gridOffset } = layout([ca, cb], 120, 0);
    const tempo = TempoMap.build(laid, 120);
    const session = await RenderSession.create({
      clips: laid, master: 120, tempo, gridOffset, sampleRate: sr,
      open: c => new MemorySource(sr, c.url === 'a' ? new Float32Array(n) : mixed), pool: new StretchPool(sr),
      openStems: withStems ? c => (c.url === 'b' ? parts.map(p => new MemorySource(sr, p)) as unknown as StemSources : null) : undefined,
    });
    const out = new Float32Array(Math.round(42 * sr));
    let p = 0;
    while (p < out.length) { const k = session.renderNext(); out.set(session.L.subarray(0, Math.min(k, out.length - p)), p); p += k; }
    session.stop();
    const s = tempo.real(laid[1].start);
    const a = Math.round((s + 6) * sr), b = Math.round((s + 10) * sr);
    return { mid: [440, 1000, 110, 2500].map(hz => tone(out, hz, a, b)), after: tone(out, 440, Math.round((s + 18) * sr), Math.round((s + 21) * sr)) };
  };
  const plain = await run(false), stems = await run(true);
  assert.ok(plain.mid[0] > 0.02, `without stems the vocals are heard: ${plain.mid[0]}`);
  assert.ok(stems.mid[0] < plain.mid[0] * 0.05, `vocals turned down: ${stems.mid[0]} vs ${plain.mid[0]}`);
  assert.ok(stems.mid[2] < plain.mid[2] * 0.05, `bass turned down: ${stems.mid[2]} vs ${plain.mid[2]}`);
  assert.ok(stems.mid[1] > plain.mid[1] * 0.8, `drums kept: ${stems.mid[1]} vs ${plain.mid[1]}`);
  assert.ok(stems.mid[3] > plain.mid[3] * 0.8, `melody kept: ${stems.mid[3]} vs ${plain.mid[3]}`);
  assert.ok(stems.after > plain.mid[0] * 0.5, `vocals back after the transition: ${stems.after}`);
  // Presets that keep one stem draw the others too.
  lanes = Lanes.applyEffectPreset(Lanes.sampled('bassSwap', Shape.defaults('bassSwap')), Lanes.effectPresets('drums')[0], 'drums');
  assert.ok(Lanes.isActive(lanes, 'melody', true) && Lanes.isActive(lanes, 'bass', true) && !Lanes.isActive(lanes, 'drums', true));
});

test('mix waveform: re-rendering only the changed stretch matches a full render', async () => {
  const srcs = { a: clickTrack(120, 40), b: clickTrack(120, 40, 0.25), c: clickTrack(128, 40, 0.3) };
  const make = () => {
    const ca = clip('a', 120, 40), cb = clip('b', 120, 40, 0.25), cc = clip('c', 128, 40, 0.3);
    ca.mixOutBar = 14; cb.mixInBar = 0; cb.mixOutBar = 14; cb.transitionBars = 4; cc.mixInBar = 0; cc.transitionBars = 4;
    return [ca, cb, cc];
  };
  const before = make();
  const after = structuredClone(before);
  after[1].mixOutBar = 12;          // the second track ends 2 bars earlier: the third moves with it
  const inputsOf = (cl: Clip[]) => {
    const { clips, gridOffset } = layout(cl, 124, 0);
    return { clips, master: 124, tempo: TempoMap.build(clips, 124), gridOffset, sampleRate: sr, stems: '' };
  };
  const ia = inputsOf(before), ib = inputsOf(after);
  const mi = (i: typeof ia) => ({ ...i, open: (c: Clip) => new MemorySource(sr, srcs[c.url as 'a']), pool: new StretchPool(sr) });
  const full = async (i: typeof ia) => renderPeaks(mi(i), new CancelFlag(), () => {});
  const old = await full(ia);
  const ch = mixWaveformChange(ia, ib);
  assert.ok(ch, 'a change is found');
  assert.ok(ch!.toReal < ib.tempo.real(ib.clips[2].start) + 30, `only part is rendered again: ${ch!.fromReal.toFixed(2)}…${ch!.toReal.toFixed(2)}`);
  const prov = provisionalPeaks(ch!, old, ib)!;
  const part = await renderPeakRange(mi(ib), old.binsPerSecond, ch!.fromReal, ch!.toReal, new CancelFlag());
  const spliced = splicePeaks(prov, part);
  const exact = await full(ib);
  let worst = 0, n = Math.min(exact.maxs.length, spliced.maxs.length);
  for (let k = 0; k < n; k++) worst = Math.max(worst, Math.abs(exact.maxs[k] - spliced.maxs[k]), Math.abs(exact.mins[k] - spliced.mins[k]));
  assert.ok(Math.abs(exact.maxs.length - spliced.maxs.length) <= 1, `length ${exact.maxs.length} vs ${spliced.maxs.length}`);
  assert.ok(worst < (ch!.exact ? 1e-4 : 2), `worst bin difference ${worst} (exact: ${ch!.exact})`);
  // Moved by whole bins or not, nearly every bin matches.
  let off = 0;
  for (let k = 0; k < n; k++) if (Math.abs(exact.maxs[k] - spliced.maxs[k]) > 0.05) off++;
  assert.ok(off < n * 0.01, `bins that differ: ${off} of ${n}`);
});

test('sampler hits land on their beat, the same from the start or the middle', async () => {
  const shot = Float32Array.from({ length: 2000 }, (_, i) => (i < 4 ? 0.9 : 0));   // a click
  const c = clip('a', 120, 30);
  const { clips, gridOffset } = layout([c], 120, 0);
  const tempo = TempoMap.build(clips, 120);
  const samples = [Sampler.newSample('shot.wav', 'shot', 0)];
  const hits = [{ ...Sampler.newHit(samples[0].id, 8), repeats: 3, every: 0.5 }, Sampler.newHit(samples[0].id, 20)];
  const input = Sampler.expand(samples, hits, 120, gridOffset);
  const render = async (from: number) => {
    const session = await RenderSession.create({
      clips, master: 120, tempo, gridOffset, sampleRate: sr, from,
      open: () => new MemorySource(sr, new Float32Array(30 * sr)), pool: new StretchPool(sr),
      sampler: { input, open: () => new MemorySource(sr, shot) },
    });
    const start = session.absoluteFrame;
    const out = new Float32Array(Math.round(14 * sr) - start);
    let p = 0;
    while (p < out.length) { const k = session.renderNext(); out.set(session.L.subarray(0, Math.min(k, out.length - p)), p); p += k; }
    session.stop();
    return { start, out };
  };
  const a = await render(0);
  const clicks: number[] = [];
  for (let i = 0; i < a.out.length; i++) if (a.out[i] > 0.5 && (i === 0 || a.out[i - 1] < 0.5)) clicks.push(a.start + i);
  const expect = [8, 8.5, 9, 9.5, 20].map(b => Math.round(tempo.real(Sampler.timeOfBeat(b, 120, gridOffset)) * sr));
  assert.deepEqual(clicks, expect, 'every play on its exact frame');
  const b = await render(Sampler.timeOfBeat(9, 120, gridOffset) - 0.01);
  for (let i = 0; i < b.out.length; i++) assert.equal(b.out[i], a.out[b.start - a.start + i], `frame ${b.start + i} differs`);
});

test('a layered track plays on its mix track’s bar, at the mix tempo, for its own bars', async () => {
  const { placeLayers } = await import('../src/core/layers');
  const { timelineTimeOfBar } = await import('../src/core/models');
  const master = 120;
  const host = clip('host', 120, 40);
  const layer = clip('layer', 100, 40, 0.3);
  Object.assign(layer, { id: 'L1', layerOf: host.id, layerBar: 4, mixInBar: 2, mixOutBar: 6, fadeInBeats: 0, fadeOutBeats: 0 });
  const { clips: laid, gridOffset } = layout([host], master, 0);
  const tempo = TempoMap.build(laid, master);
  const placed = placeLayers([layer], laid, master);
  const sources: Record<string, Float32Array> = { host: new Float32Array(40 * sr), layer: clickTrack(100, 40, 0.6) };
  const session = await RenderSession.create({
    clips: laid, layers: placed, master, tempo, gridOffset, sampleRate: sr,
    open: c => new MemorySource(sr, sources[c.url]), pool: new StretchPool(sr),
  });
  const out = new Float32Array(20 * sr);
  let p = 0;
  while (p < out.length) { const n = session.renderNext(); out.set(session.L.subarray(0, Math.min(n, out.length - p)), p); p += n; }
  session.stop();
  const got = onsets(out);
  const t0 = timelineTimeOfBar(laid[0], 4, master);
  // 4 bars of the layered track = 16 off-beat clicks, half a second apart at 120 BPM, from the host's bar 4.
  assert.equal(got.length, 16, `clicks: ${got.map(t => t.toFixed(3)).join(' ')}`);
  got.forEach((t, k) => assert.ok(Math.abs(t - (t0 + 0.25 + k * 0.5)) < 0.0015, `click ${k} at ${t.toFixed(4)}, want ${(t0 + 0.25 + k * 0.5).toFixed(4)}`));
});
