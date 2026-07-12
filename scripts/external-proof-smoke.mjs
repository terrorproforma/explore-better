import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "external-proof-latest.json");
const latestMdPath = path.join(artifactsDir, "external-proof-latest.md");
const strictMode = process.argv.includes("--strict") || process.env.EB_EXTERNAL_PROOF_STRICT === "1";
const skipRefresh = process.argv.includes("--skip-refresh") || process.env.EB_EXTERNAL_PROOF_SKIP_REFRESH === "1";
const refreshTimeoutMs = Math.max(30000, Number(process.env.EB_EXTERNAL_PROOF_REFRESH_TIMEOUT_MS || 180000));

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

function warnCheck(checks, condition, id, label, detail = "", data = {}) {
  addCheck(checks, condition ? "pass" : "warn", id, label, detail, data);
  return Boolean(condition);
}

function checkById(report, id) {
  return (Array.isArray(report?.checks) ? report.checks : []).find((check) => check.id === id);
}

function hasPass(report, id) {
  return checkById(report, id)?.status === "pass";
}

function summaryIsPass(report) {
  return report?.status === "pass" && Number(report.summary?.fail || 0) === 0;
}

function summaryHasNoFailures(report) {
  return report?.status !== "fail" && Number(report.summary?.fail || 0) === 0;
}

function limitedAppend(current, chunk, limit = 36000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function runCommand(commandText, { timeoutMs = refreshTimeoutMs } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const command = process.platform === "win32" ? "cmd.exe" : "sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", commandText] : ["-lc", commandText];
    try {
      child = spawn(command, args, {
        cwd: workspace,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: null, error: error.message, stdout, stderr, command: commandText });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, timedOut: true, stdout, stderr, command: commandText });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = limitedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitedAppend(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: null, error: error.message, stdout, stderr, command: commandText });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, command: commandText });
    });
  });
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

function artifactPath(name) {
  return path.join(artifactsDir, name);
}

function ageMsFrom(data, stat) {
  const generatedAt = Date.parse(data?.generatedAt || "");
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Date.now() - Number(stat?.mtimeMs || 0);
}

function formatAge(ms) {
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

async function loadArtifact(checks, fileName, label) {
  const filePath = artifactPath(fileName);
  try {
    const stat = await fs.stat(filePath);
    const data = await readJson(filePath);
    addCheck(checks, "pass", `${fileName.replace(/\.json$/, "")}-present`, `${label} artifact exists`, `${fileName} (${formatAge(ageMsFrom(data, stat))} old).`, {
      path: filePath,
      generatedAt: data.generatedAt || null
    });
    return { data, filePath, ageMs: ageMsFrom(data, stat) };
  } catch (error) {
    addCheck(checks, "fail", `${fileName.replace(/\.json$/, "")}-present`, `${label} artifact exists`, error.message, { path: filePath });
    return { data: null, filePath, ageMs: null };
  }
}

async function refreshExternalProofs(checks) {
  const commands = [
    {
      id: "code-signing-rehearsal-refresh",
      label: "Refresh code-signing rehearsal proof",
      command: "npm run verify:code-signing",
      required: true
    },
    {
      id: "release-update-feed-refresh",
      label: "Refresh static update feed proof",
      command: "npm run verify:release-update-feed",
      required: true
    },
    {
      id: "release-update-feed-desktop-refresh",
      label: "Refresh desktop update feed proof",
      command: "npm run verify:release-update-feed-desktop",
      required: true
    },
    {
      id: "release-readiness-refresh",
      label: "Refresh release readiness proof",
      command: "npm run verify:release-readiness",
      required: true
    },
    {
      id: "release-integrity-refresh",
      label: "Refresh release integrity proof",
      command: "npm run verify:release-integrity",
      required: true
    },
    {
      id: "release-bundle-refresh",
      label: "Refresh release bundle proof",
      command: "npm run verify:release-bundle",
      required: true
    },
    {
      id: "shell-devices-refresh",
      label: "Refresh shell device proof",
      command: strictMode ? "npm run verify:shell-devices -- --require-device" : "npm run verify:shell-devices",
      required: false
    },
    {
      id: "production-signing-refresh",
      label: "Refresh production signing proof",
      command: "npm run verify:production-signing",
      required: false
    },
    {
      id: "hosted-feed-refresh",
      label: "Refresh hosted update feed proof",
      command: "npm run verify:hosted-update-feed",
      required: false
    }
  ];
  const results = [];
  for (const item of commands) {
    const result = await runCommand(item.command);
    const ok = result.code === 0 && !result.timedOut && !result.error;
    const status = ok ? "pass" : item.required || strictMode ? "fail" : "warn";
    addCheck(
      checks,
      status,
      item.id,
      item.label,
      ok
        ? "Command exited cleanly."
        : result.timedOut
          ? "Command timed out."
          : result.error || `Exit ${result.code}.`,
      { command: item.command }
    );
    results.push({
      id: item.id,
      command: item.command,
      code: result.code,
      timedOut: result.timedOut === true,
      error: result.error || null,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
  return results;
}

function guide() {
  return {
    summary: "External production certification requires physical shell hardware, a real signing certificate, and a hosted update feed.",
    strictCommand: "npm run verify:external-proof -- --strict",
    steps: [
      {
        id: "release-bundle",
        label: "Rebuild current release",
        command: "npm run package:dir && npm run package:installer && npm run verify:external-proof",
        detail: "Rebuild the unpacked app and setup installer before final certification. The external proof command refreshes code signing rehearsal, update feed, desktop updater smoke, release readiness, release integrity, and bundle manifest evidence."
      },
      {
        id: "shell-device",
        label: "Attach phone/camera",
        command: "npm run verify:shell-devices -- --require-device",
        detail: "Attach an unlocked phone, camera, or MTP/PTP device, allow file-transfer access, confirm it appears under This PC, then run the strict shell-device verifier."
      },
      {
        id: "production-signing",
        label: "Configure signing certificate",
        command: "npm run verify:production-signing",
        detail: "Set EXPLORE_BETTER_SIGNING_THUMBPRINT or EXPLORE_BETTER_SIGNING_SUBJECT to the real production certificate before running the verifier."
      },
      {
        id: "hosted-update-feed",
        label: "Configure hosted feed",
        command: "npm run verify:hosted-update-feed",
        detail: "Set EXPLORE_BETTER_UPDATE_URL or EB_UPDATE_URL to the hosted generic feed base URL or latest.yml URL."
      }
    ]
  };
}

function evaluateReleasePrerequisites(checks, data) {
  const { readiness, integrity, updateFeed, desktopUpdateFeed, codeSigning, bundle } = data;
  if (readiness) {
    const expected = ["release-installer-artifact", "release-packaged-freshness", "release-update-feed-desktop-smoke", "desktop-smoke-window"];
    const missing = expected.filter((id) => !hasPass(readiness, id));
    requireCheck(
      checks,
      summaryHasNoFailures(readiness) && missing.length === 0,
      "external-release-readiness",
      "Release readiness proof is current",
      missing.length
        ? `Missing readiness pass check(s): ${missing.join(", ")}.`
        : `${readiness.summary?.pass || 0} pass, ${readiness.summary?.warn || 0} warning(s).`
    );
  }
  if (integrity) {
    const expected = ["release-artifacts-present", "release-artifacts-fresh", "sha256-manifest", "artifact-name-matches-config"];
    const missing = expected.filter((id) => !hasPass(integrity, id));
    requireCheck(
      checks,
      summaryIsPass(integrity) && missing.length === 0,
      "external-release-integrity",
      "Release integrity proof is current",
      missing.length ? `Missing integrity pass check(s): ${missing.join(", ")}.` : `${integrity.artifacts?.length || 0} release artifact hash(es).`
    );
  }
  if (updateFeed) {
    requireCheck(
      checks,
      summaryIsPass(updateFeed),
      "external-release-update-feed",
      "Static update feed proof is current",
      summaryIsPass(updateFeed) ? `${updateFeed.assets?.length || 0} feed asset(s) matched.` : "Static update feed report is missing or failing."
    );
  }
  if (desktopUpdateFeed) {
    const desktopOk =
      desktopUpdateFeed.status === "pass" &&
      desktopUpdateFeed.updateCheck?.event === "not-available" &&
      desktopUpdateFeed.updateCheck?.available === false &&
      (desktopUpdateFeed.feed?.requests || []).some((request) => request.path === "/latest.yml");
    requireCheck(
      checks,
      desktopOk,
      "external-release-update-feed-desktop",
      "Desktop updater consumed current static feed",
      desktopOk
        ? `event=${desktopUpdateFeed.updateCheck.event}, version=${desktopUpdateFeed.updateCheck.version}.`
        : "Desktop updater smoke did not prove latest.yml consumption."
    );
  }
  if (codeSigning) {
    const rehearsalOk =
      summaryIsPass(codeSigning) &&
      codeSigning.signing?.removedCertificate === true &&
      codeSigning.signing?.signerThumbprint &&
      codeSigning.sourceBefore?.sha256 === codeSigning.sourceAfter?.sha256 &&
      codeSigning.sourceAfter?.sha256 !== codeSigning.signedCopy?.sha256;
    requireCheck(
      checks,
      rehearsalOk,
      "external-code-signing-rehearsal",
      "Code-signing rehearsal proof is current",
      rehearsalOk
        ? `temporary cert ${String(codeSigning.signing.thumbprint || "").slice(0, 10)}... removed.`
        : "Code-signing rehearsal did not prove copied-installer signing and cleanup."
    );
  }
  if (bundle) {
    const expected = [
      "bundle-artifacts-present",
      "bundle-artifacts-nonempty",
      "bundle-hashes-generated",
      "integrity-report-pass",
      "integrity-hashes-current",
      "update-feed-assets-match",
      "update-feed-latest-yml-current",
      "update-feed-desktop-smoke-pass",
      "code-signing-rehearsal-pass",
      "shell-current-user-pass",
      "release-readiness-no-fail"
    ];
    const missing = expected.filter((id) => !hasPass(bundle, id));
    const artifactCount = Array.isArray(bundle.manifest?.artifacts) ? bundle.manifest.artifacts.length : 0;
    requireCheck(
      checks,
      summaryIsPass(bundle) && missing.length === 0 && artifactCount >= 7,
      "external-release-bundle",
      "Current release bundle proof",
      missing.length
        ? `Missing bundle pass check(s): ${missing.join(", ")}.`
        : `${artifactCount} bundled artifact(s) cross-checked against readiness, integrity, feed, signing, and shell evidence.`
    );
  }
}

function evaluateShellDevice(checks, data) {
  if (!data) return;
  if (data.summary?.fail > 0 || data.status === "fail") {
    addCheck(checks, "fail", "external-shell-device", "Physical shell device proof", `${data.summary?.fail || 1} shell-device failure(s).`);
    return;
  }
  const safetyOk =
    data.invariants?.nonFilesystemNeverPaneOpen === true &&
    data.invariants?.portableDevicesMarkedShellDevices === true &&
    data.thisPc?.warmCached === true;
  requireCheck(
    checks,
    safetyOk,
    "external-shell-device-safety",
    "Shell device safety invariants",
    safetyOk ? `This PC warm=${data.thisPc?.warmElapsedMs} ms, pane safety true.` : "Missing pane-safety, classification, or warm-cache evidence."
  );
  const attached = Number(data.devices?.count || 0) > 0 && Boolean(data.probe?.dryRunOpen || data.probe?.browse);
  if (strictMode) {
    requireCheck(
      checks,
      attached,
      "external-shell-device-attached",
      "Attached phone/MTP/camera proof",
      attached ? `${data.devices.count} device(s) with probe.` : data.attachmentGuide?.strictCommand || "Run shell-devices with --require-device."
    );
  } else {
    warnCheck(
      checks,
      attached,
      "external-shell-device-attached",
      "Attached phone/MTP/camera proof",
      attached ? `${data.devices.count} device(s) with probe.` : data.attachmentGuide?.strictCommand || "Run shell-devices with --require-device."
    );
  }
}

function evaluateProductionSigning(checks, data) {
  if (!data) return;
  if (data.summary?.fail > 0 || data.status === "fail") {
    addCheck(checks, "fail", "external-production-signing", "Production Authenticode proof", `${data.summary?.fail || 1} production-signing failure(s).`);
    return;
  }
  const targetsMatch = (data.checks || []).some((check) => check.id === "signing-targets-match-bundle" && check.status === "pass");
  requireCheck(
    checks,
    targetsMatch,
    "external-production-signing-targets",
    "Signing targets match release bundle",
    targetsMatch ? "Installer and desktop EXE hashes match release bundle." : "Signing targets do not match the current bundle."
  );
  const signedTargets = (data.signatures || []).filter((signature) => signature.signerThumbprint && signature.status !== "NotSigned");
  const productionOk = data.status === "pass" && data.expected?.configured === true && signedTargets.length >= 2;
  if (strictMode) {
    requireCheck(
      checks,
      productionOk,
      "external-production-signing",
      "Production Authenticode proof",
      productionOk ? `${signedTargets.length} signed target(s).` : "Configure expected production certificate and sign installer/EXE."
    );
  } else {
    warnCheck(
      checks,
      productionOk,
      "external-production-signing",
      "Production Authenticode proof",
      productionOk ? `${signedTargets.length} signed target(s).` : "Configure expected production certificate and sign installer/EXE."
    );
  }
}

function evaluateHostedFeed(checks, data) {
  if (!data) return;
  if (data.summary?.fail > 0 || data.status === "fail") {
    addCheck(checks, "fail", "external-hosted-feed", "Hosted update feed proof", `${data.summary?.fail || 1} hosted-feed failure(s).`);
    return;
  }
  const hostedOk = data.status === "pass" && (data.assets || []).some((asset) => asset.id === "setup-installer");
  if (strictMode) {
    requireCheck(
      checks,
      hostedOk,
      "external-hosted-feed",
      "Hosted update feed proof",
      hostedOk ? `${data.feed?.latestUrl || "latest.yml"} matched local bundle.` : "Configure EXPLORE_BETTER_UPDATE_URL or EB_UPDATE_URL to a production-hosted feed."
    );
  } else {
    warnCheck(
      checks,
      hostedOk,
      "external-hosted-feed",
      "Hosted update feed proof",
      hostedOk ? `${data.feed?.latestUrl || "latest.yml"} matched local bundle.` : "Configure EXPLORE_BETTER_UPDATE_URL or EB_UPDATE_URL to a production-hosted feed."
    );
  }
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
    "# Explore Better External Proof",
    "",
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.strict ? "strict" : "advisory"}`,
    "",
    `Status: ${report.status}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  lines.push("", "## Certification Steps", "");
  for (const step of report.guide.steps) {
    lines.push(`- ${step.label}: \`${step.command}\` - ${step.detail}`);
  }
  const warnings = report.checks.filter((check) => check.status === "warn");
  if (warnings.length) {
    lines.push("", "## Warnings", "");
    for (const warning of warnings) lines.push(`- ${warning.label}: ${warning.detail}`);
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
  const pkg = await readJson(path.join(workspace, "package.json"));
  const requiredScripts = [
    "verify:code-signing",
    "verify:release-update-feed",
    "verify:release-update-feed-desktop",
    "verify:release-readiness",
    "verify:release-integrity",
    "verify:release-bundle",
    "verify:shell-devices",
    "verify:production-signing",
    "verify:hosted-update-feed"
  ];
  for (const scriptName of requiredScripts) {
    requireCheck(
      checks,
      Boolean(pkg.scripts?.[scriptName]),
      `script-${scriptName}`,
      `Package script ${scriptName}`,
      pkg.scripts?.[scriptName] || "missing"
    );
  }

  const refresh = skipRefresh ? [] : await refreshExternalProofs(checks);
  const readiness = await loadArtifact(checks, "release-readiness-latest.json", "Release readiness");
  const integrity = await loadArtifact(checks, "release-integrity-latest.json", "Release integrity");
  const updateFeed = await loadArtifact(checks, "release-update-feed-latest.json", "Static update feed");
  const desktopUpdateFeed = await loadArtifact(checks, "release-update-feed-desktop-latest.json", "Desktop update feed");
  const codeSigning = await loadArtifact(checks, "code-signing-rehearsal-latest.json", "Code-signing rehearsal");
  const bundle = await loadArtifact(checks, "release-bundle-latest.json", "Release bundle");
  const shell = await loadArtifact(checks, "shell-devices-latest.json", "Shell devices");
  const signing = await loadArtifact(checks, "production-signing-latest.json", "Production signing");
  const hosted = await loadArtifact(checks, "hosted-update-feed-latest.json", "Hosted update feed");

  evaluateReleasePrerequisites(checks, {
    readiness: readiness.data,
    integrity: integrity.data,
    updateFeed: updateFeed.data,
    desktopUpdateFeed: desktopUpdateFeed.data,
    codeSigning: codeSigning.data,
    bundle: bundle.data
  });
  evaluateShellDevice(checks, shell.data);
  evaluateProductionSigning(checks, signing.data);
  evaluateHostedFeed(checks, hosted.data);

  const summary = statusCounts(checks);
  const status = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    strict: strictMode,
    refreshed: !skipRefresh,
    status,
    summary,
    checks,
    refresh,
    artifacts: {
      releasePrerequisites: {
        releaseReadiness: {
          path: readiness.filePath,
          generatedAt: readiness.data?.generatedAt || null,
          status: readiness.data?.status || null,
          summary: readiness.data?.summary || null
        },
        releaseIntegrity: {
          path: integrity.filePath,
          generatedAt: integrity.data?.generatedAt || null,
          status: integrity.data?.status || null,
          summary: integrity.data?.summary || null
        },
        releaseUpdateFeed: {
          path: updateFeed.filePath,
          generatedAt: updateFeed.data?.generatedAt || null,
          status: updateFeed.data?.status || null,
          summary: updateFeed.data?.summary || null
        },
        releaseUpdateFeedDesktop: {
          path: desktopUpdateFeed.filePath,
          generatedAt: desktopUpdateFeed.data?.generatedAt || null,
          status: desktopUpdateFeed.data?.status || null,
          updateCheck: desktopUpdateFeed.data?.updateCheck || null
        },
        codeSigningRehearsal: {
          path: codeSigning.filePath,
          generatedAt: codeSigning.data?.generatedAt || null,
          status: codeSigning.data?.status || null,
          summary: codeSigning.data?.summary || null
        },
        releaseBundle: {
          path: bundle.filePath,
          generatedAt: bundle.data?.generatedAt || null,
          status: bundle.data?.status || null,
          summary: bundle.data?.summary || null,
          manifestPath: bundle.data?.manifestPath || null
        }
      },
      shellDevices: {
        path: shell.filePath,
        generatedAt: shell.data?.generatedAt || null,
        status: shell.data?.status || null,
        summary: shell.data?.summary || null,
        devices: shell.data?.devices || null,
        attachmentGuide: shell.data?.attachmentGuide || null
      },
      productionSigning: {
        path: signing.filePath,
        generatedAt: signing.data?.generatedAt || null,
        status: signing.data?.status || null,
        summary: signing.data?.summary || null,
        expected: signing.data?.expected || null,
        signatures: signing.data?.signatures || []
      },
      hostedUpdateFeed: {
        path: hosted.filePath,
        generatedAt: hosted.data?.generatedAt || null,
        status: hosted.data?.status || null,
        summary: hosted.data?.summary || null,
        feed: hosted.data?.feed || null
      }
    },
    guide: guide()
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`external proof: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
      id: "external-proof-error",
      label: "External proof verifier crashed",
      detail: error.stack || error.message
    }
  ];
  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    strict: strictMode,
    refreshed: !skipRefresh,
    status: "fail",
    summary,
    checks,
    refresh: [],
    artifacts: {},
    guide: guide()
  };
  await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
