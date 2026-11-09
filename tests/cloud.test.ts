// Cloud sync folder helpers (src/core/cloud.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Presence, cloudPaths, copyTracksIntoCloud, deviceName, detectMegaRoots, isInside, listCloudMixes, resolveRelative, writeFileAtomic } from '../src/core/cloud';
import { encodeProject } from '../src/core/project';
import { newClip, projectFormatID } from '../src/core/models';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-cloud-'));

test('tracks are copied once, reused by content, renamed on a clash', async () => {
  const home = tmp(), root = path.join(home, 'MEGA'), music = path.join(home, 'Music');
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, '.debris')); fs.mkdirSync(music); fs.mkdirSync(path.join(music, 'other'));
  const a = path.join(music, 'track.mp3'), b = path.join(music, 'other', 'track.mp3');
  fs.writeFileSync(a, Buffer.alloc(1000, 1));
  fs.writeFileSync(b, Buffer.alloc(1200, 2));
  const m1 = await copyTracksIntoCloud([a, b, a], root);
  const { tracks } = cloudPaths(root);
  assert.equal(m1.get(a), path.join(tracks, 'track.mp3'));
  assert.equal(m1.get(b), path.join(tracks, 'track (2).mp3'));
  assert.deepEqual(fs.readdirSync(tracks).sort(), ['track (2).mp3', 'track.mp3'], 'no temporary files left');
  // Again (e.g. the next save, or the same file on another computer): nothing new is copied.
  const before = fs.statSync(path.join(tracks, 'track.mp3')).mtimeMs;
  const m2 = await copyTracksIntoCloud([a, b], root);
  assert.equal(m2.get(b), path.join(tracks, 'track (2).mp3'));
  assert.equal(fs.statSync(path.join(tracks, 'track.mp3')).mtimeMs, before);
  assert.equal(fs.readdirSync(tracks).length, 2);
  // Files already in the sync folder stay where they are.
  const inside = path.join(root, 'mine.wav');
  fs.writeFileSync(inside, 'x');
  assert.equal((await copyTracksIntoCloud([inside], root)).get(inside), inside);
  assert.deepEqual(detectMegaRoots(home), [root]);
  assert.ok(isInside(root, inside) && !isInside(root, a) && !isInside(root, root));
});

test('relative paths resolve whichever Unicode form the other computer used', () => {
  const dir = tmp();
  const name = 'がくがく.mp3';
  fs.mkdirSync(path.join(dir, '曲'));
  fs.writeFileSync(path.join(dir, '曲', name.normalize('NFD')), 'x');
  assert.ok(resolveRelative(dir, '曲/' + name.normalize('NFC')));
  assert.equal(resolveRelative(dir, '曲/none.mp3'), null);
});

test('mix list and "open on another computer" notes', () => {
  const root = tmp();
  const { dir } = cloudPaths(root);
  const c = newClip({ url: path.join(dir, '曲', 'gone.mp3'), title: 'gone', artist: '', duration: 10, bpm: 120, firstBeat: 0, trimEnd: 10 });
  c.relativePath = '曲/gone.mp3';
  writeFileAtomic(path.join(dir, 'Set.djaw'), encodeProject({ format: projectFormatID, version: 2, masterBPM: 120, gridOffset: 0, defaultTransitionBars: 16, snap: 'bar', clips: [c], projectID: 'P1', savedOn: 'Studio（Mac）', savedAt: '2026-11-09T08:00:00Z' }));
  const list = listCloudMixes(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].savedOn, 'Studio（Mac）');
  assert.equal(list[0].waiting, 1, 'the track has not arrived yet');
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('.')), [], 'no temporary files left');
  Presence.write(root, 'P1', 'Set');
  assert.deepEqual(Presence.others(root, 'P1'), [], 'this computer is not "another" one');
  const other = path.join(cloudPaths(root).presence, 'P1__Studio.json');
  fs.writeFileSync(other, JSON.stringify({ device: 'Studio（Mac）', at: Date.now(), title: 'Set' }));
  assert.equal(Presence.others(root, 'P1')[0].device, 'Studio（Mac）');
  assert.equal(Presence.others(root, 'P1', Date.now() + 10 * 60_000).length, 0, 'old notes are ignored');
  Presence.remove(root, 'P1');
  assert.ok(!fs.readdirSync(cloudPaths(root).presence).some(n => n.includes(deviceName().slice(0, 5))));
});
