// Developer tool: renders a .djaw with the engine, without the app.
//   node build/cli/render.js <mix.djaw> <out.wav> [--from seconds] [--seconds n] [--no-normalize]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractMedia, readProject, unpackedName } from '../core/project';
import { layout } from '../core/layout';
import { TempoMap } from '../core/tempo';
import { openPcmFile } from '../core/render/source';
import { StretchPool } from '../core/render/stretch';
import { CancelFlag, exportWav } from '../core/render/offline';
import { RenderSession } from '../core/render/session';
import { WavWriter } from '../core/render/wav';

async function main() {
  const args = process.argv.slice(2);
  const [input, output] = args;
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const { file, blobStart } = readProject(input);
  const media = new Map((file.media ?? []).map(m => [m.id, m]));
  const dir = path.join(os.tmpdir(), 'djaw-media', file.projectID ?? 'x');
  const fix = (c: typeof file.clips[number]) => {
    if (fs.existsSync(c.url)) return c;
    const m = c.mediaID ? media.get(c.mediaID) : undefined;
    if (m && blobStart != null) {
      const dest = path.join(dir, unpackedName(m));
      extractMedia(m, input, blobStart, dest);
      return { ...c, url: dest };
    }
    return c;
  };
  const clips0 = file.clips.map(fix);
  const { clips, gridOffset } = layout(clips0, file.masterBPM, file.gridOffset);
  const tempo = TempoMap.build(clips, file.masterBPM);
  const sr = 44100;
  const pool = new StretchPool(sr);
  const open = (c: typeof clips[number]) => openPcmFile(c.url);
  const t0 = Date.now();
  const from = opt('--from'), secs = opt('--seconds');
  if (from || secs) {
    const session = await RenderSession.create({ clips, master: file.masterBPM, tempo, gridOffset, sampleRate: sr, open, pool, from: tempo.referenceAtReal(Number(from ?? 0)) });
    const w = new WavWriter(output, sr, 24);
    const total = Math.round(Number(secs ?? 30) * sr);
    while (session.renderedFrames < total) { const n = session.renderNext(); w.write(session.L, session.R, n); }
    w.close();
    session.stop();
  } else {
    await exportWav({ clips, master: file.masterBPM, tempo, gridOffset, sampleRate: sr, open, pool }, output,
      { sampleRate: sr, normalize: !args.includes('--no-normalize'), bits: 24 }, new CancelFlag(), p => {
        if (Math.round(p * 100) % 10 === 0) process.stdout.write(`\r${Math.round(p * 100)}%`);
      });
  }
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
main().catch(e => { console.error(e); process.exit(1); });
