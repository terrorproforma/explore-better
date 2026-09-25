// Renders the v7 cut: the real capture from `npm run capture`, re-cut to the score's beat map
// (music/beatmap-D3.json by default) and muxed with that score's WAV master.
//
//   npm run render:v7                          master, web assets, sync-check sheets, manifest
//   npm run render:v7 -- --plan                print the solved sync plan only
//   npm run render:v7 -- --stills 90,600       only render review stills (frame numbers)
//   npm run render:v7 -- --beatmap music/beatmap-D2.json   re-sync to another score
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { buildV7Edit, createMusicGrid, FPS, MIN_RATE, MAX_RATE } from "./src/v7-edit.mjs";

const workDir = import.meta.dirname;
const root = path.resolve(workDir, "..");
const outputDir = path.join(workDir, "output");
const reviewDir = path.join(outputDir, "review-v7");
const publicDir = path.join(workDir, "public");
const siteAssets = path.join(root, "site", "assets");
const captureDir = path.join(workDir, "capture");
const capture = path.join(captureDir, "explore-better-live-walkthrough.mp4");
const captureManifestPath = path.join(captureDir, "capture-manifest.json");
const tracePath = path.join(captureDir, "ai-handoff-trace.json");
const publicCapture = path.join(publicDir, "live.mp4");
const motionPath = path.join(outputDir, "v7-capture-motion.json");
const propsPath = path.join(outputDir, "v7-props.json");
const silentVideo = path.join(outputDir, "explore-better-demo-v7-silent.mp4");
const video = path.join(outputDir, "explore-better-demo-v7-1080p.mp4");
const poster = path.join(outputDir, "explore-better-v7-poster.png");
const contactSheet = path.join(outputDir, "explore-better-v7-contact-sheet.jpg");
const syncHits = path.join(reviewDir, "sync-hits.jpg");
const syncTimeline = path.join(reviewDir, "sync-timeline.png");
const captionsVtt = path.join(outputDir, "explore-better-demo-v7.vtt");
const webVideo = path.join(siteAssets, "explore-better-demo.mp4");
const webPoster = path.join(siteAssets, "explore-better-demo-poster.webp");
const manifestPath = path.join(outputDir, "manifest-v7.json");
const chaptersPath = path.join(workDir, "chapters-v6.json");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const chrome = process.env.CHROME_PATH || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const remotionCli = path.join(workDir, "node_modules", "@remotion", "cli", "remotion-cli.js");
const webBudgetBytes = 9_000_000;
const posterBudgetBytes = 120 * 1024;
const audioKbps = 192;

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : null;
};
const beatmapPath = path.resolve(workDir, argValue("--beatmap") || path.join("music", "beatmap-D3.json"));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || workDir,
      stdio: options.capture || options.binary ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      windowsHide: true
    });
    const chunks = [];
    let text = "";
    if (options.capture || options.binary) {
      child.stdout.on("data", (chunk) => { if (options.binary) chunks.push(chunk); else text += chunk; });
      child.stderr.on("data", (chunk) => { text += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(options.binary ? Buffer.concat(chunks) : text) : reject(new Error(`${path.basename(command)} exited with code ${code}\n${text.slice(-3000)}`)));
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
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Mean absolute luminance difference between consecutive frames at 160x90. Used to find the
// frame where the screen really changes after a scripted action, and to check the render.
async function measureMotion(file) {
  const width = 160;
  const height = 90;
  const raw = await run(ffmpeg, ["-v", "error", "-i", file, "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-"], { binary: true });
  const size = width * height;
  const frames = Math.floor(raw.length / size);
  const diffs = new Array(frames).fill(0);
  for (let frame = 1; frame < frames; frame += 1) {
    let sum = 0;
    const offset = frame * size;
    for (let index = 0; index < size; index += 1) sum += Math.abs(raw[offset + index] - raw[offset - size + index]);
    diffs[frame] = Number((sum / size).toFixed(2));
  }
  return { fps: FPS, width, height, diffs };
}

await Promise.all([fs.mkdir(outputDir, { recursive: true }), fs.mkdir(publicDir, { recursive: true }), fs.mkdir(reviewDir, { recursive: true })]);
await Promise.all([fs.access(capture), fs.access(captureManifestPath), fs.access(remotionCli), fs.access(beatmapPath)]);
const captureManifest = JSON.parse(await fs.readFile(captureManifestPath, "utf8"));
const trace = existsSync(tracePath) ? JSON.parse(await fs.readFile(tracePath, "utf8")) : null;
const beatmap = JSON.parse(await fs.readFile(beatmapPath, "utf8"));
const appVersion = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;

const captureStat = await fs.stat(capture);
let motion = existsSync(motionPath) ? JSON.parse(await fs.readFile(motionPath, "utf8")) : null;
if (!motion || motion.captureBytes !== captureStat.size || motion.captureMtimeMs !== captureStat.mtimeMs) {
  motion = { captureBytes: captureStat.size, captureMtimeMs: captureStat.mtimeMs, ...(await measureMotion(capture)) };
  await fs.writeFile(motionPath, JSON.stringify(motion));
}

const edit = buildV7Edit(captureManifest, beatmap, { motion, trace, appVersion });
await fs.writeFile(propsPath, `${JSON.stringify({ edit }, null, 2)}\n`);
const publicStat = await fs.stat(publicCapture).catch(() => null);
if (!publicStat || publicStat.size !== captureStat.size || publicStat.mtimeMs < captureStat.mtimeMs) await fs.copyFile(capture, publicCapture);

const rates = edit.segments.map((segment) => segment.rate);
const planSummary = () => {
  const rows = edit.syncs.map((sync) => `${sync.chapter.padEnd(9)} ${sync.id.padEnd(22)} f${String(sync.frame).padStart(5)} ${(sync.frame / FPS).toFixed(3).padStart(7)}s -> ${sync.to.padEnd(9)} ${sync.target.toFixed(3).padStart(7)} ${sync.kinds.join("+").padEnd(28)} ${String(sync.offsetMs).padStart(6)} ms`);
  const segs = edit.segments.map((segment) => `${segment.chapter}:${segment.from}-${segment.to}@${segment.rate}`).join("  ");
  return `${rows.join("\n")}\nretime rates ${Math.min(...rates).toFixed(2)}-${Math.max(...rates).toFixed(2)}x (limits ${MIN_RATE}-${MAX_RATE}x; 0 = stop freeze)\n${segs}`;
};
console.log(planSummary());
if (process.argv.includes("--plan")) process.exit(0);

const stillsArg = argValue("--stills");
if (stillsArg) {
  for (const frame of stillsArg.split(",").map(Number).filter(Number.isFinite)) {
    await run(process.execPath, [
      remotionCli, "still", ".\\src\\index.jsx", "ExploreBetterV7", path.join(reviewDir, `still-${String(frame).padStart(4, "0")}.png`),
      `--props=${propsPath}`, `--frame=${frame}`, ...browserArgs, "--log=error"
    ]);
  }
  process.exit(0);
}

// 1. Picture.
await run(process.execPath, [
  remotionCli, "render", ".\\src\\index.jsx", "ExploreBetterV7", silentVideo,
  `--props=${propsPath}`, "--codec=h264", "--crf=16", "--pixel-format=yuv420p", "--color-space=bt709", "--concurrency=6", ...browserArgs
]);

// 2. The score: the beat map's own WAV master, checked against the hash the music render wrote.
const duration = edit.durationInFrames / FPS;
const wav = beatmap.audio?.wav ? path.join(root, beatmap.audio.wav) : null;
if (!wav || !existsSync(wav)) throw new Error(`The ${beatmap.candidate} master (${beatmap.audio?.wav}) is missing. Run npm run render:music -- ${beatmap.candidate} first.`);
const wavBytes = await fs.readFile(wav);
if (beatmap.audio.sha256 && sha256(wavBytes) !== beatmap.audio.sha256.toLowerCase()) throw new Error(`${wav} does not match the beat map's SHA-256; re-render the music so picture and beat map agree.`);
await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error", "-i", silentVideo, "-i", wav,
  "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ar", "48000",
  "-t", duration.toFixed(6), "-movflags", "+faststart", video
]);

// 3. Web cut: two-pass H.264 sized to the landing-page budget.
const webVideoKbps = Math.floor((webBudgetBytes * 8 * 0.93) / duration / 1000 - audioKbps);
const passLog = path.join(outputDir, "v7-web-pass");
const webArgs = ["-vf", "scale=1600:900:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-b:v", `${webVideoKbps}k`, "-maxrate", `${Math.round(webVideoKbps * 2.2)}k`, "-bufsize", `${webVideoKbps * 4}k`, "-g", "60", "-passlogfile", passLog];
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", video, ...webArgs, "-pass", "1", "-an", "-f", "mp4", "NUL"]);
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", video, ...webArgs, "-pass", "2", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ar", "48000", "-movflags", "+faststart", webVideo]);
for (const suffix of ["-0.log", "-0.log.mbtree"]) await fs.rm(`${passLog}${suffix}`, { force: true });

// 4. Poster: the hero title over the real workspace, once every word has landed.
const posterSeconds = Number(argValue("--poster") || 2.2);
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(posterSeconds), "-i", silentVideo, "-frames:v", "1", "-update", "1", poster]);
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

// 6. Sync check. Measure where the rendered picture actually changes around every anchored
//    event, then build two sheets: frames exactly on each strong hit, and a timeline of edit
//    events over the score's waveform.
const grid = createMusicGrid(beatmap);
const renderMotion = await measureMotion(silentVideo);
const measured = edit.syncs.map((sync) => {
  let best = sync.frame;
  let bestValue = -1;
  for (let frame = sync.frame - 4; frame <= sync.frame + 4; frame += 1) {
    const value = renderMotion.diffs[frame] ?? 0;
    if (value > bestValue + 0.05 || (Math.abs(value - bestValue) <= 0.05 && Math.abs(frame - sync.frame) < Math.abs(best - sync.frame))) { best = frame; bestValue = value; }
  }
  const nearest = grid.nearestGridPoint(sync.frame / FPS);
  return {
    ...sync,
    time: Number((sync.frame / FPS).toFixed(3)),
    nearestGrid: { time: Number(nearest.time.toFixed(3)), kind: nearest.kind, offsetMs: Number(((sync.frame / FPS - nearest.time) * 1000).toFixed(1)) },
    measuredChangeFrame: bestValue > 0.3 ? best : null,
    measuredOffsetFrames: bestValue > 0.3 ? best - sync.frame : null
  };
});
const strongHits = grid.moments.filter((moment) => moment.time < duration - 0.05 && (moment.kinds.includes("stop") || moment.kinds.some((kind) => ["impact", "drop"].includes(kind)) || (moment.kinds.includes("stab") && moment.strength >= 0.7)));
const hitFrames = [];
for (const moment of strongHits) {
  const frame = Math.round(moment.time * FPS);
  const file = path.join(reviewDir, `hit-${String(frame).padStart(4, "0")}.jpg`);
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", (frame / FPS + 0.001).toFixed(4), "-i", silentVideo, "-frames:v", "1", "-vf", "scale=480:270", "-q:v", "3", file]);
  const events = [
    ...edit.syncs.filter((sync) => Math.abs(sync.frame - frame) <= 1).map((sync) => sync.label),
    ...edit.flashes.filter((flash) => Math.abs(flash.frame - frame) <= 1).map((flash) => `${flash.kind} transition`),
    ...edit.captions.filter((caption) => Math.abs(caption.from - frame) <= 1).map((caption) => `caption: ${caption.eyebrow}`),
    ...edit.freezes.filter((freeze) => Math.abs(freeze.from - frame) <= 1).map(() => "freeze on stop")
  ];
  hitFrames.push({ frame, time: moment.time, kinds: moment.kinds.filter((kind) => kind !== "clap"), strength: moment.strength, file, events: [...new Set(events)] });
}
const waveform = path.join(reviewDir, "waveform.png");
await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", wav, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=4800x160:colors=#c7ff4a:scale=sqrt", "-frames:v", "1", waveform]);
await buildSyncSheets({ edit, grid, duration, hitFrames, measured, waveform });

// 7. Chapters (unchanged from v6: the cuts are the score's downbeats) and captions.
const chapterList = edit.chapters.map((chapter) => ({
  id: chapter.id,
  title: chapter.title,
  start: Number((chapter.startFrame / FPS).toFixed(2)),
  end: Number((chapter.endFrame / FPS).toFixed(2)),
  label: timecode(chapter.startFrame / FPS)
}));
const published = JSON.parse(await fs.readFile(chaptersPath, "utf8"));
const chaptersMatch = published.chapters.length === chapterList.length && published.chapters.every((chapter, index) => chapter.id === chapterList[index].id && Math.abs(chapter.start - chapterList[index].start) < 0.011) && Math.abs(published.durationSeconds - duration) < 0.011;
if (!chaptersMatch) {
  await fs.writeFile(chaptersPath, `${JSON.stringify({ ...published, durationSeconds: Number(duration.toFixed(2)), chapters: chapterList.map(({ id, title, start, label }) => ({ id, title, start, label })) }, null, 2)}\n`);
  console.warn("Chapter times changed; chapters-v6.json was rewritten. Update the VideoObject in site/index.html to match.");
}
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
  { start: 0, end: openChapter.endFrame / FPS, text: `The Windows file manager built for humans and AI.\nReal app footage, v${appVersion}` },
  ...captionList.map((caption) => ({ start: caption.start, end: caption.end, text: [caption.headline, caption.detail, caption.proof.join(" / ")].filter(Boolean).join("\n") })),
  { start: edit.endFrom / FPS, end: duration, text: "Explore Better: download for Windows\nterrorproforma.github.io/explore-better" }
];
await fs.writeFile(captionsVtt, `WEBVTT\n\n${vttCues.map((cue, index) => `${index + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}\n`).join("\n")}`);

// 8. Manifest.
const loudness = await run(ffmpeg, ["-hide_banner", "-i", webVideo, "-af", "loudnorm=I=-14:TP=-1:LRA=7:print_format=json", "-f", "null", "NUL"], { capture: true });
const metric = (name) => Number(loudness.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1]);
const [masterBytes, webBytes, posterBytes] = await Promise.all([video, webVideo, webPoster].map((file) => fs.readFile(file)));
const manifest = {
  title: "Explore Better - v7 product demo (beat-synced)",
  generatedAt: new Date().toISOString(),
  direction: "The v6 story re-cut to the D3 score: chapter cuts on the score's downbeats, footage retimed so key presses, clicks and reveals land on beats and strong hits, captions and keycaps on the grid, flashes and punches on drops and stabs, and a restrained pulse on kick accents outside the breakdown.",
  durationSeconds: Number(duration.toFixed(3)),
  frames: edit.durationInFrames,
  fps: FPS,
  resolution: "1920x1080",
  music: { ...edit.music, beatmap: path.relative(root, beatmapPath) },
  chapters: chapterList,
  chaptersFile: { path: path.relative(root, chaptersPath), unchanged: chaptersMatch },
  captions: captionList,
  sync: {
    events: measured,
    maxAbsOffsetMs: Math.max(...measured.map((event) => Math.abs(event.offsetMs))),
    retimeRate: { min: Math.min(...rates.filter((rate) => rate > 0)), max: Math.max(...rates), limits: [MIN_RATE, MAX_RATE] },
    flashes: edit.flashes,
    pulses: edit.pulses,
    freezes: edit.freezes,
    strongHits: hitFrames.map(({ frame, time, kinds, strength, events }) => ({ frame, time, kinds, strength, events }))
  },
  clips: edit.clips.map((clip) => ({ id: clip.id, chapter: clip.chapter, outputStart: Number((clip.from / FPS).toFixed(3)), duration: Number((clip.duration / FPS).toFixed(3)), sourceSeconds: clip.sourceSeconds, timeMap: clip.map })),
  capture: {
    capturedAt: captureManifest.capturedAt,
    resolution: captureManifest.resolution,
    viewport: captureManifest.viewport,
    durationSeconds: captureManifest.durationSeconds,
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
  audio: { integratedLufs: metric("input_i"), truePeakDbtp: metric("input_tp"), loudnessRangeLu: metric("input_lra") },
  files: {
    master: { path: path.relative(root, video), bytes: masterBytes.byteLength, sha256: sha256(masterBytes) },
    web: { path: path.relative(root, webVideo), bytes: webBytes.byteLength, sha256: sha256(webBytes), videoKbps: webVideoKbps, audioKbps, resolution: "1600x900" },
    webPoster: { path: path.relative(root, webPoster), bytes: posterBytes.byteLength, sha256: sha256(posterBytes), quality: posterQuality, seconds: posterSeconds },
    poster: path.relative(root, poster),
    contactSheet: path.relative(root, contactSheet),
    syncHits: path.relative(root, syncHits),
    syncTimeline: path.relative(root, syncTimeline),
    captions: path.relative(root, captionsVtt)
  }
};
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (webBytes.byteLength > webBudgetBytes) throw new Error(`Web video is ${webBytes.byteLength} bytes, over the ${webBudgetBytes} byte budget.`);
if (posterBytes.byteLength > posterBudgetBytes) throw new Error(`Web poster is ${posterBytes.byteLength} bytes, over the ${posterBudgetBytes} byte budget.`);
console.log(JSON.stringify({ durationSeconds: manifest.durationSeconds, chaptersUnchanged: chaptersMatch, maxAbsOffsetMs: manifest.sync.maxAbsOffsetMs, retimeRate: manifest.sync.retimeRate, files: manifest.files, audio: manifest.audio }, null, 2));

// ---------------------------------------------------------------------------------------

async function buildSyncSheets({ edit, grid, duration, hitFrames, measured, waveform }) {
  const { chromium } = await import("playwright-core");
  const toData = async (file, type) => `data:${type};base64,${(await fs.readFile(file)).toString("base64")}`;
  const esc = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const style = `body{margin:0;background:#111715;color:#f4f7f5;font:14px "Cascadia Mono",Consolas,monospace}h1{font:800 26px Bahnschrift,sans-serif;margin:0 0 6px;color:#c7ff4a}p{margin:0 0 14px;color:#c8cfca}`;

  // Sheet A: frames exactly on every strong hit.
  const cells = [];
  for (const hit of hitFrames) {
    cells.push(`<figure style="margin:0;background:#1b2420;border:1px solid #2c3833"><img src="${await toData(hit.file, "image/jpeg")}" style="display:block;width:480px;height:270px"><figcaption style="padding:6px 8px 8px;min-height:44px"><b style="color:#c7ff4a">${hit.time.toFixed(3)} s · f${hit.frame}</b> <span style="color:#fff">${esc(hit.kinds.join(" + "))}</span> <span style="color:#8a948f">${hit.strength.toFixed(2)}</span><br><span style="color:#c8cfca">${esc(hit.events.join(" · ") || "-")}</span></figcaption></figure>`);
  }
  const hitsHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body><div style="padding:18px"><h1>v7 sync check: frames on strong hits</h1><p>Each frame is rendered exactly at the hit time from the ${esc(edit.music.candidate)} beat map (impacts, drops, stops and stabs ≥ 0.7). The second line lists the edit events anchored within one frame.</p><div style="display:grid;grid-template-columns:repeat(5,482px);gap:8px">${cells.join("")}</div></div></body></html>`;

  // Sheet B: two rows of timeline, each ~28 s, events over the waveform.
  const rowSeconds = Math.ceil(duration / 2);
  const pxPerSecond = 84;
  const width = rowSeconds * pxPerSecond + 120;
  const lanes = [
    ["hits", "Score hits"],
    ["cuts", "Cuts + transitions"],
    ["captions", "Captions (slam)"],
    ["keys", "Keycaps"],
    ["reveals", "Reveals + anchors"],
    ["pulses", "Beat pulses / freezes"]
  ];
  const laneHeight = 34;
  const waveHeight = 110;
  const kindColor = { impact: "#ff5a5a", drop: "#ff5a5a", stab: "#ffb347", "kick-accent": "#7fd6ff", stop: "#b28cff", "riser-start": "#666", "riser-end": "#666", clap: "#555", "lead-in": "#4c7", "lead-out": "#4c7" };
  const events = [];
  for (const moment of grid.moments) {
    const kind = moment.kinds.find((item) => ["impact", "drop", "stop", "stab", "kick-accent"].includes(item));
    if (kind) events.push({ lane: "hits", t: moment.time, color: kindColor[kind], h: 8 + 20 * moment.strength, label: moment.strength >= 0.85 || kind === "drop" || kind === "stop" ? kind : "" });
  }
  for (const flash of edit.flashes) events.push({ lane: "cuts", t: flash.frame / FPS, color: flash.kind === "drop" ? "#ff5a5a" : flash.kind === "stab" ? "#ffb347" : "#c7ff4a", h: 26, label: flash.kind });
  for (const caption of edit.captions) {
    events.push({ lane: "captions", t: caption.from / FPS, color: "#c7ff4a", h: 26, label: caption.eyebrow.split(" / ")[0] });
    caption.chipFrames.forEach((frame) => events.push({ lane: "captions", t: (caption.from + frame) / FPS, color: "#8fb33a", h: 12, label: "" }));
  }
  for (const key of edit.keys) events.push({ lane: "keys", t: key.from / FPS, color: "#f4f7f5", h: 26, label: key.label });
  for (const sync of measured) if (!sync.keycap && !sync.cut) events.push({ lane: "reveals", t: sync.frame / FPS, color: sync.reveal ? "#ff5a5a" : "#7fd6ff", h: sync.reveal ? 26 : 16, label: sync.reveal ? sync.label : "" });
  for (const pulse of edit.pulses) events.push({ lane: "pulses", t: pulse.frame / FPS, color: pulse.kind === "reveal" ? "#ff5a5a" : "#7fd6ff", h: 8 + pulse.amp * 500, label: "" });
  const rows = [];
  for (let row = 0; row < 2; row += 1) {
    const t0 = row * rowSeconds;
    const t1 = Math.min(duration, t0 + rowSeconds);
    const x = (t) => 110 + (t - t0) * pxPerSecond;
    const height = waveHeight + lanes.length * laneHeight + 40;
    const svg = [];
    // Chapters and freezes as bands.
    for (const chapter of edit.chapters) {
      const a = Math.max(t0, chapter.startFrame / FPS);
      const b = Math.min(t1, chapter.endFrame / FPS);
      if (b > a) svg.push(`<text x="${x(a) + 4}" y="14" fill="#c8cfca" font-size="12">${esc(chapter.title)}</text><line x1="${x(chapter.startFrame / FPS)}" x2="${x(chapter.startFrame / FPS)}" y1="0" y2="${height}" stroke="#c7ff4a" stroke-opacity=".5"/>`);
    }
    for (const freeze of edit.freezes) {
      const a = Math.max(t0, freeze.from / FPS);
      const b = Math.min(t1, freeze.to / FPS);
      if (b > a) svg.push(`<rect x="${x(a)}" y="20" width="${(b - a) * pxPerSecond}" height="${height - 20}" fill="#b28cff" fill-opacity=".12"/>`);
    }
    // Beats and bars.
    for (const beat of grid.beats) if (beat >= t0 && beat <= t1) svg.push(`<line x1="${x(beat)}" x2="${x(beat)}" y1="20" y2="${height - 18}" stroke="#f4f7f5" stroke-opacity="${grid.bars.some((bar) => Math.abs(bar - beat) < 0.002) ? 0.28 : 0.09}"/>`);
    for (let s = Math.ceil(t0); s <= t1; s += 1) svg.push(`<text x="${x(s)}" y="${height - 4}" fill="#8a948f" font-size="11" text-anchor="middle">${s}s</text>`);
    lanes.forEach(([id, title], index) => {
      const base = 20 + waveHeight + (index + 1) * laneHeight;
      svg.push(`<text x="4" y="${base - 10}" fill="#c8cfca" font-size="11">${title}</text><line x1="110" x2="${width}" y1="${base}" y2="${base}" stroke="#2c3833"/>`);
      for (const event of events.filter((item) => item.lane === id && item.t >= t0 && item.t <= t1)) {
        svg.push(`<line x1="${x(event.t)}" x2="${x(event.t)}" y1="${base}" y2="${base - event.h}" stroke="${event.color}" stroke-width="2"/>`);
        if (event.label) svg.push(`<text x="${x(event.t) + 3}" y="${base - event.h + 9}" fill="${event.color}" font-size="10">${esc(event.label)}</text>`);
      }
    });
    rows.push(`<div style="position:relative;width:${width}px;height:${height}px;margin-bottom:16px"><div style="position:absolute;left:110px;top:20px;width:${(t1 - t0) * pxPerSecond}px;height:${waveHeight}px;background:url(${await toData(waveform, "image/png")}) no-repeat;background-size:${duration * pxPerSecond}px ${waveHeight}px;background-position:${-t0 * pxPerSecond}px 0;opacity:.85"></div><svg width="${width}" height="${height}" style="position:absolute;left:0;top:0">${svg.join("")}</svg></div>`);
  }
  const offsets = measured.map((event) => `<tr><td>${esc(event.chapter)}</td><td>${esc(event.label)}</td><td>${event.time.toFixed(3)}</td><td>${esc(event.to)}</td><td>${esc(event.kinds.join("+"))}</td><td style="color:${Math.abs(event.offsetMs) <= 1000 / FPS ? "#c7ff4a" : "#ff5a5a"}">${event.offsetMs}</td><td>${event.measuredOffsetFrames ?? "-"}</td></tr>`).join("");
  const timelineHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${style}td,th{padding:2px 10px;text-align:left;border-bottom:1px solid #2c3833}th{color:#c7ff4a}</style></head><body><div style="padding:18px;width:${width}px"><h1>v7 sync check: edit events over the score</h1><p>${esc(edit.music.candidate)} waveform with beats (faint) and bars (bright). Purple bands are free-time stops where the picture freezes until the drop. Offsets are anchor frame time minus the grid target; one frame is ${(1000 / FPS).toFixed(1)} ms. "Measured" is where the rendered picture changes most within ±4 frames of the anchor (0 = on the frame).</p>${rows.join("")}<table style="border-collapse:collapse;font-size:13px"><tr><th>Chapter</th><th>Event</th><th>Time s</th><th>Grid</th><th>Hit</th><th>Offset ms</th><th>Measured frames</th></tr>${offsets}</table></div></body></html>`;

  const browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 2460, height: 1000 }, deviceScaleFactor: 1 });
    await page.setContent(hitsHtml, { waitUntil: "load" });
    await page.screenshot({ path: syncHits, fullPage: true, type: "jpeg", quality: 82 });
    await page.setViewportSize({ width: width + 40, height: 1000 });
    await page.setContent(timelineHtml, { waitUntil: "load" });
    await page.screenshot({ path: syncTimeline, fullPage: true });
  } finally {
    await browser.close();
  }
}
