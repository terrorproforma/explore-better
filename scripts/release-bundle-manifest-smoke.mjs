import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const distDir = path.join(workspace, "dist");
const manifestJsonPath = path.join(distDir, "release-bundle-manifest.json");
const manifestMdPath = path.join(distDir, "release-bundle-manifest.md");
const latestJsonPath = path.join(artifactsDir, "release-bundle-latest.json");
const latestMdPath = path.join(artifactsDir, "release-bundle-latest.md");

function buildArchName() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "ia32") return "ia32";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function relativePath(filePath) {
  return slashPath(path.relative(workspace, filePath));
}

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

function renderArtifactName(template, pkg, ext) {
  return String(template || "")
    .replaceAll("${productName}", pkg.build?.productName || pkg.productName || pkg.name || "ExploreBetter")
    .replaceAll("${name}", pkg.name || "explore-better")
    .replaceAll("${version}", pkg.version || "0.0.0")
    .replaceAll("${arch}", buildArchName())
    .replaceAll("${ext}", ext);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function hashFile(filePath, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest(encoding)));
  });
}

async function fileRecord(filePath, id, label) {
  const stat = await fs.stat(filePath);
  return {
    id,
    label,
    path: filePath,
    relativePath: relativePath(filePath),
    size: stat.size,
    mtimeMs: Number(stat.mtimeMs) || 0,
    modifiedAt: stat.mtime.toISOString(),
    sha256: await hashFile(filePath, "sha256", "hex"),
    sha512: await hashFile(filePath, "sha512", "base64")
  };
}

function hashShort(value) {
  return String(value || "").slice(0, 16);
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 520);
}

function reportByCheckId(report, id) {
  return (Array.isArray(report?.checks) ? report.checks : []).find((check) => check.id === id);
}

function reportHasPass(report, id) {
  return reportByCheckId(report, id)?.status === "pass";
}

function artifactById(report, id) {
  return (Array.isArray(report?.artifacts) ? report.artifacts : []).find((artifact) => artifact.id === id);
}

function assetById(report, id) {
  return (Array.isArray(report?.assets) ? report.assets : []).find((artifact) => artifact.id === id);
}

function sourceById(report, id) {
  return (Array.isArray(report?.sources) ? report.sources : []).find((artifact) => artifact.id === id);
}

function summaryOk(report) {
  return report?.status === "pass" && Number(report.summary?.fail || 0) === 0;
}

async function loadEvidenceReport(checks, id, fileName, label) {
  const filePath = path.join(artifactsDir, fileName);
  if (!(await pathExists(filePath))) {
    addCheck(checks, "fail", `${id}-report-present`, `${label} report exists`, `${fileName} is missing.`, { reportPath: relativePath(filePath) });
    return null;
  }
  try {
    const data = await readJson(filePath);
    addCheck(checks, "pass", `${id}-report-present`, `${label} report exists`, fileName, { reportPath: relativePath(filePath), generatedAt: data.generatedAt || null });
    return data;
  } catch (error) {
    addCheck(checks, "fail", `${id}-report-readable`, `${label} report is readable JSON`, error.message, { reportPath: relativePath(filePath) });
    return null;
  }
}

function expectedReleaseArtifacts(pkg) {
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
      path: path.join(distDir, installerName)
    },
    {
      id: "setup-blockmap",
      label: "NSIS setup blockmap",
      path: path.join(distDir, `${installerName}.blockmap`)
    },
    {
      id: "unpacked-exe",
      label: "Unpacked desktop executable",
      path: path.join(distDir, "win-unpacked", executable)
    },
    {
      id: "app-asar",
      label: "Packaged app archive",
      path: path.join(distDir, "win-unpacked", "resources", "app.asar")
    },
    {
      id: "feed-latest-yml",
      label: "Static update latest.yml",
      path: path.join(distDir, "update-feed", "latest.yml")
    },
    {
      id: "feed-installer",
      label: "Static update installer asset",
      path: path.join(distDir, "update-feed", installerName)
    },
    {
      id: "feed-blockmap",
      label: "Static update blockmap asset",
      path: path.join(distDir, "update-feed", `${installerName}.blockmap`)
    }
  ];
}

function validateReleaseIntegrity(checks, integrity, records) {
  if (!integrity) return;
  const required = ["setup-installer", "setup-blockmap", "unpacked-exe", "app-asar"];
  const recordById = new Map(records.map((record) => [record.id, record]));
  const missing = required.filter((id) => !artifactById(integrity, id));
  requireCheck(
    checks,
    summaryOk(integrity) && missing.length === 0,
    "integrity-report-pass",
    "Release integrity report passes",
    summaryOk(integrity) && missing.length === 0
      ? `${integrity.artifacts?.length || 0} artifact hash(es), ${integrity.sources?.length || 0} source hash(es).`
      : `Missing or failing release integrity evidence: ${missing.join(", ") || "summary"}.`
  );
  const mismatches = [];
  for (const id of required) {
    const integrityArtifact = artifactById(integrity, id);
    const current = recordById.get(id);
    if (!integrityArtifact || !current) continue;
    if (integrityArtifact.sha256 !== current.sha256 || Number(integrityArtifact.size || 0) !== current.size) {
      mismatches.push(id);
    }
  }
  requireCheck(
    checks,
    mismatches.length === 0,
    "integrity-hashes-current",
    "Release integrity hashes match current dist artifacts",
    mismatches.length ? `Mismatched artifact(s): ${mismatches.join(", ")}.` : `${required.length} dist artifact hash(es) match.`
  );
}

function validateUpdateFeed(checks, feedReport, desktopReport, records, pkg) {
  if (!feedReport) return;
  const byId = new Map(records.map((record) => [record.id, record]));
  const installer = byId.get("setup-installer");
  const blockmap = byId.get("setup-blockmap");
  const feedInstaller = byId.get("feed-installer");
  const feedBlockmap = byId.get("feed-blockmap");
  const feedLatest = byId.get("feed-latest-yml");
  const reportInstaller = assetById(feedReport, "setup-installer");
  const reportBlockmap = assetById(feedReport, "setup-blockmap");
  const sourceInstaller = sourceById(feedReport, "source-installer");
  const sourceBlockmap = sourceById(feedReport, "source-blockmap");
  const feedContent = String(feedReport.feed?.content || "");
  const assetMatches =
    installer &&
    blockmap &&
    feedInstaller &&
    feedBlockmap &&
    reportInstaller &&
    reportBlockmap &&
    sourceInstaller &&
    sourceBlockmap &&
    installer.sha256 === feedInstaller.sha256 &&
    blockmap.sha256 === feedBlockmap.sha256 &&
    reportInstaller.sha256 === installer.sha256 &&
    reportBlockmap.sha256 === blockmap.sha256 &&
    sourceInstaller.sha256 === installer.sha256 &&
    sourceBlockmap.sha256 === blockmap.sha256;

  requireCheck(
    checks,
    summaryOk(feedReport) && assetMatches,
    "update-feed-assets-match",
    "Static update feed assets match release artifacts",
    assetMatches ? `installer=${installer.size} bytes, blockmap=${blockmap.size} bytes.` : "Installer/blockmap hashes do not align across dist, feed, and report."
  );

  const latestOk =
    feedLatest &&
    feedReport.feed?.sha256 === feedLatest.sha256 &&
    feedContent.includes(`version: ${pkg.version}`) &&
    feedContent.includes(`path: ${path.basename(installer?.path || "")}`) &&
    feedContent.includes(`sha512: ${installer?.sha512 || ""}`) &&
    feedContent.includes(`size: ${installer?.size || ""}`) &&
    feedContent.includes(`blockMapSize: ${blockmap?.size || ""}`);
  requireCheck(
    checks,
    latestOk,
    "update-feed-latest-yml-current",
    "latest.yml points at the current release",
    latestOk ? `${feedLatest.relativePath} advertises ${pkg.version}.` : "latest.yml content or hash does not match the current release."
  );

  if (!desktopReport) return;
  const desktopOk =
    desktopReport.status === "pass" &&
    desktopReport.updateCheck?.event === "not-available" &&
    desktopReport.updateCheck?.available === false &&
    desktopReport.updateCheck?.version === pkg.version &&
    (desktopReport.feed?.requests || []).some((request) => request.path === "/latest.yml");
  requireCheck(
    checks,
    desktopOk,
    "update-feed-desktop-smoke-pass",
    "Desktop updater consumes generated release feed",
    desktopOk
      ? `event=${desktopReport.updateCheck.event}, version=${desktopReport.updateCheck.version}.`
      : "Desktop updater smoke did not prove latest.yml consumption for the current release."
  );
}

function validateCodeSigning(checks, signingReport, records) {
  if (!signingReport) return;
  const installer = records.find((record) => record.id === "setup-installer");
  const ok =
    summaryOk(signingReport) &&
    signingReport.signing?.removedCertificate === true &&
    signingReport.signing?.signerThumbprint &&
    signingReport.signing?.verifyStatus !== "NotSigned" &&
    signingReport.sourceBefore?.sha256 &&
    signingReport.sourceBefore.sha256 === signingReport.sourceAfter?.sha256 &&
    signingReport.sourceAfter?.sha256 === installer?.sha256 &&
    signingReport.signedCopy?.sha256 &&
    signingReport.signedCopy.sha256 !== installer?.sha256 &&
    Number(signingReport.signedCopy?.size || 0) > Number(installer?.size || 0);
  requireCheck(
    checks,
    ok,
    "code-signing-rehearsal-pass",
    "Code-signing rehearsal proves copied-installer signing",
    ok
      ? `temporary cert ${String(signingReport.signing.thumbprint || "").slice(0, 10)}... removed; source installer preserved.`
      : "Signing rehearsal did not prove signer metadata, source hash preservation, signed-copy mutation, and cert cleanup."
  );
}

function validateShell(checks, shellReport) {
  if (!shellReport) return;
  const ok =
    summaryOk(shellReport) &&
    reportHasPass(shellReport, "real-hkcu-installed") &&
    reportHasPass(shellReport, "installed-handler-shell-open") &&
    reportHasPass(shellReport, "registry-restored") &&
    Array.isArray(shellReport.registry?.mismatchedKeys) &&
    shellReport.registry.mismatchedKeys.length === 0 &&
    Array.isArray(shellReport.registry?.mismatchedStatus) &&
    shellReport.registry.mismatchedStatus.length === 0;
  requireCheck(
    checks,
    ok,
    "shell-current-user-pass",
    "Current-user shell install/revert proof is present",
    ok
      ? "Real HKCU handlers installed, desktop handler opened a target, and registry/status snapshots matched after restore."
      : "Current-user shell report did not prove install, shell-open, restore, and snapshot equality."
  );
}

function validateReadiness(checks, readinessReport) {
  if (!readinessReport) return;
  const failCount = Number(readinessReport.summary?.fail || 0);
  const warnCount = Number(readinessReport.summary?.warn || 0);
  requireCheck(
    checks,
    readinessReport.status !== "fail" && failCount === 0,
    "release-readiness-no-fail",
    "Release readiness has no hard failures",
    failCount === 0 ? `${readinessReport.summary?.pass || 0} pass, ${warnCount} warning(s).` : `${failCount} hard failure(s).`,
    { readinessWarnings: warnCount }
  );
}

function manifestReport(records, reports, pkg) {
  return {
    generatedAt: new Date().toISOString(),
    workspace,
    package: {
      name: pkg.name,
      version: pkg.version,
      productName: pkg.build?.productName || pkg.productName || null,
      appId: pkg.build?.appId || null,
      arch: buildArchName()
    },
    artifacts: records.map((record) => ({
      id: record.id,
      label: record.label,
      relativePath: record.relativePath,
      size: record.size,
      modifiedAt: record.modifiedAt,
      sha256: record.sha256,
      sha512: record.sha512
    })),
    evidence: {
      releaseIntegrity: {
        generatedAt: reports.integrity?.generatedAt || null,
        status: reports.integrity?.status || null,
        summary: reports.integrity?.summary || null
      },
      releaseUpdateFeed: {
        generatedAt: reports.feed?.generatedAt || null,
        status: reports.feed?.status || null,
        summary: reports.feed?.summary || null,
        copyModes: reports.feed?.copyModes || null
      },
      releaseUpdateFeedDesktop: {
        generatedAt: reports.desktopFeed?.generatedAt || null,
        status: reports.desktopFeed?.status || null,
        updateCheck: reports.desktopFeed?.updateCheck || null
      },
      codeSigningRehearsal: {
        generatedAt: reports.signing?.generatedAt || null,
        status: reports.signing?.status || null,
        summary: reports.signing?.summary || null,
        thumbprint: reports.signing?.signing?.thumbprint || null,
        verifyStatus: reports.signing?.signing?.verifyStatus || null,
        removedCertificate: reports.signing?.signing?.removedCertificate === true
      },
      currentUserShell: {
        generatedAt: reports.shell?.generatedAt || null,
        status: reports.shell?.status || null,
        summary: reports.shell?.summary || null,
        mismatchedKeys: reports.shell?.registry?.mismatchedKeys || [],
        mismatchedStatus: reports.shell?.registry?.mismatchedStatus || []
      },
      releaseReadiness: {
        generatedAt: reports.readiness?.generatedAt || null,
        status: reports.readiness?.status || null,
        summary: reports.readiness?.summary || null
      }
    }
  };
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Release Bundle Manifest",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Package: ${report.package.name}@${report.package.version} (${report.package.arch})`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  lines.push("", "## Bundle Artifacts", "");
  lines.push("| Artifact | Size | Modified | SHA-256 |");
  lines.push("| --- | ---: | --- | --- |");
  for (const artifact of report.manifest.artifacts) {
    lines.push(
      `| ${tableValue(artifact.relativePath)} | ${artifact.size} | ${artifact.modifiedAt} | \`${hashShort(artifact.sha256)}...\` |`
    );
  }
  lines.push("", "## Evidence", "");
  lines.push("| Evidence | Status | Detail |");
  lines.push("| --- | --- | --- |");
  const evidence = report.manifest.evidence;
  lines.push(`| Release integrity | ${tableValue(evidence.releaseIntegrity.status)} | ${tableValue(evidence.releaseIntegrity.generatedAt)} |`);
  lines.push(`| Static update feed | ${tableValue(evidence.releaseUpdateFeed.status)} | ${tableValue(evidence.releaseUpdateFeed.generatedAt)} |`);
  lines.push(`| Desktop update smoke | ${tableValue(evidence.releaseUpdateFeedDesktop.status)} | ${tableValue(evidence.releaseUpdateFeedDesktop.updateCheck?.event)} ${tableValue(evidence.releaseUpdateFeedDesktop.updateCheck?.version)} |`);
  lines.push(`| Code signing rehearsal | ${tableValue(evidence.codeSigningRehearsal.status)} | ${tableValue(evidence.codeSigningRehearsal.verifyStatus)} certRemoved=${evidence.codeSigningRehearsal.removedCertificate} |`);
  lines.push(`| Current-user shell | ${tableValue(evidence.currentUserShell.status)} | mismatches=${evidence.currentUserShell.mismatchedKeys.length + evidence.currentUserShell.mismatchedStatus.length} |`);
  lines.push(`| Release readiness | ${tableValue(evidence.releaseReadiness.status)} | ${tableValue(evidence.releaseReadiness.generatedAt)} |`);
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
  await fs.mkdir(distDir, { recursive: true });

  const packagePath = path.join(workspace, "package.json");
  const pkg = await readJson(packagePath);
  addCheck(checks, "pass", "pkg-readable", "package.json readable", `${pkg.name}@${pkg.version}`);

  const expected = expectedReleaseArtifacts(pkg);
  const records = [];
  const missing = [];
  const empty = [];
  for (const artifact of expected) {
    if (!(await pathExists(artifact.path))) {
      missing.push(artifact);
      continue;
    }
    const record = await fileRecord(artifact.path, artifact.id, artifact.label);
    records.push(record);
    if (record.size <= 0) empty.push(record);
  }
  requireCheck(
    checks,
    missing.length === 0,
    "bundle-artifacts-present",
    "Bundle release artifacts exist",
    missing.length ? `Missing ${missing.map((artifact) => relativePath(artifact.path)).join(", ")}.` : `${records.length} artifact(s) found.`
  );
  requireCheck(
    checks,
    empty.length === 0,
    "bundle-artifacts-nonempty",
    "Bundle release artifacts are non-empty",
    empty.length ? `Empty artifact(s): ${empty.map((artifact) => artifact.relativePath).join(", ")}.` : "All bundle artifacts have non-zero size."
  );

  const badHashes = records.filter((record) => !/^[a-f0-9]{64}$/.test(record.sha256 || "") || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.sha512 || ""));
  requireCheck(
    checks,
    badHashes.length === 0,
    "bundle-hashes-generated",
    "Bundle SHA-256 and SHA-512 hashes generated",
    badHashes.length ? `Bad hashes for ${badHashes.map((record) => record.relativePath).join(", ")}.` : `${records.length} artifact hash pair(s).`
  );

  const reports = {
    integrity: await loadEvidenceReport(checks, "integrity", "release-integrity-latest.json", "Release integrity"),
    feed: await loadEvidenceReport(checks, "update-feed", "release-update-feed-latest.json", "Static update feed"),
    desktopFeed: await loadEvidenceReport(checks, "update-feed-desktop", "release-update-feed-desktop-latest.json", "Desktop update feed smoke"),
    signing: await loadEvidenceReport(checks, "code-signing", "code-signing-rehearsal-latest.json", "Code-signing rehearsal"),
    shell: await loadEvidenceReport(checks, "shell-current-user", "shell-current-user-latest.json", "Current-user shell"),
    readiness: await loadEvidenceReport(checks, "release-readiness", "release-readiness-latest.json", "Release readiness")
  };

  validateReleaseIntegrity(checks, reports.integrity, records);
  validateUpdateFeed(checks, reports.feed, reports.desktopFeed, records, pkg);
  validateCodeSigning(checks, reports.signing, records);
  validateShell(checks, reports.shell);
  validateReadiness(checks, reports.readiness);

  const manifest = manifestReport(records, reports, pkg);
  const summary = statusCounts(checks);
  const report = {
    generatedAt: manifest.generatedAt,
    workspace,
    status: summary.fail > 0 ? "fail" : "pass",
    package: manifest.package,
    summary,
    manifestPath: relativePath(manifestJsonPath),
    manifestMarkdownPath: relativePath(manifestMdPath),
    checks,
    manifest
  };

  await fs.writeFile(manifestJsonPath, JSON.stringify(manifest, null, 2), "utf8");
  await fs.writeFile(manifestMdPath, markdownReport(report), "utf8");
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");

  console.log(`release bundle: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${manifestJsonPath}`);
  console.log(`wrote ${manifestMdPath}`);
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
