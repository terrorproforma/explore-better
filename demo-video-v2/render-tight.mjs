import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { generateIndustrialScore } from "./src/audio/industrial-score.mjs";

const workDir = path.resolve(process.cwd());
const root = path.resolve(workDir, "..");
const outputDir = path.join(workDir, "output");
const publicDir = path.join(workDir, "public");
const siteAssets = path.join(root, "site", "assets");
const capture = path.join(workDir, "capture", "explore-better-live-walkthrough.mp4");
const publicCapture = path.join(publicDir, "live.mp4");
const silentVideo = path.join(outputDir, "explore-better-hype-demo-v4-tight-silent.mp4");
const rawScore = path.join(outputDir, "explore-better-v4-tight-industrial-score.wav");
const masteredScore = path.join(outputDir, "explore-better-v4-tight-industrial-master.wav");
const video = path.join(outputDir, "explore-better-hype-demo-v4-tight-industrial-1080p.mp4");
const poster = path.join(outputDir, "explore-better-v4-tight-poster.png");
const contactSheet = path.join(outputDir, "explore-better-v4-tight-contact-sheet.jpg");
const waveform = path.join(outputDir, "explore-better-v4-tight-waveform.png");
const spectrogram = path.join(outputDir, "explore-better-v4-tight-spectrogram.png");
const webVideo = path.join(siteAssets, "explore-better-demo.mp4");
const webPoster = path.join(siteAssets, "explore-better-demo-poster.webp");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const chrome = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const remotionCli = path.join(workDir, "node_modules", "@remotion", "cli", "remotion-cli.js");
const duration = 1370 / 30;

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
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited with code ${code}\n${output}`)));
  });
}

await Promise.all([
  fs.mkdir(outputDir, { recursive: true }),
  fs.mkdir(publicDir, { recursive: true }),
  fs.mkdir(siteAssets, { recursive: true })
]);
await fs.copyFile(capture, publicCapture);

try {
  await fs.access(silentVideo);
  console.log(`Reusing tight picture render: ${silentVideo}`);
} catch {
  await fs.access(remotionCli);
  await run(process.execPath, [
    remotionCli, "render", ".\\src\\index.jsx", "ExploreBetterTight", silentVideo,
    "--codec=h264", "--crf=17", "--pixel-format=yuv420p", "--concurrency=50%",
    `--browser-executable=${chrome}`
  ]);
}

const sectionPoints = {
  human: 4.27,
  command: 6.83,
  disk: 11.354,
  safety: 16.67,
  terminal: 25.6,
  ai: 35.83,
  proof: 40.6,
  final: 43,
  end: duration
};
const cueTimes = [0.1, 4.27, 7.245, 11.354, 17.621, 25.693, 36.2, 41.183, 43];
const arrangement = await generateIndustrialScore(rawScore, {
  duration,
  sampleRate: 48000,
  bpm: 116,
  cueTimes,
  sectionPoints
});

await run(ffmpeg, [
  "-y", "-i", rawScore,
  "-af", "volume=3dB,alimiter=limit=0.50:level=false",
  "-c:a", "pcm_s24le", masteredScore
]);
await run(ffmpeg, [
  "-y", "-i", silentVideo, "-i", masteredScore,
  "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
  "-movflags", "+faststart", "-shortest", video
]);

await run(ffmpeg, ["-y", "-ss", "17.85", "-i", video, "-frames:v", "1", "-update", "1", poster]);
await run(ffmpeg, [
  "-y", "-i", video,
  "-vf", "fps=1/4.3,scale=384:216,tile=4x3:padding=8:margin=8:color=111715",
  "-frames:v", "1", "-update", "1", "-q:v", "2", contactSheet
]);
await run(ffmpeg, [
  "-y", "-i", masteredScore,
  "-filter_complex", "showwavespic=s=1600x500:split_channels=1:colors=c7ff4a|f4f7f5",
  "-frames:v", "1", "-update", "1", waveform
]);
await run(ffmpeg, [
  "-y", "-i", masteredScore,
  "-lavfi", "showspectrumpic=s=1600x900:legend=disabled:scale=log:color=fiery:gain=4",
  "-frames:v", "1", "-update", "1", spectrogram
]);

await run(ffmpeg, [
  "-y", "-i", video,
  "-vf", "scale=1280:-2:flags=lanczos", "-c:v", "libx264", "-preset", "medium", "-crf", "23",
  "-maxrate", "3200k", "-bufsize", "6400k", "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
  "-movflags", "+faststart", webVideo
]);
await run(ffmpeg, [
  "-y", "-ss", "17.85", "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2:flags=lanczos",
  "-c:v", "libwebp", "-quality", "82", "-compression_level", "6", webPoster
]);

const masterLoudness = await run(ffmpeg, [
  "-hide_banner", "-i", video,
  "-af", "loudnorm=I=-14.5:TP=-1.1:LRA=6:print_format=json",
  "-f", "null", "NUL"
], { capture: true });
const metric = (name) => masterLoudness.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1] || "unknown";
const masterBytes = await fs.readFile(video);
const webBytes = await fs.readFile(webVideo);

const manifest = {
  title: "Explore Better - Tight Website Demo v4",
  generatedAt: new Date().toISOString(),
  timing: {
    durationSeconds: duration,
    removedSeconds: 55 - duration,
    pictureCuts: [16.8, 25.2, 33.4, 40.7],
    sectionPoints
  },
  direction: "Tighter product-led edit with motivated cuts, earlier safety proof, and an original industrial score rebuilt around the revised markers.",
  arrangement,
  files: {
    video: path.relative(root, video),
    poster: path.relative(root, poster),
    contactSheet: path.relative(root, contactSheet),
    rawScore: path.relative(root, rawScore),
    masteredScore: path.relative(root, masteredScore),
    webVideo: path.relative(root, webVideo),
    webPoster: path.relative(root, webPoster)
  },
  audioMetrics: {
    integratedLufs: Number(metric("input_i")),
    truePeakDbtp: Number(metric("input_tp")),
    loudnessRangeLu: Number(metric("input_lra"))
  },
  integrity: {
    masterBytes: masterBytes.byteLength,
    masterSha256: createHash("sha256").update(masterBytes).digest("hex").toUpperCase(),
    webBytes: webBytes.byteLength,
    webSha256: createHash("sha256").update(webBytes).digest("hex").toUpperCase()
  }
};

await fs.writeFile(path.join(outputDir, "manifest-v4-tight.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
