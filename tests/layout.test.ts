import test from 'node:test';
import assert from 'node:assert/strict';
import { readProject } from '../src/core/project';
import { layout } from '../src/core/layout';
import { TempoMap } from '../src/core/tempo';
import { clipEnd } from '../src/core/models';
import { fixture } from './fixtures';

const hf = fixture('hyperflip.djaw');

test('layout reproduces the Mac placement of hyperflip.djaw', { skip: !hf }, () => {
  const { file } = readProject(hf!);
  const { clips, gridOffset } = layout(file.clips, file.masterBPM, file.gridOffset);
  for (const [i, c] of clips.entries()) {
    const m = file.clips[i];
    assert.ok(Math.abs(c.start - m.start) < 1e-6, `start ${i}: ${c.start} vs ${m.start}`);
    assert.ok(Math.abs(c.trimStart - m.trimStart) < 1e-6, `trimStart ${i}`);
    assert.ok(Math.abs(c.trimEnd - m.trimEnd) < 1e-6, `trimEnd ${i}: ${c.trimEnd} vs ${m.trimEnd}`);
  }
  assert.ok(Math.abs(gridOffset - file.gridOffset) < 1e-6, `gridOffset ${gridOffset} vs ${file.gridOffset}`);
  const map = TempoMap.build(clips, file.masterBPM);
  const end = Math.max(...clips.map(c => clipEnd(c, file.masterBPM)));
  console.log('mix', end.toFixed(2), 's reference,', map.real(end).toFixed(2), 's real; tempo points', map.points.length);
});
