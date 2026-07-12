import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `state-lock-${stamp}`);
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const readyPath = path.join(runRoot, "state-lock-ready.txt");
const lockScriptPath = path.join(runRoot, "lock-state.ps1");
const latestJsonPath = path.join(artifactsDir, "state-lock-latest.json");
const latestMdPath = path.join(artifactsDir, "state-lock-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_STATE_LOCK_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
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

function startServer(port) {
  serverOutput = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  return child;
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

async function waitForPath(itemPath, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await pathExists(itemPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function stateTempFiles() {
  try {
    const names = await fs.readdir(stateDir);
    return names.filter((name) => /^state\.json\..+\.tmp$/i.test(name)).map((name) => path.join(stateDir, name));
  } catch {
    return [];
  }
}

async function writeLockScript() {
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(
    lockScriptPath,
    `param(
  [string]$Path,
  [string]$Ready,
  [int]$Milliseconds
)

$ErrorActionPreference = "Stop"
$ReadyDir = Split-Path -Parent $Ready
New-Item -ItemType Directory -Force -Path $ReadyDir | Out-Null
$stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
  Set-Content -LiteralPath $Ready -Value ([DateTime]::UtcNow.ToString("o"))
  Start-Sleep -Milliseconds $Milliseconds
} finally {
  $stream.Dispose()
}
`,
    "utf8"
  );
}

function startStateLock(lockMs) {
  return spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      lockScriptPath,
      "-Path",
      statePath,
      "-Ready",
      readyPath,
      "-Milliseconds",
      String(lockMs)
    ],
    {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
}

async function waitForExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return child?.exitCode ?? 0;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await writeLockScript();
  const port = Number(optionValue("--port", process.env.PORT || 57000 + Math.floor(Math.random() * 5000)));
  const lockMs = Number(optionValue("--lock-ms", process.env.EB_STATE_LOCK_MS || "800"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  let lockProcess = null;
  let lockStdout = "";
  let lockStderr = "";
  try {
    await waitForServer(baseUrl, server);
    const initial = await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({ settings: { density: "compact", startupMode: "last" } })
    });
    assert(initial.settings?.density === "compact", "Initial state write should create compact settings.");
    assert(await pathExists(statePath), "State file should exist before lock test.");
    JSON.parse(await fs.readFile(statePath, "utf8"));

    await fs.rm(readyPath, { force: true }).catch(() => {});
    lockProcess = startStateLock(lockMs);
    lockProcess.stdout.on("data", (chunk) => {
      lockStdout += chunk.toString();
    });
    lockProcess.stderr.on("data", (chunk) => {
      lockStderr += chunk.toString();
    });
    assert(await waitForPath(readyPath, 5000), `Timed out waiting for state lock. ${lockStderr}`);

    const started = performance.now();
    const saved = await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({
        settings: {
          density: "spacious",
          startupMode: "homeDownloads",
          showHidden: false
        },
        aliases: [{ name: "locktest", path: fixtureSafePath() }]
      })
    });
    const wallMs = Math.round((performance.now() - started) * 10) / 10;
    const lockExit = await waitForExit(lockProcess, 5000);
    assert(lockExit === 0, `State lock process should exit cleanly. stdout=${lockStdout} stderr=${lockStderr}`);
    assert(wallMs >= Math.min(300, Math.max(100, lockMs / 4)), `State write should be delayed by the lock, got ${wallMs} ms.`);
    assert(saved.settings?.density === "spacious", "Locked state write should eventually save spacious density.");
    assert(saved.settings?.startupMode === "homeDownloads", "Locked state write should save startup mode.");
    assert(saved.aliases?.some((alias) => alias.name === "locktest"), "Locked state write should save alias changes.");

    const apiState = await requestJson(baseUrl, "/api/state");
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert(apiState.settings?.density === "spacious", "API state should reflect the locked write.");
    assert(persisted.settings?.density === "spacious", "Persisted state should reflect the locked write.");
    assert(JSON.stringify(apiState.settings) === JSON.stringify(persisted.settings), "Persisted settings should match API settings.");
    assert((await stateTempFiles()).length === 0, "No state temp files should remain after retrying locked write.");

    const report = {
      generatedAt: new Date().toISOString(),
      statePath,
      appData,
      lockMs,
      writeWallMs: wallMs,
      lockExit,
      saved: {
        density: saved.settings?.density,
        startupMode: saved.settings?.startupMode,
        aliasNames: (saved.aliases || []).map((alias) => alias.name)
      },
      serverWarnings: serverOutput
        .split(/\r?\n/)
        .filter((line) => /state backup|EPERM|EBUSY|EACCES|Could not/.test(line))
        .slice(-20)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(
      latestMdPath,
      `# Explore Better State Lock Resilience

Generated: ${report.generatedAt}

Summary: locked \`state.json\` for ${lockMs} ms, state write completed in ${wallMs} ms, and persisted JSON remained readable.

Verified:
- \`/api/state\` write survives an exclusive Windows file lock on the current state file.
- The saved API response and persisted \`state.json\` agree after retry.
- No atomic state temp files remain after the lock releases.

Artifacts:
- JSON: \`${latestJsonPath}\`
- State path: \`${statePath}\`
`,
      "utf8"
    );
    console.log(`state lock: ${lockMs} ms`);
    console.log(`state write wall: ${wallMs} ms`);
    console.log(`saved density: ${saved.settings?.density}`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
  } finally {
    if (lockProcess && lockProcess.exitCode === null) {
      lockProcess.kill();
      await waitForExit(lockProcess, 1500);
    }
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function fixtureSafePath() {
  return path.join(runRoot, "alias-target");
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
