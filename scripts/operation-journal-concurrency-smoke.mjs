import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-journal-concurrency-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const targetDir = path.join(fixtureRoot, "burst-target");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "operation-journal-concurrency-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-journal-concurrency-latest.md");
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
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_JOURNAL_CONCURRENCY_KEEP_FIXTURE === "1";
}

function statusCounts(checks) {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length
  };
}

function check(checks, id, ok, detail, extra = {}) {
  checks.push({ id, status: ok ? "pass" : "fail", detail, ...extra });
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
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
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
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

async function safeRemoveRunRoot() {
  const resolvedRunRoot = path.resolve(runRoot);
  const resolvedArtifacts = path.resolve(artifactsDir);
  if (!resolvedRunRoot.startsWith(`${resolvedArtifacts}${path.sep}`)) {
    throw new Error(`Refusing to remove run root outside artifacts: ${resolvedRunRoot}`);
  }
  await fs.rm(runRoot, { recursive: true, force: true });
}

async function seedState() {
  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
}

function summarizeOperation(operation) {
  return {
    id: operation.id,
    type: operation.type,
    status: operation.status,
    createdAt: operation.createdAt || null,
    startedAt: operation.startedAt || null,
    finishedAt: operation.finishedAt || null,
    progress: operation.progress || null,
    resultPath: operation.result?.path || null,
    cacheInvalidation: operation.result?.cacheInvalidation || null,
    backgroundIndexInvalidation: operation.result?.backgroundIndexInvalidation || null,
    undoType: operation.undo?.type || null
  };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Journal Concurrency Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

Burst: ${report.burst.count} concurrent create-file operation(s) in ${report.burst.wallMs} ms.
Journal rows: API ${report.journal.apiCount}, persisted ${report.journal.persistedCount}.
Created files: ${report.disk.createdCount}/${report.burst.count}.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await seedState();
  const checks = [];
  const burstCount = numberOption("--count", "EB_OPERATION_JOURNAL_CONCURRENCY_COUNT", 32);
  const port = Number(optionValue("--port", process.env.PORT || 56500 + Math.floor(Math.random() * 6000)));
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
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: burstCount }, (_, index) =>
        requestJson(baseUrl, "/api/file/create", {
          method: "POST",
          body: JSON.stringify({
            path: targetDir,
            name: `journal-burst-${String(index).padStart(3, "0")}.txt`,
            content: `operation journal concurrency ${index}\n`,
            conflictMode: "fail"
          })
        })
      )
    );
    const wallMs = Math.round((performance.now() - started) * 10) / 10;
    const operations = results.map((result) => result.operation);
    const ids = operations.map((operation) => operation.id);
    const uniqueIds = new Set(ids);
    const resultPaths = operations.map((operation) => operation.result?.path).filter(Boolean);
    const existingPaths = [];
    for (const filePath of resultPaths) {
      if (await pathExists(filePath)) existingPaths.push(filePath);
    }
    const apiState = await requestJson(baseUrl, "/api/state");
    const persistedState = JSON.parse(await fs.readFile(statePath, "utf8"));
    const apiOperations = Array.isArray(apiState.operations) ? apiState.operations : [];
    const persistedOperations = Array.isArray(persistedState.operations) ? persistedState.operations : [];
    const apiById = new Map(apiOperations.map((operation) => [operation.id, operation]));
    const persistedById = new Map(persistedOperations.map((operation) => [operation.id, operation]));
    const missingApiIds = ids.filter((id) => !apiById.has(id));
    const missingPersistedIds = ids.filter((id) => !persistedById.has(id));
    const incomplete = ids
      .map((id) => apiById.get(id))
      .filter((operation) => operation?.status !== "completed" || operation?.progress?.phase !== "Completed");
    const badUndo = ids.map((id) => apiById.get(id)).filter((operation) => operation?.undo?.type !== "trash-created");
    const missingCacheInvalidation = ids
      .map((id) => apiById.get(id))
      .filter((operation) => Number(operation?.result?.cacheInvalidation?.invalidated || 0) < 1);
    const missingBackgroundInvalidation = ids
      .map((id) => apiById.get(id))
      .filter((operation) => !operation?.result?.backgroundIndexInvalidation);

    check(checks, "burst-size", burstCount >= 24, `burst=${burstCount}.`);
    check(checks, "responses-completed", operations.length === burstCount && incomplete.length === 0, `responses=${operations.length}; incomplete=${incomplete.length}.`);
    check(checks, "operation-ids-unique", uniqueIds.size === burstCount, `unique=${uniqueIds.size}; expected=${burstCount}.`);
    check(checks, "disk-files-created", existingPaths.length === burstCount, `created=${existingPaths.length}; expected=${burstCount}.`);
    check(checks, "api-state-has-all-rows", missingApiIds.length === 0, missingApiIds.length ? missingApiIds.join(", ") : `${ids.length} row(s).`);
    check(
      checks,
      "persisted-state-has-all-rows",
      missingPersistedIds.length === 0,
      missingPersistedIds.length ? missingPersistedIds.join(", ") : `${ids.length} row(s).`
    );
    check(checks, "api-persisted-match", JSON.stringify(apiOperations) === JSON.stringify(persistedOperations), "API operations and persisted state.json match exactly.");
    check(checks, "journal-bound", apiOperations.length <= 100, `count=${apiOperations.length}.`);
    check(checks, "journal-no-loss", apiOperations.length >= burstCount, `count=${apiOperations.length}; burst=${burstCount}.`);
    check(checks, "undo-metadata-present", badUndo.length === 0, `missing undo rows=${badUndo.length}.`);
    check(
      checks,
      "cache-invalidation-recorded",
      missingCacheInvalidation.length === 0,
      `missing cache invalidation rows=${missingCacheInvalidation.length}.`
    );
    check(
      checks,
      "background-invalidation-recorded",
      missingBackgroundInvalidation.length === 0,
      `missing background invalidation rows=${missingBackgroundInvalidation.length}.`
    );
    check(
      checks,
      "latest-row-from-burst",
      ids.includes(apiOperations[0]?.id),
      `latest=${apiOperations[0]?.id || "missing"}.`
    );

    const summary = statusCounts(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: { targetDir },
      burst: {
        count: burstCount,
        wallMs,
        ids,
        uniqueIds: uniqueIds.size
      },
      journal: {
        apiCount: apiOperations.length,
        persistedCount: persistedOperations.length,
        missingApiIds,
        missingPersistedIds,
        latestId: apiOperations[0]?.id || null,
        persistedMatchesApi: JSON.stringify(apiOperations) === JSON.stringify(persistedOperations)
      },
      disk: {
        createdCount: existingPaths.length,
        paths: existingPaths.slice(0, 12)
      },
      operations: ids.map((id) => summarizeOperation(apiById.get(id))),
      checks,
      summary
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`operation journal concurrency: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`burst ${burstCount} create-file operation(s) in ${wallMs} ms; persisted rows ${persistedOperations.length}`);
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
  const checks = [{ id: "operation-journal-concurrency-error", status: "fail", detail: error.stack || error.message }];
  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    fixture: { targetDir },
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport({ ...report, burst: { count: 0, wallMs: 0 }, journal: {}, disk: {} }), "utf8").catch(() => {});
  console.error(serverOutput);
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
