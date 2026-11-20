// Makes DJAW's own sampler sounds (assets/samples/*.wav): all synthesised here, so they are DJAW's and free to use
// anywhere (no third-party recordings). 44.1 kHz stereo 16-bit with dither, peaks at −1 dBFS.
//   node scripts/make-samples.mjs
// The sounds are deterministic (fixed random seeds), so running this again gives the same files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'samples');
const TAU = Math.PI * 2;

// MARK: - Building blocks

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 * 2 - 1; };
}
const buf = sec => new Float64Array(Math.round(sec * SR));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const db = v => Math.pow(10, v / 20);

/** Band-limited sawtooth (polyBLEP) following a frequency function. */
function saw(n, freq, phase0 = 0) {
  const out = new Float64Array(n);
  let ph = phase0;
  for (let i = 0; i < n; i++) {
    const dt = freq(i / SR) / SR;
    let v = 2 * ph - 1;
    if (ph < dt) { const t = ph / dt; v -= t + t - t * t - 1; } else if (ph > 1 - dt) { const t = (ph - 1) / dt; v -= t * t + t + t + 1; }
    out[i] = v;
    ph += dt; if (ph >= 1) ph -= 1;
  }
  return out;
}
/** Band-limited square (two saws). */
function square(n, freq) {
  const a = saw(n, freq, 0), b = saw(n, freq, 0.5);
  return a.map((v, i) => (v - b[i]) * 0.5);
}
function sine(n, freq, phase0 = 0) {
  const out = new Float64Array(n);
  let ph = phase0;
  for (let i = 0; i < n; i++) { out[i] = Math.sin(TAU * ph); ph += freq(i / SR) / SR; }
  return out;
}
function noise(n, seed) { const r = rng(seed); return Float64Array.from({ length: n }, r); }

/** State-variable filter (Chamberlin, 2× oversampled): 'lp' | 'hp' | 'bp', cutoff and Q may change over time. */
function svf(x, type, cutoff, q = 0.707) {
  const out = new Float64Array(x.length);
  let low = 0, band = 0;
  const damp = typeof q === 'function' ? null : 1 / q;
  for (let i = 0; i < x.length; i++) {
    const fc = clamp(typeof cutoff === 'function' ? cutoff(i / SR) : cutoff, 10, SR * 0.24);
    const f = 2 * Math.sin(Math.PI * fc / (SR * 2));
    const d = damp ?? 1 / q(i / SR);
    let y = 0;
    for (let k = 0; k < 2; k++) {
      low += f * band;
      const high = x[i] - low - d * band;
      band += f * high;
      y = type === 'lp' ? low : type === 'hp' ? high : band;
    }
    out[i] = y;
  }
  return out;
}

/** Envelope from breakpoints [[t, v], …] (linear between them; `curve` > 1 bends decays). */
function env(n, pts, curve = 1) {
  const out = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (k < pts.length - 2 && t > pts[k + 1][0]) k++;
    const [t0, v0] = pts[k], [t1, v1] = pts[Math.min(k + 1, pts.length - 1)];
    let u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 1;
    if (v1 < v0 && curve !== 1) u = 1 - Math.pow(1 - u, curve);
    out[i] = lerp(v0, v1, u);
  }
  return out;
}
const expDecay = (n, tau, attack = 0.002) => Float64Array.from({ length: n }, (_, i) => { const t = i / SR; return Math.min(1, t / attack) * Math.exp(-t / tau); });

/** Soft clipping with 4× oversampling (keeps distortion from folding back as harsh aliasing). */
function drive(x, amount, shape = Math.tanh) {
  const up = 4, out = new Float64Array(x.length);
  let prev = 0, z1 = 0, z2 = 0;
  const a = Math.exp(-TAU * 16000 / (SR * up));
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    for (let k = 1; k <= up; k++) {
      const s = lerp(prev, x[i], k / up);
      let y = shape(s * amount);
      z1 = y + a * (z1 - y); z2 = z1 + a * (z2 - z1); // two-pole low-pass before taking every 4th sample
      acc = z2;
    }
    prev = x[i];
    out[i] = acc;
  }
  return out;
}

/** Stereo reverb (Freeverb: 8 combs + 4 all-passes per side, the right side detuned). */
function reverb(l, r, { room = 0.84, damp = 0.35, wet = 0.3, width = 1, tail = 2.5 } = {}) {
  const n = l.length + Math.round(tail * SR);
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225];
  const scale = SR / 44100;
  const side = (input, spread) => {
    const out = new Float64Array(n);
    const cs = combs.map(c => ({ b: new Float64Array(Math.round((c + spread) * scale)), i: 0, f: 0 }));
    const as = aps.map(c => ({ b: new Float64Array(Math.round((c + spread) * scale)), i: 0 }));
    for (let i = 0; i < n; i++) {
      const x = (i < input.length ? input[i] : 0) * 0.015;
      let s = 0;
      for (const c of cs) { const y = c.b[c.i]; c.f = y * (1 - damp) + c.f * damp; c.b[c.i] = x + c.f * room; c.i = (c.i + 1) % c.b.length; s += y; }
      for (const a of as) { const y = a.b[a.i]; const v = -s + y; a.b[a.i] = s + y * 0.5; a.i = (a.i + 1) % a.b.length; s = v; }
      out[i] = s;
    }
    return out;
  };
  const wl = side(l, 0), wr = side(r, 23);
  const w1 = wet * (width / 2 + 0.5), w2 = wet * ((1 - width) / 2);
  const L = new Float64Array(n), R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dl = i < l.length ? l[i] : 0, dr = i < r.length ? r[i] : 0;
    L[i] = dl + wl[i] * w1 + wr[i] * w2;
    R[i] = dr + wr[i] * w1 + wl[i] * w2;
  }
  return [L, R];
}

/** Tempo-free ping-pong echo. */
function echo(l, r, { time = 0.28, feedback = 0.45, wet = 0.35, tail = 2, tone = 3500 } = {}) {
  const n = l.length + Math.round(tail * SR), d = Math.round(time * SR);
  const L = new Float64Array(n), R = new Float64Array(n);
  const bl = new Float64Array(d), br = new Float64Array(d);
  let k = 0, lpL = 0, lpR = 0;
  const a = Math.exp(-TAU * tone / SR);
  for (let i = 0; i < n; i++) {
    const xl = i < l.length ? l[i] : 0, xr = i < r.length ? r[i] : 0;
    const yl = bl[k], yr = br[k];
    lpL = yl + a * (lpL - yl); lpR = yr + a * (lpR - yr);
    bl[k] = (xl + xr) * 0.5 + lpR * feedback; // crossed: ping-pong
    br[k] = lpL * feedback;
    k = (k + 1) % d;
    L[i] = xl + yl * wet; R[i] = xr + yr * wet;
  }
  return [L, R];
}

const mix = (...xs) => { const n = Math.max(...xs.map(x => x.length)); const o = new Float64Array(n); for (const x of xs) for (let i = 0; i < x.length; i++) o[i] += x[i]; return o; };
const mul = (x, e) => x.map((v, i) => v * (typeof e === 'number' ? e : (e[i] ?? 0)));
const reverse = x => Float64Array.from(x).reverse();
/** Fades the last `sec` seconds smoothly to silence (a sound must never stop on a non-zero sample: that clicks). */
const fadeTail = (x, sec) => { const o = Float64Array.from(x); const f = Math.round(sec * SR); for (let i = 0; i < f && i < o.length; i++) { const k = o.length - 1 - i; o[k] *= 0.5 - 0.5 * Math.cos(Math.PI * i / f); } return o; };
const delayed = (x, sec) => { const d = Math.round(sec * SR); const o = new Float64Array(x.length + d); o.set(x, d); return o; };

/** DC removal (a gentle high-pass at 20 Hz). */
function dcBlock(x) { const o = new Float64Array(x.length); let px = 0, py = 0; const R = 1 - TAU * 20 / SR; for (let i = 0; i < x.length; i++) { py = x[i] - px + R * py; px = x[i]; o[i] = py; } return o; }

/** Writes a stereo 16-bit WAV: DC removed, peak normalised to −1 dBFS, 3 ms fade at the end, TPDF dither. */
function write(name, l, r = l) {
  l = dcBlock(l); r = dcBlock(r);
  const n = Math.max(l.length, r.length);
  // Trim trailing near-silence (below −90 dBFS for the last part).
  let end = n;
  while (end > SR * 0.05 && Math.abs(l[end - 1] ?? 0) < 3e-5 && Math.abs(r[end - 1] ?? 0) < 3e-5) end--;
  let peak = 0;
  for (let i = 0; i < end; i++) peak = Math.max(peak, Math.abs(l[i] ?? 0), Math.abs(r[i] ?? 0));
  const g = db(-1) / (peak || 1);
  const fade = Math.round(Math.min(0.02, end / SR * 0.05) * SR);
  const data = Buffer.alloc(end * 4);
  const d = rng(name.length * 7919);
  for (let i = 0; i < end; i++) {
    const f = i > end - fade ? (end - i) / fade : 1;
    for (const [c, x] of [[0, l], [1, r]]) {
      const v = (x[i] ?? 0) * g * (0.5 - 0.5 * Math.cos(Math.PI * f)) * 32767 + (d() + d()) * 0.5;
      data.writeInt16LE(clamp(Math.round(v), -32768, 32767), i * 4 + c * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(OUT, name + '.wav'), Buffer.concat([h, data]));
  console.log(`${name}.wav  ${(end / SR).toFixed(2)} s`);
}

// MARK: - The sounds

/** Air horn: a stack of detuned band-limited saws with the classic falling "bwaap", through a horn-like resonance. */
function airHornBlast(len, seed) {
  const n = buf(len).length;
  const r = rng(seed);
  const base = t => 466 * (1 - 0.06 * Math.exp(-t * 18)) * (1 - 0.03 * Math.min(1, t / len));
  const voices = [1, 1.005, 0.996, 1.258, 1.262, 1.5, 0.5].map((m, k) => mul(saw(n, t => base(t) * m * (1 + 0.002 * Math.sin(TAU * (5.5 + k) * t))), [0.9, 0.8, 0.8, 0.55, 0.5, 0.35, 0.45][k]));
  let x = mix(...voices);
  x = mix(svf(x, 'bp', 1450, 1.6), mul(svf(x, 'bp', 2900, 2.2), 0.5), mul(svf(x, 'lp', 4200), 0.35));
  x = drive(x, 1.8);
  void r;
  return mul(x, env(n, [[0, 0], [0.012, 1], [len - 0.06, 0.92], [len, 0]]));
}
function airHorn() {
  const [l, r] = reverb(airHornBlast(0.95, 1), airHornBlast(0.95, 2), { wet: 0.22, room: 0.8, tail: 1.6 });
  write('air-horn', l, r);
}
function airHornTriple() {
  const a = airHornBlast(0.16, 3), b = airHornBlast(0.16, 4), c = airHornBlast(0.85, 5);
  const x = mix(a, delayed(b, 0.2), delayed(c, 0.4));
  const [l, r] = reverb(x, x, { wet: 0.22, room: 0.8, tail: 1.6 });
  write('air-horn-x3', l, r);
}

/** Dub siren: a square wave swept by a slow LFO, then ping-pong echo and reverb. */
function siren() {
  const len = 2.4, n = buf(len).length;
  const f = t => 600 * Math.pow(2, 1.0 * (0.5 - 0.5 * Math.cos(TAU * 2.1 * t)));
  let x = mix(mul(square(n, f), 0.7), mul(sine(n, t => f(t) * 2), 0.25));
  x = svf(x, 'lp', 3800, 0.9);
  x = mul(x, env(n, [[0, 0], [0.01, 1], [len - 0.05, 1], [len, 0]]));
  let [l, r] = echo(x, x, { time: 0.33, feedback: 0.5, wet: 0.4, tail: 2.2 });
  [l, r] = reverb(l, r, { wet: 0.18, tail: 1.5 });
  write('siren', l, r);
}

/** Riser: white noise through a rising band-pass plus a detuned saw stack gliding up, getting louder (4 s). */
function riser() {
  const len = 4, n = buf(len).length;
  const p = t => Math.pow(t / len, 2.2);
  const nz = svf(noise(n, 11), 'bp', t => 300 + 9000 * p(t), t => 1.2 + 3 * p(t));
  const tone = svf(mix(...[1, 1.007, 0.993, 2.01].map((m, k) => mul(saw(n, t => (110 + 770 * p(t)) * m), k === 3 ? 0.3 : 0.5))), 'lp', t => 500 + 7000 * p(t), 1.5);
  const e = env(n, [[0, 0], [len * 0.9, 1], [len, 1]]);
  const x = mul(mix(mul(nz, 1.4), mul(tone, 0.55)), e.map(v => v * v));
  const xr = mul(mix(mul(svf(noise(n, 12), 'bp', t => 300 + 9000 * p(t), t => 1.2 + 3 * p(t)), 1.4), mul(tone, 0.55)), e.map(v => v * v));
  const [l, r] = reverb(x, xr, { wet: 0.3, tail: 1.2 });
  write('riser', l.slice(0, n + Math.round(0.4 * SR)), r.slice(0, n + Math.round(0.4 * SR)));
}

/** Downlifter: the reverse movement — bright noise sweeping down and fading (2.5 s). */
function downlifter() {
  const len = 2.5, n = buf(len).length;
  const p = t => Math.pow(1 - t / len, 1.6);
  const mk = s => mul(svf(noise(n, s), 'bp', t => 200 + 9000 * p(t), 2.2), env(n, [[0, 1], [len, 0]], 1.8));
  const tone = mul(svf(saw(n, t => 80 + 600 * p(t)), 'lp', t => 300 + 4000 * p(t), 1.4), env(n, [[0, 0.4], [len, 0]], 2));
  const [l, r] = reverb(mix(mk(21), tone), mix(mk(22), tone), { wet: 0.3, tail: 1.5 });
  write('downlifter', l, r);
}

/** Impact: a big boom — sub sine dropping in pitch, a noise crack, a low thump, a long reverb tail. */
function impact() {
  const len = 3.2, n = buf(len).length;
  let ph = 0;
  const sub = Float64Array.from({ length: n }, (_, i) => { const t = i / SR; ph += (38 + 70 * Math.exp(-t * 9)) / SR; return Math.sin(TAU * ph); });
  const subE = mul(sub, expDecay(n, 0.9, 0.001));
  const crack = mul(svf(noise(n, 31), 'hp', 900), expDecay(n, 0.05, 0.0005));
  const body = mul(svf(noise(n, 32), 'lp', 260, 1.1), expDecay(n, 0.25, 0.001));
  const x = fadeTail(drive(mix(mul(subE, 1.2), mul(crack, 0.8), mul(body, 1.2)), 1.6), 0.8);
  const [l, r] = reverb(x, x, { wet: 0.38, room: 0.9, damp: 0.5, tail: 2.5 });
  write('impact', l, r);
}

/** Sub drop: a long 808-style boom falling an octave. */
function subDrop() {
  const len = 3, n = buf(len).length;
  let ph = 0;
  const x = Float64Array.from({ length: n }, (_, i) => { const t = i / SR; ph += (60 * Math.pow(0.5, t / len) + 25 * Math.exp(-t * 30)) / SR; return Math.sin(TAU * ph); });
  const y = drive(mul(x, env(n, [[0, 0], [0.004, 1], [len * 0.7, 0.8], [len, 0]], 1.5)), 1.3);
  write('sub-drop', y, y);
}

/** Gabber kick: the hardcore kick — a sine sweeping from 260 Hz to 52 Hz, driven into heavy distortion, a click on top. */
function gabberKick() {
  const len = 0.62, n = buf(len).length;
  let ph = 0;
  const body = Float64Array.from({ length: n }, (_, i) => { const t = i / SR; ph += (52 + 210 * Math.exp(-t * 32) + 40 * Math.exp(-t * 6)) / SR; return Math.sin(TAU * ph); });
  const shaped = mul(body, env(n, [[0, 1], [0.12, 0.95], [len - 0.08, 0.55], [len, 0]], 1.4));
  let x = drive(shaped, 7, v => Math.tanh(v) * 0.8 + Math.tanh(v * 0.35) * 0.2);
  x = svf(x, 'lp', t => 9000 - 6000 * Math.min(1, t / 0.2), 0.8);
  const click = mul(svf(noise(n, 41), 'hp', 3000), expDecay(n, 0.004, 0.0002));
  write('gabber-kick', mix(x, mul(click, 0.6)));
}

/** Hard kick: a punchy, cleaner kick (techno / breaks). */
function hardKick() {
  const len = 0.45, n = buf(len).length;
  let ph = 0;
  const body = Float64Array.from({ length: n }, (_, i) => { const t = i / SR; ph += (48 + 160 * Math.exp(-t * 40)) / SR; return Math.sin(TAU * ph); });
  const x = drive(mul(body, expDecay(n, 0.16, 0.001)), 2.2);
  const click = mul(svf(noise(n, 42), 'bp', 4000, 1.2), expDecay(n, 0.003, 0.0002));
  write('hard-kick', mix(x, mul(click, 0.5)));
}

/** Snare: a tuned body (two modes) and a band of noise, slightly driven, a short room. */
function snare() {
  const len = 0.5, n = buf(len).length;
  let p1 = 0, p2 = 0;
  const tone = Float64Array.from({ length: n }, (_, i) => { const t = i / SR; p1 += (190 + 60 * Math.exp(-t * 60)) / SR; p2 += 330 / SR; return Math.sin(TAU * p1) * 0.8 + Math.sin(TAU * p2) * 0.35; });
  const mk = s => mix(mul(tone, expDecay(n, 0.06, 0.001)), mul(svf(svf(noise(n, s), 'hp', 1600), 'lp', 9000), mul(expDecay(n, 0.12, 0.001), 1.1)));
  const [l, r] = reverb(fadeTail(drive(mk(51), 1.5), 0.15), fadeTail(drive(mk(52), 1.5), 0.15), { wet: 0.16, room: 0.6, damp: 0.6, tail: 0.6 });
  write('snare', l, r);
}

/** Clap: four quick noise bursts and a short tail, band-passed around 1.2 kHz. */
function clap() {
  const len = 0.6, n = buf(len).length;
  const mk = s => {
    const nz = svf(noise(n, s), 'bp', 1200, 1.4);
    const e = new Float64Array(n);
    for (const [at, a] of [[0, 1], [0.011, 0.9], [0.023, 0.85], [0.034, 1]]) for (let i = Math.round(at * SR); i < n; i++) { const t = i / SR - at; e[i] += a * Math.exp(-t / (at === 0.034 ? 0.12 : 0.006)); }
    return mul(nz, e);
  };
  const [l, r] = reverb(fadeTail(mk(61), 0.2), fadeTail(mk(62), 0.2), { wet: 0.22, room: 0.7, tail: 0.8 });
  write('clap', l, r);
}

/** Crash: metallic partials (inharmonic square-wave cluster, like analogue cymbals) plus bright noise, long decay. */
function crashSide(seed, len) {
  const n = buf(len).length;
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map(f => f * (1 + 0.01 * rng(seed)()));
  const metal = svf(mix(...freqs.map(f => square(n, () => f * 2.4))), 'hp', 6000, 0.8);
  const nz = svf(noise(n, seed), 'hp', 4500);
  return fadeTail(mul(mix(mul(metal, 0.5), mul(nz, 0.9)), mix(expDecay(n, 1.1, 0.0015), mul(expDecay(n, 0.08, 0.0005), 0.6))), len * 0.35);
}
function crash() {
  const len = 3.2;
  const [l, r] = reverb(crashSide(71, len), crashSide(72, len), { wet: 0.2, tail: 1 });
  write('crash', l, r);
}
function reverseCrash() {
  const len = 2.2;
  const [l, r] = reverb(crashSide(73, len), crashSide(74, len), { wet: 0.25, tail: 0.6 });
  // Ends on the hit: the last moment is the loudest, then a clean cut.
  write('reverse-crash', reverse(l), reverse(r));
}

/** Open hi-hat. */
function openHat() {
  const len = 0.7, n = buf(len).length;
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800];
  const mk = s => fadeTail(mul(mix(mul(svf(mix(...freqs.map(f => square(n, () => f * 3.1))), 'hp', 8000), 0.5), svf(noise(n, s), 'hp', 7000)), expDecay(n, 0.22, 0.001)), 0.25);
  write('open-hat', mk(81), mk(82));
}

/** Laser zap: an FM tone diving from 3 kHz with a fast echo. */
function laser() {
  const len = 0.5, n = buf(len).length;
  let pc = 0, pm = 0;
  const x = Float64Array.from({ length: n }, (_, i) => { const t = i / SR; const fc = 180 + 2800 * Math.exp(-t * 9); pm += fc * 1.5 / SR; pc += (fc + 400 * Math.exp(-t * 6) * Math.sin(TAU * pm)) / SR; return Math.sin(TAU * pc); });
  const y = mul(x, env(n, [[0, 0], [0.003, 1], [len, 0]], 1.6));
  const [l, r] = echo(y, y, { time: 0.11, feedback: 0.42, wet: 0.45, tail: 0.9, tone: 6000 });
  write('laser', l, r);
}

/** Noise sweep (white noise high-pass opening upward, short): a quick build into a drop. */
function sweepUp() {
  const len = 2, n = buf(len).length;
  const mk = s => mul(svf(noise(n, s), 'hp', t => 200 * Math.pow(60, t / len), 1.5), env(n, [[0, 0.1], [len * 0.95, 1], [len, 0]]));
  const [l, r] = reverb(mk(91), mk(92), { wet: 0.25, tail: 0.5 });
  write('noise-sweep', l, r);
}

fs.mkdirSync(OUT, { recursive: true });
airHorn(); airHornTriple(); siren(); riser(); downlifter(); impact(); subDrop();
gabberKick(); hardKick(); snare(); clap(); crash(); reverseCrash(); openHat(); laser(); sweepUp();
