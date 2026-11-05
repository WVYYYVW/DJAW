// Preview playback: the render worker renders the mix ~0.3 s ahead and streams it straight to an AudioWorklet.
// The clock comes from the frames the worklet has actually played (minus the output latency), so the playhead
// follows what is heard.
import { pathToFileURL } from 'node:url';
import { TempoMap } from '../../core/tempo';
import { buildDir } from './env';
import type { MixMessage } from '../../workers/render.worker';

export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private gen = 0;
  private anchorReal = 0;
  private tempo = new TempoMap(120);
  private played = 0;
  private playedAt = 0;
  running = false;
  /** Called when a change moved audio in time and the stream has to start again. */
  onRestartNeeded?: () => void;
  /** Mono audio about to be heard, with its mix frame (for the visuals preview; set with `setTap`). */
  onTap?: (mono: Float32Array, start: number) => void;
  private tapping = false;

  async setTap(on: boolean) {
    this.tapping = on;
    if (on) await this.setup();
    this.worker?.postMessage({ type: 'tap', on });
  }

  private async setup() {
    if (this.ctx) return;
    const ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(pathToFileURL(buildDir('worklet.js')).href);
    const node = new AudioWorkletNode(ctx, 'djaw-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(ctx.destination);
    const worker = new Worker(pathToFileURL(buildDir('render.worker.js')).href);
    const ch = new MessageChannel();
    node.port.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
    worker.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]);
    node.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'played' && m.gen === this.gen) { this.played = m.played; this.playedAt = performance.now(); }
    };
    worker.onmessage = e => {
      if (e.data.type === 'restart') this.onRestartNeeded?.();
      if (e.data.type === 'tap' && e.data.gen === this.gen && this.tapping) this.onTap?.(e.data.mono, e.data.start);
      if (e.data.type === 'error') console.error('[DJAW] preview:', e.data.message);
    };
    this.ctx = ctx; this.node = node; this.worker = worker;
  }

  async start(mix: MixMessage, from: number) {
    await this.setup();
    this.gen++;
    this.tempo = new TempoMap(mix.tempo.reference, mix.tempo.points);
    this.anchorReal = this.tempo.real(from);
    this.played = 0;
    this.playedAt = performance.now();
    this.node!.port.postMessage({ type: 'reset', gen: this.gen });
    this.worker!.postMessage({ type: 'play', gen: this.gen, from, ...mix });
    if (this.ctx!.state !== 'running') await this.ctx!.resume();
    this.running = true;
  }

  update(mix: MixMessage) {
    if (this.running) this.worker?.postMessage({ type: 'update', clips: mix.clips, master: mix.master });
  }

  stop() {
    if (!this.running) return;
    this.gen++;
    this.worker?.postMessage({ type: 'stop' });
    this.node?.port.postMessage({ type: 'reset', gen: this.gen });
    this.running = false;
  }

  /** Timeline (reference) time being heard now. */
  get currentTime(): number {
    const ctx = this.ctx;
    if (!this.running || !ctx) return this.tempo.referenceAtReal(this.anchorReal);
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    // Between worklet reports, run on the wall clock.
    const since = Math.min(0.05, (performance.now() - this.playedAt) / 1000);
    const real = this.anchorReal + Math.max(0, this.played / 44100 + since - latency);
    return this.tempo.referenceAtReal(real);
  }
}
