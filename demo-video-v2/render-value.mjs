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
const captureDir = path.join(workDir, "capture");
const capture = path.join(captureDir, "explore-better-live-walkthrough.mp4");
const captureManifestPath = path.join(captureDir, "capture-manifest.json");
const codexTracePath = path.join(captureDir, "codex-handoff-trace.json");
const publicCapture = path.join(publicDir, "live.mp4");
const silentVideo = path.join(outputDir, "explore-better-hype-demo-v5-value-codex-silent.mp4");
const rawScore = path.join(outputDir, "explore-better-v5-value-industrial-score.wav");
const masteredScore = path.join(outputDir, "explore-better-v5-value-industrial-master.wav");
const video = path.join(outputDir, "explore-better-hype-demo-v5-value-codex-1080p.mp4");
const poster = path.join(outputDir, "explore-better-v5-value-poster.png");
const contactSheet = path.join(outputDir, "explore-better-v5-value-contact-sheet.jpg");
const waveform = path.join(outputDir, "explore-better-v5-value-waveform.png");
const spectrogram = path.join(outputDir, "explore-better-v5-value-spectrogram.png");
const webVideo = path.join(siteAssets, "explore-better-demo.mp4");
const webPoster = path.join(siteAssets, "explore-better-demo-poster.webp");
const manifestPath = path.join(outputDir, "manifest-v5-value-codex.json");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const chrome = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const remotionCli = path.join(workDir, "node_modules", "@remotion", "cli", "remotion-cli.js");
const duration = 1935 / 30;

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
await Promise.all([fs.access(capture), fs.access(captureManifestPath), fs.access(codexTracePath), fs.access(remotionCli)]);
await fs.copyFile(capture, publicCapture);

await run(process.execPath, [
  remotionCli, "render", ".\\src\\index.jsx", "ExploreBetterValue", silentVideo,
  "--codec=h264", "--crf=17", "--pixel-format=yuv420p", "--concurrency=4",
  `--browser-executable=${chrome}`
]);

const sectionPoints = {
  human: 4,
  command: 6.8,
  disk: 11,
  safety: 16,
  terminal: 25,
  ai: 36.5,
  proof: 60,
  final: 62,
  end: duration
};
const cueTimes = [0.1, 4, 6.8, 11, 16, 25, 36.5, 39, 42, 45, 52, 60, 62];
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

await run(ffmpeg, ["-y", "-ss", "18.2", "-i", video, "-frames:v", "1", "-update", "1", poster]);
await run(ffmpeg, [
  "-y", "-i", video,
  "-vf", "fps=1/5.4,scale=384:216,tile=4x3:padding=8:margin=8:color=111715",
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
  "-y", "-ss", "18.2", "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2:flags=lanczos",
  "-c:v", "libwebp", "-quality", "82", "-compression_level", "6", webPoster
]);

const masterLoudness = await run(ffmpeg, [
  "-hide_banner", "-i", video,
  "-af", "loudnorm=I=-14.5:TP=-1.1:LRA=6:print_format=json",
  "-f", "null", "NUL"
], { capture: true });
const metric = (name) => masterLoudness.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1] || "unknown";
const [masterBytes, webBytes, captureManifest, codexTrace] = await Promise.all([
  fs.readFile(video),
  fs.readFile(webVideo),
  fs.readFile(captureManifestPath, "utf8").then(JSON.parse),
  fs.readFile(codexTracePath, "utf8").then(JSON.parse)
]);

const manifest = {
  title: "Explore Better - Value + Codex Demo v5",
  generatedAt: new Date().toISOString(),
  direction: "Outcome-led feature story with full-workspace establishing shots, restrained detail pushes, and a real read-only Codex MCP handoff replayed at edit speed.",
  timing: {
    durationSeconds: duration,
    pictureCuts: [16, 25, 36.5, 39, 42, 45, 52, 60],
    sectionPoints,
    chapters: [
      { time: 0, label: "Shared context" },
      { time: 4, label: "Find anything" },
      { time: 11, label: "Map every byte" },
      { time: 16, label: "Preview safely" },
      { time: 25, label: "Terminal ready" },
      { time: 36.5, label: "Codex handoff" },
      { time: 52, label: "Scope the AI" }
    ]
  },
  valueClaims: [
    "Go from thought to file without breaking flow.",
    "Find what is eating the drive visually.",
    "Know what will happen before a byte moves.",
    "Open a real shell already in the right folder.",
    "Give Codex the same live pane context without pasted paths or terminal scraping.",
    "Give every AI only the roots and tools it needs."
  ],
  codexEvidence: {
    realRun: true,
    replayedAtEditSpeed: true,
    profile: "demo-readonly",
    tools: codexTrace.events,
    sourceMarkers: captureManifest.markers.filter((marker) => marker.id.startsWith("codex-"))
  },
  capture: {
    resolution: captureManifest.resolution,
    durationSeconds: captureManifest.durationSeconds
  },
  arrangement,
  files: {
    video: path.relative(root, video),
    poster: path.relative(root, poster),
    contactSheet: path.relative(root, contactSheet),
    rawScore: path.relative(root, rawScore),
    masteredScore: path.relative(root, masteredScore),
    webVideo: path.relative(root, webVideo),
    webPoster: path.relative(root, webPoster),
    codexTrace: path.relative(root, codexTracePath)
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

await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
