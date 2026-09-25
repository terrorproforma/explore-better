// Renders the v6 cut from the real capture produced by `npm run capture`.
//
//   npm run render:v6                 full master, silent cut, score, web assets, review files
//   npm run render:v6 -- --stills 90,600   only render review stills (frame numbers) for iteration
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { generateIndustrialScore } from "./src/audio/industrial-score.mjs";
import { buildV6Edit, FPS } from "./src/v6-edit.mjs";

const workDir = import.meta.dirname;
const root = path.resolve(workDir, "..");
const outputDir = path.join(workDir, "output");
const reviewDir = path.join(outputDir, "review-v6");
const publicDir = path.join(workDir, "public");
const siteAssets = path.join(root, "site", "assets");
const captureDir = path.join(workDir, "capture");
const capture = path.join(captureDir, "explore-better-live-walkthrough.mp4");
const captureManifestPath = path.join(captureDir, "capture-manifest.json");
const tracePath = path.join(captureDir, "ai-handoff-trace.json");
const publicCapture = path.join(publicDir, "live.mp4");
const propsPath = path.join(outputDir, "v6-props.json");
const silentVideo = path.join(outputDir, "explore-better-hype-demo-v6-silent.mp4");
const rawScore = path.join(outputDir, "explore-better-v6-score.wav");
const masteredScore = path.join(outputDir, "explore-better-v6-score-master.wav");
const video = path.join(outputDir, "explore-better-hype-demo-v6-1080p.mp4");
const poster = path.join(outputDir, "explore-better-v6-poster.png");
const contactSheet = path.join(outputDir, "explore-better-v6-contact-sheet.jpg");
const captionsVtt = path.join(outputDir, "explore-better-demo-v6.vtt");
const webVideo = path.join(siteAssets, "explore-better-demo.mp4");
const webPoster = path.join(siteAssets, "explore-better-demo-poster.webp");
const manifestPath = path.join(outputDir, "manifest-v6.json");
const chaptersPath = path.join(workDir, "chapters-v6.json");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const chrome = process.env.CHROME_PATH || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const remotionCli = path.join(workDir, "node_modules", "@remotion", "cli", "remotion-cli.js");
const webBudgetBytes = 8 * 1024 * 1024;
const posterBudgetBytes = 120 * 1024;

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
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} exited with code ${code}\n${output.slice(-3000)}`)));
  });
}

const browserArgs = existsSync(chrome) ? [`--browser-executable=${chrome}`] : [];
const timecode = (seconds) => {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};
const vttTime = (seconds) => {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

await Promise.all([fs.mkdir(outputDir, { recursive: true }), fs.mkdir(publicDir, { recursive: true }), fs.mkdir(siteAssets, { recursive: true })]);
await Promise.all([fs.access(capture), fs.access(captureManifestPath), fs.access(remotionCli)]);
const captureManifest = JSON.parse(await fs.readFile(captureManifestPath, "utf8"));
const trace = existsSync(tracePath) ? JSON.parse(await fs.readFile(tracePath, "utf8")) : null;
const edit = buildV6Edit(captureManifest, trace);
await fs.writeFile(propsPath, `${JSON.stringify({ edit }, null, 2)}\n`);
const captureStat = await fs.stat(capture);
const publicStat = await fs.stat(publicCapture).catch(() => null);
if (!publicStat || publicStat.size !== captureStat.size || publicStat.mtimeMs < captureStat.mtimeMs) await fs.copyFile(capture, publicCapture);

const stillsIndex = process.argv.indexOf("--stills");
if (stillsIndex > 0) {
  await fs.mkdir(reviewDir, { recursive: true });
  const frames = String(process.argv[stillsIndex + 1] || "").split(",").map(Number).filter(Number.isFinite);
  for (const frame of frames) {
    await run(process.execPath, [
      remotionCli, "still", ".\\src\\index.jsx", "ExploreBetterV6", path.join(reviewDir, `still-${String(frame).padStart(4, "0")}.png`),
      `--props=${propsPath}`, `--frame=${frame}`, ...browserArgs, "--log=error"
    ]);
  }
  console.log(JSON.stringify({ durationSeconds: edit.durationInFrames / FPS, chapters: edit.chapters.map((c) => [c.id, c.startFrame, c.endFrame]) }, null, 2));
  process.exit(0);
}

// 1. Picture.
await run(process.execPath, [
  remotionCli, "render", ".\\src\\index.jsx", "ExploreBetterV6", silentVideo,
  `--props=${propsPath}`, "--codec=h264", "--crf=16", "--pixel-format=yuv420p", "--color-space=bt709", "--concurrency=6", ...browserArgs
]);

// 2. Original score, re-timed to this edit.
const duration = edit.durationInFrames / FPS;
const arrangement = await generateIndustrialScore(rawScore, {
  duration,
  sampleRate: 48000,
  bpm: 120,
  cueTimes: edit.score.cueTimes,
  sectionPoints: edit.score.sectionPoints
});
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", rawScore, "-af", "volume=3dB,alimiter=limit=0.5:level=false,loudnorm=I=-15:TP=-1.5:LRA=7", "-ar", "48000", "-c:a", "pcm_s24le", masteredScore]);
await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error", "-i", silentVideo, "-i", masteredScore,
  "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
  "-movflags", "+faststart", "-shortest", video
]);

// 3. Web cut: two-pass H.264 sized to the landing-page budget.
const audioKbps = 96;
const webVideoKbps = Math.floor((webBudgetBytes * 8 * 0.93) / duration / 1000 - audioKbps);
const passLog = path.join(outputDir, "v6-web-pass");
const webArgs = ["-vf", "scale=1600:900:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-b:v", `${webVideoKbps}k`, "-maxrate", `${Math.round(webVideoKbps * 2.2)}k`, "-bufsize", `${webVideoKbps * 4}k`, "-g", "60", "-passlogfile", passLog];
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", video, ...webArgs, "-pass", "1", "-an", "-f", "mp4", "NUL"]);
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", video, ...webArgs, "-pass", "2", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ar", "48000", "-movflags", "+faststart", webVideo]);
for (const suffix of ["-0.log", "-0.log.mbtree"]) await fs.rm(`${passLog}${suffix}`, { force: true });

// 4. Poster: the hero frame (title over the real workspace).
const posterSeconds = 2.0;
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(posterSeconds), "-i", video, "-frames:v", "1", "-update", "1", poster]);
let posterQuality = 82;
for (;;) {
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", poster, "-vf", "scale=1600:900:flags=lanczos", "-c:v", "libwebp", "-quality", String(posterQuality), "-compression_level", "6", webPoster]);
  const { size } = await fs.stat(webPoster);
  if (size <= posterBudgetBytes || posterQuality <= 50) break;
  posterQuality -= 6;
}

// 5. Review sheet: one frame every two seconds.
await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error", "-i", video,
  "-vf", "fps=1/2,scale=384:216,tile=6x5:padding=6:margin=6:color=111715",
  "-frames:v", "1", "-update", "1", "-q:v", "2", contactSheet
]);

// 6. Chapters and silent-safe captions (the captions are burned in; the VTT mirrors them).
const chapterList = edit.chapters.map((chapter) => ({
  id: chapter.id,
  title: chapter.title,
  start: Number((chapter.startFrame / FPS).toFixed(2)),
  end: Number((chapter.endFrame / FPS).toFixed(2)),
  label: timecode(chapter.startFrame / FPS)
}));
const captionList = edit.captions.map((caption) => ({
  start: Number((caption.from / FPS).toFixed(2)),
  end: Number(((caption.from + caption.duration) / FPS).toFixed(2)),
  eyebrow: caption.eyebrow,
  headline: caption.headline,
  detail: caption.detail || null,
  proof: caption.proof
}));
const openChapter = edit.chapters.find((chapter) => chapter.id === "open");
const vttCues = [
  { start: 0, end: openChapter.endFrame / FPS, text: "The Windows file manager built for humans and AI.\nReal app footage, v0.2.7" },
  ...captionList.map((caption) => ({ start: caption.start, end: caption.end, text: [caption.headline, caption.detail, caption.proof.join(" / ")].filter(Boolean).join("\n") })),
  { start: edit.endFrom / FPS, end: duration, text: "Explore Better: download for Windows\nterrorproforma.github.io/explore-better" }
];
await fs.writeFile(captionsVtt, `WEBVTT\n\n${vttCues.map((cue, index) => `${index + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}\n`).join("\n")}`);
await fs.writeFile(chaptersPath, `${JSON.stringify({
  version: 6,
  video: "site/assets/explore-better-demo.mp4",
  poster: "site/assets/explore-better-demo-poster.webp",
  durationSeconds: Number(duration.toFixed(2)),
  chapters: chapterList.map(({ id, title, start, label }) => ({ id, title, start, label }))
}, null, 2)}\n`);

// 7. Manifest.
const loudness = await run(ffmpeg, ["-hide_banner", "-i", video, "-af", "loudnorm=I=-15:TP=-1.5:LRA=7:print_format=json", "-f", "null", "NUL"], { capture: true });
const metric = (name) => Number(loudness.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1]);
const [masterBytes, silentBytes, webBytes, posterBytes] = await Promise.all([video, silentVideo, webVideo, webPoster].map((file) => fs.readFile(file)));
const manifest = {
  title: "Explore Better - v6 product demo",
  generatedAt: new Date().toISOString(),
  direction: "Outcome-led, product-first cut of one continuous real app session: filtered search, exact disk map, transfer preview into a live transactional copy, safe rename, keyboard menus, folder-following terminal, a real MCP client handoff and the scoped AI Bridge audit trail. Captions carry the story with the sound off.",
  durationSeconds: Number(duration.toFixed(3)),
  frames: edit.durationInFrames,
  fps: FPS,
  resolution: "1920x1080",
  chapters: chapterList,
  captions: captionList,
  clips: edit.clips.map((clip) => ({ id: clip.id, chapter: clip.chapter, outputStart: Number((clip.from / FPS).toFixed(3)), duration: Number((clip.duration / FPS).toFixed(3)), sourceSeconds: clip.sourceSeconds })),
  capture: {
    capturedAt: captureManifest.capturedAt,
    resolution: captureManifest.resolution,
    viewport: captureManifest.viewport,
    durationSeconds: captureManifest.durationSeconds,
    sourceRate: captureManifest.sourceRate,
    demoRoot: captureManifest.demoRoot,
    texts: captureManifest.texts
  },
  aiEvidence: {
    client: captureManifest.aiClient,
    realRun: true,
    profile: "demo-readonly",
    access: "read-only",
    modelThinkingTrimmedSeconds: edit.ai.trimmedSeconds,
    calls: (captureManifest.aiEvents || []).filter((event) => event.phase === "complete").map(({ tool, detail, seconds }) => ({ tool, detail, sourceSeconds: seconds }))
  },
  score: { ...arrangement, integratedLufs: metric("input_i"), truePeakDbtp: metric("input_tp"), loudnessRangeLu: metric("input_lra") },
  files: {
    master: { path: path.relative(root, video), bytes: masterBytes.byteLength, sha256: sha256(masterBytes) },
    silent: { path: path.relative(root, silentVideo), bytes: silentBytes.byteLength, sha256: sha256(silentBytes) },
    web: { path: path.relative(root, webVideo), bytes: webBytes.byteLength, sha256: sha256(webBytes), videoKbps: webVideoKbps, resolution: "1600x900" },
    webPoster: { path: path.relative(root, webPoster), bytes: posterBytes.byteLength, sha256: sha256(posterBytes), quality: posterQuality },
    poster: path.relative(root, poster),
    contactSheet: path.relative(root, contactSheet),
    captions: path.relative(root, captionsVtt),
    chapters: path.relative(root, chaptersPath),
    score: path.relative(root, masteredScore)
  }
};
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (webBytes.byteLength > webBudgetBytes) throw new Error(`Web video is ${webBytes.byteLength} bytes, over the ${webBudgetBytes} byte budget.`);
if (posterBytes.byteLength > posterBudgetBytes) throw new Error(`Web poster is ${posterBytes.byteLength} bytes, over the ${posterBudgetBytes} byte budget.`);
console.log(JSON.stringify({ durationSeconds: manifest.durationSeconds, chapters: chapterList, files: manifest.files, score: { lufs: manifest.score.integratedLufs, truePeak: manifest.score.truePeakDbtp } }, null, 2));
