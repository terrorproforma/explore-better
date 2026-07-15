import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const workDir = path.resolve(process.cwd());
const root = path.resolve(workDir, "..");
const outputDir = path.join(workDir, "output");
const publicDir = path.join(workDir, "public");
const capture = path.join(workDir, "capture", "explore-better-live-walkthrough.mp4");
const publicCapture = path.join(publicDir, "live.mp4");
const silentVideo = path.join(outputDir, "explore-better-hype-demo-v2-silent.mp4");
const score = path.join(outputDir, "explore-better-v2-original-score.wav");
const video = path.join(outputDir, "explore-better-hype-demo-v2-1080p.mp4");
const poster = path.join(outputDir, "explore-better-hype-demo-v2-poster.png");
const contactSheet = path.join(outputDir, "explore-better-hype-demo-v2-contact-sheet.jpg");
const auditSheet = path.join(outputDir, "explore-better-hype-demo-v2-audit-sheet.jpg");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const chrome = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const remotionCli = path.join(workDir, "node_modules", "@remotion", "cli", "remotion-cli.js");
const duration = 55;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || workDir,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      windowsHide: true
    });
    let output = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} exited with ${code}\n${output.slice(-6000)}`)));
  });
}

function writeWav(left, right, sampleRate, outPath) {
  const frames = left.length;
  const dataSize = frames * 4;
  const buffer = Buffer.alloc(44 + dataSize);
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
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(Math.round(clamp(left[i], -1, 1) * 32767), 44 + i * 4);
    buffer.writeInt16LE(Math.round(clamp(right[i], -1, 1) * 32767), 46 + i * 4);
  }
  return fs.writeFile(outPath, buffer);
}

function noteFrequency(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

async function generateScore(outPath) {
  const sampleRate = 48_000;
  const frames = Math.ceil(duration * sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const bpm = 126;
  const beat = 60 / bpm;
  const roots = [38, 41, 34, 36];
  const impactTimes = [0.1, 5.2, 10.3, 13.7, 19.5, 28.8, 41.3, 47.9, 51.2];
  let seed = 0x2f76b1a5;
  const noise = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const beatIndex = Math.floor(t / beat);
    const beatPhase = (t % beat) / beat;
    const eighthPhase = (t % (beat / 2)) / (beat / 2);
    const root = roots[Math.floor(beatIndex / 4) % roots.length];
    const fade = clamp(t / 1.4, 0, 1) * clamp((duration - t) / 1.6, 0, 1);
    const sidechain = 0.58 + 0.42 * clamp(beatPhase * 4.5, 0, 1);

    const padEnv = 0.5 + 0.5 * Math.sin(Math.PI * ((t % (beat * 4)) / (beat * 4)));
    const chord = [0, 3, 7, 10];
    let padL = 0;
    let padR = 0;
    for (let n = 0; n < chord.length; n += 1) {
      const f = noteFrequency(root + 12 + chord[n]);
      padL += Math.sin(2 * Math.PI * f * (0.9985 - n * 0.0003) * t + n * 0.62);
      padR += Math.sin(2 * Math.PI * f * (1.0015 + n * 0.0003) * t + n * 0.91);
    }
    padL *= 0.028 * padEnv * sidechain;
    padR *= 0.028 * padEnv * sidechain;

    const bassF = noteFrequency(root);
    const bass = (Math.sin(2 * Math.PI * bassF * t) + 0.22 * Math.sin(2 * Math.PI * bassF * 2 * t)) * Math.exp(-beatPhase * 4.2) * 0.13;
    const arpNotes = [12, 19, 22, 15, 24, 19, 15, 22];
    const arpF = noteFrequency(root + arpNotes[Math.floor(t / (beat / 2)) % arpNotes.length]);
    const arp = (Math.sin(2 * Math.PI * arpF * t) + 0.25 * Math.sin(2 * Math.PI * arpF * 2 * t)) * Math.exp(-eighthPhase * 8) * 0.042;

    const kickF = 48 + 86 * Math.exp(-beatPhase * 32);
    const kick = Math.sin(2 * Math.PI * kickF * t) * Math.exp(-beatPhase * 13) * 0.27;
    const snare = (beatIndex % 4 === 1 || beatIndex % 4 === 3) ? noise() * Math.exp(-beatPhase * 20) * 0.09 : 0;
    const hat = noise() * Math.exp(-eighthPhase * 26) * 0.025;

    let edit = 0;
    let rise = 0;
    for (const point of impactTimes) {
      const after = t - point;
      if (after >= 0 && after < 0.48) edit += Math.sin(2 * Math.PI * (62 - after * 24) * after) * Math.exp(-after * 8) * 0.22;
      const before = point - t;
      if (before >= 0 && before < 0.28) rise += noise() * (1 - before / 0.28) * 0.035;
    }

    // Short, tactile ticks during the two typing moments.
    let tick = 0;
    for (const start of [2.9, 8.0, 20.2, 30.5, 42.0]) {
      const local = t - start;
      if (local >= 0 && local < 2.6) {
        const phase = local % 0.18;
        tick += noise() * Math.exp(-phase * 90) * 0.024;
      }
    }
    const mono = bass + arp + kick + snare + hat + edit + rise + tick;
    const rawLeft = (padL + mono) * fade * 0.62;
    const rawRight = (padR + mono * 0.98) * fade * 0.62;
    left[i] = Math.tanh(rawLeft * 1.35) * 0.54;
    right[i] = Math.tanh(rawRight * 1.35) * 0.54;
  }
  await writeWav(left, right, sampleRate, outPath);
}

await fs.mkdir(publicDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });
await fs.copyFile(capture, publicCapture);
await generateScore(score);

try {
  await fs.access(silentVideo);
  console.log(`Reusing completed visual render: ${silentVideo}`);
} catch {
  await run(process.execPath, [
    remotionCli, "render", ".\\src\\index.jsx", "ExploreBetterV2", silentVideo,
    "--codec=h264", "--crf=17", "--pixel-format=yuv420p", "--concurrency=50%",
    `--browser-executable=${chrome}`
  ]);
}

const target = { integrated: -14, peak: -2.4, range: 7 };
const passOne = await run(ffmpeg, [
  "-hide_banner", "-i", score,
  "-af", `afade=t=in:st=0:d=0.45,afade=t=out:st=53.3:d=1.7,loudnorm=I=${target.integrated}:TP=${target.peak}:LRA=${target.range}:print_format=json`,
  "-f", "null", "NUL"
], { capture: true });
const match = passOne.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
if (!match) throw new Error("Could not parse loudness analysis.");
const measured = JSON.parse(match);

await run(ffmpeg, [
  "-y", "-i", silentVideo, "-i", score,
  "-filter_complex", `[1:a]afade=t=in:st=0:d=0.45,afade=t=out:st=53.3:d=1.7,loudnorm=I=${target.integrated}:TP=${target.peak}:LRA=${target.range}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=false,aresample=48000,alimiter=limit=0.45:level=false[a]`,
  "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
  "-movflags", "+faststart", "-shortest", video
]);

await run(ffmpeg, ["-y", "-ss", "46.5", "-i", video, "-frames:v", "1", "-update", "1", poster]);
await run(ffmpeg, [
  "-y", "-i", video,
  "-vf", "fps=1/6.6,scale=480:270,tile=3x3:padding=8:margin=8:color=111715",
  "-frames:v", "1", "-update", "1", "-q:v", "2", contactSheet
]);
await run(ffmpeg, [
  "-y", "-i", video,
  "-vf", "fps=1/3.4,scale=480:-1,tile=4x4:padding=8:margin=8:color=111715",
  "-frames:v", "1", "-update", "1", "-q:v", "2", auditSheet
]);

const masterLoudness = await run(ffmpeg, [
  "-hide_banner", "-i", video,
  "-af", "loudnorm=I=-14:TP=-2.4:LRA=7:print_format=json",
  "-f", "null", "NUL"
], { capture: true });
const masterMetric = (name) => masterLoudness.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1] || "unknown";
const videoBytes = await fs.readFile(video);
const sha256 = createHash("sha256").update(videoBytes).digest("hex").toUpperCase();

const manifest = {
  title: "Explore Better - Website-matched Hype Demo v2",
  generatedAt: new Date().toISOString(),
  durationSeconds: duration,
  resolution: "1920x1080",
  frameRate: "30 fps",
  video: path.relative(root, video),
  poster: path.relative(root, poster),
  contactSheet: path.relative(root, contactSheet),
  auditSheet: path.relative(root, auditSheet),
  sourceFootage: path.relative(root, capture),
  direction: "Continuous real app interaction with website-matched ink, lime, paper, type and copy.",
  audio: "Original procedural electronic score; two-pass normalization followed by AAC-safe true-peak limiting.",
  audioMetrics: {
    integratedLufs: Number(masterMetric("input_i")),
    truePeakDbtp: Number(masterMetric("input_tp")),
    loudnessRangeLu: Number(masterMetric("input_lra"))
  },
  integrity: {
    bytes: videoBytes.byteLength,
    sha256
  },
  claims: {
    searchLatency: "54.7x lower median search latency (published website benchmark)",
    typedTools: "28 tools typed local MCP surface",
    recovery: "Preview + undo recoverable file changes"
  }
};
await fs.writeFile(path.join(outputDir, "manifest-v2.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
