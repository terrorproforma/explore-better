import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "native-shell-readiness-latest.json");
const latestMdPath = path.join(artifactsDir, "native-shell-readiness-latest.md");
const strictMode = process.argv.includes("--strict") || process.env.EB_NATIVE_SHELL_READINESS_STRICT === "1";

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

function summaryHasNoFailures(report) {
  return report?.status !== "fail" && Number(report?.summary?.fail || 0) === 0;
}

function checkById(report, id) {
  return (Array.isArray(report?.checks) ? report.checks : []).find((check) => check.id === id);
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

function addGate(checks, checklist, status, id, label, detail, command, data = {}) {
  const item = { status, id, label, detail, command, ...data };
  checklist.push(item);
  addCheck(checks, status, id, label, detail, { command, gate: true, evidence: data });
  return item;
}

function addLocalGate(checks, checklist, id, label, ok, detail, command, data = {}) {
  return addGate(checks, checklist, ok ? "pass" : "fail", id, label, detail, command, { external: false, ...data });
}

function addExternalGate(checks, checklist, id, label, ok, detail, command, data = {}) {
  return addGate(checks, checklist, ok ? "pass" : warningStatus(), id, label, detail, command, { external: true, ...data });
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
      "npm run verify:shell",
      "npm run verify:shell-namespace",
      "npm run verify:shell-devices",
      "npm run verify:shell-verbs",
      "npm run verify:windows-recycle",
      "npm run verify:zip-browse",
      "npm run verify:filesystem-objects",
      "npm run verify:real-paths",
      "npm run verify:network-loopback",
      "npm run verify:native-shell-readiness"
    ],
    hardware: [
      "Attach an unlocked phone, camera, or MTP/PTP device to Windows.",
      "Allow file-transfer access on the device if prompted.",
      "Confirm it appears under This PC in Explorer.",
      "npm run verify:shell-devices -- --require-device",
      "npm run verify:native-shell-readiness -- --strict"
    ]
  };
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Native Shell Readiness",
    "",
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.strict ? "strict" : "advisory"}`,
    "",
    `Status: ${report.status}`,
    "",
    `Local shell ready: ${report.localReady ? "yes" : "no"}`,
    `Hardware proof ready: ${report.hardwareReady ? "yes" : "no"}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
    "",
    "| Status | Check | Detail | Command |",
    "| --- | --- | --- | --- |"
  ];
  for (const item of report.readinessChecklist) {
    lines.push(`| ${item.status.toUpperCase()} | ${tableValue(item.label)} | ${tableValue(item.detail)} | \`${tableValue(item.command)}\` |`);
  }
  if (report.hardwareBlockers.length) {
    lines.push("", "## Hardware Blockers", "");
    for (const blocker of report.hardwareBlockers) {
      lines.push(`- ${blocker.label}: ${blocker.detail}`);
    }
  }
  lines.push("", "## Local Commands", "");
  for (const command of report.commands.local) lines.push(`- \`${command}\``);
  lines.push("", "## Hardware Commands", "");
  for (const command of report.commands.hardware) lines.push(`- ${command.startsWith("npm ") ? `\`${command}\`` : command}`);
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
    "verify:shell",
    "verify:shell-namespace",
    "verify:shell-devices",
    "verify:shell-verbs",
    "verify:windows-recycle",
    "verify:zip-browse",
    "verify:filesystem-objects",
    "verify:real-paths",
    "verify:network-loopback",
    "verify:native-shell-readiness"
  ];
  for (const scriptName of scripts) {
    requireCheck(checks, Boolean(pkg.scripts?.[scriptName]), `script-${scriptName}`, `Package script ${scriptName}`, pkg.scripts?.[scriptName] || "missing");
  }

  const reports = {
    shell: await loadReport(checks, "shell", "shell-locations-latest.json", "Shell locations"),
    namespace: await loadReport(checks, "shell-namespace", "shell-namespace-latest.json", "Shell namespace"),
    devices: await loadReport(checks, "shell-devices", "shell-devices-latest.json", "Shell devices"),
    verbs: await loadReport(checks, "shell-verbs", "shell-verbs-latest.json", "Shell verbs"),
    recycle: await loadReport(checks, "windows-recycle", "windows-recycle-latest.json", "Windows Recycle Bin"),
    zip: await loadReport(checks, "zip-browse", "zip-browse-latest.json", "ZIP browsing"),
    filesystemObjects: await loadReport(checks, "filesystem-objects", "filesystem-objects-latest.json", "Filesystem objects"),
    realPaths: await loadReport(checks, "real-paths", "real-paths-latest.json", "Real paths"),
    networkLoopback: await loadReport(checks, "network-loopback", "network-loopback-latest.json", "Network loopback")
  };

  const shellData = reports.shell.data || {};
  const requiredVirtual = ["thisPc", "libraries", "network", "recycleBin"];
  const requiredSpecial = ["home", "documents", "downloads", "music", "videos", "public", "appData", "appTrash"];
  const virtual = new Set(shellData.virtualFolders || []);
  const special = new Set(shellData.specialFolders || []);
  const missingVirtual = requiredVirtual.filter((id) => !virtual.has(id));
  const missingSpecial = requiredSpecial.filter((id) => !special.has(id));
  addLocalGate(
    checks,
    readinessChecklist,
    "local-shell-locations",
    "Navigator shell locations cover Windows virtual and special folders",
    missingVirtual.length === 0 && missingSpecial.length === 0,
    missingVirtual.length || missingSpecial.length
      ? `Missing virtual=${missingVirtual.join(", ") || "none"}; special=${missingSpecial.join(", ") || "none"}.`
      : `${requiredVirtual.length} virtual folder(s), ${requiredSpecial.length} special folder(s).`,
    "npm run verify:shell",
    { virtualFolders: shellData.virtualFolders || [], specialFolders: shellData.specialFolders || [] }
  );

  const namespace = reports.namespace.data?.namespaces || {};
  addLocalGate(
    checks,
    readinessChecklist,
    "local-shell-namespace",
    "Shell namespace enumeration is bounded and cached",
    namespace.thisPc?.available === true && namespace.network?.warmCached === true && namespace.libraries?.available === true,
    `This PC=${namespace.thisPc?.count ?? "missing"}, Network warm=${namespace.network?.warmCached === true}, Libraries=${namespace.libraries?.count ?? "missing"}.`,
    "npm run verify:shell-namespace",
    {
      thisPcElapsedMs: namespace.thisPc?.elapsedMs ?? null,
      networkWarmElapsedMs: namespace.network?.warmElapsedMs ?? null,
      librariesWarmElapsedMs: namespace.libraries?.warmElapsedMs ?? null
    }
  );

  const devices = reports.devices.data || {};
  const hardwareSnapshot = devices.hardwareSnapshot || {};
  const hardwareSnapshotOk =
    devices.platform !== "win32" || (hardwareSnapshot.available === true && Number(hardwareSnapshot.elapsedMs || Infinity) < 6500);
  const simulatedProbe = devices.simulatedProbe || {};
  const simulatedBrowseOk =
    simulatedProbe.browse?.count >= 1 && simulatedProbe.browse?.shellSafe === true && Number(simulatedProbe.browse?.elapsedMs || 0) < 6500;
  const simulatedDryRunOk = simulatedProbe.dryRunOpen?.ok === true && simulatedProbe.dryRunOpen?.dryRun === true;
  const deviceSafetyOk =
    summaryHasNoFailures(devices) &&
    devices.invariants?.nonFilesystemNeverPaneOpen === true &&
    devices.invariants?.portableDevicesMarkedShellDevices === true &&
    devices.invariants?.filesystemTargetsRemainPaneOpenable === true &&
    devices.thisPc?.warmCached === true &&
    devices.simulatedDevices?.count >= 1 &&
    simulatedDryRunOk &&
    simulatedBrowseOk &&
    hardwareSnapshotOk;
  addLocalGate(
    checks,
    readinessChecklist,
    "local-hardware-discovery-snapshot",
    "Windows portable-device hardware snapshot is captured without elevation",
    hardwareSnapshotOk,
    hardwareSnapshotOk
      ? `${hardwareSnapshot.count || 0} portable/camera candidate(s), ${hardwareSnapshot.elapsedMs ?? "n/a"} ms.`
      : hardwareSnapshot.error || "Hardware snapshot unavailable.",
    "npm run verify:shell-devices",
    {
      available: hardwareSnapshot.available === true,
      count: hardwareSnapshot.count || 0,
      elapsedMs: hardwareSnapshot.elapsedMs ?? null,
      source: hardwareSnapshot.source || null
    }
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-portable-device-safety",
    "Portable shell-device pane safety is deterministic",
    deviceSafetyOk,
    deviceSafetyOk
      ? `${devices.simulatedDevices?.count || 0} simulated portable device(s), hardware snapshot, dry-run, and bounded browse passed.`
      : "Shell device artifact must prove non-filesystem pane blocking, portable classification, warm cache, hardware snapshot, simulated dry-run, and shell-safe browse.",
    "npm run verify:shell-devices",
    {
      simulatedDevices: devices.simulatedDevices?.count || 0,
      physicalDevices: devices.devices?.count || 0,
      thisPcWarmCached: devices.thisPc?.warmCached === true
    }
  );

  addLocalGate(
    checks,
    readinessChecklist,
    "local-shell-verbs",
    "Native Windows shell verbs enumerate safely",
    reports.verbs.data?.verbs?.available === true && Number(reports.verbs.data?.verbs?.count || 0) > 0,
    `${reports.verbs.data?.verbs?.count || 0} verb(s).`,
    "npm run verify:shell-verbs"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-recycle-bin",
    "Windows Recycle Bin list, dry-run, and restore path passes",
    reports.recycle.data?.operation?.status === "completed" && Number(reports.recycle.data?.dryRun?.matched || 0) >= 1,
    `matched=${reports.recycle.data?.dryRun?.matched || 0}, operation=${reports.recycle.data?.operation?.status || "missing"}.`,
    "npm run verify:windows-recycle"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-zip-browse",
    "ZIP virtual pane browsing reaches nested archive folders",
    reports.zip.data?.root?.count >= 1 && reports.zip.data?.nested?.count >= 1 && reports.zip.data?.deep?.count >= 1,
    `root/nested/deep=${reports.zip.data?.root?.count || 0}/${reports.zip.data?.nested?.count || 0}/${reports.zip.data?.deep?.count || 0}.`,
    "npm run verify:zip-browse"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-filesystem-objects",
    "Shortcuts, hard links, junctions, and symlink-denial handling are indexed and undone",
    reports.filesystemObjects.data?.index?.returned >= 1 &&
      reports.filesystemObjects.data?.background?.returned >= 1 &&
      reports.filesystemObjects.data?.undo?.removedCreatedObjects === true &&
      reports.filesystemObjects.data?.undo?.sourcesIntact === true,
    `index=${reports.filesystemObjects.data?.index?.returned || 0}, background=${reports.filesystemObjects.data?.background?.returned || 0}, symlink=${reports.filesystemObjects.data?.symlink?.status || "missing"}.`,
    "npm run verify:filesystem-objects"
  );
  const realPathPasses = Array.isArray(reports.realPaths.data?.results)
    ? reports.realPaths.data.results.filter((result) => result.status === "pass").length
    : 0;
  addLocalGate(
    checks,
    readinessChecklist,
    "local-real-paths",
    "Real workspace, OneDrive, known-folder, drive, and explicit path diagnostics pass",
    reports.realPaths.data?.status === "pass" && realPathPasses > 0,
    `${realPathPasses}/${reports.realPaths.data?.total || reports.realPaths.data?.results?.length || 0} real path target(s) passed.`,
    "npm run verify:real-paths"
  );
  addLocalGate(
    checks,
    readinessChecklist,
    "local-network-loopback",
    "UNC network loopback listing and indexing pass",
    reports.networkLoopback.data?.status === "pass" &&
      reports.networkLoopback.data?.checks?.diagnostics?.result?.kind === "unc" &&
      reports.networkLoopback.data?.checks?.indexSearch?.result?.indexed === true,
    reports.networkLoopback.data?.status === "pass"
      ? `mode=${reports.networkLoopback.data?.mode || "unknown"}, returned=${reports.networkLoopback.data?.checks?.warm?.result?.returned || 0}.`
      : reports.networkLoopback.data?.detail || "No loopback UNC evidence.",
    "npm run verify:network-loopback"
  );

  const physicalDevices = Number(devices.devices?.count || 0);
  const hardwareReady = physicalDevices > 0 && Boolean(devices.probe?.dryRunOpen || devices.probe?.browse);
  addExternalGate(
    checks,
    readinessChecklist,
    "hardware-attached-portable-device",
    "Attached phone/MTP/camera device is observed and probed",
    hardwareReady,
    hardwareReady
      ? `${physicalDevices} physical shell device candidate(s) with probe evidence.`
      : "Attach an unlocked phone/camera/MTP device, allow file transfer, and rerun strict shell-device proof.",
    "npm run verify:shell-devices -- --require-device",
    {
      physicalDevices,
      attachmentGuide: devices.attachmentGuide || null
    }
  );

  const localReady = readinessChecklist.filter((item) => !item.external).every((item) => item.status === "pass");
  const hardwareBlockers = readinessChecklist.filter((item) => item.external && item.status !== "pass");
  const summary = statusCounts(checks);
  const status = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    strict: strictMode,
    status,
    summary,
    localReady,
    hardwareReady,
    checks,
    readinessChecklist,
    hardwareBlockers,
    commands: expectedCommands(),
    artifacts: Object.fromEntries(Object.entries(reports).map(([id, loaded]) => [id, artifactSnapshot(loaded)]))
  };

  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`native shell readiness: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`local shell ready: ${localReady ? "yes" : "no"}; hardware proof ready: ${hardwareReady ? "yes" : "no"}`);
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
      id: "native-shell-readiness-error",
      label: "Native shell readiness verifier crashed",
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
    hardwareReady: false,
    checks,
    readinessChecklist: [],
    hardwareBlockers: [],
    commands: expectedCommands(),
    artifacts: {}
  };
  await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
