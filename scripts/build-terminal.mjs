import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "public", "generated");
const iconSource = path.join(root, "node_modules", "lucide-static", "icons");
const iconTarget = path.join(root, "public", "icons");
const terminalIcons = [
  "chevron-down.svg",
  "eraser.svg",
  "external-link.svg",
  "folder-open.svg",
  "rotate-cw.svg",
  "shield.svg",
  "square-terminal.svg"
];

await mkdir(outputDir, { recursive: true });
await mkdir(iconTarget, { recursive: true });

async function writeIfChanged(file, contents) {
  const current = await readFile(file).catch(() => null);
  if (current?.equals(contents)) return false;
  await writeFile(file, contents);
  return true;
}

await Promise.all(
  terminalIcons.map(async (name) => {
    const contents = await readFile(path.join(iconSource, name));
    return writeIfChanged(path.join(iconTarget, name), contents);
  })
);

const renderer = await build({
  entryPoints: [path.join(root, "src", "terminal-renderer.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome136"],
  outdir: outputDir,
  entryNames: "terminal-renderer",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  loader: { ".css": "css" },
  write: false
});

const webgl = await build({
  entryPoints: [path.join(root, "src", "terminal-webgl.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome136"],
  outdir: outputDir,
  entryNames: "terminal-webgl",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  write: false
});

await Promise.all([
  ...renderer.outputFiles.map((file) => writeIfChanged(file.path, file.contents)),
  ...webgl.outputFiles.map((file) => writeIfChanged(file.path, file.contents))
]);

console.log("Explore Better terminal renderer ready.");
