// Renders the three v7 music candidates and muxes each onto the published picture.
//
//   npm run render:music            the current candidates (D, E)
//   npm run render:music -- A B C   any subset; A-C are the rejected first round, kept for reference
//
// Outputs (gitignored) go to output/music-v7/:
//   explore-better-music-<X>.wav          48 kHz / 24-bit stereo master
//   explore-better-demo-<X>.mp4           published picture (stream-copied) + AAC 192 kbps
//   review-<X>.png                        spectrogram (log frequency) over waveform, cut markers
//   review-<X>-low.png                    0-500 Hz linear spectrogram (sub / rumble check)
//   beatmap-<X>.json                      beats, bars, tempo map, sections and hit points for re-editing
//   manifest.json                         tempo map, keys, progressions, cue alignment, meters
// D and E beat maps are also copied to music/beatmap-<X>.json (tracked) for the picture re-edit.
//
// The picture is never re-encoded and site/assets is never written.
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { PRESETS, renderCandidate, writeWav24, SR } from "./src/audio/score-v7.mjs";

const workDir = import.meta.dirname;
const root = path.resolve(workDir, "..");
const outDir = path.join(workDir, "output", "music-v7");
const chapters = JSON.parse(await fs.readFile(path.join(workDir, "chapters-v6.json"), "utf8"));
const picture = path.join(root, chapters.video);
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
// Measured from the published cut: the end card begins with a hard cut at 52.900 s (frame 1587).
const END_CARD_FALLBACK = 52.9;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} exited with ${code}\n${output.slice(-3000)}`))));
  });
}

const number = (text, re) => {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
};

async function probeDuration(file) {
  const out = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", file]);
  return Number(out.trim());
}

// Hard cuts in the picture, used to confirm chapter times and find the end card.
async function sceneCuts(file) {
  const out = await run(ffmpeg, ["-hide_banner", "-i", file, "-an", "-vf", "select='gt(scene,0.12)',showinfo", "-f", "null", "-"]);
  return [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]));
}

async function measure(file) {
  const ebu = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-map", "0:a", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
  const summary = ebu.slice(ebu.lastIndexOf("Summary:"));
  const stats = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-map", "0:a", "-af", "astats=measure_perchannel=none", "-f", "null", "-"]);
  const overall = stats.slice(stats.lastIndexOf("Overall"));
  return {
    integratedLufs: number(summary, /I:\s+(-?[0-9.]+) LUFS/),
    loudnessRangeLu: number(summary, /LRA:\s+(-?[0-9.]+) LU/),
    truePeakDbtp: number(summary, /True peak:\s+Peak:\s+(-?[0-9.]+|-inf) dBFS/),
    samplePeakDbfs: number(overall, /Peak level dB:\s+(-?[0-9.]+)/),
    rmsDbfs: number(overall, /RMS level dB:\s+(-?[0-9.]+)/),
    dcOffset: number(overall, /DC offset:\s+(-?[0-9.e+-]+)/),
    clippedSamples: number(overall, /Number of clipped samples:\s+([0-9.]+)/)
  };
}

async function bandLevel(file, filter) {
  const out = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", `${filter},astats=measure_perchannel=none`, "-f", "null", "-"]);
  return number(out.slice(out.lastIndexOf("Overall")), /RMS level dB:\s+(-?[0-9.]+|-inf)/);
}

async function stereoPhase(file) {
  const out = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", "aphasemeter=video=0,ametadata=print:key=lavfi.aphasemeter.phase:file=-", "-f", "null", "-"]);
  const values = [...out.matchAll(/lavfi\.aphasemeter\.phase=(-?[0-9.]+)/g)].map((m) => Number(m[1]));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: +mean.toFixed(3), p5: +sorted[Math.floor(sorted.length * 0.05)].toFixed(3), min: +sorted[0].toFixed(3), frames: values.length };
}

// Review images. Blue verticals are chapter cuts and the end card. On the log-frequency
// spectrogram (about 21.5 Hz at the bottom to 24 kHz at the top, calibrated with test tones)
// the grey horizontals mark 10 kHz and 30 Hz. The low-band image is the audio resampled to
// 1 kHz (0-500 Hz linear, 2 Hz per pixel) with guides at 30 Hz and 100 Hz.
async function reviewImages(wav, id, duration, marks) {
  const width = 1600;
  const specH = 560;
  const boxes = marks.map((t) => `drawbox=x=${Math.round((t / duration) * width)}:y=0:w=2:h=ih:color=0x39c5ff@0.85:t=fill`).join(",");
  const logY = (f) => Math.round(((Math.log10(24000) - Math.log10(f)) / (Math.log10(24000) - Math.log10(21.5))) * specH);
  const guides = [10000, 30].map((f) => `drawbox=x=0:y=${logY(f)}:w=iw:h=1:color=0xbbbbbb@0.7:t=fill`).join(",");
  const lowH = 250;
  const lowGuides = [30, 100].map((f) => `drawbox=x=0:y=${lowH - Math.round(f / 2)}:w=iw:h=1:color=0xbbbbbb@0.7:t=fill`).join(",");
  const review = path.join(outDir, `review-${id}.png`);
  const low = path.join(outDir, `review-${id}-low.png`);
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", wav, "-filter_complex",
    `[0:a]asplit[a][b];[a]showspectrumpic=s=${width}x${specH}:legend=0:fscale=log:scale=cbrt:color=intensity,${guides},${boxes}[s];` +
    `[b]showwavespic=s=${width}x240:scale=sqrt:colors=0xc7ff4a,${boxes}[w];[s][w]vstack`,
    "-frames:v", "1", "-update", "1", review
  ]);
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", wav, "-filter_complex",
    `[0:a]aresample=1000,showspectrumpic=s=${width}x${lowH}:legend=0:scale=cbrt:color=intensity,${lowGuides},${boxes}`,
    "-frames:v", "1", "-update", "1", low
  ]);
  return { review, low };
}

const sha256 = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const rel = (file) => path.relative(root, file).replaceAll("\\", "/");

await fs.mkdir(outDir, { recursive: true });
const wanted = process.argv.slice(2).map((s) => s.toUpperCase()).filter((s) => PRESETS[s]);
const ids = wanted.length ? wanted : Object.keys(PRESETS).filter((id) => PRESETS[id].status === "candidate");
const trackedDir = path.join(workDir, "music");

const duration = await probeDuration(picture);
const cuts = await sceneCuts(picture);
// The end card is the last hard cut before the final title. Scene detection can flag two
// adjacent frames (cut, then the dim overlay a frame later); the first frame is the cut.
const endCluster = cuts.filter((t) => t > duration - 5 && t < duration - 1.5);
let endCard = endCluster.at(-1) ?? END_CARD_FALLBACK;
while (endCluster.some((t) => t < endCard && endCard - t < 0.05)) endCard = endCluster.filter((t) => t < endCard).at(-1);
// Chapter times in chapters-v6.json are rounded to 10 ms. When a hard picture cut lies within
// 40 ms, the music follows the exact cut frame; otherwise (the title dissolve) the JSON time.
const pictureCheck = chapters.chapters.slice(1).map((c) => {
  const nearest = cuts.reduce((a, b) => (Math.abs(b - c.start) < Math.abs(a - c.start) ? b : a), Infinity);
  const differenceMs = Math.round((nearest - c.start) * 1000);
  return Math.abs(differenceMs) > 40
    ? { chapter: c.id, chaptersJson: c.start, cue: c.start, note: "no hard cut here (the title card dissolves into the first chapter)" }
    : { chapter: c.id, chaptersJson: c.start, pictureCut: +nearest.toFixed(4), differenceMs, cue: +nearest.toFixed(4) };
});
const cues = {
  duration,
  endCard: +endCard.toFixed(4),
  sections: chapters.chapters.slice(1).map((c, i) => ({ id: c.id, title: c.title, start: pictureCheck[i].cue, chaptersJson: c.start }))
};
console.log(`Picture ${rel(picture)}: ${duration.toFixed(3)} s, end card at ${cues.endCard} s`);

const manifestPath = path.join(outDir, "manifest.json");
let manifest = { candidates: {} };
try {
  manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
} catch {}

for (const id of ids) {
  const started = Date.now();
  console.log(`Candidate ${id}: ${PRESETS[id].name}`);
  const { L, R, info, beatmap } = renderCandidate(id, cues, { log: () => {} });
  const wav = path.join(outDir, `explore-better-music-${id}.wav`);
  const mp4 = path.join(outDir, `explore-better-demo-${id}.mp4`);
  await writeWav24(wav, L, R, 7 + id.charCodeAt(0));
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", picture, "-i", wav,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", String(SR), "-ac", "2",
    "-movflags", "+faststart", mp4
  ]);
  const [wavMeters, mp4Meters, below30, above10k, phase] = await Promise.all([
    measure(wav),
    measure(mp4),
    bandLevel(wav, Array(4).fill("lowpass=f=30:poles=2").join(",")),
    bandLevel(wav, Array(4).fill("highpass=f=10000:poles=2").join(",")),
    stereoPhase(wav)
  ]);
  const wavSha = await sha256(wav);
  const beatmapJson = `${JSON.stringify({ ...beatmap, audio: { wav: rel(wav), sha256: wavSha } }, null, 1)}
`;
  const beatmapPath = path.join(outDir, `beatmap-${id}.json`);
  await fs.writeFile(beatmapPath, beatmapJson);
  if (PRESETS[id].status === "candidate") {
    await fs.mkdir(trackedDir, { recursive: true });
    await fs.writeFile(path.join(trackedDir, `beatmap-${id}.json`), beatmapJson);
  }
  const images = await reviewImages(wav, id, duration, [chapters.chapters[1].start, ...cues.sections.slice(1).map((s) => s.start), cues.endCard]);
  const master = PRESETS[id].master;
  manifest.candidates[id] = {
    ...info,
    target: { integratedLufs: master?.targetLufs ?? -16, truePeakDbtpMax: master ? -1.0 : -1.5 },
    meters: {
      wav: wavMeters,
      mp4: mp4Meters,
      bandRmsDbfs: { below30Hz: below30, above10kHz: above10k, fullBand: wavMeters.rmsDbfs, filters: "8th-order Butterworth split at 30 Hz and 10 kHz" },
      stereoPhase: phase
    },
    files: {
      wav: rel(wav),
      mp4: rel(mp4),
      review: rel(images.review),
      reviewLow: rel(images.low),
      beatmap: rel(beatmapPath),
      sha256: { wav: wavSha, mp4: await sha256(mp4) }
    },
    renderSeconds: +((Date.now() - started) / 1000).toFixed(1)
  };
  const c = manifest.candidates[id];
  console.log(`  ${c.integratedLufs ?? wavMeters.integratedLufs} LUFS, ${wavMeters.truePeakDbtp} dBTP (mp4 ${mp4Meters.integratedLufs} LUFS / ${mp4Meters.truePeakDbtp} dBTP), max cue offset ${c.maxCueOffsetMs} ms, phase ${phase.mean}, ${c.renderSeconds} s`);
}

manifest = {
  title: "Explore Better demo music v7 candidates",
  generatedAt: new Date().toISOString(),
  originality: "Every sound is synthesized in src/audio/score-v7.mjs from oscillators and noise. No samples, loops, downloaded audio or existing melodies.",
  picture: { file: rel(picture), durationSeconds: duration, endCardSeconds: cues.endCard, chapterCutCheck: pictureCheck },
  mux: "Picture stream-copied (-c:v copy); AAC-LC 192 kbps, 48 kHz stereo.",
  current: Object.keys(PRESETS).filter((id) => PRESETS[id].status === "candidate"),
  candidates: Object.fromEntries(Object.entries(manifest.candidates).sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) => [id, { ...c, status: PRESETS[id]?.status ?? c.status }]))
};
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${rel(manifestPath)}`);
