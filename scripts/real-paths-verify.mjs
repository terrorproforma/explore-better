import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `real-paths-${stamp}`);
const appData = path.join(runRoot, "appdata");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function optionNumber(name, fallback) {
  const envName = `EB_REAL_PATHS_${name.replace(/^--/, "").replace(/-/g, "_").toUpperCase()}`;
  const value = Number(optionValue(name, process.env[envName] || ""));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_REAL_PATHS_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function elapsed(started) {
  return Math.round((performance.now() - started) * 10) / 10;
}

async function requestJson(baseUrl, route, options = {}) {
  const { timeoutMs = 8000, ...fetchOptions } = options;
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
  const started = performance.now();
  while (performance.now() - started < 10000) {
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

function pathKey(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function addCandidate(candidates, candidate) {
  if (!candidate.path) return;
  const key = pathKey(candidate.path);
  if (candidates.has(key)) return;
  candidates.set(key, {
    required: false,
    source: "auto",
    kind: "folder",
    ...candidate,
    path: candidate.path
  });
}

function parseExplicitPaths() {
  return optionValue("--paths", process.env.EB_REAL_PATHS || "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function windowsDriveTypeName(type) {
  return (
    {
      0: "unknown",
      1: "no-root",
      2: "removable",
      3: "fixed",
      4: "network",
      5: "cdrom",
      6: "ramdisk"
    }[Number(type)] || "drive"
  );
}

function runPowerShellJson(command, timeoutMs = 3500) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

async function discoverWindowsDrives() {
  if (process.platform !== "win32") return [];
  const command =
    "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,ProviderName,VolumeName | ConvertTo-Json -Compress";
  const drives = await runPowerShellJson(command);
  return drives
    .map((drive) => {
      const device = String(drive.DeviceID || "").replace(/\\+$/, "");
      return device
        ? {
            label: `${device}\\ ${drive.VolumeName || windowsDriveTypeName(drive.DriveType)}`.trim(),
            path: `${device}\\`,
            kind: windowsDriveTypeName(drive.DriveType),
            source: "logical-disk",
            providerName: drive.ProviderName || "",
            required: false
          }
        : null;
    })
    .filter(Boolean);
}

function commonFolderCandidates() {
  const home = os.homedir();
  const env = process.env;
  const candidates = new Map();
  addCandidate(candidates, { label: "Workspace", path: workspace, kind: "workspace", source: "workspace", required: true });
  addCandidate(candidates, { label: "Home", path: home, kind: "home", source: "home" });
  addCandidate(candidates, { label: "Desktop", path: path.join(home, "Desktop"), kind: "desktop", source: "known-folder" });
  addCandidate(candidates, { label: "Downloads", path: path.join(home, "Downloads"), kind: "downloads", source: "known-folder" });
  addCandidate(candidates, { label: "Documents", path: path.join(home, "Documents"), kind: "documents", source: "known-folder" });
  const cloudEnv = [
    ["OneDrive", env.OneDrive || env.ONEDRIVE],
    ["OneDrive Consumer", env.OneDriveConsumer],
    ["OneDrive Commercial", env.OneDriveCommercial],
    ["OneDrive Home Guess", path.join(home, "OneDrive")]
  ];
  for (const [label, targetPath] of cloudEnv) {
    if (targetPath) {
      addCandidate(candidates, { label, path: targetPath, kind: "cloud", source: "cloud" });
      addCandidate(candidates, { label: `${label} Desktop`, path: path.join(targetPath, "Desktop"), kind: "cloud-desktop", source: "cloud" });
      addCandidate(candidates, { label: `${label} Documents`, path: path.join(targetPath, "Documents"), kind: "cloud-documents", source: "cloud" });
    }
  }
  for (const explicitPath of parseExplicitPaths()) {
    addCandidate(candidates, { label: `Explicit ${explicitPath}`, path: explicitPath, kind: "explicit", source: "explicit", required: true });
  }
  return candidates;
}

async function discoverCandidates() {
  const candidates = commonFolderCandidates();
  for (const drive of await discoverWindowsDrives()) {
    addCandidate(candidates, drive);
  }
  const maxTargets = optionNumber("--max-targets", 12);
  const ordered = [...candidates.values()].sort((left, right) => {
    if (left.required !== right.required) return left.required ? -1 : 1;
    const score = (item) =>
      item.kind === "workspace"
        ? 0
        : item.kind === "cloud" || item.kind === "cloud-desktop" || item.kind === "cloud-documents"
          ? 1
          : item.kind === "network"
            ? 2
            : item.kind === "removable"
              ? 3
              : item.kind === "fixed"
                ? 6
                : 4;
    return score(left) - score(right) || String(left.label).localeCompare(String(right.label));
  });
  const required = ordered.filter((item) => item.required);
  const optional = ordered.filter((item) => !item.required).slice(0, Math.max(0, maxTargets - required.length));
  return [...required, ...optional];
}

async function timedStep(label, run) {
  const started = performance.now();
  try {
    const result = await run();
    return {
      label,
      status: "pass",
      wallMs: elapsed(started),
      result
    };
  } catch (error) {
    return {
      label,
      status: "error",
      wallMs: elapsed(started),
      error: error.message || String(error)
    };
  }
}

function summarizeList(data) {
  return {
    path: data.path || "",
    returned: data.entries?.length || 0,
    hiddenFiltered: data.hiddenFiltered || 0,
    timing: data.timing || null,
    folderSignature: data.folderSignature || null
  };
}

function chooseSearchQuery(listData) {
  const entries = Array.isArray(listData.entries) ? listData.entries : [];
  const entry =
    entries.find((item) => item.name && !item.name.startsWith(".") && item.isFile) ||
    entries.find((item) => item.name && !item.name.startsWith(".")) ||
    entries.find((item) => item.name);
  if (!entry) return "";
  const parsed = path.parse(entry.name);
  return String(parsed.name || entry.name).slice(0, 32).toLowerCase();
}

function summarizeIndexBuild(data) {
  return {
    status: data.job?.status || "",
    index: data.index || data.job?.index || null
  };
}

function summarizeIndexSearch(data) {
  return {
    indexed: data.indexed === true,
    returned: data.results?.length || 0,
    timing: data.timing || null
  };
}

async function waitForBackgroundComplete(baseUrl, rootId, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const overview = await requestJson(baseUrl, "/api/background-indexes", { timeoutMs: Math.min(timeoutMs, 4000) });
    const root = overview.roots?.find((item) => item.id === rootId);
    if (!root) throw new Error("Background root disappeared.");
    if (root.job?.status === "error") throw new Error(root.job.error || "Background index failed.");
    if (!root.job || root.job.status === "complete") return root;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Background index did not complete within ${timeoutMs} ms.`);
}

async function shallowBackgroundIndex(baseUrl, targetPath, query, timeoutMs) {
  const started = await requestJson(baseUrl, "/api/background-indexes/start", {
    method: "POST",
    timeoutMs,
    body: JSON.stringify({
      path: targetPath,
      recursive: false,
      includeDimensions: false,
      includeLinks: false,
      includeContent: false,
      maxFolders: 1,
      maxEntries: 1000
    })
  });
  const rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
  assert(rootId, "Background index did not return a root id.");
  const root = await waitForBackgroundComplete(baseUrl, rootId, timeoutMs);
  const search = await requestJson(
    baseUrl,
    `/api/background-indexes/search?${new URLSearchParams({ q: query, rootId, limit: "20" })}`,
    { timeoutMs }
  );
  return {
    rootId,
    search: root.search || root.lastStats || null,
    returned: search.results?.length || 0,
    timing: search.timing || null
  };
}

async function probeCandidate(baseUrl, candidate) {
  const timeoutMs = optionNumber("--timeout-ms", 8000);
  const diagnosticsTimeoutMs = Math.min(timeoutMs, optionNumber("--diagnostics-timeout-ms", 3000));
  const result = {
    ...candidate,
    status: "pending",
    diagnostics: null,
    coldList: null,
    warmList: null,
    indexBuild: null,
    indexSearch: null,
    backgroundIndex: null,
    searchQuery: ""
  };

  const diagnostics = await timedStep("diagnostics", () =>
    requestJson(
      baseUrl,
      `/api/path/diagnostics?${new URLSearchParams({
        path: candidate.path,
        timeoutMs: String(diagnosticsTimeoutMs),
        sampleLimit: "12",
        watch: "false"
      })}`,
      { timeoutMs: diagnosticsTimeoutMs + 1000 }
    )
  );
  result.diagnostics = diagnostics;
  if (diagnostics.status !== "pass") {
    result.status = candidate.required ? "fail" : "unavailable";
    return result;
  }
  const diag = diagnostics.result;
  if (!diag.exists || !diag.reachable || diag.targetKind !== "directory" || diag.readable === false) {
    result.status = candidate.required ? "fail" : "unavailable";
    result.reason = diag.errors?.map((item) => item.message).filter(Boolean).join("; ") || "Path is not a readable directory.";
    return result;
  }

  const listRoute = `/api/list?${new URLSearchParams({ path: candidate.path, includeSignature: "true" })}`;
  result.coldList = await timedStep("cold-list", async () => summarizeList(await requestJson(baseUrl, listRoute, { timeoutMs })));
  if (result.coldList.status !== "pass") {
    result.status = candidate.required ? "fail" : "error";
    return result;
  }
  result.warmList = await timedStep("warm-list", async () => summarizeList(await requestJson(baseUrl, listRoute, { timeoutMs })));
  if (result.warmList.status !== "pass") {
    result.status = candidate.required ? "fail" : "error";
    return result;
  }
  const rawWarmList = await requestJson(baseUrl, listRoute, { timeoutMs });
  result.searchQuery = chooseSearchQuery(rawWarmList);

  result.indexBuild = await timedStep("folder-index-build", async () =>
    summarizeIndexBuild(
      await requestJson(baseUrl, "/api/index/build", {
        method: "POST",
        timeoutMs,
        body: JSON.stringify({ path: candidate.path, wait: true, showHidden: true })
      })
    )
  );
  if (result.indexBuild.status !== "pass") {
    result.status = candidate.required ? "fail" : "error";
    return result;
  }
  result.indexSearch = await timedStep("folder-index-search", async () =>
    summarizeIndexSearch(
      await requestJson(
        baseUrl,
        `/api/index/search?${new URLSearchParams({ path: candidate.path, q: result.searchQuery, limit: "20" })}`,
        { timeoutMs }
      )
    )
  );
  if (result.indexSearch.status !== "pass" || result.indexSearch.result.indexed !== true) {
    result.status = candidate.required ? "fail" : "error";
    return result;
  }

  result.backgroundIndex = await timedStep("background-index-shallow", () =>
    shallowBackgroundIndex(baseUrl, candidate.path, result.searchQuery, timeoutMs)
  );
  if (result.backgroundIndex.status !== "pass") {
    result.status = candidate.required ? "fail" : "error";
    return result;
  }

  result.status = "pass";
  return result;
}

function markdownReport(report) {
  const rows = report.results
    .map((item) => {
      const cold = item.coldList?.status === "pass" ? item.coldList.wallMs : "";
      const warm = item.warmList?.status === "pass" ? item.warmList.wallMs : "";
      const listed = item.warmList?.result?.returned ?? "";
      const index = item.indexSearch?.status === "pass" ? item.indexSearch.wallMs : "";
      const bg = item.backgroundIndex?.status === "pass" ? item.backgroundIndex.wallMs : "";
      const reason = item.reason || item.diagnostics?.error || item.coldList?.error || item.indexBuild?.error || "";
      return `| ${item.status} | ${item.label} | ${item.kind} | \`${item.path}\` | ${listed} | ${cold} | ${warm} | ${index} | ${bg} | ${reason.replace(/\|/g, "/")} |`;
    })
    .join("\n");
  return `# Explore Better Real Path Verification

Generated: ${report.generatedAt}

Status: ${report.status}

Required targets passed: ${report.requiredPassed}/${report.requiredTotal}

| Status | Label | Kind | Path | Listed | Cold ms | Warm ms | Index search ms | Shallow BG ms | Note |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
${rows}

Notes:
- Auto-discovered external targets that are not present or not readable are reported as unavailable.
- Explicit paths from \`EB_REAL_PATHS\` or \`--paths\` are required and fail the verifier if they cannot be listed and indexed.
- Shallow background indexing uses \`recursive=false\` and bounded entry caps so a drive or cloud root is not recursively crawled.
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const port = Number(optionValue("--port", process.env.PORT || 58000 + Math.floor(Math.random() * 5000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  try {
    await waitForServer(baseUrl, server);
    const candidates = await discoverCandidates();
    assert(candidates.length, "At least one real path candidate should be discovered.");
    const results = [];
    for (const candidate of candidates) {
      const result = await probeCandidate(baseUrl, candidate);
      results.push(result);
      const cold = result.coldList?.status === "pass" ? `${result.coldList.wallMs} ms` : result.status;
      const warm = result.warmList?.status === "pass" ? `${result.warmList.wallMs} ms` : "";
      console.log(`${result.status}: ${candidate.label} (${candidate.kind}) cold ${cold}${warm ? `, warm ${warm}` : ""}`);
    }
    const required = results.filter((item) => item.required);
    const requiredPassed = required.filter((item) => item.status === "pass").length;
    const passCount = results.filter((item) => item.status === "pass").length;
    const report = {
      generatedAt: new Date().toISOString(),
      status: requiredPassed === required.length && passCount > 0 ? "pass" : "fail",
      platform: process.platform,
      timeoutMs: optionNumber("--timeout-ms", 8000),
      requiredPassed,
      requiredTotal: required.length,
      passed: passCount,
      total: results.length,
      results
    };
    const jsonPath = path.join(artifactsDir, "real-paths-latest.json");
    const mdPath = path.join(artifactsDir, "real-paths-latest.md");
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
    await fs.writeFile(mdPath, markdownReport(report), "utf8");
    console.log(`wrote ${jsonPath}`);
    console.log(`wrote ${mdPath}`);
    if (report.status !== "pass") {
      throw new Error(`real path verification failed: ${requiredPassed}/${required.length} required paths passed, ${passCount}/${results.length} total passed`);
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (serverOutput) {
    console.error(serverOutput);
  }
  process.exitCode = 1;
});
