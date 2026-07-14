import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
const root = process.cwd();
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const contract = JSON.parse(await fs.readFile(path.join(root, "mcp", "contracts-v1.json"), "utf8"));
const artifactName = `ExploreBetter-MCP-${pkg.version}-windows-x64.mcpb`;
const artifactPath = path.join(root, "dist", "mcp", artifactName);
const sidecarPath = path.join(root, "native", "bin", "ExploreBetterMcp.exe");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

try {
  await fs.access(artifactPath);
} catch {
  const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-mcpb.mjs")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  assert(build.status === 0, `MCPB build failed:\n${build.stdout}\n${build.stderr}`);
}

function readZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = new Map();
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        assert(!entry.fileName.includes("..") && !path.isAbsolute(entry.fileName), `Unsafe MCPB entry: ${entry.fileName}`);
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}

const artifact = await fs.readFile(artifactPath);
const entries = await readZip(artifactPath);
for (const required of [
  "manifest.json",
  "README.md",
  "LICENSE",
  "server/ExploreBetterMcp.exe",
  "assets/icon.png",
  "assets/ai-bridge.png",
  "assets/disk-map.png"
]) {
  assert(entries.has(required), `MCPB is missing ${required}.`);
}

const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
assert(manifest.manifest_version === "0.3", "MCPB manifest version is not 0.3.");
assert(manifest.version === pkg.version, "MCPB version does not match package.json.");
assert(manifest.server?.type === "binary", "MCPB does not declare a binary server.");
assert(manifest.compatibility?.platforms?.length === 1 && manifest.compatibility.platforms[0] === "win32", "MCPB must be explicitly Windows-only.");
assert(manifest.user_config?.profile_id?.required === true, "MCPB must require an explicit revocable profile ID.");
assert(manifest.server.mcp_config.args.includes("${user_config.profile_id}"), "MCPB command does not bind the configured profile ID.");
assert(manifest.privacy_policies?.includes("https://terrorproforma.github.io/explore-better/privacy/"), "MCPB privacy policy is missing.");
assert(manifest.tools.length === contract.tools.length && manifest.tools.length === 28, "MCPB tool inventory is incomplete.");
assert(manifest.prompts.length === contract.prompts.length && manifest.prompts.length >= 3, "MCPB prompt inventory is incomplete.");
for (const tool of contract.tools) {
  assert(typeof tool.annotations?.readOnlyHint === "boolean", `${tool.name} is missing readOnlyHint.`);
  assert(typeof tool.annotations?.destructiveHint === "boolean", `${tool.name} is missing destructiveHint.`);
}

const serverJson = JSON.parse(await fs.readFile(path.join(root, "dist", "mcp", "server.json"), "utf8"));
assert(serverJson.name === "io.github.terrorproforma/explore-better", "Registry namespace is incorrect.");
assert(serverJson.version === pkg.version, "Registry version does not match package.json.");
assert(serverJson.description.length <= 100, "Registry description exceeds the 100-character limit.");
assert(serverJson.packages?.[0]?.registryType === "mcpb", "Registry package is not MCPB.");
assert(serverJson.packages[0].fileSha256 === sha256(artifact), "Registry SHA-256 does not match the MCPB.");
assert(serverJson.packages[0].identifier.endsWith(`/v${pkg.version}/${artifactName}`), "Registry release URL is incorrect.");

const contractResult = spawnSync(sidecarPath, ["--self-test-contract"], { encoding: "utf8", windowsHide: true });
assert(contractResult.status === 0, `Sidecar contract self-test failed: ${contractResult.stderr}`);
const contractReport = JSON.parse(contractResult.stdout.trim());
assert(contractReport.ok === true && contractReport.tools === 28, "Sidecar contract self-test reported an incomplete contract.");

const discoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mcpb-discovery-"));
try {
  const expected = path.join(discoveryRoot, "Programs", "Explore Better", "Explore Better.exe");
  await fs.mkdir(path.dirname(expected), { recursive: true });
  await fs.writeFile(expected, "fixture", "utf8");
  const discovery = spawnSync(sidecarPath, ["--discover-app"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, EXPLORE_BETTER_APP: "", LOCALAPPDATA: discoveryRoot }
  });
  assert(discovery.status === 0 && path.resolve(discovery.stdout.trim()) === path.resolve(expected), "Sidecar did not discover the standard per-user installation path.");
} finally {
  await fs.rm(discoveryRoot, { recursive: true, force: true });
}

console.log(`MCPB smoke passed: ${entries.size} files, ${manifest.tools.length} tools, ${manifest.prompts.length} prompts, ${artifact.length} bytes, sha256 ${sha256(artifact)}.`);
