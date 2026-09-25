// Explore Better demo score v7: three original, fully synthesized music candidates.
//
//   A  "Warm electronic"        soft four-on-the-floor, supersaw pads, pluck arpeggio, round sub
//   B  "Minimal piano + pulse"  additive piano, soft sub pulse, textural percussion, string swells
//   C  "Upbeat synth-pop"       punchy kick/clap, driving bass, arpeggio, a short hook at title + end
//
// Everything is synthesized here from oscillators and noise. There are no samples, loops or
// borrowed melodies. The module is dependency-free: band-limited (polyBLEP / additive)
// oscillators, ADSR envelopes, TPT state-variable and RBJ biquad filters, chorus, ping-pong
// delay, an 8-line feedback-delay-network reverb, kick-keyed ducking, bus compression, a
// BS.1770 loudness meter and an offline true-peak limiter.
//
// Timing: each product chapter is a whole number of beats. Tempo is constant inside a chapter
// and nudged (at most about 2.5 %) between chapters so every chapter cut lands exactly on a bar
// line. When a chapter's length is not a multiple of four beats, the remainder becomes a short
// pickup bar (1, 2 or 3 beats) at the end of that chapter, which carries the fill or break into
// the next downbeat.
import { promises as fs } from "node:fs";

export const SR = 48000;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Utilities

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
const dbGain = (db) => 10 ** (db / 20);
const toDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));
const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Track {
  constructor(n) {
    this.n = n;
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
  }
}

function panGains(pan) {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

function scaleTrack(track, gain) {
  for (let i = 0; i < track.n; i += 1) {
    track.L[i] *= gain;
    track.R[i] *= gain;
  }
}

// Adds `src` into `dst` with a constant-power balance that keeps a centred source at unity.
function mixInto(dst, src, gain = 1, pan = 0) {
  const [gl, gr] = panGains(pan);
  const l = gain * gl * Math.SQRT2;
  const r = gain * gr * Math.SQRT2;
  for (let i = 0; i < dst.n; i += 1) {
    dst.L[i] += src.L[i] * l;
    dst.R[i] += src.R[i] * r;
  }
}

// ADSR with a raised-cosine attack, exponential decay to sustain and an exponential release;
// `release` is the time to fall 60 dB after note-off.
function adsr(len, attack, decay, sustain, release, dur) {
  const env = new Float32Array(len);
  const aN = Math.max(1, Math.round(attack * SR));
  const offN = Math.round(dur * SR);
  const dm = decay > 0 ? Math.exp(-1 / (decay * SR)) : 0;
  const rm = Math.exp(-6.9 / (Math.max(release, 0.002) * SR));
  let dec = 1;
  let v = 0;
  for (let i = 0; i < len; i += 1) {
    if (i < offN) {
      if (i < aN) v = 0.5 - 0.5 * Math.cos((Math.PI * i) / aN);
      else {
        v = sustain + (1 - sustain) * dec;
        dec *= dm;
      }
    } else v *= rm;
    env[i] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------------------------
// Filters

function polyBlep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// Topology-preserving-transform state-variable filter (Zavalishin). Stable under fast modulation.
class Svf {
  constructor(fc = 1000, q = 0.707) {
    this.ic1 = 0;
    this.ic2 = 0;
    this.bp = 0;
    this.hp = 0;
    this.set(fc, q);
  }
  set(fc, q) {
    const g = Math.tan((Math.PI * clamp(fc, 10, SR * 0.45)) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  lp(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

// RBJ cookbook biquads.
function biquad(type, f, q = 0.707, db = 0) {
  const w = (TAU * clamp(f, 5, SR * 0.49)) / SR;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const alpha = sw / (2 * q);
  const A = 10 ** (db / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === "lp") [b0, b1, b2, a0, a1, a2] = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha];
  else if (type === "hp") [b0, b1, b2, a0, a1, a2] = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha];
  else if (type === "bp") [b0, b1, b2, a0, a1, a2] = [alpha, 0, -alpha, 1 + alpha, -2 * cw, 1 - alpha];
  else if (type === "peak") [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A];
  else {
    const s = 2 * Math.sqrt(A) * alpha;
    if (type === "lowshelf") {
      [b0, b1, b2] = [A * (A + 1 - (A - 1) * cw + s), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - s)];
      [a0, a1, a2] = [A + 1 + (A - 1) * cw + s, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - s];
    } else {
      [b0, b1, b2] = [A * (A + 1 + (A - 1) * cw + s), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - s)];
      [a0, a1, a2] = [A + 1 - (A - 1) * cw + s, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - s];
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function runBiquad(buf, c) {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const x = buf[i];
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    buf[i] = y;
  }
}

function eqTrack(track, bands) {
  for (const [type, f, q, db] of bands) {
    const c = biquad(type, f, q, db);
    runBiquad(track.L, c);
    runBiquad(track.R, c);
  }
}

// Fourth-order Butterworth high/low-pass as two biquads.
const butter4 = (type, f) => [[type, f, 0.5412], [type, f, 1.3066]];

// ---------------------------------------------------------------------------------------------
// Effects

function chorus(track, { rate = 0.33, depth = 0.0022, base = 0.011, mix = 0.35 } = {}) {
  const size = Math.ceil((base + depth) * SR) + 4;
  const bufL = new Float32Array(size);
  const bufR = new Float32Array(size);
  let w = 0;
  for (let i = 0; i < track.n; i += 1) {
    const inL = track.L[i];
    const inR = track.R[i];
    bufL[w] = inL;
    bufR[w] = inR;
    const t = i / SR;
    const dl = (base + depth * Math.sin(TAU * rate * t)) * SR;
    const dr = (base + depth * Math.sin(TAU * rate * t + Math.PI / 2)) * SR;
    const read = (buf, d) => {
      let p = w - d;
      while (p < 0) p += size;
      const i0 = Math.floor(p);
      const frac = p - i0;
      return buf[i0] * (1 - frac) + buf[(i0 + 1) % size] * frac;
    };
    // Cross-feed keeps the chorus image wide but correlated.
    const wl = read(bufL, dl);
    const wr = read(bufR, dr);
    track.L[i] = inL * (1 - mix * 0.5) + (wl * 0.7 + wr * 0.3) * mix;
    track.R[i] = inR * (1 - mix * 0.5) + (wr * 0.7 + wl * 0.3) * mix;
    w = (w + 1) % size;
  }
}

function pingPong(src, { time, feedback = 0.35, lp = 3500, hp = 350 }) {
  const out = new Track(src.n);
  const d = Math.max(1, Math.round(time * SR));
  const bufL = new Float32Array(d);
  const bufR = new Float32Array(d);
  const lpc = 1 - Math.exp((-TAU * lp) / SR);
  const hpc = 1 - Math.exp((-TAU * hp) / SR);
  let lL = 0, lR = 0, hL = 0, hR = 0;
  let w = 0;
  for (let i = 0; i < src.n; i += 1) {
    const yl = bufL[w];
    const yr = bufR[w];
    out.L[i] = yl;
    out.R[i] = yr;
    lL += (yr - lL) * lpc;
    lR += (yl - lR) * lpc;
    hL += (lL - hL) * hpc;
    hR += (lR - hR) * hpc;
    const mono = (src.L[i] + src.R[i]) * 0.5;
    bufL[w] = mono + (lL - hL) * feedback;
    bufR[w] = (lR - hR) * feedback;
    w = (w + 1) % d;
  }
  return out;
}

// Eight-line feedback delay network with input diffusion, per-line damping, a Householder
// mixing matrix and slow delay modulation on two lines to avoid metallic ringing.
function fdnReverb(src, { rt60 = 2.2, size = 1, damp = 6000, predelay = 0.02, width = 1 } = {}) {
  const out = new Track(src.n);
  const scale = SR / 44100;
  const pre = Math.max(1, Math.round(predelay * SR));
  const preL = new Float32Array(pre);
  const preR = new Float32Array(pre);
  const makeAp = (len, g) => ({ buf: new Float32Array(Math.round(len * scale)), g, w: 0 });
  const apL = [makeAp(142, 0.72), makeAp(107, 0.72), makeAp(379, 0.62), makeAp(277, 0.62)];
  const apR = [makeAp(151, 0.72), makeAp(113, 0.72), makeAp(367, 0.62), makeAp(289, 0.62)];
  const allpass = (ap, x) => {
    const d = ap.buf[ap.w];
    const y = -ap.g * x + d;
    ap.buf[ap.w] = x + ap.g * y;
    ap.w = (ap.w + 1) % ap.buf.length;
    return y;
  };
  const baseLens = [1433, 1601, 1867, 2053, 2251, 2399, 2687, 2903];
  const N = 8;
  const lines = baseLens.map((len, i) => {
    const L = Math.round(len * size * scale);
    return {
      buf: new Float32Array(L + 64),
      len: L,
      w: 0,
      lp: 0,
      g: 10 ** ((-3 * L) / (rt60 * SR)),
      mod: i === 2 || i === 5 ? 9 : 0,
      modRate: i === 2 ? 0.47 : 0.61
    };
  });
  const dampC = 1 - Math.exp((-TAU * damp) / SR);
  const ys = new Float64Array(N);
  let pw = 0;
  for (let i = 0; i < src.n; i += 1) {
    let inL = preL[pw];
    let inR = preR[pw];
    preL[pw] = src.L[i];
    preR[pw] = src.R[i];
    pw = (pw + 1) % pre;
    for (const ap of apL) inL = allpass(ap, inL);
    for (const ap of apR) inR = allpass(ap, inR);
    let sum = 0;
    for (let k = 0; k < N; k += 1) {
      const ln = lines[k];
      let y;
      if (ln.mod) {
        const d = ln.len - ln.mod * (1 + Math.sin((TAU * ln.modRate * i) / SR));
        let p = ln.w - d;
        const size2 = ln.buf.length;
        while (p < 0) p += size2;
        const i0 = Math.floor(p);
        const fr = p - i0;
        y = ln.buf[i0 % size2] * (1 - fr) + ln.buf[(i0 + 1) % size2] * fr;
      } else {
        let p = ln.w - ln.len;
        if (p < 0) p += ln.buf.length;
        y = ln.buf[p];
      }
      ln.lp += (y - ln.lp) * dampC;
      ys[k] = ln.lp * ln.g;
      sum += ys[k];
    }
    const hh = (2 / N) * sum;
    let oL = 0;
    let oR = 0;
    for (let k = 0; k < N; k += 1) {
      const ln = lines[k];
      const fb = ys[k] - hh;
      ln.buf[ln.w] = fb + (k % 2 === 0 ? inL : inR) * 0.5;
      ln.w = (ln.w + 1) % ln.buf.length;
      const sign = (k >> 1) % 2 === 0 ? 1 : -1;
      if (k % 2 === 0) oL += ys[k] * sign;
      else oR += ys[k] * sign;
    }
    // Width < 1 blends the two outputs to keep the return's correlation positive.
    const mid = (oL + oR) * 0.5;
    out.L[i] = (mid + (oL - mid) * width) * 0.35;
    out.R[i] = (mid + (oR - mid) * width) * 0.35;
  }
  return out;
}

// Stereo-linked feed-forward compressor with a soft knee.
function compress(track, { threshold = -18, ratio = 2, attack = 0.01, release = 0.15, knee = 6, detectMs = 5 } = {}) {
  const det = Math.exp(-1 / ((detectMs / 1000) * SR));
  const att = Math.exp(-1 / (attack * SR));
  const rel = Math.exp(-1 / (release * SR));
  let ms = 0;
  let gr = 0;
  let maxGr = 0;
  let sumGr = 0;
  for (let i = 0; i < track.n; i += 1) {
    const l = track.L[i];
    const r = track.R[i];
    ms = det * ms + (1 - det) * Math.max(l * l, r * r);
    const x = 10 * Math.log10(ms + 1e-12);
    const over = x - threshold;
    let target = 0;
    if (over > knee / 2) target = over * (1 / ratio - 1);
    else if (over > -knee / 2) target = ((1 / ratio - 1) * (over + knee / 2) ** 2) / (2 * knee);
    gr = target < gr ? att * gr + (1 - att) * target : rel * gr + (1 - rel) * target;
    const g = dbGain(gr);
    track.L[i] = l * g;
    track.R[i] = r * g;
    if (-gr > maxGr) maxGr = -gr;
    sumGr += -gr;
  }
  return { maxGainReductionDb: +maxGr.toFixed(2), meanGainReductionDb: +(sumGr / track.n).toFixed(2) };
}

// Kick-keyed ducking envelope (0..1): a 4 ms raised-cosine dip, short hold, smooth recovery.
function duckEnvelope(times, n, { attack = 0.004, hold = 0.012, release = 0.26 } = {}) {
  const env = new Float32Array(n);
  const aN = Math.round(attack * SR);
  const hN = Math.round(hold * SR);
  const rN = Math.round(release * SR);
  for (const t of times) {
    const s = Math.round(t * SR);
    for (let i = 0; i < aN + hN + rN; i += 1) {
      const idx = s + i;
      if (idx < 0 || idx >= n) continue;
      let d;
      if (i < aN) d = Math.sin((Math.PI / 2) * (i / aN)) ** 2;
      else if (i < aN + hN) d = 1;
      else d = 1 - smoothstep((i - aN - hN) / rN);
      if (d > env[idx]) env[idx] = d;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------------------------
// Loudness (ITU-R BS.1770-4) and true peak

const K_STAGE1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
const K_STAGE2 = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };

function kWeighted(buf) {
  const out = Float32Array.from(buf);
  runBiquad(out, K_STAGE1);
  runBiquad(out, K_STAGE2);
  return out;
}

function squaredPrefix(L, R) {
  const kL = kWeighted(L);
  const kR = R ? kWeighted(R) : null;
  const pre = new Float64Array(L.length + 1);
  for (let i = 0; i < L.length; i += 1) pre[i + 1] = pre[i] + kL[i] * kL[i] + (kR ? kR[i] * kR[i] : 0);
  return pre;
}

export function integratedLoudness(L, R, pre = squaredPrefix(L, R)) {
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const z = [];
  for (let s = 0; s + block <= L.length; s += hop) z.push((pre[s + block] - pre[s]) / block);
  const lk = (ms) => -0.691 + 10 * Math.log10(ms + 1e-20);
  const abs = z.filter((v) => lk(v) > -70);
  if (!abs.length) return -Infinity;
  const relGate = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((v) => lk(v) > relGate);
  return lk(rel.reduce((a, b) => a + b, 0) / rel.length);
}

// Mean (ungated) loudness of a time window, for section energy reporting.
function windowLoudness(pre, from, to) {
  const a = clamp(Math.round(from * SR), 0, pre.length - 1);
  const b = clamp(Math.round(to * SR), a + 1, pre.length - 1);
  return -0.691 + 10 * Math.log10((pre[b] - pre[a]) / (b - a) + 1e-20);
}

// 4x windowed-sinc interpolation kernels for true-peak estimation.
const TP_HALF = 8;
const TP_KERNELS = [1, 2, 3].map((p) => {
  const frac = p / 4;
  const k = [];
  for (let j = -TP_HALF + 1; j <= TP_HALF; j += 1) {
    const x = j - frac;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const wx = (x + TP_HALF) / (2 * TP_HALF);
    const win = 0.42 - 0.5 * Math.cos(TAU * wx) + 0.08 * Math.cos(2 * TAU * wx);
    k.push(sinc * win);
  }
  return k;
});

// Per-sample peak including the inter-sample peaks between i and i+1 (both channels).
function truePeakEnvelope(L, R) {
  const n = L.length;
  const tp = new Float32Array(n);
  for (const ch of [L, R]) {
    for (let i = 0; i < n; i += 1) {
      let m = Math.abs(ch[i]);
      if (i >= TP_HALF && i < n - TP_HALF) {
        for (const k of TP_KERNELS) {
          let s = 0;
          for (let j = 0; j < k.length; j += 1) s += ch[i + j - TP_HALF + 1] * k[j];
          const a = Math.abs(s);
          if (a > m) m = a;
        }
      }
      if (m > tp[i]) tp[i] = m;
    }
  }
  return tp;
}

// Offline true-peak limiter: a backward pass builds the attack ramps ahead of each peak, a
// forward pass holds and releases. Gain never exceeds what each (inter-)sample peak allows.
function truePeakLimit(L, R, ceilingDb, { attackMs = 1.5, holdMs = 4, releaseMs = 90 } = {}) {
  const n = L.length;
  const ceiling = dbGain(ceilingDb);
  const tp = truePeakEnvelope(L, R);
  const req = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const peak = Math.max(tp[i], i > 0 ? tp[i - 1] : 0);
    req[i] = peak > ceiling ? toDb(ceiling / peak) : 0;
  }
  const attackStep = 6 / (attackMs * 0.001 * SR);
  for (let i = n - 2; i >= 0; i -= 1) req[i] = Math.min(req[i], req[i + 1] + attackStep);
  const relC = 1 - Math.exp(-1 / (releaseMs * 0.001 * SR));
  const holdN = Math.round(holdMs * 0.001 * SR);
  let g = 0;
  let hold = 0;
  let maxGr = 0;
  for (let i = 0; i < n; i += 1) {
    if (req[i] < g) {
      g = req[i];
      hold = holdN;
    } else if (hold > 0) hold -= 1;
    else g = Math.min(req[i], g + (0 - g) * relC);
    const lin = dbGain(g);
    L[i] *= lin;
    R[i] *= lin;
    if (-g > maxGr) maxGr = -g;
  }
  return maxGr;
}

// ---------------------------------------------------------------------------------------------
// Harmony

const PC = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
const QUALITY = {
  "": [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
  sus4: [0, 5, 7], sus2: [0, 2, 7], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], 6: [0, 4, 7, 9], "7sus4": [0, 5, 7, 10]
};

export function parseChord(symbol) {
  const match = /^([A-G][#b]?)(maj9|maj7|madd9|m9|m7|7sus4|add9|sus4|sus2|m|7|6)?(?:\/([A-G][#b]?))?$/.exec(symbol);
  if (!match) throw new Error(`Unknown chord symbol "${symbol}"`);
  const root = PC[match[1]];
  const ints = QUALITY[match[2] || ""];
  return { symbol, root, ints, pcs: [...new Set(ints.map((i) => (root + i) % 12))], bass: match[3] ? PC[match[3]] : root };
}

// Chooses the closed or drop-2 voicing inside [lo, hi] with the least motion from `prev`.
function voice(chord, prev, lo, hi, maxNotes = 4) {
  let pcs = chord.ints.map((i) => (chord.root + i) % 12);
  pcs = [...new Set(pcs)];
  while (pcs.length > maxNotes) {
    const fifth = (chord.root + 7) % 12;
    pcs = pcs.includes(fifth) && pcs.length > 3 ? pcs.filter((p) => p !== fifth) : pcs.slice(1);
  }
  const candidates = [];
  for (let bottom = lo; bottom <= hi; bottom += 1) {
    const r = pcs.indexOf(bottom % 12);
    if (r < 0) continue;
    const notes = [bottom];
    for (let k = 1; k < pcs.length; k += 1) {
      const pc = pcs[(r + k) % pcs.length];
      let m = notes[notes.length - 1] + 1;
      while (m % 12 !== pc) m += 1;
      notes.push(m);
    }
    if (notes[notes.length - 1] <= hi) candidates.push(notes);
    if (notes.length >= 4) {
      const drop2 = [...notes];
      drop2[drop2.length - 2] -= 12;
      drop2.sort((a, b) => a - b);
      if (drop2[0] >= lo) candidates.push(drop2);
    }
  }
  if (!candidates.length) throw new Error(`No voicing for ${chord.symbol} in ${lo}-${hi}`);
  const centre = (lo + hi) / 2;
  const cost = (c) => {
    let s = 0;
    if (prev) {
      for (const m of c) s += Math.min(...prev.map((p) => Math.abs(p - m)));
      for (const p of prev) s += Math.min(...c.map((m) => Math.abs(p - m)));
    } else s = Math.abs(c.reduce((a, b) => a + b, 0) / c.length - centre) * 2;
    if (c[0] < 57 && c[1] - c[0] < 3) s += 6;
    return s;
  };
  return candidates.reduce((best, c) => (cost(c) < cost(best) ? c : best));
}

function nearestPitch(pc, prev, lo, hi) {
  let best = null;
  for (let m = lo; m <= hi; m += 1) if (m % 12 === pc && (best === null || Math.abs(m - prev) < Math.abs(best - prev))) best = m;
  return best;
}


// Legato writer: a pitch held across a chord change is tied rather than re-attacked.
class Legato {
  constructor(list) {
    this.list = list;
    this.active = new Map();
  }
  chord(t, dur, pitches, v, extra = {}) {
    const next = new Map();
    for (const m of pitches) {
      const a = this.active.get(m);
      if (a && Math.abs(a.t + a.dur - t) < 0.002 && Math.abs(a.v - v) < 1e-9) {
        a.dur += dur;
        next.set(m, a);
      } else {
        const ev = { t, dur, m, v, ...extra };
        this.list.push(ev);
        next.set(m, ev);
      }
    }
    this.active = next;
  }
}

// ---------------------------------------------------------------------------------------------
// Timeline

export function buildTimeline(preset, cues) {
  const form = preset.form;
  const ids = cues.sections.map((s) => s.id);
  const formIds = form.sections.map((s) => s.id);
  if (ids.join() !== formIds.join()) throw new Error(`Preset ${preset.id} expects chapters ${formIds.join(", ")} but the cut has ${ids.join(", ")}`);
  const sections = form.sections.map((s, i) => {
    const start = cues.sections[i].start;
    const end = i + 1 < form.sections.length ? cues.sections[i + 1].start : cues.endCard;
    const beats = s.bars.reduce((a, b) => a + b, 0);
    let spb = (end - start) / beats;
    let gap = 0;
    // A gap chapter keeps the preset tempo and ends in a short free-time stop that absorbs the
    // remainder, so the groove never changes speed and the next downbeat still lands on the cut.
    if (s.gap) {
      spb = 60 / (s.bpm ?? preset.nominalBpm);
      gap = end - start - beats * spb;
      if (gap < 0.02 || gap > 0.6) throw new Error(`${preset.id}/${s.id}: stop of ${gap.toFixed(3)} s is out of range`);
    }
    return { id: s.id, start, end, beats, spb, bpm: 60 / spb, gap, bars: s.bars, chords: s.chords };
  });
  const bars = [];
  const pushBars = (id, spec, start, spb, secEnd, gap = 0) => {
    let t = start;
    const n = spec.bars.length;
    spec.bars.forEach((beats, j) => {
      const symbols = spec.chords[j].split(/\s+/);
      const per = beats / symbols.length;
      const chords = symbols.map((sym, k) => ({ b0: k * per, b1: (k + 1) * per, chord: parseChord(sym) }));
      bars.push({ sec: id, j, nInSec: n + (gap ? 1 : 0), start: t, beats, spb, end: t + beats * spb, chords, secStart: start, secEnd, last: !gap && j === n - 1, lastGrid: j === n - 1 });
      t += beats * spb;
    });
    // The stop is its own gridless bar; arrangers leave it silent apart from tails and swells.
    if (gap) {
      const prev = bars[bars.length - 1];
      bars.push({ sec: id, j: n, nInSec: n + 1, start: t, beats: gap / spb, spb, end: secEnd, chords: [{ b0: 0, b1: gap / spb, chord: prev.chords[prev.chords.length - 1].chord }], secStart: start, secEnd, last: true, lastGrid: false, gap: true });
    }
  };
  const introBeats = form.intro.bars.reduce((a, b) => a + b, 0);
  const introStart = sections[0].start - introBeats * sections[0].spb;
  if (introStart < 0) throw new Error("Intro does not fit before the first chapter");
  pushBars("intro", form.intro, introStart, sections[0].spb, sections[0].start);
  for (const s of sections) pushBars(s.id, s, s.start, s.spb, s.end, s.gap);
  const last = sections[sections.length - 1];
  pushBars("outro", form.outro, cues.endCard, last.spb, cues.duration);
  bars.forEach((bar, i) => { bar.i = i; });
  return { sections, bars, introStart, cues };
}

const at = (bar, beat) => bar.start + beat * bar.spb;

function chordAt(bar, beat) {
  for (const seg of bar.chords) if (beat >= seg.b0 - 1e-9 && beat < seg.b1 - 1e-9) return seg;
  return bar.chords[bar.chords.length - 1];
}

// ---------------------------------------------------------------------------------------------
// Tonal synths

function synthSupersaw(track, notes, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x51ed);
  const voices = p.voices ?? 7;
  for (const nt of notes) {
    const attack = nt.a ?? p.attack;
    const release = nt.r ?? p.release;
    const start = Math.round(nt.t * SR);
    const len = Math.round((nt.dur + release) * SR);
    const env = adsr(len, attack, p.decay ?? 1, p.sustain ?? 1, release, nt.dur);
    const f0 = midiHz(nt.m);
    const osc = [];
    for (let v = 0; v < voices; v += 1) {
      const spread = voices === 1 ? 0 : (v / (voices - 1)) * 2 - 1;
      const cents = spread * (p.detune ?? 14) + (rng() - 0.5) * 2;
      const [gl, gr] = panGains(spread * (p.width ?? 0.8));
      osc.push({ f: f0 * 2 ** (cents / 1200), ph: rng(), gl, gr, vph: rng() * TAU, vrate: (p.vibRate ?? 5) * (0.9 + 0.2 * rng()), mul: 1 });
    }
    const fl = new Svf();
    const fr = new Svf();
    const amp = (nt.v * (p.gain ?? 1)) / Math.sqrt(voices);
    const keyTrack = (f0 / 261.63) ** (p.keyTrack ?? 0.3);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      if (idx < 0) continue;
      if ((i & 15) === 0) {
        const t = idx / SR;
        let fc = (p.cutoffAt ? p.cutoffAt(t) : p.cutoff ?? 2000) * keyTrack;
        fc *= 1 + (p.lfoDepth ?? 0) * Math.sin(TAU * (p.lfoRate ?? 0.1) * t + (p.lfoPhase ?? 0));
        fl.set(fc, p.q ?? 0.7);
        fr.set(fc, p.q ?? 0.7);
        const vibOn = p.vibCents ? smoothstep((i / SR - (p.vibDelay ?? 0.3)) / 0.4) : 0;
        for (const o of osc) {
          const cents = vibOn ? vibOn * p.vibCents * Math.sin(o.vph + TAU * o.vrate * (i / SR)) : 0;
          o.dt = (o.f * 2 ** (cents / 1200)) / SR;
        }
      }
      let l = 0;
      let r = 0;
      for (let k = 0; k < osc.length; k += 1) {
        const o = osc[k];
        let ph = o.ph + o.dt;
        if (ph >= 1) ph -= 1;
        o.ph = ph;
        const s = 2 * ph - 1 - polyBlep(ph, o.dt);
        l += s * o.gl;
        r += s * o.gr;
      }
      let e = env[i] * amp;
      // Optional crescendo shared by tied notes, rising smoothly from t0 and reaching full level at t1.
      if (nt.ramp) e *= smoothstep((idx / SR - nt.ramp[0]) / (nt.ramp[1] - nt.ramp[0])) ** 1.5;
      track.L[idx] += fl.lp(l) * e;
      track.R[idx] += fr.lp(r) * e;
    }
  }
}

// Two detuned band-limited saws (or squares) plus a sub square through an enveloped low-pass.
function synthPluck(track, notes, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x9a11);
  for (const nt of notes) {
    const release = p.release ?? 0.08;
    const start = Math.round(nt.t * SR);
    const len = Math.round((nt.dur + release) * SR);
    const env = adsr(len, p.attack ?? 0.002, p.decay ?? 0.2, p.sustain ?? 0, release, nt.dur);
    const f0 = midiHz(nt.m);
    const det = 2 ** ((p.detune ?? 8) / 1200);
    const oscs = [
      { dt: (f0 * det) / SR, ph: rng(), g: 0.5 },
      { dt: f0 / det / SR, ph: rng(), g: 0.5 },
      { dt: f0 / 2 / SR, ph: rng(), g: p.sub ?? 0, square: true }
    ];
    const square = p.wave === "square";
    const filter = new Svf();
    const [gl, gr] = panGains(nt.pan ?? p.pan ?? 0);
    const vel = nt.v;
    const envAmt = (p.envAmt ?? 3000) * vel ** 0.7;
    const fdm = Math.exp(-16 / ((p.fdecay ?? 0.1) * SR));
    let fenv = 1;
    const keyTrack = (f0 / 523.25) ** 0.5;
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      if ((i & 15) === 0) {
        filter.set(((p.cutoff ?? 700) + envAmt * fenv) * keyTrack, p.q ?? 1);
        fenv *= fdm;
      }
      let s = 0;
      for (const o of oscs) {
        if (!o.g) continue;
        let ph = o.ph + o.dt;
        if (ph >= 1) ph -= 1;
        o.ph = ph;
        if (o.square || square) {
          let q = ph < 0.5 ? 1 : -1;
          q += polyBlep(ph, o.dt);
          q -= polyBlep((ph + 0.5) % 1, o.dt);
          s += q * o.g;
        } else s += (2 * ph - 1 - polyBlep(ph, o.dt)) * o.g;
      }
      let f = filter.lp(s);
      if (p.drive) f = Math.tanh(p.drive * f) / Math.tanh(p.drive);
      const y = f * env[i] * vel * (p.gain ?? 1);
      track.L[idx] += y * gl;
      track.R[idx] += y * gr;
    }
  }
}

// Sine sub with low harmonics and gentle saturation, plus an optional filtered-saw layer that
// keeps the bass audible on laptop speakers.
function synthSub(track, notes, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x5b5b);
  for (const nt of notes) {
    const release = p.release ?? 0.06;
    const start = Math.round(nt.t * SR);
    const len = Math.round((nt.dur + release) * SR);
    const env = adsr(len, p.attack ?? 0.005, p.decay ?? 1, p.sustain ?? 0.8, release, nt.dur);
    const f0 = midiHz(nt.m);
    const dt = f0 / SR;
    let ph = 0;
    let sph = rng();
    const filter = new Svf();
    const drive = p.drive ?? 1;
    const norm = Math.tanh(drive);
    const envDecay = Math.exp(-16 / ((p.sawEnvDecay ?? 0.1) * SR));
    let senv = 1;
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      ph += dt;
      if (ph >= 1) ph -= 1;
      let s = Math.sin(TAU * ph) + (p.h2 ?? 0) * Math.sin(2 * TAU * ph) + (p.h3 ?? 0) * Math.sin(3 * TAU * ph);
      s = Math.tanh(s * drive) / norm;
      if (p.saw) {
        if ((i & 15) === 0) {
          filter.set((p.sawCut ?? 400) + (p.sawEnv ?? 0) * senv * nt.v, p.sawQ ?? 0.9);
          senv *= envDecay;
        }
        sph += dt;
        if (sph >= 1) sph -= 1;
        s += filter.lp(2 * sph - 1 - polyBlep(sph, dt)) * p.saw;
      }
      const y = s * env[i] * nt.v * 0.5;
      track.L[idx] += y;
      track.R[idx] += y;
    }
  }
}

// Two-operator FM bell / glassy e-piano with a detuned twin for width.
function synthBell(track, notes, p) {
  for (const nt of notes) {
    const release = p.release ?? 0.6;
    const start = Math.round(nt.t * SR);
    const len = Math.round((nt.dur + release) * SR);
    const env = adsr(len, p.attack ?? 0.003, p.decay ?? 1.2, p.sustain ?? 0, release, nt.dur);
    const f0 = midiHz(nt.m);
    const ratio = p.ratio ?? 2;
    const maxIndex = Math.max(0, (18000 - f0) / (f0 * ratio) - 1);
    const index0 = Math.min((p.index ?? 1.5) * nt.v, maxIndex);
    const idm = Math.exp(-1 / ((p.indexDecay ?? 0.3) * SR));
    const det = 2 ** ((p.detune ?? 5) / 1200);
    const twins = [{ f: f0 * det, pan: -0.35 }, { f: f0 / det, pan: 0.35 }].map((o) => ({ ...o, pc: 0, pm: 0, g: panGains(o.pan) }));
    let index = index0;
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const e = env[i] * nt.v * 0.5;
      for (const o of twins) {
        o.pm += (o.f * ratio) / SR;
        o.pc += o.f / SR;
        if (o.pm >= 1) o.pm -= 1;
        if (o.pc >= 1) o.pc -= 1;
        const s = Math.sin(TAU * o.pc + index * Math.sin(TAU * o.pm)) + (p.octave ?? 0.15) * Math.sin(2 * TAU * o.pc);
        track.L[idx] += s * e * o.g[0];
        track.R[idx] += s * e * o.g[1];
      }
      index = index * idm + (p.indexSustain ?? 0.2) * (1 - idm);
    }
  }
}

// Saw/square lead with delayed vibrato and an enveloped, key-tracked low-pass.
function synthLead(track, notes, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x1ead);
  for (const nt of notes) {
    const release = p.release ?? 0.3;
    const start = Math.round(nt.t * SR);
    const len = Math.round((nt.dur + release) * SR);
    const env = adsr(len, p.attack ?? 0.01, p.decay ?? 0.3, p.sustain ?? 0.7, release, nt.dur);
    const f0 = midiHz(nt.m);
    let ph1 = rng();
    let ph2 = rng();
    const filter = new Svf();
    const fdm = Math.exp(-16 / ((p.fdecay ?? 0.2) * SR));
    let fenv = 1;
    let dt1 = f0 / SR;
    let dt2 = (f0 * 2 ** ((p.detune ?? 6) / 1200)) / SR;
    const keyTrack = (f0 / 523.25) ** 0.6;
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      if ((i & 15) === 0) {
        const t = i / SR;
        const vib = (p.vibCents ?? 10) * smoothstep((t - (p.vibDelay ?? 0.25)) / 0.3) * Math.sin(TAU * (p.vibRate ?? 5.3) * t);
        // Optional portamento: the note starts at `from` and glides exponentially onto its pitch.
        const glide = nt.from != null ? (nt.from - nt.m) * 100 * Math.exp(-t / ((p.glide ?? 0.06) / 3)) : 0;
        const m = 2 ** ((vib + glide) / 1200);
        dt1 = (f0 * m) / SR;
        dt2 = (f0 * m * 2 ** ((p.detune ?? 6) / 1200)) / SR;
        filter.set((p.cutoff ?? 2500) * keyTrack * (1 + (p.envAmt ?? 0.8) * fenv), p.q ?? 0.8);
        fenv *= fdm;
      }
      ph1 += dt1;
      if (ph1 >= 1) ph1 -= 1;
      ph2 += dt2;
      if (ph2 >= 1) ph2 -= 1;
      const saw = 2 * ph1 - 1 - polyBlep(ph1, dt1);
      let sq = ph2 < 0.5 ? 1 : -1;
      sq += polyBlep(ph2, dt2) - polyBlep((ph2 + 0.5) % 1, dt2);
      let raw = saw * (p.saw ?? 0.6) + sq * (p.square ?? 0.4);
      if (p.drive) raw = Math.tanh(p.drive * raw);
      let s = filter.lp(raw);
      if (p.drive2) s = Math.tanh(p.drive2 * s) / Math.tanh(p.drive2);
      const y = s * env[i] * nt.v * 0.5;
      track.L[idx] += y;
      track.R[idx] += y;
    }
  }
}

// Additive piano: inharmonic partials (f_n = n f0 sqrt(1 + B n^2)), strike-position comb,
// velocity-dependent brightness, two-stage (prompt + aftersound) decay with detuned unison
// strings for natural beating, hammer noise and a damper on release. Each partial is a
// recursive complex rotor, so the tone is exactly band-limited.
function synthPiano(track, notes, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x9e3779b9);
  for (const nt of notes) {
    const f0 = midiHz(nt.m);
    const v = clamp(nt.v, 0.05, 1);
    const start = Math.round(nt.t * SR);
    const B = 7e-5 * Math.exp(0.09 * (nt.m - 21));
    const reg = 261.63 / f0;
    const T = clamp(3.4 * reg ** 0.55, 0.6, 9);
    const damper = clamp(0.05 + 0.06 * Math.sqrt(reg), 0.04, 0.2);
    const holdN = Math.round(nt.dur * SR);
    const len = Math.round(Math.min(nt.dur + damper * 7, p.maxLen ?? 7) * SR);
    const out = new Float64Array(len);
    const strike = p.strike ?? 0.118;
    const cutoff = 3200 + 6000 * v * v;
    for (let k = 1; k <= 64; k += 1) {
      const fk = k * f0 * Math.sqrt(1 + B * k * k);
      if (fk > 14000) break;
      let a = k ** -(1.05 + 0.5 * (1 - v)) * (0.25 + Math.abs(Math.sin(Math.PI * k * strike)));
      a /= 1 + (fk / cutoff) ** 2;
      if (a < 0.0012) continue;
      const tau2 = T / (1 + (fk / 1300) ** 1.25);
      const tau1 = tau2 * 0.2;
      const beat = (0.06 + 0.06 * rng()) * Math.sqrt(k);
      const pLen = Math.min(len, Math.round(Math.min(holdN + damper * 7 * SR, tau2 * 7.5 * SR)));
      const rot = (f, tau, w) => {
        const om = (TAU * f) / SR;
        const r = Math.exp(-1 / (tau * SR));
        return { c: Math.cos(om) * r, s: Math.sin(om) * r, re: 1, im: 0, w };
      };
      const rs = [rot(fk, tau1, 0.55), rot(fk + beat / 2, tau2, 0.24), rot(fk - beat / 2, tau2, 0.21)];
      for (const o of rs) {
        let re = o.re;
        let im = o.im;
        const c = o.c;
        const s = o.s;
        const g = o.w * a;
        for (let i = 0; i < pLen; i += 1) {
          const nre = re * c - im * s;
          im = re * s + im * c;
          re = nre;
          out[i] += im * g;
        }
      }
    }
    // Hammer: a short burst of low-passed noise shaped by velocity.
    const hc = 1 - Math.exp((-TAU * (900 + 3200 * v)) / SR);
    let lpn = 0;
    const hN = Math.min(len, Math.round(0.03 * SR));
    for (let i = 0; i < hN; i += 1) {
      lpn += (rng() * 2 - 1 - lpn) * hc;
      out[i] += lpn * 0.05 * v * Math.exp(-i / (0.004 * SR));
    }
    const dm = Math.exp(-1 / (damper * SR));
    let d = 1;
    const aN = Math.round(0.0012 * SR);
    const gain = 0.2 * v ** 1.5;
    const [gl, gr] = panGains(clamp((nt.m - 62) / 36, -0.4, 0.4));
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      if (idx < 0) continue;
      if (i >= holdN) d *= dm;
      const atk = i < aN ? i / aN : 1;
      const y = out[i] * gain * d * atk;
      track.L[idx] += y * gl;
      track.R[idx] += y * gr;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Percussion and effects synths (mono sources unless noted)

function synthKick(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x4b1c);
  const len = Math.round((p.length ?? 0.45) * SR);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    let ph = 0;
    let lpn = 0;
    const drive = p.drive ?? 1.5;
    const norm = Math.tanh(drive);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      const f = p.f1 + (p.f0 - p.f1) * Math.exp(-t / (p.pitchTau ?? 0.04));
      ph += f / SR;
      const amp = Math.min(1, t / 0.0006) * Math.exp(-t / (p.ampTau ?? 0.25)) * (1 - (i / len) ** 4);
      lpn += (rng() * 2 - 1 - lpn) * 0.3;
      let s = Math.sin(TAU * ph) * amp + lpn * (p.click ?? 0.1) * Math.exp(-t / 0.0022);
      s = (Math.tanh(s * drive) / norm) * ev.v;
      track.L[idx] += s;
      track.R[idx] += s;
    }
  }
}

function synthClap(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0xc1a9);
  const len = Math.round(0.4 * SR);
  const offsets = [0, 0.0105, 0.021, 0.031];
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const bl = new Svf(p.freq ?? 1250, 1.3);
    const br = new Svf((p.freq ?? 1250) * 1.06, 1.3);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      let e = 0;
      offsets.forEach((o, k) => {
        if (t >= o) e += (k < 3 ? 0.75 : 1) * Math.exp(-(t - o) / 0.0035);
      });
      if (t >= 0.031) e += 0.8 * Math.exp(-(t - 0.031) / (p.tail ?? 0.09));
      const common = rng() * 2 - 1;
      bl.lp(common * 0.7 + (rng() * 2 - 1) * 0.3);
      br.lp(common * 0.7 + (rng() * 2 - 1) * 0.3);
      track.L[idx] += bl.bp * e * ev.v;
      track.R[idx] += br.bp * e * ev.v;
    }
  }
}

function synthSnare(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x5a4e);
  const len = Math.round(0.35 * SR);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const hp = new Svf(1500, 0.7);
    const lp = new Svf(7500, 0.7);
    let ph = 0;
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      const f = (p.body ?? 190) * (1 + 0.25 * Math.exp(-t / 0.02));
      ph += f / SR;
      const body = Math.sin(TAU * ph) * Math.exp(-t / 0.05) * 0.55;
      hp.lp(rng() * 2 - 1);
      const noise = lp.lp(hp.hp) * Math.exp(-t / (p.tail ?? 0.12));
      const s = (body + noise) * Math.min(1, t / 0.0007) * ev.v;
      track.L[idx] += s;
      track.R[idx] += s;
    }
  }
}

function synthHat(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ (p.open ? 0x0be7 : 0x4a7));
  const decay = p.decay ?? 0.035;
  const len = Math.round(Math.min(decay * 8, 1.2) * SR);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const bp = new Svf(p.freq ?? 8200, 0.8);
    const hp = new Svf(p.hp ?? 5600, 0.7);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      bp.lp(rng() * 2 - 1);
      hp.lp(bp.bp);
      const s = hp.hp * Math.min(1, t / 0.0005) * Math.exp(-t / decay) * (1 - i / len) * ev.v;
      track.L[idx] += s;
      track.R[idx] += s;
    }
  }
}

function synthShaker(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x54a3);
  const len = Math.round(0.16 * SR);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const bp = new Svf(p.freq ?? 6000, 1.1);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      bp.lp(rng() * 2 - 1);
      const e = smoothstep(t / (p.attack ?? 0.007)) * Math.exp(-t / (p.decay ?? 0.035)) * (1 - i / len);
      track.L[idx] += bp.bp * e * ev.v;
      track.R[idx] += bp.bp * e * ev.v;
    }
  }
}

function synthRim(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x2111);
  const len = Math.round(0.08 * SR);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const hp = new Svf(900, 0.7);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      const tone = Math.sin(TAU * (p.freq ?? 1650) * t) * Math.exp(-t / 0.009) * 0.7 + Math.sin(TAU * (p.low ?? 560) * t) * Math.exp(-t / 0.016) * 0.45;
      hp.lp(rng() * 2 - 1);
      const s = (tone + hp.hp * Math.exp(-t / 0.0018) * 0.5) * Math.min(1, t / 0.0004) * ev.v;
      track.L[idx] += s;
      track.R[idx] += s;
    }
  }
}

// Short finger-snap: a single band-passed noise burst with a pitched click.
function synthSnap(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x5a9);
  const len = Math.round(0.18 * SR);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const bp = new Svf(p.freq ?? 2300, 1.6);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      bp.lp(rng() * 2 - 1);
      const s = (bp.bp * Math.exp(-t / 0.022) + Math.sin(TAU * 1900 * t) * Math.exp(-t / 0.004) * 0.3) * Math.min(1, t / 0.0004) * ev.v;
      track.L[idx] += s;
      track.R[idx] += s;
    }
  }
}

// Soft crash: high-passed noise, partly decorrelated between channels for width.
function synthCrash(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0xc2a5);
  const len = Math.round((p.length ?? 2.8) * SR);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const hl = new Svf(p.hp ?? 2800, 0.7);
    const hr = new Svf(p.hp ?? 2800, 0.7);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      const e = Math.min(1, t / 0.0015) * Math.exp(-t / (p.decay ?? 1.1)) * (1 - (i / len) ** 2) * ev.v;
      const c = rng() * 2 - 1;
      hl.lp(c * 0.6 + (rng() * 2 - 1) * 0.4);
      hr.lp(c * 0.6 + (rng() * 2 - 1) * 0.4);
      track.L[idx] += hl.hp * e;
      track.R[idx] += hr.hp * e;
    }
  }
}

// Noise riser: a band-pass sweeping up exponentially while the level swells; ends on the cue.
function synthRiser(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x415e);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const len = Math.round(ev.dur * SR);
    const bl = new Svf();
    const br = new Svf();
    const fade = Math.round(0.006 * SR);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const x = i / len;
      if ((i & 15) === 0) {
        const fc = (p.f0 ?? 350) * ((p.f1 ?? 6000) / (p.f0 ?? 350)) ** (x ** 1.3);
        bl.set(fc, p.q ?? 1.8);
        br.set(fc * 1.04, p.q ?? 1.8);
      }
      const c = rng() * 2 - 1;
      bl.lp(c * 0.6 + (rng() * 2 - 1) * 0.4);
      br.lp(c * 0.6 + (rng() * 2 - 1) * 0.4);
      const e = x * x * (i > len - fade ? (len - i) / fade : 1) * ev.v;
      track.L[idx] += bl.bp * e;
      track.R[idx] += br.bp * e;
    }
  }
}

// Reverse-cymbal swell: band-limited noise rising cubically into the cue, then gone.
function synthSwell(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x5e11);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const len = Math.round(ev.dur * SR);
    const hl = new Svf(p.hp ?? 3000, 0.7);
    const hr = new Svf(p.hp ?? 3000, 0.7);
    const ll = new Svf(p.lp ?? 9500, 0.7);
    const lr = new Svf(p.lp ?? 9500, 0.7);
    const fade = Math.round(0.004 * SR);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const x = i / len;
      const c = rng() * 2 - 1;
      hl.lp(c * 0.6 + (rng() * 2 - 1) * 0.4);
      hr.lp(c * 0.6 + (rng() * 2 - 1) * 0.4);
      const e = x ** 3 * (i > len - fade ? (len - i) / fade : 1) * ev.v;
      track.L[idx] += ll.lp(hl.hp) * e;
      track.R[idx] += lr.lp(hr.hp) * e;
    }
  }
}

// Sub impact for big downbeats; stays above 40 Hz.
function synthBoom(track, evs, p) {
  const len = Math.round((p.length ?? 1.6) * SR);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    let ph = 0;
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      ph += ((p.f1 ?? 43) + ((p.f0 ?? 75) - (p.f1 ?? 43)) * Math.exp(-t / 0.09)) / SR;
      const s = Math.tanh(1.3 * Math.sin(TAU * ph)) * Math.min(1, t / 0.002) * Math.exp(-t / (p.decay ?? 0.5)) * (1 - i / len) * ev.v;
      track.L[idx] += s;
      track.R[idx] += s;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Dark techno instruments (candidates D and E)

// Hard techno kick: band-passed noise click, sine body with a two-stage pitch drop (fast
// attack sweep, then a slower fall onto the fundamental), body + sub-tail envelope and an
// asymmetric tanh waveshaper. Each kick is choked by the next one so tails never smear.
function synthTechnoKick(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x7e4c);
  const sorted = [...evs].sort((a, b) => a.t - b.t);
  sorted.forEach((ev, k) => {
    const next = sorted[k + 1];
    const len = Math.round(Math.min(p.length ?? 0.6, next ? next.t - ev.t : Infinity) * SR);
    const fade = Math.min(len, Math.round(0.006 * SR));
    const start = Math.round(ev.t * SR);
    const click = new Svf(p.clickFreq ?? 4500, 0.8);
    const drive = p.drive ?? 3;
    const asym = p.asym ?? 0.08;
    const off = Math.tanh(drive * asym);
    const norm = 1 / (Math.tanh(drive * (1 + asym)) - off);
    const tail = p.tail ?? 0.3;
    let ph = 0;
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      const f = p.f1 + (p.fMid - p.f1) * Math.exp(-t / p.tau2) + (p.f0 - p.fMid) * Math.exp(-t / p.tau1);
      ph += f / SR;
      const amp = Math.min(1, t / 0.0004) * ((1 - tail) * Math.exp(-t / p.ampTau) + tail * Math.exp(-t / p.tailTau));
      click.lp(rng() * 2 - 1);
      let s = Math.sin(TAU * ph) * amp + click.bp * (p.click ?? 0.3) * Math.exp(-t / 0.0015);
      s = (Math.tanh(drive * (s + asym)) - off) * norm;
      if (i > len - fade) s *= (len - i) / fade;
      track.L[idx] += s * ev.v;
      track.R[idx] += s * ev.v;
    }
  });
}

// Distorted analogue-style bass: detuned band-limited saw + square, pre-drive into a resonant
// enveloped low-pass, post-drive, optional bit/sample-rate crush, and a clean sine sub.
function synthDriveBass(track, notes, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0xba55);
  for (const nt of notes) {
    const release = p.release ?? 0.02;
    const start = Math.round(nt.t * SR);
    const len = Math.round((nt.dur + release) * SR);
    const env = adsr(len, p.attack ?? 0.0015, p.decay ?? 0.12, p.sustain ?? 0.5, release, nt.dur);
    const f0 = midiHz(nt.m);
    const det = 2 ** ((p.detune ?? 7) / 1200);
    const dt1 = (f0 * det) / SR;
    const dt2 = f0 / det / SR;
    const dts = f0 / SR;
    let p1 = rng();
    let p2 = rng();
    let ps = 0;
    const filt = new Svf();
    const d1 = p.drive1 ?? 2.5;
    const d2 = p.drive2 ?? 2;
    const n2 = Math.tanh(d2);
    const sqMix = p.square ?? 0.4;
    const fdm = Math.exp(-16 / ((p.fdecay ?? 0.07) * SR));
    let fenv = 1;
    const crush = nt.crush ?? 0;
    const hold = 1 + Math.round(crush * 5);
    const q = 2 ** (12 - crush * 7);
    let held = 0;
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      if ((i & 15) === 0) {
        const base = p.cutoffAt ? p.cutoffAt(idx / SR) : p.cutoff ?? 800;
        filt.set(base * (1 + (p.envAmt ?? 3) * nt.v * fenv), p.q ?? 2.5);
        fenv *= fdm;
      }
      p1 += dt1;
      if (p1 >= 1) p1 -= 1;
      p2 += dt2;
      if (p2 >= 1) p2 -= 1;
      ps += dts;
      if (ps >= 1) ps -= 1;
      const saw = 2 * p1 - 1 - polyBlep(p1, dt1);
      let sq = p2 < 0.5 ? 1 : -1;
      sq += polyBlep(p2, dt2) - polyBlep((p2 + 0.5) % 1, dt2);
      let s = Math.tanh(d1 * (saw * (1 - sqMix) + sq * sqMix));
      s = Math.tanh(d2 * filt.lp(s)) / n2;
      if (crush > 0) {
        if (i % hold === 0) held = Math.round(s * q) / q;
        s = held;
      }
      const y = (s * (p.mid ?? 0.6) + Math.sin(TAU * ps) * (p.sub ?? 0.5)) * env[i] * nt.v * 0.5;
      track.L[idx] += y;
      track.R[idx] += y;
    }
  }
}

// Brass-like stabs and sustained chords: detuned saw ensemble plus an octave-down square,
// enveloped resonant low-pass, heavy saturation, and an optional pitch-bend dive.
function synthBrass(track, notes, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0xb7a55);
  const voices = p.voices ?? 5;
  for (const nt of notes) {
    const attack = nt.a ?? p.attack ?? 0.004;
    const release = nt.r ?? p.release ?? 0.12;
    const start = Math.round(nt.t * SR);
    const len = Math.round((nt.dur + release) * SR);
    const env = adsr(len, attack, nt.decay ?? p.decay ?? 0.2, nt.sustain ?? p.sustain ?? 0.3, release, nt.dur);
    const f0 = midiHz(nt.m);
    const osc = [];
    for (let v = 0; v < voices; v += 1) {
      const spread = voices === 1 ? 0 : (v / (voices - 1)) * 2 - 1;
      const [gl, gr] = panGains(spread * (p.width ?? 0.7));
      osc.push({ f: f0 * 2 ** ((spread * (p.detune ?? 16) + (rng() - 0.5) * 3) / 1200), ph: rng(), gl, gr, dt: 0 });
    }
    const sub = { f: f0 / 2, ph: rng(), dt: 0 };
    const fl = new Svf();
    const fr = new Svf();
    const drive = p.drive ?? 3;
    const norm = Math.tanh(drive);
    const fdm = Math.exp(-16 / ((p.fdecay ?? 0.12) * SR));
    let fenv = 1;
    const amp = nt.v / Math.sqrt(voices);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      if ((i & 15) === 0) {
        const t = i / SR;
        const dive = nt.dive ? -nt.dive * smoothstep((t - (nt.diveAt ?? 0.05)) / (nt.diveTime ?? 0.35)) : 0;
        const mul = 2 ** (dive / 12);
        for (const o of osc) o.dt = (o.f * mul) / SR;
        sub.dt = (sub.f * mul) / SR;
        const base = p.cutoffAt ? p.cutoffAt(idx / SR) : p.cutoff ?? 900;
        const fc = base * (1 + (nt.envAmt ?? p.envAmt ?? 4) * nt.v * fenv);
        fl.set(fc, p.q ?? 1.1);
        fr.set(fc, p.q ?? 1.1);
        fenv *= fdm;
      }
      let l = 0;
      let r = 0;
      for (const o of osc) {
        o.ph += o.dt;
        if (o.ph >= 1) o.ph -= 1;
        const s = 2 * o.ph - 1 - polyBlep(o.ph, o.dt);
        l += s * o.gl;
        r += s * o.gr;
      }
      sub.ph += sub.dt;
      if (sub.ph >= 1) sub.ph -= 1;
      let sq = sub.ph < 0.5 ? 1 : -1;
      sq += polyBlep(sub.ph, sub.dt) - polyBlep((sub.ph + 0.5) % 1, sub.dt);
      l += sq * (p.sub ?? 0.3);
      r += sq * (p.sub ?? 0.3);
      const e = env[i] * amp;
      track.L[idx] += (Math.tanh(drive * fl.lp(l) * 0.6) / norm) * e;
      track.R[idx] += (Math.tanh(drive * fr.lp(r) * 0.6) / norm) * e;
    }
  }
}

// Thin, eerie high line: two slightly detuned saws and a sine with delayed vibrato and a slow
// pitch drift (`bend` cents over the note) for dread.
function synthEerie(track, notes, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0xe3e1);
  for (const nt of notes) {
    const release = p.release ?? 1.2;
    const start = Math.round(nt.t * SR);
    const len = Math.round((nt.dur + release) * SR);
    const env = adsr(len, nt.a ?? p.attack ?? 0.9, 2, 1, release, nt.dur);
    const f0 = midiHz(nt.m);
    const det = p.detune ?? 9;
    const oscs = [{ c: -det, pan: -0.35, ph: rng() }, { c: det, pan: 0.35, ph: rng() }].map((o) => ({ ...o, g: panGains(o.pan), dt: 0 }));
    let sph = 0;
    let sdt = 0;
    const fl = new Svf(p.cutoff ?? 4500, 0.7);
    const fr = new Svf(p.cutoff ?? 4500, 0.7);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      if ((i & 15) === 0) {
        const t = i / SR;
        const drift = (nt.bend ?? 0) * Math.min(1, t / nt.dur);
        const vib = (p.vibCents ?? 14) * smoothstep((t - 0.5) / 0.8) * Math.sin(TAU * (p.vibRate ?? 4.7) * t);
        for (const o of oscs) o.dt = (f0 * 2 ** ((o.c + drift + vib) / 1200)) / SR;
        sdt = (f0 * 2 ** ((drift + vib) / 1200)) / SR;
      }
      let l = 0;
      let r = 0;
      for (const o of oscs) {
        o.ph += o.dt;
        if (o.ph >= 1) o.ph -= 1;
        const s = 2 * o.ph - 1 - polyBlep(o.ph, o.dt);
        l += s * o.g[0];
        r += s * o.g[1];
      }
      sph += sdt;
      if (sph >= 1) sph -= 1;
      const sine = Math.sin(TAU * sph) * (p.sine ?? 0.6);
      const e = env[i] * nt.v * 0.4;
      track.L[idx] += (fl.lp(l) + sine) * e;
      track.R[idx] += (fr.lp(r) + sine) * e;
    }
  }
}

// Gritty hats: saturated noise mixed with six detuned band-limited square "metal" oscillators,
// band-passed and high-passed. Each hit can carry its own pan for width.
function synthGrittyHat(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ (p.open ? 0x6a7 : 0x6a8));
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * (p.metalScale ?? 1.6));
  const decay = p.decay ?? 0.04;
  const len = Math.round(Math.min(decay * 7, 1) * SR);
  const drive = p.drive ?? 2;
  const metal = p.metal ?? 0.35;
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const bp = new Svf(p.freq ?? 9000, p.q ?? 0.9);
    const hp = new Svf(p.hp ?? 6000, 0.7);
    const ph = freqs.map(() => rng());
    const dts = freqs.map((f) => f / SR);
    const [gl, gr] = panGains(ev.pan ?? 0);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      let m = 0;
      for (let k = 0; k < 6; k += 1) {
        ph[k] += dts[k];
        if (ph[k] >= 1) ph[k] -= 1;
        m += (ph[k] < 0.5 ? 1 : -1) + polyBlep(ph[k], dts[k]) - polyBlep((ph[k] + 0.5) % 1, dts[k]);
      }
      bp.lp(Math.tanh(drive * (rng() * 2 - 1)) * (1 - metal) + (m / 6) * metal);
      hp.lp(bp.bp);
      const s = hp.hp * Math.min(1, t / 0.0004) * Math.exp(-t / decay) * (1 - i / len) * ev.v * Math.SQRT2;
      track.L[idx] += s * gl;
      track.R[idx] += s * gr;
    }
  }
}

// Clanky metal hit: inharmonic partials (bar/plate ratios), ring modulation, a noise
// transient and saturation. Slight left/right detune gives it width.
function synthMetal(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x3e7a1);
  const ratios = p.ratios ?? [1, 1.593, 2.135, 2.295, 2.917, 3.598, 4.162];
  for (const ev of evs) {
    const base = ev.f ?? p.freq ?? 520;
    const decay = ev.decay ?? p.decay ?? 0.35;
    const len = Math.round(Math.min(decay * 6, 3) * SR);
    const start = Math.round(ev.t * SR);
    const parts = ratios
      .map((r, k) => ({ f: base * r, a: 1 / (1 + 0.45 * k), m: Math.exp(-1 / ((decay / (1 + 0.4 * k)) * SR)), e: 1, pr: rng() * TAU }))
      .filter((o) => o.f * 1.004 < 15000);
    const ring = p.ring ?? 0.4;
    const rf = base * (p.ringRatio ?? 2.71);
    const hl = new Svf(p.hp ?? 250, 0.7);
    const hr = new Svf(p.hp ?? 250, 0.7);
    const drive = p.drive ?? 1.8;
    const norm = Math.tanh(drive);
    const [gl, gr] = panGains(ev.pan ?? 0);
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const t = i / SR;
      let l = 0;
      let r = 0;
      for (const o of parts) {
        l += Math.sin(o.pr + TAU * o.f * t) * o.a * o.e;
        r += Math.sin(o.pr + TAU * o.f * 1.004 * t) * o.a * o.e;
        o.e *= o.m;
      }
      const rm = 1 - ring + ring * Math.sin(TAU * rf * t);
      const nz = (rng() * 2 - 1) * Math.exp(-t / 0.002) * 0.6;
      const atk = Math.min(1, t / 0.0005) * (1 - i / len);
      hl.lp(Math.tanh(drive * (l * rm * 0.4 + nz)) / norm);
      hr.lp(Math.tanh(drive * (r * rm * 0.4 + nz)) / norm);
      track.L[idx] += hl.hp * atk * ev.v * gl * Math.SQRT2;
      track.R[idx] += hr.hp * atk * ev.v * gr * Math.SQRT2;
    }
  }
}

// Downlifter impact: wide noise through a band-pass sweeping down from the top of the
// spectrum while it decays. Starts exactly on the cut.
function synthDownlifter(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0xd0a1);
  for (const ev of evs) {
    const dur = ev.dur ?? p.dur ?? 1.6;
    const len = Math.round(dur * SR);
    const start = Math.round(ev.t * SR);
    const bl = new Svf();
    const br = new Svf();
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const x = i / len;
      if ((i & 15) === 0) {
        const fc = (p.f0 ?? 6000) * ((p.f1 ?? 160) / (p.f0 ?? 6000)) ** (x ** 0.7);
        bl.set(fc, 1.4);
        br.set(fc * 1.05, 1.4);
      }
      const c = rng() * 2 - 1;
      bl.lp(c * 0.5 + (rng() * 2 - 1) * 0.5);
      br.lp(c * 0.5 + (rng() * 2 - 1) * 0.5);
      const e = Math.min(1, i / (0.002 * SR)) * Math.exp(-x * 3.2) * (1 - x) * ev.v;
      track.L[idx] += bl.bp * e;
      track.R[idx] += br.bp * e;
    }
  }
}

// Tape-style noise floor (pinkish, mostly common to both channels) for grit.
function synthHiss(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x4155);
  for (const ev of evs) {
    const start = Math.round(ev.t * SR);
    const len = Math.round(ev.dur * SR);
    const fade = Math.round(0.4 * SR);
    const pink = (w, s) => {
      s[0] = 0.99765 * s[0] + w * 0.099046;
      s[1] = 0.963 * s[1] + w * 0.2965164;
      s[2] = 0.57 * s[2] + w * 1.0526913;
      return s[0] + s[1] + s[2] + w * 0.1848;
    };
    const sl = [0, 0, 0];
    const sr = [0, 0, 0];
    for (let i = 0; i < len; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const common = rng() * 2 - 1;
      const e = Math.min(1, i / fade, (len - i) / fade) * ev.v * 0.05;
      track.L[idx] += pink(common * 0.7 + (rng() * 2 - 1) * 0.3, sl) * e;
      track.R[idx] += pink(common * 0.7 + (rng() * 2 - 1) * 0.3, sr) * e;
    }
  }
}

// Reversed-reverb swell: a short chord burst is rendered through the FDN reverb, reversed and
// placed so it builds into the cut and stops dead on it.
function synthRevReverb(track, evs, p, ctx) {
  const rng = makeRng(ctx.seed ^ 0x2e7e);
  for (const ev of evs) {
    const n = Math.round(ev.dur * SR);
    const skip = Math.round(0.012 * SR);
    const tmp = new Track(n + skip);
    const burst = Math.round(0.15 * SR);
    for (const m of ev.ms) {
      const dt = midiHz(m) / SR;
      let ph = rng();
      const lp = new Svf(p.burstCutoff ?? 2200, 0.8);
      for (let i = 0; i < burst && i < tmp.n; i += 1) {
        ph += dt;
        if (ph >= 1) ph -= 1;
        const s = lp.lp(2 * ph - 1 - polyBlep(ph, dt)) * Math.exp(-i / (0.05 * SR));
        tmp.L[i] += s;
        tmp.R[i] += s;
      }
    }
    const wet = fdnReverb(tmp, { rt60: p.rt60 ?? 3.2, size: 1.2, damp: p.damp ?? 4500, predelay: 0.004, width: 0.7 });
    const start = Math.round(ev.t * SR);
    const fadeEnd = Math.round(0.003 * SR);
    for (let i = 0; i < n; i += 1) {
      const idx = start + i;
      if (idx >= track.n) break;
      const src = skip + (n - 1 - i);
      const e = smoothstep(i / (0.3 * n)) * (i > n - fadeEnd ? (n - i) / fadeEnd : 1) * ev.v;
      track.L[idx] += wet.L[src] * e;
      track.R[idx] += wet.R[src] * e;
    }
  }
}

const SYNTHS = {
  supersaw: synthSupersaw, pluck: synthPluck, sub: synthSub, bell: synthBell, lead: synthLead, piano: synthPiano,
  kick: synthKick, clap: synthClap, snare: synthSnare, hat: synthHat, shaker: synthShaker, rim: synthRim, snap: synthSnap,
  crash: synthCrash, riser: synthRiser, swell: synthSwell, boom: synthBoom,
  technoKick: synthTechnoKick, driveBass: synthDriveBass, brass: synthBrass, eerie: synthEerie, grittyHat: synthGrittyHat,
  metal: synthMetal, downlifter: synthDownlifter, hiss: synthHiss, revverb: synthRevReverb
};

// ---------------------------------------------------------------------------------------------
// Arrangers

function eventBag() {
  const bag = {};
  const list = (name) => (bag[name] ||= []);
  return { bag, list };
}

// Piecewise-linear automation from per-section [start, end] values with short ramps at cuts.
function sectionAutomation(tl, style, key, fallback) {
  const points = [];
  const spans = [
    { id: "intro", start: 0, end: tl.sections[0].start },
    ...tl.sections.map((s) => ({ id: s.id, start: s.start, end: s.end })),
    { id: "outro", start: tl.cues.endCard, end: tl.cues.duration + 1 }
  ];
  for (const span of spans) {
    const v = style.sections[span.id]?.[key] ?? fallback;
    const [a, b] = Array.isArray(v) ? v : [v, v];
    points.push([span.start, a], [Math.max(span.start, span.end - 0.04), b]);
  }
  return (t) => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i += 1) {
      if (t <= points[i][0]) {
        const [t0, v0] = points[i - 1];
        const [t1, v1] = points[i];
        return t1 === t0 ? v1 : v0 * (v1 / v0) ** ((t - t0) / (t1 - t0));
      }
    }
    return points[points.length - 1][1];
  };
}

const BASS_PATTERNS = {
  offbeat8: [[0.5, 0.42, 0, 0.95], [1.5, 0.42, 0, 0.9], [2.5, 0.42, 0, 0.95], [3.5, 0.42, 0, 0.9]],
  roll8: [[0, 0.28, 0, 0.55], [0.5, 0.42, 0, 0.95], [1, 0.28, 0, 0.5], [1.5, 0.42, 0, 0.9], [2, 0.28, 0, 0.55], [2.5, 0.42, 0, 0.95], [3, 0.28, 0, 0.5], [3.5, 0.42, 12, 0.85]],
  drive8: [[0, 0.42, 0, 1], [0.5, 0.4, 0, 0.7], [1, 0.42, 0, 0.85], [1.5, 0.4, 12, 0.75], [2, 0.42, 0, 0.95], [2.5, 0.4, 0, 0.7], [3, 0.42, 0, 0.85], [3.5, 0.4, 12, 0.8]]
};

// Shared arranger for the two beat-driven candidates (A and C).
function arrangeElectronic(tl, ctx, style) {
  const { bag, list } = eventBag();
  const pad = new Legato(list("pad"));
  let padV = null;
  let bassPrev = style.bassStart;
  let bassFor = new Map();
  let arpStep = 0;
  for (const bar of tl.bars) {
    const sc = style.sections[bar.sec];
    if (!sc) continue;
    if (bar.j === 0) {
      arpStep = 0;
      bassFor = new Map();
    }
    const fill = sc.fill || { type: "none" };
    const fillBeats = bar.last && fill.type !== "none" ? (bar.beats < 4 ? bar.beats : fill.beats ?? 2) : 0;
    const fillFrom = bar.beats - fillBeats;
    const inFill = (b) => fillBeats > 0 && b >= fillFrom - 1e-9;
    const stopped = (b) => inFill(b) && fill.type === "stop";
    const dropKick = (b) => stopped(b) || (inFill(b) && fill.kick === false);

    if (bar.j === 0) {
      if (sc.crash) list("crash").push({ t: bar.start, v: sc.crash });
      if (sc.boom) list("boom").push({ t: bar.start, v: sc.boom });
      if (sc.riser) list("riser").push({ t: bar.secEnd - sc.riser * bar.spb, dur: sc.riser * bar.spb, v: 1 });
    }
    if (bar.last && (fill.swell || sc.swellBeats)) {
      const beats = sc.swellBeats ?? fillBeats;
      list("swell").push({ t: bar.end - beats * bar.spb, dur: beats * bar.spb, v: 1 });
    }

    // Harmony: pad and bass pitch per chord segment.
    for (const seg of bar.chords) {
      const t0 = bar.sec === "intro" && seg.b0 === 0 && bar.j === 0 ? 0 : at(bar, seg.b0);
      const t1 = at(bar, seg.b1);
      padV = voice(seg.chord, padV, style.padRange[0], style.padRange[1], style.padVoices ?? 4);
      if (sc.pad) pad.chord(t0, t1 - t0, padV, sc.pad);
      const bp = nearestPitch(seg.chord.bass, bassPrev, style.bassRange[0], style.bassRange[1]);
      bassFor.set(seg, bp);
      bassPrev = bp;
      if (sc.bass === "sustain") list("bass").push({ t: t0 < at(bar, seg.b0) ? at(bar, seg.b0) : t0, dur: (seg.b1 - seg.b0) * bar.spb - 0.03, m: bp, v: sc.bassV ?? 0.85 });
    }
    if (sc.bass && sc.bass !== "sustain") {
      for (const [pos, len, oct, vel] of BASS_PATTERNS[sc.bass]) {
        if (pos >= bar.beats - 1e-9 || dropKick(pos)) continue;
        const seg = chordAt(bar, pos);
        const dur = Math.min(len, seg.b1 - pos) * bar.spb * 0.97;
        list("bass").push({ t: at(bar, pos), dur, m: bassFor.get(seg) + oct, v: vel * (sc.bassV ?? 1) });
      }
    }

    // Arpeggio over the current chord's tones.
    if (sc.arp) {
      const step = sc.arp === 16 ? 0.25 : 0.5;
      for (let pos = 0; pos < bar.beats - 1e-9; pos += step) {
        if (stopped(pos)) continue;
        const seg = chordAt(bar, pos);
        const ladder = [];
        for (let m = style.arpRange[0]; m <= style.arpRange[1]; m += 1) if (seg.chord.pcs.includes(m % 12)) ladder.push(m);
        const idx = style.arpPattern[arpStep % style.arpPattern.length] % ladder.length;
        const frac = pos % 1;
        const accent = frac === 0 ? 1 : frac === 0.5 ? 0.8 : 0.62;
        const lift = inFill(pos) && fill.type !== "stop" ? 1 + 0.25 * ((pos - fillFrom) / Math.max(fillBeats, 1)) : 1;
        list("arp").push({ t: at(bar, pos), dur: step * bar.spb * 0.9, m: ladder[idx], v: sc.arp && (sc.arpV ?? 0.6) * accent * lift });
        arpStep += 1;
      }
    }

    // Drums.
    for (let b = 0; b < bar.beats; b += 1) {
      if (sc.kick && !dropKick(b)) list("kick").push({ t: at(bar, b), v: sc.kick * (b === 0 ? 1 : 0.94) });
      const clapBeat = sc.clapHalf ? b === 2 : b === 1 || b === 3;
      if (sc.clap && clapBeat && !inFill(b)) list("clap").push({ t: at(bar, b), v: sc.clap });
      if (sc.rim && b === 2 && !inFill(b)) list("rim").push({ t: at(bar, b), v: sc.rim });
      const hatsOn = sc.hats && bar.j >= (sc.hatsFromBar ?? 0) && !stopped(b);
      if (hatsOn) {
        if (sc.hats === "8off") {
          if (sc.openHat) list("openhat").push({ t: at(bar, b + 0.5), v: 0.6 });
          else list("hat").push({ t: at(bar, b + 0.5), v: 0.85 });
        } else {
          [0.34, 0.2, 0.9, 0.24].forEach((v, k) => {
            const pos = b + k * 0.25;
            if (k === 2 && sc.openHat) list("openhat").push({ t: at(bar, pos), v: 0.6 });
            else list("hat").push({ t: at(bar, pos + (k % 2 ? style.swing ?? 0 : 0)), v });
          });
        }
      }
      if (sc.shaker && !stopped(b)) {
        [0.55, 0.3, 0.75, 0.36].forEach((v, k) => list("shaker").push({ t: at(bar, b + k * 0.25 + (k % 2 ? style.swing ?? 0 : 0)), v: v * sc.shaker }));
      }
    }
    if (fillBeats && (fill.type === "snare8" || fill.type === "snare16")) {
      const step = fill.type === "snare16" ? 0.25 : 0.5;
      const count = Math.round(fillBeats / step);
      for (let k = 0; k < count; k += 1) list("snare").push({ t: at(bar, fillFrom + k * step), v: 0.22 + 0.72 * (k / Math.max(1, count - 1)) ** 1.6 });
    }
  }
  style.extras?.(tl, ctx, list);
  return bag;
}

// Arranger for the piano candidate (B).
function arrangePiano(tl, ctx, style) {
  const { bag, list } = eventBag();
  const rng = makeRng(ctx.seed ^ 0x77);
  const strings = new Legato(list("strings"));
  let rhPrev = null;
  let strPrev = null;
  let lhPrev = 50;
  let pulsePrev = 38;
  const jitter = () => (rng() - 0.5) * 0.01;
  const piano = list("piano");
  for (const bar of tl.bars) {
    const sc = style.sections[bar.sec];
    if (!sc || bar.sec === "outro") continue;
    const rhMode = sc.rhBars?.[bar.j] ?? sc.rh;
    for (const seg of bar.chords) {
      const t0 = at(bar, seg.b0);
      const t1 = at(bar, seg.b1);
      const rh = voice(seg.chord, rhPrev, 62, 79, 4);
      rhPrev = rh;
      // Triads get the lowest tone doubled an octave up so every pattern has four voices.
      if (rh.length < 4) rh.push(rh[0] + 12);
      const lh = nearestPitch(seg.chord.bass, lhPrev, 38, 50);
      lhPrev = lh;
      const pedal = t1 - t0 + 0.06;
      // Left hand: bass note (with octave in fuller sections) on the chord change.
      piano.push({ t: t0, dur: pedal, m: lh, v: sc.lhV ?? 0.5 });
      if (sc.lhOct && lh - 12 >= 33) piano.push({ t: t0 + 0.004, dur: pedal, m: lh - 12, v: (sc.lhV ?? 0.5) * 0.8 });
      // Right hand.
      const beats = seg.b1 - seg.b0;
      if (rhMode === "roll") {
        rh.forEach((m, k) => piano.push({ t: t0 + 0.035 * (k + 1), dur: pedal - 0.035 * (k + 1), m, v: (sc.rhV ?? 0.5) * (0.85 + 0.05 * k) }));
      } else {
        const step = rhMode === "eighths" ? 0.5 : rhMode === "quarters" ? 1 : 2;
        const pattern = rhMode === "eighths" ? [0, 2, 1, 3, 0, 2, 1, 2] : rhMode === "quarters" ? [0, 2, 1, 3] : [0, 2];
        const accents = rhMode === "eighths" ? [1, 0.74, 0.84, 0.78, 0.92, 0.74, 0.84, 0.76] : [1, 0.82, 0.9, 0.82];
        let k = 0;
        for (let pos = seg.b0; pos < seg.b1 - 1e-9; pos += step, k += 1) {
          // Chord changes stay on the grid; notes inside a chord get a few ms of human looseness.
          const t = at(bar, pos) + (pos === seg.b0 ? 0 : jitter());
          const v = (sc.rhV ?? 0.5) * accents[k % accents.length] * (0.94 + 0.12 * rng());
          if (rhMode === "halves") [rh[1], rh[3]].concat(k % 2 ? [] : [rh[0]]).forEach((m) => piano.push({ t, dur: t1 - t + 0.06, m, v }));
          else piano.push({ t, dur: Math.max(0.2, t1 - t + 0.06), m: rh[pattern[k % pattern.length]], v });
        }
      }
      if (sc.sparkle && seg.b0 === 0) piano.push({ t: t0 + 0.012, dur: pedal, m: rh[3] + 12, v: sc.sparkle });
      if (sc.strings) {
        strPrev = voice(seg.chord, strPrev, 55, 76, 4);
        strings.chord(bar.sec === "intro" && seg.b0 === 0 ? 0 : t0, t1 - (bar.sec === "intro" && seg.b0 === 0 ? 0 : t0), strPrev, sc.strings);
      }
      // Sub pulse on the bass note.
      if (sc.pulse) {
        const pp = nearestPitch(seg.chord.bass, pulsePrev, 31, 43);
        pulsePrev = pp;
        const step = sc.pulse === 8 ? 0.5 : 1;
        for (let pos = seg.b0; pos < seg.b1 - 1e-9; pos += step) {
          const onBeat = pos % 1 === 0;
          list("pulse").push({ t: at(bar, pos), dur: step * bar.spb * 0.8, m: pp, v: (sc.pulseV ?? 0.8) * (onBeat ? 1 : 0.72) });
        }
      }
    }
    for (let b = 0; b < bar.beats; b += 1) {
      if (sc.kick?.includes(b)) list("kick").push({ t: at(bar, b), v: sc.kickV ?? 0.8 });
      if (sc.rim?.includes(b)) list("rim").push({ t: at(bar, b), v: sc.rimV ?? 0.6 });
      if (sc.snap?.includes(b)) list("snap").push({ t: at(bar, b), v: sc.snapV ?? 0.6 });
      if (sc.shaker) {
        const steps = sc.shaker === 16 ? [0.5, 0.28, 0.7, 0.32] : [0.6, 0, 0.8, 0];
        steps.forEach((v, k) => v && list("shaker").push({ t: at(bar, b + k * 0.25 + (k % 2 ? 0.02 : 0)), v: v * (sc.shakerV ?? 0.6) }));
      }
    }
    // String swell and soft cymbal swell into the next chapter. The strings follow the harmony
    // inside the swell window (common tones tied) under one continuous crescendo.
    if (bar.last && sc.swell) {
      const tS = Math.max(bar.secStart, bar.secEnd - sc.swell * bar.spb);
      const swell = new Legato(list("swell"));
      let sv = null;
      for (const b of tl.bars) {
        if (b.sec !== bar.sec || b.end <= tS + 1e-6) continue;
        for (const seg of b.chords) {
          const s0 = Math.max(at(b, seg.b0), tS);
          const s1 = at(b, seg.b1);
          if (s1 <= s0 + 1e-6) continue;
          sv = voice(seg.chord, sv, 62, 81, 3);
          swell.chord(s0, s1 - s0, sv, 0.9, { a: 0.1, r: 0.5, ramp: [tS, bar.secEnd] });
        }
      }
      list("cymbal").push({ t: tS, dur: bar.secEnd - tS, v: 1 });
    }
  }
  style.extras?.(tl, ctx, list);
  return bag;
}

const TECHNO_BASS = {
  roll: [[0.25, 0.18, 0, 0.78], [0.5, 0.2, 0, 1], [0.75, 0.18, 0, 0.84]],
  gallop: [[0.5, 0.26, 0, 1], [0.75, 0.18, 0, 0.8]],
  pulse: [[0.5, 0.36, 0, 1]]
};

// Arranger for the dark techno candidates (D and E). Besides audio events it writes `marks`
// (stops, drops, lead-in/out) that feed the beat map for the picture re-edit.
function arrangeTechno(tl, ctx, style) {
  const { bag, list } = eventBag();
  const drone = new Legato(list("drone"));
  const brassPad = new Legato(list("brassPad"));
  const mark = (t, kind, v) => list("marks").push({ t, kind, v });
  const voicing = (chord) => style.voicings?.[chord.symbol] ?? voice(chord, null, style.stabRange[0], style.stabRange[1], 4);
  const firstChordAfter = (bar) => tl.bars.find((b) => b.i > bar.i && !b.gap && b.sec !== bar.sec)?.chords[0].chord ?? bar.chords[0].chord;
  let bassPrev = style.bassStart;
  let riffStep = 0;
  let riffPlayed = null;
  let endedWithStop = false;
  for (const bar of tl.bars) {
    const sc = style.sections[bar.sec];
    if (!sc) continue;
    const T = (b) => at(bar, b);
    if (bar.j === 0) {
      riffStep = 0;
      riffPlayed = null;
      const hit = Math.max(sc.crash ?? 0, sc.boom ?? 0, sc.downlifter ?? 0, sc.stab ?? 0);
      if (endedWithStop) mark(bar.start, "drop", 1);
      else if (hit) mark(bar.start, "impact", hit);
      endedWithStop = false;
      for (const k of ["crash", "boom", "downlifter"]) if (sc[k]) list(k).push({ t: bar.start, v: sc[k], ...(k === "downlifter" ? { dur: style.downlifterDur ?? 1.6 } : {}) });
      if (sc.stab) for (const m of voicing(bar.chords[0].chord)) list("stab").push({ t: bar.start, dur: (sc.stabBeats ?? 0.75) * bar.spb, m, v: sc.stab, dive: sc.stabDive });
      if (sc.riser) {
        const t0 = bar.secEnd - sc.riser * bar.spb;
        list("riser").push({ t: t0, dur: bar.secEnd - t0, v: 1 });
        mark(t0, "riser-start", 0.5);
        mark(bar.secEnd, "riser-end", 0.9);
      }
      if (sc.eerie) {
        const t0 = T(sc.eerie.beat ?? 0);
        const end = bar.secEnd - (sc.eerie.early ?? 0.08);
        list("eerie").push({ t: t0, dur: end - t0, m: sc.eerie.m, v: sc.eerie.v ?? 1, bend: sc.eerie.bend ?? 0 });
        mark(t0, "lead-in", 0.4);
        mark(end, "lead-out", 0.3);
      }
    }
    if (bar.gap) {
      endedWithStop = true;
      continue;
    }
    const on = (key) => {
      const v = sc[key];
      const only = sc[`${key}Bars`];
      if (!v || (only && !only.includes(bar.j))) return 0;
      // Numbers are levels; `true` or a pattern name just switches the element on.
      return typeof v === "number" ? v : 1;
    };
    const fill = sc.fill || { type: "none" };
    const fillBeats = bar.lastGrid && fill.type !== "none" ? Math.min(bar.beats, fill.beats ?? (bar.beats < 4 ? bar.beats : 2)) : 0;
    const fillFrom = bar.beats - fillBeats;
    const inFill = (b) => fillBeats > 0 && b >= fillFrom - 1e-9;
    const stopped = (b) => inFill(b) && fill.type === "stop";
    const hasGap = tl.bars[bar.i + 1]?.gap === true;

    if (bar.lastGrid) {
      const tFill = fillBeats ? T(fillFrom) : bar.end;
      if (fill.type === "stop") {
        mark(tFill, "stop", 0.8);
        endedWithStop = true;
      } else if (hasGap) mark(bar.end, "stop", 0.7);
      if (fill.swell && bar.secEnd - tFill > 0.05) list("swell").push({ t: tFill, dur: bar.secEnd - tFill, v: 1 });
      if (fill.rev) {
        // Builds from the start of the fill (or of the free-time stop) into the cut.
        const t0 = fill.revBeats ? bar.secEnd - fill.revBeats * bar.spb : tFill;
        list("revverb").push({ t: t0, dur: bar.secEnd - t0, ms: voicing(firstChordAfter(bar)), v: 1 });
      }
      if (fill.dive) for (const m of voicing(chordAt(bar, fillFrom).chord)) list("stab").push({ t: tFill, dur: fillBeats * bar.spb * 0.9, m, v: fill.dive, dive: 12, diveAt: 0.06, diveTime: fillBeats * bar.spb * 0.8 });
    }

    // Harmony beds: low drone (power voicing) and sustained brass chords.
    for (const seg of bar.chords) {
      const t0 = bar.sec === "intro" && seg.b0 === 0 ? 0 : T(seg.b0);
      const t1 = T(seg.b1);
      const root = nearestPitch(seg.chord.root, style.droneRange[0] + 5, style.droneRange[0], style.droneRange[1]);
      if (on("drone")) drone.chord(t0, t1 - t0, [root, root + 7, root + 12], on("drone"));
      if (on("brassPad") && !stopped(seg.b0)) {
        const end = fillBeats && seg.b1 > fillFrom && fill.type === "stop" ? T(fillFrom) : t1;
        if (end > t0 + 0.05) brassPad.chord(t0, end - t0, voicing(seg.chord), on("brassPad"));
      }
    }

    // Bass.
    const bassKind = sc.bassBars?.[bar.j] ?? sc.bass;
    if (bassKind === "hold") {
      for (const seg of bar.chords) {
        const pos = seg.b0;
        if (stopped(pos) || (inFill(pos) && fill.bass === false)) continue;
        const root = nearestPitch(seg.chord.bass, bassPrev, style.bassRange[0], style.bassRange[1]);
        bassPrev = root;
        const end = fillBeats && fill.bass === false ? Math.min(seg.b1, fillFrom) : seg.b1;
        if (end > pos) list("bass").push({ t: T(pos), dur: (end - pos) * bar.spb - 0.02, m: root, v: sc.bassV ?? 1, crush: sc.crushBars?.includes(bar.j) ? sc.crush ?? 0.4 : 0 });
      }
    } else if (bassKind) {
      for (let b = 0; b < Math.ceil(bar.beats - 1e-9); b += 1) {
        const turn = style.bassTurn && sc.turn !== false && bar.j % 2 === 1 && b === 3;
        for (const [off, len, semi, vel] of turn ? style.bassTurn : TECHNO_BASS[bassKind]) {
          const pos = b + off;
          if (pos >= bar.beats - 1e-9 || stopped(pos) || (inFill(pos) && fill.bass === false)) continue;
          const seg = chordAt(bar, pos);
          const root = nearestPitch(seg.chord.bass, bassPrev, style.bassRange[0], style.bassRange[1]);
          list("bass").push({ t: T(pos), dur: len * bar.spb, m: root + semi, v: vel * (sc.bassV ?? 1), crush: sc.crushBars?.includes(bar.j) ? sc.crush ?? 0.4 : 0 });
        }
        bassPrev = nearestPitch(chordAt(bar, b).chord.bass, bassPrev, style.bassRange[0], style.bassRange[1]);
      }
    }

    // Drums and percussion.
    let hatSide = 1;
    for (let b = 0; b < bar.beats - 1e-9; b += 1) {
      const kick = on("kick");
      if (kick && !stopped(b) && !(inFill(b) && fill.kick !== true)) {
        list("kick").push({ t: T(b), v: kick });
        if (b === 0) mark(T(b), "kick-accent", bar.j === 0 ? 0.8 : 0.5);
      }
      if (on("clap") && (b === 1 || b === 3) && !inFill(b)) {
        list("clap").push({ t: T(b), v: on("clap") });
        if (style.clapLayer) list("clapmetal").push({ t: T(b), f: style.clapLayer.f, decay: style.clapLayer.decay, pan: 0, v: style.clapLayer.v * on("clap") });
        mark(T(b), "clap", 0.6 * on("clap"));
      }
      const hats = on("hats") ? sc.hats : null;
      if (hats && !stopped(b)) {
        const steps = hats === "16" ? style.hat16 : hats === "tick" ? [0, 0, 0.8, 0] : [0, 0, 1, 0];
        steps.forEach((v, k) => {
          const pos = b + k * 0.25;
          if (!v || pos >= bar.beats - 1e-9 || stopped(pos)) return;
          if (k === 2 && on("openHat")) list("openhat").push({ t: T(pos), v: 0.8 * on("openHat"), pan: 0 });
          else {
            hatSide = -hatSide;
            list(hats === "tick" ? "tick" : "hat").push({ t: T(pos), v, pan: k % 2 ? 0.28 * hatSide : 0.08 * hatSide });
          }
        });
      }
    }
    if (on("metal")) {
      for (const [parity, beat, f, decay, pan, v] of style.metalPattern) {
        if (bar.j % 2 !== parity || beat >= bar.beats - 1e-9 || stopped(beat) || inFill(beat)) continue;
        list("metal").push({ t: T(beat), f, decay, pan, v: v * on("metal") });
      }
    }
    const stabs = on("stabs") ? style.stabPatterns[sc.stabs] : null;
    if (stabs) {
      for (const [parity, beat, len, key, v, dive] of stabs) {
        if (bar.j % 2 !== parity || beat >= bar.beats - 1e-9 || inFill(beat) || (bar.j === 0 && beat === 0 && sc.stab)) continue;
        const ms = key ? style.voicings[key] : voicing(chordAt(bar, beat).chord);
        for (const m of ms) list("stab").push({ t: T(beat), dur: len * bar.spb, m, v: v * on("stabs"), dive });
        mark(T(beat), "stab", v * on("stabs"));
      }
    }
    if (fillBeats && ["snare8", "snare16", "roll"].includes(fill.type)) {
      const step = fill.type === "snare8" ? 0.5 : 0.25;
      const count = Math.round(fillBeats / step);
      for (let k = 0; k < count; k += 1) list("snare").push({ t: T(fillFrom + k * step), v: 0.25 + 0.7 * (k / Math.max(1, count - 1)) ** 1.5 });
      if (fill.type === "roll") for (let k = 0; k < 4; k += 1) list("snare").push({ t: T(bar.beats - 1 + 0.125 + k * 0.25), v: 0.8 + 0.05 * k });
    }

    // Riff lead over the home chord only, alternating its two bars.
    if (on("riff") && bar.chords[0].chord.root === style.riffRoot) {
      const notes = style.riff[riffStep % style.riff.length];
      riffStep += 1;
      for (const [beat, len, m, from] of notes) {
        if (beat >= bar.beats - 1e-9 || inFill(beat)) continue;
        const t = T(beat);
        list("lead").push({ t, dur: len * bar.spb, m, from, v: on("riff") });
        if (!riffPlayed) mark(t, "lead-in", 0.7);
        riffPlayed = t + len * bar.spb;
      }
      const nextBar = tl.bars[bar.i + 1];
      const continues = nextBar && nextBar.sec === bar.sec && !nextBar.gap && on("riff") && nextBar.chords[0].chord.root === style.riffRoot && !(sc.riffBars && !sc.riffBars.includes(nextBar.j));
      if (!continues && riffPlayed) {
        mark(riffPlayed, "lead-out", 0.5);
        riffPlayed = null;
      }
    }
  }
  style.extras?.(tl, ctx, list, mark);
  return bag;
}

// Machine-readable beat map for re-cutting the picture to the music. Times are seconds,
// rounded to whole samples.
export function buildBeatMap(preset, tl, events, cues) {
  const q = (t) => +(Math.round(t * SR) / SR).toFixed(6);
  const grid = tl.bars.filter((b) => !b.gap && b.start < cues.duration);
  const tempoMap = [];
  for (const bar of tl.bars) {
    if (bar.start >= cues.duration) break;
    const bpm = bar.gap ? null : +(60 / bar.spb).toFixed(3);
    const last = tempoMap[tempoMap.length - 1];
    if (!last || last.bpm !== bpm) tempoMap.push({ time: q(bar.start), bpm, ...(bar.gap ? { stop: true } : {}) });
  }
  // Before the title card's pickup bar the drone plays in free time.
  if (tempoMap[0].time > 0) tempoMap.unshift({ time: 0, bpm: null, preroll: true });
  const beats = [];
  for (const bar of grid) for (let b = 0; b < bar.beats - 1e-9; b += 1) if (at(bar, b) < cues.duration) beats.push(q(at(bar, b)));
  const energyOf = (id) => preset.style.sections[id]?.energy ?? null;
  const sections = [
    { name: "title", start: 0, end: q(tl.sections[0].start), energy: energyOf("intro") },
    ...tl.sections.map((s) => ({ name: s.id, start: q(s.start), end: q(s.end), energy: energyOf(s.id), bpm: +s.bpm.toFixed(3), ...(s.gap ? { stopSeconds: +s.gap.toFixed(3) } : {}) })),
    { name: "end-card", start: q(cues.endCard), end: q(cues.duration), energy: energyOf("outro") }
  ];
  const hits = new Map();
  const add = (t, kind, strength) => {
    const key = `${q(t)}|${kind}`;
    const s = +Math.min(1, Math.max(0, strength)).toFixed(2);
    if (!hits.has(key) || hits.get(key).strength < s) hits.set(key, { time: q(t), kind, strength: s });
  };
  for (const e of events.marks || []) add(e.t, e.kind, e.v);
  for (const k of ["crash", "boom", "downlifter"]) for (const e of events[k] || []) add(e.t, "impact", Math.max(0.6, e.v));
  for (const e of [...(events.stab || []), ...(events.stabEnd || [])]) add(e.t, "stab", e.v);
  return {
    candidate: preset.id,
    name: preset.name,
    sampleRate: SR,
    durationSeconds: cues.duration,
    notes: "Times in seconds, rounded to whole samples at 48 kHz. Chapter cuts sit on downbeats. tempoMap entries with bpm null are free-time stops (no beat grid) that end exactly on the next cut.",
    tempoMap,
    beats,
    bars: grid.map((b) => q(b.start)),
    sections,
    hits: [...hits.values()].sort((a, b) => a.time - b.time || a.kind.localeCompare(b.kind))
  };
}

// ---------------------------------------------------------------------------------------------
// Presets

const byId = (tl, id) => tl.bars.filter((b) => b.sec === id);

const PRESET_A = {
  id: "A",
  name: "Warm electronic",
  seed: 0xa11ce,
  nominalBpm: 114,
  key: "F major (vi-led, D minor colour)",
  feel: "Soft four-on-the-floor with warm detuned supersaw pads, a plucked arpeggio, round sub and gentle kick-keyed pumping.",
  form: {
    intro: { bars: [4], chords: ["Fadd9 Fadd9 Csus4 C"] },
    sections: [
      { id: "find", bars: [4, 4, 4, 2], chords: ["Dm7", "Bbmaj7", "F", "Csus4 C"] },
      { id: "disk", bars: [4, 4, 2], chords: ["Dm7", "Bbmaj7", "C"] },
      { id: "transfer", bars: [4, 4, 4, 4, 1], chords: ["Dm7", "Bbmaj7", "F", "C", "C"] },
      { id: "safety", bars: [4, 4, 4, 2], chords: ["Bbmaj7", "F/A", "Gm7", "Csus4 C"] },
      { id: "terminal", bars: [4, 4, 4, 3], chords: ["Dm7", "Bbmaj7", "F", "C"] },
      { id: "ai", bars: [4, 4, 4], chords: ["Dm7", "Bbmaj7", "F F C C"] },
      { id: "scope", bars: [4, 4, 4, 2], chords: ["Dm7", "Gm7", "Bbmaj7", "Csus4 C"] }
    ],
    outro: { bars: [4, 4], chords: ["Fadd9", "Fadd9"] }
  },
  arranger: arrangeElectronic,
  style: {
    padRange: [53, 76],
    bassRange: [31, 42],
    bassStart: 38,
    arpRange: [65, 86],
    arpPattern: [0, 2, 1, 3, 2, 4, 3, 1],
    swing: 0.035,
    sections: {
      intro: { pad: 0.55, cutoff: [650, 1500], fill: { type: "none" }, swellBeats: 2 },
      find: { pad: 0.6, cutoff: [1500, 1900], bass: "sustain", bassV: 0.5, kick: 0.74, hats: "8off", hatsFromBar: 1, shaker: 0.5, arp: 8, arpV: 0.5, crash: 0.45, fill: { type: "snare8", kick: true, swell: true } },
      disk: { pad: 0.74, cutoff: [1900, 2400], bass: "offbeat8", kick: 0.86, clap: 0.8, hats: "8off", shaker: 0.7, arp: 8, arpV: 0.6, fill: { type: "snare16", kick: false }, riser: 6 },
      transfer: { pad: 0.88, cutoff: [2700, 3300], bass: "roll8", kick: 1, clap: 0.9, hats: "16", openHat: true, shaker: 0.8, arp: 16, arpV: 0.62, crash: 1, boom: 1, fill: { type: "stop", swell: true } },
      safety: { pad: 0.74, cutoff: [1100, 2100], bass: "sustain", bassV: 0.42, rim: 0.7, shaker: 0.45, arp: 8, arpV: 0.45, crash: 0.55, fill: { type: "snare8", kick: false }, riser: 6 },
      terminal: { pad: 0.8, cutoff: [2000, 2700], bass: "offbeat8", kick: 0.9, clap: 0.85, hats: "8off", shaker: 0.75, arp: 16, arpV: 0.56, crash: 0.7, boom: 0.6, fill: { type: "snare16", kick: false, swell: true }, riser: 7 },
      ai: { pad: 0.94, cutoff: [3000, 3500], bass: "roll8", kick: 1, clap: 0.95, hats: "16", openHat: true, shaker: 0.8, arp: 16, arpV: 0.64, crash: 1, boom: 1, fill: { type: "snare16", kick: false, swell: true } },
      scope: { pad: 0.84, cutoff: [2600, 2000], bass: "offbeat8", kick: 0.9, clap: 0.85, hats: "8off", shaker: 0.7, arp: 8, arpV: 0.56, crash: 0.8, fill: { type: "snare8", kick: false, swell: true }, riser: 6 },
      outro: { cutoff: [1900, 700] }
    },
    extras(tl2, ctx2, list) {
      const intro = byId(tl2, "intro")[0];
      // Title: a three-note bell figure that settles on F, the third of Dm7, at the first cut.
      [[0, 81, 1], [1, 84, 1.5], [2.5, 79, 1.5]].forEach(([b, m, d]) => list("bell").push({ t: at(intro, b), dur: d * intro.spb, m, v: 0.42 }));
      list("bell").push({ t: tl2.sections[0].start, dur: 2 * intro.spb, m: 77, v: 0.5 });
      // A slow counter-line, one long tone per bar, only in the two peak chapters.
      const lines = { transfer: [81, 86, 84, 79], ai: [81, 86, 84] };
      for (const [id, notes] of Object.entries(lines)) byId(tl2, id).slice(0, notes.length).forEach((bar, k) => list("bell").push({ t: bar.start, dur: 2 * bar.spb, m: notes[k], v: 0.5 }));
      // Ending: IV-V resolves to Fadd9 on the end card; everything decays by the last frame.
      const end = tl2.cues.endCard;
      const spb = tl2.sections[tl2.sections.length - 1].spb;
      list("kick").push({ t: end, v: 0.95 });
      list("crash").push({ t: end, v: 0.8 });
      list("boom").push({ t: end, v: 0.9 });
      list("bass").push({ t: end, dur: 1.5, m: 41, v: 0.85 });
      [53, 57, 60, 67, 72].forEach((m) => list("padEnd").push({ t: end, dur: 1.45, m, v: 0.8 }));
      [65, 69, 72, 79].forEach((m, k) => list("arp").push({ t: end + k * spb * 0.5, dur: spb * 0.45, m, v: 0.62 - k * 0.07 }));
      list("bell").push({ t: end, dur: 1.2, m: 84, v: 0.5 });
      list("bell").push({ t: end + 2 * spb, dur: 1.0, m: 81, v: 0.34 });
    }
  },
  parts: {
    pad: { synth: "supersaw", level: -19, cutoff: true, params: { voices: 7, detune: 15, width: 0.85, attack: 0.16, decay: 1.4, sustain: 0.85, release: 0.7, q: 0.8, lfoRate: 0.11, lfoDepth: 0.16, keyTrack: 0.25 }, eq: [...butter4("hp", 170), ["peak", 2600, 1, -1.5], ["peak", 380, 1, -1.5]], chorus: { mix: 0.35 }, duck: 0.42, reverb: -9 },
    padEnd: { synth: "supersaw", level: -20, params: { voices: 7, detune: 15, width: 0.85, attack: 0.05, decay: 1.6, sustain: 0.7, release: 1.1, q: 0.8, cutoff: 1500, lfoRate: 0.11, lfoDepth: 0.1, keyTrack: 0.25 }, eq: [...butter4("hp", 150), ["peak", 2600, 1, -1.5]], chorus: { mix: 0.35 }, reverb: -8 },
    arp: { synth: "pluck", level: -23.5, params: { detune: 8, sub: 0.2, decay: 0.2, release: 0.08, cutoff: 650, envAmt: 3000, fdecay: 0.09, q: 1.1 }, eq: [["hp", 280, 0.7], ["highshelf", 7000, 0.7, -3]], duck: 0.22, delay: -5, reverb: -11 },
    bell: { synth: "bell", level: -26, params: { ratio: 2, index: 1.5, indexDecay: 0.25, decay: 1.3, release: 0.7, detune: 6, octave: 0.12 }, eq: [["hp", 400, 0.7], ["highshelf", 6500, 0.7, -4]], delay: -9, reverb: -5 },
    bass: { synth: "sub", level: -17, params: { h2: 0.18, h3: 0.05, drive: 1.3, attack: 0.006, decay: 2, sustain: 0.85, release: 0.07, saw: 0.22, sawCut: 380, sawEnv: 450, sawEnvDecay: 0.09 }, eq: [["lp", 1400, 0.7], ...butter4("hp", 34)], duck: 0.5 },
    kick: { synth: "kick", level: -16, bus: "drums", params: { f0: 125, f1: 50, pitchTau: 0.042, ampTau: 0.2, click: 0.07, drive: 1.3, length: 0.42 }, eq: [...butter4("hp", 32), ["lp", 9000, 0.7]] },
    clap: { synth: "clap", level: -24, bus: "drums", params: { freq: 1250, tail: 0.1 }, eq: [["hp", 350, 0.7], ["highshelf", 8000, 0.7, -3]], reverb: -8 },
    snare: { synth: "snare", level: -25, bus: "drums", params: { body: 200, tail: 0.1 }, eq: [["hp", 150, 0.7]], reverb: -9 },
    hat: { synth: "hat", level: -28.5, bus: "drums", params: { freq: 8000, decay: 0.028 }, eq: [["lp", 11000, 0.7]], pan: 0.15 },
    openhat: { synth: "hat", level: -30, bus: "drums", params: { freq: 7600, decay: 0.16, open: true }, eq: [["lp", 10500, 0.7]], pan: -0.12 },
    shaker: { synth: "shaker", level: -31, bus: "drums", params: { freq: 5800 }, eq: [["lp", 10000, 0.7]], pan: -0.2, reverb: -14 },
    rim: { synth: "rim", level: -27, bus: "drums", reverb: -7, pan: 0.1 },
    crash: { synth: "crash", peak: -19, bus: "drums", params: { decay: 1.0 }, eq: [["lp", 8500, 0.7]], reverb: -12 },
    boom: { synth: "boom", peak: -10 },
    riser: { synth: "riser", peak: -19, params: { f0: 350, f1: 6000 }, reverb: -8 },
    swell: { synth: "swell", peak: -21, eq: [["lp", 9000, 0.7]], reverb: -10 }
  },
  reverb: { rt60: 2.3, size: 1, damp: 5500, predelay: 0.022, width: 0.6, level: -23, eq: [["hp", 260, 0.7], ["lp", 7500, 0.7]], duck: 0.3 },
  delay: { beats: 0.75, feedback: 0.34, lp: 3200, hp: 450, level: -28 },
  masterEq: [["highshelf", 3000, 0.7, 3.5]],
  drumBus: { threshold: -17, ratio: 2.5, attack: 0.012, release: 0.12, knee: 6 },
  duck: { release: 0.28 }
};

const PRESET_B = {
  id: "B",
  name: "Minimal piano + pulse",
  seed: 0xb0b,
  nominalBpm: 99,
  key: "D major",
  feel: "Synthesized piano ostinato over a soft sub pulse, light textural percussion and string swells into each chapter.",
  form: {
    intro: { bars: [4], chords: ["Gmaj7 Asus4"] },
    sections: [
      { id: "find", bars: [4, 4, 4], chords: ["Dmaj7", "A/C#", "Bm7"] },
      { id: "disk", bars: [4, 4, 1], chords: ["Gmaj7", "D/F#", "Asus4"] },
      { id: "transfer", bars: [4, 4, 4, 3], chords: ["Bm7", "Gmaj7", "D/F#", "Em7 Asus4 A"] },
      { id: "safety", bars: [4, 4, 4], chords: ["Gmaj7", "D/F#", "Em7 A"] },
      { id: "terminal", bars: [4, 4, 4, 1], chords: ["Bm7", "Gmaj7", "Asus4", "A"] },
      { id: "ai", bars: [4, 4, 2], chords: ["Dmaj7", "A/C#", "Bm7"] },
      { id: "scope", bars: [4, 4, 4], chords: ["Gmaj7", "Em7", "Asus4 A"] }
    ],
    outro: { bars: [4, 4], chords: ["Dadd9", "Dadd9"] }
  },
  arranger: arrangePiano,
  style: {
    sections: {
      intro: { rh: "roll", rhV: 0.3, lhV: 0.3, strings: 0.22, swell: 2 },
      find: { rh: "eighths", rhV: 0.42, lhV: 0.48, strings: 0.3, pulse: 8, pulseV: 0.62, shaker: 8, shakerV: 0.45 },
      disk: { rh: "eighths", rhV: 0.46, lhV: 0.52, strings: 0.38, pulse: 8, pulseV: 0.72, shaker: 8, shakerV: 0.6, rim: [1, 3], rimV: 0.5, swell: 3 },
      transfer: { rh: "eighths", rhV: 0.55, lhV: 0.58, lhOct: true, strings: 0.52, pulse: 8, pulseV: 0.9, kick: [0, 2], kickV: 0.8, shaker: 16, shakerV: 0.6, rim: [1, 3], rimV: 0.55, sparkle: 0.3, swell: 3 },
      safety: { rh: "quarters", rhV: 0.4, lhV: 0.46, strings: 0.5, pulse: 4, pulseV: 0.5, shaker: 8, shakerV: 0.35, swell: 2 },
      terminal: { rh: "eighths", rhV: 0.48, lhV: 0.54, strings: 0.46, pulse: 8, pulseV: 0.82, kick: [0, 2], kickV: 0.75, shaker: 16, shakerV: 0.55, rim: [1, 3], rimV: 0.5, swell: 3 },
      ai: { rh: "eighths", rhV: 0.56, lhV: 0.6, lhOct: true, strings: 0.56, pulse: 8, pulseV: 0.92, kick: [0, 2], kickV: 0.85, snap: [1, 3], snapV: 0.6, shaker: 16, shakerV: 0.62, sparkle: 0.3, swell: 2 },
      scope: { rh: "eighths", rhBars: { 2: "halves" }, rhV: 0.48, lhV: 0.52, strings: 0.46, pulse: 8, pulseV: 0.72, kick: [0, 2], kickV: 0.6, shaker: 8, shakerV: 0.5, swell: 4 }
    },
    extras(tl2, ctx2, list) {
      const intro = byId(tl2, "intro")[0];
      // Title: a soft rising answer over Asus4 that lands on F#5 (third of D) at the first cut.
      [[2, 76, 1], [3, 78, 1.2]].forEach(([b, m, d]) => list("piano").push({ t: at(intro, b), dur: d * intro.spb, m, v: 0.3 }));
      // Ending: rolled Dadd9 with a high D, low D pulse and strings resolving on the end card.
      const end = tl2.cues.endCard;
      list("piano").push({ t: end, dur: 2.3, m: 38, v: 0.55 }, { t: end + 0.004, dur: 2.3, m: 50, v: 0.42 });
      [57, 62, 64, 66, 69, 74].forEach((m, k) => list("piano").push({ t: end + 0.03 * (k + 1), dur: 2.3, m, v: 0.44 + 0.02 * k }));
      list("piano").push({ t: end + 1.25, dur: 1.6, m: 78, v: 0.3 });
      list("pulse").push({ t: end, dur: 1.4, m: 38, v: 0.85 });
      list("kick").push({ t: end, v: 0.7 });
      [57, 62, 66, 69, 76].forEach((m) => list("stringsEnd").push({ t: end, dur: 1.2, m, v: 0.6 }));
    }
  },
  parts: {
    piano: { synth: "piano", level: -16, params: { strike: 0.118, maxLen: 6 }, eq: [...butter4("hp", 45), ["peak", 240, 0.8, 1.2], ["highshelf", 9000, 0.7, -1.5]], reverb: -3, pan: 0 },
    strings: { synth: "supersaw", level: -22, params: { voices: 6, detune: 9, width: 0.9, attack: 0.9, decay: 2, sustain: 0.9, release: 1.2, q: 0.6, cutoff: 2200, lfoRate: 0.07, lfoDepth: 0.12, vibCents: 7, vibRate: 5.2, vibDelay: 0.4, keyTrack: 0.4 }, eq: [...butter4("hp", 230), ["peak", 350, 1, -2], ["peak", 3000, 1, -1.5], ["highshelf", 7000, 0.7, -2]], chorus: { mix: 0.4, rate: 0.25 }, reverb: -4 },
    stringsEnd: { synth: "supersaw", level: -22, params: { voices: 6, detune: 9, width: 0.9, attack: 0.25, decay: 2, sustain: 0.9, release: 1.5, q: 0.6, cutoff: 2000, lfoRate: 0.07, lfoDepth: 0.1, vibCents: 7, vibRate: 5.2, vibDelay: 0.4, keyTrack: 0.4 }, eq: [...butter4("hp", 230), ["peak", 350, 1, -2], ["peak", 3000, 1, -1.5], ["highshelf", 7000, 0.7, -2]], chorus: { mix: 0.4, rate: 0.25 }, reverb: -4 },
    swell: { synth: "supersaw", level: -24, params: { voices: 6, detune: 10, width: 0.9, attack: 1, decay: 2, sustain: 1, release: 0.5, q: 0.6, cutoff: 2600, vibCents: 8, vibRate: 5.4, vibDelay: 0.2, keyTrack: 0.4 }, eq: [...butter4("hp", 280), ["highshelf", 7000, 0.7, -4]], chorus: { mix: 0.4, rate: 0.25 }, reverb: -3 },
    pulse: { synth: "sub", level: -19, params: { h2: 0.22, h3: 0.06, drive: 1.2, attack: 0.012, decay: 0.16, sustain: 0.15, release: 0.08 }, eq: [["lp", 700, 0.7], ...butter4("hp", 34)] },
    kick: { synth: "kick", level: -22, bus: "drums", params: { f0: 105, f1: 52, pitchTau: 0.035, ampTau: 0.16, click: 0.02, drive: 1.1, length: 0.38 }, eq: [...butter4("hp", 34), ["lp", 4000, 0.7]] },
    rim: { synth: "rim", level: -29, bus: "drums", params: { freq: 1500, low: 480 }, eq: [["highshelf", 6000, 0.7, -3]], reverb: -6, pan: 0.12 },
    snap: { synth: "snap", level: -27, bus: "drums", eq: [["highshelf", 7000, 0.7, -3]], reverb: -6, pan: -0.1 },
    shaker: { synth: "shaker", level: -32, bus: "drums", params: { freq: 5200, decay: 0.03 }, eq: [["lp", 9500, 0.7]], reverb: -12, pan: 0.22 },
    cymbal: { synth: "swell", peak: -27, params: { hp: 3500, lp: 8500 }, reverb: -8 }
  },
  reverb: { rt60: 2.6, size: 1.15, damp: 5000, predelay: 0.025, width: 0.6, level: -20, eq: [["hp", 220, 0.7], ["lp", 7000, 0.7]] },
  delay: null,
  masterEq: [["highshelf", 2500, 0.7, 3]],
  drumBus: { threshold: -20, ratio: 2, attack: 0.015, release: 0.15, knee: 6 },
  duck: { release: 0.3 }
};

const PRESET_C = {
  id: "C",
  name: "Upbeat synth-pop",
  seed: 0xc0ffee,
  nominalBpm: 123,
  key: "G major",
  feel: "Punchy kick and clap, driving eighth-note bass, gated arpeggio and a short hook heard only at the title and on the end card.",
  form: {
    intro: { bars: [4], chords: ["Cadd9 D"] },
    sections: [
      { id: "find", bars: [4, 4, 4, 3], chords: ["G", "D/F#", "Em7", "Cadd9"] },
      { id: "disk", bars: [4, 4, 3], chords: ["G/B", "Cadd9", "Dsus4 D D"] },
      { id: "transfer", bars: [4, 4, 4, 4, 2], chords: ["Em7", "Cadd9", "G", "D", "Dsus4 D"] },
      { id: "safety", bars: [4, 4, 4, 3], chords: ["Cadd9", "G/B", "Am7", "D"] },
      { id: "terminal", bars: [4, 4, 4, 4], chords: ["Em7", "Cadd9", "G", "D"] },
      { id: "ai", bars: [4, 4, 4, 1], chords: ["G", "D/F#", "Cadd9", "D"] },
      { id: "scope", bars: [4, 4, 4, 3], chords: ["Em7", "Am7", "Cadd9", "D"] }
    ],
    outro: { bars: [4, 4], chords: ["G", "G"] }
  },
  arranger: arrangeElectronic,
  style: {
    padRange: [55, 76],
    bassRange: [31, 43],
    bassStart: 36,
    arpRange: [67, 88],
    arpPattern: [0, 1, 2, 0, 3, 2, 1, 2],
    swing: 0,
    sections: {
      intro: { pad: 0.4, cutoff: [800, 1700], fill: { type: "none" }, swellBeats: 2 },
      find: { pad: 0.52, cutoff: [1800, 2200], bass: "drive8", bassV: 0.7, kick: 0.8, clap: 0.72, hats: "8off", arp: 16, arpV: 0.46, crash: 0.7, fill: { type: "snare8", kick: true } },
      disk: { pad: 0.62, cutoff: [2200, 2600], bass: "drive8", kick: 0.95, clap: 0.85, hats: "16", arp: 16, arpV: 0.55, fill: { type: "snare16", kick: false, swell: true }, riser: 7 },
      transfer: { pad: 0.78, cutoff: [3000, 3700], bass: "drive8", kick: 1, clap: 1, hats: "16", openHat: true, arp: 16, arpV: 0.64, crash: 1, boom: 0.8, fill: { type: "snare16", kick: false, swell: true }, riser: 6 },
      safety: { pad: 0.68, cutoff: [1200, 2200], bass: "sustain", bassV: 0.42, clap: 0.5, clapHalf: true, shaker: 0.45, arp: 8, arpV: 0.42, crash: 0.6, fill: { type: "snare8", kick: false }, riser: 7 },
      terminal: { pad: 0.68, cutoff: [2200, 2900], bass: "drive8", kick: 0.95, clap: 0.9, hats: "8off", arp: 16, arpV: 0.56, crash: 0.7, fill: { type: "snare16", kick: false, swell: true }, riser: 8 },
      ai: { pad: 0.84, cutoff: [3200, 3800], bass: "drive8", kick: 1, clap: 1, hats: "16", openHat: true, arp: 16, arpV: 0.66, crash: 1, boom: 0.9, fill: { type: "stop", swell: true } },
      scope: { pad: 0.72, cutoff: [2600, 2000], bass: "drive8", kick: 0.95, clap: 0.9, hats: "8off", arp: 8, arpV: 0.5, crash: 0.8, fill: { type: "snare8", kick: false, swell: true }, riser: 7 },
      outro: { cutoff: [1900, 800] }
    },
    extras(tl2, ctx2, list) {
      // Hook at the title: D | G . . F# E . D A | resolves to G on the first cut.
      const intro = byId(tl2, "intro")[0];
      const hook = [[-0.5, 74, 0.5], [0, 79, 1.5], [1.5, 78, 0.5], [2, 76, 1], [3, 74, 0.5], [3.5, 69, 0.5], [4, 67, 1.6]];
      for (const [b, m, d] of hook) {
        const t = at(intro, b);
        list("lead").push({ t, dur: d * intro.spb * 0.92, m, v: b === 4 ? 0.5 : 0.6 });
      }
      // Reprise: the same contour in diminution over the final D bar, landing G on the end card.
      const scope = byId(tl2, "scope");
      const lastBar = scope[scope.length - 1];
      const reprise = [[0, 79, 1], [1, 78, 0.5], [1.5, 76, 0.5], [2, 74, 0.5], [2.5, 69, 0.5]];
      for (const [b, m, d] of reprise) list("lead").push({ t: at(lastBar, b), dur: d * lastBar.spb * 0.92, m, v: 0.7 });
      const end = tl2.cues.endCard;
      const spb = lastBar.spb;
      list("lead").push({ t: end, dur: 1.5, m: 67, v: 0.66 }, { t: end, dur: 1.5, m: 79, v: 0.4 });
      list("kick").push({ t: end, v: 1 });
      list("crash").push({ t: end, v: 0.85 });
      list("boom").push({ t: end, v: 0.85 });
      list("bass").push({ t: end, dur: 1.4, m: 31, v: 0.9 });
      [55, 59, 62, 67, 71].forEach((m) => list("padEnd").push({ t: end, dur: 1.4, m, v: 0.75 }));
      [67, 71, 74, 79].forEach((m, k) => list("arp").push({ t: end + (k + 1) * spb * 0.5, dur: spb * 0.45, m, v: 0.5 - k * 0.07 }));
    }
  },
  parts: {
    pad: { synth: "supersaw", level: -21, cutoff: true, params: { voices: 7, detune: 13, width: 0.85, attack: 0.08, decay: 1, sustain: 0.85, release: 0.5, q: 0.8, lfoRate: 0.13, lfoDepth: 0.14, keyTrack: 0.25 }, eq: [...butter4("hp", 200), ["peak", 2600, 1, -1.5]], chorus: { mix: 0.3 }, duck: 0.5, reverb: -10 },
    padEnd: { synth: "supersaw", level: -21, params: { voices: 7, detune: 13, width: 0.85, attack: 0.03, decay: 1.4, sustain: 0.7, release: 1.1, q: 0.8, cutoff: 1700, keyTrack: 0.25 }, eq: [...butter4("hp", 180), ["peak", 2600, 1, -1.5]], chorus: { mix: 0.3 }, reverb: -8 },
    arp: { synth: "pluck", level: -24, params: { wave: "square", detune: 6, sub: 0, decay: 0.12, release: 0.05, cutoff: 900, envAmt: 3200, fdecay: 0.06, q: 1.2 }, eq: [["hp", 350, 0.7], ["highshelf", 7000, 0.7, -4]], duck: 0.3, delay: -6, reverb: -12, pan: 0.08 },
    lead: { synth: "lead", level: -18, params: { saw: 0.55, square: 0.45, cutoff: 2600, envAmt: 0.7, fdecay: 0.18, attack: 0.008, decay: 0.3, sustain: 0.75, release: 0.35, vibCents: 11, vibDelay: 0.22 }, eq: [["hp", 250, 0.7], ["peak", 2800, 1, -1.5], ["highshelf", 8000, 0.7, -4]], chorus: { mix: 0.3 }, delay: -7, reverb: -8 },
    bass: { synth: "sub", level: -16.5, params: { h2: 0.12, drive: 1.4, attack: 0.004, decay: 0.3, sustain: 0.7, release: 0.04, saw: 0.45, sawCut: 300, sawEnv: 1300, sawEnvDecay: 0.07, sawQ: 1.1 }, eq: [["lp", 2200, 0.7], ...butter4("hp", 34)], duck: 0.45 },
    kick: { synth: "kick", level: -15, bus: "drums", params: { f0: 165, f1: 52, pitchTau: 0.032, ampTau: 0.23, click: 0.16, drive: 1.8, length: 0.42 }, eq: [...butter4("hp", 32), ["lp", 10000, 0.7]] },
    clap: { synth: "clap", level: -22, bus: "drums", params: { freq: 1350, tail: 0.11 }, eq: [["hp", 400, 0.7], ["highshelf", 8000, 0.7, -3]], reverb: -8 },
    snare: { synth: "snare", level: -24, bus: "drums", params: { body: 210, tail: 0.1 }, eq: [["hp", 160, 0.7]], reverb: -9 },
    hat: { synth: "hat", level: -29, bus: "drums", params: { freq: 8400, decay: 0.026 }, eq: [["lp", 11000, 0.7]], pan: 0.18 },
    openhat: { synth: "hat", level: -29, bus: "drums", params: { freq: 7800, decay: 0.15, open: true }, eq: [["lp", 10500, 0.7]], pan: -0.15 },
    shaker: { synth: "shaker", level: -31, bus: "drums", params: { freq: 6000 }, eq: [["lp", 10000, 0.7]], pan: -0.2 },
    crash: { synth: "crash", peak: -18, bus: "drums", params: { decay: 1.0 }, eq: [["lp", 8500, 0.7]], reverb: -12 },
    boom: { synth: "boom", peak: -10 },
    riser: { synth: "riser", peak: -19, params: { f0: 400, f1: 6500 }, reverb: -8 },
    swell: { synth: "swell", peak: -20, eq: [["lp", 9000, 0.7]], reverb: -10 }
  },
  reverb: { rt60: 1.9, size: 0.9, damp: 6000, predelay: 0.018, width: 0.6, level: -24, eq: [["hp", 280, 0.7], ["lp", 8000, 0.7]], duck: 0.35 },
  delay: { beats: 0.75, feedback: 0.3, lp: 3500, hp: 500, level: -27 },
  masterEq: [["highshelf", 3000, 0.7, 3]],
  drumBus: { threshold: -16, ratio: 3, attack: 0.01, release: 0.1, knee: 6 },
  duck: { release: 0.24 }
};

// Shared dark-techno sound palette; D and E override what they need.
const DARK_PARTS = {
  drone: { synth: "supersaw", level: -23, cutoff: "droneCut", params: { voices: 5, detune: 20, width: 0.6, attack: 0.6, decay: 2, sustain: 1, release: 1.2, q: 1.3, lfoRate: 0.07, lfoDepth: 0.25, keyTrack: 0 }, eq: butter4("hp", 38), duck: 0.7, reverb: -12 },
  droneEnd: { synth: "supersaw", level: -23, params: { voices: 5, detune: 20, width: 0.6, attack: 0.02, decay: 2, sustain: 1, release: 2.2, q: 1.3, cutoff: 650, keyTrack: 0 }, eq: butter4("hp", 38), reverb: -8 },
  kick: { synth: "technoKick", level: -10.5, bus: "drums", params: { f0: 320, fMid: 120, f1: 47, tau1: 0.006, tau2: 0.045, ampTau: 0.14, tail: 0.35, tailTau: 0.4, drive: 3, asym: 0.08, click: 0.35, length: 0.8 }, eq: butter4("hp", 30) },
  clap: { synth: "clap", level: -20, bus: "drums", params: { freq: 1400, tail: 0.12 }, eq: [["hp", 400, 0.7], ["highshelf", 9000, 0.7, -3]], room: -3, reverb: -12 },
  snare: { synth: "snare", level: -22, bus: "drums", params: { body: 210, tail: 0.1 }, eq: [["hp", 180, 0.7]], room: -5, reverb: -12 },
  hat: { synth: "grittyHat", level: -25, bus: "drums", params: { freq: 8500, decay: 0.03, drive: 2.5, metal: 0.35 }, eq: [["lp", 12000, 0.7]] },
  openhat: { synth: "grittyHat", level: -27, bus: "drums", params: { freq: 7800, decay: 0.17, drive: 2.5, metal: 0.4, open: true }, eq: [["lp", 11500, 0.7]] },
  metal: { synth: "metal", level: -24, bus: "drums", room: -4, reverb: -12, delay: -12 },
  stab: { synth: "brass", level: -19, params: { voices: 5, detune: 18, attack: 0.003, decay: 0.16, sustain: 0, release: 0.12, cutoff: 900, envAmt: 4, fdecay: 0.09, q: 1.4, drive: 3, sub: 0.25 }, eq: [...butter4("hp", 140), ["peak", 2500, 1, -2]], chorus: { mix: 0.3 }, gatedReverb: { rt60: 2.4, hold: 0.3, level: -23 }, duck: 0.3 },
  stabEnd: { synth: "brass", level: -18, params: { voices: 6, detune: 18, attack: 0.003, decay: 0.6, sustain: 0.25, release: 1.6, cutoff: 1000, envAmt: 3, fdecay: 0.2, q: 1.2, drive: 3, sub: 0.3 }, eq: [...butter4("hp", 120), ["peak", 2500, 1, -2]], reverb: -2 },
  crash: { synth: "crash", peak: -17, bus: "drums", params: { decay: 1.1, hp: 3500 }, eq: [["lp", 10000, 0.7]], reverb: -12 },
  boom: { synth: "boom", peak: -8, params: { f0: 90, f1: 44, decay: 0.55 } },
  downlifter: { synth: "downlifter", peak: -15, reverb: -8 },
  riser: { synth: "riser", peak: -16, params: { f0: 300, f1: 7000 }, reverb: -8 },
  swell: { synth: "swell", peak: -18, eq: [["lp", 10000, 0.7]], reverb: -10 },
  revverb: { synth: "revverb", peak: -14, eq: butter4("hp", 120) },
  hiss: { synth: "hiss", level: -48, eq: [["hp", 1500, 0.7], ["lp", 9000, 0.7]] }
};

const PRESET_D = {
  id: "D",
  name: "Dark techno: club",
  seed: 0xd4c,
  nominalBpm: 128,
  key: "F minor (phrygian flat-2 inflections)",
  feel: "Driving, relentless hard techno: saturated kick with rumble, rolling 16th off-beat distorted bass, gritty hats, metal hits, a sparse gliding square riff on the AI chapters, stabs and impacts on the cuts.",
  form: {
    intro: { bars: [4], chords: ["Fm"] },
    sections: [
      { id: "find", bars: [4, 4, 4, 3], chords: ["Fm", "Fm", "Db", "Eb"], gap: true },
      { id: "disk", bars: [4, 4, 3], chords: ["Fm", "Gb", "Eb"], gap: true },
      { id: "transfer", bars: [4, 4, 4, 4, 3], chords: ["Fm", "Fm", "Db", "Eb", "Gb"] },
      { id: "safety", bars: [4, 4, 4, 4], chords: ["Db", "Db", "Bbm", "C"] },
      { id: "terminal", bars: [4, 4, 4, 4, 1], chords: ["Fm", "Fm", "Db", "Eb", "Eb"] },
      { id: "ai", bars: [4, 4, 4, 1], chords: ["Fm", "Fm", "Fm", "Eb"] },
      { id: "scope", bars: [4, 4, 4, 4], chords: ["Fm", "Fm", "Fm", "C"] }
    ],
    outro: { bars: [4, 4], chords: ["Fm", "Fm"] }
  },
  arranger: arrangeTechno,
  style: {
    droneRange: [36, 47],
    bassRange: [29, 40],
    bassStart: 29,
    stabRange: [53, 72],
    riffRoot: 5,
    hat16: [0.32, 0.2, 1, 0.26],
    downlifterDur: 1.4,
    // Last beat of every second bar: octave jump and a flat-2 flick.
    bassTurn: [[0.25, 0.18, 0, 0.8], [0.5, 0.2, 12, 1], [0.75, 0.18, 1, 0.9]],
    metalPattern: [[0, 1.75, 620, 0.25, 0.4, 0.7], [1, 0.75, 910, 0.2, -0.4, 0.6], [1, 2.75, 470, 0.35, 0.3, 0.8]],
    stabPatterns: { sparse: [[1, 3.5, 0.5, null, 0.7]] },
    // Two-bar square riff in F minor (flat 2 = Gb for menace), with glides.
    riff: [
      [[0, 0.5, 53], [0.75, 0.25, 53], [1.5, 0.5, 56], [2.5, 0.75, 54, 56], [3.5, 0.25, 53], [3.75, 0.25, 51, 53]],
      [[0, 0.5, 53], [0.75, 0.25, 53], [1.5, 0.5, 60], [2.5, 1, 54, 60]]
    ],
    sections: {
      intro: { energy: 0.3, drone: 0.8, droneCut: [180, 900] },
      find: { energy: 0.8, drone: 0.5, droneCut: [700, 900], kick: 1, bass: "roll", bassV: 0.9, bassCut: [420, 700], hats: "16", clap: 0.9, crash: 1, boom: 1, downlifter: 1, stab: 0.9, riser: 3, fill: { type: "snare16", bass: false, swell: true } },
      disk: { energy: 0.85, drone: 0.5, droneCut: [800, 1000], kick: 1, bass: "roll", bassCut: [600, 1000], hats: "16", openHat: 0.8, openHatBars: [1, 2], clap: 0.9, metal: 1, crash: 0.7, fill: { type: "stop", rev: true } },
      transfer: { energy: 1, drone: 0.5, droneCut: [900, 1400], kick: 1, bass: "roll", bassCut: [900, 1800], crush: 0.35, crushBars: [2, 3], hats: "16", openHat: 0.9, clap: 1, metal: 1, stabs: "sparse", crash: 1, boom: 1, downlifter: 1, stab: 1, riser: 5, fill: { type: "snare16", bass: false, swell: true } },
      safety: { energy: 0.45, drone: 0.9, droneCut: [500, 1600], kick: 1, kickBars: [2, 3], bass: "pulse", turn: false, bassCut: [300, 900], bassV: 0.8, hats: "8off", hatsBars: [2, 3], metal: 0.8, stab: 0.9, stabBeats: 1.5, downlifter: 0.8, crash: 0.5, riser: 8, fill: { type: "snare16", swell: true, bass: false } },
      terminal: { energy: 0.9, drone: 0.5, droneCut: [900, 1200], kick: 1, bass: "roll", bassCut: [800, 1500], hats: "16", openHat: 0.8, clap: 1, metal: 1, crash: 0.9, boom: 0.9, downlifter: 0.9, stab: 0.8, fill: { type: "stop", rev: true } },
      ai: { energy: 1, drone: 0.5, droneCut: 1000, kick: 1, bass: "roll", bassCut: [1100, 1700], hats: "16", openHat: 0.8, clap: 1, metal: 0.7, riff: 1, crash: 1, boom: 1, downlifter: 1, stab: 1, fill: { type: "stop", rev: true } },
      scope: { energy: 0.95, drone: 0.55, droneCut: [1000, 1400], kick: 1, bass: "roll", bassCut: [1300, 2600], crush: 0.45, crushBars: [3], hats: "16", openHat: 0.9, clap: 1, metal: 0.8, riff: 0.9, riffBars: [0, 1, 2], crash: 0.9, boom: 0.8, downlifter: 0.8, stab: 0.9, riser: 8, fill: { type: "roll", bass: false, swell: true } },
      outro: { energy: 0.6, droneCut: [900, 300] }
    },
    extras(tl, ctx, list, mark) {
      const first = tl.sections[0].start;
      const intro = tl.bars[0];
      list("hiss").push({ t: 0, dur: tl.cues.duration, v: 1 });
      list("riser").push({ t: 0.25, dur: first - 0.25, v: 1 });
      mark(0.25, "riser-start", 0.4);
      mark(first, "riser-end", 0.9);
      list("revverb").push({ t: first - 1.4, dur: 1.4, ms: [53, 56, 60, 65], v: 1 });
      list("metal").push({ t: intro.start, f: 170, decay: 1.2, pan: 0, v: 0.8 });
      // Last impact on the end card, then a dark tail.
      const end = tl.cues.endCard;
      list("kick").push({ t: end, v: 1 });
      list("crash").push({ t: end, v: 1 });
      list("boom").push({ t: end, v: 1 });
      list("downlifter").push({ t: end, v: 1, dur: 2.4 });
      for (const m of [53, 56, 60, 65]) list("stabEnd").push({ t: end, dur: 0.6, m, v: 1 });
      list("metal").push({ t: end, f: 140, decay: 1.6, pan: 0, v: 0.8 });
      list("bass").push({ t: end, dur: 0.5, m: 29, v: 1 });
      for (const m of [41, 48, 53]) list("droneEnd").push({ t: end, dur: 1.2, m, v: 0.8 });
      mark(end, "impact", 1);
    }
  },
  parts: {
    ...DARK_PARTS,
    bass: { synth: "driveBass", level: -13, cutoff: "bassCut", params: { drive1: 2.8, drive2: 2.2, q: 2.8, envAmt: 2.5, fdecay: 0.06, decay: 0.09, sustain: 0.45, square: 0.4, mid: 0.65, sub: 0.45 }, eq: [...butter4("hp", 32), ["lp", 7000, 0.7]], duck: 0.5 },
    lead: { synth: "lead", level: -18, params: { saw: 0.35, square: 0.65, cutoff: 1500, envAmt: 2.2, fdecay: 0.1, q: 3, attack: 0.004, decay: 0.15, sustain: 0.6, release: 0.08, vibCents: 0, glide: 0.07, drive: 3, drive2: 2, detune: 9 }, eq: [...butter4("hp", 160), ["lp", 7500, 0.7]], delay: -9, reverb: -12, duck: 0.35 }
  },
  room: { rt60: 0.7, size: 0.55, damp: 3500, predelay: 0.006, width: 0.6, level: -24, eq: [["hp", 250, 0.7], ["lp", 6500, 0.7]] },
  reverb: { rt60: 2.8, size: 1.15, damp: 4200, predelay: 0.02, width: 0.6, level: -24, eq: [["hp", 250, 0.7], ["lp", 7000, 0.7]], duck: 0.6 },
  delay: { beats: 0.75, feedback: 0.3, lp: 2500, hp: 500, level: -30 },
  rumble: { level: -21, rt60: 2.2 },
  drumBus: { threshold: -14, ratio: 3, attack: 0.004, release: 0.08, knee: 6 },
  master: { targetLufs: -14, ceilingDbtp: -1.6, saturation: 1.6, monoBelow: 120, eq: [["highshelf", 3000, 0.7, 1]], glue: { threshold: -20, ratio: 2, attack: 0.02, release: 0.15 } },
  duck: { attack: 0.003, release: 0.2 }
};

// Cold, dissonant brass voicings for E (E phrygian): b9 and #11 on top, a tritone stack and
// two minor triads a half step apart.
const E_VOICINGS = {
  Em: [52, 59, 64, 67, 77],
  F: [53, 57, 60, 65, 71],
  C: [48, 55, 59, 64],
  D: [50, 57, 62, 66],
  Am: [57, 60, 64, 71],
  B: [47, 54, 59, 63],
  Tri: [52, 58, 64, 70],
  EmFm: [52, 55, 59, 65, 68, 72]
};

const PRESET_E = {
  id: "E",
  name: "Dark techno: cinematic march",
  seed: 0xe7e,
  nominalBpm: 122,
  key: "E phrygian (flat-2 F, harmonic-minor B for tension)",
  feel: "Militant, stomping, cinematic dark techno in the Pursuit lane: massive dry distorted kick, huge cold claps in a dark hall, saturated detuned brass stabs with dissonant voicings and pitch dives, an eerie held high line, sparse ticks, stops before key cuts, a drone-and-stabs breakdown mid-video.",
  form: {
    intro: { bars: [4], chords: ["Em"] },
    sections: [
      { id: "find", bars: [4, 4, 4, 3], chords: ["Em", "Em", "C", "F"] },
      { id: "disk", bars: [4, 4, 2], chords: ["Em", "F", "Em"], gap: true },
      { id: "transfer", bars: [4, 4, 4, 4, 2], chords: ["Em", "Em", "C", "D", "F"] },
      { id: "safety", bars: [4, 4, 4, 3], chords: ["C", "C", "Am", "B"] },
      { id: "terminal", bars: [4, 4, 4, 4], chords: ["Em", "Em", "C", "F"] },
      { id: "ai", bars: [4, 4, 4], chords: ["Em", "Em", "F"], gap: true },
      { id: "scope", bars: [4, 4, 4, 3], chords: ["Em", "F", "C", "B"] }
    ],
    outro: { bars: [4, 4], chords: ["Em", "Em"] }
  },
  arranger: arrangeTechno,
  style: {
    droneRange: [36, 47],
    bassRange: [28, 39],
    bassStart: 28,
    stabRange: [48, 72],
    voicings: E_VOICINGS,
    hat16: [0.3, 0.18, 0.9, 0.22],
    downlifterDur: 2,
    clapLayer: { f: 2300, decay: 0.09, v: 0.8 },
    metalPattern: [[0, 3.75, 760, 0.3, 0.45, 0.8], [1, 1.75, 1180, 0.22, -0.45, 0.6], [1, 3.5, 430, 0.5, 0.2, 0.9]],
    // Original two-bar stab rhythms: a march figure, a sparse one and a breakdown figure.
    stabPatterns: {
      march: [[0, 0, 0.75, null, 1], [0, 2.5, 0.35, null, 0.72], [1, 0, 0.75, null, 0.9], [1, 1.5, 0.35, "Tri", 0.7], [1, 3, 0.9, "EmFm", 0.85, 7]],
      breakdown: [[0, 0, 2.5, null, 0.9], [1, 0, 1.5, "Tri", 0.8], [1, 2.5, 1.2, "EmFm", 0.85, 12]]
    },
    sections: {
      intro: { energy: 0.25, drone: 0.9, droneCut: [150, 700] },
      find: { energy: 0.8, drone: 0.5, droneCut: 700, kick: 1, clap: 1, bass: "hold", bassCut: [350, 520], hats: "tick", metal: 0.7, stabs: "march", stab: 1, crash: 0.8, boom: 1, downlifter: 1, fill: { type: "stop", beats: 1, rev: true } },
      disk: { energy: 0.85, drone: 0.5, droneCut: 800, kick: 1, clap: 1, bass: "hold", bassCut: [450, 700], hats: "tick", metal: 1, stabs: "march", stab: 0.9, crash: 0.7, boom: 0.8, downlifter: 0.8, fill: { type: "stop", beats: 1, dive: 0.9, rev: true } },
      transfer: { energy: 1, drone: 0.5, droneCut: 900, kick: 1, clap: 1, bass: "hold", bassCut: [500, 1100], crush: 0.3, crushBars: [3], hats: "tick", metal: 1, brassPad: 0.55, brassCut: [700, 2600], stabs: "march", stab: 1, crash: 1, boom: 1, downlifter: 1, eerie: { m: 83, bend: -30 }, riser: 6, fill: { type: "stop", swell: true, rev: true } },
      safety: { energy: 0.45, drone: 1, droneCut: [300, 1200], stabs: "breakdown", stab: 1, stabBeats: 2, downlifter: 1, boom: 0.9, metal: 0.6, metalBars: [2, 3], eerie: { m: 84, bend: -50 }, riser: 7, fill: { type: "roll", swell: true } },
      terminal: { energy: 0.9, drone: 0.5, droneCut: 900, kick: 1, clap: 1, bass: "hold", bassCut: [500, 900], hats: "tick", metal: 1, brassPad: 0.45, brassCut: [900, 1600], stabs: "march", stab: 1, crash: 1, boom: 1, downlifter: 1, fill: { type: "stop", beats: 2, rev: true } },
      ai: { energy: 0.95, drone: 0.5, droneCut: 1000, kick: 1, clap: 1, bass: "hold", bassCut: [600, 1000], hats: "8off", metal: 1, stabs: "march", stab: 1, crash: 1, boom: 1, downlifter: 1, eerie: { m: 77, bend: -30 }, fill: { type: "stop", beats: 1, rev: true } },
      scope: { energy: 0.95, drone: 0.55, droneCut: [900, 1400], kick: 1, clap: 1, bass: "hold", bassCut: [600, 1600], crush: 0.4, crushBars: [2], hats: "tick", metal: 1, brassPad: 0.65, brassCut: [600, 3200], stabs: "march", stab: 1, crash: 0.9, boom: 0.9, downlifter: 0.9, eerie: { m: 83, bend: 100 }, riser: 7, fill: { type: "roll", swell: true, dive: 0.8 } },
      outro: { energy: 0.7, droneCut: [700, 200] }
    },
    extras(tl, ctx, list, mark) {
      const first = tl.sections[0].start;
      const intro = tl.bars[0];
      list("hiss").push({ t: 0, dur: tl.cues.duration, v: 1 });
      list("riser").push({ t: 0.3, dur: first - 0.3, v: 1 });
      mark(0.3, "riser-start", 0.4);
      mark(first, "riser-end", 0.9);
      list("revverb").push({ t: first - 1.5, dur: 1.5, ms: E_VOICINGS.Em, v: 1 });
      list("metal").push({ t: intro.start, f: 150, decay: 1.4, pan: 0, v: 0.9 });
      list("eerie").push({ t: 0.05, dur: first - 0.15, m: 83, v: 0.8, bend: -20 });
      mark(0.05, "lead-in", 0.3);
      // Last impact on the end card: kick, boom, downlifter and a cold Em(b9) chord, then the
      // eerie line drifts down while everything decays.
      const end = tl.cues.endCard;
      list("kick").push({ t: end, v: 1 });
      list("crash").push({ t: end, v: 1 });
      list("boom").push({ t: end, v: 1 });
      list("downlifter").push({ t: end, v: 1, dur: 2.6 });
      for (const m of E_VOICINGS.Em) list("stabEnd").push({ t: end, dur: 0.9, m, v: 1 });
      list("metal").push({ t: end, f: 130, decay: 1.8, pan: 0, v: 0.8 });
      list("bass").push({ t: end, dur: 0.6, m: 28, v: 1 });
      for (const m of [40, 47, 52]) list("droneEnd").push({ t: end, dur: 1.2, m, v: 0.8 });
      list("eerie").push({ t: end + 0.02, dur: 1.4, m: 83, v: 0.8, bend: -45, a: 0.3 });
      mark(end, "impact", 1);
    }
  },
  parts: {
    ...DARK_PARTS,
    kick: { synth: "technoKick", level: -10.5, bus: "drums", params: { f0: 260, fMid: 110, f1: 50, tau1: 0.005, tau2: 0.035, ampTau: 0.11, tail: 0.25, tailTau: 0.16, drive: 3.8, asym: 0.1, click: 0.3, length: 0.4 }, eq: butter4("hp", 30) },
    clap: { synth: "clap", level: -17, bus: "drums", params: { freq: 1200, tail: 0.16 }, eq: [["hp", 350, 0.7], ["highshelf", 9000, 0.7, -3]], reverb: 0, room: -8 },
    clapmetal: { synth: "metal", level: -25, bus: "drums", params: { hp: 1200, ring: 0.6, drive: 2.5 }, reverb: -2 },
    snare: { synth: "snare", level: -21, bus: "drums", params: { body: 200, tail: 0.12 }, eq: [["hp", 180, 0.7]], reverb: -6 },
    tick: { synth: "grittyHat", level: -27, bus: "drums", params: { freq: 9500, decay: 0.014, drive: 2, metal: 0.5 }, eq: [["lp", 12000, 0.7]] },
    hat: { synth: "grittyHat", level: -28, bus: "drums", params: { freq: 9000, decay: 0.025, drive: 2, metal: 0.4 }, eq: [["lp", 12000, 0.7]] },
    metal: { synth: "metal", level: -23, bus: "drums", room: -4, reverb: -6 },
    bass: { synth: "driveBass", level: -14, cutoff: "bassCut", params: { drive1: 3, drive2: 2.5, q: 1.8, envAmt: 1.5, fdecay: 0.15, decay: 0.3, sustain: 0.8, square: 0.5, mid: 0.7, sub: 0.5, release: 0.04 }, eq: [...butter4("hp", 30), ["lp", 6000, 0.7]], duck: 0.8 },
    stab: { synth: "brass", level: -15, bus: "synth", params: { voices: 6, detune: 22, attack: 0.003, decay: 0.22, sustain: 0.35, release: 0.18, cutoff: 1100, envAmt: 4.5, fdecay: 0.1, q: 1.3, drive: 3.5, sub: 0.35 }, eq: [...butter4("hp", 120), ["peak", 2500, 1, -2]], reverb: -6, duck: 0.35 },
    brassPad: { synth: "brass", level: -20, bus: "synth", cutoff: "brassCut", params: { voices: 6, detune: 18, attack: 0.12, decay: 1, sustain: 0.9, release: 0.4, envAmt: 0.3, q: 1, drive: 2.5, sub: 0.2 }, eq: butter4("hp", 150), duck: 0.6, reverb: -10 },
    stabEnd: { ...DARK_PARTS.stabEnd, level: -16, params: { ...DARK_PARTS.stabEnd.params, decay: 0.8, release: 2 }, reverb: 0 },
    eerie: { synth: "eerie", level: -24, params: { detune: 9, vibCents: 14, cutoff: 4200, attack: 0.9, release: 1.2 }, eq: butter4("hp", 600), reverb: -4, delay: -10 },
    crash: { ...DARK_PARTS.crash, peak: -16 },
    boom: { ...DARK_PARTS.boom, peak: -7 },
    downlifter: { ...DARK_PARTS.downlifter, peak: -13 },
    riser: { ...DARK_PARTS.riser, peak: -15 },
    swell: { ...DARK_PARTS.swell, peak: -17 },
    revverb: { ...DARK_PARTS.revverb, peak: -12 },
    hiss: { ...DARK_PARTS.hiss, level: -47 }
  },
  room: { rt60: 0.6, size: 0.5, damp: 3500, predelay: 0.005, width: 0.6, level: -26, eq: [["hp", 250, 0.7], ["lp", 6000, 0.7]] },
  reverb: { rt60: 3.6, size: 1.35, damp: 3200, predelay: 0.03, width: 0.6, level: -19, eq: [["hp", 200, 0.7], ["lp", 6000, 0.7]], duck: 0.45 },
  delay: { beats: 0.75, feedback: 0.3, lp: 2500, hp: 600, level: -31 },
  synthBus: { drive: 4, mix: 0.35, hp: 150, lp: 9000 },
  drumBus: { threshold: -14, ratio: 3, attack: 0.004, release: 0.09, knee: 6 },
  master: { targetLufs: -14, ceilingDbtp: -1.6, saturation: 1.8, monoBelow: 120, eq: [["highshelf", 3000, 0.7, 1]], glue: { threshold: -20, ratio: 2, attack: 0.02, release: 0.15 } },
  duck: { attack: 0.003, release: 0.22 }
};

for (const p of [PRESET_A, PRESET_B, PRESET_C]) p.status = "rejected by the owner (warm/pop palette); kept for reference";
for (const p of [PRESET_D, PRESET_E]) p.status = "candidate";

export const PRESETS = { A: PRESET_A, B: PRESET_B, C: PRESET_C, D: PRESET_D, E: PRESET_E };

// ---------------------------------------------------------------------------------------------
// Mixing and mastering

// Loudness of a stem while it is actually playing: K-weighted RMS over 100 ms blocks that are
// within 30 dB of the stem's loudest block.
function activeLevel(track) {
  const pre = squaredPrefix(track.L, track.R);
  const block = Math.round(0.1 * SR);
  const vals = [];
  for (let s = 0; s + block <= track.n; s += block) vals.push((pre[s + block] - pre[s]) / block);
  const max = Math.max(...vals);
  if (max <= 0) return -Infinity;
  const active = vals.filter((v) => v > max * 1e-3);
  return 10 * Math.log10(active.reduce((a, b) => a + b, 0) / active.length);
}

function samplePeak(track) {
  let m = 0;
  for (let i = 0; i < track.n; i += 1) m = Math.max(m, Math.abs(track.L[i]), Math.abs(track.R[i]));
  return toDb(m);
}

// The arrangement as note/hit events (seconds, MIDI notes), without rendering audio.
export function arrangeCandidate(id, cues) {
  const preset = PRESETS[id];
  if (!preset) throw new Error(`Unknown candidate ${id}`);
  const ctx = { seed: preset.seed, n: Math.round(cues.duration * SR) };
  const timeline = buildTimeline(preset, cues);
  return { preset, ctx, timeline, events: preset.arranger(timeline, ctx, preset.style) };
}

const applyDuck = (track, duck, depth) => {
  for (let i = 0; i < track.n; i += 1) {
    const g = 1 - depth * duck[i];
    track.L[i] *= g;
    track.R[i] *= g;
  }
};

// Gate that opens for `hold` seconds after each event (3 ms attack, 25 ms release).
function gateEnvelope(times, n, hold) {
  const env = new Float32Array(n);
  const a = Math.round(0.003 * SR);
  const h = Math.round(hold * SR);
  const r = Math.round(0.025 * SR);
  for (const t of [...new Set(times.map((x) => Math.round(x * SR)))]) {
    for (let i = 0; i < a + h + r; i += 1) {
      const idx = t + i;
      if (idx >= n) break;
      const g = i < a ? i / a : i < a + h ? 1 : 1 - (i - a - h) / r;
      if (g > env[idx]) env[idx] = g;
    }
  }
  return env;
}

export function renderCandidate(id, cues, { log = () => {} } = {}) {
  const { preset, ctx, timeline: tl, events } = arrangeCandidate(id, cues);
  const targetLufs = preset.master?.targetLufs ?? -16;
  const ceilingDbtp = preset.master?.ceilingDbtp ?? -1.8;
  const n = ctx.n;
  const kickTimes = (events.kick || []).map((e) => e.t);
  const duck = kickTimes.length ? duckEnvelope(kickTimes, n, preset.duck) : null;
  const mix = new Track(n);
  const drums = new Track(n);
  const synthBus = new Track(n);
  const reverbSend = new Track(n);
  const roomSend = new Track(n);
  const delaySend = new Track(n);
  const stems = {};
  let kickTrack = null;

  for (const [name, cfg] of Object.entries(preset.parts)) {
    const evs = events[name];
    if (!evs?.length) continue;
    for (const e of evs) {
      const bad = !Number.isFinite(e.t) || !Number.isFinite(e.v) || ("m" in e && !Number.isFinite(e.m)) || ("dur" in e && !(e.dur > 0));
      if (bad) throw new Error(`Invalid ${id}/${name} event ${JSON.stringify(e)}`);
    }
    const track = new Track(n);
    const params = { ...cfg.params };
    // Filter automation comes from the arranger's per-chapter table (`cutoff: true` reads the
    // "cutoff" column, a string names another column such as "bassCut").
    if (cfg.cutoff) params.cutoffAt = sectionAutomation(tl, preset.style, cfg.cutoff === true ? "cutoff" : cfg.cutoff, 2000);
    SYNTHS[cfg.synth](track, evs, params, ctx);
    if (cfg.eq) eqTrack(track, cfg.eq);
    if (cfg.chorus) chorus(track, cfg.chorus);
    if (cfg.duck && duck) applyDuck(track, duck, cfg.duck);
    const measured = cfg.peak != null ? samplePeak(track) : activeLevel(track);
    if (!Number.isFinite(measured)) throw new Error(`Stem ${id}/${name} rendered silence or non-finite samples`);
    const target = cfg.peak != null ? cfg.peak : cfg.level;
    scaleTrack(track, dbGain(target - measured));
    stems[name] = { events: evs.length, ...(cfg.peak != null ? { peakDbfs: target } : { activeLevelDb: target }) };
    mixInto(cfg.bus === "drums" ? drums : cfg.bus === "synth" ? synthBus : mix, track, 1, cfg.pan ?? 0);
    if (cfg.reverb != null) mixInto(reverbSend, track, dbGain(cfg.reverb), cfg.pan ?? 0);
    if (cfg.room != null && preset.room) mixInto(roomSend, track, dbGain(cfg.room), cfg.pan ?? 0);
    if (cfg.delay != null && preset.delay) mixInto(delaySend, track, dbGain(cfg.delay), cfg.pan ?? 0);
    // Gated reverb: the part's own reverb, chopped off shortly after each hit.
    if (cfg.gatedReverb) {
      const g = cfg.gatedReverb;
      const wet = fdnReverb(track, { rt60: g.rt60 ?? 2.4, size: g.size ?? 1.1, damp: g.damp ?? 5000, predelay: 0.01, width: 0.6 });
      eqTrack(wet, [["hp", 200, 0.7], ["lp", 7000, 0.7]]);
      const gate = gateEnvelope(evs.map((e) => e.t), n, g.hold ?? 0.3);
      for (let i = 0; i < n; i += 1) {
        wet.L[i] *= gate[i];
        wet.R[i] *= gate[i];
      }
      scaleTrack(wet, dbGain(g.level - activeLevel(wet)));
      mixInto(mix, wet);
    }
    if (name === "kick") kickTrack = track;
    log(`  ${id}/${name}: ${evs.length} events`);
  }

  // Kick rumble: the kick through a dark reverb, band-limited to 45-160 Hz, driven and ducked
  // almost completely by the kick itself.
  if (preset.rumble && kickTrack) {
    const r = preset.rumble;
    const wet = fdnReverb(kickTrack, { rt60: r.rt60 ?? 2.2, size: 1, damp: 900, predelay: 0.01, width: 0 });
    eqTrack(wet, [...butter4("hp", 45), ...butter4("lp", r.lp ?? 160)]);
    for (let i = 0; i < n; i += 1) {
      const m = Math.tanh(2 * (wet.L[i] + wet.R[i]) * 4) / 4;
      wet.L[i] = m;
      wet.R[i] = m;
    }
    if (duck) applyDuck(wet, duck, 0.95);
    scaleTrack(wet, dbGain(r.level - activeLevel(wet)));
    stems.rumble = { activeLevelDb: r.level };
    mixInto(mix, wet);
  }

  // Synth bus with parallel distortion (dense, saturated brass without losing the transients).
  if (preset.synthBus) {
    const sb = preset.synthBus;
    const dist = new Track(n);
    for (let i = 0; i < n; i += 1) {
      dist.L[i] = Math.tanh(sb.drive * synthBus.L[i]);
      dist.R[i] = Math.tanh(sb.drive * synthBus.R[i]);
    }
    eqTrack(dist, [["hp", sb.hp ?? 150, 0.7], ["lp", sb.lp ?? 7000, 0.7]]);
    const dryLevel = activeLevel(synthBus);
    scaleTrack(dist, dbGain(dryLevel + toDb(sb.mix ?? 0.35) - activeLevel(dist)));
    mixInto(synthBus, dist);
  }
  mixInto(mix, synthBus);

  const drumBus = compress(drums, preset.drumBus);
  mixInto(mix, drums);

  if (preset.delay) {
    const spb = 60 / preset.nominalBpm;
    const wet = pingPong(delaySend, { time: preset.delay.beats * spb, feedback: preset.delay.feedback, lp: preset.delay.lp, hp: preset.delay.hp });
    scaleTrack(wet, dbGain(preset.delay.level - activeLevel(wet)));
    mixInto(mix, wet);
    mixInto(reverbSend, wet, dbGain(-8));
  }
  for (const [rv, send] of [[preset.room, roomSend], [preset.reverb, reverbSend]]) {
    if (!rv || activeLevel(send) === -Infinity) continue;
    const wet = fdnReverb(send, rv);
    eqTrack(wet, rv.eq);
    if (rv.duck && duck) applyDuck(wet, duck, rv.duck);
    scaleTrack(wet, dbGain(rv.level - activeLevel(wet)));
    mixInto(mix, wet);
  }

  const master = masterChain(mix, { targetLufs, ceilingDbtp, duration: cues.duration, eq: preset.masterEq ?? preset.master?.eq, ...preset.master });
  const pre = squaredPrefix(mix.L, mix.R);
  const sectionLoudness = [
    { id: "open", from: 0, to: tl.sections[0].start },
    ...tl.sections.map((s) => ({ id: s.id, from: s.start, to: s.end })),
    { id: "end", from: cues.endCard, to: cues.duration }
  ].map((w) => ({ id: w.id, from: w.from, to: +w.to.toFixed(3), meanLufs: +windowLoudness(pre, w.from, w.to).toFixed(1) }));
  const tail = windowLoudness(pre, cues.duration - 0.25, cues.duration);

  return {
    L: mix.L,
    R: mix.R,
    beatmap: buildBeatMap(preset, tl, events, cues),
    info: describe(preset, tl, cues, { master, drumBus, stems, sectionLoudness, tailLufs: +tail.toFixed(1) })
  };
}

// Tape-style saturation with a touch of asymmetry (even harmonics) and unity small-signal gain.
function tapeSaturate(track, drive, bias = 0.06) {
  const t0 = Math.tanh(drive * bias);
  const slope = drive * (1 - t0 * t0);
  for (const ch of [track.L, track.R]) for (let i = 0; i < ch.length; i += 1) ch[i] = (Math.tanh(drive * (ch[i] + bias)) - t0) / slope;
}

// Collapses everything below `f` Hz to mono by high-passing the side channel.
function monoBelow(track, f) {
  const side = new Float32Array(track.n);
  for (let i = 0; i < track.n; i += 1) side[i] = (track.L[i] - track.R[i]) * 0.5;
  for (const [type, fc, q] of butter4("hp", f)) runBiquad(side, biquad(type, fc, q));
  for (let i = 0; i < track.n; i += 1) {
    const mid = (track.L[i] + track.R[i]) * 0.5;
    track.L[i] = mid + side[i];
    track.R[i] = mid - side[i];
  }
}

function masterChain(mix, { targetLufs, ceilingDbtp, duration, eq = [], saturation = 0, monoBelow: monoHz = 0, glue: glueCfg = {} }) {
  eqTrack(mix, [...butter4("hp", 30), ...eq, ["highshelf", 11000, 0.7, -1.5]]);
  // Fades: 3 ms in, and a raised-cosine out over the last 0.7 s so the tail reaches digital
  // silence exactly on the final frame (sources are already decaying by then).
  const n = mix.n;
  const fadeIn = Math.round(0.003 * SR);
  const fadeOut = Math.round(0.7 * SR);
  for (let i = 0; i < n; i += 1) {
    let g = 1;
    if (i < fadeIn) g = i / fadeIn;
    const fromEnd = n - 1 - i;
    if (fromEnd < fadeOut) g *= 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fadeOut);
    mix.L[i] *= g;
    mix.R[i] *= g;
  }
  let lufs = integratedLoudness(mix.L, mix.R);
  scaleTrack(mix, dbGain(-20 - lufs));
  if (saturation) {
    tapeSaturate(mix, saturation);
    eqTrack(mix, butter4("hp", 25));
  }
  if (monoHz) monoBelow(mix, monoHz);
  const glue = compress(mix, { threshold: -24, ratio: 1.4, attack: 0.03, release: 0.25, knee: 8, detectMs: 30, ...glueCfg });
  const dry = { L: Float32Array.from(mix.L), R: Float32Array.from(mix.R) };
  let gain = dbGain(targetLufs - integratedLoudness(mix.L, mix.R));
  let limiterGr = 0;
  for (let pass = 0; pass < 6; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      mix.L[i] = dry.L[i] * gain;
      mix.R[i] = dry.R[i] * gain;
    }
    limiterGr = truePeakLimit(mix.L, mix.R, ceilingDbtp);
    lufs = integratedLoudness(mix.L, mix.R);
    if (Math.abs(lufs - targetLufs) < 0.05) break;
    gain *= dbGain(targetLufs - lufs);
  }
  const tp = truePeakEnvelope(mix.L, mix.R).reduce((a, b) => (b > a ? b : a), 0);
  return { integratedLufs: +lufs.toFixed(2), truePeakDbtp: +toDb(tp).toFixed(2), glueCompressor: glue, limiterMaxGainReductionDb: +limiterGr.toFixed(2), saturation, monoBelowHz: monoHz || null, durationSeconds: duration };
}

// ---------------------------------------------------------------------------------------------
// Reporting

function describe(preset, tl, cues, extra) {
  const beatTimes = [];
  const barTimes = [];
  for (const bar of tl.bars) {
    if (bar.gap) continue;
    barTimes.push({ t: bar.start, label: `${bar.sec} bar ${bar.j + 1}` });
    for (let b = 0; b < bar.beats; b += 1) beatTimes.push(bar.start + b * bar.spb);
  }
  const nominalSpb = 60 / preset.nominalBpm;
  const cueList = [
    { id: "open", title: "Title card", time: 0 },
    ...cues.sections.map((s) => ({ id: s.id, title: s.title, time: s.start, ...(s.chaptersJson != null ? { chaptersJson: s.chaptersJson } : {}) })),
    { id: "end", title: "End card (picture cut)", time: cues.endCard }
  ];
  const cueAlignment = cueList.map((cue) => {
    if (cue.id === "open") {
      const first = tl.bars[0];
      return { ...cue, alignedTo: `music entry (pad from 0.000 s; pickup bar starts ${first.start.toFixed(3)} s)`, offsetMs: 0 };
    }
    const bar = barTimes.reduce((a, b) => (Math.abs(b.t - cue.time) < Math.abs(a.t - cue.time) ? b : a));
    const beat = beatTimes.reduce((a, b) => (Math.abs(b - cue.time) < Math.abs(a - cue.time) ? b : a));
    const beatsFromFirst = (cue.time - cues.sections[0].start) / nominalSpb;
    const constOffset = (beatsFromFirst - Math.round(beatsFromFirst / 4) * 4) * nominalSpb * 1000;
    return {
      ...cue,
      nearestBar: bar.label,
      nearestBarTime: +bar.t.toFixed(4),
      offsetMs: +((bar.t - cue.time) * 1000).toFixed(2),
      nearestBeatOffsetMs: +((beat - cue.time) * 1000).toFixed(2),
      sampleQuantisedOffsetMs: +(((Math.round(bar.t * SR) - cue.time * SR) / SR) * 1000).toFixed(3),
      offsetAtConstantNominalTempoMs: +constOffset.toFixed(0)
    };
  });
  return {
    id: preset.id,
    name: preset.name,
    status: preset.status,
    feel: preset.feel,
    key: preset.key,
    nominalBpm: preset.nominalBpm,
    tempoMap: tl.sections.map((s) => ({
      chapter: s.id,
      start: s.start,
      end: s.end,
      beats: s.beats,
      bars: s.bars.map((b) => (b === 4 ? "4/4" : `${b}/4 pickup`)).join(" ") + (s.gap ? ` + ${s.gap.toFixed(3)} s stop` : ""),
      bpm: +s.bpm.toFixed(2),
      deviationFromNominalPct: +(((s.bpm - preset.nominalBpm) / preset.nominalBpm) * 100).toFixed(2),
      ...(s.gap ? { stopSeconds: +s.gap.toFixed(3) } : {})
    })),
    progression: {
      intro: preset.form.intro.chords.join(" | "),
      ...Object.fromEntries(preset.form.sections.map((s) => [s.id, s.chords.join(" | ")])),
      endCard: preset.form.outro.chords[0]
    },
    cueAlignment,
    maxCueOffsetMs: Math.max(...cueAlignment.map((c) => Math.abs(c.offsetMs))),
    ...extra
  };
}

export async function writeWav24(path, L, R, seed = 1) {
  const n = Math.min(L.length, R.length);
  const dataSize = n * 6;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 6, 28);
  buf.writeUInt16LE(6, 32);
  buf.writeUInt16LE(24, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  const rng = makeRng(seed);
  const full = 8388607;
  let o = 44;
  for (let i = 0; i < n; i += 1) {
    for (const ch of [L, R]) {
      // TPDF dither at 1 LSB.
      const d = rng() - rng();
      const v = Math.round(clamp(ch[i], -1, 1) * full + d);
      buf.writeIntLE(clamp(v, -full - 1, full), o, 3);
      o += 3;
    }
  }
  await fs.writeFile(path, buf);
}
