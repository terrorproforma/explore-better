import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "public", "generated");
const outputPath = path.join(outputDir, "app-runtime.js");
const modelOutputPath = path.join(outputDir, "model-runtime.js");

async function writeIfChanged(file, contents) {
  const current = await readFile(file).catch(() => null);
  if (current?.equals(contents)) return false;
  await writeFile(file, contents);
  return true;
}

await mkdir(outputDir, { recursive: true });
const occtDist = path.join(root, "node_modules", "occt-import-js", "dist");
const occtAssets = [
  "occt-import-js.js",
  "occt-import-js.wasm",
  "occt-import-js-worker.js",
  "license.occt-import-js.txt",
  "license.occt.txt"
];
let copiedOcctAssets = 0;
for (const assetName of occtAssets) {
  const contents = await readFile(path.join(occtDist, assetName));
  if (await writeIfChanged(path.join(outputDir, assetName), contents)) {
    copiedOcctAssets += 1;
  }
}
const threeLicense = await readFile(path.join(root, "node_modules", "three", "LICENSE"));
if (await writeIfChanged(path.join(outputDir, "license.three.txt"), threeLicense)) {
  copiedOcctAssets += 1;
}
const result = await build({
  entryPoints: [path.join(root, "public", "app.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome136"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["/generated/model-runtime.js"],
  write: false
});
const output = result.outputFiles.find((file) => file.path.endsWith(".js")) || result.outputFiles[0];
const changed = await writeIfChanged(outputPath, output.contents);
const modelResult = await build({
  entryPoints: [path.join(root, "public", "model-runtime.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome136"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  write: false
});
const modelOutput = modelResult.outputFiles.find((file) => file.path.endsWith(".js")) || modelResult.outputFiles[0];
const modelChanged = await writeIfChanged(modelOutputPath, modelOutput.contents);
console.log(`Explore Better app runtime ${changed ? "built" : "unchanged"}.`);
console.log(`Explore Better 3D renderer ${modelChanged ? "built" : "unchanged"}.`);
console.log(`Explore Better local CAD runtime ${copiedOcctAssets ? `updated (${copiedOcctAssets} assets)` : "unchanged"}.`);
