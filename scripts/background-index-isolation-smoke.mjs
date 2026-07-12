import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-isolation-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const backgroundRoot = path.join(fixtureRoot, "background-heavy");
const foregroundRoot = path.join(fixtureRoot, "foreground-active");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "background-index-isolation-latest.json");
const latestMdPath = path.join(artifactsDir, "background-index-isolation-latest.md");
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
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_ISOLATION_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function timed(label, task) {
  const started = performance.now();
  const result = await task();
  return {
    label,
    wallMs: Math.round((performance.now() - started) * 10) / 10,
    result
  };
}

async function waitForServer(baseUrl, child) {
  const started = performance.now();
  while (performance.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}`);
}

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = performance.now();
  while (performance.now() - started < 45000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots?.find((item) => item.id === rootId);
    assert(root, "Background index root disappeared.");
    if (root.job?.status === "error") {
      throw new Error(root.job.error || "Background index failed.");
    }
    if (!root.job || root.job.status === "complete") {
      return root;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Background index did not complete in time.");
}

async function writeManyFiles(dir, count, factory) {
  await fs.mkdir(dir, { recursive: true });
  const batchSize = 256;
  for (let offset = 0; offset < count; offset += batchSize) {
    const files = [];
    for (let index = offset; index < Math.min(offset + batchSize, count); index += 1) {
      const { name, text } = factory(index);
      files.push(fs.writeFile(path.join(dir, name), text, "utf8"));
    }
    await Promise.all(files);
  }
}

async function prepareFixture(backgroundCount, foregroundCount) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  await writeManyFiles(backgroundRoot, backgroundCount, (index) => ({
    name: `background-content-${String(index).padStart(6, "0")}.txt`,
    text: `background load isolation target ${index}\nThis content is indexed to keep the background worker busy while foreground browsing stays responsive.\n`
  }));
  await writeManyFiles(foregroundRoot, foregroundCount, (index) => ({
    name: `foreground-target-${String(index).padStart(6, "0")}.txt`,
    text: `foreground active file ${index}\n`
  }));
  return {
    backgroundNeedle: `background load isolation target ${backgroundCount - 1}`,
    foregroundNeedle: `foreground-target-${String(foregroundCount - 1).padStart(6, "0")}`
  };
}

function percentile(values, rank) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function latencySummary(samples, key) {
  const values = samples.map((sample) => Number(sample[key])).filter((value) => Number.isFinite(value));
  return {
    count: values.length,
    minMs: values.length ? Math.round(Math.min(...values) * 10) / 10 : null,
    maxMs: values.length ? Math.round(Math.max(...values) * 10) / 10 : null,
    avgMs: values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null,
    p95Ms: percentile(values, 95)
  };
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function markdownReport(report) {
  const checkRows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Index Isolation Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${checkRows}

## Foreground Latency While Indexing

| Metric | P95 ms | Max ms | Budget ms |
| --- | ---: | ---: | ---: |
| List | ${report.latency.list.p95Ms} | ${report.latency.list.maxMs} | ${report.budgets.listP95Ms} |
| Search | ${report.latency.search.p95Ms} | ${report.latency.search.maxMs} | ${report.budgets.searchP95Ms} |

Background files: ${report.fixture.backgroundCount}
Foreground files: ${report.fixture.foregroundCount}
Samples while running: ${report.runningSamples}/${report.samples.length}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const backgroundCount = numberOption("--background-count", "EB_BACKGROUND_ISOLATION_BACKGROUND_COUNT", 8000);
  const foregroundCount = numberOption("--foreground-count", "EB_BACKGROUND_ISOLATION_FOREGROUND_COUNT", 1500);
  const sampleCount = numberOption("--samples", "EB_BACKGROUND_ISOLATION_SAMPLES", 8);
  const budgets = {
    listP95Ms: numberOption("--list-p95-ms", "EB_BACKGROUND_ISOLATION_LIST_P95_MS", 2500),
    listMaxMs: numberOption("--list-max-ms", "EB_BACKGROUND_ISOLATION_LIST_MAX_MS", 4000),
    searchP95Ms: numberOption("--search-p95-ms", "EB_BACKGROUND_ISOLATION_SEARCH_P95_MS", 2000),
    searchMaxMs: numberOption("--search-max-ms", "EB_BACKGROUND_ISOLATION_SEARCH_MAX_MS", 3500)
  };

  const fixture = await prepareFixture(backgroundCount, foregroundCount);
  await fs.mkdir(appData, { recursive: true });

  const port = Number(optionValue("--port", process.env.PORT || 53000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_CONTENT_INDEX_CONCURRENCY: "1"
    },
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
    const foregroundListRoute = `/api/list?path=${encodeURIComponent(foregroundRoot)}&includeSignature=true`;
    const foregroundSearchRoute = `/api/search?path=${encodeURIComponent(foregroundRoot)}&q=${encodeURIComponent(
      fixture.foregroundNeedle
    )}&limit=20`;

    const warmForeground = await requestJson(baseUrl, foregroundListRoute);
    assert((warmForeground.entries || []).length >= foregroundCount, "Foreground warm list should include every fixture file.");

    const started = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({
        path: backgroundRoot,
        recursive: true,
        includeDimensions: false,
        includeLinks: false,
        includeContent: true,
        maxContentBytes: 4096,
        maxContentFiles: backgroundCount,
        maxFolders: 4,
        maxEntries: backgroundCount + 32
      })
    });
    const rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
    assert(rootId, "Background index start should return a root id.");

    const samples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const beforeOverview = await requestJson(baseUrl, "/api/background-indexes");
      const beforeRoot = beforeOverview.roots?.find((item) => item.id === rootId);
      const runningBefore = beforeRoot?.job?.status === "running";
      const list = await timed("foreground-list", () => requestJson(baseUrl, foregroundListRoute));
      const search = await timed("foreground-search", () => requestJson(baseUrl, foregroundSearchRoute));
      const afterOverview = await requestJson(baseUrl, "/api/background-indexes");
      const afterRoot = afterOverview.roots?.find((item) => item.id === rootId);
      samples.push({
        index,
        runningBefore,
        runningAfter: afterRoot?.job?.status === "running",
        indexedEntries: Number(afterRoot?.job?.progress?.indexedEntries || afterRoot?.search?.count || 0),
        listWallMs: list.wallMs,
        listApiMs: Number(list.result?.timing?.totalMs || 0),
        listReturned: Number(list.result?.entries?.length || list.result?.returned || 0),
        searchWallMs: search.wallMs,
        searchReturned: Number(search.result?.entries?.length || search.result?.results?.length || search.result?.returned || 0)
      });
    }

    const completedRoot = await waitForBackgroundComplete(baseUrl, rootId);
    const backgroundSearch = await timed("background-content-search", () =>
      requestJson(
        baseUrl,
        `/api/background-indexes/search?${new URLSearchParams({ q: fixture.backgroundNeedle, rootId, limit: "20" })}`
      )
    );

    const runningSamples = samples.filter((sample) => sample.runningBefore || sample.runningAfter).length;
    const listLatency = latencySummary(samples, "listWallMs");
    const searchLatency = latencySummary(samples, "searchWallMs");
    const checks = [];
    check(checks, "foreground-sampled-while-running", runningSamples >= 1, `${runningSamples}/${samples.length} foreground sample(s) overlapped the running index job.`);
    check(checks, "foreground-list-complete", samples.every((sample) => sample.listReturned >= foregroundCount), `min returned=${Math.min(...samples.map((sample) => sample.listReturned))}.`);
    check(checks, "foreground-search-complete", samples.every((sample) => sample.searchReturned >= 1), `min returned=${Math.min(...samples.map((sample) => sample.searchReturned))}.`);
    check(checks, "foreground-list-p95-budget", Number(listLatency.p95Ms) <= budgets.listP95Ms, `p95=${listLatency.p95Ms}ms <= ${budgets.listP95Ms}ms.`);
    check(checks, "foreground-list-max-budget", Number(listLatency.maxMs) <= budgets.listMaxMs, `max=${listLatency.maxMs}ms <= ${budgets.listMaxMs}ms.`);
    check(checks, "foreground-search-p95-budget", Number(searchLatency.p95Ms) <= budgets.searchP95Ms, `p95=${searchLatency.p95Ms}ms <= ${budgets.searchP95Ms}ms.`);
    check(checks, "foreground-search-max-budget", Number(searchLatency.maxMs) <= budgets.searchMaxMs, `max=${searchLatency.maxMs}ms <= ${budgets.searchMaxMs}ms.`);
    check(checks, "background-index-completed", Number(completedRoot.search?.contentIndexed || completedRoot.lastStats?.contentIndexed || 0) >= backgroundCount, `content indexed=${completedRoot.search?.contentIndexed || completedRoot.lastStats?.contentIndexed || 0}.`);
    check(checks, "background-search-hit", Number(backgroundSearch.result?.results?.length || 0) >= 1, `${backgroundSearch.wallMs}ms / ${backgroundSearch.result?.results?.length || 0} result(s).`);

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      summary,
      fixture: {
        root: fixtureRoot,
        backgroundRoot,
        foregroundRoot,
        backgroundCount,
        foregroundCount
      },
      budgets,
      root: {
        id: completedRoot.id,
        path: completedRoot.path,
        search: completedRoot.search || completedRoot.lastStats || null
      },
      samples,
      runningSamples,
      latency: {
        list: listLatency,
        search: searchLatency
      },
      backgroundSearch: {
        wallMs: backgroundSearch.wallMs,
        returned: backgroundSearch.result?.results?.length || 0,
        timing: backgroundSearch.result?.timing || null
      },
      checks
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`background files: ${backgroundCount}`);
    console.log(`foreground files: ${foregroundCount}`);
    console.log(`running samples: ${runningSamples}/${samples.length}`);
    console.log(`foreground list p95/max: ${listLatency.p95Ms}/${listLatency.maxMs} ms`);
    console.log(`foreground search p95/max: ${searchLatency.p95Ms}/${searchLatency.maxMs} ms`);
    console.log(`background content search: ${backgroundSearch.wallMs} ms / ${backgroundSearch.result?.results?.length || 0} result(s)`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail) {
      process.exitCode = 1;
    }
  } finally {
    server.kill();
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
