import crypto from "node:crypto";
import { createRequire } from "node:module";

const yauzl = createRequire(import.meta.url)("yauzl");
export const releaseRepository = "terrorproforma/explore-better";
export const registryName = "io.github.terrorproforma/explore-better";
export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function matchesReleaseUrl(value, expectedPath) {
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && decodeURIComponent(url.pathname) === expectedPath && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function validateReleaseVersion(tag, version) {
  requireValue(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(version)), "The package version must be a release version.");
  requireValue(tag === `v${version}`, "The selected release tag must exactly match package.json version.");
  return `ExploreBetter-MCP-${version}-windows-x64.mcpb`;
}

export function registryMetadata({ version, artifactSha256, tag = `v${version}` }) {
  const artifactName = validateReleaseVersion(tag, version);
  requireValue(/^[a-f0-9]{64}$/.test(artifactSha256), "The MCPB SHA-256 is invalid.");
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: registryName,
    title: "Explore Better",
    description: "AI-native Windows file manager for scoped discovery, disk analysis, and recoverable operations.",
    repository: { url: `https://github.com/${releaseRepository}`, source: "github" },
    version,
    packages: [{
      registryType: "mcpb",
      identifier: `https://github.com/${releaseRepository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifactName)}`,
      fileSha256: artifactSha256,
      transport: { type: "stdio" }
    }]
  };
}

function checksumEntries(bytes) {
  const entries = new Map();
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/);
    requireValue(match, "The published MCP checksums contain an invalid line.");
    requireValue(!entries.has(match[2]), `The published checksums repeat ${match[2]}.`);
    entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function bundleEvidence(bytes) {
  requireValue(bytes.length <= 256 * 1024 * 1024, "The published MCPB exceeds the validation size limit.");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const names = new Set();
      const result = {};
      const fail = (error) => { zip.close(); reject(error); };
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        if (names.has(entry.fileName) || names.size >= 1000) return fail(new Error("The MCPB contains duplicate entries or too many files."));
        names.add(entry.fileName);
        if (!["manifest.json", "server/ExploreBetterMcp.exe"].includes(entry.fileName)) return zip.readEntry();
        const limit = entry.fileName === "manifest.json" ? 1024 * 1024 : 128 * 1024 * 1024;
        if (entry.uncompressedSize > limit) return fail(new Error(`The MCPB entry ${entry.fileName} exceeds its validation limit.`));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const hash = crypto.createHash("sha256");
          const chunks = [];
          let length = 0;
          stream.on("error", fail);
          stream.on("data", (chunk) => {
            length += chunk.length;
            if (length > limit) { stream.destroy(new Error("The MCPB entry exceeds its validation limit.")); return; }
            hash.update(chunk);
            if (entry.fileName === "manifest.json") chunks.push(chunk);
          });
          stream.on("end", () => {
            if (entry.fileName === "manifest.json") result.manifest = Buffer.concat(chunks);
            else result.sidecarSha256 = hash.digest("hex");
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(result));
      zip.readEntry();
    });
  });
}

export async function verifyPublishedMcpRelease({ tag, packageVersion, repository = releaseRepository, release, artifact, manifest, checksums }) {
  requireValue(repository === releaseRepository, "Registry publication is restricted to the canonical repository.");
  const artifactName = validateReleaseVersion(tag, packageVersion);
  requireValue(release?.tag_name === tag && release.draft === false && Number.isFinite(Date.parse(release.published_at)), "Select an already-published release with the matching tag.");
  requireValue(matchesReleaseUrl(release.html_url, `/${releaseRepository}/releases/tag/${tag}`), "The published release belongs to a different repository or tag.");
  const files = new Map([[artifactName, artifact], ["manifest.json", manifest], ["SHA256SUMS-mcp.txt", checksums]]);
  for (const [name, bytes] of files) {
    const assets = (release.assets || []).filter((asset) => asset.name === name);
    requireValue(assets.length === 1, `The published release must contain exactly one ${name} asset.`);
    const asset = assets[0];
    requireValue(asset.state === "uploaded" && asset.size === bytes.length, `Published asset metadata does not match ${name}.`);
    requireValue(matchesReleaseUrl(asset.browser_download_url, `/${releaseRepository}/releases/download/${tag}/${name}`), `Published asset ${name} points to a different release.`);
    if (asset.digest) requireValue(asset.digest === `sha256:${sha256(bytes)}`, `The GitHub digest does not match ${name}.`);
  }
  const hashes = checksumEntries(checksums);
  const artifactSha256 = sha256(artifact);
  requireValue(hashes.get(artifactName) === artifactSha256, "The published MCPB does not match its release checksum.");
  const embedded = await bundleEvidence(artifact);
  requireValue(embedded.manifest?.equals(manifest), "The published manifest differs from the manifest inside the MCPB.");
  const manifestJson = JSON.parse(manifest.toString("utf8"));
  requireValue(manifestJson.version === packageVersion && manifestJson.name === "explore-better", "The published MCPB manifest does not match the selected release version.");
  requireValue(embedded.sidecarSha256 && hashes.get("ExploreBetterMcp.exe") === embedded.sidecarSha256, "The sidecar inside the MCPB does not match its release checksum.");
  if (hashes.has("manifest.json")) requireValue(hashes.get("manifest.json") === sha256(manifest), "The published manifest checksum is incorrect.");
  return { artifactName, artifactSha256, manifestSha256: sha256(manifest), sidecarSha256: embedded.sidecarSha256, server: registryMetadata({ version: packageVersion, tag, artifactSha256 }) };
}
