// Beat This! through onnxruntime-node (native; the model file is models/beatthis.onnx).
import { BeatModel } from './neural';

export async function loadBeatModel(modelPath: string): Promise<BeatModel | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
    const session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: 'all' });
    return async (mag, frames) => {
      const out = await session.run({ mag: new ort.Tensor('float32', mag, [1, frames, 513]) });
      return { beat: out.beat.data as Float32Array, downbeat: out.downbeat.data as Float32Array };
    };
  } catch (e) {
    console.warn('[DJAW] beat model unavailable:', (e as Error).message);
    return null;
  }
}
