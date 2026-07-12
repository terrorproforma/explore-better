import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "release-integrity-latest.json");
const latestMdPath = path.join(artifactsDir, "release-integrity-latest.md");

function statusCounts(checks) {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
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

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function relativePath(filePath) {
  return slashPath(path.relative(workspace, filePath));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fileRecord(filePath, id = relativePath(filePath)) {
  const stat = await fs.stat(filePath);
  return {
    id,
    path: filePath,
    relativePath: relativePath(filePath),
    size: stat.size,
    mtimeMs: Number(stat.mtimeMs) || 0,
    modifiedAt: stat.mtime.toISOString(),
    sha256: await hashFile(filePath)
  };
}

async function walkFiles(rootPath, results = []) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "artifacts") {
      continue;
    }
    const itemPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(itemPath, results);
    } else if (entry.isFile()) {
      results.push(itemPath);
    }
  }
  return results;
}

async function expandBuildFiles(pkg) {
  const configured = Array.isArray(pkg.build?.files) ? pkg.build.files : [];
  const files = new Set();
  for (const entry of configured) {
    if (!entry || entry.startsWith("!")) continue;
    if (entry.endsWith("/**/*")) {
      const root = path.join(workspace, entry.slice(0, -"/**/*".length));
      if (await pathExists(root)) {
        for (const filePath of await walkFiles(root)) files.add(filePath);
      }
      continue;
    }
    const direct = path.join(workspace, entry);
    if (await pathExists(direct)) {
      const stat = await fs.stat(direct);
      if (stat.isDirectory()) {
        for (const filePath of await walkFiles(direct)) files.add(filePath);
      } else if (stat.isFile()) {
        files.add(direct);
      }
    }
  }
  const lockPath = path.join(workspace, "package-lock.json");
  if (await pathExists(lockPath)) files.add(lockPath);
  const packagingInputs = [
    pkg.build?.icon,
    pkg.build?.win?.icon,
    pkg.build?.nsis?.installerIcon,
    pkg.build?.nsis?.uninstallerIcon,
    "scripts/generate-icon.mjs"
  ].filter(Boolean);
  for (const input of packagingInputs) {
    const inputPath = path.join(workspace, input);
    if (await pathExists(inputPath)) files.add(inputPath);
  }
  return [...files].sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
}

async function artifactCandidates(pkg) {
  const installerName = renderArtifactName(
    pkg.build?.nsis?.artifactName || pkg.build?.win?.artifactName || "ExploreBetter-${version}-${arch}-setup.${ext}",
    pkg,
    "exe"
  );
  const executable = process.platform === "win32" ? "Explore Better.exe" : "Explore Better";
  return [
    {
      id: "setup-installer",
      label: "NSIS setup installer",
      path: path.join(workspace, "dist", installerName),
      required: true
    },
    {
      id: "setup-blockmap",
      label: "NSIS setup blockmap",
      path: path.join(workspace, "dist", `${installerName}.blockmap`),
      required: true
    },
    {
      id: "unpacked-exe",
      label: "Unpacked desktop executable",
      path: path.join(workspace, "dist", "win-unpacked", executable),
      required: true
    },
    {
      id: "app-asar",
      label: "Packaged app archive",
      path: path.join(workspace, "dist", "win-unpacked", "resources", "app.asar"),
      required: true
    }
  ];
}

function newestRecord(records) {
  return records.reduce((best, record) => (!best || record.mtimeMs > best.mtimeMs ? record : best), null);
}

function oldestRecord(records) {
  return records.reduce((best, record) => (!best || record.mtimeMs < best.mtimeMs ? record : best), null);
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 520);
}

function hashShort(value) {
  return String(value || "").slice(0, 16);
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Release Integrity",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  lines.push("", "## Release Artifacts", "");
  lines.push("| Artifact | Size | Modified | SHA-256 |");
  lines.push("| --- | ---: | --- | --- |");
  for (const artifact of report.artifacts) {
    lines.push(
      `| ${tableValue(artifact.relativePath)} | ${artifact.size} | ${artifact.modifiedAt} | \`${hashShort(artifact.sha256)}...\` |`
    );
  }
  lines.push("", "## Source Inputs", "");
  lines.push("| Source | Size | Modified | SHA-256 |");
  lines.push("| --- | ---: | --- | --- |");
  for (const source of report.sources) {
    lines.push(`| ${tableValue(source.relativePath)} | ${source.size} | ${source.modifiedAt} | \`${hashShort(source.sha256)}...\` |`);
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of failures) lines.push(`- ${failure.label}: ${failure.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const checks = [];
  await fs.mkdir(artifactsDir, { recursive: true });
  const packagePath = path.join(workspace, "package.json");
  const packageText = await fs.readFile(packagePath, "utf8");
  const pkg = JSON.parse(packageText);
  addCheck(checks, "pass", "pkg-readable", "package.json readable", `${pkg.name}@${pkg.version}`);

  const sourcePaths = await expandBuildFiles(pkg);
  const sources = [];
  for (const sourcePath of sourcePaths) {
    sources.push(await fileRecord(sourcePath));
  }
  const requiredSources = ["build/icon.ico", "electron-main.mjs", "electron-preload.cjs", "server.mjs", "package.json", "scripts/generate-icon.mjs"];
  const sourceNames = new Set(sources.map((source) => source.relativePath));
  const missingSources = requiredSources.filter((name) => !sourceNames.has(name));
  const publicSources = sources.filter((source) => source.relativePath.startsWith("public/")).length;
  requireCheck(
    checks,
    missingSources.length === 0 && publicSources > 0,
    "source-manifest",
    "Packaged source manifest",
    missingSources.length
      ? `Missing ${missingSources.join(", ")}.`
      : `${sources.length} source input(s), including ${publicSources} public asset(s).`,
    { sourceCount: sources.length, publicSources }
  );

  const candidates = await artifactCandidates(pkg);
  const artifacts = [];
  const missingArtifacts = [];
  const emptyArtifacts = [];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate.path))) {
      missingArtifacts.push(candidate);
      continue;
    }
    const record = await fileRecord(candidate.path, candidate.id);
    artifacts.push({ ...record, label: candidate.label, required: candidate.required });
    if (record.size <= 0) emptyArtifacts.push(candidate);
  }

  requireCheck(
    checks,
    missingArtifacts.length === 0,
    "release-artifacts-present",
    "Required release artifacts present",
    missingArtifacts.length
      ? `Missing ${missingArtifacts.map((artifact) => relativePath(artifact.path)).join(", ")}.`
      : `${artifacts.length} required artifact(s) found.`,
    { missing: missingArtifacts.map((artifact) => artifact.path) }
  );
  requireCheck(
    checks,
    emptyArtifacts.length === 0,
    "release-artifacts-nonempty",
    "Release artifacts are non-empty",
    emptyArtifacts.length
      ? `Empty artifact(s): ${emptyArtifacts.map((artifact) => relativePath(artifact.path)).join(", ")}.`
      : "All release artifacts have non-zero size."
  );

  const newestSource = newestRecord(sources);
  const staleArtifacts = artifacts.filter((artifact) => newestSource && artifact.mtimeMs + 1000 < newestSource.mtimeMs);
  requireCheck(
    checks,
    staleArtifacts.length === 0,
    "release-artifacts-fresh",
    "Release artifacts cover packaged sources",
    staleArtifacts.length
      ? `Older than ${newestSource.relativePath}: ${staleArtifacts.map((artifact) => artifact.relativePath).join(", ")}. Run npm run package:dir and npm run package:installer.`
      : newestSource
        ? `Oldest artifact ${oldestRecord(artifacts)?.modifiedAt || "missing"} covers newest source ${newestSource.relativePath} (${newestSource.modifiedAt}).`
        : "No source inputs discovered."
  );

  const badHashes = [...artifacts, ...sources].filter((record) => !/^[a-f0-9]{64}$/.test(record.sha256 || ""));
  requireCheck(
    checks,
    badHashes.length === 0,
    "sha256-manifest",
    "SHA-256 manifest generated",
    badHashes.length ? `Invalid hashes for ${badHashes.map((record) => record.relativePath).join(", ")}.` : `${artifacts.length} artifact hash(es), ${sources.length} source hash(es).`
  );

  const expectedInstaller = renderArtifactName(
    pkg.build?.nsis?.artifactName || pkg.build?.win?.artifactName || "ExploreBetter-${version}-${arch}-setup.${ext}",
    pkg,
    "exe"
  );
  requireCheck(
    checks,
    artifacts.some((artifact) => artifact.relativePath === slashPath(path.join("dist", expectedInstaller))),
    "artifact-name-matches-config",
    "Installer artifact name matches build config",
    expectedInstaller
  );

  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    status: summary.fail > 0 ? "fail" : "pass",
    package: {
      name: pkg.name,
      version: pkg.version,
      productName: pkg.build?.productName || pkg.productName || null,
      appId: pkg.build?.appId || null,
      arch: buildArchName()
    },
    summary,
    checks,
    artifacts,
    sources
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`release integrity: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
