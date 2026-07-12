import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `network-loopback-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "network-loopback-latest.json");
const latestMdPath = path.join(artifactsDir, "network-loopback-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function optionNumber(name, fallback) {
  const envName = `EB_NETWORK_LOOPBACK_${name.replace(/^--/, "").replace(/-/g, "_").toUpperCase()}`;
  const value = Number(optionValue(name, process.env[envName] || ""));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_NETWORK_LOOPBACK_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function limitedAppend(current, chunk, limit = 20000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

function execPowerShell(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          error: error?.message || ""
        });
      }
    );
  });
}

async function requestJson(baseUrl, route, options = {}) {
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(fetchOptions.headers || {})
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
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs} ms: ${route}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutput}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots", { timeoutMs: 1200 });
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
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData
    },
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

async function prepareFixture() {
  const count = optionNumber("--count", 500);
  await fs.mkdir(path.join(fixture, "nested"), { recursive: true });
  const marker = path.join(fixture, ".network-loopback-ready.json");
  try {
    const parsed = JSON.parse(await fs.readFile(marker, "utf8"));
    if (parsed.count === count) return { count };
  } catch {
    // Rebuild below.
  }
  await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(fixture, "nested"), { recursive: true });
  const batchSize = 100;
  for (let start = 0; start < count; start += batchSize) {
    const jobs = [];
    for (let index = start; index < Math.min(count, start + batchSize); index += 1) {
      const name = `network-target-${String(index).padStart(5, "0")}.txt`;
      jobs.push(fs.writeFile(path.join(fixture, name), `network loopback ${index}\n`, "utf8"));
    }
    await Promise.all(jobs);
  }
  await fs.writeFile(path.join(fixture, "nested", "inside-network.txt"), "nested\n", "utf8");
  await fs.writeFile(marker, JSON.stringify({ count, generatedAt: new Date().toISOString() }, null, 2), "utf8");
  return { count };
}

function explicitNetworkPath() {
  return optionValue("--path", process.env.EB_NETWORK_LOOPBACK_PATH || process.env.EB_PERF_NETWORK_PATHS || "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean)[0];
}

async function findAccessibleAdminShare() {
  if (process.platform !== "win32") return null;
  const parsed = path.parse(fixture);
  const driveLetter = parsed.root.slice(0, 1).toUpperCase();
  if (!driveLetter) return null;
  const relative = fixture.slice(parsed.root.length).replaceAll("\\", "\\");
  const candidates = [
    `\\\\127.0.0.1\\${driveLetter}$\\${relative}`,
    `\\\\localhost\\${driveLetter}$\\${relative}`
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return {
        kind: "admin-share",
        path: candidate,
        cleanup: null,
        detail: "Using an existing administrative drive share."
      };
    }
  }
  return null;
}

async function createTemporaryShare() {
  if (process.platform !== "win32") return null;
  const safeName = `EBLoop${stamp.replace(/[^0-9A-Za-z]/g, "").slice(-18)}`;
  const escapedPath = fixture.replaceAll("'", "''");
  const escapedName = safeName.replaceAll("'", "''");
  const account = `${os.userInfo().domain ? `${os.userInfo().domain}\\` : ""}${os.userInfo().username}`.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = "Stop"
if (-not (Get-Command New-SmbShare -ErrorAction SilentlyContinue)) { throw "New-SmbShare is unavailable" }
$Share = New-SmbShare -Name '${escapedName}' -Path '${escapedPath}' -ChangeAccess '${account}' -CachingMode None -Temporary:$false
[pscustomobject]@{ Name = $Share.Name; Path = $Share.Path } | ConvertTo-Json -Compress
`;
  const created = await execPowerShell(script, 12000);
  if (!created.ok) {
    return {
      kind: "temporary-share",
      unavailable: true,
      detail: shortPowerShellError(created)
    };
  }
  return {
    kind: "temporary-share",
    shareName: safeName,
    path: `\\\\127.0.0.1\\${safeName}`,
    cleanup: async () => {
      await execPowerShell(`Remove-SmbShare -Name '${escapedName}' -Force -ErrorAction SilentlyContinue`, 8000);
    },
    detail: "Created a temporary local SMB share for loopback verification."
  };
}

function shortPowerShellError(result) {
  return String(result.stderr || result.stdout || result.error || "PowerShell command failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function resolveNetworkTarget() {
  const explicit = explicitNetworkPath();
  if (explicit) {
    return {
      kind: "explicit",
      path: explicit,
      cleanup: null,
      detail: "Using explicit network path from --path, EB_NETWORK_LOOPBACK_PATH, or EB_PERF_NETWORK_PATHS."
    };
  }
  const adminShare = await findAccessibleAdminShare();
  if (adminShare) return adminShare;
  const temporary = await createTemporaryShare();
  if (temporary?.path) return temporary;
  return temporary || {
    kind: "unavailable",
    unavailable: true,
    detail: "No explicit path, administrative share, or temporary SMB share was available."
  };
}

async function timed(label, run) {
  const started = performance.now();
  try {
    const result = await run();
    return {
      label,
      status: "pass",
      wallMs: Math.round((performance.now() - started) * 10) / 10,
      result
    };
  } catch (error) {
    return {
      label,
      status: "error",
      wallMs: Math.round((performance.now() - started) * 10) / 10,
      error: error.message || String(error)
    };
  }
}

function summarizeList(data) {
  return {
    returned: data.entries?.length || 0,
    scanned: data.timing?.scanned || 0,
    totalMs: data.timing?.totalMs || 0,
    readMs: data.timing?.readMs || 0,
    statMs: data.timing?.statMs || 0,
    signatureMs: data.timing?.signatureMs || 0,
    timing: data.timing || null
  };
}

function summarizeIndexSearch(data) {
  return {
    indexed: data.indexed === true,
    returned: data.results?.length || 0,
    timing: data.timing || null
  };
}

async function runNetworkChecks(baseUrl, networkPath) {
  const timeoutMs = optionNumber("--timeout-ms", 15000);
  const params = new URLSearchParams({ path: networkPath, timeoutMs: "5000", sampleLimit: "10", watch: "false" });
  const diagnostics = await timed("diagnostics", () => requestJson(baseUrl, `/api/path/diagnostics?${params}`, { timeoutMs }));
  if (diagnostics.status !== "pass") return { diagnostics };

  const listRoute = `/api/list?${new URLSearchParams({ path: networkPath, includeSignature: "true" })}`;
  const cold = await timed("cold-list", async () => summarizeList(await requestJson(baseUrl, listRoute, { timeoutMs })));
  const warm = await timed("warm-list", async () => summarizeList(await requestJson(baseUrl, listRoute, { timeoutMs })));
  const indexBuild = await timed("folder-index-build", () =>
    requestJson(baseUrl, "/api/index/build", {
      method: "POST",
      timeoutMs,
      body: JSON.stringify({ path: networkPath, wait: true, showHidden: true })
    })
  );
  const indexSearch = await timed("folder-index-search", async () =>
    summarizeIndexSearch(
      await requestJson(
        baseUrl,
        `/api/index/search?${new URLSearchParams({ path: networkPath, q: "network-target", limit: "20" })}`,
        { timeoutMs }
      )
    )
  );
  return { diagnostics, cold, warm, indexBuild, indexSearch };
}

function checksPassed(checks) {
  if (!checks?.diagnostics?.result?.exists || checks.diagnostics.result.isNetwork !== true) return false;
  if (checks.cold?.status !== "pass" || checks.warm?.status !== "pass") return false;
  if ((checks.warm.result?.returned || 0) < optionNumber("--count", 500)) return false;
  if (checks.indexBuild?.status !== "pass" || checks.indexSearch?.status !== "pass") return false;
  return checks.indexSearch.result?.indexed === true && checks.indexSearch.result?.returned >= 1;
}

function markdownReport(output) {
  const lines = [
    "# Explore Better Network Loopback Smoke",
    "",
    `Generated: ${output.generatedAt}`,
    `Status: ${output.status}`,
    `Mode: ${output.mode}`,
    `Network path: ${output.networkPath || ""}`,
    `Detail: ${output.detail || ""}`,
    ""
  ];
  if (output.checks) {
    lines.push("| Check | Status | Wall ms | Detail |");
    lines.push("| --- | --- | ---: | --- |");
    for (const [name, check] of Object.entries(output.checks)) {
      const detail =
        check.result?.returned !== undefined
          ? `returned=${check.result.returned}`
          : check.result?.targetKind
            ? `${check.result.kind || ""} ${check.result.targetKind}`
            : check.error || "";
      lines.push(`| ${name} | ${check.status} | ${check.wallMs ?? ""} | ${String(detail).replaceAll("|", "/")} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const prepared = await prepareFixture();
  let target = null;
  let output = null;
  const explicit = Boolean(explicitNetworkPath());
  try {
    target = await resolveNetworkTarget();
    output = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      fixture,
      fixtureCount: prepared.count,
      mode: target.kind || "unknown",
      networkPath: target.path || "",
      detail: target.detail || "",
      status: target.unavailable ? "unavailable" : "pending",
      checks: null
    };
    if (target.unavailable || !target.path) {
      output.status = explicit ? "fail" : "unavailable";
      return;
    }
    const port = Number(optionValue("--port", process.env.PORT || 59000 + Math.floor(Math.random() * 4000)));
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = startServer(port);
    try {
      await waitForServer(baseUrl, server);
      output.checks = await runNetworkChecks(baseUrl, target.path);
      output.status = checksPassed(output.checks) ? "pass" : explicit ? "fail" : "unavailable";
    } finally {
      await stopServer(server);
    }
  } finally {
    if (target?.cleanup) {
      await target.cleanup();
    }
    if (output) {
      await fs.writeFile(latestJsonPath, JSON.stringify(output, null, 2), "utf8");
      await fs.writeFile(latestMdPath, markdownReport(output), "utf8");
      console.log(`network loopback: ${output.status} (${output.mode})`);
      console.log(`wrote ${latestJsonPath}`);
      console.log(`wrote ${latestMdPath}`);
      if (output.status === "fail") {
        process.exitCode = 1;
      }
    }
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch(async (error) => {
  const output = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    fixture,
    status: "fail",
    mode: "error",
    networkPath: "",
    detail: error.stack || error.message,
    serverOutput
  };
  await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
  await fs.writeFile(latestJsonPath, JSON.stringify(output, null, 2), "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(output), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
