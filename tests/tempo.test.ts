// Tempo changes inside the mix (src/core/tempo.ts TempoMap.build): e.g. a track that comes in at −7.5% to match the
// previous one, then goes back to its own speed (0.0%) over some bars once the transition is over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../src/core/layout';
import { TempoMap, tempoStartBars } from '../src/core/tempo';
import { newClip, rate, timelineTimeOfBar, type Clip } from '../src/core/models';

const MASTER = 185;

function mix(change: Partial<Clip>) {
  const a = newClip({ url: 'a', title: 'A', artist: '', duration: 240, bpm: 185, firstBeat: 0, trimEnd: 240 });
  const b = newClip({ url: 'b', title: 'B', artist: '', duration: 240, bpm: 200, firstBeat: 0, trimEnd: 240 });
  a.mixOutBar = 64; b.mixInBar = 0; b.transitionBars = 16;
  Object.assign(b, change);
  const { clips } = layout([a, b], MASTER, 0);
  return { clips, map: TempoMap.build(clips, MASTER) };
}

test('the incoming track first plays at the previous tempo (−7.5%)', () => {
  const { clips } = mix({});
  assert.ok(Math.abs((rate(clips[1], MASTER) - 1) * 100 - -7.5) < 0.01);
});

test('after the transition, the tempo goes back to the track’s own speed over the chosen bars', () => {
  const { clips, map } = mix({ tempo: 200, tempoStart: 'afterTransition', tempoBars: 8 });
  const b = clips[1];
  assert.equal(tempoStartBars(b), 16);
  const mixIn = timelineTimeOfBar(b, b.mixInBar, MASTER);
  const from = timelineTimeOfBar(b, b.mixInBar + 16, MASTER);
  const bar = 240 / MASTER;
  // Unchanged through the transition.
  assert.ok(Math.abs(map.bpm(mixIn + 1) - 185) < 1e-6);
  assert.ok(Math.abs(map.bpm(from - 0.01) - 185) < 1e-6);
  // Half-way through the 8 bars, then at the track's own BPM (pitch 0.0%) from there on.
  assert.ok(Math.abs(map.bpm(from + 4 * bar) - 192.5) < 1e-6);
  assert.ok(Math.abs(map.bpm(from + 8 * bar + 0.01) - 200) < 1e-6);
  assert.ok(Math.abs(map.bpm(from + 100) - 200) < 1e-6);
});

test('where the track comes in (the old behaviour) and a number of bars after it', () => {
  const old = mix({ tempo: 200, tempoBars: 8 });
  const mixIn = timelineTimeOfBar(old.clips[1], old.clips[1].mixInBar, MASTER);
  assert.ok(old.map.bpm(mixIn + 1) > 185);
  const later = mix({ tempo: 200, tempoStart: 4, tempoBars: 0 });
  const at = timelineTimeOfBar(later.clips[1], later.clips[1].mixInBar + 4, MASTER);
  assert.ok(Math.abs(later.map.bpm(at - 0.01) - 185) < 1e-6);
  assert.ok(Math.abs(later.map.bpm(at + 0.01) - 200) < 1e-6);
});

test('the next track can come in on a chosen pass of a loop, while the loop keeps repeating', async () => {
  const { mixOutTime, passesAtBar } = await import('../src/core/models');
  const a = newClip({ url: 'a', title: 'A', artist: '', duration: 120, bpm: 120, firstBeat: 0, trimEnd: 120 });
  const b = newClip({ url: 'b', title: 'B', artist: '', duration: 120, bpm: 120, firstBeat: 0, trimEnd: 120 });
  // A loops bars 8–12 four times (×4 = 3 repeats); B comes in on the 2nd pass, overlapping for 8 bars.
  a.edits = [{ id: 'l', kind: 'loop', bar: 8, bars: 4, repeats: 3 }];
  a.mixInBar = 0; a.mixOutBar = 8; a.outPass = 2;
  b.mixInBar = 0; b.transitionBars = 8;
  const { clips } = layout([a, b], 120, 0);
  const bar = 2; // seconds at 120 BPM
  assert.equal(passesAtBar(clips[0], 9), 4);
  // Pass 2 of the loop starts after bars 0–8 and one pass (4 bars): 12 bars in.
  assert.ok(Math.abs(clips[1].start - (clips[0].start + 12 * bar)) < 1e-6, `B starts at ${clips[1].start}`);
  assert.ok(Math.abs(mixOutTime(clips[0], 120) - clips[1].start) < 1e-6);
  // A keeps looping under B: it plays 12 + 8 bars (passes 2 and 3 of the loop), not past the loop.
  assert.ok(Math.abs((clips[0].playLength ?? 0) - 20 * bar) < 1e-3, `A plays ${clips[0].playLength}`);
  // Without a pass: the last pass (as before).
  const old = layout([{ ...a, outPass: null }, b], 120, 0).clips;
  assert.ok(Math.abs(old[1].start - (old[0].start + 20 * bar)) < 1e-6);
});
