// A preset transition's lanes (src/core/models.ts Lanes.sampled / Lanes.points): the transition editor finds the
// selected or double-clicked point by its id, so the ids must not change from one draw to the next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lanes, Shape, type TransitionLanes, type TransitionStyle } from '../src/core/models';

const styles: TransitionStyle[] = ['crossfade', 'bassSwap', 'filter', 'echoOut', 'cut', 'brake', 'backspin'];

test('a preset transition keeps the same point ids each time it is sampled', () => {
  for (const style of styles) {
    const a = Lanes.sampled(style, Shape.defaults(style)), b = Lanes.sampled(style, Shape.defaults(style));
    for (const key of Object.keys(a) as (keyof TransitionLanes)[]) {
      const pa = a[key] ?? [], pb = b[key] ?? [];
      assert.deepEqual(pa.map(p => p.id), pb.map(p => p.id), `${style} ${String(key)}`);
      assert.equal(new Set(pa.map(p => p.id)).size, pa.length, `${style} ${String(key)}: ids are unique`);
    }
  }
});

test('an undrawn lane keeps the same point ids', () => {
  const l = Lanes.sampled('crossfade', Shape.defaults('crossfade'));
  assert.deepEqual(Lanes.points(l, 'filter', true).map(p => p.id), Lanes.points(l, 'filter', true).map(p => p.id));
});

test('a middle point of a preset transition can be deleted by its id', () => {
  const style: TransitionStyle = 'bassSwap';
  const before = Lanes.sampled(style, Shape.defaults(style));
  const pts = Lanes.points(before, 'low', true);
  assert.ok(pts.length >= 3, 'the bass lane has a middle point');
  const victim = pts[1].id;
  // As the editor does it: the lanes are re-sampled, and the point is looked up by the id from the earlier draw.
  const again = Lanes.points(Lanes.sampled(style, Shape.defaults(style)), 'low', true);
  const k = again.findIndex(p => p.id === victim);
  assert.equal(k, 1);
  const after = Lanes.setPoints(before, 'low', true, again.filter(p => p.id !== victim));
  assert.equal(Lanes.points(after, 'low', true).length, pts.length - 1);
});
