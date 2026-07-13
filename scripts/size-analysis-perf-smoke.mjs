import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `size-analysis-perf-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "size-analysis-perf-latest.json");
const latestMdPath = path.join(artifactsDir, "size-analysis-perf-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function numberOption(name, envName, fallback) {
  const value = Number(optionValue(name, process.env[envName] || fallback));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function rounded(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SIZE_ANALYSIS_PERF_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function budgetCheck(checks, id, actual, budget, detail) {
  const numeric = Number(actual);
  checks.push({
    id,
    status: Number.isFinite(numeric) && numeric <= Number(budget) ? "pass" : "fail",
    actual: Number.isFinite(numeric) ? Math.round(numeric * 10) / 10 : null,
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

async function timed(task) {
  const started = performance.now();
  const result = await task();
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

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function safeRemoveRunRoot() {
  const resolvedRunRoot = path.resolve(runRoot);
  const resolvedArtifacts = path.resolve(artifactsDir);
  if (!resolvedRunRoot.startsWith(`${resolvedArtifacts}${path.sep}`)) {
    throw new Error(`Refusing to remove run root outside artifacts: ${resolvedRunRoot}`);
  }
  await fs.rm(resolvedRunRoot, { recursive: true, force: true });
}

async function writeSizedFile(filePath, bytes, fill) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(bytes, fill));
}

async function prepareFixture(count, folderCount) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const folders = [];
  for (let index = 0; index < folderCount; index += 1) {
    const folder = path.join(fixtureRoot, `bucket-${String(index).padStart(3, "0")}`);
    folders.push(folder);
    await fs.mkdir(folder, { recursive: true });
  }

  await writeSizedFile(path.join(folders[0], "largest-video-target.mkv"), 96 * 1024, 77);

  const extensions = [".mkv", ".mp4", ".jpg", ".zip", ".pdf", ".txt", ".js", ".dll"];
  const batchSize = 384;
  for (let offset = 1; offset < count; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(offset + batchSize, count); index += 1) {
      const folder = folders[index % folders.length];
      const extension = extensions[index % extensions.length];
      const size = 32 + (index % 4096);
      const fileName = `analysis-${String(index).padStart(6, "0")}${extension}`;
      writes.push(writeSizedFile(path.join(folder, fileName), size, 65 + (index % 26)));
    }
    await Promise.all(writes);
  }
  return { folders, expectedScanned: count + folderCount };
}

function summarizeAnalysis(timing) {
  const data = timing.result || {};
  return {
    wallMs: timing.wallMs,
    path: data.path,
    cache: data.cache || null,
    scanProvider: data.scanProvider || "",
    allocationProvider: data.allocationProvider || "",
    native: data.native || null,
    scanned: Number(data.scanned || 0),
    truncated: data.truncated === true,
    summary: data.summary || {},
    topFileNames: (data.topFiles || []).slice(0, 8).map((item) => item.name),
    extensions: (data.extensions || []).slice(0, 12).map((item) => ({
      extension: item.extension,
      category: item.category,
      files: item.files,
      size: item.size,
      allocated: item.allocated
    }))
  };
}

async function timedForegroundOperation(index, operation, fn) {
  const started = performance.now();
  try {
    const result = await fn();
    return {
      index,
      operation,
      ok: true,
      wallMs: rounded(performance.now() - started),
      ...result
    };
  } catch (error) {
    return {
      index,
      operation,
      ok: false,
      wallMs: rounded(performance.now() - started),
      error: error.message
    };
  }
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return rounded(sorted[index]);
}

function summarizeForegroundOperation(samples, operation) {
  const items = samples.filter((sample) => sample.operation === operation);
  const values = items.map((item) => Number(item.wallMs)).filter(Number.isFinite);
  const scannedValues = items.map((item) => Number(item.scanned)).filter(Number.isFinite);
  return {
    count: items.length,
    failures: items.filter((item) => !item.ok).length,
    minMs: values.length ? rounded(Math.min(...values)) : null,
    maxMs: values.length ? rounded(Math.max(...values)) : null,
    avgMs: values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    p95Ms: percentile(values, 0.95),
    minReturned: items.length ? Math.min(...items.map((item) => Number(item.returned || 0))) : 0,
    maxScanned: scannedValues.length ? Math.max(...scannedValues) : null
  };
}

async function analyze(baseUrl, body) {
  return summarizeAnalysis(
    await timed(() =>
      requestJson(baseUrl, "/api/size-analysis", {
        method: "POST",
        body: JSON.stringify(body)
      })
    )
  );
}

async function runAnalyzerIsolation(baseUrl, body, fixture, options = {}) {
  const operationCount = Math.max(6, Number(options.operationCount || 24));
  const concurrency = Math.max(1, Number(options.concurrency || 6));
  const foregroundRoot = fixture.folders[0];
  const expectedForegroundRows = (await fs.readdir(foregroundRoot)).length;
  const searchNeedle = "largest-video-target";
  const listRoute = `/api/list?${new URLSearchParams({ path: foregroundRoot, includeSignature: "true" })}`;
  const indexBuild = await timed(() =>
    requestJson(baseUrl, "/api/index/build", {
      method: "POST",
      body: JSON.stringify({
        path: foregroundRoot,
        wait: true,
        showHidden: true,
        includeDimensions: false,
        includeLinks: false
      })
    })
  );
  const searchRoute = `/api/index/search?${new URLSearchParams({ path: foregroundRoot, q: searchNeedle, limit: "20" })}`;
  const operations = ["list", "nameSearch", "roots"];
  const tasks = Array.from({ length: operationCount }, (_, index) => {
    const operation = operations[index % operations.length];
    return () =>
      timedForegroundOperation(index, operation, async () => {
        if (operation === "list") {
          const result = await requestJson(baseUrl, listRoute);
          return {
            returned: result.entries?.length || 0,
            source: result.source || result.timing?.source || "",
            apiMs: rounded(result.timing?.totalMs || 0)
          };
        }
        if (operation === "nameSearch") {
          const result = await requestJson(baseUrl, searchRoute);
          return {
            returned: result.entries?.length || result.results?.length || 0,
            scanned: result.scanned || result.timing?.scanned || 0,
            tokenNarrowed: result.timing?.tokenNarrowed === true,
            storeCacheHits: result.timing?.storeCacheHits || 0
          };
        }
        const result = await requestJson(baseUrl, "/api/roots");
        return {
          returned: Number(result.shortcuts?.length || 0) + Number(result.drives?.length || 0),
          cwd: result.cwd || ""
        };
      });
  });

  const started = performance.now();
  const analysisPromise = analyze(baseUrl, body);
  const [samples, analysis] = await Promise.all([runPool(tasks, concurrency), analysisPromise]);
  const wallMs = rounded(performance.now() - started);
  const foreground = Object.fromEntries(operations.map((operation) => [operation, summarizeForegroundOperation(samples, operation)]));
  return {
    wallMs,
    operationCount,
    concurrency,
    foregroundRoot,
    expectedForegroundRows,
    searchNeedle,
    indexBuild: {
      wallMs: indexBuild.wallMs,
      count: indexBuild.result?.index?.count || 0,
      tokenIndex: indexBuild.result?.index?.tokenIndex || null
    },
    analysis,
    foreground,
    failures: samples.filter((sample) => !sample.ok),
    samples: samples.map((sample) => ({
      index: sample.index,
      operation: sample.operation,
      ok: sample.ok,
      wallMs: sample.wallMs,
      returned: sample.returned ?? null,
      scanned: sample.scanned ?? null,
      tokenNarrowed: sample.tokenNarrowed === true,
      storeCacheHits: sample.storeCacheHits ?? null,
      source: sample.source || "",
      error: sample.error || null
    }))
  };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${item.actual ?? ""} | ${item.budget ?? ""} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const snapshots = report.snapshots || {};
  const cold = snapshots.cold || {};
  const warm = snapshots.warm || {};
  const afterMutation = snapshots.afterMutation || {};
  const herd = report.inFlightHerd || {};
  return `# Size Analysis Performance Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

Fixture: ${Number(report.fixture?.count || 0).toLocaleString()} files across ${Number(report.fixture?.folderCount || 0).toLocaleString()} folders.

In-flight herd: ${herd.joined ?? "n/a"} joined / ${herd.count ?? "n/a"} requests (${herd.wallMs ?? "n/a"} ms)
Cold scan: ${cold.wallMs ?? "n/a"} ms
Warm scan: ${warm.wallMs ?? "n/a"} ms (${warm.cache?.hit ? "cache hit" : "cache miss"})
Foreground during Analyzer: list p95=${report.isolation?.foreground?.list?.p95Ms ?? "n/a"} ms, search p95=${report.isolation?.foreground?.nameSearch?.p95Ms ?? "n/a"} ms, roots p95=${report.isolation?.foreground?.roots?.p95Ms ?? "n/a"} ms
After mutation: ${afterMutation.wallMs ?? "n/a"} ms (${afterMutation.cache?.hit ? "cache hit" : "cache miss"})

| Status | Check | Actual | Budget | Detail |
| --- | --- | ---: | ---: | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const count = numberOption("--count", "EB_SIZE_ANALYSIS_PERF_COUNT", 10000);
  const folderCount = numberOption("--folders", "EB_SIZE_ANALYSIS_PERF_FOLDERS", 80);
  const coldWallBudgetMs = numberOption("--cold-wall-ms", "EB_SIZE_ANALYSIS_PERF_COLD_WALL_MS", 2000);
  const warmWallBudgetMs = numberOption("--warm-wall-ms", "EB_SIZE_ANALYSIS_PERF_WARM_WALL_MS", 50);
  const afterMutationBudgetMs = numberOption("--after-mutation-wall-ms", "EB_SIZE_ANALYSIS_PERF_AFTER_MUTATION_WALL_MS", 2000);
  const herdCount = Math.max(2, numberOption("--herd-count", "EB_SIZE_ANALYSIS_PERF_HERD_COUNT", 6));
  const isolationOperationCount = Math.max(6, numberOption("--isolation-operations", "EB_SIZE_ANALYSIS_ISOLATION_OPERATIONS", 24));
  const isolationConcurrency = Math.max(1, numberOption("--isolation-concurrency", "EB_SIZE_ANALYSIS_ISOLATION_CONCURRENCY", 6));
  const isolationListP95BudgetMs = numberOption("--isolation-list-p95-ms", "EB_SIZE_ANALYSIS_ISOLATION_LIST_P95_MS", 1500);
  const isolationSearchP95BudgetMs = numberOption("--isolation-search-p95-ms", "EB_SIZE_ANALYSIS_ISOLATION_SEARCH_P95_MS", 2000);
  const isolationRootsP95BudgetMs = numberOption("--isolation-roots-p95-ms", "EB_SIZE_ANALYSIS_ISOLATION_ROOTS_P95_MS", 800);
  const isolationMaxBudgetMs = numberOption("--isolation-max-ms", "EB_SIZE_ANALYSIS_ISOLATION_MAX_MS", 4000);
  const isolationSearchScannedBudget = numberOption("--isolation-search-scanned", "EB_SIZE_ANALYSIS_ISOLATION_SEARCH_SCANNED", 5);
  const maxEntries = count + folderCount + 50;
  const fixture = await prepareFixture(count, folderCount);
  await fs.mkdir(appData, { recursive: true });

  const port = Number(optionValue("--port", process.env.PORT || 56500 + Math.floor(Math.random() * 4000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, server);
    const body = { path: fixtureRoot, maxEntries, maxDepth: 8, maxChildren: 96 };
    const herdStarted = performance.now();
    const herdResults = await Promise.all(Array.from({ length: herdCount }, () => analyze(baseUrl, body)));
    const herdWallMs = Math.round((performance.now() - herdStarted) * 10) / 10;
    const herdOriginScans = herdResults.filter((item) => item.cache?.source === "filesystem");
    const herdJoined = herdResults.filter((item) => item.cache?.source === "size-analysis-inflight");
    const herdCacheHits = herdResults.filter((item) => item.cache?.source === "size-analysis-cache");
    const cold = herdOriginScans[0] || herdResults.find((item) => item.cache?.hit !== true) || herdResults[0];
    const warm = await analyze(baseUrl, body);
    check(
      checks,
      "inflight-origin-scan-count",
      herdOriginScans.length === 1,
      `origins=${herdOriginScans.length}; sources=${herdResults.map((item) => item.cache?.source || "missing").join(", ")}.`
    );
    check(
      checks,
      "inflight-joined-count",
      herdJoined.length >= Math.max(1, herdCount - 1),
      `joined=${herdJoined.length}/${herdCount}; cacheHits=${herdCacheHits.length}.`
    );
    check(
      checks,
      "inflight-joined-source",
      herdJoined.every((item) => item.cache?.coalesced === true && item.cache?.originSource === "filesystem"),
      JSON.stringify(
        herdJoined.map((item) => ({
          source: item.cache?.source || null,
          coalesced: item.cache?.coalesced === true,
          originSource: item.cache?.originSource || null,
          waitMs: item.cache?.waitMs ?? null,
          joinedScanned: item.cache?.joinedScanned ?? null
        }))
      )
    );
    check(
      checks,
      "inflight-joined-zero-scan",
      herdJoined.every((item) => Number(item.cache?.joinedScanned || 0) === 0),
      JSON.stringify(herdJoined.map((item) => item.cache?.joinedScanned ?? null))
    );

    check(checks, "cold-files-count", Number(cold.summary.files || 0) === count, `${cold.summary.files || 0}/${count} files.`);
    check(checks, "cold-folder-count", Number(cold.summary.folders || 0) === folderCount, `${cold.summary.folders || 0}/${folderCount} folders.`);
    check(checks, "cold-scanned-count", cold.scanned === fixture.expectedScanned, `${cold.scanned}/${fixture.expectedScanned} entries scanned.`);
    if (process.platform === "win32") {
      check(
        checks,
        "cold-native-single-pass",
        cold.scanProvider === "native-go-helper-single-pass" &&
          cold.native?.singlePass === true &&
          cold.native?.wireFormat === "columns-v1",
        `provider=${cold.scanProvider || "missing"}; native=${JSON.stringify(cold.native || null)}.`
      );
      check(
        checks,
        "cold-native-entry-count",
        Number(cold.native?.scannedEntries || 0) === fixture.expectedScanned,
        `${cold.native?.scannedEntries || 0}/${fixture.expectedScanned} native entries.`
      );
    }
    check(checks, "cold-not-truncated", cold.truncated === false, `truncated=${cold.truncated}.`);
    check(checks, "cold-top-file", cold.topFileNames.includes("largest-video-target.mkv"), cold.topFileNames.join(", "));
    check(checks, "cold-extension-buckets", cold.extensions.length >= 8 && cold.extensions.some((item) => item.extension === ".mkv"), JSON.stringify(cold.extensions));
    check(
      checks,
      "cold-allocated-summary",
      Number(cold.summary.allocated || 0) >= Number(cold.summary.bytes || 0) &&
        cold.extensions.some((item) => item.extension === ".mkv" && Number(item.allocated || 0) >= Number(item.size || 0)),
      `summary=${cold.summary.allocated || 0}/${cold.summary.bytes || 0}; extensions=${JSON.stringify(cold.extensions.slice(0, 4))}.`
    );
    budgetCheck(checks, "cold-wall-budget", cold.wallMs, coldWallBudgetMs, `${count} file analyzer scan.`);

    check(checks, "warm-cache-hit", warm.cache?.hit === true, JSON.stringify(warm.cache || null));
    budgetCheck(checks, "warm-wall-budget", warm.wallMs, warmWallBudgetMs, "Repeat scan should return from Size Analyzer cache.");
    budgetCheck(
      checks,
      "warm-summary-elapsed-budget",
      warm.summary.elapsedMs,
      Math.max(50, warmWallBudgetMs),
      `summary.elapsedMs=${warm.summary.elapsedMs}`
    );
    check(
      checks,
      "warm-same-total",
      Number(warm.summary.bytes || 0) === Number(cold.summary.bytes || 0) && Number(warm.summary.files || 0) === Number(cold.summary.files || 0),
      `cold=${cold.summary.bytes}/${cold.summary.files}; warm=${warm.summary.bytes}/${warm.summary.files}.`
    );

    const cappedBody = { ...body, maxEntries: Math.max(100, Math.floor(count / 4)) };
    const cappedCold = await analyze(baseUrl, cappedBody);
    const cappedWarm = await analyze(baseUrl, cappedBody);
    check(
      checks,
      "capped-cold-truncated",
      cappedCold.truncated === true && cappedCold.cache?.hit !== true,
      `truncated=${cappedCold.truncated}; cache=${cappedCold.cache?.source || "missing"}.`
    );
    check(
      checks,
      "capped-warm-cache-hit",
      cappedWarm.cache?.hit === true && cappedWarm.cache?.source === "size-analysis-cache",
      JSON.stringify(cappedWarm.cache || null)
    );
    budgetCheck(checks, "capped-warm-wall-budget", cappedWarm.wallMs, warmWallBudgetMs, "Repeat capped scan should reuse the bounded report.");

    const isolation = await runAnalyzerIsolation(
      baseUrl,
      { ...body, maxDepth: 7, maxChildren: 95 },
      fixture,
      { count, operationCount: isolationOperationCount, concurrency: isolationConcurrency }
    );
    check(
      checks,
      "isolation-analysis-cold-files-count",
      isolation.analysis.cache?.hit !== true && Number(isolation.analysis.summary.files || 0) === count,
      `cache=${isolation.analysis.cache?.source || "missing"}; files=${isolation.analysis.summary.files || 0}/${count}.`
    );
    check(
      checks,
      "isolation-active-index-built",
      Number(isolation.indexBuild?.count || 0) >= isolation.expectedForegroundRows &&
        Number(isolation.indexBuild?.tokenIndex?.tokens || 0) >= isolation.expectedForegroundRows,
      `count=${isolation.indexBuild?.count || 0}/${isolation.expectedForegroundRows}; tokens=${isolation.indexBuild?.tokenIndex?.tokens || 0}; build=${isolation.indexBuild?.wallMs ?? "?"}ms.`
    );
    check(
      checks,
      "isolation-foreground-clean",
      isolation.failures.length === 0,
      `${isolation.failures.length} failed foreground request(s) across ${isolation.operationCount}.`
    );
    check(
      checks,
      "isolation-list-complete",
      Number(isolation.foreground.list?.minReturned || 0) >= isolation.expectedForegroundRows,
      `min=${isolation.foreground.list?.minReturned || 0}; expected=${isolation.expectedForegroundRows}.`
    );
    check(
      checks,
      "isolation-search-hit",
      Number(isolation.foreground.nameSearch?.minReturned || 0) >= 1,
      `min=${isolation.foreground.nameSearch?.minReturned || 0}; needle=${isolation.searchNeedle}.`
    );
    budgetCheck(
      checks,
      "isolation-search-scanned-budget",
      isolation.foreground.nameSearch?.maxScanned,
      isolationSearchScannedBudget,
      `Indexed foreground search candidate scan while Analyzer scanned ${count} files.`
    );
    check(
      checks,
      "isolation-roots-returned",
      Number(isolation.foreground.roots?.minReturned || 0) >= 1,
      `min=${isolation.foreground.roots?.minReturned || 0}.`
    );
    budgetCheck(
      checks,
      "isolation-list-p95-budget",
      isolation.foreground.list?.p95Ms,
      isolationListP95BudgetMs,
      `Foreground list p95 while Analyzer scanned ${count} files.`
    );
    budgetCheck(
      checks,
      "isolation-search-p95-budget",
      isolation.foreground.nameSearch?.p95Ms,
      isolationSearchP95BudgetMs,
      `Foreground search p95 while Analyzer scanned ${count} files.`
    );
    budgetCheck(
      checks,
      "isolation-roots-p95-budget",
      isolation.foreground.roots?.p95Ms,
      isolationRootsP95BudgetMs,
      `Roots p95 while Analyzer scanned ${count} files.`
    );
    budgetCheck(
      checks,
      "isolation-list-max-budget",
      isolation.foreground.list?.maxMs,
      isolationMaxBudgetMs,
      `Foreground list max while Analyzer scanned ${count} files.`
    );
    budgetCheck(
      checks,
      "isolation-search-max-budget",
      isolation.foreground.nameSearch?.maxMs,
      isolationMaxBudgetMs,
      `Foreground search max while Analyzer scanned ${count} files.`
    );

    const create = await requestJson(baseUrl, "/api/file/create", {
      method: "POST",
      body: JSON.stringify({
        path: fixture.folders[0],
        name: "mutation-new-heavy-target.mkv",
        content: "z".repeat(128 * 1024)
      })
    });
    const afterMutation = await analyze(baseUrl, { ...body, maxEntries: maxEntries + 2 });
    const postMutationWarm = await analyze(baseUrl, { ...body, maxEntries: maxEntries + 2 });

    const sizeInvalidation = create.operation?.result?.cacheInvalidation?.sizeAnalysisInvalidation;
    check(
      checks,
      "operation-invalidates-size-analysis-cache",
      Number(sizeInvalidation?.invalidated || 0) >= 1,
      JSON.stringify(sizeInvalidation || null)
    );
    check(checks, "after-mutation-cache-miss", afterMutation.cache?.hit !== true, JSON.stringify(afterMutation.cache || null));
    check(
      checks,
      "after-mutation-new-file-counted",
      Number(afterMutation.summary.files || 0) === count + 1 && afterMutation.topFileNames.includes("mutation-new-heavy-target.mkv"),
      `${afterMutation.summary.files || 0}/${count + 1}; top=${afterMutation.topFileNames.join(", ")}.`
    );
    budgetCheck(checks, "after-mutation-wall-budget", afterMutation.wallMs, afterMutationBudgetMs, "Fresh scan after operation invalidation.");
    check(checks, "post-mutation-warm-cache-hit", postMutationWarm.cache?.hit === true, JSON.stringify(postMutationWarm.cache || null));
    budgetCheck(checks, "post-mutation-warm-wall-budget", postMutationWarm.wallMs, warmWallBudgetMs, "Repeat scan after rewarming cache.");

    const summary = summaryFor(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: {
        root: fixtureRoot,
        count,
        folderCount,
        expectedScanned: fixture.expectedScanned
      },
      budgets: {
        coldWallBudgetMs,
        warmWallBudgetMs,
        afterMutationBudgetMs,
        herdCount,
        isolationOperationCount,
        isolationConcurrency,
        isolationListP95BudgetMs,
        isolationSearchP95BudgetMs,
        isolationRootsP95BudgetMs,
        isolationMaxBudgetMs,
        isolationSearchScannedBudget
      },
      inFlightHerd: {
        count: herdCount,
        wallMs: herdWallMs,
        origins: herdOriginScans.length,
        joined: herdJoined.length,
        cacheHits: herdCacheHits.length,
        sources: herdResults.map((item) => item.cache?.source || "missing"),
        originWallMs: herdOriginScans[0]?.wallMs ?? null,
        originScanned: herdOriginScans[0]?.scanned ?? null,
        joinedWallMs: herdJoined.map((item) => item.wallMs),
        joinedWaitMs: herdJoined.map((item) => item.cache?.waitMs ?? null),
        joinedScanned: herdJoined.map((item) => item.cache?.joinedScanned ?? null)
      },
      createOperation: {
        id: create.operation?.id || null,
        status: create.operation?.status || null,
        cacheInvalidation: create.operation?.result?.cacheInvalidation || null
      },
      snapshots: {
        cold,
        warm,
        cappedCold,
        cappedWarm,
        afterMutation,
        postMutationWarm
      },
      isolation,
      checks,
      summary,
      serverOutput: serverOutput.slice(-4000)
    };

    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`size analysis performance: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
  const checks = [{ id: "size-analysis-perf-error", status: "fail", detail: error.stack || error.message }];
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
  await fs.writeFile(latestMdPath, markdownReport({ ...report, fixture: { count: 0, folderCount: 0 }, snapshots: {} })).catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
