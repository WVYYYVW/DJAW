import test from 'node:test';
import assert from 'node:assert/strict';
import { Clip, newClip, resetToWholeTrack } from '../src/core/models';
import { layout } from '../src/core/layout';
import { TempoMap } from '../src/core/tempo';
import { MemorySource } from '../src/core/render/source';
import { StretchPool } from '../src/core/render/stretch';
import { RenderSession } from '../src/core/render/session';

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
