// Developer tool: node build/cli/analyze.js <audio.wav> [--no-neural]
import path from 'node:path';
import { openPcmFile } from '../core/render/source';
import { analyzeAudio } from '../core/analysis/analyzer';
import { loadBeatModel } from '../core/analysis/beatmodel';
import { Key, Structure } from '../core/analysis/structure';

async function main() {
  const file = process.argv[2];
  const src = openPcmFile(file);
  if (!src) throw new Error('not a PCM file');
  const model = process.argv.includes('--no-neural') ? null : await loadBeatModel(path.join(__dirname, '../../models/beatthis.onnx'));
  const t0 = Date.now();
  const a = await analyzeAudio(src, { beatModel: model });
  console.log(JSON.stringify({
    file: path.basename(file), seconds: ((Date.now() - t0) / 1000).toFixed(1), duration: a.duration.toFixed(2),
    bpm: +a.bpm.toFixed(3), firstBeat: +a.firstBeat.toFixed(4), key: a.structure?.key ? Key.camelot(a.structure.key) : null,
    neural: a.neural?.grid ? { bpm: +a.neural.grid.bpm.toFixed(3), fb: +a.neural.grid.firstBeat.toFixed(4), beats: a.neural.beats.length } : null,
    structure: a.structure ? Structure.summary(a.structure) : null,
  }));
}
main().catch(e => { console.error(e); process.exit(1); });
