// The sampler: short sounds (horns, vocal shots, sirens, risers …) placed on the mix's beat grid. They play at their
// own speed and pitch (no stretching), on top of the tracks, in the preview and the export alike.
import { L } from './i18n';
import { uuid } from './models';
import { TempoMap } from './tempo';
import type { AudioSource } from './render/source';

export interface Sample {
  id: string;
  name: string;
  /** The audio file. */
  url: string;
  relativePath?: string | null;
  /** Embedded in the .djaw (as tracks are). */
  mediaID?: string | null;
  gainDB: number;
  colorIndex: number;
}

export interface SampleHit {
  id: string;
  /** Sample.id */
  sample: string;
  /** Position on the mix's beat grid: beats from the grid origin (gridOffset). */
  beat: number;
  gainDB?: number;
  /** Extra plays after the first (a roll: 3 = four plays in all). */
  repeats?: number;
  /** Beats between the plays of a roll. */
  every?: number;
}

/** What the render engine needs: when each play starts (timeline seconds) and how loud, per sample. */
export interface SamplerInput {
  hits: { sample: string; time: number; gain: number }[];
}

export const PADS = 8;
export const padKeys = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I'];
export const rollChoices = [0, 1, 3, 7, 15];
export const everyChoices = [0.25, 0.5, 1, 2, 4];

export const Sampler = {
  newSample(url: string, name: string, colorIndex: number): Sample { return { id: uuid(), name, url, gainDB: 0, colorIndex }; },
  newHit(sample: string, beat: number): SampleHit { return { id: uuid(), sample, beat }; },
  /** Timeline (reference) time of a beat on the mix grid. */
  timeOfBeat: (beat: number, master: number, gridOffset: number) => gridOffset + beat * 60 / Math.max(1, master),
  beatOfTime: (t: number, master: number, gridOffset: number) => (t - gridOffset) * Math.max(1, master) / 60,
  /** Every play of every hit, in time order. */
  expand(samples: Sample[], hits: SampleHit[], master: number, gridOffset: number): SamplerInput {
    const byID = new Map(samples.map(s => [s.id, s]));
    const out: SamplerInput['hits'] = [];
    for (const h of hits) {
      const s = byID.get(h.sample);
      if (!s) continue;
      const gain = Math.pow(10, (s.gainDB + (h.gainDB ?? 0)) / 20);
      const n = 1 + Math.max(0, Math.round(h.repeats ?? 0));
      for (let k = 0; k < n; k++) out.push({ sample: s.id, time: Sampler.timeOfBeat(h.beat + k * (h.every ?? 1), master, gridOffset), gain });
    }
    return { hits: out.sort((a, b) => a.time - b.time) };
  },
  rollLabel(h: SampleHit) {
    const n = Math.max(0, Math.round(h.repeats ?? 0));
    if (!n) return '';
    const every = h.every ?? 1;
    const unit = every >= 1 ? L(`${every}拍`, `${every} beat${every > 1 ? 's' : ''}`) : L(`1/${Math.round(1 / every)}拍`, `1/${Math.round(1 / every)} beat`);
    return L(`×${n + 1}（${unit}ごと）`, `×${n + 1} (every ${unit})`);
  },
};

/** Mixes the sampler's plays into a render block. Every play starts on its exact frame, wherever rendering starts. */
export class SamplerVoice {
  private plays: { src: AudioSource; frame: number; gain: number }[] = [];
  private maxLength = 0;
  private first = 0;
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);

  constructor(input: SamplerInput, tempo: TempoMap, private readonly sr: number, open: (sample: string) => AudioSource | null) {
    const sources = new Map<string, AudioSource | null>();
    for (const h of input.hits) {
      if (!sources.has(h.sample)) sources.set(h.sample, open(h.sample));
      const src = sources.get(h.sample);
      if (!src || !(h.gain > 0)) continue;
      this.plays.push({ src, frame: Math.round(tempo.real(h.time) * sr), gain: h.gain });
      this.maxLength = Math.max(this.maxLength, src.frames);
    }
    this.plays.sort((a, b) => a.frame - b.frame);
    this.sources = [...sources.values()].filter((x): x is AudioSource => !!x);
  }
  private readonly sources: AudioSource[];

  get isEmpty() { return !this.plays.length; }

  /** Adds frames [f0, f0 + n) of the mix into L / R. */
  render(f0: number, n: number, L: Float32Array, R: Float32Array) {
    if (!this.plays.length) return;
    while (this.first < this.plays.length && this.plays[this.first].frame + this.maxLength <= f0) this.first++;
    if (this.bufL.length < n) { this.bufL = new Float32Array(n); this.bufR = new Float32Array(n); }
    for (let k = this.first; k < this.plays.length; k++) {
      const p = this.plays[k];
      if (p.frame >= f0 + n) break;
      const from = Math.max(0, f0 - p.frame);           // offset into the sample
      if (from >= p.src.frames) continue;
      const at = Math.max(0, p.frame - f0);              // offset into the block
      const count = Math.min(n - at, p.src.frames - from);
      if (count <= 0) continue;
      p.src.read(from, count, this.bufL, this.bufR);
      for (let i = 0; i < count; i++) { L[at + i] += this.bufL[i] * p.gain; R[at + i] += this.bufR[i] * p.gain; }
    }
  }

  close() { for (const s of this.sources) s.close(); }
}
