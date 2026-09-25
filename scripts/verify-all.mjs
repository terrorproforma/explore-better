import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { currentSourceState, recordArtifactProvenance } from "./verify-provenance.mjs";

const root = process.cwd();
const artifacts = path.join(root, "artifacts");
const lockPath = path.join(artifacts, ".verify-all.lock");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const acceptanceDir = path.join(artifacts, "acceptance", stamp);
const full = process.argv.includes("--full");
const refreshStale = process.argv.includes("--refresh-stale");
// --strict: summary audits fail (instead of warning) on evidence from a different commit.
const strict = process.argv.includes("--strict") || process.env.EB_VERIFY_STRICT === "1";
const auditNpmVersion = "11.6.2";

// Per-suite timeout overrides: --suite-timeout=<suite>=<ms> (repeatable) or
// EB_VERIFY_SUITE_TIMEOUTS="<suite>=<ms>,<suite>=<ms>". These win over the defaults below.
function parseSuiteTimeouts() {
  const entries = [
    ...String(process.env.EB_VERIFY_SUITE_TIMEOUTS || "").split(","),
    ...process.argv.filter((arg) => arg.startsWith("--suite-timeout=")).map((arg) => arg.slice("--suite-timeout=".length))
  ];
  const overrides = new Map();
  for (const entry of entries) {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0) continue;
    const ms = Number(entry.slice(separator + 1));
    if (Number.isFinite(ms) && ms > 0) overrides.set(entry.slice(0, separator).trim(), ms);
  }
  return overrides;
}
const suiteTimeoutOverrides = parseSuiteTimeouts();
// Suites whose own internal waits can exceed the generic defaults. Killing them
// mid-run could leave external state half-applied, so give them room to finish.
const suiteTimeoutDefaults = new Map([["shell-current-user", 600000]]);

function suiteTimeout(name, fallbackMs) {
  return suiteTimeoutOverrides.get(name) ?? suiteTimeoutDefaults.get(name) ?? fallbackMs;
}

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
  ["checksums-ui", "scripts/checksums-ui-smoke.mjs", 120000],
  ["organizer-ui", "scripts/organizer-ui-smoke.mjs", 180000],
  ["preview-editor-properties-ui", "scripts/preview-editor-properties-ui-smoke.mjs", 180000],
  ["model-preview-ui", "scripts/model-preview-ui-smoke.mjs", 180000],
  ["preferences-ui", "scripts/preferences-ui-smoke.mjs", 180000],
  ["interaction-resize", "scripts/interaction-resize-smoke.mjs", 180000],
  ["interaction-quality", "scripts/interaction-quality-smoke.mjs", 120000],
  ["default-explorer-ui", "scripts/default-explorer-ui-smoke.mjs", 120000],
  ["packaged-integration-launch", "scripts/packaged-integration-launch-smoke.mjs", 120000],
  ["folder-tree-ui", "scripts/folder-tree-ui-smoke.mjs", 120000],
  ["adaptive-pane-chrome", "scripts/adaptive-pane-chrome-ui-smoke.mjs", 180000],
  ["workspace-panels-ui", "scripts/workspace-panels-ui-smoke.mjs", 180000],
  ["startup-recovery-ui", "scripts/startup-recovery-ui-smoke.mjs", 120000],
  ["pane-activity", "scripts/pane-activity-ui-smoke.mjs", 180000],
  ["dual-pane-safety", "scripts/dual-pane-safety-ui-smoke.mjs", 180000],
  ["pane-navigation", "scripts/pane-navigation-ui-smoke.mjs", 180000],
  ["pane-layout", "scripts/pane-layout-no-scrollbars-smoke.mjs", 120000],
  ["layout", "scripts/layout-verify.mjs", 180000],
  ["keyboard", "scripts/keyboard-workflows-ui-smoke.mjs", 180000],
  ["command-center", "scripts/command-center-ui-smoke.mjs", 180000],
  ["accessibility", "scripts/accessibility-verify.mjs", 180000],
  ["terminal", "scripts/terminal-verify.mjs", 300000],
  ["terminal-service", "scripts/terminal-service.test.mjs", 30000],
  ["desktop-lifecycle", "scripts/desktop-lifecycle.test.mjs", 30000],
  ["desktop-startup", "scripts/desktop-startup.test.mjs", 30000],
  ["desktop-session", "scripts/desktop-session-smoke.mjs", 120000],
  ["terminal-native-lifecycle", "scripts/terminal-native-lifecycle-smoke.mjs", 120000],
  ["backend-integrity", "scripts/backend-integrity-smoke.mjs", 120000],
  ["backend-round-two", "scripts/backend-round-two-smoke.mjs", 120000],
  ["backend-operation-wait", "scripts/backend-operation-wait-smoke.mjs", 60000],
  ["renderer-state", "scripts/renderer-state-regression-smoke.mjs", 120000],
  ["renderer-async", "scripts/renderer-async-regression-smoke.mjs", 120000],
  ["clipboard-sequence", "scripts/clipboard-sequence-smoke.mjs", 60000],
  ["mcp-release", "scripts/mcp-release-smoke.mjs", 60000],
  ["mcp-reliability", "scripts/mcp-reliability-smoke.mjs", 60000],
  ["mcp-lifecycle", "scripts/mcp-lifecycle-smoke.mjs", 60000],
  ["mcp-policy-regression", "scripts/mcp-policy-regression-smoke.mjs", 60000],
  ["mcp-client-roots", "scripts/mcp-client-roots-smoke.mjs", 60000],
  ["mcp-contract", "scripts/mcp-contract-smoke.mjs", 60000],
  ["mcp-security", "scripts/mcp-security-smoke.mjs", 120000],
  ["mcp-context", "scripts/mcp-context-smoke.mjs", 180000],
  ["mcp-ui-views", "scripts/mcp-ui-views-smoke.mjs", 240000],
  ["mcp-analysis", "scripts/mcp-analysis-smoke.mjs", 180000],
  ["mcp-operations", "scripts/mcp-operations-smoke.mjs", 180000],
  ["mcp-clients", "scripts/mcp-clients-smoke.mjs", 120000],
  ["mcpb", "scripts/mcpb-smoke.mjs", 120000],
  ["mcp-performance", "scripts/mcp-performance-smoke.mjs", 180000],
  ["mcp-value", "scripts/mcp-value-benchmark.mjs", 180000],
  ["packaged-mcp", "scripts/packaged-mcp-smoke.mjs", 60000],
  ["mcp-inspector", "scripts/mcp-inspector-smoke.mjs", 240000],
  ["seo-discovery", "scripts/seo-discovery-smoke.mjs", 180000],
  ["site-links", "scripts/site-link-check.mjs", 60000],
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
  ["native-shell-readiness", "scripts/native-shell-readiness-smoke.mjs", 180000],
  ["windows-recycle", "scripts/windows-recycle-smoke.mjs", 180000],
  ["trash-recovery-ui", "scripts/trash-recovery-ui-smoke.mjs", 180000],
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

// Snapshot of every process (pid, parent, creation time) flagging node/electron
// processes whose command line references this workspace.
function processSnapshot() {
  if (process.platform !== "win32") return [];
  const escaped = root.replace(/'/g, "''");
  const command = `$items = Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ P = [int]$_.ProcessId; PP = [int]$_.ParentProcessId; C = $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }); W = [bool]($_.Name -match '^(node|electron).*' -and $_.CommandLine -like '*${escaped}*') } }; @($items) | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  try {
    const value = JSON.parse(result.stdout || "[]");
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.map((item) => ({
      pid: Number(item.P),
      ppid: Number(item.PP),
      createdMs: Number(item.C) ? Number(item.C) / 10000 - 11644473600000 : 0,
      workspace: item.W === true
    }));
  } catch {
    return [];
  }
}

// Workspace node/electron processes left behind by one suite: new since the suite
// started and descended from it. Ancestry follows live parents (a parent counts only
// if it was created before its child, which rules out reused PIDs); a chain that ends
// at the exited suite PID, or at an orphan root created after the suite started, is
// owned by the suite. Processes under any other live parent (a user's own shell,
// editor or running app) are left alone.
function suiteLeftoverProcesses(snapshot, before, suitePid, suiteStartedMs) {
  const byPid = new Map(snapshot.map((item) => [item.pid, item]));
  const owned = [];
  for (const item of snapshot) {
    if (!item.workspace || before.has(item.pid) || item.pid === process.pid || item.createdMs < suiteStartedMs - 1000) continue;
    let node = item;
    for (let depth = 0; depth < 64; depth += 1) {
      if (node.ppid === suitePid) {
        owned.push(item.pid);
        break;
      }
      const parent = byPid.get(node.ppid);
      if (!parent || parent.createdMs > node.createdMs) {
        if (node.createdMs >= suiteStartedMs - 1000) owned.push(item.pid);
        break;
      }
      if (parent.pid === process.pid) break;
      node = parent;
    }
  }
  return owned;
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

async function runSuite([name, script, defaultTimeoutMs, extraArgs = []], sourceState) {
  const timeoutMs = suiteTimeout(name, defaultTimeoutMs);
  if (name === "perf-guard") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (name === "large-folder-100k") {
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  const suitePort = await freeLoopbackPort();
  const result = await new Promise((resolve) => {
    const before = new Set(processSnapshot().filter((item) => item.workspace).map((item) => item.pid));
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(root, script), ...extraArgs], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(suitePort),
        EB_ACCEPTANCE_DIR: acceptanceDir,
        EB_VERIFY_COMMIT: sourceState.commit || "",
        EB_VERIFY_DIRTY: sourceState.dirty ? "1" : "0",
        EB_VERIFY_STRICT: strict ? "1" : "0"
      },
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
      const leftovers = suiteLeftoverProcesses(processSnapshot(), before, child.pid, started);
      for (const pid of leftovers) stopTree(pid);
      resolve({ name, script, status: code === 0 && !timedOut ? "pass" : "fail", code, timedOut, timeoutMs, durationMs: Date.now() - started, startedMs: started, leftoverProcessesStopped: leftovers.length, stdout: stdout.slice(-100000), stderr: stderr.slice(-100000) });
    });
  });
  if (sourceState.commit) {
    result.artifactsRecorded = await recordArtifactProvenance(artifacts, result.startedMs ?? Date.now(), name, sourceState).catch(() => []);
  }
  delete result.startedMs;
  return result;
}

async function readAuditProvenance(fileName) {
  try {
    return JSON.parse(await fs.readFile(path.join(artifacts, fileName), "utf8")).provenance || null;
  } catch {
    return null;
  }
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

async function npmAuditInvocation() {
  const npmOnPath = process.platform === "win32"
    ? spawnSync("where.exe", ["npm"], { stdio: "ignore", windowsHide: true }).status === 0
    : spawnSync("npm", ["--version"], { stdio: "ignore" }).status === 0;
  if (npmOnPath) {
    return process.platform === "win32"
      ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd audit --audit-level=high"] }
      : { command: "npm", args: ["audit", "--audit-level=high"] };
  }

  const toolingDir = path.join(artifacts, "npm-runtime");
  const npmCli = path.join(toolingDir, "node_modules", "npm", "bin", "npm-cli.js");
  const pnpmCli = process.env.PNPM_CLI_PATH || path.resolve(path.dirname(process.execPath), "..", "node_modules", "pnpm", "bin", "pnpm.cjs");
  try {
    await fs.access(npmCli);
  } catch {
    const pnpmAvailable = spawnSync(process.execPath, [pnpmCli, "--version"], { stdio: "ignore", windowsHide: true }).status === 0;
    if (!pnpmAvailable) {
      return { error: "npm audit requires npm, or a bundled pnpm runtime capable of provisioning npm." };
    }
    await fs.mkdir(toolingDir, { recursive: true });
    await fs.writeFile(
      path.join(toolingDir, "package.json"),
      `${JSON.stringify({ name: "explore-better-npm-runtime", private: true, version: "0.0.0" }, null, 2)}\n`,
      "utf8"
    );
    const provision = spawnSync(
      process.execPath,
      [pnpmCli, "--dir", toolingDir, "add", `npm@${auditNpmVersion}`, "--save-exact"],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 }
    );
    if (provision.status !== 0) {
      return { error: `Could not provision npm ${auditNpmVersion}: ${provision.stderr || provision.stdout || provision.error?.message || provision.status}` };
    }
  }
  return { command: process.execPath, args: [npmCli, "audit", "--audit-level=high"] };
}

async function main() {
  const lock = await acquireLock();
  await fs.mkdir(acceptanceDir, { recursive: true });
  const results = [];
  const startedAt = new Date().toISOString();
  const sourceState = currentSourceState(root);
  let provenanceIssues = [];
  try {
    const auditStarted = Date.now();
    const auditCommand = await npmAuditInvocation();
    const audit = auditCommand.error
      ? { status: 1, stdout: "", stderr: auditCommand.error }
      : spawnSync(auditCommand.command, auditCommand.args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120000 });
    results.push({ name: "dependency-audit", script: "npm audit --audit-level=high", status: audit.status === 0 ? "pass" : "fail", code: audit.status, timedOut: Boolean(audit.error?.code === "ETIMEDOUT"), durationMs: Date.now() - auditStarted, stdout: audit.stdout || "", stderr: audit.stderr || "" });
    const metaNames = new Set(["release-readiness", "speed-health", "goal"]);
    const coreWithoutMeta = coreSuites.filter((suite) => !metaNames.has(suite[0]));
    const metaSuites = coreSuites.filter((suite) => metaNames.has(suite[0]));
    const discoveredSuites = await packageVerificationSuites();
    const baseSuites = refreshStale
      ? [...discoveredSuites, ...extendedSuites, ...metaSuites]
      : full
        ? [...coreWithoutMeta, ...discoveredSuites, ...extendedSuites, ...metaSuites]
        : [...coreWithoutMeta, ...metaSuites];
    const finalReleaseOrder = new Map([
      ["release-checksums", 1],
      ["release-bundle", 2]
    ]);
    const selectedSuites = [
      ...baseSuites.filter((suite) => !finalReleaseOrder.has(suite[0]) && !metaNames.has(suite[0])),
      ...baseSuites
        .filter((suite) => finalReleaseOrder.has(suite[0]))
        .sort((left, right) => finalReleaseOrder.get(left[0]) - finalReleaseOrder.get(right[0])),
      ...baseSuites.filter((suite) => metaNames.has(suite[0]))
    ];
    const seenScripts = new Set();
    for (const suite of selectedSuites) {
      const suiteKey = `${suite[1]} ${JSON.stringify(suite[3] || [])}`;
      if (seenScripts.has(suiteKey)) continue;
      seenScripts.add(suiteKey);
      console.log(`\n[verify:all] ${suite[0]}`);
      results.push(await runSuite(suite, sourceState));
    }
    // Summary audits accept evidence up to 72h old; surface anything they consumed
    // that was produced by a different commit than this run.
    for (const [suite, fileName] of [["speed-health", "speed-health-latest.json"], ["goal", "goal-stress-audit-latest.json"]]) {
      if (!results.some((item) => item.name === suite)) continue;
      const provenance = await readAuditProvenance(fileName);
      for (const item of provenance?.mismatched || []) provenanceIssues.push({ audit: suite, ...item });
    }
    provenanceIssues = provenanceIssues.filter((item, index, all) => all.findIndex((other) => other.name === item.name) === index);
    if (provenanceIssues.length) {
      const banner = "!".repeat(78);
      console.warn(`\n${banner}\n[verify:all] ${provenanceIssues.length} artifact(s) consumed by the summary audits were produced at a different commit than ${sourceState.commit?.slice(0, 12) || "HEAD"}${sourceState.dirty ? " (dirty tree)" : ""}:`);
      for (const item of provenanceIssues) console.warn(`  - ${item.detail}`);
      console.warn(strict
        ? "[verify:all] --strict: treating different-commit evidence as a failure."
        : "[verify:all] Re-run the producing suites (verify:all --full or --refresh-stale), or pass --strict to fail on this.");
      console.warn(banner);
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
    source: { commit: sourceState.commit, dirty: sourceState.dirty, strict },
    summary: { pass: results.filter((item) => item.status === "pass").length, fail: results.filter((item) => item.status === "fail").length },
    provenance: { differentCommitArtifacts: provenanceIssues },
    results
  };
  await fs.writeFile(path.join(acceptanceDir, "release-readiness.json"), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(artifacts, "verify-all-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [`# Explore Better Verification`, ``, `Generated: ${report.generatedAt}`, `Profile: ${report.profile}`, `Source: ${sourceState.commit || "unknown"}${sourceState.dirty ? " (dirty)" : ""}`, `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail`, ...(provenanceIssues.length ? [`Different-commit evidence: ${provenanceIssues.map((item) => item.name).join(", ")}`] : []), ``, `| Status | Suite | Duration |`, `| --- | --- | ---: |`, ...results.map((item) => `| ${item.status.toUpperCase()} | ${item.name} | ${(item.durationMs / 1000).toFixed(1)} s |`)].join("\n");
  await fs.writeFile(path.join(acceptanceDir, "release-readiness.md"), `${markdown}\n`);
  await fs.writeFile(path.join(artifacts, "verify-all-latest.md"), `${markdown}\n`);
  console.log(`\nverify:all: ${report.summary.pass} pass, ${report.summary.fail} fail`);
  console.log(`Evidence: ${acceptanceDir}`);
  if (report.summary.fail || (strict && provenanceIssues.length)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
