// Tracks found by their path relative to the mix (src/core/paths.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRelative } from '../src/core/paths';

test('a relative path is found in either Unicode form', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djaw-paths-'));
  fs.mkdirSync(path.join(dir, '曲'));
  const name = 'がくがく.mp3'.normalize('NFD');
  fs.writeFileSync(path.join(dir, '曲', name), 'x');
  const found = resolveRelative(dir, '曲/' + 'がくがく.mp3'.normalize('NFC'));
  assert.ok(found && fs.existsSync(found));
  assert.equal(resolveRelative(dir, '曲/none.mp3'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
