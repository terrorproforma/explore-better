import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseVersion, verifyPublishedMcpRelease } from "./mcp-release-metadata.mjs";

const options = new Map(process.argv.slice(2).map((argument) => {
  const equals = argument.indexOf("=");
  if (equals === -1) throw new Error("Use --name=value arguments.");
  return [argument.slice(0, equals), argument.slice(equals + 1)];
}));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = options.get("--tag");
const repository = options.get("--repository");
const assetsDir = options.get("--assets");
const releaseFile = options.get("--release");
const outputDir = path.resolve(options.get("--output") || path.join(root, "dist", "mcp-registry"));
if (!tag || !repository || !assetsDir || !releaseFile) throw new Error("Provide --tag, --repository, --assets and --release explicitly.");
const packageJson = JSON.parse(await fs.readFile(options.get("--package") || path.join(root, "package.json"), "utf8"));
const artifactName = validateReleaseVersion(tag, packageJson.version);
const [release, artifact, manifest, checksums] = await Promise.all([
  fs.readFile(releaseFile, "utf8").then(JSON.parse),
  fs.readFile(path.join(assetsDir, artifactName)),
  fs.readFile(path.join(assetsDir, "manifest.json")),
  fs.readFile(path.join(assetsDir, "SHA256SUMS-mcp.txt"))
]);
const result = await verifyPublishedMcpRelease({ tag, packageVersion: packageJson.version, repository, release, artifact, manifest, checksums });
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "server.json"), `${JSON.stringify(result.server, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, "verified-release.json"), `${JSON.stringify({ tag, version: packageJson.version, releaseId: release.id, artifactName, artifactSha256: result.artifactSha256, manifestSha256: result.manifestSha256, sidecarSha256: result.sidecarSha256 }, null, 2)}\n`);
console.log(`Prepared Registry metadata for published ${tag}; MCPB SHA-256 ${result.artifactSha256}.`);
