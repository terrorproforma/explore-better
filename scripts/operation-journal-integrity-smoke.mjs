import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-journal-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_JOURNAL_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function seedFixtureAndState() {
  const dirs = {
    copySource: path.join(fixtureRoot, "copy-source"),
    copyTarget: path.join(fixtureRoot, "copy-target"),
    moveSource: path.join(fixtureRoot, "move-source"),
    moveTarget: path.join(fixtureRoot, "move-target"),
    deleteSource: path.join(fixtureRoot, "delete-source"),
    trashSource: path.join(fixtureRoot, "trash-source"),
    syncLeft: path.join(fixtureRoot, "sync-left"),
    syncRight: path.join(fixtureRoot, "sync-right"),
    renameDir: path.join(fixtureRoot, "rename"),
    retrySource: path.join(fixtureRoot, "retry-source"),
    retryTarget: path.join(fixtureRoot, "retry-target"),
    createDir: path.join(fixtureRoot, "create")
  };
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
  const paths = {
    copyA: path.join(dirs.copySource, "copy-a.txt"),
    copyB: path.join(dirs.copySource, "copy-b.txt"),
    moveA: path.join(dirs.moveSource, "move-a.txt"),
    deleteA: path.join(dirs.deleteSource, "delete-a.txt"),
    trashA: path.join(dirs.trashSource, "trash-a.txt"),
    renameBefore: path.join(dirs.renameDir, "before.txt"),
    renameAfter: path.join(dirs.renameDir, "after.txt"),
    retryRemaining: path.join(dirs.retrySource, "remaining.txt")
  };
  await writeText(paths.copyA, "copy a\n");
  await writeText(paths.copyB, "copy b\n");
  await writeText(paths.moveA, "move a\n");
  await writeText(paths.deleteA, "delete a\n");
  await writeText(paths.trashA, "trash a\n");
  await writeText(paths.renameBefore, "rename me\n");
  await writeText(path.join(dirs.syncLeft, "fresh.txt"), "fresh left\n");
  await writeText(path.join(dirs.syncLeft, "replace.txt"), "replace left\n");
  await writeText(path.join(dirs.syncRight, "replace.txt"), "replace right old\n");
  await writeText(paths.retryRemaining, "retry remaining\n");

  const now = new Date().toISOString();
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: now,
        operations: [
          {
            id: "seed-failed-copy",
            type: "copy",
            label: "Seed failed copy",
            status: "failed",
            createdAt: now,
            startedAt: now,
            finishedAt: now,
            result: {
              recovery: {
                type: "copy",
                targetDir: dirs.retryTarget,
                completedCount: 0,
                remainingCount: 1,
                completed: [],
                failed: {
                  index: 0,
                  path: paths.retryRemaining,
                  name: "remaining.txt"
                },
                remaining: [
                  {
                    index: 0,
                    path: paths.retryRemaining,
                    name: "remaining.txt"
                  }
                ],
                retry: {
                  type: "copy",
                  body: {
                    paths: [paths.retryRemaining],
                    targetDir: dirs.retryTarget
                  }
                },
                canRetryRemaining: true,
                interrupted: true,
                interruptedAt: now
              }
            },
            error: "Seeded failure with remaining work.",
            undo: null,
            progress: {
              unit: "items",
              total: 1,
              completed: 0,
              phase: "Failed",
              updatedAt: now
            },
            retry: {
              type: "copy",
              body: {
                paths: [paths.retryRemaining],
                targetDir: dirs.retryTarget
              },
              createdAt: now
            },
            retryOf: null
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  return { dirs, paths };
}

function assertCompletedOperation(operation, type, undoType = undefined) {
  assert(operation?.id, `${type} operation should have an id.`);
  assert(operation.type === type, `Expected operation type ${type}, got ${operation.type}.`);
  assert(operation.status === "completed", `${type} should complete.`);
  assert(operation.createdAt && operation.startedAt && operation.finishedAt, `${type} should have operation timestamps.`);
  assert(operation.error === null, `${type} should not have an error.`);
  assert(operation.progress?.phase === "Completed", `${type} progress should finish as Completed.`);
  assert(operation.result && typeof operation.result === "object", `${type} should have a structured result.`);
  assert(Array.isArray(operation.events) && operation.events.length >= 3 && operation.events.length <= 64, `${type} should have a bounded operation timeline.`);
  assert(operation.events.some((event) => /queued/.test(event.kind)) && operation.events.some((event) => event.kind === "started"), `${type} timeline should include queue and start events.`);
  assert(operation.events.some((event) => /completed/.test(event.kind)), `${type} timeline should include completion.`);
  if (type === "undo") {
    assert(operation.retry === null, "Undo should not have retry metadata.");
  } else {
    assert(operation.retry?.type === type, `${type} should have retry metadata.`);
  }
  if (undoType !== undefined) {
    if (undoType === null) {
      assert(operation.undo === null, `${type} should not be undoable.`);
    } else {
      assert(operation.undo?.type === undoType, `${type} should have ${undoType} undo metadata.`);
    }
  }
}

function operationById(state, id) {
  const operation = state.operations?.find((item) => item.id === id);
  assert(operation, `Missing operation ${id}.`);
  return operation;
}

function operationsByType(state, type) {
  return (state.operations || []).filter((operation) => operation.type === type);
}

function summarizeOperation(operation) {
  return {
    id: operation.id,
    type: operation.type,
    status: operation.status,
    label: operation.label,
    retryOf: operation.retryOf || null,
    progress: operation.progress,
    resultKeys: Object.keys(operation.result || {}),
    undoType: operation.undo?.type || null,
    undoAppliedAt: operation.undo?.appliedAt || null,
    recovery: operation.result?.recovery || null
  };
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const fixture = await seedFixtureAndState();
  const port = Number(optionValue("--port", process.env.PORT || 56000 + Math.floor(Math.random() * 6000)));
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
    const copy = await requestJson(baseUrl, "/api/copy", {
      method: "POST",
      body: JSON.stringify({ paths: [fixture.paths.copyA, fixture.paths.copyB], targetDir: fixture.dirs.copyTarget })
    });
    assertCompletedOperation(copy.operation, "copy", "trash-created");
    assert(await pathExists(path.join(fixture.dirs.copyTarget, "copy-a.txt")), "Copy target should exist before undo.");

    const move = await requestJson(baseUrl, "/api/move", {
      method: "POST",
      body: JSON.stringify({ paths: [fixture.paths.moveA], targetDir: fixture.dirs.moveTarget })
    });
    assertCompletedOperation(move.operation, "move", "move-back");
    assert(await pathExists(path.join(fixture.dirs.moveTarget, "move-a.txt")), "Move target should exist.");
    assert(!(await pathExists(fixture.paths.moveA)), "Move source should be gone.");

    const deleteResult = await requestJson(baseUrl, "/api/delete", {
      method: "POST",
      body: JSON.stringify({ paths: [fixture.paths.deleteA] })
    });
    assertCompletedOperation(deleteResult.operation, "delete", null);
    assert(deleteResult.operation.result?.undoAvailable === false, "Permanent delete result should declare undo unavailable.");
    assert(!(await pathExists(fixture.paths.deleteA)), "Deleted file should be gone.");

    const trash = await requestJson(baseUrl, "/api/trash", {
      method: "POST",
      body: JSON.stringify({ paths: [fixture.paths.trashA] })
    });
    assertCompletedOperation(trash.operation, "trash", "restore-trash");
    assert(!(await pathExists(fixture.paths.trashA)), "Trashed source should be gone.");
    assert(trash.operation.undo?.items?.[0]?.from && (await pathExists(trash.operation.undo.items[0].from)), "Trashed file should exist in app trash.");

    const rename = await requestJson(baseUrl, "/api/rename", {
      method: "POST",
      body: JSON.stringify({ path: fixture.paths.renameBefore, name: "after.txt" })
    });
    assertCompletedOperation(rename.operation, "rename", "rename-back");
    assert(await pathExists(fixture.paths.renameAfter), "Renamed target should exist.");

    const sync = await requestJson(baseUrl, "/api/sync", {
      method: "POST",
      body: JSON.stringify({
        leftPath: fixture.dirs.syncLeft,
        rightPath: fixture.dirs.syncRight,
        direction: "leftToRight",
        overwrite: true,
        mirrorDeletes: false,
        items: ["fresh.txt", "replace.txt"]
      })
    });
    assertCompletedOperation(sync.operation, "sync", "sync-copy");
    assert(await pathExists(path.join(fixture.dirs.syncRight, "fresh.txt")), "Synced fresh file should exist.");
    assert((await fs.readFile(path.join(fixture.dirs.syncRight, "replace.txt"), "utf8")) === "replace left\n", "Synced replace file should be overwritten.");

    const create = await requestJson(baseUrl, "/api/file/create", {
      method: "POST",
      body: JSON.stringify({ path: fixture.dirs.createDir, name: "created.txt", content: "created by journal smoke\n" })
    });
    assertCompletedOperation(create.operation, "create-file", "trash-created");
    assert(await pathExists(path.join(fixture.dirs.createDir, "created.txt")), "Created file should exist.");

    const undoCopy = await requestJson(baseUrl, "/api/operation/undo", {
      method: "POST",
      body: JSON.stringify({ operationId: copy.operation.id })
    });
    assertCompletedOperation(undoCopy.operation, "undo", null);
    assert(!(await pathExists(path.join(fixture.dirs.copyTarget, "copy-a.txt"))), "Undo should remove copied file from target.");

    const retryRemaining = await requestJson(baseUrl, "/api/operation/retry-remaining", {
      method: "POST",
      body: JSON.stringify({ operationId: "seed-failed-copy" })
    });
    assertCompletedOperation(retryRemaining.operation, "copy", "trash-created");
    assert(retryRemaining.operation.retryOf === "seed-failed-copy", "Retry operation should link back to the failed operation.");
    assert(await pathExists(path.join(fixture.dirs.retryTarget, "remaining.txt")), "Retry remaining should copy the pending file.");

    const state = await requestJson(baseUrl, "/api/state");
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert(Array.isArray(state.operations), "State should expose operations.");
    assert(state.operations.length >= 10, "Journal should include seeded, primary, undo, and retry operations.");
    assert(state.operations.length <= 100, "Journal should stay bounded.");
    assert(state.operations[0].id === retryRemaining.operation.id, "Latest operation should be first in journal.");
    assert(JSON.stringify(state.operations) === JSON.stringify(persisted.operations), "Persisted operation journal should match API state.");

    for (const operation of [
      copy.operation,
      move.operation,
      deleteResult.operation,
      trash.operation,
      rename.operation,
      sync.operation,
      create.operation,
      undoCopy.operation,
      retryRemaining.operation
    ]) {
      const saved = operationById(state, operation.id);
      assert(saved.status === operation.status, `${operation.type} saved status should match response.`);
      assert(saved.progress?.phase === "Completed", `${operation.type} saved progress should be completed.`);
      assert(Array.isArray(saved.events) && saved.events.length <= 64, `${operation.type} persisted timeline should remain bounded.`);
    }

    const originalCopy = operationById(state, copy.operation.id);
    assert(originalCopy.undo?.appliedAt, "Original copy operation should record undo appliedAt.");
    assert(originalCopy.undo?.result, "Original copy operation should record undo result.");
    assert(originalCopy.events?.some((event) => event.kind === "undo" && event.relatedOperationId === undoCopy.operation.id), "Original copy timeline should link its Undo operation.");
    assert(undoCopy.operation.relatedOperationId === originalCopy.id, "Undo operation should link back to its source.");
    const seeded = operationById(state, "seed-failed-copy");
    assert(seeded.result?.recovery?.lastRetryOperationId === retryRemaining.operation.id, "Seeded failed operation should record retry lineage.");
    assert(seeded.result?.recovery?.lastRetriedAt, "Seeded failed operation should record last retry timestamp.");
    assert(seeded.events?.some((event) => event.kind === "retry" && event.relatedOperationId === retryRemaining.operation.id), "Failed operation timeline should link its retry.");
    assert(retryRemaining.operation.relatedOperationId === seeded.id, "Retry operation should link back to its source.");
    assert(operationsByType(state, "copy").length >= 3, "Journal should include original copy, seeded failure, and retry copy.");
    assert(operationsByType(state, "undo").length === 1, "Journal should include one undo operation.");

    const report = {
      generatedAt: new Date().toISOString(),
      fixtureRoot,
      appData,
      counts: {
        operations: state.operations.length,
        completed: state.operations.filter((operation) => operation.status === "completed").length,
        failed: state.operations.filter((operation) => operation.status === "failed").length,
        undoable: state.operations.filter((operation) => operation.undo && !operation.undo.appliedAt).length,
        appliedUndo: state.operations.filter((operation) => operation.undo?.appliedAt).length,
        retryLinked: state.operations.filter((operation) => operation.retryOf).length
      },
      operations: state.operations.map(summarizeOperation),
      verified: {
        persistedMatchesApi: true,
        journalBounded: true,
        undoLineage: {
          originalOperationId: copy.operation.id,
          undoOperationId: undoCopy.operation.id,
          appliedAt: originalCopy.undo.appliedAt
        },
        retryLineage: {
          originalOperationId: "seed-failed-copy",
          retryOperationId: retryRemaining.operation.id,
          retriedAt: seeded.result.recovery.lastRetriedAt
        }
      }
    };
    const jsonPath = path.join(artifactsDir, "operation-journal-latest.json");
    const mdPath = path.join(artifactsDir, "operation-journal-latest.md");
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(
      mdPath,
      `# Explore Better Operation Journal Integrity

Generated: ${report.generatedAt}

Summary: ${report.counts.operations} operations, ${report.counts.completed} completed, ${report.counts.failed} failed, ${report.counts.appliedUndo} applied undo, ${report.counts.retryLinked} retry-linked.

Verified:
- Real copy, move, permanent delete, app trash, rename, sync, and create-file operations record completed journal rows.
- Undo records both a new undo operation and applied undo metadata on the original operation.
- Seeded failed remaining-work recovery can retry through the public retry-remaining API and records retry lineage.
- API state and persisted \`state.json\` operations match exactly.
- Journal remains bounded to 100 rows.

Artifacts:
- JSON: \`${jsonPath}\`
- Fixture root: \`${fixtureRoot}\`
`,
      "utf8"
    );
    console.log(`journal operations: ${report.counts.operations}`);
    console.log(`completed: ${report.counts.completed}, failed: ${report.counts.failed}`);
    console.log(`undo operation: ${undoCopy.operation.id}`);
    console.log(`retry operation: ${retryRemaining.operation.id}`);
    console.log(`wrote ${jsonPath}`);
    console.log(`wrote ${mdPath}`);
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
