import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "production-readiness-latest.json");
const latestMdPath = path.join(artifactsDir, "production-readiness-latest.md");
const strictMode = process.argv.includes("--strict") || process.env.EB_PRODUCTION_READINESS_STRICT === "1";

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

function warningStatus() {
  return strictMode ? "fail" : "warn";
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

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function relativePath(filePath) {
  return slashPath(path.relative(workspace, filePath));
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function envValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return { name, value };
  }
  return { name: null, value: "" };
}

function checkById(report, id) {
  return (Array.isArray(report?.checks) ? report.checks : []).find((check) => check.id === id);
}

function summaryHasNoFailures(report) {
  return report?.status !== "fail" && Number(report?.summary?.fail || 0) === 0;
}

function summaryIsPass(report) {
  return report?.status === "pass" && Number(report?.summary?.fail || 0) === 0;
}

function reportSummaryDetail(report) {
  if (!report) return "missing";
  const summary = report.summary || {};
  const status = report.status || (Number(summary.fail || 0) > 0 ? "fail" : Number(summary.warn || 0) > 0 ? "warn" : "pass");
  return `${status} (${summary.pass || 0} pass, ${summary.warn || 0} warn, ${summary.fail || 0} fail)`;
}

async function loadReport(checks, id, fileName, label) {
  const filePath = path.join(artifactsDir, fileName);
  if (!(await pathExists(filePath))) {
    addCheck(checks, "fail", `${id}-artifact-present`, `${label} artifact exists`, `${fileName} is missing.`, {
      artifact: fileName,
      path: filePath
    });
    return { id, label, fileName, filePath, data: null };
  }
  try {
    const data = await readJson(filePath);
    addCheck(checks, "pass", `${id}-artifact-readable`, `${label} artifact is readable`, `${fileName} generated ${data.generatedAt || "unknown"}.`, {
      artifact: fileName,
      path: filePath,
      generatedAt: data.generatedAt || null
    });
    return { id, label, fileName, filePath, data };
  } catch (error) {
    addCheck(checks, "fail", `${id}-artifact-readable`, `${label} artifact is readable`, error.message, {
      artifact: fileName,
      path: filePath
    });
    return { id, label, fileName, filePath, data: null };
  }
}

function addLocalGate(checks, checklist, id, label, ok, detail, command, evidence = {}) {
  const item = {
    id,
    label,
    status: ok ? "pass" : "fail",
    detail,
    command,
    external: false,
    ...evidence
  };
  checklist.push(item);
  addCheck(checks, item.status, id, label, detail, { command, localGate: true, evidence });
  return item;
}

function addExternalGate(checks, checklist, id, label, ok, detail, command, evidence = {}) {
  const item = {
    id,
    label,
    status: ok ? "pass" : warningStatus(),
    detail,
    command,
    external: true,
    ...evidence
  };
  checklist.push(item);
  addCheck(checks, item.status, id, label, detail, { command, externalGate: true, evidence });
  return item;
}

function artifactSnapshot(loaded) {
  return {
    fileName: loaded.fileName,
    path: relativePath(loaded.filePath),
    generatedAt: loaded.data?.generatedAt || null,
    status: loaded.data?.status || null,
    summary: loaded.data?.summary || null
  };
}

function expectedCommands() {
  return {
    local: [
      "npm run package:dir",
      "npm run package:installer",
      "npm run verify:release-readiness",
      "npm run verify:release-integrity",
      "npm run verify:code-signing",
      "npm run build:update-feed",
      "npm run verify:release-update-feed",
      "npm run verify:release-update-feed-desktop",
      "npm run verify:auto-update-feed",
      "npm run verify:shell-rehearsal",
      "npm run verify:shell-current-user",
      "npm run verify:release-bundle",
      "npm run verify:production-readiness"
    ],
    production: [
      "$env:EXPLORE_BETTER_SIGNING_THUMBPRINT=\"<cert thumbprint>\"",
      "$env:EXPLORE_BETTER_UPDATE_URL=\"https://example.com/explore-better/releases/\"",
      "npm run verify:production-signing",
      "npm run verify:hosted-update-feed",
      "npm run verify:external-proof -- --strict",
      "npm run verify:production-readiness -- --strict"
    ]
  };
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Production Readiness",
    "",
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.strict ? "strict" : "advisory"}`,
    "",
    `Package: ${report.package.name}@${report.package.version}`,
    "",
    `Status: ${report.status}`,
    "",
    `Local release ready: ${report.localReady ? "yes" : "no"}`,
    `Production publish ready: ${report.productionReady ? "yes" : "no"}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
    "",
    "| Status | Check | Detail | Command |",
    "| --- | --- | --- | --- |"
  ];
  for (const item of report.readinessChecklist) {
    lines.push(`| ${item.status.toUpperCase()} | ${tableValue(item.label)} | ${tableValue(item.detail)} | \`${tableValue(item.command)}\` |`);
  }
  if (report.externalBlockers.length) {
    lines.push("", "## External Blockers", "");
    for (const blocker of report.externalBlockers) {
      lines.push(`- ${blocker.label}: ${blocker.detail}`);
    }
  }
  lines.push("", "## Local Commands", "");
  for (const command of report.commands.local) lines.push(`- \`${command}\``);
  lines.push("", "## Production Commands", "");
  for (const command of report.commands.production) lines.push(`- \`${command}\``);
  lines.push("", "## Evidence Artifacts", "");
  lines.push("| Artifact | Status | Generated |");
  lines.push("| --- | --- | --- |");
  for (const artifact of Object.values(report.artifacts)) {
    lines.push(`| ${tableValue(artifact.path)} | ${tableValue(artifact.status)} | ${tableValue(artifact.generatedAt)} |`);
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
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const readinessChecklist = [];
  const pkgPath = path.join(workspace, "package.json");
  const pkg = await readJson(pkgPath);
  addCheck(checks, "pass", "pkg-readable", "package.json readable", `${pkg.name}@${pkg.version}`, {
    path: relativePath(pkgPath)
  });

  const scripts = [
    "package:dir",
    "package:installer",
    "verify:release-readiness",
    "verify:release-integrity",
    "verify:code-signing",
    "verify:production-signing",
    "build:update-feed",
    "verify:release-update-feed",
    "verify:release-update-feed-desktop",
    "verify:auto-update-feed",
    "verify:shell-rehearsal",
    "verify:shell-current-user",
    "verify:release-bundle",
    "verify:hosted-update-feed",
    "verify:external-proof",
    "verify:production-readiness"
  ];
  for (const scriptName of scripts) {
    requireCheck(checks, Boolean(pkg.scripts?.[scriptName]), `script-${scriptName}`, `Package script ${scriptName}`, pkg.scripts?.[scriptName] || "missing");
  }

  const reports = {
    readiness: await loadReport(checks, "release-readiness", "release-readiness-latest.json", "Release readiness"),
    integrity: await loadReport(checks, "release-integrity", "release-integrity-latest.json", "Release integrity"),
    codeSigning: await loadReport(checks, "code-signing", "code-signing-rehearsal-latest.json", "Code-signing rehearsal"),
    productionSigning: await loadReport(checks, "production-signing", "production-signing-latest.json", "Production signing"),
    updateFeed: await loadReport(checks, "release-update-feed", "release-update-feed-latest.json", "Static update feed"),
    desktopUpdateFeed: await loadReport(checks, "release-update-feed-desktop", "release-update-feed-desktop-latest.json", "Desktop update feed"),
    autoUpdateFeed: await loadReport(checks, "auto-update-feed", "auto-update-feed-latest.json", "Auto-update feed"),
    shellRehearsal: await loadReport(checks, "shell-rehearsal", "shell-rehearsal-latest.json", "Shell rehearsal"),
    shellCurrentUser: await loadReport(checks, "shell-current-user", "shell-current-user-latest.json", "Current-user shell"),
    releaseBundle: await loadReport(checks, "release-bundle", "release-bundle-latest.json", "Release bundle"),
    hostedUpdateFeed: await loadReport(checks, "hosted-update-feed", "hosted-update-feed-latest.json", "Hosted update feed"),
    externalProof: await loadReport(checks, "external-proof", "external-proof-latest.json", "External proof")
  };

  addLocalGate(
    checks,
    readinessChecklist,
    "local-release-readiness-no-fail",
    "Release readiness has no hard failures",
    summaryHasNoFailures(reports.readiness.data),
    reportSummaryDetail(reports.readiness.data),
    "npm run verify:release-readiness"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-release-integrity-pass",
    "Release integrity manifest passes",
    summaryIsPass(reports.integrity.data),
    reportSummaryDetail(reports.integrity.data),
    "npm run verify:release-integrity"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-code-signing-rehearsal-pass",
    "Code-signing rehearsal passes",
    summaryIsPass(reports.codeSigning.data),
    reportSummaryDetail(reports.codeSigning.data),
    "npm run verify:code-signing",
    { verifyStatus: reports.codeSigning.data?.signing?.verifyStatus || null }
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-static-update-feed-pass",
    "Static update feed passes",
    summaryIsPass(reports.updateFeed.data),
    reportSummaryDetail(reports.updateFeed.data),
    "npm run verify:release-update-feed"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-desktop-update-smoke-pass",
    "Desktop update-feed smoke passes",
    summaryIsPass(reports.desktopUpdateFeed.data) && reports.desktopUpdateFeed.data?.updateCheck?.event === "not-available",
    `${reportSummaryDetail(reports.desktopUpdateFeed.data)}; event=${reports.desktopUpdateFeed.data?.updateCheck?.event || "missing"}.`,
    "npm run verify:release-update-feed-desktop"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-auto-update-smoke-pass",
    "Configured-feed updater smoke passes",
    summaryIsPass(reports.autoUpdateFeed.data) && reports.autoUpdateFeed.data?.updateCheck?.event === "available",
    `${reportSummaryDetail(reports.autoUpdateFeed.data)}; event=${reports.autoUpdateFeed.data?.updateCheck?.event || "missing"}.`,
    "npm run verify:auto-update-feed"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-shell-rehearsal-no-fail",
    "Shell replacement rehearsal has no hard failures",
    summaryHasNoFailures(reports.shellRehearsal.data),
    reportSummaryDetail(reports.shellRehearsal.data),
    "npm run verify:shell-rehearsal"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-current-user-shell-pass",
    "Current-user shell install/revert passes",
    summaryIsPass(reports.shellCurrentUser.data),
    reportSummaryDetail(reports.shellCurrentUser.data),
    "npm run verify:shell-current-user"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-release-bundle-pass",
    "Release bundle manifest passes",
    summaryIsPass(reports.releaseBundle.data),
    reportSummaryDetail(reports.releaseBundle.data),
    "npm run verify:release-bundle",
    { manifestPath: reports.releaseBundle.data?.manifestPath || null }
  );

  const signingEnv = {
    thumbprint: envValue("EXPLORE_BETTER_SIGNING_THUMBPRINT", "EB_SIGNING_THUMBPRINT"),
    subject: envValue("EXPLORE_BETTER_SIGNING_SUBJECT", "EB_SIGNING_SUBJECT")
  };
  const signingConfigured = Boolean(signingEnv.thumbprint.value || signingEnv.subject.value || reports.productionSigning.data?.expected?.configured === true);
  const signingPassed = reports.productionSigning.data?.status === "pass" && reports.productionSigning.data?.expected?.configured === true;
  addExternalGate(
    checks,
    readinessChecklist,
    "external-production-signing",
    "Production Authenticode signing is configured and trusted",
    signingPassed,
    signingPassed
      ? `${(reports.productionSigning.data?.signatures || []).length} signed target(s) matched the expected certificate.`
      : signingConfigured
        ? "Signing expectation is configured, but the latest production-signing artifact is not passing. Re-run the verifier with the certificate environment."
        : "Set EXPLORE_BETTER_SIGNING_THUMBPRINT or EXPLORE_BETTER_SIGNING_SUBJECT, sign the installer/EXE, then verify.",
    "npm run verify:production-signing",
    {
      configured: signingConfigured,
      configuredBy: [signingEnv.thumbprint.name, signingEnv.subject.name].filter(Boolean),
      expected: reports.productionSigning.data?.expected || null
    }
  );

  const feedEnv = envValue("EXPLORE_BETTER_UPDATE_URL", "EB_UPDATE_URL");
  const hostedConfigured = Boolean(feedEnv.value || reports.hostedUpdateFeed.data?.feed?.configuredUrl || reports.hostedUpdateFeed.data?.status === "pass");
  const hostedPassed = reports.hostedUpdateFeed.data?.status === "pass";
  addExternalGate(
    checks,
    readinessChecklist,
    "external-hosted-update-feed",
    "Hosted production update feed matches the bundle",
    hostedPassed,
    hostedPassed
      ? `Hosted feed matched ${reports.hostedUpdateFeed.data?.package?.version || pkg.version}.`
      : hostedConfigured
        ? "Hosted feed URL is configured, but the latest hosted-feed artifact is not passing. Re-run the hosted verifier."
        : "Set EXPLORE_BETTER_UPDATE_URL or EB_UPDATE_URL to the hosted release feed, then verify.",
    "npm run verify:hosted-update-feed",
    {
      configured: hostedConfigured,
      configuredBy: feedEnv.name ? [feedEnv.name] : [],
      latestUrl: reports.hostedUpdateFeed.data?.feed?.latestUrl || null
    }
  );

  const externalPassed = reports.externalProof.data?.status === "pass" && reports.externalProof.data?.strict === true;
  addExternalGate(
    checks,
    readinessChecklist,
    "external-strict-certification",
    "Strict external certification passes",
    externalPassed,
    externalPassed
      ? "Strict external proof passed for hardware, signing, and hosted feed."
      : "Run strict external proof after attaching shell hardware, configuring production signing, and publishing the update feed.",
    "npm run verify:external-proof -- --strict",
    {
      strict: reports.externalProof.data?.strict === true,
      summary: reports.externalProof.data?.summary || null
    }
  );

  const localReady = readinessChecklist.filter((item) => !item.external).every((item) => item.status === "pass");
  const externalBlockers = readinessChecklist.filter((item) => item.external && item.status !== "pass");
  const productionReady = localReady && externalBlockers.length === 0;
  const summary = statusCounts(checks);
  const status = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    strict: strictMode,
    status,
    package: {
      name: pkg.name,
      version: pkg.version,
      productName: pkg.build?.productName || pkg.productName || pkg.name
    },
    summary,
    localReady,
    productionReady,
    checks,
    readinessChecklist,
    externalBlockers,
    externalRequirements: {
      productionSigning: {
        configured: signingConfigured,
        configuredBy: [signingEnv.thumbprint.name, signingEnv.subject.name].filter(Boolean),
        passing: signingPassed
      },
      hostedUpdateFeed: {
        configured: hostedConfigured,
        configuredBy: feedEnv.name ? [feedEnv.name] : [],
        passing: hostedPassed
      },
      strictExternalProof: {
        passing: externalPassed,
        strict: reports.externalProof.data?.strict === true
      }
    },
    commands: expectedCommands(),
    artifacts: Object.fromEntries(Object.entries(reports).map(([id, loaded]) => [id, artifactSnapshot(loaded)]))
  };

  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`production readiness: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`local ready: ${localReady ? "yes" : "no"}; production ready: ${productionReady ? "yes" : "no"}`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    const failures = checks.filter((check) => check.status === "fail");
    console.error(`failures: ${failures.map((check) => `${check.id}: ${check.detail}`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const checks = [
    {
      status: "fail",
      id: "production-readiness-error",
      label: "Production readiness verifier crashed",
      detail: error.stack || error.message
    }
  ];
  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    strict: strictMode,
    status: "fail",
    summary,
    localReady: false,
    productionReady: false,
    checks,
    readinessChecklist: [],
    externalBlockers: [],
    externalRequirements: {},
    commands: expectedCommands(),
    artifacts: {}
  };
  await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
