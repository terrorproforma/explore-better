import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `mixed-load-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "mixed-load-latest.json");
const latestMdPath = path.join(artifactsDir, "mixed-load-latest.md");
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
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_MIXED_LOAD_KEEP_FIXTURE === "1";
}

function rounded(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function requestRaw(baseUrl, filePath) {
  const response = await fetch(`${baseUrl}/api/raw?${new URLSearchParams({ path: filePath })}`);
  const bytes = response.status === 304 ? 0 : (await response.arrayBuffer()).byteLength;
  if (!response.ok && response.status !== 304) {
    throw new Error(`Raw request failed: ${response.status}`);
  }
  return {
    status: response.status,
    bytes,
    contentType: response.headers.get("content-type") || "",
    cacheControl: response.headers.get("cache-control") || ""
  };
}

async function waitForServer(baseUrl, child) {
  const started = performance.now();
  let lastError = null;
  while (performance.now() - started < 15_000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}.\n${serverOutput}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Server did not start in time: ${lastError?.message || "unknown"}`);
}

async function writeManyFiles(dir, count) {
  await fs.mkdir(dir, { recursive: true });
  const width = String(Math.max(0, count - 1)).length;
  const files = [];
  const batchSize = 200;
  for (let start = 0; start < count; start += batchSize) {
    const batch = [];
    for (let index = start; index < Math.min(start + batchSize, count); index += 1) {
      const padded = String(index).padStart(width, "0");
      const filePath = path.join(dir, `mixed-target-${padded}.txt`);
      const content =
        index === count - 1
          ? `mixed load name target ${padded}\nunique mixed content needle ${padded}\n`
          : `mixed load name target ${padded}\nordinary foreground storm content ${index}\n`;
      files.push(filePath);
      batch.push(fs.writeFile(filePath, content, "utf8"));
    }
    await Promise.all(batch);
  }
  return {
    files,
    nameNeedle: `mixed-target-${String(Math.max(0, count - 1)).padStart(width, "0")}`,
    contentNeedle: `unique mixed content needle ${String(Math.max(0, count - 1)).padStart(width, "0")}`
  };
}

async function timedOperation(index, operation, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    return {
      index,
      operation,
      ok: true,
      wallMs: rounded(performance.now() - start),
      ...result
    };
  } catch (error) {
    return {
      index,
      operation,
      ok: false,
      wallMs: rounded(performance.now() - start),
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
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return rounded(sorted[index]);
}

function summarizeOperation(samples, operation) {
  const items = samples.filter((sample) => sample.operation === operation);
  const values = items.map((item) => Number(item.wallMs)).filter(Number.isFinite);
  return {
    count: items.length,
    failures: items.filter((item) => !item.ok).length,
    minMs: rounded(Math.min(...values)),
    maxMs: rounded(Math.max(...values)),
    avgMs: rounded(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
    p95Ms: percentile(values, 0.95),
    minReturned: Math.min(...items.map((item) => Number(item.returned || 0))),
    minBytes: Math.min(...items.map((item) => Number(item.bytes || 0)))
  };
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function markdownReport(report) {
  const checkRows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const operationRows = Object.entries(report.operations)
    .map(
      ([name, stats]) =>
        `| ${name} | ${stats.count} | ${stats.p95Ms} | ${stats.maxMs} | ${stats.failures} |`
    )
    .join("\n");
  return `# Mixed Foreground Load Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${checkRows}

## Operation Latency

| Operation | Count | P95 ms | Max ms | Failures |
| --- | ---: | ---: | ---: | ---: |
${operationRows}

Fixture files: ${report.fixture.fileCount}
Operations: ${report.workload.operationCount}
Concurrency: ${report.workload.concurrency}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fileCount = numberOption("--file-count", "EB_MIXED_LOAD_FILE_COUNT", 2500);
  const concurrency = numberOption("--concurrency", "EB_MIXED_LOAD_CONCURRENCY", 8);
  const rounds = numberOption("--rounds", "EB_MIXED_LOAD_ROUNDS", 8);
  const budgets = {
    listP95Ms: numberOption("--list-p95-ms", "EB_MIXED_LOAD_LIST_P95_MS", 1500),
    listMaxMs: numberOption("--list-max-ms", "EB_MIXED_LOAD_LIST_MAX_MS", 3000),
    nameSearchP95Ms: numberOption("--name-search-p95-ms", "EB_MIXED_LOAD_NAME_SEARCH_P95_MS", 1500),
    nameSearchMaxMs: numberOption("--name-search-max-ms", "EB_MIXED_LOAD_NAME_SEARCH_MAX_MS", 3000),
    contentSearchP95Ms: numberOption("--content-search-p95-ms", "EB_MIXED_LOAD_CONTENT_SEARCH_P95_MS", 4500),
    contentSearchMaxMs: numberOption("--content-search-max-ms", "EB_MIXED_LOAD_CONTENT_SEARCH_MAX_MS", 7000),
    rawP95Ms: numberOption("--raw-p95-ms", "EB_MIXED_LOAD_RAW_P95_MS", 1000),
    rawMaxMs: numberOption("--raw-max-ms", "EB_MIXED_LOAD_RAW_MAX_MS", 2000),
    rootsP95Ms: numberOption("--roots-p95-ms", "EB_MIXED_LOAD_ROOTS_P95_MS", 800),
    rootsMaxMs: numberOption("--roots-max-ms", "EB_MIXED_LOAD_ROOTS_MAX_MS", 1600)
  };

  const fixture = await writeManyFiles(fixtureRoot, fileCount);
  await fs.mkdir(appData, { recursive: true });
  const port = Number(optionValue("--port", process.env.PORT || 54000 + Math.floor(Math.random() * 9000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
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
    const listRoute = `/api/list?${new URLSearchParams({ path: fixtureRoot, includeSignature: "true" })}`;
    const nameSearchRoute = `/api/search?${new URLSearchParams({ path: fixtureRoot, q: fixture.nameNeedle, limit: "20" })}`;
    const rawTargets = fixture.files.slice(Math.max(0, fixture.files.length - 8));

    const warmList = await requestJson(baseUrl, listRoute);
    assert((warmList.entries || []).length >= fileCount, "Warm list should include every fixture file.");

    const operationCycle = ["list", "nameSearch", "roots", "raw", "list", "contentSearch", "raw", "nameSearch"];
    const tasks = [];
    for (let round = 0; round < rounds; round += 1) {
      for (const operation of operationCycle) {
        const index = tasks.length;
        tasks.push(() =>
          timedOperation(index, operation, async () => {
            if (operation === "list") {
              const result = await requestJson(baseUrl, listRoute);
              return {
                returned: result.entries?.length || 0,
                apiMs: rounded(result.timing?.totalMs || 0),
                source: result.source || result.timing?.source || ""
              };
            }
            if (operation === "nameSearch") {
              const result = await requestJson(baseUrl, nameSearchRoute);
              return {
                returned: result.entries?.length || result.results?.length || 0,
                scanned: result.scanned || result.timing?.scanned || 0
              };
            }
            if (operation === "contentSearch") {
              const result = await requestJson(baseUrl, "/api/search", {
                method: "POST",
                body: JSON.stringify({
                  path: fixtureRoot,
                  content: fixture.contentNeedle,
                  limit: 20,
                  maxScanned: fileCount + 32,
                  maxContentBytes: 4096
                })
              });
              return {
                returned: result.entries?.length || result.results?.length || 0,
                scanned: result.scanned || 0,
                contentScanned: result.contentScanned || 0
              };
            }
            if (operation === "raw") {
              const result = await requestRaw(baseUrl, rawTargets[index % rawTargets.length]);
              return {
                bytes: result.bytes,
                status: result.status,
                contentType: result.contentType
              };
            }
            const result = await requestJson(baseUrl, "/api/roots");
            return {
              returned: Number(result.shortcuts?.length || 0) + Number(result.drives?.length || 0),
              cwd: result.cwd || ""
            };
          })
        );
      }
    }

    const samples = await runPool(tasks, concurrency);
    const operations = Object.fromEntries(
      operationCycle.filter((item, index, array) => array.indexOf(item) === index).map((operation) => [
        operation,
        summarizeOperation(samples, operation)
      ])
    );
    const checks = [];
    const failures = samples.filter((sample) => !sample.ok);
    check(checks, "all-requests-clean", failures.length === 0, `${failures.length} failed request(s) across ${samples.length}.`);
    check(checks, "list-results-complete", operations.list.minReturned >= fileCount, `min returned=${operations.list.minReturned}.`);
    check(checks, "name-search-hit", operations.nameSearch.minReturned >= 1, `min returned=${operations.nameSearch.minReturned}.`);
    check(checks, "content-search-hit", operations.contentSearch.minReturned >= 1, `min returned=${operations.contentSearch.minReturned}.`);
    check(checks, "raw-bytes-returned", operations.raw.minBytes > 0, `min bytes=${operations.raw.minBytes}.`);
    check(checks, "roots-returned", operations.roots.minReturned >= 1, `min returned=${operations.roots.minReturned}.`);
    check(checks, "list-p95-budget", Number(operations.list.p95Ms) <= budgets.listP95Ms, `p95=${operations.list.p95Ms}ms <= ${budgets.listP95Ms}ms.`);
    check(checks, "list-max-budget", Number(operations.list.maxMs) <= budgets.listMaxMs, `max=${operations.list.maxMs}ms <= ${budgets.listMaxMs}ms.`);
    check(
      checks,
      "name-search-p95-budget",
      Number(operations.nameSearch.p95Ms) <= budgets.nameSearchP95Ms,
      `p95=${operations.nameSearch.p95Ms}ms <= ${budgets.nameSearchP95Ms}ms.`
    );
    check(
      checks,
      "name-search-max-budget",
      Number(operations.nameSearch.maxMs) <= budgets.nameSearchMaxMs,
      `max=${operations.nameSearch.maxMs}ms <= ${budgets.nameSearchMaxMs}ms.`
    );
    check(
      checks,
      "content-search-p95-budget",
      Number(operations.contentSearch.p95Ms) <= budgets.contentSearchP95Ms,
      `p95=${operations.contentSearch.p95Ms}ms <= ${budgets.contentSearchP95Ms}ms.`
    );
    check(
      checks,
      "content-search-max-budget",
      Number(operations.contentSearch.maxMs) <= budgets.contentSearchMaxMs,
      `max=${operations.contentSearch.maxMs}ms <= ${budgets.contentSearchMaxMs}ms.`
    );
    check(checks, "raw-p95-budget", Number(operations.raw.p95Ms) <= budgets.rawP95Ms, `p95=${operations.raw.p95Ms}ms <= ${budgets.rawP95Ms}ms.`);
    check(checks, "raw-max-budget", Number(operations.raw.maxMs) <= budgets.rawMaxMs, `max=${operations.raw.maxMs}ms <= ${budgets.rawMaxMs}ms.`);
    check(checks, "roots-p95-budget", Number(operations.roots.p95Ms) <= budgets.rootsP95Ms, `p95=${operations.roots.p95Ms}ms <= ${budgets.rootsP95Ms}ms.`);
    check(checks, "roots-max-budget", Number(operations.roots.maxMs) <= budgets.rootsMaxMs, `max=${operations.roots.maxMs}ms <= ${budgets.rootsMaxMs}ms.`);

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
        fileCount,
        kept: keepFixture()
      },
      workload: {
        concurrency,
        rounds,
        operationCount: samples.length,
        operationCycle
      },
      budgets,
      operations,
      samples,
      checks
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`fixture files: ${fileCount}`);
    console.log(`operations: ${samples.length} at concurrency ${concurrency}`);
    console.log(`list p95/max: ${operations.list.p95Ms}/${operations.list.maxMs} ms`);
    console.log(`name search p95/max: ${operations.nameSearch.p95Ms}/${operations.nameSearch.maxMs} ms`);
    console.log(`content search p95/max: ${operations.contentSearch.p95Ms}/${operations.contentSearch.maxMs} ms`);
    console.log(`raw p95/max: ${operations.raw.p95Ms}/${operations.raw.maxMs} ms`);
    console.log(`roots p95/max: ${operations.roots.p95Ms}/${operations.roots.maxMs} ms`);
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
