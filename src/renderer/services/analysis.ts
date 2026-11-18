// Track analysis: fingerprint → cache (Analysis/<fp>.analysis) or the analysis process, one track at a time.
// The analysis runs in utility processes the main process starts (main/analysisHost.ts), reached over a MessagePort.
import fs from 'node:fs';
import path from 'node:path';
import { ipcRenderer } from 'electron';
import { AnalysisStore, fingerprint } from '../../core/analysis/cache';
import { TrackAnalysis } from '../../core/analysis/analyzer';
import { GENRE_VERSION } from '../../core/genre';
import { dataDir, modelPath } from './env';
import { ensurePcm } from './decode';
import { STEM_NAMES, StemFiles, stemFiles } from '../../core/analysis/stems';

export const analysisStore = new AnalysisStore(dataDir('Analysis'));

type Progress = (stage: 'decode' | 'read' | 'beats' | 'cues' | 'genre' | 'stems', fraction: number) => void;

interface Job { id: number; lane: Lane; resolve: (m: any) => void; reject: (e: Error) => void; progress?: Progress }

/** Two processes: analysis, and vocal separation (slow, so it never holds up the analysis of new tracks). */
type Lane = 'analysis' | 'stems';
/** One analysis process as the renderer sees it: messages wait until its port has arrived. */
interface Proc { serial: number; port: MessagePort | null; queue: unknown[]; startup: ReturnType<typeof setTimeout> }
const children = new Map<Lane, Proc>();
const jobs = new Map<number, Job>();
let nextId = 1;
let nextSerial = 1;

function onMessage(lane: Lane, m: any) {
  const p = children.get(lane);
  if (m.type === 'ready') { if (p) clearTimeout(p.startup); return; }
  if (m.type === 'log') { console.warn('[DJAW] analysis:', m.message); return; }
  const job = jobs.get(m.id);
  if (!job) return;
  if (m.type === 'progress') { job.progress?.(m.stage, m.fraction); return; }
  jobs.delete(m.id);
  if (m.type === 'done') job.resolve(m); else job.reject(new Error(m.message));
}

function ended(lane: Lane, serial: number, why: string) {
  const p = children.get(lane);
  if (!p || p.serial !== serial) return;
  clearTimeout(p.startup);
  p.port?.close();
  children.delete(lane);
  console.error(`[DJAW] ${lane} process ended:`, why);
  for (const j of [...jobs.values()]) if (j.lane === lane) { jobs.delete(j.id); j.reject(new Error(`analysis process ended (${why})`)); }
}

ipcRenderer.on('analysis:port', (e, req: { lane: Lane; serial: number }) => {
  const p = children.get(req.lane);
  const port = e.ports[0];
  if (!p || p.serial !== req.serial) { port.close(); return; }
  p.port = port;
  port.onmessage = ev => onMessage(req.lane, ev.data);
  port.start();
  for (const m of p.queue) port.postMessage(m);
  p.queue = [];
});
ipcRenderer.on('analysis:exit', (_e, r: { lane: Lane; serial: number; code: number }) => ended(r.lane, r.serial, String(r.code)));
ipcRenderer.on('analysis:log', (_e, r: { lane: Lane; stream: string; text: string }) => {
  (r.stream === 'err' ? console.warn : console.log)(`[DJAW] ${r.lane}:`, r.text.trimEnd());
});

function getChild(lane: Lane = 'analysis'): Proc {
  const have = children.get(lane);
  if (have) return have;
  const serial = nextSerial++;
  // A process that does not start within 60 s is given up (its jobs fail with a message instead of waiting forever).
  const startup = setTimeout(() => { ipcRenderer.send('analysis:kill', lane); ended(lane, serial, 'did not start'); }, 60000);
  const p: Proc = { serial, port: null, queue: [], startup };
  children.set(lane, p);
  ipcRenderer.send('analysis:spawn', { lane, serial });
  return p;
}

/** Sends one request to the analysis process (they run one after another there). */
export function request<T = any>(msg: Record<string, unknown>, progress?: Progress, lane: Lane = 'analysis'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    jobs.set(id, { id, lane, resolve, reject, progress });
    const p = getChild(lane);
    const m = { ...msg, id };
    if (p.port) p.port.postMessage(m); else p.queue.push(m);
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
