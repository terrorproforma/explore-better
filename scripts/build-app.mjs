import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "public", "generated");
const outputPath = path.join(outputDir, "app-runtime.js");

async function writeIfChanged(file, contents) {
  const current = await readFile(file).catch(() => null);
  if (current?.equals(contents)) return false;
  await writeFile(file, contents);
  return true;
}

await mkdir(outputDir, { recursive: true });
const result = await build({
  entryPoints: [path.join(root, "public", "app.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome136"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  write: false
});
const output = result.outputFiles.find((file) => file.path.endsWith(".js")) || result.outputFiles[0];
const changed = await writeIfChanged(outputPath, output.contents);
console.log(`Explore Better app runtime ${changed ? "built" : "unchanged"}.`);
