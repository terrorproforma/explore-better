// Pre-publish privacy sweep for rendered media: samples frames from every site
// video and reads them with the built-in Windows OCR engine, failing if any frame
// shows the current account name, a user-profile path, or the repository path.
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const fps = Number(process.env.EB_PRIVACY_SCAN_FPS || 10);
const videos = process.argv.slice(2).length
  ? process.argv.slice(2).map((item) => path.resolve(item))
  : [
      path.join(root, "site", "assets", "explore-better-demo.mp4"),
      ...(await fs.readdir(path.join(root, "site", "assets", "features")).catch(() => []))
        .filter((name) => name.endsWith(".mp4"))
        .map((name) => path.join(root, "site", "assets", "features", name))
    ];

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const account = os.userInfo().username;
// The repository folder shares the product name (and demo fixtures use it), so
// match the account name and user-profile paths, which every leaked path contains.
const terms = [account, `Users\\${account}`].filter((item) => item && item.length > 2);
const pattern = `(${terms.map(escape).join("|")}|Users\\\\[A-Za-z])`;

if (process.platform !== "win32") {
  console.log("Media privacy scan: skipped (Windows OCR is required).");
  process.exit(0);
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), "eb-media-privacy-"));
let failures = 0;
try {
  for (const video of videos) {
    const frameDir = path.join(work, path.basename(video, ".mp4"));
    await fs.mkdir(frameDir, { recursive: true });
    const extract = spawnSync(ffmpeg, ["-v", "error", "-i", video, "-vf", `fps=${fps},scale=2400:-1`, path.join(frameDir, "f%05d.png")], { encoding: "utf8" });
    if (extract.status !== 0) throw new Error(`ffmpeg failed for ${video}: ${extract.stderr}`);
    const scan = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "ocr-scan.ps1"), "-FrameDir", frameDir, "-Pattern", pattern], { encoding: "utf8" });
    if (scan.status !== 0) throw new Error(`OCR failed for ${video}: ${scan.stderr}`);
    // Report frame numbers as timestamps but never echo the matched text itself.
    const hits = scan.stdout.split(/\r?\n/).filter((line) => line.startsWith("HIT "));
    const times = [...new Set(hits.map((line) => (Number(line.match(/f(\d+)\.png/)?.[1] || 0) / fps).toFixed(1)))];
    failures += hits.length;
    console.log(`${hits.length ? "FAIL" : "PASS"} ${path.relative(root, video)}${hits.length ? ` — possible private text near ${times.join(", ")} s` : ""}`);
  }
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
console.log(`Media privacy scan: ${videos.length} video(s), ${failures} hit(s).`);
process.exit(failures ? 1 : 0);
