// Derives the website's WebP screenshots from the real PNG captures in site/assets.
//
// PNGs remain the source of truth (og:image, JSON-LD screenshots, the MCPB bundle); pages
// load the WebP copies. UI captures are mostly flat colour, so lossless WebP is pixel-exact
// and roughly 40-60% of the PNG size. Downscaled variants were measured and rejected: the
// resampling blurs flat UI colour, so a 960 px copy is often larger than the lossless original.
//
// Usage: node scripts/build-site-images.mjs            (re-encode every capture)
//        node scripts/build-site-images.mjs --check    (fail if a WebP is missing or older than its PNG)
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const assets = path.join(process.cwd(), "site", "assets");
const captures = ["workspace", "terminal", "disk-map", "ai-bridge", "devices", "health", "transfer-preview", "command-center"];
const check = process.argv.includes("--check");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

async function mtime(file) {
  return (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0;
}

const problems = [];
for (const name of captures) {
  const png = path.join(assets, `${name}.png`);
  const webp = path.join(assets, `${name}.webp`);
  const pngTime = await mtime(png);
  if (!pngTime) continue;
  if (check) {
    if ((await mtime(webp)) < pngTime) problems.push(`${name}.webp is missing or older than ${name}.png`);
    continue;
  }
  const encode = (output, options) => execFileSync(ffmpeg, ["-v", "error", "-y", "-i", png, "-c:v", "libwebp", ...options, "-compression_level", "6", output], {
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true
  });
  // Lossless keeps text pixel-exact; captures dominated by gradients (the Disk Map treemap)
  // compress far better lossy, so use quality 90 only when it saves at least 30%.
  const lossy = path.join(assets, `${name}.lossy-tmp.webp`);
  encode(webp, ["-lossless", "1"]);
  encode(lossy, ["-quality", "90"]);
  const [pngSize, losslessSize, lossySize] = await Promise.all([png, webp, lossy].map((file) => fs.stat(file).then((stat) => stat.size)));
  const useLossy = lossySize < losslessSize * 0.7;
  if (useLossy) await fs.rename(lossy, webp);
  else await fs.rm(lossy);
  console.log(`${name}: ${pngSize} B png -> ${useLossy ? lossySize : losslessSize} B ${useLossy ? "quality-90" : "lossless"} webp`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
}
