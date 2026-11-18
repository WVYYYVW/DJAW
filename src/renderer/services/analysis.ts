// Track analysis: fingerprint → cache (Analysis/<fp>.analysis) or the analysis process, one track at a time.
// The analysis runs in a child Node process (onnxruntime-node cannot run in a renderer Web Worker).
import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess, fork } from 'node:child_process';
import { AnalysisStore, fingerprint } from '../../core/analysis/cache';
import { TrackAnalysis } from '../../core/analysis/analyzer';
import { GENRE_VERSION } from '../../core/genre';
import { buildDir, dataDir, env, modelPath } from './env';
import { ensurePcm } from './decode';
import { STEM_NAMES, StemFiles, stemFiles } from '../../core/analysis/stems';

export const analysisStore = new AnalysisStore(dataDir('Analysis'));

type Progress = (stage: 'decode' | 'read' | 'beats' | 'cues' | 'genre' | 'stems', fraction: number) => void;

interface Job { id: number; lane: Lane; resolve: (m: any) => void; reject: (e: Error) => void; progress?: Progress }

/** Two processes: analysis, and vocal separation (slow, so it never holds up the analysis of new tracks). */
type Lane = 'analysis' | 'stems';
const children = new Map<Lane, ChildProcess>();
const jobs = new Map<number, Job>();
let nextId = 1;

function getChild(lane: Lane = 'analysis') {
  const child = children.get(lane);
  if (child) return child;
  const c = fork(buildDir('analysis.child.js'), [], {
    // Not process.execPath: on the Mac that is the renderer's helper app, which ignores ELECTRON_RUN_AS_NODE and
    // would just hang (nothing ever got analysed there).
    execPath: env.exe,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    serialization: 'advanced',
    // Its output comes here (inheriting the renderer's own streams can kill it on the Mac when they are closed).
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  c.stdout?.on('data', d => console.log(`[DJAW] ${lane}:`, String(d).trimEnd()));
  c.stderr?.on('data', d => console.warn(`[DJAW] ${lane}:`, String(d).trimEnd()));
  // A process that does not start within 30 s is given up (its jobs fail with a message instead of waiting forever).
  const startup = setTimeout(() => { console.error('[DJAW] analysis process did not start'); c.kill(); }, 30000);
  c.on('message', (m: any) => {
    if (m.type === 'ready') { clearTimeout(startup); return; }
    if (m.type === 'log') { console.warn('[DJAW] analysis:', m.message); return; }
    const job = jobs.get(m.id);
    if (!job) return;
    if (m.type === 'progress') { job.progress?.(m.stage, m.fraction); return; }
    jobs.delete(m.id);
    if (m.type === 'done') job.resolve(m); else job.reject(new Error(m.message));
  });
  c.on('error', e => console.error('[DJAW] analysis process:', e.message));
  c.on('exit', (code, signal) => {
    clearTimeout(startup);
    if (children.get(lane) === c) children.delete(lane);
    if (code !== 0) console.error(`[DJAW] ${lane} process ended:`, code ?? signal);
    for (const j of [...jobs.values()]) if (j.lane === lane) { jobs.delete(j.id); j.reject(new Error(`analysis process ended (${code ?? signal})`)); }
  });
  children.set(lane, c);
  return c;
}

/** Sends one request to the analysis process (they run one after another there). */
export function request<T = any>(msg: Record<string, unknown>, progress?: Progress, lane: Lane = 'analysis'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    jobs.set(id, { id, lane, resolve, reject, progress });
    getChild(lane).send({ ...msg, id });
  });
}

async function metadata(file: string) {
  let title = path.basename(file, path.extname(file)), artist = '', genre: string | null = null;
  try {
    const mm = (await import('music-metadata')) as unknown as { parseFile(f: string, o: object): Promise<{ common: { title?: string; artist?: string; genre?: string[] } }> };
    const m = await mm.parseFile(file, { skipCovers: true, duration: false });
    if (m.common.title) title = m.common.title;
    if (m.common.artist) artist = m.common.artist;
    // ID3v1-style "(17)" numbers are not useful.
    const g = (m.common.genre ?? []).map(x => x.trim()).find(x => x && !/^[\d()]+$/.test(x));
    if (g) genre = g;
  } catch { /* no tags */ }
  return { title, artist, genre };
}

/** Analyses made before the cue / genre models were added are made again. */
const complete = (a: TrackAnalysis) => a.genre !== undefined;

/** Analysis of a file (cached by content). `fresh` analyses again. */
export async function analyze(file: string, opts: { fresh?: boolean; progress?: Progress } = {}): Promise<{ analysis: TrackAnalysis; fp: string; pcm: string }> {
  const fp = fingerprint(file);
  if (!fp) throw new Error('unreadable');
  opts.progress?.('decode', 0);
  const pcm = await ensurePcm(file, fp);
  if (!opts.fresh) {
    const hit = analysisStore.load<TrackAnalysis>(fp);
    if (hit && complete(hit)) return { analysis: hit, fp, pcm };
  }
  const a = (await request<{ analysis: TrackAnalysis }>({ type: 'analyze', pcm, modelPath: modelPath('beatthis.onnx') }, opts.progress)).analysis;
  const meta = await metadata(file);
  a.title = meta.title;
  a.artist = meta.artist;
  if (meta.genre) a.genre = a.genre ? { ...a.genre, tag: meta.genre } : { version: GENRE_VERSION, styles: [], families: {}, tag: meta.genre };
  if (a.genre === undefined) a.genre = null;
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

// MARK: Stem separation (vocals / drums / bass / melody)

const stemDir = () => dataDir('Stems');
const STEM_MODELS = ['vocals', 'drums', 'bass', 'other'].map(s => `stem_${s}.onnx`);

/** The separated stems of a track, if they exist. */
export function stemsFor(file: string): StemFiles | null {
  const fp = fingerprint(file);
  if (!fp) return null;
  const f = stemFiles(stemDir(), fp);
  return STEM_NAMES.every(s => fs.existsSync(f[s])) ? f : null;
}

export const stemsAvailable = () => STEM_MODELS.every(m => fs.existsSync(modelPath(m)));

/** Separates a track (if not done yet) in the stems process. */
export async function separateStems(file: string, progress?: (p: number) => void): Promise<StemFiles> {
  const done = stemsFor(file);
  if (done) return done;
  const fp = fingerprint(file);
  if (!fp) throw new Error('unreadable');
  const pcm = await ensurePcm(file, fp);
  const files = stemFiles(stemDir(), fp);
  await request({ type: 'stems', pcm, modelDir: path.dirname(modelPath(STEM_MODELS[0])), files }, (_s, f) => progress?.(f), 'stems');
  // Two-stem files of the earlier version are no longer used.
  try { for (const n of fs.readdirSync(stemDir())) if (n.startsWith(fp + '.v1.')) fs.rmSync(path.join(stemDir(), n), { force: true }); } catch { /* ignore */ }
  return files;
}

/** Forgets a track's stems (they are made again when needed). */
export function removeStems(file: string) {
  const f = stemsFor(file);
  if (f) for (const s of STEM_NAMES) try { fs.rmSync(f[s], { force: true }); } catch { /* ignore */ }
}
