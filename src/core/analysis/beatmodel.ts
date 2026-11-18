// The ONNX models through onnxruntime-node (native): Beat This!, CUE-DETR, Discogs-EffNet + heads, Spleeter.
// Files are in models/ (see tools/models/ for how they were made).
import fs from 'node:fs';
import path from 'node:path';
import { BeatModel, CueAssets } from './neural';
import { GenreAssets } from './genreModel';

type Ort = typeof import('onnxruntime-node');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ort = (): Ort => require('onnxruntime-node') as Ort;

async function session(file: string) {
  return ort().InferenceSession.create(file, { graphOptimizationLevel: 'all' });
}

const floats = (file: string) => {
  const b = fs.readFileSync(file);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

export async function loadBeatModel(modelPath: string): Promise<BeatModel | null> {
  try {
    const s = await session(modelPath);
    return async (mag, frames) => {
      const out = await s.run({ mag: new (ort().Tensor)('float32', mag, [1, frames, 513]) });
      return { beat: out.beat.data as Float32Array, downbeat: out.downbeat.data as Float32Array };
    };
  } catch (e) {
    console.warn('[DJAW] beat model unavailable:', (e as Error).message);
    return null;
  }
}

export async function loadCueModel(dir: string): Promise<CueAssets | null> {
  try {
    const s = await session(path.join(dir, 'cuedetr.onnx'));
    return {
      model: async (pixels, batch) => {
        const out = await s.run({ pixel_values: new (ort().Tensor)('float32', pixels, [batch, 3, 128, 355]) });
        return { score: out.score.data as Float32Array, boxes: out.boxes.data as Float32Array };
      },
      melfb: floats(path.join(dir, 'cuedetr_melfb_128x1025.f32')),
      lut: new Uint8Array(fs.readFileSync(path.join(dir, 'viridis_256x3.u8'))),
    };
  } catch (e) {
    console.warn('[DJAW] cue model unavailable:', (e as Error).message);
    return null;
  }
}

export async function loadGenreModel(dir: string): Promise<GenreAssets | null> {
  try {
    const eff = await session(path.join(dir, 'effnet.onnx'));
    const head = async (name: string, positive: number) => {
      const s = await session(path.join(dir, `head_${name}.onnx`));
      const input = s.inputNames[0], output = s.outputNames[0];
      return { positive, run: async (emb: Float32Array, batch: number) => (await s.run({ [input]: new (ort().Tensor)('float32', emb, [batch, 1280]) }))[output].data as Float32Array };
    };
    // Classes: voice_instrumental [instrumental, voice], mood_party [non_party, party],
    // mood_aggressive [aggressive, not_aggressive], danceability [danceable, not_danceable].
    const heads = [await head('voice_instrumental', 1), await head('mood_party', 1), await head('mood_aggressive', 0), await head('danceability', 0)];
    return {
      effnet: async (mel, batch) => {
        const out = await eff.run({ melspectrogram: new (ort().Tensor)('float32', mel, [batch, 128, 96]) });
        return { activations: out.activations.data as Float32Array, embeddings: out.embeddings.data as Float32Array };
      },
      heads,
      melfb: floats(path.join(dir, 'effnet_melfb_96x257.f32')),
      labels: fs.readFileSync(path.join(dir, 'genre_discogs400_labels.txt'), 'utf8').split('\n').map(x => x.trim()).filter(Boolean),
    };
  } catch (e) {
    console.warn('[DJAW] genre model unavailable:', (e as Error).message);
    return null;
  }
}

/** Spleeter vocal mask: magnitude (1 × 2 × 512 × 1024) → vocal ratio mask (same shape). */

/** Spleeter 4-stems: magnitude [1, 2, 512, 1024] → the four stems' magnitude estimates (vocals, drums, bass, other). */
export type StemModel = (magnitude: Float32Array) => Promise<Float32Array[]>;

export async function loadStemModel(dir: string): Promise<StemModel | null> {
  try {
    const sessions: Awaited<ReturnType<typeof session>>[] = [];
    for (const s of ['vocals', 'drums', 'bass', 'other']) sessions.push(await session(path.join(dir, `stem_${s}.onnx`)));
    return async mag => {
      const out: Float32Array[] = [];
      for (const s of sessions) {
        const t = new (ort().Tensor)('float32', mag, [1, 2, 512, 1024]);
        out.push((await s.run({ [s.inputNames[0]]: t }))[s.outputNames[0]].data as Float32Array);
      }
      return out;
    };
  } catch (e) {
    console.warn('[DJAW] stem model unavailable:', (e as Error).message);
    return null;
  }
}
