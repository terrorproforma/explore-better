import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createBackendFixture, waitForOperation } from "./mcp-smoke-helpers.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out awaiting ${label}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

const fixture = await createBackendFixture({ access: "read-write" });
const stateFile = path.join(fixture.temp, "LocalAppData", "ExploreBetter", "state.json");
const original = { open: fs.open, stat: fs.stat, readFile: fs.readFile };
const stagingReached = deferred(), releaseStaging = deferred(), completionPublished = deferred();
let operationId;
let stateReads = 0;
let captureWaitRead = false;
let delayedSnapshotStatus;
let waitResult;
try {
  await fixture.backend.setMcpUiDispatcher(async () => ({ matched: true, context: { live: true, contextRevision: 1 } }));
  const target = path.join(fixture.fixture, "wait-race.txt");
  await fs.writeFile(target, "original bytes");
  const plan = await fixture.request("plan_text_write", { path: target, content: "committed bytes" });
  fs.open = async (...args) => {
    if (typeof args[0] === "string" && path.dirname(args[0]) === fixture.fixture && path.basename(args[0]).startsWith(".explore-better-staging-")) {
      stagingReached.resolve();
      await releaseStaging.promise;
    }
    return original.open(...args);
  };
  operationId = (await fixture.request("apply_operation", { applyToken: plan.data.applyToken })).data.operationId;
  await within(stagingReached.promise, "transaction staging");
  fixture.backend.setMcpResourceUpdatePublisher(uri => {
    if (uri !== `explore-better://operations/${operationId}`) return;
    original.readFile(stateFile, "utf8").then(text => {
      if (JSON.parse(text).operations.find(operation => operation.id === operationId)?.status === "completed") completionPublished.resolve();
    }).catch(() => {});
  });
  fs.stat = async (...args) => {
    const stat = await original.stat(...args);
    // The adapter reads once for authorization, then the backend reads to
    // establish its wait. Force that second read past its cached metadata.
    if (args[0] === stateFile && ++stateReads === 2) {
      captureWaitRead = true;
      return { ...stat, mtimeMs: stat.mtimeMs + 1 };
    }
    return stat;
  };
  fs.readFile = async (...args) => {
    const result = await original.readFile(...args);
    if (args[0] === stateFile && captureWaitRead) {
      captureWaitRead = false;
      delayedSnapshotStatus = JSON.parse(result).operations.find(operation => operation.id === operationId)?.status;
      releaseStaging.resolve();
      // Complete the real transaction while its earlier state read remains
      // in flight, before returning the now-stale snapshot to the waiter.
      await within(completionPublished.promise, "completion notification");
    }
    return result;
  };
  waitResult = await within(fixture.request("wait_for_ui", { timeoutMs: 5000, condition: { operationId, operationStatus: "completed" } }), "operation wait result");
  fs.stat = original.stat;
  fs.readFile = original.readFile;
  const operation = await waitForOperation(fixture.request, operationId, 5000);
  const evidence = { delayedSnapshotStatus, matched: waitResult.data.matched, returnedStatus: waitResult.data.operation?.status, persistedStatus: operation.status };
  await fs.writeFile(path.resolve("artifacts/backend-operation-wait-latest.json"), JSON.stringify(evidence, null, 2));
  assert.equal(delayedSnapshotStatus, "running", JSON.stringify(evidence));
  assert.equal(operation.status, "completed", JSON.stringify(evidence));
  assert.equal(await fs.readFile(target, "utf8"), "committed bytes");
  assert.equal(waitResult.data.matched, true, `Completion published during the initial state read was lost: ${JSON.stringify(evidence)}`);
  assert.equal(waitResult.data.operation.status, "completed");
  console.log("PASS Completion during an in-flight initial state read is observed");

  const alreadyCompleted = await within(fixture.request("wait_for_ui", { timeoutMs: 100, condition: { operationId, operationStatus: "completed" } }), "already completed operation");
  assert.equal(alreadyCompleted.data.matched, true);
  assert.equal(alreadyCompleted.data.operation.status, "completed");
  console.log("PASS An already completed operation matches without another notification");

  const stateReadBlocked = deferred(), releaseStateRead = deferred(), stateReadReturned = deferred();
  const controller = new AbortController();
  stateReads = 0;
  fs.stat = async (...args) => {
    const stat = await original.stat(...args);
    if (args[0] === stateFile && ++stateReads === 2) {
      stateReadBlocked.resolve();
      await releaseStateRead.promise;
      stateReadReturned.resolve();
    }
    return stat;
  };
  try {
    const waiting = within(fixture.request("wait_for_ui", { timeoutMs: 5000, condition: { operationId, operationStatus: "running" } }, { signal: controller.signal }), "canceled operation wait");
    const rejected = assert.rejects(waiting, { code: "REQUEST_CANCELED" });
    await within(stateReadBlocked.promise, "blocked initial state read");
    controller.abort();
    // Cancellation must settle the caller while its filesystem read is blocked.
    await rejected;
  } finally {
    releaseStateRead.resolve();
    fs.stat = original.stat;
    await within(stateReadReturned.promise, "released initial state read");
    await new Promise(resolve => setImmediate(resolve));
  }
  console.log("PASS Cancellation settles while the initial state read remains blocked");
  await fs.writeFile(path.resolve("artifacts/backend-operation-wait-latest.json"), JSON.stringify({ ...evidence, checks: 3, cancellationDuringRead: true, alreadyCompleted: true }, null, 2));
  console.log("Backend operation wait: 3 passed.");
} finally {
  releaseStaging.resolve();
  completionPublished.resolve();
  fs.open = original.open;
  fs.stat = original.stat;
  fs.readFile = original.readFile;
  fixture.backend.setMcpResourceUpdatePublisher(null);
  await fixture.backend.setMcpUiDispatcher(null);
  if (operationId) await waitForOperation(fixture.request, operationId, 5000).catch(() => {});
  await fixture.cleanup();
}
process.exit(0);
