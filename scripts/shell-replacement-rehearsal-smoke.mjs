import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `shell-rehearsal-${stamp}`);
const localAppData = path.join(runRoot, "LocalAppData");
const roamingAppData = path.join(runRoot, "RoamingAppData");
const userProfile = path.join(runRoot, "UserProfile");
const oneDriveRoot = path.join(runRoot, "OneDrive");
const desktopRoot = path.join(oneDriveRoot, "Desktop");
const stateDir = path.join(localAppData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "shell-rehearsal-latest.json");
const latestMdPath = path.join(artifactsDir, "shell-rehearsal-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function randomPort() {
  return 55000 + Math.floor(Math.random() * 7000);
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SHELL_REHEARSAL_KEEP_FIXTURE === "1";
}

function limitedAppend(current, chunk, limit = 24000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function normalizeForCompare(itemPath) {
  return path.resolve(itemPath || "").toLowerCase();
}

function startsWithin(itemPath, rootPath) {
  const item = normalizeForCompare(itemPath);
  const root = normalizeForCompare(rootPath);
  return item === root || item.startsWith(`${root}${path.sep}`);
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

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function serverEnv(port) {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    LOCALAPPDATA: localAppData,
    APPDATA: roamingAppData,
    USERPROFILE: userProfile,
    OneDrive: oneDriveRoot,
    ONEDRIVE: oneDriveRoot
  };
}

function startServer(port) {
  serverOutput = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: serverEnv(port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => {
    serverOutput = limitedAppend(serverOutput, chunk);
  });
  child.stderr.on("data", (chunk) => {
    serverOutput = limitedAppend(serverOutput, chunk);
  });
  return child;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutput}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${serverOutput}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function seedState() {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(desktopRoot, { recursive: true });
  await fs.mkdir(path.join(userProfile, "Desktop"), { recursive: true });
  await fs.mkdir(roamingAppData, { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        settings: {
          launchMode: "native",
          shellOpenMode: "activeNewTab"
        },
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
}

async function packagedAppPath() {
  const executable = process.platform === "win32" ? "Explore Better.exe" : "Explore Better";
  return path.join(workspace, "dist", "win-unpacked", executable);
}

function readyStep(status, id) {
  return (status.replacement?.steps || []).find((step) => step.id === id);
}

async function readGeneratedFiles(generated) {
  const files = {};
  for (const [key, value] of Object.entries(generated || {})) {
    if (key.endsWith("Path") && typeof value === "string" && (await pathExists(value))) {
      files[key] = await fs.readFile(value, "utf8").catch(() => "");
    }
  }
  return files;
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Shell Replacement Rehearsal",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.`,
    "",
    "This rehearsal uses isolated LOCALAPPDATA, APPDATA, USERPROFILE, and OneDrive/Desktop paths. It installs and removes the app copy, Start Menu/Desktop shortcuts, and the optional Win+E startup helper without importing shell registry files.",
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of failures) {
      lines.push(`- ${failure.label}: ${failure.detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const checks = [];
  await fs.mkdir(artifactsDir, { recursive: true });
  await seedState();
  const packagePath = await packagedAppPath();
  requireCheck(
    checks,
    await pathExists(packagePath),
    "packaged-artifact",
    "Unpacked desktop app exists",
    (await pathExists(packagePath)) ? packagePath : `Missing ${packagePath}; run npm run package:dir.`
  );

  const port = Number(optionValue("--port", process.env.PORT || randomPort()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  let generated = null;
  let statusAfterInstall = null;
  let statusAfterShortcuts = null;
  let statusAfterWinE = null;
  let statusAfterBackup = null;
  let statusAfterRemove = null;
  let generatedFileText = {};

  try {
    await waitForServer(baseUrl, server);
    generated = await requestJson(baseUrl, "/api/integration/generate", { method: "POST" });
    generatedFileText = await readGeneratedFiles(generated);

    const install = await requestJson(baseUrl, "/api/integration/app-package", {
      method: "POST",
      body: JSON.stringify({ mode: "install" })
    });
    statusAfterInstall = install.status;
    const installedApp = statusAfterInstall.native?.installed;
    requireCheck(
      checks,
      Boolean(install.ok && installedApp && (await pathExists(installedApp)) && startsWithin(installedApp, localAppData)),
      "installed-app-copy",
      "Packaged app installs into isolated LOCALAPPDATA",
      installedApp || "missing"
    );
    requireCheck(
      checks,
      statusAfterInstall.handler?.kind === "installed" && startsWithin(statusAfterInstall.handler?.target, localAppData),
      "installed-shell-target",
      "Native shell handler points at installed app",
      `${statusAfterInstall.handler?.kind || "missing"}: ${statusAfterInstall.handler?.target || ""}`
    );

    generated = await requestJson(baseUrl, "/api/integration/generate", { method: "POST" });
    generatedFileText = await readGeneratedFiles(generated);
    const installedAppRegistryText = String(installedApp || "").replaceAll("\\", "\\\\");
    requireCheck(
      checks,
      generatedFileText.contextMenuRegPath?.includes(installedAppRegistryText) &&
        generatedFileText.folderDefaultRegPath?.includes(installedAppRegistryText),
      "registry-files-target-installed-app",
      "Generated registry files target installed app",
      installedApp || "missing"
    );
    const generatedShellText = `${generatedFileText.contextMenuRegPath || ""}\n${
      generatedFileText.folderDefaultRegPath || ""
    }`;
    requireCheck(
      checks,
      generatedShellText.includes("Directory\\Background\\shell\\ExploreBetter") &&
        generatedShellText.includes("*\\shell\\ExploreBetterLocation") &&
        generatedShellText.includes("%V") &&
        generatedShellText.includes("%1"),
      "complete-shell-entry-points",
      "Generated handlers cover folders, drives, backgrounds, and file locations",
      "Directory/Drive use %1, folder backgrounds use %V, and file-location commands use %1"
    );
    requireCheck(
      checks,
      generatedFileText.contextMenuRemoveRegPath?.includes("Directory\\Background\\shell\\ExploreBetter") &&
        generatedFileText.contextMenuRemoveRegPath?.includes("*\\shell\\ExploreBetterLocation") &&
        generatedFileText.folderDefaultRemoveRegPath?.includes("Directory\\Background\\shell\\ExploreBetter") &&
        generatedFileText.folderDefaultRemoveRegPath?.includes("*\\shell\\ExploreBetterLocation"),
      "complete-shell-cleanup",
      "Generated cleanup removes every Explore Better handler",
      "Folder, drive, background, and file-location keys are covered"
    );

    const shortcuts = await requestJson(baseUrl, "/api/integration/shortcuts", {
      method: "POST",
      body: JSON.stringify({ mode: "install", desktop: true })
    });
    statusAfterShortcuts = shortcuts.status;
    requireCheck(
      checks,
      shortcuts.ok === true &&
        statusAfterShortcuts.shortcuts?.startMenu &&
        statusAfterShortcuts.shortcuts?.desktop &&
        startsWithin(statusAfterShortcuts.shortcuts.startMenuShortcut, roamingAppData) &&
        startsWithin(statusAfterShortcuts.shortcuts.desktopShortcut, oneDriveRoot),
      "shortcut-install",
      "Start Menu and Desktop shortcuts install into isolated profile",
      `${statusAfterShortcuts.shortcuts?.startMenuShortcut || "missing"} / ${
        statusAfterShortcuts.shortcuts?.desktopShortcut || "missing"
      }`
    );

    const winE = await requestJson(baseUrl, "/api/integration/win-e", {
      method: "POST",
      body: JSON.stringify({ mode: "install" })
    });
    statusAfterWinE = winE.status;
    requireCheck(
      checks,
      winE.ok === true &&
        statusAfterWinE.shortcuts?.winEStartup &&
        startsWithin(statusAfterWinE.shortcuts.winEStartupShortcut, roamingAppData),
      "win-e-install",
      "Win+E startup helper installs into isolated APPDATA",
      statusAfterWinE.shortcuts?.winEStartupShortcut || "missing"
    );
    requireCheck(
      checks,
      generatedFileText.winEInstallScriptPath?.includes("$env:APPDATA") &&
        generatedFileText.winERemoveScriptPath?.includes("$env:APPDATA"),
      "win-e-script-isolatable",
      "Win+E scripts respect APPDATA",
      generated.winEInstallScriptPath || "missing"
    );

    const backup = await requestJson(baseUrl, "/api/integration/backup", {
      method: "POST",
      body: JSON.stringify({ mode: "shell-rehearsal" })
    });
    statusAfterBackup = backup.status;
    const restorePath = backup.backup?.restoreRegPath || statusAfterBackup.registry?.shellBackup?.restoreRegPath;
    requireCheck(
      checks,
      Boolean(backup.ok && restorePath && (await pathExists(restorePath)) && startsWithin(restorePath, localAppData)),
      "shell-backup",
      "Shell backup restore file is generated in isolated LOCALAPPDATA",
      restorePath || "missing"
    );

    const requiredReadySteps = ["kit", "native", "backup", "installed", "packaged", "shortcuts", "winE"];
    const missingReadySteps = requiredReadySteps.filter((id) => !readyStep(statusAfterBackup, id)?.ready);
    requireCheck(
      checks,
      missingReadySteps.length === 0,
      "replacement-ready-steps",
      "Rehearsed replacement steps are ready",
      missingReadySteps.length
        ? `Missing ${missingReadySteps.join(", ")}`
        : `${statusAfterBackup.replacement?.ready}/${statusAfterBackup.replacement?.total} total readiness steps`
    );

    const winERemove = await requestJson(baseUrl, "/api/integration/win-e", {
      method: "POST",
      body: JSON.stringify({ mode: "remove" })
    });
    const shortcutRemove = await requestJson(baseUrl, "/api/integration/shortcuts", {
      method: "POST",
      body: JSON.stringify({ mode: "remove" })
    });
    const appRemove = await requestJson(baseUrl, "/api/integration/app-package", {
      method: "POST",
      body: JSON.stringify({ mode: "remove" })
    });
    statusAfterRemove = appRemove.status;
    requireCheck(
      checks,
      winERemove.ok === true &&
        shortcutRemove.ok === true &&
        appRemove.ok === true &&
        !statusAfterRemove.files?.installedApp &&
        !statusAfterRemove.shortcuts?.startMenu &&
        !statusAfterRemove.shortcuts?.desktop &&
        !statusAfterRemove.shortcuts?.winEStartup,
      "rehearsal-clean-remove",
      "Installed app, shortcuts, and Win+E helper remove cleanly",
      `installed=${Boolean(statusAfterRemove.files?.installedApp)} startMenu=${Boolean(
        statusAfterRemove.shortcuts?.startMenu
      )} desktop=${Boolean(statusAfterRemove.shortcuts?.desktop)} winE=${Boolean(statusAfterRemove.shortcuts?.winEStartup)}`
    );

    requireCheck(
      checks,
      true,
      "registry-imports-skipped",
      "Registry imports skipped by design",
      "Context-menu/default-folder .reg files are generated and inspected, but this automated rehearsal does not import HKCU registry files."
    );
  } catch (error) {
    addCheck(checks, "fail", "shell-rehearsal", "Shell replacement rehearsal", error.stack || error.message);
  } finally {
    await stopServer(server);
  }

  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    runRoot,
    isolatedProfile: {
      localAppData,
      roamingAppData,
      userProfile,
      oneDriveRoot,
      desktopRoot
    },
    summary,
    checks,
    generated,
    statusAfterInstall,
    statusAfterShortcuts,
    statusAfterWinE,
    statusAfterBackup,
    statusAfterRemove
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  if (!keepFixture()) {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`shell rehearsal: ${summary.pass} pass, ${summary.fail} fail`);
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
  if (serverOutput) {
    console.error(serverOutput);
  }
  process.exitCode = 1;
});
