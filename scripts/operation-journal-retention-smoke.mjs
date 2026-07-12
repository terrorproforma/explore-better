import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-journal-retention-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "operation-journal-retention-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-journal-retention-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_JOURNAL_RETENTION_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) {
    throw new Error(`${id}: ${detail}`);
  }
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
  while (Date.now() - started < 10000) {
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

function completedOperation(id, createdAt) {
  return {
    id,
    type: "copy",
    label: `Completed historical copy ${id}`,
    status: "completed",
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    result: { copied: 1 },
    error: null,
    undo: null,
    progress: { unit: "items", total: 1, completed: 1, phase: "Completed", updatedAt: createdAt },
    retry: null,
    retryOf: null
  };
}

function recoverableFailedOperation(id, createdAt, sourcePath, targetDir) {
  return {
    id,
    type: "copy",
    label: "Very old failed copy with remaining work",
    status: "failed",
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    result: {
      recovery: {
        type: "copy",
        targetDir,
        completedCount: 0,
        remainingCount: 1,
        completed: [],
        failed: { index: 0, path: sourcePath, name: path.basename(sourcePath) },
        remaining: [{ index: 0, path: sourcePath, name: path.basename(sourcePath) }],
        retry: {
          type: "copy",
          body: {
            paths: [sourcePath],
            targetDir
          }
        },
        canRetryRemaining: true,
        interrupted: false
      }
    },
    error: "Seeded old recoverable failure.",
    undo: null,
    progress: { unit: "items", total: 1, completed: 0, phase: "Failed", updatedAt: createdAt },
    retry: {
      type: "copy",
      body: {
        paths: [sourcePath],
        targetDir
      },
      createdAt
    },
    retryOf: null
  };
}

async function seedState(seedCount) {
  const sourceDir = path.join(fixtureRoot, "source");
  const targetDir = path.join(fixtureRoot, "target");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "important-recovery.txt");
  await fs.writeFile(sourcePath, "this recoverable operation must survive journal trimming\n", "utf8");
  await fs.mkdir(stateDir, { recursive: true });
  const now = Date.now();
  const operations = [];
  for (let index = 0; index < seedCount; index += 1) {
    const id = `history-${String(index).padStart(3, "0")}`;
    const createdAt = new Date(now - index * 1000).toISOString();
    operations.push(completedOperation(id, createdAt));
  }
  const protectedIndex = Math.max(120, Math.min(seedCount - 2, 150));
  const oldDisposableId = `history-${String(seedCount - 1).padStart(3, "0")}`;
  operations[protectedIndex] = recoverableFailedOperation("old-recoverable-copy", new Date(now - protectedIndex * 1000).toISOString(), sourcePath, targetDir);
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        operations
      },
      null,
      2
    ),
    "utf8"
  );
  return { operations, sourcePath, targetDir, protectedIndex, oldDisposableId };
}

function byId(state, id) {
  return (state.operations || []).find((operation) => operation.id === id) || null;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Journal Retention Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Seeded operations: ${report.seeded.count}
Protected seed index: ${report.seeded.protectedIndex}
Startup retained count: ${report.afterStartup.count}
After retry retained count: ${report.afterRetry.count}
Retry operation: ${report.retry.operationId}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const seedCount = Number(optionValue("--seed-count", process.env.EB_OPERATION_JOURNAL_RETENTION_SEED_COUNT || "160"));
  const fixture = await seedState(Number.isFinite(seedCount) && seedCount > 130 ? seedCount : 160);
  const checks = [];
  const port = Number(optionValue("--port", process.env.PORT || 47800 + Math.floor(Math.random() * 2000)));
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

  let startupState = null;
  let retry = null;
  let afterRetryState = null;
  try {
    await waitForServer(baseUrl, server);
    startupState = await requestJson(baseUrl, "/api/state");
    const persistedStartup = JSON.parse(await fs.readFile(statePath, "utf8"));
    const protectedStartup = byId(startupState, "old-recoverable-copy");

    check(checks, "oversized-history-seeded", fixture.operations.length > 100, `seeded=${fixture.operations.length}.`);
    check(checks, "startup-still-bounded", startupState.operations?.length === 100, `count=${startupState.operations?.length || 0}.`);
    check(checks, "protected-old-recovery-retained", protectedStartup?.result?.recovery?.canRetryRemaining === true, `present=${Boolean(protectedStartup)}.`);
    check(checks, "disposable-old-history-dropped", byId(startupState, fixture.oldDisposableId) === null, `${fixture.oldDisposableId} dropped.`);
    check(checks, "startup-persisted-bounded", persistedStartup.operations?.length === 100 && byId(persistedStartup, "old-recoverable-copy"), `persisted=${persistedStartup.operations?.length || 0}.`);

    retry = await requestJson(baseUrl, "/api/operation/retry-remaining", {
      method: "POST",
      body: JSON.stringify({ operationId: "old-recoverable-copy" })
    });
    afterRetryState = await requestJson(baseUrl, "/api/state");
    const persistedAfterRetry = JSON.parse(await fs.readFile(statePath, "utf8"));
    const copiedPath = path.join(fixture.targetDir, path.basename(fixture.sourcePath));
    const protectedAfterRetry = byId(afterRetryState, "old-recoverable-copy");

    check(checks, "old-recovery-retry-completed", retry.operation?.status === "completed" && retry.operation?.retryOf === "old-recoverable-copy", `status=${retry.operation?.status}; retryOf=${retry.operation?.retryOf}.`);
    check(checks, "old-recovery-copied-file", await pathExists(copiedPath), `copied=${copiedPath}.`);
    check(checks, "protected-row-retained-after-retry", Boolean(protectedAfterRetry), `present=${Boolean(protectedAfterRetry)}.`);
    check(
      checks,
      "protected-row-linked-to-retry",
      protectedAfterRetry?.result?.recovery?.lastRetryOperationId === retry.operation?.id,
      `lastRetry=${protectedAfterRetry?.result?.recovery?.lastRetryOperationId || "missing"}.`
    );
    check(checks, "after-retry-still-bounded", afterRetryState.operations?.length === 100 && persistedAfterRetry.operations?.length === 100, `api=${afterRetryState.operations?.length || 0}; persisted=${persistedAfterRetry.operations?.length || 0}.`);
    check(checks, "retry-operation-first", afterRetryState.operations?.[0]?.id === retry.operation?.id, `first=${afterRetryState.operations?.[0]?.id || "missing"}.`);
    check(checks, "api-persisted-match", JSON.stringify(afterRetryState.operations) === JSON.stringify(persistedAfterRetry.operations), "API and persisted operations match after protected retry.");

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      summary,
      runRoot,
      fixtureRoot,
      seeded: {
        count: fixture.operations.length,
        protectedIndex: fixture.protectedIndex,
        oldDisposableId: fixture.oldDisposableId
      },
      afterStartup: {
        count: startupState.operations?.length || 0,
        firstId: startupState.operations?.[0]?.id || null,
        protectedPresent: Boolean(protectedStartup),
        protectedRecovery: protectedStartup?.result?.recovery || null
      },
      retry: {
        operationId: retry.operation?.id || null,
        retryOf: retry.operation?.retryOf || null,
        status: retry.operation?.status || null,
        copiedPath
      },
      afterRetry: {
        count: afterRetryState.operations?.length || 0,
        firstId: afterRetryState.operations?.[0]?.id || null,
        protectedPresent: Boolean(byId(afterRetryState, "old-recoverable-copy")),
        protectedLastRetryOperationId: byId(afterRetryState, "old-recoverable-copy")?.result?.recovery?.lastRetryOperationId || null
      },
      checks,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`operation journal retention: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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

main().catch((error) => {
  console.error(serverOutput);
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
