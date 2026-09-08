import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { registryMetadata, sha256, validateReleaseVersion } from "./mcp-release-metadata.mjs";

const require = createRequire(import.meta.url);
const { ZipFile } = require("yazl");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const contract = JSON.parse(await fs.readFile(path.join(root, "mcp", "contracts-v1.json"), "utf8"));
const template = JSON.parse(await fs.readFile(path.join(root, "distribution", "mcpb", "manifest.template.json"), "utf8"));
const outputDir = path.join(root, "dist", "mcp");
const stageDir = path.join(root, "dist", "mcp-stage");
const artifactName = validateReleaseVersion(`v${packageJson.version}`, packageJson.version);
const artifactPath = path.join(outputDir, artifactName);
const fixedTime = new Date("2026-01-01T00:00:00.000Z");

async function copy(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function stageBundle() {
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });
  const manifest = {
    ...template,
    version: packageJson.version,
    tools: contract.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    prompts: contract.prompts.map((prompt) => ({ name: prompt.name, description: prompt.description }))
  };
  await fs.writeFile(path.join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await copy(path.join(root, "distribution", "mcpb", "README.md"), path.join(stageDir, "README.md"));
  await copy(path.join(root, "LICENSE"), path.join(stageDir, "LICENSE"));
  await copy(path.join(root, "native", "bin", "ExploreBetterMcp.exe"), path.join(stageDir, "server", "ExploreBetterMcp.exe"));
  await copy(path.join(root, "site", "assets", "app-icon.png"), path.join(stageDir, "assets", "icon.png"));
  await copy(path.join(root, "site", "assets", "ai-bridge.png"), path.join(stageDir, "assets", "ai-bridge.png"));
  await copy(path.join(root, "site", "assets", "disk-map.png"), path.join(stageDir, "assets", "disk-map.png"));
  return manifest;
}

async function bundleFiles(directory, current = "") {
  const entries = await fs.readdir(path.join(directory, current), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await bundleFiles(directory, relative)));
    else files.push(relative);
  }
  return files;
}

async function writeBundle() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(artifactPath, { force: true });
  const zip = new ZipFile();
  for (const relative of await bundleFiles(stageDir)) {
    zip.addFile(path.join(stageDir, relative), relative.split(path.sep).join("/"), {
      mtime: fixedTime,
      mode: relative.endsWith(".exe") ? 0o100755 : 0o100644,
      compress: !relative.endsWith(".png") && !relative.endsWith(".exe")
    });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(artifactPath));
}

const manifest = await stageBundle();
await writeBundle();
const artifact = await fs.readFile(artifactPath);
const artifactSha256 = sha256(artifact);
const serverJson = registryMetadata({ version: packageJson.version, artifactSha256 });
await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(outputDir, "server.json"), `${JSON.stringify(serverJson, null, 2)}\n`, "utf8");
await fs.writeFile(
  path.join(outputDir, "SHA256SUMS-mcp.txt"),
  `${artifactSha256}  ${artifactName}\n${sha256(await fs.readFile(path.join(root, "native", "bin", "ExploreBetterMcp.exe")))}  ExploreBetterMcp.exe\n${sha256(await fs.readFile(path.join(outputDir, "manifest.json")))}  manifest.json\n`,
  "utf8"
);

console.log(
  JSON.stringify({
    artifact: artifactPath,
    bytes: artifact.length,
    sha256: artifactSha256,
    tools: manifest.tools.length,
    prompts: manifest.prompts.length,
    serverJson: path.join(outputDir, "server.json")
  })
);
