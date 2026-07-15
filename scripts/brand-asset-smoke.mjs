import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [];
const expectedSizes = [16, 24, 32, 48, 64, 128, 256];

function add(id, passed, detail) {
  checks.push({ id, status: passed ? "pass" : "fail", detail });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function htmlFiles(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await htmlFiles(target)));
    else if (entry.name.endsWith(".html")) output.push(target);
  }
  return output;
}

const source = await fs.readFile(path.join(root, "brand", "eb-icon.svg"));
const sourceText = source.toString("utf8");
add(
  "canonical-source",
  sourceText.includes('viewBox="0 0 334 321"') && sourceText.includes('fill="#C7FF4A"') && sourceText.includes('fill="#18201D"'),
  `brand/eb-icon.svg ${sha256(source).slice(0, 12)}`
);

for (const relative of ["public/assets/brand-mark.svg", "site/assets/brand-mark.svg", "demo-video-v2/public/brand-mark.svg"]) {
  const target = await fs.readFile(path.join(root, relative));
  add(`svg-${relative}`, target.equals(source), `${relative} ${target.equals(source) ? "matches canonical source" : "differs from canonical source"}`);
}

const buildPngs = new Map();
for (const size of expectedSizes) {
  const buffer = await fs.readFile(path.join(root, "build", `icon-${size}.png`));
  const dimensions = pngDimensions(buffer);
  buildPngs.set(size, buffer);
  add(`png-${size}`, dimensions?.width === size && dimensions?.height === size, `${dimensions?.width || 0}x${dimensions?.height || 0}, ${buffer.length} bytes`);
}

const buildIcon = await fs.readFile(path.join(root, "build", "icon.png"));
for (const relative of ["public/assets/app-icon.png", "site/assets/app-icon.png"]) {
  const target = await fs.readFile(path.join(root, relative));
  add(`app-icon-${relative}`, target.equals(buildIcon) && target.equals(buildPngs.get(256)), `${relative} ${sha256(target).slice(0, 12)}`);
}

const ico = await fs.readFile(path.join(root, "build", "icon.ico"));
const icoCount = ico.readUInt16LE(4);
const icoSizes = [];
let icoImagesMatch = icoCount === expectedSizes.length;
for (let index = 0; index < icoCount; index += 1) {
  const entry = 6 + index * 16;
  const size = ico[entry] || 256;
  const length = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  const image = ico.subarray(offset, offset + length);
  icoSizes.push(size);
  if (!image.equals(buildPngs.get(size) || Buffer.alloc(0))) icoImagesMatch = false;
}
add("windows-ico", icoImagesMatch && icoSizes.join(",") === expectedSizes.join(","), `${icoCount} embedded PNGs: ${icoSizes.join(", ")}`);

const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const iconBuildScripts = ["prepackage:dir", "prepackage:win", "prepackage:installer", "build:mcpb", "build:site-pages"];
add(
  "build-wiring",
  packageJson.build?.win?.icon === "build/icon.ico" && iconBuildScripts.every((name) => packageJson.scripts?.[name]?.includes("build:icon")),
  `Windows icon ${packageJson.build?.win?.icon || "missing"}; canonical generation wired into ${iconBuildScripts.join(", ")}`
);

const electronMain = await fs.readFile(path.join(root, "electron-main.mjs"), "utf8");
add(
  "desktop-runtime-wiring",
  electronMain.includes("const appIconPath = app.isPackaged") &&
    electronMain.includes('path.join(process.resourcesPath, "app-icon.png")') &&
    electronMain.includes('path.join(__dirname, "public", "assets", "app-icon.png")') &&
    electronMain.includes("icon: appIconPath") &&
    electronMain.includes("nativeImage.createFromPath(appIconPath)"),
  "BrowserWindow and AI Bridge tray use the packaged canonical app icon"
);

const server = await fs.readFile(path.join(root, "server.mjs"), "utf8");
add(
  "shortcut-wiring",
  server.includes('$BrandIcon = "${path.join(repoPath, "build", "icon.ico")') &&
    server.match(/Test-Path -LiteralPath \$BrandIcon/g)?.length >= 2,
  "Development, Start Menu, Desktop, and Win+E shortcut generators prefer the canonical ICO"
);

const demoSource = await fs.readFile(path.join(root, "demo-video-v2", "src", "Video.jsx"), "utf8");
add(
  "current-demo-wiring",
  demoSource.includes('staticFile("brand-mark.svg")') && !demoSource.includes(">EB</div>"),
  "Current demo composition uses the canonical SVG instead of a text placeholder"
);

const siteHtml = await htmlFiles(path.join(root, "site"));
const staleReferences = [];
for (const file of siteHtml) {
  const html = await fs.readFile(file, "utf8");
  if (html.includes("brand-mark-legacy-") || html.includes("app-icon-legacy-")) staleReferences.push(path.relative(root, file));
}
add("site-references", staleReferences.length === 0, staleReferences.length ? staleReferences.join(", ") : `${siteHtml.length} HTML pages use current brand assets`);

const failures = checks.filter((check) => check.status === "fail");
console.log(`brand asset smoke: ${checks.length - failures.length} pass, ${failures.length} fail`);
for (const check of failures) console.error(`FAIL ${check.id}: ${check.detail}`);
if (failures.length) process.exitCode = 1;
