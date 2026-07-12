import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `size-analysis-cancel-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "size-analysis-cancel-latest.json");
const latestMdPath = path.join(artifactsDir, "size-analysis-cancel-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function numberOption(name, envName, fallback) {
  const value = Number(optionValue(name, process.env[envName] || String(fallback)));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function rounded(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SIZE_ANALYSIS_CANCEL_KEEP_FIXTURE === "1";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
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
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
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
      await delay(120);
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
    const folder = path.join(fixtureRoot, `cancel-bucket-${String(index).padStart(3, "0")}`);
    folders.push(folder);
    await fs.mkdir(folder, { recursive: true });
  }

  await writeSizedFile(path.join(folders[0], "cancel-largest-target.iso"), 128 * 1024, 90);
  const extensions = [".iso", ".mkv", ".zip", ".jpg", ".dll", ".log", ".txt", ".bin"];
  const batchSize = 384;
  for (let offset = 1; offset < count; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(offset + batchSize, count); index += 1) {
      const folder = folders[index % folders.length];
      const extension = extensions[index % extensions.length];
      const size = 64 + (index % 2048);
      const fileName = `cancel-analysis-${String(index).padStart(6, "0")}${extension}`;
      writes.push(writeSizedFile(path.join(folder, fileName), size, 65 + (index % 26)));
    }
    await Promise.all(writes);
  }

  return {
    root: fixtureRoot,
    folders,
    count,
    folderCount,
    expectedScanned: count + folderCount
  };
}

async function analyzerFetch(baseUrl, body, options = {}) {
  const started = performance.now();
  try {
    const result = await requestJson(baseUrl, "/api/size-analysis", {
      method: "POST",
      body: JSON.stringify(body),
      signal: options.signal
    });
    return {
      ok: true,
      aborted: false,
      wallMs: rounded(performance.now() - started),
      result
    };
  } catch (error) {
    return {
      ok: false,
      aborted: error.name === "AbortError" || error.code === "ABORT_ERR" || /aborted/i.test(error.message || ""),
      wallMs: rounded(performance.now() - started),
      error: error.message,
      status: error.status || null
    };
  }
}

function summarizeAnalyzer(response) {
  const result = response?.result || {};
  return {
    ok: response?.ok === true,
    aborted: response?.aborted === true,
    wallMs: response?.wallMs ?? null,
    error: response?.error || null,
    status: response?.status || null,
    cache: result.cache || null,
    scanned: Number(result.scanned || 0),
    summary: result.summary || {},
    truncated: result.truncated === true,
    topFiles: (result.topFiles || []).slice(0, 8).map((item) => item.name),
    extensions: (result.extensions || []).slice(0, 8).map((item) => ({
      extension: item.extension,
      size: item.size,
      allocated: item.allocated,
      category: item.category
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

function summarizeForeground(samples, operation) {
  const items = samples.filter((sample) => sample.operation === operation);
  const values = items.map((item) => Number(item.wallMs)).filter(Number.isFinite);
  return {
    count: items.length,
    failures: items.filter((item) => !item.ok).length,
    minMs: values.length ? rounded(Math.min(...values)) : null,
    maxMs: values.length ? rounded(Math.max(...values)) : null,
    p95Ms: percentile(values, 0.95),
    minReturned: items.length ? Math.min(...items.map((item) => Number(item.returned || 0))) : 0
  };
}

async function runForegroundAfterAbort(baseUrl, fixture, operationCount, concurrency) {
  const listRoot = fixture.folders[0];
  const expectedListRows = (await fs.readdir(listRoot)).length;
  const listRoute = `/api/list?${new URLSearchParams({ path: listRoot, includeSignature: "true" })}`;
  const operations = ["list", "roots"];
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
        const result = await requestJson(baseUrl, "/api/roots");
        return {
          returned: Number(result.shortcuts?.length || 0) + Number(result.drives?.length || 0),
          cwd: result.cwd || ""
        };
      });
  });
  const samples = await runPool(tasks, concurrency);
  return {
    operationCount,
    concurrency,
    listRoot,
    expectedListRows,
    failures: samples.filter((sample) => !sample.ok),
    list: summarizeForeground(samples, "list"),
    roots: summarizeForeground(samples, "roots"),
    samples
  };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${item.actual ?? ""} | ${item.budget ?? ""} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Size Analysis Cancellation Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

Fixture: ${Number(report.fixture?.count || 0).toLocaleString()} files across ${Number(report.fixture?.folderCount || 0).toLocaleString()} folders.
Origin abort: ${report.origin?.aborted ? "aborted" : "not aborted"} in ${report.origin?.wallMs ?? "n/a"} ms
Follower: ${report.follower?.ok ? "completed" : "failed"} in ${report.follower?.wallMs ?? "n/a"} ms, cache=${report.follower?.cache?.source || "missing"}, restartedAfterAbort=${report.follower?.cache?.restartedAfterAbortedInFlight || 0}
Foreground after abort: list p95=${report.foreground?.list?.p95Ms ?? "n/a"} ms, roots p95=${report.foreground?.roots?.p95Ms ?? "n/a"} ms

| Status | Check | Actual | Budget | Detail |
| --- | --- | ---: | ---: | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const count = numberOption("--count", "EB_SIZE_ANALYSIS_CANCEL_COUNT", 12000);
  const folderCount = numberOption("--folders", "EB_SIZE_ANALYSIS_CANCEL_FOLDERS", 96);
  const joinDelayMs = numberOption("--join-delay-ms", "EB_SIZE_ANALYSIS_CANCEL_JOIN_DELAY_MS", 25);
  const abortDelayMs = numberOption("--abort-delay-ms", "EB_SIZE_ANALYSIS_CANCEL_ABORT_DELAY_MS", 35);
  const abortBudgetMs = numberOption("--abort-budget-ms", "EB_SIZE_ANALYSIS_CANCEL_ABORT_BUDGET_MS", 2500);
  const followerBudgetMs = numberOption("--follower-budget-ms", "EB_SIZE_ANALYSIS_CANCEL_FOLLOWER_BUDGET_MS", 15000);
  const warmBudgetMs = numberOption("--warm-budget-ms", "EB_SIZE_ANALYSIS_CANCEL_WARM_BUDGET_MS", 250);
  const foregroundOperationCount = Math.max(4, numberOption("--foreground-operations", "EB_SIZE_ANALYSIS_CANCEL_FOREGROUND_OPERATIONS", 16));
  const foregroundConcurrency = Math.max(1, numberOption("--foreground-concurrency", "EB_SIZE_ANALYSIS_CANCEL_FOREGROUND_CONCURRENCY", 4));
  const foregroundListBudgetMs = numberOption("--foreground-list-p95-ms", "EB_SIZE_ANALYSIS_CANCEL_LIST_P95_MS", 1500);
  const foregroundRootsBudgetMs = numberOption("--foreground-roots-p95-ms", "EB_SIZE_ANALYSIS_CANCEL_ROOTS_P95_MS", 800);
  const fixture = await prepareFixture(count, folderCount);
  await fs.mkdir(appData, { recursive: true });

  const port = Number(optionValue("--port", process.env.PORT || 60500 + Math.floor(Math.random() * 3000)));
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

  let origin = null;
  let follower = null;
  let warm = null;
  let foreground = null;
  try {
    await waitForServer(baseUrl, server);
    const body = {
      path: fixtureRoot,
      maxEntries: fixture.expectedScanned + 20,
      maxDepth: 8,
      maxChildren: 96
    };

    const controller = new AbortController();
    const originPromise = analyzerFetch(baseUrl, body, { signal: controller.signal });
    await delay(joinDelayMs);
    const followerPromise = analyzerFetch(baseUrl, body);
    await delay(abortDelayMs);
    controller.abort();
    origin = summarizeAnalyzer(await originPromise);
    foreground = await runForegroundAfterAbort(baseUrl, fixture, foregroundOperationCount, foregroundConcurrency);
    follower = summarizeAnalyzer(await followerPromise);
    warm = summarizeAnalyzer(await analyzerFetch(baseUrl, body));

    check(checks, "origin-request-aborted", origin.aborted === true, `origin ok=${origin.ok}; error=${origin.error || "none"}; wall=${origin.wallMs}ms.`);
    budgetCheck(checks, "origin-abort-wall-budget", origin.wallMs, abortBudgetMs, "Aborted Analyzer request should release promptly.");
    check(
      checks,
      "follower-completes-after-origin-abort",
      follower.ok === true,
      `follower ok=${follower.ok}; error=${follower.error || "none"}; cache=${follower.cache?.source || "missing"}.`
    );
    check(
      checks,
      "follower-restarted-aborted-inflight",
      Number(follower.cache?.restartedAfterAbortedInFlight || 0) >= 1 && follower.cache?.source === "filesystem",
      JSON.stringify(follower.cache || null)
    );
    check(
      checks,
      "follower-scanned-complete-fixture",
      follower.scanned === fixture.expectedScanned &&
        Number(follower.summary.files || 0) === fixture.count &&
        Number(follower.summary.folders || 0) === fixture.folderCount &&
        follower.truncated === false,
      `scanned=${follower.scanned}/${fixture.expectedScanned}; files=${follower.summary.files || 0}/${fixture.count}; folders=${follower.summary.folders || 0}/${fixture.folderCount}; truncated=${follower.truncated}.`
    );
    check(checks, "follower-largest-file", follower.topFiles.includes("cancel-largest-target.iso"), follower.topFiles.join(", "));
    check(
      checks,
      "follower-allocated-summary",
      Number(follower.summary.allocated || 0) >= Number(follower.summary.bytes || 0) &&
        follower.extensions.some((item) => item.extension === ".iso" && Number(item.allocated || 0) >= Number(item.size || 0)),
      `summary=${follower.summary.allocated || 0}/${follower.summary.bytes || 0}; extensions=${JSON.stringify(follower.extensions.slice(0, 4))}.`
    );
    budgetCheck(checks, "follower-wall-budget", follower.wallMs, followerBudgetMs, "Recovered Analyzer scan after origin abort.");
    check(checks, "warm-cache-after-recovered-scan", warm.cache?.hit === true && warm.cache?.source === "size-analysis-cache", JSON.stringify(warm.cache || null));
    budgetCheck(checks, "warm-wall-budget", warm.wallMs, warmBudgetMs, "Repeat scan after recovered cancellation should be cached.");
    check(
      checks,
      "foreground-after-abort-clean",
      foreground.failures.length === 0,
      `${foreground.failures.length} failed foreground request(s) across ${foreground.operationCount}.`
    );
    check(
      checks,
      "foreground-after-abort-list-complete",
      Number(foreground.list?.minReturned || 0) >= foreground.expectedListRows,
      `min=${foreground.list?.minReturned || 0}; expected=${foreground.expectedListRows}.`
    );
    check(checks, "foreground-after-abort-roots-returned", Number(foreground.roots?.minReturned || 0) >= 1, `min=${foreground.roots?.minReturned || 0}.`);
    budgetCheck(checks, "foreground-after-abort-list-p95-budget", foreground.list?.p95Ms, foregroundListBudgetMs, "List requests after abort while recovered scan continues.");
    budgetCheck(checks, "foreground-after-abort-roots-p95-budget", foreground.roots?.p95Ms, foregroundRootsBudgetMs, "Roots requests after abort while recovered scan continues.");
    check(checks, "server-alive-after-cancel", server.exitCode === null, `exitCode=${server.exitCode ?? "running"}.`);

    const summary = summaryFor(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: {
        root: fixtureRoot,
        count: fixture.count,
        folderCount: fixture.folderCount,
        expectedScanned: fixture.expectedScanned
      },
      budgets: {
        joinDelayMs,
        abortDelayMs,
        abortBudgetMs,
        followerBudgetMs,
        warmBudgetMs,
        foregroundOperationCount,
        foregroundConcurrency,
        foregroundListBudgetMs,
        foregroundRootsBudgetMs
      },
      origin,
      follower,
      warm,
      foreground,
      checks,
      summary,
      serverOutput: serverOutput.slice(-4000)
    };

    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`size analysis cancellation: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
  const checks = [{ id: "size-analysis-cancel-error", status: "fail", detail: error.stack || error.message }];
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
  await fs.writeFile(latestMdPath, markdownReport({ ...report, fixture: { count: 0, folderCount: 0 } })).catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
