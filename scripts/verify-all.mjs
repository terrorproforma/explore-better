import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

const root = process.cwd();
const artifacts = path.join(root, "artifacts");
const lockPath = path.join(artifacts, ".verify-all.lock");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const acceptanceDir = path.join(artifacts, "acceptance", stamp);
const full = process.argv.includes("--full");
const refreshStale = process.argv.includes("--refresh-stale");

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
}

const coreSuites = [
  ["action-inventory", "scripts/action-inventory.mjs", 30000],
  ["perf-guard", "scripts/perf-guard.mjs", 180000],
  ["security-boundary", "scripts/security-boundary-smoke.mjs", 60000],
  ["operation-preview", "scripts/operation-preview-smoke.mjs", 90000],
  ["transactional-operations", "scripts/transactional-operations-smoke.mjs", 120000],
  ["operation-journal", "scripts/operation-journal-integrity-smoke.mjs", 120000],
  ["crash-recovery", "scripts/crash-recovery-smoke.mjs", 90000],
  ["crash-kill", "scripts/crash-kill-smoke.mjs", 180000],
  ["native-helper", "scripts/native-helper-smoke.mjs", 30000],
  ["packaged-native-helper", "scripts/packaged-native-helper-smoke.mjs", 60000],
  ["native-listing-provider", "scripts/native-listing-provider-smoke.mjs", 60000],
  ["size-analysis-perf", "scripts/size-analysis-perf-smoke.mjs", 180000],
  ["size-analysis-cancel", "scripts/size-analysis-cancel-smoke.mjs", 120000],
  ["size-analysis-ui", "scripts/size-analysis-ui-smoke.mjs", 120000],
  ["interaction-resize", "scripts/interaction-resize-smoke.mjs", 180000],
  ["default-explorer-ui", "scripts/default-explorer-ui-smoke.mjs", 120000],
  ["adaptive-pane-chrome", "scripts/adaptive-pane-chrome-ui-smoke.mjs", 180000],
  ["workspace-panels-ui", "scripts/workspace-panels-ui-smoke.mjs", 180000],
  ["startup-recovery-ui", "scripts/startup-recovery-ui-smoke.mjs", 120000],
  ["pane-activity", "scripts/pane-activity-ui-smoke.mjs", 180000],
  ["dual-pane-safety", "scripts/dual-pane-safety-ui-smoke.mjs", 180000],
  ["pane-layout", "scripts/pane-layout-no-scrollbars-smoke.mjs", 120000],
  ["layout", "scripts/layout-verify.mjs", 180000],
  ["keyboard", "scripts/keyboard-workflows-ui-smoke.mjs", 180000],
  ["command-center", "scripts/command-center-ui-smoke.mjs", 180000],
  ["accessibility", "scripts/accessibility-verify.mjs", 180000],
  ["terminal", "scripts/terminal-verify.mjs", 300000],
  ["mcp-contract", "scripts/mcp-contract-smoke.mjs", 60000],
  ["mcp-security", "scripts/mcp-security-smoke.mjs", 120000],
  ["mcp-context", "scripts/mcp-context-smoke.mjs", 180000],
  ["mcp-analysis", "scripts/mcp-analysis-smoke.mjs", 180000],
  ["mcp-operations", "scripts/mcp-operations-smoke.mjs", 180000],
  ["mcp-clients", "scripts/mcp-clients-smoke.mjs", 120000],
  ["mcp-performance", "scripts/mcp-performance-smoke.mjs", 180000],
  ["packaged-mcp", "scripts/packaged-mcp-smoke.mjs", 60000],
  ["mcp-inspector", "scripts/mcp-inspector-smoke.mjs", 240000],
  ["windows-baseline", "scripts/windows-baseline-smoke.mjs", 300000],
  ["large-folder-100k", "scripts/large-folder-ui-verify.mjs", 600000, ["--count=100000", "--viewports=desktop", "--output=large-folder-100k-ui-latest.json", "--screenshot-prefix=large-folder-100k-ui"]],
  ["release-readiness", "scripts/release-readiness-smoke.mjs", 180000],
  ["speed-health", "scripts/speed-health-audit.mjs", 60000],
  ["goal", "scripts/goal-stress-audit.mjs", 60000]
];

const extendedSuites = [
  ["filesystem-objects", "scripts/filesystem-objects-smoke.mjs", 180000],
  ["real-paths", "scripts/real-paths-verify.mjs", 180000],
  ["network-loopback", "scripts/network-loopback-smoke.mjs", 120000],
  ["no-admin-access", "scripts/no-admin-access-smoke.mjs", 180000],
  ["shell-current-user", "scripts/shell-current-user-smoke.mjs", 180000],
  ["shell-verbs", "scripts/shell-verbs-smoke.mjs", 180000],
  ["shell-namespace", "scripts/shell-namespace-smoke.mjs", 180000],
  ["shell-devices", "scripts/shell-devices-smoke.mjs", 180000],
  ["windows-recycle", "scripts/windows-recycle-smoke.mjs", 180000],
  ["zip-browse", "scripts/zip-browse-smoke.mjs", 180000],
  ["production-readiness", "scripts/production-readiness-smoke.mjs", 300000],
  ["external-proof", "scripts/external-proof-smoke.mjs", 120000]
];

async function packageVerificationSuites() {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const excludedNames = new Set(["verify:all", "verify:all:full", "verify:all:refresh", "verify:speed-health", "verify:goal"]);
  const existingScripts = new Set([...coreSuites, ...extendedSuites].map((suite) => suite[1].replace(/\\/g, "/")));
  const suites = [];
  for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    if (!name.startsWith("verify:") || excludedNames.has(name) || !String(command).startsWith("node scripts/")) continue;
    const tokens = String(command).match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const script = String(tokens[1] || "").replace(/^"|"$/g, "");
    if (!script || existingScripts.has(script.replace(/\\/g, "/"))) continue;
    const args = tokens.slice(2).map((token) => token.replace(/^"|"$/g, ""));
    const timeoutMs = /100k|production|release|desktop|mixed-load/.test(name) ? 600000 : 240000;
    suites.push([name.replace(/^verify:/, ""), script, timeoutMs, args]);
  }
  return suites;
}

function workspaceNodeProcesses() {
  if (process.platform !== "win32") return [];
  const escaped = root.replace(/'/g, "''");
  const command = `$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|electron).*' -and $_.CommandLine -like '*${escaped}*' }; @($items | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true });
  try {
    const value = JSON.parse(result.stdout || "[]");
    return Array.isArray(value) ? value : value ? [value] : [];
  } catch {
    return [];
  }
}

function stopTree(pid) {
  if (!pid || pid === process.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else process.kill(pid, "SIGKILL");
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function runSuite([name, script, timeoutMs, extraArgs = []]) {
  if (name === "perf-guard") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (name === "large-folder-100k") {
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  const suitePort = await freeLoopbackPort();
  return new Promise((resolve) => {
    const before = new Set(workspaceNodeProcesses().map((item) => Number(item.ProcessId)));
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(root, script), ...extraArgs], {
      cwd: root,
      env: { ...process.env, PORT: String(suitePort), EB_ACCEPTANCE_DIR: acceptanceDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      stopTree(child.pid);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ name, script, status: "fail", code: -1, timedOut, durationMs: Date.now() - started, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      for (const item of workspaceNodeProcesses()) {
        const pid = Number(item.ProcessId);
        if (!before.has(pid) && pid !== process.pid) stopTree(pid);
      }
      resolve({ name, script, status: code === 0 && !timedOut ? "pass" : "fail", code, timedOut, durationMs: Date.now() - started, stdout: stdout.slice(-100000), stderr: stderr.slice(-100000) });
    });
  });
}

async function acquireLock() {
  await fs.mkdir(artifacts, { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await fs.readFile(lockPath, "utf8").catch(() => "{}"));
    try {
      process.kill(Number(existing.pid), 0);
      throw new Error(`verify:all is already running as PID ${existing.pid}.`);
    } catch (probeError) {
      if (probeError.code !== "ESRCH") throw probeError;
      await fs.rm(lockPath, { force: true });
      return acquireLock();
    }
  }
}

async function main() {
  const lock = await acquireLock();
  await fs.mkdir(acceptanceDir, { recursive: true });
  const results = [];
  const startedAt = new Date().toISOString();
  try {
    const auditStarted = Date.now();
    const audit = process.platform === "win32"
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd audit --audit-level=high"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120000 })
      : spawnSync("npm", ["audit", "--audit-level=high"], { cwd: root, encoding: "utf8", timeout: 120000 });
    results.push({ name: "dependency-audit", script: "npm audit --audit-level=high", status: audit.status === 0 ? "pass" : "fail", code: audit.status, timedOut: Boolean(audit.error?.code === "ETIMEDOUT"), durationMs: Date.now() - auditStarted, stdout: audit.stdout || "", stderr: audit.stderr || "" });
    const metaNames = new Set(["release-readiness", "speed-health", "goal"]);
    const coreWithoutMeta = coreSuites.filter((suite) => !metaNames.has(suite[0]));
    const metaSuites = coreSuites.filter((suite) => metaNames.has(suite[0]));
    const discoveredSuites = await packageVerificationSuites();
    const selectedSuites = refreshStale
      ? [...discoveredSuites, ...extendedSuites, ...metaSuites]
      : full
        ? [...coreWithoutMeta, ...discoveredSuites, ...extendedSuites, ...metaSuites]
        : [...coreWithoutMeta, ...metaSuites];
    const seenScripts = new Set();
    for (const suite of selectedSuites) {
      const suiteKey = `${suite[1]} ${JSON.stringify(suite[3] || [])}`;
      if (seenScripts.has(suiteKey)) continue;
      seenScripts.add(suiteKey);
      console.log(`\n[verify:all] ${suite[0]}`);
      results.push(await runSuite(suite));
    }
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
  const report = {
    schema: "explore-better.verify-all.v1",
    generatedAt: new Date().toISOString(),
    startedAt,
    profile: refreshStale ? "refresh-stale" : full ? "full" : "core",
    acceptanceDir,
    machine: { node: process.version, platform: process.platform, arch: process.arch },
    summary: { pass: results.filter((item) => item.status === "pass").length, fail: results.filter((item) => item.status === "fail").length },
    results
  };
  await fs.writeFile(path.join(acceptanceDir, "release-readiness.json"), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(artifacts, "verify-all-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [`# Explore Better Verification`, ``, `Generated: ${report.generatedAt}`, `Profile: ${report.profile}`, `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail`, ``, `| Status | Suite | Duration |`, `| --- | --- | ---: |`, ...results.map((item) => `| ${item.status.toUpperCase()} | ${item.name} | ${(item.durationMs / 1000).toFixed(1)} s |`)].join("\n");
  await fs.writeFile(path.join(acceptanceDir, "release-readiness.md"), `${markdown}\n`);
  await fs.writeFile(path.join(artifacts, "verify-all-latest.md"), `${markdown}\n`);
  console.log(`\nverify:all: ${report.summary.pass} pass, ${report.summary.fail} fail`);
  console.log(`Evidence: ${acceptanceDir}`);
  if (report.summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
