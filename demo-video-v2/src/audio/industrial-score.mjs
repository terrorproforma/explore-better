import { promises as fs } from "node:fs";

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fract(value) {
  return value - Math.floor(value);
}

function smoothstep(edge0, edge1, value) {
  const x = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return x * x * (3 - 2 * x);
}

function window(t, start, end, attack = 0.18, release = 0.24) {
  return smoothstep(start, start + attack, t) * (1 - smoothstep(end - release, end, t));
}

function noteFrequency(base, semitones) {
  return base * 2 ** (semitones / 12);
}

function pulse(phase, width = 0.5) {
  return fract(phase) < width ? 1 : -1;
}

function saw(phase) {
  return fract(phase) * 2 - 1;
}

async function writeStereoWav(left, right, sampleRate, outputPath) {
  const frames = Math.min(left.length, right.length);
  const dataSize = frames * 4;
  const buffer = Buffer.allocUnsafe(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < frames; index += 1) {
    const offset = 44 + index * 4;
    buffer.writeInt16LE(Math.round(clamp(left[index], -1, 1) * 32767), offset);
    buffer.writeInt16LE(Math.round(clamp(right[index], -1, 1) * 32767), offset + 2);
  }
  await fs.writeFile(outputPath, buffer);
}

export async function generateIndustrialScore(outputPath, options = {}) {
  const sampleRate = options.sampleRate || 48000;
  const duration = options.duration || 55;
  const bpm = options.bpm || 116;
  const beatSeconds = 60 / bpm;
  const totalFrames = Math.floor(sampleRate * duration);
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  const sectionPoints = {
    human: 5.2,
    command: 10.3,
    disk: 13.7,
    safety: 19.5,
    terminal: 28.8,
    ai: 41.3,
    proof: 47.9,
    final: 51.2,
    end: duration,
    ...options.sectionPoints
  };
  const cueTimes = options.cueTimes || [0.1, 5.2, 10.3, 13.7, 19.5, 28.8, 41.3, 47.9, 51.2];
  const preKickStart = Math.max(0, sectionPoints.human - beatSeconds * 4);
  const motif = [0, 0, 3, -2, 0, 5, 3, -5];
  const upperMotif = [0, 3, 7, 3, -2, 3, 5, 0];
  const root = 36.7081; // D1

  let randomState = 0x4e554c4c;
  const noise = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return ((randomState >>> 0) / 0xffffffff) * 2 - 1;
  };

  let bassLowpass = 0;
  let droneLowpassL = 0;
  let droneLowpassR = 0;
  let noiseLowpassL = 0;
  let noiseLowpassR = 0;
  let previousInputL = 0;
  let previousInputR = 0;
  let highpassL = 0;
  let highpassR = 0;

  for (let index = 0; index < totalFrames; index += 1) {
    const t = index / sampleRate;
    const intro = window(t, 0, sectionPoints.human, 0.5, 0.35);
    const human = window(t, sectionPoints.human, sectionPoints.command);
    const command = window(t, sectionPoints.command, sectionPoints.disk, 0.1, 0.14);
    const disk = window(t, sectionPoints.disk, sectionPoints.safety, 0.1, 0.26);
    const safety = window(t, sectionPoints.safety, sectionPoints.terminal, 0.16, 0.36);
    const terminal = window(t, sectionPoints.terminal, sectionPoints.ai, 0.12, 0.34);
    const ai = window(t, sectionPoints.ai, sectionPoints.proof, 0.12, 0.26);
    const proof = window(t, sectionPoints.proof, sectionPoints.final, 0.08, 0.2);
    const final = window(t, sectionPoints.final, sectionPoints.end, 0.08, 1.45);

    const driveEnergy = human * 0.52 + command * 0.68 + disk * 0.92 + safety * 0.28 + terminal + ai * 0.9 + proof * 0.68;
    const grid = (t - sectionPoints.human) / beatSeconds;
    const beatIndex = Math.floor(grid);
    const beatPhase = fract(grid);
    const halfGrid = grid * 2;
    const halfIndex = Math.floor(halfGrid);
    const halfPhase = fract(halfGrid);
    const quarterPhase = fract(grid * 4);

    // A low, unstable machine-room drone establishes the threat before the beat.
    const drift = Math.sin(TAU * 0.071 * t) * 0.006 + Math.sin(TAU * 0.113 * t) * 0.004;
    const droneNoiseL = noise();
    const droneNoiseR = noise();
    droneLowpassL += (droneNoiseL - droneLowpassL) * 0.00115;
    droneLowpassR += (droneNoiseR - droneLowpassR) * 0.00109;
    const droneToneL = Math.sin(TAU * (root + drift) * t) * 0.48 + Math.sin(TAU * root * 1.498 * t + 0.3) * 0.16;
    const droneToneR = Math.sin(TAU * (root + drift * 0.93) * t + 0.025) * 0.48 + Math.sin(TAU * root * 1.502 * t + 0.72) * 0.16;
    const droneAmount = 0.11 + intro * 0.19 + safety * 0.13 + final * 0.2;
    let padL = (droneToneL + droneLowpassL * 0.92) * droneAmount;
    let padR = (droneToneR + droneLowpassR * 0.92) * droneAmount;

    // Original eight-step bass cell: terse, monophonic and deliberately unresolved.
    let bass = 0;
    if (t >= sectionPoints.human && t < sectionPoints.final) {
      const motifIndex = ((halfIndex % motif.length) + motif.length) % motif.length;
      const frequency = noteFrequency(root, motif[motifIndex]);
      const gate = Math.exp(-halfPhase * (3.7 + safety * 2.8));
      const sparseSafety = safety > 0.25 ? (beatIndex % 4 === 0 ? 1 : 0.12) : 1;
      const raw = pulse(t * frequency, 0.43) * 0.62 + saw(t * frequency * 0.5) * 0.38;
      const cutoff = 75 + gate * (92 + driveEnergy * 170);
      const alpha = 1 - Math.exp((-TAU * cutoff) / sampleRate);
      bassLowpass += (raw - bassLowpass) * alpha;
      const amplitude = (0.16 + driveEnergy * 0.34) * gate * sparseSafety;
      bass = Math.tanh(bassLowpass * (3.6 + driveEnergy * 2.4)) * amplitude;
      bass += Math.sin(TAU * frequency * 0.5 * t) * amplitude * 0.22;
    }

    // Mechanical kick grid. The transfer preview intentionally drops to half-time.
    let kick = 0;
    let kickEnvelope = 0;
    if (t >= preKickStart && t < sectionPoints.final) {
      const preGrid = (t - preKickStart) / (beatSeconds * 2);
      const introBeatPhase = fract(preGrid);
      const introKick = t < sectionPoints.human && Math.floor(preGrid) >= 0;
      const safetyKick = safety > 0.25 && beatIndex % 2 === 0;
      const activeKick = introKick || (t >= sectionPoints.human && (safety > 0.25 ? safetyKick : true));
      const phase = introKick ? introBeatPhase : beatPhase;
      const local = phase * (introKick ? beatSeconds * 2 : beatSeconds);
      if (activeKick && local < 0.42) {
        kickEnvelope = Math.exp(-local * 9.6);
        const phaseIntegral = 43 * local + (108 / 28) * (1 - Math.exp(-28 * local));
        kick = Math.sin(TAU * phaseIntegral) * kickEnvelope * (0.42 + driveEnergy * 0.22);
        kick += noise() * Math.exp(-local * 82) * 0.11;
      }
    }

    // Dry metallic backbeat and high-frequency machine ticks.
    let snare = 0;
    let hatsL = 0;
    let hatsR = 0;
    if (t >= sectionPoints.disk && t < sectionPoints.final && safety < 0.25) {
      const local = beatPhase * beatSeconds;
      if (beatIndex % 2 !== 0 && local < 0.24) {
        const envelope = Math.exp(-local * 18);
        const white = noise();
        noiseLowpassL += (white - noiseLowpassL) * 0.065;
        const high = white - noiseLowpassL;
        snare = (high * 0.4 + Math.sin(TAU * 181 * local) * 0.21 + Math.sin(TAU * 317 * local) * 0.11) * envelope * (0.54 + terminal * 0.22);
      }
      const hatLocal = quarterPhase * beatSeconds * 0.25;
      const hatEnvelope = Math.exp(-hatLocal * (terminal > 0.4 ? 72 : 92));
      const whiteL = noise();
      const whiteR = noise();
      noiseLowpassL += (whiteL - noiseLowpassL) * 0.12;
      noiseLowpassR += (whiteR - noiseLowpassR) * 0.12;
      const highL = whiteL - noiseLowpassL;
      const highR = whiteR - noiseLowpassR;
      const alternating = (Math.floor(grid * 4) & 1) === 0;
      const hatGain = (0.026 + terminal * 0.034 + ai * 0.024) * hatEnvelope;
      hatsL = highL * hatGain * (alternating ? 1.3 : 0.7);
      hatsR = highR * hatGain * (alternating ? 0.7 : 1.3);
    }

    // In the AI Bridge section, a narrow upper pulse answers the bass without resolving it.
    let upperL = 0;
    let upperR = 0;
    if (ai > 0.05) {
      const patternIndex = ((halfIndex % upperMotif.length) + upperMotif.length) % upperMotif.length;
      const frequency = noteFrequency(root * 4, upperMotif[patternIndex]);
      const envelope = Math.exp(-halfPhase * 7.2) * ai;
      const tone = (pulse(t * frequency, 0.19) * 0.7 + Math.sin(TAU * frequency * t) * 0.3) * envelope * 0.09;
      upperL = tone * (patternIndex % 2 ? 0.55 : 1);
      upperR = tone * (patternIndex % 2 ? 1 : 0.55);
    }

    // Every major visual transition gets its own bespoke hit and pre-roll pressure ramp.
    let impact = 0;
    let pressureL = 0;
    let pressureR = 0;
    for (const cue of cueTimes) {
      const after = t - cue;
      if (after >= 0 && after < 0.95) {
        const sub = Math.sin(TAU * (47 * after + 3.2 * (1 - Math.exp(-9 * after)))) * Math.exp(-after * 4.1);
        const metal = (Math.sin(TAU * 227 * after) + Math.sin(TAU * 419 * after) * 0.52) * Math.exp(-after * 13.5);
        impact += sub * 0.22 + metal * 0.065 + noise() * Math.exp(-after * 34) * 0.12;
      }
      const before = cue - t;
      if (before > 0 && before < 0.72) {
        const rise = 1 - before / 0.72;
        const amount = rise * rise * 0.055;
        pressureL += (noise() - noiseLowpassL) * amount;
        pressureR += (noise() - noiseLowpassR) * amount;
      }
    }

    // Final lockup: the machine stops and leaves a sustained, unresolved low interval.
    let finalChordL = 0;
    let finalChordR = 0;
    if (final > 0) {
      const finalLocal = t - sectionPoints.final;
      const swell = smoothstep(0, 0.5, finalLocal) * final;
      finalChordL = (Math.sin(TAU * root * finalLocal) * 0.55 + Math.sin(TAU * root * 1.5 * finalLocal + 0.4) * 0.18) * swell * 0.32;
      finalChordR = (Math.sin(TAU * root * finalLocal + 0.02) * 0.55 + Math.sin(TAU * root * 1.5 * finalLocal + 0.8) * 0.18) * swell * 0.32;
    }

    const sidechain = 1 - kickEnvelope * (0.26 + terminal * 0.12);
    padL *= sidechain;
    padR *= sidechain;
    bass *= 1 - kickEnvelope * 0.18;

    const masterFade = smoothstep(0, 0.28, t) * (1 - smoothstep(sectionPoints.end - 1.55, sectionPoints.end, t));
    const mono = bass + kick + snare + impact;
    const rawL = (padL + mono + hatsL + upperL + pressureL + finalChordL) * masterFade;
    const rawR = (padR + mono + hatsR + upperR + pressureR + finalChordR) * masterFade;

    // DC blocking and asymmetric saturation keep the low end huge without eating headroom.
    highpassL = rawL - previousInputL + 0.9975 * highpassL;
    highpassR = rawR - previousInputR + 0.9975 * highpassR;
    previousInputL = rawL;
    previousInputR = rawR;
    left[index] = Math.tanh(highpassL * 1.72) * 0.72;
    right[index] = Math.tanh(highpassR * 1.72) * 0.72;
  }

  await writeStereoWav(left, right, sampleRate, outputPath);
  return { duration, sampleRate, bpm, cueTimes, motif, sectionPoints };
}
