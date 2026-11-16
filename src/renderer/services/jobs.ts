// Background renders (export, mix waveform) on their own worker so the preview never waits for them.
import { pathToFileURL } from 'node:url';
import { buildDir } from './env';
import type { MixMessage } from '../../workers/render.worker';
import type { TrackVisualMessage, VideoExportOptions } from '../../core/render/video';

let worker: Worker | null = null;
let next = 1;
const handlers = new Map<number, (m: any) => void>();

function w() {
  if (!worker) {
    worker = new Worker(pathToFileURL(buildDir('render.worker.js')).href);
    worker.onmessage = e => handlers.get(e.data.job)?.(e.data);
  }
  return worker;
}

export interface Job<T> { id: number; promise: Promise<T>; cancel(): void }

function run<T>(msg: Record<string, unknown>, onMessage?: (m: any) => void): Job<T> {
  const id = next++;
  const promise = new Promise<T>((resolve, reject) => {
    handlers.set(id, m => {
      if (m.type === 'done') { handlers.delete(id); resolve(m); }
      else if (m.type === 'error') { handlers.delete(id); reject(new Error(m.message)); }
      else if (m.type === 'cancelled') { handlers.delete(id); reject(new Error('cancelled')); }
      else onMessage?.(m);
    });
  });
  w().postMessage({ ...msg, job: id });
  return { id, promise, cancel: () => w().postMessage({ type: 'cancel', job: id }) };
}

export const Jobs = {
  export: (mix: MixMessage, dest: string, options: { sampleRate: number; normalize: boolean; bits: 16 | 24 | 32; format?: 'wav24' | 'aac256' }, knownPeak: number | null, progress: (p: number) => void) =>
    run<{ type: 'done' }>({ type: 'export', ...mix, dest, options, knownPeak }, m => m.type === 'progress' && progress(m.progress)),
  video: (mix: MixMessage, dest: string, options: VideoExportOptions, tracks: TrackVisualMessage[], knownPeak: number | null, progress: (p: number) => void) =>
    run<{ type: 'done'; stats?: Record<string, number> }>({ type: 'video', ...mix, dest, options, tracks, knownPeak }, m => m.type === 'progress' && progress(m.progress)),
  peaks: (mix: MixMessage, partial: (p: any) => void) =>
    run<{ peaks: any }>({ type: 'peaks', ...mix }, m => m.type === 'partial' && partial(m.peaks)),
  peakRange: (mix: MixMessage, binsPerSecond: number, a: number, b: number) =>
    run<{ range: any }>({ type: 'peakRange', ...mix, binsPerSecond, a, b }),
  /** Renders the transition into clip `index` and lists what sounds wrong (null = could not render). */
  check: (mix: MixMessage, index: number) => run<{ result: { problems: string[] } | null }>({ type: 'check', ...mix, index }),
};
