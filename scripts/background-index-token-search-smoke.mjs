import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-token-search-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "background-index-token-search-latest.json");
const latestMdPath = path.join(artifactsDir, "background-index-token-search-latest.md");
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
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_TOKEN_SEARCH_KEEP_FIXTURE === "1";
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

async function prepareFixture(count) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const marker = path.join(fixtureRoot, ".fixture-ready.json");
  const batchSize = 512;
  for (let offset = 0; offset < count; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(offset + batchSize, count); index += 1) {
      const name = `token-target-${String(index).padStart(6, "0")}.txt`;
      writes.push(fs.writeFile(path.join(fixtureRoot, name), `token search fixture ${index}\n`, "utf8"));
    }
    await Promise.all(writes);
  }
  await fs.writeFile(marker, JSON.stringify({ count, generatedAt: new Date().toISOString() }, null, 2), "utf8");
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Index Token Search Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

Fixture files: ${report.fixture.count}
Query: \`${report.search.query}\`
Wall: ${report.search.wallMs} ms
Scanned candidates: ${report.search.timing.scanned}
Token narrowed stores: ${report.search.timing.tokenNarrowedStores}
Store cache hits: ${report.search.timing.storeCacheHits}

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const count = numberOption("--count", "EB_BACKGROUND_TOKEN_SEARCH_COUNT", 20000);
  const scannedBudget = numberOption("--scanned-budget", "EB_BACKGROUND_TOKEN_SEARCH_SCANNED_BUDGET", 5);
  const wallBudgetMs = numberOption("--wall-ms", "EB_BACKGROUND_TOKEN_SEARCH_WALL_MS", 1200);
  await prepareFixture(count);
  await fs.mkdir(appData, { recursive: true });

  const port = Number(optionValue("--port", process.env.PORT || 58900 + Math.floor(Math.random() * 5000)));
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
    const query = `token-target-${String(count - 1).padStart(6, "0")}`;
    const targetPath = path.join(fixtureRoot, `${query}.txt`);
    const search = await timed(() =>
      requestJson(baseUrl, `/api/background-indexes/search?${new URLSearchParams({ q: query, rootId, limit: "20" })}`)
    );
    const repeatSearch = await timed(() =>
      requestJson(baseUrl, `/api/background-indexes/search?${new URLSearchParams({ q: query, rootId, limit: "20" })}`)
    );
    const result = search.result;
    const repeatResult = repeatSearch.result;
    const timing = result.timing || {};
    const repeatTiming = repeatResult.timing || {};
    const tokenIndex = root.search?.tokenIndex || null;
    const hit = (result.results || []).some((item) => item.path === targetPath);
    const repeatHit = (repeatResult.results || []).some((item) => item.path === targetPath);
    check(checks, "token-index-built", Number(tokenIndex?.tokens || 0) >= count, `tokens=${tokenIndex?.tokens || 0}; postings=${tokenIndex?.postings || 0}.`);
    check(checks, "token-search-hit", hit, `returned=${result.results?.length || 0}; target=${targetPath}.`);
    check(checks, "token-search-narrowed", Number(timing.tokenNarrowedStores || 0) >= 1, `tokenNarrowedStores=${timing.tokenNarrowedStores || 0}.`);
    check(checks, "token-search-scanned-budget", Number(timing.scanned || 0) <= scannedBudget, `scanned=${timing.scanned || 0}; budget=${scannedBudget}.`);
    check(checks, "token-search-wall-budget", Number(search.wallMs || 0) <= wallBudgetMs, `wall=${search.wallMs} ms; budget=${wallBudgetMs} ms.`);
    check(checks, "token-search-store-cache-hit", Number(timing.storeCacheHits || 0) >= 1, `hits=${timing.storeCacheHits || 0}; misses=${timing.storeCacheMisses || 0}.`);
    check(checks, "repeat-token-search-cache-hit", repeatHit && Number(repeatTiming.storeCacheHits || 0) >= 1 && Number(repeatTiming.scanned || 0) <= scannedBudget, `hit=${repeatHit}; hits=${repeatTiming.storeCacheHits || 0}; scanned=${repeatTiming.scanned || 0}.`);

    const summary = summaryFor(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: { root: fixtureRoot, count, targetPath },
      budgets: { scannedBudget, wallBudgetMs },
      root: {
        id: root.id,
        path: root.path,
        search: root.search
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
    console.log(`background token search: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`scanned ${timing.scanned || 0} candidate(s) for ${count} indexed file(s)`);
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
  const checks = [{ id: "background-token-search-error", status: "fail", detail: error.stack || error.message }];
  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    fixture: { root: fixtureRoot, count: 0 },
    search: { query: "", wallMs: null, timing: {} },
    checks,
    summary,
    serverOutput
  };
  await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
