import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-concurrency-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "background-index-concurrency-latest.json");
const latestMdPath = path.join(artifactsDir, "background-index-concurrency-latest.md");
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

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_INDEX_CONCURRENCY_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail, data = {}) {
  checks.push({ id, status: ok ? "pass" : "fail", detail, ...data });
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
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function timed(task) {
  const started = performance.now();
  const result = await task();
  return {
    wallMs: Math.round((performance.now() - started) * 10) / 10,
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

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = performance.now();
  while (performance.now() - started < 45000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots?.find((item) => item.id === rootId);
    if (!root) throw new Error("Background index root disappeared.");
    if (root.job?.status === "error") throw new Error(root.job.error || "Background index failed.");
    if (!root.job || root.job.status === "complete") return root;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Background index did not complete in time.");
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

function startServer(port) {
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

async function prepareFixture(count) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const batchSize = 512;
  for (let offset = 0; offset < count; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(offset + batchSize, count); index += 1) {
      const name = `burst-token-target-${String(index).padStart(6, "0")}.txt`;
      writes.push(fs.writeFile(path.join(fixtureRoot, name), `background burst token fixture ${index}\n`, "utf8"));
    }
    await Promise.all(writes);
  }
}

function searchCacheSource(result) {
  return result?.freshness?.roots?.[0]?.read?.searchCache?.source || "";
}

function searchCacheHit(result) {
  return result?.freshness?.roots?.[0]?.read?.searchCache?.hit === true;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${item.actual ?? ""} | ${item.budget ?? ""} | ${String(item.detail || "").replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Index Concurrency Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

Fixture files: ${report.fixture.count}
Herd: ${report.herd.joined}/${report.herd.count} joined, ${report.herd.wallMs} ms.
Warm repeat: ${report.warm.wallMs} ms.

| Status | Check | Actual | Budget | Detail |
| --- | --- | ---: | ---: | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const checks = [];
  const count = numberOption("--count", "EB_BACKGROUND_INDEX_CONCURRENCY_COUNT", 20000);
  const herdCount = Math.max(2, numberOption("--herd-count", "EB_BACKGROUND_INDEX_CONCURRENCY_HERD_COUNT", 8));
  const scannedBudget = numberOption("--scanned-budget", "EB_BACKGROUND_INDEX_CONCURRENCY_SCANNED_BUDGET", 5);
  const herdWallBudgetMs = numberOption("--herd-wall-ms", "EB_BACKGROUND_INDEX_CONCURRENCY_HERD_WALL_MS", 2500);
  const warmWallBudgetMs = numberOption("--warm-wall-ms", "EB_BACKGROUND_INDEX_CONCURRENCY_WARM_WALL_MS", 250);
  await prepareFixture(count);

  const port = Number(optionValue("--port", process.env.PORT || 59400 + Math.floor(Math.random() * 4000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = startServer(port);
  try {
    await waitForServer(baseUrl, server);
    const started = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({
        path: fixtureRoot,
        recursive: true,
        includeDimensions: false,
        includeLinks: false,
        includeContent: false,
        maxFolders: 4,
        maxEntries: count + 32
      })
    });
    const rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
    if (!rootId) throw new Error("Background index start did not return a root id.");
    const root = await waitForBackgroundComplete(baseUrl, rootId);
    await stopServer(server);
    server = null;

    serverOutput = "";
    server = startServer(port);
    await waitForServer(baseUrl, server);

    const query = `burst-token-target-${String(count - 1).padStart(6, "0")}`;
    const targetPath = path.join(fixtureRoot, `${query}.txt`);
    const searchRoute = `/api/background-indexes/search?${new URLSearchParams({ q: query, rootId, limit: "20" })}`;
    const herdStarted = performance.now();
    const herdResponses = await Promise.all(Array.from({ length: herdCount }, () => timed(() => requestJson(baseUrl, searchRoute))));
    const herdWallMs = Math.round((performance.now() - herdStarted) * 10) / 10;
    const herdResults = herdResponses.map((item) => ({
      wallMs: item.wallMs,
      hit: (item.result.results || []).some((result) => result.path === targetPath),
      returned: item.result.results?.length || 0,
      timing: item.result.timing || {},
      source: searchCacheSource(item.result),
      cacheHit: searchCacheHit(item.result)
    }));
    const origins = herdResults.filter((item) => item.source === "background-search-store-file" || item.timing.storeCacheMisses > 0);
    const joined = herdResults.filter((item) => item.source === "background-search-store-inflight");
    const cacheHits = herdResults.filter((item) => item.source === "background-search-store-cache");
    const warm = await timed(() => requestJson(baseUrl, searchRoute));
    const warmResult = {
      wallMs: warm.wallMs,
      hit: (warm.result.results || []).some((result) => result.path === targetPath),
      returned: warm.result.results?.length || 0,
      timing: warm.result.timing || {},
      source: searchCacheSource(warm.result),
      cacheHit: searchCacheHit(warm.result)
    };

    check(checks, "background-index-built", Number(root.search?.count || 0) >= count, `count=${root.search?.count || 0}/${count}; tokens=${root.search?.tokenIndex?.tokens || 0}.`);
    check(checks, "herd-all-hit", herdResults.every((item) => item.hit), `${herdResults.filter((item) => item.hit).length}/${herdCount} search response(s) hit target.`);
    check(checks, "herd-single-origin", origins.length === 1, `origins=${origins.length}; sources=${herdResults.map((item) => item.source || "missing").join(", ")}.`);
    check(checks, "herd-joined-inflight", joined.length >= Math.max(1, herdCount - 1), `joined=${joined.length}/${herdCount}; cacheHits=${cacheHits.length}.`);
    check(checks, "herd-scanned-budget", herdResults.every((item) => Number(item.timing.scanned || 0) <= scannedBudget), JSON.stringify(herdResults.map((item) => item.timing.scanned || 0)));
    check(checks, "herd-store-cache-classification", joined.every((item) => item.cacheHit === true) && origins.every((item) => item.cacheHit !== true), `joinedHits=${joined.filter((item) => item.cacheHit).length}; originHits=${origins.filter((item) => item.cacheHit).length}.`);
    budgetCheck(checks, "herd-wall-budget", herdWallMs, herdWallBudgetMs, `${herdCount} concurrent first searches after backend restart.`);
    check(checks, "warm-cache-hit", warmResult.hit && warmResult.source === "background-search-store-cache" && warmResult.cacheHit === true, `source=${warmResult.source}; hit=${warmResult.hit}.`);
    budgetCheck(checks, "warm-wall-budget", warmResult.wallMs, warmWallBudgetMs, "Post-herd warm background index search.");

    const summary = summaryFor(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: {
        root: fixtureRoot,
        count,
        targetPath
      },
      budgets: {
        scannedBudget,
        herdWallBudgetMs,
        warmWallBudgetMs
      },
      root: {
        id: root.id,
        path: root.path,
        search: root.search
      },
      herd: {
        count: herdCount,
        wallMs: herdWallMs,
        origins: origins.length,
        joined: joined.length,
        cacheHits: cacheHits.length,
        sources: herdResults.map((item) => item.source || "missing"),
        scanned: herdResults.map((item) => item.timing.scanned ?? null),
        wallTimes: herdResults.map((item) => item.wallMs),
        returned: herdResults.map((item) => item.returned)
      },
      warm: warmResult,
      checks,
      summary,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`background index concurrency: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`herd joined ${joined.length}/${herdCount}, wall ${herdWallMs} ms`);
    console.log(`warm search ${warmResult.wallMs} ms from ${warmResult.source}`);
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
  const checks = [{ id: "background-index-concurrency-error", status: "fail", detail: error.stack || error.message }];
  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    fixture: { root: fixtureRoot, count: 0 },
    herd: { count: 0, joined: 0, wallMs: null },
    warm: {},
    checks,
    summary,
    serverOutput: serverOutput.slice(-4000)
  };
  await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report)).catch(() => {});
  console.error(error.stack || error.message);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
