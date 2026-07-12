import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `crash-recovery-${stamp}`);
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
  return process.argv.includes("--keep-fixture") || process.env.EB_CRASH_RECOVERY_KEEP_FIXTURE === "1";
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

async function seedState() {
  const copySource = path.join(fixtureRoot, "copy-source");
  const copyTarget = path.join(fixtureRoot, "copy-target");
  const transferSource = path.join(fixtureRoot, "transfer-source");
  const transferTarget = path.join(fixtureRoot, "transfer-target");
  const syncLeft = path.join(fixtureRoot, "sync-left");
  const syncRight = path.join(fixtureRoot, "sync-right");
  await fs.mkdir(copySource, { recursive: true });
  await fs.mkdir(copyTarget, { recursive: true });
  await fs.mkdir(transferSource, { recursive: true });
  await fs.mkdir(transferTarget, { recursive: true });
  await fs.mkdir(syncLeft, { recursive: true });
  await fs.mkdir(syncRight, { recursive: true });
  const copyPaths = ["a.txt", "b.txt", "c.txt"].map((name) => path.join(copySource, name));
  for (const itemPath of copyPaths) {
    await fs.writeFile(itemPath, `${path.basename(itemPath)}\n`);
  }
  const transferRemaining = path.join(transferSource, "remaining.txt");
  await fs.writeFile(transferRemaining, "remaining\n");
  const now = new Date().toISOString();
  const state = {
    version: 1,
    updatedAt: now,
    operations: [
      {
        id: "running-copy",
        type: "copy",
        label: "Copy files",
        status: "running",
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        result: null,
        error: null,
        undo: null,
        progress: {
          unit: "items",
          total: copyPaths.length,
          completed: 1,
          phase: "Copying",
          current: "b.txt",
          currentPath: copyPaths[1],
          updatedAt: now
        },
        retry: {
          type: "copy",
          body: {
            paths: copyPaths,
            targetDir: copyTarget
          },
          createdAt: now
        },
        retryOf: null
      },
      {
        id: "paused-transfer",
        type: "transfer",
        label: "Transfer file",
        status: "paused",
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        result: {
          mode: "copy",
          transferred: [path.join(transferTarget, "done.txt")],
          recovery: {
            type: "transfer",
            targetDir: transferTarget,
            completedCount: 1,
            remainingCount: 1,
            completed: [
              {
                index: 0,
                path: path.join(transferSource, "done.txt"),
                name: "done.txt",
                dest: path.join(transferTarget, "done.txt")
              }
            ],
            failed: null,
            remaining: [
              {
                index: 1,
                path: transferRemaining,
                name: "remaining.txt"
              }
            ],
            retry: {
              type: "transfer",
              body: {
                paths: [transferRemaining],
                targetDir: transferTarget,
                mode: "copy",
                conflictMode: "unique"
              }
            },
            canRetryRemaining: true
          }
        },
        error: null,
        undo: null,
        progress: {
          unit: "items",
          total: 2,
          completed: 1,
          phase: "Paused",
          currentPath: transferRemaining,
          updatedAt: now
        },
        retry: {
          type: "transfer",
          body: {
            paths: [path.join(transferSource, "done.txt"), transferRemaining],
            targetDir: transferTarget,
            mode: "copy",
            conflictMode: "unique"
          },
          createdAt: now
        },
        retryOf: null
      },
      {
        id: "queued-sync",
        type: "sync",
        label: "Sync folders",
        status: "queued",
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
        undo: null,
        progress: {
          unit: "items",
          total: 3,
          completed: 2,
          phase: "Queued",
          updatedAt: now
        },
        retry: {
          type: "sync",
          body: {
            leftPath: syncLeft,
            rightPath: syncRight,
            direction: "leftToRight",
            overwrite: true,
            items: ["one.txt", "two.txt", "three.txt"]
          },
          createdAt: now
        },
        retryOf: null
      },
      {
        id: "completed-keep",
        type: "copy",
        label: "Completed copy",
        status: "completed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        result: { copied: [] },
        error: null,
        undo: null,
        progress: {
          unit: "items",
          total: 0,
          completed: 0,
          phase: "Completed",
          updatedAt: now
        },
        retry: null,
        retryOf: null
      }
    ]
  };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  return { copyPaths, copyTarget, transferRemaining, syncLeft, syncRight };
}

function operationById(state, id) {
  const operation = state.operations.find((item) => item.id === id);
  assert(operation, `Missing operation ${id}`);
  return operation;
}

function assertRecovered(operation) {
  assert(operation.status === "failed", `${operation.id} should be marked failed.`);
  assert(/interrupted by app restart/i.test(operation.error || ""), `${operation.id} should explain restart interruption.`);
  assert(operation.finishedAt, `${operation.id} should have finishedAt.`);
  assert(operation.interruptedAt, `${operation.id} should have interruptedAt.`);
  assert(operation.progress?.phase === "Interrupted", `${operation.id} progress should be interrupted.`);
  assert(operation.result?.recovery?.interrupted === true, `${operation.id} recovery should be marked interrupted.`);
  assert(operation.result?.recovery?.partialCompletionUnverified === true, `${operation.id} recovery should flag unverified completion.`);
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await seedState();
  const port = Number(optionValue("--port", process.env.PORT || 50000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, server);
    const state = await requestJson(baseUrl, "/api/state");
    const runningCopy = operationById(state, "running-copy");
    const pausedTransfer = operationById(state, "paused-transfer");
    const queuedSync = operationById(state, "queued-sync");
    const completed = operationById(state, "completed-keep");

    assertRecovered(runningCopy);
    assert(runningCopy.result.recovery.completedCount === 1, "Copy should keep one completed item from progress.");
    assert(runningCopy.result.recovery.remainingCount === 2, "Copy should expose two remaining items.");
    assert(runningCopy.result.recovery.remaining[0].path === fixture.copyPaths[1], "Copy remaining should resume at the second source.");
    assert(runningCopy.result.recovery.retry?.body?.paths?.length === 2, "Copy retry should contain only remaining paths.");
    assert(runningCopy.result.recovery.retry.body.targetDir === fixture.copyTarget, "Copy retry should preserve target directory.");

    assertRecovered(pausedTransfer);
    assert(pausedTransfer.result.recovery.remainingCount === 1, "Existing transfer recovery should preserve remaining count.");
    assert(pausedTransfer.result.recovery.remaining[0].path === fixture.transferRemaining, "Existing transfer remaining path should be preserved.");
    assert(pausedTransfer.result.recovery.canRetryRemaining === true, "Existing transfer recovery should remain retryable.");

    assertRecovered(queuedSync);
    assert(queuedSync.result.recovery.direction === "leftToRight", "Sync direction should be preserved.");
    assert(queuedSync.result.recovery.remainingCount === 1, "Sync should expose one remaining item from progress.");
    assert(queuedSync.result.recovery.remaining[0].relativePath === "three.txt", "Sync remaining item should resume at the third relative path.");
    assert(queuedSync.result.recovery.retry?.body?.items?.length === 1, "Sync retry should contain only remaining relative paths.");
    assert(queuedSync.result.recovery.retry.body.items[0] === "three.txt", "Sync retry should preserve the remaining relative path.");

    assert(completed.status === "completed", "Completed operation should not be rewritten.");
    assert(completed.progress?.phase === "Completed", "Completed progress should remain completed.");

    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert(operationById(persisted, "running-copy").status === "failed", "Recovered state should be written back to disk.");

    const outputPath = path.join(artifactsDir, "crash-recovery-latest.json");
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          fixtureRoot,
          recovered: {
            runningCopy: runningCopy.result.recovery,
            pausedTransfer: pausedTransfer.result.recovery,
            queuedSync: queuedSync.result.recovery
          }
        },
        null,
        2
      ),
      "utf8"
    );
    console.log("recovered active operations: running-copy, paused-transfer, queued-sync");
    console.log(`copy remaining: ${runningCopy.result.recovery.remainingCount}`);
    console.log(`sync remaining: ${queuedSync.result.recovery.remainingCount}`);
    console.log(`wrote ${outputPath}`);
  } finally {
    server.kill();
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error);
  process.exitCode = 1;
});
