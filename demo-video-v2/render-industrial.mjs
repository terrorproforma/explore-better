import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { generateIndustrialScore } from "./src/audio/industrial-score.mjs";

const workDir = path.resolve(process.cwd());
const root = path.resolve(workDir, "..");
const outputDir = path.join(workDir, "output");
const silentVideo = path.join(outputDir, "explore-better-hype-demo-v2-silent.mp4");
const score = path.join(outputDir, "explore-better-v3-industrial-score.wav");
const masteredScore = path.join(outputDir, "explore-better-v3-industrial-master.wav");
const video = path.join(outputDir, "explore-better-hype-demo-v3-industrial-1080p.mp4");
const spectrogram = path.join(outputDir, "explore-better-v3-industrial-spectrogram.png");
const waveform = path.join(outputDir, "explore-better-v3-industrial-waveform.png");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workDir,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      windowsHide: true
    });
    let output = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited with code ${code}\n${output}`)));
  });
}

await fs.mkdir(outputDir, { recursive: true });
await fs.access(silentVideo);
const arrangement = await generateIndustrialScore(score, { duration: 55, sampleRate: 48000, bpm: 116 });

await run(ffmpeg, [
  "-y", "-i", score,
  "-af", "volume=1.8dB,alimiter=limit=0.62:level=false",
  "-c:a", "pcm_s24le", masteredScore
]);

await run(ffmpeg, [
  "-y", "-i", silentVideo, "-i", masteredScore,
  "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
  "-movflags", "+faststart", "-shortest", video
]);

await run(ffmpeg, [
  "-y", "-i", masteredScore,
  "-lavfi", "showspectrumpic=s=1600x900:legend=disabled:scale=log:color=fiery:gain=4",
  "-frames:v", "1", "-update", "1", spectrogram
]);
await run(ffmpeg, [
  "-y", "-i", masteredScore,
  "-filter_complex", "showwavespic=s=1600x500:split_channels=1:colors=c7ff4a|f4f7f5",
  "-frames:v", "1", "-update", "1", waveform
]);

const masterLoudness = await run(ffmpeg, [
  "-hide_banner", "-i", video,
  "-af", "loudnorm=I=-14.5:TP=-1.1:LRA=6:print_format=json",
  "-f", "null", "NUL"
], { capture: true });
const metric = (name) => masterLoudness.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1] || "unknown";
const bytes = await fs.readFile(video);

const manifest = {
  title: "Explore Better - Original Industrial Score v3",
  generatedAt: new Date().toISOString(),
  direction: "Original brutal-minimal industrial techno synchronized to the approved product edit.",
  originality: "Procedural synthesis only; no samples, interpolations, or copied musical material.",
  arrangement,
  video: path.relative(root, video),
  silentPictureMaster: path.relative(root, silentVideo),
  sourceScore: path.relative(root, score),
  masteredScore: path.relative(root, masteredScore),
  spectrogram: path.relative(root, spectrogram),
  waveform: path.relative(root, waveform),
  audioMetrics: {
    integratedLufs: Number(metric("input_i")),
    truePeakDbtp: Number(metric("input_tp")),
    loudnessRangeLu: Number(metric("input_lra"))
  },
  integrity: {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase()
  }
};

await fs.writeFile(path.join(outputDir, "manifest-v3-industrial.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
