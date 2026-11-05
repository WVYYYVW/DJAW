// Radix-2 FFT helpers (replacing Accelerate's vDSP in the Mac version).

const tables = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function table(n: number) {
  let t = tables.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  tables.set(n, t);
  return t;
}

/** In-place complex FFT (forward), n a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  const { cos, sin, rev } = table(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** Periodic Hann window. */
export function hann(n: number) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

/**
 * |STFT| (or power) frames: periodic Hann window, centred (reflect or zero padding), like NeuralAnalyzer.stft.
 * Returns frames × (n/2+1), row-major.
 */
export function stft(y: Float32Array, n: number, hop: number, reflect: boolean, power: boolean) {
  const half = n / 2;
  const padded = new Float32Array(y.length + n);
  padded.set(y, half);
  if (reflect && y.length > half + 1) {
    for (let i = 0; i < half; i++) {
      padded[half - 1 - i] = y[i + 1];
      padded[half + y.length + i] = y[y.length - 2 - i];
    }
  }
  const frames = 1 + Math.floor((padded.length - n) / hop);
  const bins = half + 1;
  const out = new Float32Array(frames * bins);
  const w = hann(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < n; i++) { re[i] = padded[o + i] * w[i]; im[i] = 0; }
    fft(re, im);
    const base = f * bins;
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      out[base + k] = power ? p : Math.sqrt(p);
    }
  }
  return { frames, bins, data: out };
}
