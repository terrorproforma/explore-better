import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `windows-baseline-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "windows-baseline-latest.json");
const latestMdPath = path.join(artifactsDir, "windows-baseline-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function parseCounts(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
    .sort((left, right) => left - right);
}

function rounded(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_WINDOWS_BASELINE_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail, extra = {}) {
  checks.push({ id, status: ok ? "pass" : "fail", detail, ...extra });
}

function budgetCheck(checks, id, actual, budget, detail) {
  const numeric = Number(actual);
  checks.push({
    id,
    status: Number.isFinite(numeric) && numeric <= Number(budget) ? "pass" : "fail",
    actual: Number.isFinite(numeric) ? rounded(numeric) : null,
    budget,
    detail
  });
}

function summaryFor(checks) {
  return {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
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
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function timed(run) {
  const started = performance.now();
  const result = await run();
  return {
    wallMs: rounded(performance.now() - started),
    result
  };
}

async function waitForServer(baseUrl, child) {
  const started = performance.now();
  while (performance.now() - started < 10000) {
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

function spawnServer(port) {
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

async function startServerWithRetries() {
  const explicitPort = optionValue("--port", process.env.PORT || "");
  const candidates = explicitPort
    ? [Number(explicitPort)]
    : Array.from({ length: 10 }, (_, index) => 51000 + Math.floor(Math.random() * 8000) + index);
  let lastError = null;
  for (const port of candidates) {
    if (!Number.isFinite(port) || port <= 0) continue;
    const server = spawnServer(port);
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForServer(baseUrl, server);
      return { server, baseUrl, port };
    } catch (error) {
      lastError = error;
      await stopServer(server);
      if (explicitPort || !/(EACCES|EADDRINUSE|permission denied|address already in use)/i.test(error.message || "")) {
        throw error;
      }
    }
  }
  throw lastError || new Error("No usable local port found for Windows baseline verifier.");
}

async function safeRemoveRunRoot() {
  const resolvedRunRoot = path.resolve(runRoot);
  const resolvedArtifacts = path.resolve(artifactsDir);
  if (!resolvedRunRoot.startsWith(`${resolvedArtifacts}${path.sep}`)) {
    throw new Error(`Refusing to remove run root outside artifacts: ${resolvedRunRoot}`);
  }
  await fs.rm(resolvedRunRoot, { recursive: true, force: true });
}

async function writeBatch(files) {
  await Promise.all(files.map(([file, text]) => fs.writeFile(file, text)));
}

async function prepareFixture(count) {
  const dir = path.join(fixtureRoot, `count-${count}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const batch = [];
  for (let index = 0; index < count; index += 1) {
    const extension = index % 10 === 0 ? ".jpg" : index % 7 === 0 ? ".md" : index % 5 === 0 ? ".json" : ".txt";
    const name = `baseline-target-${String(index).padStart(6, "0")}${extension}`;
    const text = `windows baseline fixture ${index}\n${extension}\n`;
    batch.push([path.join(dir, name), text]);
    if (batch.length >= 512) {
      await writeBatch(batch.splice(0));
    }
  }
  if (batch.length) {
    await writeBatch(batch);
  }
  return {
    path: dir,
    count,
    needle: `baseline-target-${String(Math.max(0, count - 1)).padStart(6, "0")}`
  };
}

function runPowerShell(script, env) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        cwd: workspace,
        env: { ...process.env, ...env },
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 8
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr || stdout}`.trim()));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function measureNativeBaseline(fixture) {
  const script = `
$ErrorActionPreference = 'Stop'
$targetPath = $env:EB_BASELINE_PATH
$needle = $env:EB_BASELINE_NEEDLE
function Measure-NativeEnumeration {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $count = 0
  $bytes = [int64]0
  $matches = 0
  $directory = [IO.DirectoryInfo]::new($targetPath)
  foreach ($item in $directory.EnumerateFileSystemInfos()) {
    $count += 1
    $name = $item.Name
    $attrs = $item.Attributes
    $null = $item.LastWriteTimeUtc
    if (($attrs -band [IO.FileAttributes]::Directory) -eq 0) {
      $bytes += [int64]$item.Length
    }
    if ($name.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $matches += 1
    }
  }
  $sw.Stop()
  [pscustomobject]@{
    count = $count
    bytes = $bytes
    matches = $matches
    scanned = $count
    wallMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
  }
}
$first = Measure-NativeEnumeration
$second = Measure-NativeEnumeration
[pscustomobject]@{
  method = '.NET DirectoryInfo.EnumerateFileSystemInfos'
  path = $targetPath
  needle = $needle
  first = $first
  second = $second
} | ConvertTo-Json -Depth 5
`;
  const stdout = await runPowerShell(script, {
    EB_BASELINE_PATH: fixture.path,
    EB_BASELINE_NEEDLE: fixture.needle
  });
  return JSON.parse(stdout);
}

function summarizeList(timing) {
  const data = timing.result || {};
  return {
    wallMs: timing.wallMs,
    returned: data.entries?.length || 0,
    totalEntries: data.window?.total || data.timing?.totalEntries || data.entries?.length || 0,
    scanned: data.timing?.scanned || 0,
    source: data.source || data.timing?.source || "",
    cache: data.timing?.cache || data.cache || null,
    window: data.window || data.timing?.window || null,
    apiMs: rounded(data.timing?.totalMs || 0)
  };
}

function summarizeIndexBuild(timing) {
  const data = timing.result || {};
  return {
    wallMs: timing.wallMs,
    count: data.index?.count || 0,
    tokens: data.index?.tokenIndex?.tokens || 0,
    elapsedMs: rounded(data.index?.elapsedMs || data.timing?.totalMs || 0)
  };
}

function summarizeSearch(timing) {
  const data = timing.result || {};
  return {
    wallMs: timing.wallMs,
    returned: data.entries?.length || data.results?.length || 0,
    scanned: data.scanned || data.timing?.scanned || 0,
    tokenNarrowed: data.timing?.tokenNarrowed === true,
    timing: data.timing || null
  };
}

async function runCase(baseUrl, count, budgets) {
  const fixture = await prepareFixture(count);
  const native = await measureNativeBaseline(fixture);
  const query = new URLSearchParams({ path: fixture.path, includeSignature: "true" });
  const cold = summarizeList(await timed(() => requestJson(baseUrl, `/api/list?${query}`)));
  const warm = summarizeList(await timed(() => requestJson(baseUrl, `/api/list?${query}`)));
  const windowQuery = new URLSearchParams({
    path: fixture.path,
    includeSignature: "true",
    offset: "0",
    limit: String(budgets.windowLimit)
  });
  const warmWindow = summarizeList(await timed(() => requestJson(baseUrl, `/api/list?${windowQuery}`)));
  const indexBuild = summarizeIndexBuild(
    await timed(() =>
      requestJson(baseUrl, "/api/index/build", {
        method: "POST",
        body: JSON.stringify({
          path: fixture.path,
          wait: true,
          showHidden: true,
          includeDimensions: false,
          includeLinks: false
        })
      })
    )
  );
  const searchQuery = new URLSearchParams({ path: fixture.path, q: fixture.needle, limit: "10" });
  const indexSearch = summarizeSearch(await timed(() => requestJson(baseUrl, `/api/index/search?${searchQuery}`)));

  const warmScanAdvantage = Number(native.second?.scanned || 0) - Number(warm.scanned || 0);
  const searchScanAdvantage = Number(native.second?.scanned || 0) - Number(indexSearch.scanned || 0);
  return {
    count,
    fixture,
    native,
    app: {
      cold,
      warm,
      warmWindow,
      indexBuild,
      indexSearch
    },
    budgets,
    comparisons: {
      warmScanAdvantage,
      searchScanAdvantage,
      warmWallVsNativeSecondMs: rounded(Number(warm.wallMs || 0) - Number(native.second?.wallMs || 0)),
      indexedSearchVsNativeSecondMs: rounded(Number(indexSearch.wallMs || 0) - Number(native.second?.wallMs || 0))
    }
  };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${item.actual ?? ""} | ${item.budget ?? ""} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const cases = (report.cases || [])
    .map(
      (item) =>
        `- ${item.count.toLocaleString()} entries: native warm scanned ${item.native?.second?.scanned ?? "?"}; app warm scanned ${item.app?.warm?.scanned ?? "?"}; app window scanned ${item.app?.warmWindow?.scanned ?? "?"}; app indexed search scanned ${item.app?.indexSearch?.scanned ?? "?"}.`
    )
    .join("\n");
  return `# Windows Baseline Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

${cases}

| Status | Check | Actual | Budget | Detail |
| --- | --- | ---: | ---: | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const counts = parseCounts(optionValue("--counts", process.env.EB_WINDOWS_BASELINE_COUNTS || "1000,10000,100000"));
  const warmWallBudgetMs = Math.max(50, Number(optionValue("--warm-wall-ms", process.env.EB_WINDOWS_BASELINE_WARM_WALL_MS || "1500")));
  const warmWall100kBudgetMs = Math.max(
    warmWallBudgetMs,
    Number(optionValue("--warm-wall-100k-ms", process.env.EB_WINDOWS_BASELINE_WARM_WALL_100K_MS || "5000"))
  );
  const searchWallBudgetMs = Math.max(25, Number(optionValue("--search-wall-ms", process.env.EB_WINDOWS_BASELINE_SEARCH_WALL_MS || "750")));
  const buildWallBudgetMs = Math.max(100, Number(optionValue("--build-wall-ms", process.env.EB_WINDOWS_BASELINE_BUILD_WALL_MS || "8000")));
  const buildWall100kBudgetMs = Math.max(
    buildWallBudgetMs,
    Number(optionValue("--build-wall-100k-ms", process.env.EB_WINDOWS_BASELINE_BUILD_WALL_100K_MS || "45000"))
  );
  const windowWallBudgetMs = Math.max(25, Number(optionValue("--window-wall-ms", process.env.EB_WINDOWS_BASELINE_WINDOW_WALL_MS || "250")));
  const windowLimit = Math.max(1, Number(optionValue("--window-limit", process.env.EB_WINDOWS_BASELINE_WINDOW_LIMIT || "200")));
  const searchScannedBudget = Math.max(1, Number(optionValue("--search-scanned", process.env.EB_WINDOWS_BASELINE_SEARCH_SCANNED || "2")));
  const budgetsForCount = (count) => ({
    warmWallBudgetMs: count >= 100000 ? warmWall100kBudgetMs : warmWallBudgetMs,
    searchWallBudgetMs,
    buildWallBudgetMs: count >= 100000 ? buildWall100kBudgetMs : buildWallBudgetMs,
    searchScannedBudget,
    windowWallBudgetMs,
    windowLimit
  });
  await fs.mkdir(appData, { recursive: true });

  const cases = [];
  let server = null;
  let baseUrl = "";
  try {
    const started = await startServerWithRetries();
    server = started.server;
    baseUrl = started.baseUrl;
    for (const count of counts) {
      const caseBudgets = budgetsForCount(count);
      const result = await runCase(baseUrl, count, caseBudgets);
      cases.push(result);
      check(
        checks,
        `native-count-${count}`,
        Number(result.native?.first?.count || 0) === count && Number(result.native?.second?.count || 0) === count,
        `native=${result.native?.first?.count}/${result.native?.second?.count}; expected=${count}.`
      );
      check(checks, `app-cold-count-${count}`, Number(result.app.cold.returned || 0) === count, `${result.app.cold.returned}/${count} rows.`);
      check(
        checks,
        `app-warm-zero-scan-${count}`,
        result.app.warm.cache?.hit === true && Number(result.app.warm.scanned ?? Infinity) === 0,
        `hit=${result.app.warm.cache?.hit}; source=${result.app.warm.cache?.source || result.app.warm.source || "missing"}; scanned=${result.app.warm.scanned}.`
      );
      budgetCheck(checks, `app-warm-wall-${count}`, result.app.warm.wallMs, caseBudgets.warmWallBudgetMs, "Warm app list should avoid a full Windows-style directory walk.");
      check(
        checks,
        `app-window-count-${count}`,
        Number(result.app.warmWindow.returned || 0) === Math.min(caseBudgets.windowLimit, count) &&
          Number(result.app.warmWindow.totalEntries || 0) === count &&
          result.app.warmWindow.window?.hasMore === count > caseBudgets.windowLimit,
        `returned=${result.app.warmWindow.returned}; total=${result.app.warmWindow.totalEntries}; limit=${caseBudgets.windowLimit}; hasMore=${result.app.warmWindow.window?.hasMore}.`
      );
      check(
        checks,
        `app-window-zero-scan-${count}`,
        result.app.warmWindow.cache?.hit === true && Number(result.app.warmWindow.scanned ?? Infinity) === 0,
        `hit=${result.app.warmWindow.cache?.hit}; source=${result.app.warmWindow.cache?.source || result.app.warmWindow.source || "missing"}; scanned=${result.app.warmWindow.scanned}.`
      );
      budgetCheck(checks, `app-window-wall-${count}`, result.app.warmWindow.wallMs, caseBudgets.windowWallBudgetMs, "Windowed warm app list should return only the viewport slice.");
      budgetCheck(checks, `app-index-build-wall-${count}`, result.app.indexBuild.wallMs, caseBudgets.buildWallBudgetMs, "Active folder index build.");
      check(
        checks,
        `app-index-count-${count}`,
        Number(result.app.indexBuild.count || 0) >= count && Number(result.app.indexBuild.tokens || 0) >= count,
        `count=${result.app.indexBuild.count}; tokens=${result.app.indexBuild.tokens}; expected>=${count}.`
      );
      check(
        checks,
        `app-index-search-hit-${count}`,
        Number(result.app.indexSearch.returned || 0) === 1 && result.app.indexSearch.tokenNarrowed === true,
        `returned=${result.app.indexSearch.returned}; tokenNarrowed=${result.app.indexSearch.tokenNarrowed}.`
      );
      budgetCheck(checks, `app-index-search-scanned-${count}`, result.app.indexSearch.scanned, searchScannedBudget, "Indexed search candidate scans.");
      budgetCheck(checks, `app-index-search-wall-${count}`, result.app.indexSearch.wallMs, caseBudgets.searchWallBudgetMs, "Indexed search wall time.");
      check(
        checks,
        `scan-advantage-${count}`,
        result.comparisons.warmScanAdvantage >= count && result.comparisons.searchScanAdvantage >= count - searchScannedBudget,
        `nativeScanned=${result.native?.second?.scanned}; warmScanned=${result.app.warm.scanned}; searchScanned=${result.app.indexSearch.scanned}.`
      );
    }

    const summary = summaryFor(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      baseUrl,
      runRoot,
      counts,
      budgets: {
        warmWallBudgetMs,
        warmWall100kBudgetMs,
        searchWallBudgetMs,
        buildWallBudgetMs,
        buildWall100kBudgetMs,
        windowWallBudgetMs,
        windowLimit,
        searchScannedBudget
      },
      cases,
      checks,
      summary,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`windows baseline: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await safeRemoveRunRoot().catch(() => {});
    }
  }
}

main().catch(async (error) => {
  const checks = [{ id: "windows-baseline-error", status: "fail", detail: error.stack || error.message }];
  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport({ ...report, cases: [] })).catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
