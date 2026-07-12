import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const distDir = path.join(workspace, "dist");
const feedDir = path.join(distDir, "update-feed");
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "release-update-feed-latest.json");
const latestMdPath = path.join(artifactsDir, "release-update-feed-latest.md");

function buildArchName() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "ia32") return "ia32";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function renderArtifactName(template, pkg, ext) {
  return String(template || "")
    .replaceAll("${productName}", pkg.build?.productName || pkg.productName || pkg.name || "ExploreBetter")
    .replaceAll("${name}", pkg.name || "explore-better")
    .replaceAll("${version}", pkg.version || "0.0.0")
    .replaceAll("${arch}", buildArchName())
    .replaceAll("${ext}", ext);
}

function statusCounts(checks) {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length
  };
}

function addCheck(checks, status, id, label, detail = "", data = {}) {
  checks.push({ status, id, label, detail, ...data });
}

function requireCheck(checks, condition, id, label, detail = "", data = {}) {
  addCheck(checks, condition ? "pass" : "fail", id, label, detail, data);
  return Boolean(condition);
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

async function statRecord(filePath) {
  const stat = await fs.stat(filePath);
  return {
    path: filePath,
    relativePath: path.relative(workspace, filePath).replaceAll("\\", "/"),
    size: Number(stat.size) || 0,
    mtimeMs: Number(stat.mtimeMs) || 0,
    modifiedAt: stat.mtime.toISOString()
  };
}

async function hashFile(filePath, algorithm, digest) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest(digest)));
  });
}

async function assetRecord(filePath, id) {
  const record = await statRecord(filePath);
  return {
    ...record,
    id,
    sha256: await hashFile(filePath, "sha256", "hex"),
    sha512: await hashFile(filePath, "sha512", "base64")
  };
}

async function linkOrCopyFile(source, dest) {
  await fs.rm(dest, { force: true });
  try {
    await fs.link(source, dest);
    return "hardlink";
  } catch {
    await fs.copyFile(source, dest);
    return "copy";
  }
}

function yamlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function updateFeedYaml({ version, installerName, installer, blockmap }) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${installerName}`,
    `    sha512: ${installer.sha512}`,
    `    size: ${installer.size}`,
    `    blockMapSize: ${blockmap.size}`,
    `path: ${installerName}`,
    `sha512: ${installer.sha512}`,
    `releaseDate: ${yamlQuote(new Date().toISOString())}`,
    ""
  ].join("\n");
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Release Update Feed",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Status: ${report.status}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.`,
    "",
    `Feed: ${report.feed?.relativePath || "missing"}`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  lines.push("", "## Assets", "");
  lines.push("| Asset | Size | SHA-256 | SHA-512 |");
  lines.push("| --- | ---: | --- | --- |");
  for (const asset of report.assets || []) {
    lines.push(`| ${tableValue(asset.relativePath)} | ${asset.size} | \`${asset.sha256.slice(0, 16)}...\` | \`${asset.sha512.slice(0, 16)}...\` |`);
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of failures) lines.push(`- ${failure.label}: ${failure.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function readPackage() {
  const packagePath = path.join(workspace, "package.json");
  const text = await fs.readFile(packagePath, "utf8");
  return JSON.parse(text);
}

async function main() {
  const checks = [];
  await fs.mkdir(artifactsDir, { recursive: true });
  const pkg = await readPackage();
  const installerName = renderArtifactName(
    pkg.build?.nsis?.artifactName || pkg.build?.win?.artifactName || "ExploreBetter-${version}-${arch}-setup.${ext}",
    pkg,
    "exe"
  );
  const blockmapName = `${installerName}.blockmap`;
  const installerSource = path.join(distDir, installerName);
  const blockmapSource = path.join(distDir, blockmapName);
  const installerPresent = await pathExists(installerSource);
  const blockmapPresent = await pathExists(blockmapSource);
  requireCheck(checks, installerPresent, "installer-present", "Setup installer exists", installerPresent ? installerSource : `Missing ${installerSource}`);
  requireCheck(checks, blockmapPresent, "blockmap-present", "Setup blockmap exists", blockmapPresent ? blockmapSource : `Missing ${blockmapSource}`);

  let installer = null;
  let blockmap = null;
  let feed = null;
  const assets = [];
  const sources = [];
  const copyModes = {};
  if (installerPresent && blockmapPresent) {
    await fs.mkdir(feedDir, { recursive: true });
    const installerDest = path.join(feedDir, installerName);
    const blockmapDest = path.join(feedDir, blockmapName);
    copyModes.installer = await linkOrCopyFile(installerSource, installerDest);
    copyModes.blockmap = await linkOrCopyFile(blockmapSource, blockmapDest);
    installer = await assetRecord(installerDest, "setup-installer");
    blockmap = await assetRecord(blockmapDest, "setup-blockmap");
    assets.push(installer, blockmap);
    const sourceInstaller = await assetRecord(installerSource, "source-installer");
    const sourceBlockmap = await assetRecord(blockmapSource, "source-blockmap");
    sources.push(sourceInstaller, sourceBlockmap);
    requireCheck(
      checks,
      installer.sha256 === sourceInstaller.sha256 && blockmap.sha256 === sourceBlockmap.sha256,
      "feed-assets-match-dist",
      "Feed assets match dist artifacts",
      `installer=${copyModes.installer}, blockmap=${copyModes.blockmap}`
    );
    requireCheck(
      checks,
      installer.size > 0 && blockmap.size > 0,
      "feed-assets-nonempty",
      "Feed assets are non-empty",
      `${installer.size} bytes installer, ${blockmap.size} bytes blockmap`
    );

    const latestYmlPath = path.join(feedDir, "latest.yml");
    const yaml = updateFeedYaml({ version: pkg.version, installerName, installer, blockmap });
    await fs.writeFile(latestYmlPath, yaml, "utf8");
    feed = await statRecord(latestYmlPath);
    feed.sha256 = await hashFile(latestYmlPath, "sha256", "hex");
    feed.content = yaml;
    requireCheck(
      checks,
      yaml.includes(`version: ${pkg.version}`) &&
        yaml.includes(`url: ${installerName}`) &&
        yaml.includes(`path: ${installerName}`) &&
        yaml.includes(`sha512: ${installer.sha512}`) &&
        yaml.includes(`blockMapSize: ${blockmap.size}`),
      "latest-yml-content",
      "latest.yml references release installer and blockmap",
      `${feed.relativePath} -> ${installerName}`
    );
    requireCheck(
      checks,
      /^[A-Za-z0-9+/]+={0,2}$/.test(installer.sha512) && installer.sha512.length > 64,
      "installer-sha512",
      "Installer SHA-512 is electron-updater compatible",
      `${installer.sha512.slice(0, 20)}...`
    );
  }

  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    status: summary.fail > 0 ? "fail" : "pass",
    package: {
      name: pkg.name,
      version: pkg.version,
      arch: buildArchName()
    },
    feedRoot: feedDir,
    summary,
    checks,
    feed,
    assets,
    sources,
    copyModes
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`release update feed: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${feed?.path || path.join(feedDir, "latest.yml")}`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    const failures = checks.filter((check) => check.status === "fail");
    console.error(`failures: ${failures.map((check) => `${check.id}: ${check.detail}`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
