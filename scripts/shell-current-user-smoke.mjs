import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `shell-current-user-${stamp}`);
const localAppData = path.join(runRoot, "LocalAppData");
const roamingAppData = path.join(runRoot, "RoamingAppData");
const userProfile = path.join(runRoot, "UserProfile");
const oneDriveRoot = path.join(runRoot, "OneDrive");
const stateDir = path.join(localAppData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "shell-current-user-latest.json");
const latestMdPath = path.join(artifactsDir, "shell-current-user-latest.md");
const registryKeys = [
  "HKCU\\Software\\Classes\\Directory\\shell",
  "HKCU\\Software\\Classes\\Drive\\shell",
  "HKCU\\Software\\Classes\\Directory\\shell\\ExploreBetter",
  "HKCU\\Software\\Classes\\Directory\\shell\\ExploreBetter\\command",
  "HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter",
  "HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter\\command",
  "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter",
  "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter\\command",
  "HKCU\\Software\\Classes\\*\\shell\\ExploreBetterLocation",
  "HKCU\\Software\\Classes\\*\\shell\\ExploreBetterLocation\\command"
];
let serverOutput = "";

// This smoke writes to the real HKCU shell keys, so it only runs when explicitly
// allowed. A reg export of every touched key is kept in a fixed location so a
// run that is force-killed before its finally block is repaired on the next run.
const allowRealHkcu = process.env.EB_ALLOW_REAL_HKCU === "1" || Boolean(process.env.CI);
const crashBackupDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "ExploreBetter",
  "test-backups",
  "shell-current-user-smoke"
);
const crashManifestPath = path.join(crashBackupDir, "manifest.json");
const crashBackupRoots = [
  { key: "HKCU\\Software\\Classes\\Directory\\shell", shellRoot: true },
  { key: "HKCU\\Software\\Classes\\Drive\\shell", shellRoot: true },
  { key: "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter", shellRoot: false },
  { key: "HKCU\\Software\\Classes\\*\\shell\\ExploreBetterLocation", shellRoot: false }
];
let crashBackupActive = false;
let activeServer = null;

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const selectedPort = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else if (!selectedPort) reject(new Error("Windows did not assign a loopback port."));
        else resolve(selectedPort);
      });
    });
  });
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SHELL_CURRENT_USER_KEEP_FIXTURE === "1";
}

function limitedAppend(current, chunk, limit = 32000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function normalizeForCompare(itemPath) {
  return path.resolve(itemPath || "").toLowerCase();
}

function startsWithin(itemPath, rootPath) {
  const item = normalizeForCompare(itemPath);
  const root = normalizeForCompare(rootPath);
  return item === root || item.startsWith(`${root}${path.sep}`);
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
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

function runCommand(command, args, { timeoutMs = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      child = spawn(command, args, {
        cwd: workspace,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: null, error: error.message, stdout, stderr });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, timedOut: true, stdout, stderr });
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
      resolve({ code: null, error: error.message, stdout, stderr });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
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

async function queryRegistryKey(key) {
  const result = await runCommand("reg.exe", ["query", key, "/s"], { timeoutMs: 20000 });
  if (result.code === 0) {
    return {
      key,
      exists: true,
      text: normalizeWhitespace(result.stdout),
      stderr: normalizeWhitespace(result.stderr)
    };
  }
  const missing = /unable to find|system was unable/i.test(`${result.stdout}\n${result.stderr}`);
  return {
    key,
    exists: false,
    text: "",
    stderr: normalizeWhitespace(result.stderr || result.stdout),
    missing
  };
}

async function registrySnapshot() {
  const entries = {};
  for (const key of registryKeys) {
    entries[key] = await queryRegistryKey(key);
  }
  return entries;
}

function registrySnapshotsMatch(before, after) {
  const mismatches = [];
  for (const key of registryKeys) {
    const left = before?.[key] || {};
    const right = after?.[key] || {};
    if (Boolean(left.exists) !== Boolean(right.exists) || String(left.text || "") !== String(right.text || "")) {
      mismatches.push(key);
    }
  }
  return mismatches;
}

function compareRegistryStatus(before, after) {
  const fields = [
    "contextMenuInstalled",
    "folderDefaultEnabled",
    "directoryCommand",
    "driveCommand",
    "directoryDefault",
    "driveDefault"
  ];
  return fields.filter((field) => String(before?.registry?.[field] ?? "") !== String(after?.registry?.[field] ?? ""));
}

async function importRegistryFile(filePath) {
  const result = await runCommand("reg.exe", ["import", filePath], { timeoutMs: 30000 });
  if (result.code !== 0) {
    throw new Error(`reg import failed for ${filePath}: ${result.stderr || result.stdout || result.error || result.code}`);
  }
  return result;
}

async function setRegistryDefault(key, value) {
  const result = await runCommand("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], {
    timeoutMs: 20000
  });
  if (result.code !== 0) {
    throw new Error(`reg add failed for ${key}: ${result.stderr || result.stdout || result.error || result.code}`);
  }
  return result;
}

async function seedLegacyExploreBetterCommands(launcherPath) {
  const legacyCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${launcherPath}" "%1"`;
  const commandKeys = [
    "HKCU\\Software\\Classes\\Directory\\shell\\ExploreBetter\\command",
    "HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter\\command",
    "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter\\command",
    "HKCU\\Software\\Classes\\*\\shell\\ExploreBetterLocation\\command"
  ];
  for (const key of commandKeys) {
    await setRegistryDefault(key, legacyCommand);
  }
  return legacyCommand;
}

function desktopSmokeEnv(port, userDataDir) {
  return {
    HOST: "127.0.0.1",
    PORT: String(port),
    EXPLORE_BETTER_APP_DATA_ROOT: stateDir,
    EXPLORE_BETTER_USER_DATA_DIR: userDataDir
  };
}

async function seedState() {
  await fs.mkdir(stateDir, { recursive: true });
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

async function deleteRegistryKeyIfAbsentBefore(key, before) {
  if (before?.[key]?.exists) return { skipped: true };
  const result = await runCommand("reg.exe", ["delete", key, "/f"], { timeoutMs: 20000 });
  if (result.code === 0 || /unable to find|system was unable/i.test(`${result.stdout}\n${result.stderr}`)) {
    return { skipped: false, code: result.code };
  }
  throw new Error(`reg delete failed for ${key}: ${result.stderr || result.stdout || result.error || result.code}`);
}

async function registryKeyExists(key) {
  return (await runCommand("reg.exe", ["query", key], { timeoutMs: 20000 })).code === 0;
}

// Exports every touched key (with subkeys) before the smoke changes anything.
async function writeCrashBackup() {
  await fs.mkdir(crashBackupDir, { recursive: true });
  const keys = [];
  for (const [index, root] of crashBackupRoots.entries()) {
    const file = path.join(crashBackupDir, `key-${index}.reg`);
    await fs.rm(file, { force: true });
    const existed = await registryKeyExists(root.key);
    if (existed) {
      const result = await runCommand("reg.exe", ["export", root.key, file, "/y"], { timeoutMs: 20000 });
      if (result.code !== 0) {
        throw new Error(`reg export failed for ${root.key}: ${result.stderr || result.stdout || result.error || result.code}`);
      }
    }
    keys.push({ ...root, existed, file: existed ? file : null });
  }
  await fs.writeFile(
    crashManifestPath,
    JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid, keys }, null, 2),
    "utf8"
  );
  crashBackupActive = true;
}

async function clearCrashBackup() {
  await fs.rm(crashBackupDir, { recursive: true, force: true });
  crashBackupActive = false;
}

// Puts the exported keys back: drops what the smoke may have added (Explore
// Better verbs, folder/drive defaults) and re-imports the original export.
async function restoreFromCrashBackup() {
  const manifest = JSON.parse(await fs.readFile(crashManifestPath, "utf8"));
  const quiet = (args) => runCommand("reg.exe", args, { timeoutMs: 20000 });
  for (const entry of manifest.keys || []) {
    if (entry.shellRoot) {
      await quiet(["delete", `${entry.key}\\ExploreBetter`, "/f"]);
      await quiet(["delete", entry.key, entry.existed ? "/ve" : null, "/f"].filter(Boolean));
    } else {
      await quiet(["delete", entry.key, "/f"]);
    }
    if (entry.existed) {
      await importRegistryFile(entry.file);
    }
  }
  await clearCrashBackup();
}

async function emergencyRestore(signal) {
  console.error(`current-user shell smoke: received ${signal}; restoring HKCU shell keys.`);
  try {
    activeServer?.kill();
  } catch {}
  try {
    if (crashBackupActive) {
      await restoreFromCrashBackup();
    }
  } catch (error) {
    console.error(`HKCU restore failed; the export remains in ${crashBackupDir}: ${error.stack || error.message}`);
  } finally {
    process.exit(130);
  }
}

function markdownReport(report) {
  const lines = [
    "# Explore Better Current-User Shell Smoke",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.`,
    "",
    "This verifier uses isolated app-data folders for generated files and the app copy, but imports the generated registry files into the real current-user HKCU shell keys, then restores the original registry snapshot before exiting.",
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
  if (!allowRealHkcu) {
    console.log(
      "current-user shell smoke: skipped. It modifies the real HKCU shell keys; set EB_ALLOW_REAL_HKCU=1 (or run in CI) to allow it."
    );
    return;
  }
  if (await pathExists(crashManifestPath)) {
    console.warn(`current-user shell smoke: a previous run did not finish; restoring HKCU from ${crashBackupDir}.`);
    crashBackupActive = true;
    await restoreFromCrashBackup();
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    process.on(signal, () => emergencyRestore(signal));
  }

  const checks = [];
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(localAppData, { recursive: true });
  await fs.mkdir(roamingAppData, { recursive: true });
  await fs.mkdir(userProfile, { recursive: true });
  await fs.mkdir(path.join(oneDriveRoot, "Desktop"), { recursive: true });
  await seedState();

  const port = Number(optionValue("--port", process.env.PORT || String(await availablePort())));
  const baseUrl = `http://127.0.0.1:${port}`;
  await writeCrashBackup();
  const server = startServer(port);
  activeServer = server;
  let beforeSnapshot = null;
  let afterApplySnapshot = null;
  let apiRestoreSnapshot = null;
  let afterRestoreSnapshot = null;
  let beforeStatus = null;
  let afterApplyStatus = null;
  let afterMigrationStatus = null;
  let afterRestoreStatus = null;
  let restoreCopyPath = null;
  let restored = false;
  let generated = null;
  let shellOpenSmoke = null;

  try {
    beforeSnapshot = await registrySnapshot();
    await waitForServer(baseUrl, server);
    generated = await requestJson(baseUrl, "/api/integration/generate", { method: "POST" });
    beforeStatus = await requestJson(baseUrl, "/api/integration/status");

    const backup = await requestJson(baseUrl, "/api/integration/backup", {
      method: "POST",
      body: JSON.stringify({ mode: "current-user-shell-smoke" })
    });
    restoreCopyPath = path.join(runRoot, "restore-original-shell.reg");
    await fs.copyFile(backup.backup.restoreRegPath, restoreCopyPath);
    requireCheck(
      checks,
      backup.ok === true && (await pathExists(restoreCopyPath)),
      "original-backup-copied",
      "Original HKCU shell backup copied before registry imports",
      restoreCopyPath
    );
    const legacyState = JSON.parse(await fs.readFile(statePath, "utf8"));
    const newHandlerEntryIds = new Set([
      "directoryBackgroundExploreBetter",
      "directoryBackgroundExploreBetterCommand",
      "fileLocationExploreBetter",
      "fileLocationExploreBetterCommand"
    ]);
    legacyState.integration.registryBackup = {
      ...legacyState.integration.registryBackup,
      version: 1,
      entries: legacyState.integration.registryBackup.entries.filter((entry) => !newHandlerEntryIds.has(entry.id))
    };
    await fs.writeFile(statePath, JSON.stringify(legacyState, null, 2), "utf8");
    let observedLegacyBackup = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const observedState = await requestJson(baseUrl, "/api/state");
      if (observedState.integration?.registryBackup?.version === 1) {
        observedLegacyBackup = true;
        break;
      }
    }
    requireCheck(
      checks,
      observedLegacyBackup,
      "legacy-backup-seeded",
      "Legacy shell backup fixture is observed before install",
      "Version 1 backup omits the new background and file-location handlers"
    );

    const install = await requestJson(baseUrl, "/api/integration/app-package", {
      method: "POST",
      body: JSON.stringify({ mode: "install" })
    });
    const installedApp = install.status?.native?.installed;
    requireCheck(
      checks,
      install.ok === true && installedApp && startsWithin(installedApp, localAppData) && (await pathExists(installedApp)),
      "isolated-app-copy",
      "Packaged app copy installed under isolated app data",
      installedApp || "missing"
    );

    generated = await requestJson(baseUrl, "/api/integration/generate", { method: "POST" });
    const contextApply = await requestJson(baseUrl, "/api/integration/apply", {
      method: "POST",
      body: JSON.stringify({ mode: "contextMenu" })
    });
    const defaultApply = await requestJson(baseUrl, "/api/integration/apply", {
      method: "POST",
      body: JSON.stringify({ mode: "folderDefault" })
    });
    const upgradedBackupIds = new Set((contextApply.backup?.entries || []).map((entry) => entry.id));
    requireCheck(
      checks,
      contextApply.backup?.version === 2 && [...newHandlerEntryIds].every((id) => upgradedBackupIds.has(id)),
      "legacy-backup-upgraded",
      "Legacy backup is upgraded before new handlers are installed",
      `${upgradedBackupIds.size} registry snapshot entries at version ${contextApply.backup?.version || "missing"}`
    );
    afterApplyStatus = defaultApply.status;
    afterApplySnapshot = await registrySnapshot();
    const commandTarget = [
      afterApplyStatus.registry?.directoryCommand,
      afterApplyStatus.registry?.driveCommand,
      afterApplyStatus.registry?.directoryBackgroundCommand,
      afterApplyStatus.registry?.fileLocationCommand
    ]
      .filter(Boolean)
      .join("\n");
    requireCheck(
      checks,
      contextApply.ok === true &&
        defaultApply.ok === true &&
        afterApplyStatus.registry?.contextMenuInstalled === true &&
        afterApplyStatus.registry?.folderDefaultEnabled === true &&
        commandTarget.includes(installedApp),
      "real-hkcu-installed",
      "Real HKCU context menu and default folder handler install",
      `context=${afterApplyStatus.registry?.contextMenuInstalled} default=${afterApplyStatus.registry?.folderDefaultEnabled}`
    );
    requireCheck(
      checks,
      afterApplyStatus.replacement?.steps?.some((step) => step.id === "context" && step.ready) &&
        afterApplyStatus.replacement?.steps?.some((step) => step.id === "default" && step.ready),
      "replacement-status-during-install",
      "Integration status sees real HKCU shell replacement enabled",
      `${afterApplyStatus.replacement?.ready || 0}/${afterApplyStatus.replacement?.total || 0} readiness steps`
    );

    const legacyCommand = await seedLegacyExploreBetterCommands(generated.scriptPath);
    const legacyDefaultStatus = await requestJson(baseUrl, "/api/integration/status");
    requireCheck(
      checks,
      legacyDefaultStatus.registry?.folderDefaultEnabled === true &&
        [
          legacyDefaultStatus.registry?.directoryCommand,
          legacyDefaultStatus.registry?.driveCommand,
          legacyDefaultStatus.registry?.directoryBackgroundCommand,
          legacyDefaultStatus.registry?.fileLocationCommand
        ].every((command) => /powershell\.exe/i.test(command || "")),
      "legacy-default-handler-seeded",
      "Legacy PowerShell handler is seeded while Explore Better remains the default",
      legacyCommand
    );

    const shellOpenTarget = path.join(runRoot, "ShellOpenTarget");
    await fs.mkdir(shellOpenTarget, { recursive: true });
    const shellOpenFile = path.join(shellOpenTarget, "opened-by-handler.txt");
    await fs.writeFile(shellOpenFile, "handler fixture", "utf8");
    shellOpenSmoke = await runCommand(installedApp, ["--smoke", "--smoke-window", "--shell-mode=activeNewTab", shellOpenTarget], {
      timeoutMs: 90000,
      env: desktopSmokeEnv(await availablePort(), path.join(runRoot, "ElectronUserData"))
    });
    requireCheck(
      checks,
      shellOpenSmoke.code === 0 &&
        /Explore Better shell-open smoke: matched=true/i.test(`${shellOpenSmoke.stdout}\n${shellOpenSmoke.stderr}`),
      "installed-handler-shell-open",
      "Installed shell handler opens target folder in desktop smoke",
      shellOpenSmoke.code === 0
        ? `Opened ${shellOpenTarget}`
        : shellOpenSmoke.timedOut
          ? "Installed app shell-open smoke timed out."
        : shellOpenSmoke.error || shellOpenSmoke.stderr || shellOpenSmoke.stdout || `exit ${shellOpenSmoke.code}`
    );

    afterMigrationStatus = await requestJson(baseUrl, "/api/integration/status");
    const migratedCommands = [
      afterMigrationStatus.registry?.directoryCommand,
      afterMigrationStatus.registry?.driveCommand,
      afterMigrationStatus.registry?.directoryBackgroundCommand,
      afterMigrationStatus.registry?.fileLocationCommand
    ];
    requireCheck(
      checks,
      afterMigrationStatus.registry?.folderDefaultEnabled === true &&
        migratedCommands.every((command) => command?.includes(installedApp) && !/powershell\.exe/i.test(command)),
      "legacy-default-handler-auto-repaired",
      "Packaged startup replaces legacy handlers and preserves the user's default choice",
      migratedCommands.join(" | ")
    );

    await setRegistryDefault("HKCU\\Software\\Classes\\Directory\\shell", "ForeignHandlerFixture");
    await setRegistryDefault("HKCU\\Software\\Classes\\Drive\\shell", "ForeignHandlerFixture");
    await seedLegacyExploreBetterCommands(generated.scriptPath);
    const contextOnlySmoke = await runCommand(installedApp, ["--smoke"], {
      timeoutMs: 90000,
      env: desktopSmokeEnv(await availablePort(), path.join(runRoot, "ElectronContextOnlyUserData"))
    });
    const contextOnlyStatus = await requestJson(baseUrl, "/api/integration/status");
    const contextOnlyCommands = [
      contextOnlyStatus.registry?.directoryCommand,
      contextOnlyStatus.registry?.driveCommand,
      contextOnlyStatus.registry?.directoryBackgroundCommand,
      contextOnlyStatus.registry?.fileLocationCommand
    ];
    requireCheck(
      checks,
      contextOnlySmoke.code === 0 &&
        contextOnlyStatus.registry?.directoryDefault === "ForeignHandlerFixture" &&
        contextOnlyStatus.registry?.driveDefault === "ForeignHandlerFixture" &&
        contextOnlyCommands.every((command) => command?.includes(installedApp) && !/powershell\.exe/i.test(command)),
      "context-handler-repair-preserves-foreign-default",
      "Startup repairs Explore Better-owned context handlers without taking over another default",
      `code=${contextOnlySmoke.code} timedOut=${Boolean(contextOnlySmoke.timedOut)} directory=${contextOnlyStatus.registry?.directoryDefault} drive=${contextOnlyStatus.registry?.driveDefault} commands=${contextOnlyCommands.join(" | ")} output=${`${contextOnlySmoke.stdout || ""}${contextOnlySmoke.stderr || ""}`.trim().slice(0, 800)}`
    );
    await requestJson(baseUrl, "/api/integration/apply", {
      method: "POST",
      body: JSON.stringify({ mode: "folderDefault" })
    });

    const fileLocationSmoke = await runCommand(
      installedApp,
      ["--smoke", "--smoke-window", "--shell-mode=activeNewTab", shellOpenFile],
      {
        timeoutMs: 90000,
        env: desktopSmokeEnv(await availablePort(), path.join(runRoot, "ElectronFileLocationUserData"))
      }
    );
    requireCheck(
      checks,
      fileLocationSmoke.code === 0 &&
        /Explore Better shell-open smoke: matched=true selected=true/i.test(
          `${fileLocationSmoke.stdout}\n${fileLocationSmoke.stderr}`
        ),
      "installed-file-location-reveal",
      "Installed file-location handler opens the parent folder and selects the file",
      fileLocationSmoke.code === 0
        ? `Selected ${shellOpenFile}`
        : fileLocationSmoke.timedOut
          ? "Installed app file-location smoke timed out."
          : fileLocationSmoke.error ||
            fileLocationSmoke.stderr ||
            fileLocationSmoke.stdout ||
            `exit ${fileLocationSmoke.code}`
    );

    const apiRestore = await requestJson(baseUrl, "/api/integration/apply", {
      method: "POST",
      body: JSON.stringify({ mode: "removeFolderDefault" })
    });
    const sameDefault = (field) =>
      String(apiRestore.status?.registry?.[field] || "") === String(beforeStatus?.registry?.[field] || "");
    requireCheck(
      checks,
      apiRestore.restoredBackup === true &&
        apiRestore.partial === true &&
        sameDefault("directoryDefault") &&
        sameDefault("driveDefault") &&
        apiRestore.status?.registry?.contextMenuInstalled === true,
      "api-restores-original-default",
      "Default removal restores only the original folder and drive defaults",
      `directory=${apiRestore.status?.registry?.directoryDefault} drive=${apiRestore.status?.registry?.driveDefault} context=${apiRestore.status?.registry?.contextMenuInstalled}`
    );
    const fullRestore = await requestJson(baseUrl, "/api/integration/restore", {
      method: "POST",
      body: JSON.stringify({ mode: "restore" })
    });
    apiRestoreSnapshot = await registrySnapshot();
    requireCheck(
      checks,
      fullRestore.ok === true && registrySnapshotsMatch(beforeSnapshot, apiRestoreSnapshot).length === 0,
      "api-restores-original-shell",
      "Full shell restore returns the exact original HKCU shell snapshot",
      fullRestore.ok === true ? "Before/restore snapshots match" : "Backup restore was not used"
    );
  } catch (error) {
    addCheck(checks, "fail", "current-user-shell-install", "Current-user shell install phase", error.stack || error.message);
  } finally {
    try {
      if (restoreCopyPath && (await pathExists(restoreCopyPath))) {
        await importRegistryFile(restoreCopyPath);
        await deleteRegistryKeyIfAbsentBefore("HKCU\\Software\\Classes\\Directory\\shell\\ExploreBetter", beforeSnapshot);
        await deleteRegistryKeyIfAbsentBefore("HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter", beforeSnapshot);
        await deleteRegistryKeyIfAbsentBefore(
          "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter",
          beforeSnapshot
        );
        await deleteRegistryKeyIfAbsentBefore("HKCU\\Software\\Classes\\*\\shell\\ExploreBetterLocation", beforeSnapshot);
        await deleteRegistryKeyIfAbsentBefore("HKCU\\Software\\Classes\\Directory\\shell", beforeSnapshot);
        await deleteRegistryKeyIfAbsentBefore("HKCU\\Software\\Classes\\Drive\\shell", beforeSnapshot);
        restored = true;
      }
    } catch (error) {
      addCheck(checks, "fail", "restore-original-registry", "Restore original HKCU shell registry", error.stack || error.message);
    }

    try {
      if (server.exitCode === null) {
        await requestJson(baseUrl, "/api/integration/app-package", {
          method: "POST",
          body: JSON.stringify({ mode: "remove" })
        }).catch(() => null);
        afterRestoreStatus = await requestJson(baseUrl, "/api/integration/status").catch(() => null);
      }
      afterRestoreSnapshot = await registrySnapshot();
    } catch (error) {
      addCheck(checks, "fail", "post-restore-status", "Read post-restore shell status", error.stack || error.message);
    }
    await stopServer(server);
    activeServer = null;

    // Safety net: if the app-level restore did not return HKCU to its original
    // state, fall back to the reg export taken before the run.
    try {
      if (crashBackupActive) {
        const leftover = !restored || !afterRestoreSnapshot || registrySnapshotsMatch(beforeSnapshot, afterRestoreSnapshot).length > 0;
        if (leftover) {
          await restoreFromCrashBackup();
        } else {
          await clearCrashBackup();
        }
      }
    } catch (error) {
      addCheck(checks, "fail", "crash-backup-restore", "Restore HKCU shell keys from the reg export backup", error.stack || error.message);
    }
  }

  const mismatchedKeys = registrySnapshotsMatch(beforeSnapshot, afterRestoreSnapshot);
  const mismatchedStatus = compareRegistryStatus(beforeStatus, afterRestoreStatus);
  requireCheck(
    checks,
    restored === true && mismatchedKeys.length === 0,
    "registry-restored",
    "HKCU shell registry snapshot restored after trial",
    mismatchedKeys.length ? `Mismatched keys: ${mismatchedKeys.join(", ")}` : "Before/after registry snapshots match"
  );
  requireCheck(
    checks,
    mismatchedStatus.length === 0,
    "status-restored",
    "Integration status matches pre-trial shell state",
    mismatchedStatus.length ? `Mismatched fields: ${mismatchedStatus.join(", ")}` : "Pre/post shell status fields match"
  );
  requireCheck(
    checks,
    afterRestoreStatus?.files?.installedApp !== true,
    "isolated-app-copy-removed",
    "Isolated installed app copy removed after trial",
    `installedApp=${Boolean(afterRestoreStatus?.files?.installedApp)}`
  );

  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    runRoot,
    isolatedProfile: {
      localAppData,
      roamingAppData,
      userProfile,
      oneDriveRoot
    },
    status: summary.fail > 0 ? "fail" : "pass",
    summary,
    checks,
    restoreCopyPath,
    generated,
    beforeStatus,
    afterApplyStatus,
    afterMigrationStatus,
    afterRestoreStatus,
    shellOpenSmoke,
    registry: {
      before: beforeSnapshot,
      afterApply: afterApplySnapshot,
      apiRestore: apiRestoreSnapshot,
      afterRestore: afterRestoreSnapshot,
      mismatchedKeys,
      mismatchedStatus
    }
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  if (!keepFixture()) {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`current-user shell smoke: ${summary.pass} pass, ${summary.fail} fail`);
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
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
