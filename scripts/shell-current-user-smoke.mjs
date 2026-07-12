import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
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
  "HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter\\command"
];
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function randomPort() {
  return 56000 + Math.floor(Math.random() * 6000);
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
  const checks = [];
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(localAppData, { recursive: true });
  await fs.mkdir(roamingAppData, { recursive: true });
  await fs.mkdir(userProfile, { recursive: true });
  await fs.mkdir(path.join(oneDriveRoot, "Desktop"), { recursive: true });
  await seedState();

  const port = Number(optionValue("--port", process.env.PORT || randomPort()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  let beforeSnapshot = null;
  let afterApplySnapshot = null;
  let afterRestoreSnapshot = null;
  let beforeStatus = null;
  let afterApplyStatus = null;
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
    afterApplyStatus = defaultApply.status;
    afterApplySnapshot = await registrySnapshot();
    const commandTarget = `${afterApplyStatus.registry?.directoryCommand || ""}\n${afterApplyStatus.registry?.driveCommand || ""}`;
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

    const shellOpenTarget = path.join(runRoot, "ShellOpenTarget");
    await fs.mkdir(shellOpenTarget, { recursive: true });
    await fs.writeFile(path.join(shellOpenTarget, "opened-by-handler.txt"), "handler fixture", "utf8");
    shellOpenSmoke = await runCommand(installedApp, ["--smoke", "--smoke-window", "--shell-mode=activeNewTab", shellOpenTarget], {
      timeoutMs: 90000,
      env: {
        HOST: "127.0.0.1",
        PORT: String(port)
      }
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
  } catch (error) {
    addCheck(checks, "fail", "current-user-shell-install", "Current-user shell install phase", error.stack || error.message);
  } finally {
    try {
      if (restoreCopyPath && (await pathExists(restoreCopyPath))) {
        await importRegistryFile(restoreCopyPath);
        await deleteRegistryKeyIfAbsentBefore("HKCU\\Software\\Classes\\Directory\\shell\\ExploreBetter", beforeSnapshot);
        await deleteRegistryKeyIfAbsentBefore("HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter", beforeSnapshot);
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
    afterRestoreStatus,
    shellOpenSmoke,
    registry: {
      before: beforeSnapshot,
      afterApply: afterApplySnapshot,
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
