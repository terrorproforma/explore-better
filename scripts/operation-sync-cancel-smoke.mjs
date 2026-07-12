import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-sync-cancel-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const leftDir = path.join(fixtureRoot, "left");
const rightDir = path.join(fixtureRoot, "right");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "operation-sync-cancel-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-sync-cancel-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_SYNC_CANCEL_KEEP_FIXTURE === "1";
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

function operationById(state, id) {
  return (state.operations || []).find((operation) => operation.id === id) || null;
}

async function waitForOperation(baseUrl, predicate, timeoutMs = 15000) {
  const started = performance.now();
  let lastState = null;
  while (performance.now() - started < timeoutMs) {
    const state = await requestJson(baseUrl, "/api/state");
    lastState = state;
    const operation = (state.operations || []).find(predicate);
    if (operation) {
      return { state, operation };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for operation. Last operations: ${JSON.stringify(lastState?.operations?.slice?.(0, 5) || [])}`);
}

async function prepareFixture(count) {
  await fs.mkdir(leftDir, { recursive: true });
  await fs.mkdir(rightDir, { recursive: true });
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const relativePath = `sync-cancel-${String(index).padStart(2, "0")}.txt`;
    await fs.writeFile(path.join(leftDir, relativePath), `left sync source ${index}\n`, "utf8");
    items.push(relativePath);
  }
  return { items };
}

async function listRightNames() {
  try {
    return (await fs.readdir(rightDir)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function rightContentMatches(items) {
  const checks = [];
  for (const [index, relativePath] of items.entries()) {
    const itemPath = path.join(rightDir, relativePath);
    const expected = `left sync source ${index}\n`;
    const actual = (await pathExists(itemPath)) ? await fs.readFile(itemPath, "utf8") : "";
    checks.push(actual === expected);
  }
  return checks;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Sync Cancel Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Canceled sync operation: ${report.cancel.operationId}
Retry operation: ${report.retry.operationId}
Initial synced files: ${report.cancel.rightNamesAfterCancel.length}
Final synced files: ${report.retry.rightNamesAfterRetry.length}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const itemCount = Number(optionValue("--count", process.env.EB_OPERATION_SYNC_CANCEL_COUNT || "5"));
  const fixture = await prepareFixture(Number.isFinite(itemCount) && itemCount >= 3 ? Math.round(itemCount) : 5);
  const checks = [];
  const port = Number(optionValue("--port", process.env.PORT || 47000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EB_TEST_OPERATION_DELAY_MS: process.env.EB_TEST_OPERATION_DELAY_MS || "8000",
      EB_TEST_OPERATION_DELAY_AFTER_ITEMS: process.env.EB_TEST_OPERATION_DELAY_AFTER_ITEMS || "1"
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

  let delayedOperation = null;
  let cancelResponse = null;
  let syncResponse = null;
  let finalCanceled = null;
  let retry = null;
  let afterRetryState = null;
  let rightNamesAfterCancel = [];
  let rightNamesAfterRetry = [];
  let syncPromise = null;
  let completedBeforeCancel = 0;
  try {
    await waitForServer(baseUrl, server);
    syncPromise = requestJson(baseUrl, "/api/sync", {
      method: "POST",
      body: JSON.stringify({
        leftPath: leftDir,
        rightPath: rightDir,
        direction: "leftToRight",
        overwrite: false,
        mirrorDeletes: false,
        items: fixture.items
      })
    });
    syncPromise.catch(() => {});

    delayedOperation = (
      await waitForOperation(
        baseUrl,
        (operation) => operation.type === "sync" && operation.status === "running" && operation.progress?.phase === "Test delay"
      )
    ).operation;
    completedBeforeCancel = Number(delayedOperation.progress?.completed || 0);
    check(
      checks,
      "sync-entered-test-delay",
      completedBeforeCancel >= 1 && completedBeforeCancel < fixture.items.length,
      `completed=${completedBeforeCancel}.`
    );
    check(
      checks,
      "checkpoint-has-sync-remaining-before-cancel",
      delayedOperation.result?.recovery?.remainingCount === fixture.items.length - completedBeforeCancel,
      `remaining=${delayedOperation.result?.recovery?.remainingCount || 0}.`
    );

    cancelResponse = await requestJson(baseUrl, "/api/operation/cancel", {
      method: "POST",
      body: JSON.stringify({ operationId: delayedOperation.id })
    });
    check(checks, "cancel-request-accepted", cancelResponse.operation?.cancelRequestedAt, `status=${cancelResponse.operation?.status}.`);

    syncResponse = await syncPromise;
    const stateAfterCancel = await requestJson(baseUrl, "/api/state");
    finalCanceled = operationById(stateAfterCancel, delayedOperation.id) || syncResponse.operation;
    rightNamesAfterCancel = await listRightNames();
    check(checks, "sync-finished-canceled", finalCanceled?.status === "canceled", `status=${finalCanceled?.status || "missing"}.`);
    check(checks, "canceled-has-lineage", finalCanceled?.cancelRequestedAt && finalCanceled?.finishedAt, `cancel=${finalCanceled?.cancelRequestedAt || "missing"}.`);
    check(checks, "canceled-keeps-completed-count", finalCanceled?.result?.recovery?.completedCount === completedBeforeCancel, `completed=${finalCanceled?.result?.recovery?.completedCount || 0}.`);
    check(
      checks,
      "canceled-keeps-only-sync-remaining",
      finalCanceled?.result?.recovery?.remainingCount === fixture.items.length - completedBeforeCancel,
      `remaining=${finalCanceled?.result?.recovery?.remainingCount || 0}.`
    );
    check(checks, "cancel-left-completed-right-items", rightNamesAfterCancel.length === completedBeforeCancel, `right=${rightNamesAfterCancel.join(",")}.`);

    retry = await requestJson(baseUrl, "/api/operation/retry-remaining", {
      method: "POST",
      body: JSON.stringify({ operationId: delayedOperation.id })
    });
    afterRetryState = await requestJson(baseUrl, "/api/state");
    rightNamesAfterRetry = await listRightNames();
    const sourceAfterRetry = operationById(afterRetryState, delayedOperation.id);
    const retryOperation = retry.operation || null;
    const expectedNames = [...fixture.items].sort((a, b) => a.localeCompare(b));
    const contentChecks = await rightContentMatches(fixture.items);
    check(checks, "retry-remaining-completed", retryOperation?.status === "completed" && retryOperation?.retryOf === delayedOperation.id, `status=${retryOperation?.status}; retryOf=${retryOperation?.retryOf}.`);
    check(
      checks,
      "retry-linked-to-canceled-sync",
      sourceAfterRetry?.result?.recovery?.lastRetryOperationId === retryOperation?.id,
      `lastRetry=${sourceAfterRetry?.result?.recovery?.lastRetryOperationId || "missing"}.`
    );
    check(checks, "retry-no-duplicate-right-items", rightNamesAfterRetry.length === expectedNames.length, `right=${rightNamesAfterRetry.join(",")}.`);
    check(
      checks,
      "retry-restored-exact-right-set",
      JSON.stringify(rightNamesAfterRetry) === JSON.stringify(expectedNames),
      `expected=${expectedNames.join(",")}; actual=${rightNamesAfterRetry.join(",")}.`
    );
    check(checks, "retry-right-content-matches-left", contentChecks.every(Boolean), `matches=${contentChecks.filter(Boolean).length}/${contentChecks.length}.`);

    const persisted = JSON.parse(await fs.readFile(path.join(appData, "ExploreBetter", "state.json"), "utf8"));
    check(
      checks,
      "api-persisted-match",
      JSON.stringify(afterRetryState.operations) === JSON.stringify(persisted.operations),
      "API and persisted operations match after sync cancel retry."
    );

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
      leftDir,
      rightDir,
      fixture: {
        count: fixture.items.length,
        items: fixture.items
      },
      cancel: {
        operationId: delayedOperation.id,
        responseStatus: cancelResponse.operation?.status || null,
        finalStatus: finalCanceled?.status || null,
        completedBeforeCancel,
        completedCount: finalCanceled?.result?.recovery?.completedCount || 0,
        remainingCount: finalCanceled?.result?.recovery?.remainingCount || 0,
        rightNamesAfterCancel
      },
      retry: {
        operationId: retry.operation?.id || null,
        status: retry.operation?.status || null,
        retryOf: retry.operation?.retryOf || null,
        rightNamesAfterRetry
      },
      checks,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`operation sync cancel: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (syncPromise) {
      await Promise.race([
        syncPromise.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 250))
      ]);
    }
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
