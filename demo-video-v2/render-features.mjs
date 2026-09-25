// Renders the per-feature website clips from the capture made by `npm run capture:features`.
//
//   npm run render:features                          every clip, web assets, features.json
//   npm run render:features -- --only terminal,search
//   npm run render:features -- --stills terminal:90,200   review stills only
//
// Outputs: site/assets/features/<id>.mp4 + <id>.webp + features.json (the website contract),
// and output/features/ (1280x800 masters, contact sheets, render manifest).
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { CLIPS, FPS, WIDTH, HEIGHT, buildFeatureEdit } from "./src/features-edit.mjs";

const workDir = import.meta.dirname;
const root = path.resolve(workDir, "..");
const captureDir = path.join(workDir, "capture", "features");
const publicDir = path.join(workDir, "public", "features");
const outputDir = path.join(workDir, "output", "features");
const siteDir = path.join(root, "site", "assets", "features");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const chrome = process.env.CHROME_PATH || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const remotionCli = path.join(workDir, "node_modules", "@remotion", "cli", "remotion-cli.js");
const browserArgs = existsSync(chrome) ? [`--browser-executable=${chrome}`] : [];
const TARGET_BYTES = 1.5 * 1024 * 1024;
const HARD_CAP_BYTES = 2.5 * 1024 * 1024;
const POSTER_BYTES = 60 * 1024;

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workDir, stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"], windowsHide: true });
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} exited with ${code}\n${output.slice(-3000)}`)));
  });
}

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : null;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function probe(file) {
  const json = JSON.parse(await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { capture: true }));
  const video = json.streams.find((stream) => stream.codec_type === "video");
  const [num, den] = String(video.r_frame_rate).split("/").map(Number);
  return {
    width: video.width,
    height: video.height,
    fps: num / den,
    profile: video.profile,
    pixFmt: video.pix_fmt,
    audioStreams: json.streams.filter((stream) => stream.codec_type === "audio").length,
    durationSeconds: Number(Number(json.format.duration).toFixed(2)),
    bytes: Number(json.format.size)
  };
}

// +faststart: the moov atom must come before mdat.
async function moovFirst(file) {
  const handle = await fs.open(file, "r");
  try {
    let offset = 0;
    const header = Buffer.alloc(16);
    for (let guard = 0; guard < 64; guard += 1) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      let size = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (size === 1) size = Number(header.readBigUInt64BE(8));
      if (size < 8) return false;
      offset += size;
    }
    return false;
  } finally {
    await handle.close();
  }
}

await Promise.all([fs.mkdir(publicDir, { recursive: true }), fs.mkdir(outputDir, { recursive: true }), fs.mkdir(siteDir, { recursive: true })]);
await fs.access(remotionCli);
const manifest = JSON.parse(await fs.readFile(path.join(captureDir, "manifest.json"), "utf8"));
const only = argValue("--only")?.split(",").map((item) => item.trim()).filter(Boolean);
const stills = argValue("--stills");
const selected = CLIPS.filter((plan) => !only || only.includes(plan.id));

async function prepare(plan) {
  const capture = manifest.clips[plan.id];
  if (!capture) throw new Error(`No capture for ${plan.id}; run npm run capture:features -- --only ${plan.id}.`);
  const source = path.join(workDir, capture.source);
  const target = path.join(publicDir, `${plan.id}.mp4`);
  const [sourceStat, targetStat] = await Promise.all([fs.stat(source), fs.stat(target).catch(() => null)]);
  if (!targetStat || targetStat.size !== sourceStat.size || targetStat.mtimeMs < sourceStat.mtimeMs) await fs.copyFile(source, target);
  const clip = buildFeatureEdit(plan, capture);
  const propsPath = path.join(outputDir, `${plan.id}-props.json`);
  await fs.writeFile(propsPath, `${JSON.stringify({ clip }, null, 2)}\n`);
  return { clip, propsPath, capture };
}

if (stills) {
  const [id, frameList] = stills.split(":");
  const plan = CLIPS.find((item) => item.id === id);
  if (!plan) throw new Error(`Unknown clip ${id}.`);
  const { propsPath, clip } = await prepare(plan);
  for (const frame of String(frameList || "0").split(",").map(Number)) {
    await run(process.execPath, [remotionCli, "still", ".\\src\\index.jsx", "FeatureClip", path.join(outputDir, `${id}-still-${String(frame).padStart(4, "0")}.png`), `--props=${propsPath}`, `--frame=${frame}`, ...browserArgs, "--log=error"]);
  }
  console.log(JSON.stringify({ id, durationInFrames: clip.durationInFrames, segments: clip.segments.map((s) => [s.from, s.duration, s.sourceSeconds]), posterFrame: clip.posterFrame }, null, 2));
  process.exit(0);
}

const results = [];
for (const plan of selected) {
  const { clip, propsPath, capture } = await prepare(plan);
  const master = path.join(outputDir, `${plan.id}-master.mp4`);
  console.log(`Rendering ${plan.id} (${(clip.durationInFrames / FPS).toFixed(2)} s)`);
  await run(process.execPath, [
    remotionCli, "render", ".\\src\\index.jsx", "FeatureClip", master,
    `--props=${propsPath}`, "--codec=h264", "--crf=12", "--pixel-format=yuv420p", "--color-space=bt709", "--muted", "--concurrency=6", ...browserArgs, "--log=error"
  ]);

  // Web encode: the lowest CRF (best quality) that fits the size target.
  const web = path.join(siteDir, `${plan.id}.mp4`);
  let crf = 22;
  let bytes = 0;
  for (;;) {
    await run(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", master, "-an",
      "-c:v", "libx264", "-preset", "veryslow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", String(crf),
      "-x264-params", "aq-mode=3:ref=5:bframes=5", "-g", "150", "-r", String(FPS),
      "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-movflags", "+faststart", web
    ]);
    ({ size: bytes } = await fs.stat(web));
    if (bytes <= TARGET_BYTES || crf >= 34) break;
    crf += bytes > TARGET_BYTES * 1.35 ? 2 : 1;
  }

  // Poster: a representative frame, WebP under the budget.
  const posterPng = path.join(outputDir, `${plan.id}-poster.png`);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", (clip.posterFrame / FPS).toFixed(3), "-i", master, "-frames:v", "1", "-update", "1", posterPng]);
  const poster = path.join(siteDir, `${plan.id}.webp`);
  let quality = 82;
  let posterBytes = 0;
  for (;;) {
    await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", posterPng, "-c:v", "libwebp", "-quality", String(quality), "-compression_level", "6", "-preset", "text", poster]);
    ({ size: posterBytes } = await fs.stat(poster));
    if (posterBytes <= POSTER_BYTES || quality <= 30) break;
    quality -= 6;
  }

  // Review sheet: one frame every half second.
  const sheet = path.join(outputDir, `${plan.id}-contact-sheet.jpg`);
  const rows = Math.ceil(clip.durationInFrames / FPS / 0.5 / 6);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", web, "-vf", `fps=2,scale=426:-2,tile=6x${rows}:padding=4:margin=4:color=111715`, "-frames:v", "1", "-update", "1", "-q:v", "3", sheet]);

  const info = await probe(web);
  const checks = {
    resolution: info.width === WIDTH && info.height === HEIGHT,
    fps: Math.abs(info.fps - FPS) < 0.01,
    h264High: /high/i.test(info.profile || ""),
    yuv420p: info.pixFmt === "yuv420p",
    noAudio: info.audioStreams === 0,
    faststart: await moovFirst(web),
    duration: info.durationSeconds >= 6 && info.durationSeconds <= 12.5,
    underHardCap: info.bytes <= HARD_CAP_BYTES,
    posterBudget: posterBytes <= POSTER_BYTES
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`${plan.id} failed checks: ${failed.join(", ")} ${JSON.stringify(info)}`);
  results.push({
    plan,
    info,
    crf,
    posterBytes,
    posterQuality: quality,
    sheet: path.relative(root, sheet).replaceAll("\\", "/"),
    sha256: sha256(await fs.readFile(web)),
    capture: { capturedAt: capture.capturedAt, resolution: capture.resolution, aiClient: capture.aiClient || null },
    segments: clip.segments.map((segment) => segment.sourceSeconds),
    trimmedSeconds: clip.ai?.trimmedSeconds ?? null
  });
  console.log(`${plan.id}: ${info.durationSeconds} s, ${(info.bytes / 1024).toFixed(0)} KB (crf ${crf}), poster ${(posterBytes / 1024).toFixed(1)} KB`);
}

// features.json lists every clip in CLIPS order, keeping entries for clips not re-rendered.
const featuresPath = path.join(siteDir, "features.json");
const existing = existsSync(featuresPath) ? JSON.parse(await fs.readFile(featuresPath, "utf8")) : { clips: [] };
const entries = new Map(existing.clips.map((entry) => [entry.id, entry]));
for (const { plan, info } of results) {
  entries.set(plan.id, {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    src: `assets/features/${plan.id}.mp4`,
    poster: `assets/features/${plan.id}.webp`,
    width: WIDTH,
    height: HEIGHT,
    durationSeconds: info.durationSeconds,
    alt: plan.alt
  });
}
const clips = CLIPS.map((plan) => entries.get(plan.id)).filter(Boolean);
await fs.writeFile(featuresPath, `${JSON.stringify({ version: 1, clips }, null, 2)}\n`);

const renderManifestPath = path.join(outputDir, "render-manifest.json");
const renderManifest = existsSync(renderManifestPath) ? JSON.parse(await fs.readFile(renderManifestPath, "utf8")) : { clips: {} };
for (const result of results) {
  renderManifest.clips[result.plan.id] = {
    renderedAt: new Date().toISOString(),
    file: `site/assets/features/${result.plan.id}.mp4`,
    ...result.info,
    crf: result.crf,
    sha256: result.sha256,
    poster: { file: `site/assets/features/${result.plan.id}.webp`, bytes: result.posterBytes, quality: result.posterQuality },
    contactSheet: result.sheet,
    sourceSegments: result.segments,
    modelWaitTrimmedSeconds: result.trimmedSeconds,
    capture: result.capture
  };
}
await fs.writeFile(renderManifestPath, `${JSON.stringify(renderManifest, null, 2)}\n`);
console.log(JSON.stringify(results.map(({ plan, info, crf, posterBytes, sheet }) => ({ id: plan.id, seconds: info.durationSeconds, kb: Math.round(info.bytes / 1024), crf, posterKb: Math.round(posterBytes / 1024), sheet })), null, 2));
