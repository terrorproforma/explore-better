// Rewrites every version-bearing string on the website for the version in package.json.
//
// The published GitHub release asset is the source of truth for the installer hash and size,
// because installer builds are not byte-reproducible. Sources, in priority order:
//   --checksum=<sha256> (--size-bytes=<n> | --size-mib=<n>)   explicit values
//   --installer=<path>                                         hash a local installer
//   --use-existing                                             reuse site/release.json (same version only)
//   (default)                                                  `gh api` release asset digest + size
// Other options: --date=YYYY-MM-DD (dateModified, default today UTC), --repo=owner/name,
// --skip-pages (do not regenerate discovery pages and sitemap).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/atomic-write.mjs";

const workspace = process.cwd();
const siteRoot = path.join(workspace, "site");
const args = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    return separator === -1
      ? [argument.replace(/^--/, ""), "true"]
      : [argument.slice(0, separator).replace(/^--/, ""), argument.slice(separator + 1)];
  })
);
const VERSION = String.raw`\d+\.\d+\.\d+`;

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function gh(argv) {
  try {
    return execFileSync("gh", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    throw new Error(`gh ${argv.slice(0, 3).join(" ")} failed: ${detail}`);
  }
}

function checksumFromSums(text, installer) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2].trim() === installer) return match[1].toLowerCase();
  }
  return "";
}

async function publishedAsset(repo, tag, installer) {
  const release = JSON.parse(gh(["api", `repos/${repo}/releases/tags/${tag}`]));
  const asset = (release.assets || []).find((candidate) => candidate.name === installer);
  if (!asset) throw new Error(`Release ${tag} in ${repo} has no asset named ${installer}. Publish the release first or pass --checksum/--size-bytes.`);
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || "")?.[1]?.toLowerCase() || "";
  let sums = "";
  if ((release.assets || []).some((candidate) => candidate.name === "SHA256SUMS.txt")) {
    sums = checksumFromSums(gh(["release", "download", tag, "--repo", repo, "--pattern", "SHA256SUMS.txt", "--output", "-"]), installer);
  }
  if (digest && sums && digest !== sums) {
    throw new Error(`GitHub digest ${digest} disagrees with SHA256SUMS.txt entry ${sums} for ${installer}.`);
  }
  const sha256 = digest || sums;
  if (!sha256) throw new Error(`Could not determine the SHA-256 of ${installer}: no asset digest and no SHA256SUMS.txt entry.`);
  if (!(release.assets || []).some((candidate) => /^ExploreBetter-MCP-.+\.mcpb$/.test(candidate.name))) {
    console.warn(`Warning: release ${tag} has no ExploreBetter-MCP-*.mcpb asset, but the site links to it for the MCP bundle.`);
  }
  return { sha256, sizeBytes: Number(asset.size), source: `GitHub release ${repo}@${tag}` };
}

async function resolveInstaller(version, installer, tag, repo) {
  if (args.has("checksum")) {
    const sizeBytes = args.has("size-bytes") ? Number(args.get("size-bytes")) : undefined;
    const sizeMiB = args.has("size-mib") ? Number(args.get("size-mib")) : undefined;
    if (sizeBytes === undefined && sizeMiB === undefined) throw new Error("--checksum requires --size-bytes or --size-mib");
    return { sha256: args.get("checksum"), sizeBytes, sizeMiB, source: "command-line arguments" };
  }
  if (args.has("installer")) {
    const installerPath = path.resolve(workspace, args.get("installer"));
    const stat = await fs.stat(installerPath);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Installer is missing or empty: ${installerPath}`);
    console.warn("Warning: hashing a local installer. Builds are not reproducible; prefer the published release asset.");
    return { sha256: await hashFile(installerPath), sizeBytes: stat.size, source: installerPath };
  }
  if (args.has("use-existing")) {
    const existing = JSON.parse(await fs.readFile(path.join(siteRoot, "release.json"), "utf8"));
    if (existing.version !== version) {
      throw new Error(`--use-existing needs site/release.json at ${version}, but it is at ${existing.version}.`);
    }
    return { sha256: existing.sha256, sizeMiB: existing.sizeMiB, source: "existing site/release.json" };
  }
  return publishedAsset(repo, tag, installer);
}

// Each rule must match at least `min` times, so markup drift fails loudly instead of silently
// leaving a stale version behind. Rules are idempotent: re-running with the same values is a no-op.
function applyRules(label, text, rules) {
  let result = text;
  for (const rule of rules) {
    const count = [...result.matchAll(rule.pattern)].length;
    if (count < (rule.min ?? 1)) {
      throw new Error(`${label}: expected ${rule.min ?? 1}+ match(es) for ${rule.name}, found ${count}; check the markup.`);
    }
    result = result.replace(rule.pattern, rule.replace);
    if (!result.includes(rule.expect)) throw new Error(`${label}: ${rule.name} does not contain "${rule.expect}" after update.`);
  }
  return result;
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf8"));
  const version = String(pkg.version || "").trim();
  if (!new RegExp(`^${VERSION}$`).test(version)) throw new Error(`package.json version "${version}" is not X.Y.Z`);
  const tag = `v${version}`;
  const installer = `ExploreBetter-${version}-x64-setup.exe`;
  const repo = args.get("repo") || "terrorproforma/explore-better";
  const date = args.get("date") || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");

  const resolved = await resolveInstaller(version, installer, tag, repo);
  const sha256 = String(resolved.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("The installer SHA-256 must contain exactly 64 hexadecimal characters");
  const sizeMiB = resolved.sizeMiB ?? Math.round((resolved.sizeBytes / 1024 / 1024) * 10) / 10;
  if (!Number.isFinite(sizeMiB) || sizeMiB <= 0) throw new Error("The installer size must be a positive number");

  const release = { version, installer, sizeMiB, sha256 };
  const downloadUrl = `releases/download/${tag}/${installer}`;
  const writes = new Map();
  const read = (relative) => fs.readFile(path.join(siteRoot, relative), "utf8");

  writes.set("index.html", applyRules("index.html", await read("index.html"), [
    { name: "installer download URLs", min: 2, pattern: new RegExp(`releases/download/v${VERSION}/ExploreBetter-${VERSION}-x64-setup\\.exe`, "g"), replace: downloadUrl, expect: downloadUrl },
    { name: "SHA256SUMS link", pattern: new RegExp(`releases/download/v${VERSION}/SHA256SUMS\\.txt`, "g"), replace: `releases/download/${tag}/SHA256SUMS.txt`, expect: `releases/download/${tag}/SHA256SUMS.txt` },
    { name: "JSON-LD softwareVersion", pattern: new RegExp(`("softwareVersion":\\s*")${VERSION}"`, "g"), replace: `$1${version}"`, expect: `"softwareVersion": "${version}"` },
    { name: "release notes links", min: 2, pattern: new RegExp(`releases/tag/v${VERSION}`, "g"), replace: `releases/tag/${tag}`, expect: `releases/tag/${tag}` },
    { name: "source tree link", pattern: new RegExp(`(explore-better/tree/)v${VERSION}(">Source at )v${VERSION}`, "g"), replace: `$1${tag}$2${tag}`, expect: `tree/${tag}">Source at ${tag}` },
    { name: "download button text", pattern: new RegExp(`(Download Explore Better )v${VERSION}`, "g"), replace: `$1${tag}`, expect: `Download Explore Better ${tag}` },
    { name: "release eyebrow", pattern: new RegExp(`(<p class="eyebrow">Explore Better )v${VERSION}( /)`, "g"), replace: `$1${tag}$2`, expect: `<p class="eyebrow">Explore Better ${tag} /` },
    { name: "Get-FileHash command", pattern: new RegExp(`(Get-FileHash \\.\\\\)ExploreBetter-${VERSION}-x64-setup\\.exe`, "g"), replace: `$1${installer}`, expect: `Get-FileHash .\\${installer}` },
    { name: "checksum", pattern: /(<code data-checksum>)[^<]+(<\/code>)/g, replace: `$1${sha256}$2`, expect: `<code data-checksum>${sha256}</code>` },
    { name: "installer size", pattern: /(<p class="download-facts">Windows x64 \/ )[0-9.]+( MiB)/g, replace: `$1${sizeMiB}$2`, expect: `Windows x64 / ${sizeMiB} MiB` }
  ]));

  const mcpPath = path.join("mcp", "index.html");
  const mcpOriginal = await read(mcpPath);
  let mcp = applyRules(mcpPath, mcpOriginal, [
    { name: "JSON-LD softwareVersion", pattern: new RegExp(`("softwareVersion":\\s*")${VERSION}"`, "g"), replace: `$1${version}"`, expect: `"softwareVersion": "${version}"` }
  ]);
  if (mcp !== mcpOriginal) {
    mcp = applyRules(mcpPath, mcp, [
      { name: "TechArticle dateModified", pattern: /("dateModified":\s*")\d{4}-\d{2}-\d{2}"/g, replace: `$1${date}"`, expect: `"dateModified": "${date}"` }
    ]);
  }
  writes.set(mcpPath, mcp);

  writes.set("llms.txt", applyRules("llms.txt", await read("llms.txt"), [
    { name: "MCP bundle release link", pattern: new RegExp(`releases/tag/v${VERSION}`, "g"), replace: `releases/tag/${tag}`, expect: `releases/tag/${tag}` }
  ]));
  writes.set("llms-full.txt", applyRules("llms-full.txt", await read("llms-full.txt"), [
    { name: "current public version", pattern: new RegExp(`(Current public version: )${VERSION}`, "g"), replace: `$1${version}`, expect: `Current public version: ${version}` }
  ]));
  writes.set("release.json", `${JSON.stringify(release, null, 2)}\n`);

  const changed = [];
  for (const [relative, content] of writes) {
    const target = path.join(siteRoot, relative);
    const before = await fs.readFile(target, "utf8").catch(() => "");
    if (before.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n")) continue;
    await writeFileAtomic(target, content);
    changed.push(`site/${relative.replaceAll("\\", "/")}`);
  }

  if (!args.has("skip-pages")) {
    // Regenerates the discovery pages (MCPB release link) and the sitemap lastmod dates.
    execFileSync(process.execPath, [path.join(workspace, "scripts", "build-site-discovery-pages.mjs")], { cwd: workspace, stdio: "inherit" });
  }

  console.log(`Updated website release metadata for ${tag} from ${resolved.source}`);
  console.log(`${release.sha256}  ${release.installer}`);
  console.log(`${release.sizeMiB} MiB`);
  console.log(changed.length ? `Changed: ${changed.join(", ")}` : "Release files were already up to date.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
