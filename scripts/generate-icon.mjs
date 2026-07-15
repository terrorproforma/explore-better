import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const sourcePath = path.join(workspace, "brand", "eb-icon.svg");
const outDir = path.join(workspace, "build");
const svgTargets = [
  path.join(workspace, "public", "assets", "brand-mark.svg"),
  path.join(workspace, "site", "assets", "brand-mark.svg"),
  path.join(workspace, "demo-video-v2", "public", "brand-mark.svg")
];
const appIconTargets = [
  path.join(workspace, "public", "assets", "app-icon.png"),
  path.join(workspace, "site", "assets", "app-icon.png")
];
const sizes = [16, 24, 32, 48, 64, 128, 256];
const brandBackground = "#18201D";

async function browserPath() {
  const candidates = [
    process.env.EB_ICON_BROWSER,
    process.env.EB_LANDING_PAGE_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Microsoft Edge or Google Chrome is required to render the canonical brand SVG. Set EB_ICON_BROWSER to its executable path.");
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
    throw new Error("Chromium did not return a PNG image.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const image of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.buffer.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((image) => image.buffer)]);
}

async function renderPngs(svg) {
  const executablePath = await browserPath();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
    const source = Buffer.from(svg).toString("base64");
    await page.setContent(`<!doctype html><html><head><style>
      html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${brandBackground}}
      img{display:block;width:100%;height:100%;object-fit:contain}
    </style></head><body><img id="brand" alt="" src="data:image/svg+xml;base64,${source}"></body></html>`);
    await page.locator("#brand").evaluate((image) => image.decode());
    const pngs = [];
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size });
      const buffer = await page.screenshot({ type: "png", animations: "disabled" });
      const dimensions = pngDimensions(buffer);
      if (dimensions.width !== size || dimensions.height !== size) {
        throw new Error(`Expected ${size}x${size} brand PNG, received ${dimensions.width}x${dimensions.height}.`);
      }
      pngs.push({ size, buffer });
    }
    return pngs;
  } finally {
    await browser.close();
  }
}

async function main() {
  const svg = await fs.readFile(sourcePath, "utf8");
  if (!svg.includes('viewBox="0 0 334 321"') || !svg.includes("#C7FF4A") || !svg.includes("#18201D")) {
    throw new Error("brand/eb-icon.svg is not the expected Explore Better source artwork.");
  }
  await fs.mkdir(outDir, { recursive: true });
  await Promise.all([...svgTargets, ...appIconTargets].map((target) => fs.mkdir(path.dirname(target), { recursive: true })));
  await Promise.all(svgTargets.map((target) => fs.writeFile(target, svg, "utf8")));

  const pngs = await renderPngs(svg);
  for (const image of pngs) {
    await fs.writeFile(path.join(outDir, `icon-${image.size}.png`), image.buffer);
    if (image.size === 256) {
      await fs.writeFile(path.join(outDir, "icon.png"), image.buffer);
      await Promise.all(appIconTargets.map((target) => fs.writeFile(target, image.buffer)));
    }
  }
  await fs.writeFile(path.join(outDir, "icon.ico"), encodeIco(pngs));
  console.log(`generated canonical Explore Better SVG, ${pngs.length} PNG sizes, build\\icon.ico, app/site favicons, and the demo brand asset`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
