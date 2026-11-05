// node build/cli/stems.js <file.wav> <outdir>: separates vocals / instrumental and prints the stats.
import path from 'node:path';
import { openPcmFile } from '../core/render/source';
import { loadVocalModel } from '../core/analysis/beatmodel';
import { separateStems } from '../core/analysis/stems';

(async () => {
  const [file, out] = process.argv.slice(2);
  const src = openPcmFile(file);
  if (!src) throw new Error('unreadable');
  const model = await loadVocalModel(path.join(__dirname, '../../models'));
  if (!model) throw new Error('no model');
  const t = Date.now();
  const stats = await separateStems(src, model, { vocals: path.join(out, 'v.wav'), instrumental: path.join(out, 'i.wav') });
  console.log(JSON.stringify(stats), ((Date.now() - t) / 1000).toFixed(1) + ' s', (src.frames / src.sampleRate).toFixed(0) + ' s audio');
})().catch(e => { console.error(e); process.exit(1); });
