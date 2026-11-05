// Track analysis: fingerprint → cache (Analysis/<fp>.analysis) or the analysis process, one track at a time.
// The analysis runs in a child Node process (onnxruntime-node cannot run in a renderer Web Worker).
import path from 'node:path';
import { ChildProcess, fork } from 'node:child_process';
import { AnalysisStore, fingerprint } from '../../core/analysis/cache';
import { TrackAnalysis } from '../../core/analysis/analyzer';
import { buildDir, dataDir, modelPath } from './env';
import { ensurePcm } from './decode';

export const analysisStore = new AnalysisStore(dataDir('Analysis'));

type Progress = (stage: 'decode' | 'read' | 'beats', fraction: number) => void;

interface Job { id: number; resolve: (m: any) => void; reject: (e: Error) => void; progress?: Progress }

let child: ChildProcess | null = null;
const jobs = new Map<number, Job>();
let nextId = 1;

function getChild() {
  if (child) return child;
  const c = fork(buildDir('analysis.child.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  c.on('message', (m: any) => {
    if (m.type === 'log') { console.warn('[DJAW] analysis:', m.message); return; }
    const job = jobs.get(m.id);
    if (!job) return;
    if (m.type === 'progress') { job.progress?.(m.stage, m.fraction); return; }
    jobs.delete(m.id);
    if (m.type === 'done') job.resolve(m); else job.reject(new Error(m.message));
  });
  c.on('exit', code => {
    child = null;
    for (const j of jobs.values()) j.reject(new Error(`analysis process ended (${code})`));
    jobs.clear();
  });
  child = c;
  return c;
}

/** Sends one request to the analysis process (they run one after another there). */
export function request<T = any>(msg: Record<string, unknown>, progress?: Progress): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    jobs.set(id, { id, resolve, reject, progress });
    getChild().send({ ...msg, id });
  });
}

async function metadata(file: string) {
  let title = path.basename(file, path.extname(file)), artist = '';
  try {
    const mm = (await import('music-metadata')) as unknown as { parseFile(f: string, o: object): Promise<{ common: { title?: string; artist?: string } }> };
    const m = await mm.parseFile(file, { skipCovers: true, duration: false });
    if (m.common.title) title = m.common.title;
    if (m.common.artist) artist = m.common.artist;
  } catch { /* no tags */ }
  return { title, artist };
}

/** Analysis of a file (cached by content). `fresh` analyses again. */
export async function analyze(file: string, opts: { fresh?: boolean; progress?: Progress } = {}): Promise<{ analysis: TrackAnalysis; fp: string; pcm: string }> {
  const fp = fingerprint(file);
  if (!fp) throw new Error('unreadable');
  opts.progress?.('decode', 0);
  const pcm = await ensurePcm(file, fp);
  if (!opts.fresh) {
    const hit = analysisStore.load<TrackAnalysis>(fp);
    if (hit) return { analysis: hit, fp, pcm };
  }
  const a = (await request<{ analysis: TrackAnalysis }>({ type: 'analyze', pcm, modelPath: modelPath('beatthis.onnx') }, opts.progress)).analysis;
  const meta = await metadata(file);
  a.title = meta.title;
  a.artist = meta.artist;
  analysisStore.store(fp, a);
  return { analysis: a, fp, pcm };
}

/** K-weighted power per 100 ms (cached). */
export async function loudness(file: string): Promise<Float32Array | null> {
  const fp = fingerprint(file);
  if (!fp) return null;
  const hit = analysisStore.load<{ seg: Float32Array }>(fp, 'loud');
  if (hit) return hit.seg;
  const pcm = await ensurePcm(file, fp);
  const seg = await request<{ segments: Float32Array }>({ type: 'loudness', pcm }).then(r => r.segments, () => null);
  if (seg) analysisStore.store(fp, { seg }, 'loud');
  return seg;
}
