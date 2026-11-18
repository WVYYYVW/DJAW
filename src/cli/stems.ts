// node build/cli/stems.js <file.wav> <outdir>: separates vocals / drums / bass / melody and prints the stats.
import path from 'node:path';
import { openPcmFile } from '../core/render/source';
import { loadStemModel } from '../core/analysis/beatmodel';
import { separateStems, stemFiles } from '../core/analysis/stems';

(async () => {
  const [file, out] = process.argv.slice(2);
  const src = openPcmFile(file);
  if (!src) throw new Error('unreadable');
  const model = await loadStemModel(path.join(__dirname, '../../models'));
  if (!model) throw new Error('no model');
  const stats = await separateStems(src, model, stemFiles(out, 'test'), p => { if (Math.round(p * 100) % 25 === 0) process.stderr.write(`${Math.round(p * 100)}% `); });
  console.log(JSON.stringify(stats), (src.frames / src.sampleRate).toFixed(0) + ' s audio');
})().catch(e => { console.error(e); process.exit(1); });
