import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-cancel-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const sourceDir = path.join(fixtureRoot, "source");
const targetDir = path.join(fixtureRoot, "target");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "operation-cancel-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-cancel-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_CANCEL_KEEP_FIXTURE === "1";
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
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const itemPath = path.join(sourceDir, `cancel-copy-${String(index).padStart(2, "0")}.txt`);
    await fs.writeFile(itemPath, `cancel copy source ${index}\n`, "utf8");
    paths.push(itemPath);
  }
  return { paths };
}

async function listTargetNames() {
  try {
    return (await fs.readdir(targetDir)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Cancel Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Canceled operation: ${report.cancel.operationId}
Retry operation: ${report.retry.operationId}
Initial copied files: ${report.cancel.targetNamesAfterCancel.length}
Final copied files: ${report.retry.targetNamesAfterRetry.length}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fileCount = Number(optionValue("--count", process.env.EB_OPERATION_CANCEL_COUNT || "5"));
  const fixture = await prepareFixture(Number.isFinite(fileCount) && fileCount >= 3 ? Math.round(fileCount) : 5);
  const checks = [];
  const port = Number(optionValue("--port", process.env.PORT || 48000 + Math.floor(Math.random() * 10000)));
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
  let copyResponse = null;
  let finalCanceled = null;
  let retry = null;
  let afterRetryState = null;
  let targetNamesAfterCancel = [];
  let targetNamesAfterRetry = [];
  let copyPromise = null;
  let completedBeforeCancel = 0;
  try {
    await waitForServer(baseUrl, server);
    copyPromise = requestJson(baseUrl, "/api/copy", {
      method: "POST",
      body: JSON.stringify({
        paths: fixture.paths,
        targetDir
      })
    });
    copyPromise.catch(() => {});

    delayedOperation = (
      await waitForOperation(
        baseUrl,
        (operation) => operation.type === "copy" && operation.status === "running" && operation.progress?.phase === "Test delay"
      )
    ).operation;
    completedBeforeCancel = Number(delayedOperation.progress?.completed || 0);
    check(
      checks,
      "copy-entered-test-delay",
      completedBeforeCancel >= 1 && completedBeforeCancel < fixture.paths.length,
      `completed=${completedBeforeCancel}.`
    );
    check(
      checks,
      "checkpoint-has-remaining-before-cancel",
      delayedOperation.result?.recovery?.remainingCount === fixture.paths.length - completedBeforeCancel,
      `remaining=${delayedOperation.result?.recovery?.remainingCount || 0}.`
    );

    cancelResponse = await requestJson(baseUrl, "/api/operation/cancel", {
      method: "POST",
      body: JSON.stringify({ operationId: delayedOperation.id })
    });
    check(checks, "cancel-request-accepted", cancelResponse.operation?.cancelRequestedAt, `status=${cancelResponse.operation?.status}.`);

    copyResponse = await copyPromise;
    const stateAfterCancel = await requestJson(baseUrl, "/api/state");
    finalCanceled = operationById(stateAfterCancel, delayedOperation.id) || copyResponse.operation;
    targetNamesAfterCancel = await listTargetNames();
    check(checks, "copy-finished-canceled", finalCanceled?.status === "canceled", `status=${finalCanceled?.status || "missing"}.`);
    check(checks, "canceled-has-lineage", finalCanceled?.cancelRequestedAt && finalCanceled?.finishedAt, `cancel=${finalCanceled?.cancelRequestedAt || "missing"}.`);
    check(checks, "canceled-keeps-completed-count", finalCanceled?.result?.recovery?.completedCount === completedBeforeCancel, `completed=${finalCanceled?.result?.recovery?.completedCount || 0}.`);
    check(
      checks,
      "canceled-keeps-only-remaining",
      finalCanceled?.result?.recovery?.remainingCount === fixture.paths.length - completedBeforeCancel,
      `remaining=${finalCanceled?.result?.recovery?.remainingCount || 0}.`
    );
    check(checks, "cancel-left-completed-targets", targetNamesAfterCancel.length === completedBeforeCancel, `targets=${targetNamesAfterCancel.join(",")}.`);

    retry = await requestJson(baseUrl, "/api/operation/retry-remaining", {
      method: "POST",
      body: JSON.stringify({ operationId: delayedOperation.id })
    });
    afterRetryState = await requestJson(baseUrl, "/api/state");
    targetNamesAfterRetry = await listTargetNames();
    const sourceAfterRetry = operationById(afterRetryState, delayedOperation.id);
    const retryOperation = retry.operation || null;
    const expectedNames = fixture.paths.map((itemPath) => path.basename(itemPath)).sort((a, b) => a.localeCompare(b));
    check(checks, "retry-remaining-completed", retryOperation?.status === "completed" && retryOperation?.retryOf === delayedOperation.id, `status=${retryOperation?.status}; retryOf=${retryOperation?.retryOf}.`);
    check(
      checks,
      "retry-linked-to-canceled",
      sourceAfterRetry?.result?.recovery?.lastRetryOperationId === retryOperation?.id,
      `lastRetry=${sourceAfterRetry?.result?.recovery?.lastRetryOperationId || "missing"}.`
    );
    check(checks, "retry-no-duplicate-targets", targetNamesAfterRetry.length === expectedNames.length, `targets=${targetNamesAfterRetry.join(",")}.`);
    check(
      checks,
      "retry-restored-exact-target-set",
      JSON.stringify(targetNamesAfterRetry) === JSON.stringify(expectedNames),
      `expected=${expectedNames.join(",")}; actual=${targetNamesAfterRetry.join(",")}.`
    );
    for (const sourcePath of fixture.paths) {
      check(checks, `target-exists-${path.basename(sourcePath)}`, await pathExists(path.join(targetDir, path.basename(sourcePath))), path.basename(sourcePath));
    }

    const persisted = JSON.parse(await fs.readFile(path.join(appData, "ExploreBetter", "state.json"), "utf8"));
    check(
      checks,
      "api-persisted-match",
      JSON.stringify(afterRetryState.operations) === JSON.stringify(persisted.operations),
      "API and persisted operations match after cancel retry."
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
      sourceDir,
      targetDir,
      fixture: {
        count: fixture.paths.length,
        paths: fixture.paths
      },
      cancel: {
        operationId: delayedOperation.id,
        responseStatus: cancelResponse.operation?.status || null,
        finalStatus: finalCanceled?.status || null,
        completedBeforeCancel,
        completedCount: finalCanceled?.result?.recovery?.completedCount || 0,
        remainingCount: finalCanceled?.result?.recovery?.remainingCount || 0,
        targetNamesAfterCancel
      },
      retry: {
        operationId: retry.operation?.id || null,
        status: retry.operation?.status || null,
        retryOf: retry.operation?.retryOf || null,
        targetNamesAfterRetry
      },
      checks,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`operation cancel: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (copyPromise) {
      await Promise.race([
        copyPromise.catch(() => null),
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
