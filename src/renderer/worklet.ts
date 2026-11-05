// AudioWorklet that plays the mix rendered by the render worker. Chunks arrive over a MessagePort (from the
// worker, straight), are queued and played back to back; the worklet reports how many frames it has played so the
// app's clock follows what is heard.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

interface Chunk { gen: number; L: Float32Array; R: Float32Array; pos: number }

class DJAWPlayer extends AudioWorkletProcessor {
  private queue: Chunk[] = [];
  private gen = 0;
  private played = 0;
  private queued = 0;
  private sinceReport = 0;
  private data: MessagePort | null = null;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'port') {
        this.data = m.port as MessagePort;
        this.data.onmessage = ev => this.receive(ev.data);
      } else if (m.type === 'reset') {
        this.gen = m.gen;
        this.queue = [];
        this.queued = 0;
        this.played = 0;
      }
    };
  }

  private receive(m: { type: string; gen: number; L: Float32Array; R: Float32Array }) {
    if (m.type !== 'chunk' || m.gen !== this.gen) return;
    this.queue.push({ gen: m.gen, L: m.L, R: m.R, pos: 0 });
    this.queued += m.L.length;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const L = out[0], R = out[1] ?? out[0];
    const n = L.length;
    let i = 0;
    while (i < n && this.queue.length) {
      const c = this.queue[0];
      const take = Math.min(n - i, c.L.length - c.pos);
      L.set(c.L.subarray(c.pos, c.pos + take), i);
      if (R !== L) R.set(c.R.subarray(c.pos, c.pos + take), i);
      c.pos += take;
      i += take;
      if (c.pos >= c.L.length) this.queue.shift();
    }
    if (i < n) { L.fill(0, i); if (R !== L) R.fill(0, i); }
    this.played += i;
    this.queued -= i;
    this.sinceReport += n;
    if (this.sinceReport >= 1024) {
      this.sinceReport = 0;
      const msg = { type: 'played', gen: this.gen, played: this.played, queued: this.queued, starved: i < n };
      this.port.postMessage(msg);
      this.data?.postMessage(msg);
    }
    return true;
  }
}

registerProcessor('djaw-player', DJAWPlayer);
void sampleRate;
