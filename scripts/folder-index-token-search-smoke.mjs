import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `folder-index-token-search-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "folder-index-token-search-latest.json");
const latestMdPath = path.join(artifactsDir, "folder-index-token-search-latest.md");
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
  return process.argv.includes("--keep-fixture") || process.env.EB_FOLDER_TOKEN_SEARCH_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
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

async function prepareFixture(count) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const batchSize = 512;
  for (let offset = 0; offset < count; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(offset + batchSize, count); index += 1) {
      const name = `active-token-target-${String(index).padStart(6, "0")}.txt`;
      writes.push(fs.writeFile(path.join(fixtureRoot, name), `active folder token search fixture ${index}\n`, "utf8"));
    }
    await Promise.all(writes);
  }
  await fs.writeFile(
    path.join(fixtureRoot, ".fixture-ready.json"),
    JSON.stringify({ count, generatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Folder Index Token Search Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

Fixture files: ${report.fixture.count}
Query: \`${report.search.query}\`
First wall: ${report.search.wallMs} ms
Repeat wall: ${report.repeatSearch.wallMs} ms
First scanned candidates: ${report.search.timing.scanned}
Repeat scanned candidates: ${report.repeatSearch.timing.scanned}
Repeat store cache hits: ${report.repeatSearch.timing.storeCacheHits}

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const count = numberOption("--count", "EB_FOLDER_TOKEN_SEARCH_COUNT", 20000);
  const scannedBudget = numberOption("--scanned-budget", "EB_FOLDER_TOKEN_SEARCH_SCANNED_BUDGET", 5);
  const firstWallBudgetMs = numberOption("--first-wall-ms", "EB_FOLDER_TOKEN_SEARCH_FIRST_WALL_MS", 1200);
  const repeatWallBudgetMs = numberOption("--repeat-wall-ms", "EB_FOLDER_TOKEN_SEARCH_REPEAT_WALL_MS", 250);
  await prepareFixture(count);
  await fs.mkdir(appData, { recursive: true });

  const port = Number(optionValue("--port", process.env.PORT || 58100 + Math.floor(Math.random() * 5000)));
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
    const build = await timed(() =>
      requestJson(baseUrl, "/api/index/build", {
        method: "POST",
        body: JSON.stringify({
          path: fixtureRoot,
          wait: true,
          showHidden: true,
          includeDimensions: false,
          includeLinks: false
        })
      })
    );
    const query = `active-token-target-${String(count - 1).padStart(6, "0")}`;
    const targetPath = path.join(fixtureRoot, `${query}.txt`);
    const route = `/api/index/search?${new URLSearchParams({ path: fixtureRoot, q: query, limit: "20" })}`;
    const search = await timed(() => requestJson(baseUrl, route));
    const repeatSearch = await timed(() => requestJson(baseUrl, route));
    const result = search.result;
    const repeatResult = repeatSearch.result;
    const timing = result.timing || {};
    const repeatTiming = repeatResult.timing || {};
    const tokenIndex = build.result.index?.tokenIndex || null;
    const hit = (result.results || []).some((item) => item.path === targetPath);
    const repeatHit = (repeatResult.results || []).some((item) => item.path === targetPath);

    check(checks, "folder-token-index-built", Number(tokenIndex?.tokens || 0) >= count, `tokens=${tokenIndex?.tokens || 0}; postings=${tokenIndex?.postings || 0}.`);
    check(checks, "folder-token-search-hit", hit, `returned=${result.results?.length || 0}; target=${targetPath}.`);
    check(checks, "folder-token-search-narrowed", timing.tokenNarrowed === true, `narrowed=${timing.tokenNarrowed}; strategy=${timing.tokenStrategy}; reason=${timing.tokenReason}.`);
    check(checks, "folder-token-search-scanned-budget", Number(timing.scanned || 0) <= scannedBudget, `scanned=${timing.scanned || 0}; budget=${scannedBudget}.`);
    check(checks, "folder-token-search-first-wall-budget", Number(search.wallMs || 0) <= firstWallBudgetMs, `wall=${search.wallMs} ms; budget=${firstWallBudgetMs} ms.`);
    check(checks, "folder-index-first-cache-hit", Number(timing.storeCacheHits || 0) >= 1, `hits=${timing.storeCacheHits || 0}; misses=${timing.storeCacheMisses || 0}.`);
    check(checks, "folder-index-repeat-cache-hit", Number(repeatTiming.storeCacheHits || 0) >= 1, `hits=${repeatTiming.storeCacheHits || 0}; misses=${repeatTiming.storeCacheMisses || 0}.`);
    check(checks, "folder-token-repeat-search-hit", repeatHit, `returned=${repeatResult.results?.length || 0}; target=${targetPath}.`);
    check(checks, "folder-token-repeat-scanned-budget", Number(repeatTiming.scanned || 0) <= scannedBudget, `scanned=${repeatTiming.scanned || 0}; budget=${scannedBudget}.`);
    check(checks, "folder-token-repeat-wall-budget", Number(repeatSearch.wallMs || 0) <= repeatWallBudgetMs, `wall=${repeatSearch.wallMs} ms; budget=${repeatWallBudgetMs} ms.`);

    const summary = summaryFor(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: { root: fixtureRoot, count, targetPath },
      budgets: { scannedBudget, firstWallBudgetMs, repeatWallBudgetMs },
      build: {
        wallMs: build.wallMs,
        index: build.result.index
      },
      search: {
        query,
        wallMs: search.wallMs,
        returned: result.results?.length || 0,
        hit,
        timing
      },
      repeatSearch: {
        wallMs: repeatSearch.wallMs,
        returned: repeatResult.results?.length || 0,
        hit: repeatHit,
        timing: repeatTiming
      },
      checks,
      summary
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`folder token search: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`scanned ${timing.scanned || 0} candidate(s) for ${count} active-indexed file(s)`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch(async (error) => {
  const checks = [{ id: "folder-token-search-error", status: "fail", detail: error.stack || error.message }];
  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    fixture: { root: fixtureRoot },
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
