// Developer tool: node build/cli/analyze.js <audio.wav> [--no-neural]
import path from 'node:path';
import { openPcmFile } from '../core/render/source';
import { analyzeAudio } from '../core/analysis/analyzer';
import { loadBeatModel, loadCueModel, loadGenreModel } from '../core/analysis/beatmodel';
import { Genres } from '../core/genre';
import { Key, Structure } from '../core/analysis/structure';

async function main() {
  const file = process.argv[2];
  const src = openPcmFile(file);
  if (!src) throw new Error('not a PCM file');
  const model = process.argv.includes('--no-neural') ? null : await loadBeatModel(path.join(__dirname, '../../models/beatthis.onnx'));
  const t0 = Date.now();
  const dir = path.join(__dirname, '../../models');
  const nn = !process.argv.includes('--no-neural');
  const a = await analyzeAudio(src, { beatModel: model, cues: nn ? await loadCueModel(dir) : null, genre: nn ? await loadGenreModel(dir) : null });
  console.log(JSON.stringify({
    file: path.basename(file), seconds: ((Date.now() - t0) / 1000).toFixed(1), duration: a.duration.toFixed(2),
    bpm: +a.bpm.toFixed(3), firstBeat: +a.firstBeat.toFixed(4), key: a.structure?.key ? Key.camelot(a.structure.key) : null,
    neural: a.neural?.grid ? { bpm: +a.neural.grid.bpm.toFixed(3), fb: +a.neural.grid.firstBeat.toFixed(4), beats: a.neural.beats.length } : null,
    structure: a.structure ? Structure.summary(a.structure) : null,
    cues: a.neural?.cues.map(c => +c.time.toFixed(2)),
    genre: a.genre ? { best: Genres.detected(a.genre), styles: a.genre.styles.slice(0, 3).map(s => `${s.label} ${s.score.toFixed(2)}`), traits: a.genre.traits?.map(t => +t.toFixed(2)), vocalPatches: a.genre.voice?.length } : null,
  }));
}
main().catch(e => { console.error(e); process.exit(1); });
