import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `crash-kill-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const statePath = path.join(appData, "ExploreBetter", "state.json");
let serverOutput = "";
const ownedServers = new Set();

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_CRASH_KILL_KEEP_FIXTURE === "1";
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
    signal: options.signal || AbortSignal.timeout(5000),
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

function boundedFetch(url, options = {}, timeoutMs = 30000) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
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

function startServer(port, options = {}) {
  const operationDelay = options === true || options.operationDelay === true;
  const stateDelay = options.stateDelay === true;
  serverOutput = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      ...(operationDelay
        ? {
            EB_TEST_OPERATION_DELAY_MS: "15000",
            EB_TEST_OPERATION_DELAY_AFTER_ITEMS: "1"
          }
        : {}),
      ...(stateDelay
        ? {
            EB_TEST_STATE_WRITE_DELAY_MS: "15000"
          }
        : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  ownedServers.add(child);
  return child;
}

async function startReadyServer(baseUrl, port, options = {}) {
  const child = startServer(port, options);
  try {
    await waitForServer(baseUrl, child);
    return child;
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) {
    if (child) ownedServers.delete(child);
    return;
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  ownedServers.delete(child);
}

async function stopOwnedServers() {
  await Promise.all([...ownedServers].map((child) => stopServer(child)));
}

async function prepareFixture() {
  const copySourceDir = path.join(fixtureRoot, "copy-source");
  const copyTargetDir = path.join(fixtureRoot, "copy-target");
  const moveSourceDir = path.join(fixtureRoot, "move-source");
  const moveTargetDir = path.join(fixtureRoot, "move-target");
  const deleteDir = path.join(fixtureRoot, "delete-source");
  const trashDir = path.join(fixtureRoot, "trash-source");
  const syncLeftDir = path.join(fixtureRoot, "sync-left");
  const syncRightDir = path.join(fixtureRoot, "sync-right");
  const renameDir = path.join(fixtureRoot, "rename");
  await fs.mkdir(copySourceDir, { recursive: true });
  await fs.mkdir(copyTargetDir, { recursive: true });
  await fs.mkdir(moveSourceDir, { recursive: true });
  await fs.mkdir(moveTargetDir, { recursive: true });
  await fs.mkdir(deleteDir, { recursive: true });
  await fs.mkdir(trashDir, { recursive: true });
  await fs.mkdir(syncLeftDir, { recursive: true });
  await fs.mkdir(syncRightDir, { recursive: true });
  await fs.mkdir(renameDir, { recursive: true });

  const copySources = ["one.txt", "two.txt", "three.txt"].map((name) => path.join(copySourceDir, name));
  for (const [index, itemPath] of copySources.entries()) {
    await fs.writeFile(itemPath, `copy source ${index + 1}\n`);
  }

  const moveSources = ["one.txt", "two.txt", "three.txt"].map((name) => path.join(moveSourceDir, name));
  for (const [index, itemPath] of moveSources.entries()) {
    await fs.writeFile(itemPath, `move source ${index + 1}\n`);
  }

  const deleteSources = ["one.txt", "two.txt", "three.txt"].map((name) => path.join(deleteDir, name));
  for (const [index, itemPath] of deleteSources.entries()) {
    await fs.writeFile(itemPath, `delete source ${index + 1}\n`);
  }

  const trashSources = ["one.txt", "two.txt", "three.txt"].map((name) => path.join(trashDir, name));
  for (const [index, itemPath] of trashSources.entries()) {
    await fs.writeFile(itemPath, `trash source ${index + 1}\n`);
  }

  const syncItems = ["one.txt", "two.txt", "three.txt"];
  for (const [index, name] of syncItems.entries()) {
    await fs.writeFile(path.join(syncLeftDir, name), `sync source ${index + 1}\n`);
  }

  const renameSource = path.join(renameDir, "before.txt");
  const renameTarget = path.join(renameDir, "after.txt");
  await fs.writeFile(renameSource, "rename source\n");

  return {
    copy: { sourceDir: copySourceDir, targetDir: copyTargetDir, sources: copySources },
    move: { sourceDir: moveSourceDir, targetDir: moveTargetDir, sources: moveSources },
    delete: { sourceDir: deleteDir, sources: deleteSources },
    trash: { sourceDir: trashDir, sources: trashSources },
    sync: { leftDir: syncLeftDir, rightDir: syncRightDir, items: syncItems },
    rename: { dir: renameDir, source: renameSource, target: renameTarget, name: "after.txt" }
  };
}

async function readPersistedState() {
  const text = await fs.readFile(statePath, "utf8");
  return JSON.parse(text);
}

async function stateTempFiles() {
  const stateDir = path.dirname(statePath);
  try {
    const names = await fs.readdir(stateDir);
    return names
      .filter((name) => /^state\.json\..+\.tmp$/i.test(name))
      .map((name) => path.join(stateDir, name));
  } catch {
    return [];
  }
}

async function waitForStateTempFile() {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const files = await stateTempFiles();
    if (files.length) {
      return files[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Timed out waiting for an atomic state temp file.");
}

function latestOperationByType(state, type) {
  return state.operations?.find((item) => item.type === type);
}

async function waitForCheckpoint(type, expectedRemaining) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const state = await readPersistedState();
      const operation = latestOperationByType(state, type);
      if (
        operation?.status === "running" &&
        operation?.progress?.phase === "Test delay" &&
        operation?.result?.recovery?.remainingCount === expectedRemaining
      ) {
        return operation;
      }
    } catch {
      // State may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for a persisted running ${type} checkpoint.`);
}

function assertRecoveredBase(operation, type) {
  assert(operation, `Missing recovered ${type} operation.`);
  assert(operation.status === "failed", `${type} should recover as failed.`);
  assert(/interrupted by app restart/i.test(operation.error || ""), `${type} should explain restart interruption.`);
  assert(operation.progress?.phase === "Interrupted", `${type} progress should be marked interrupted.`);
  assert(operation.result?.recovery?.interrupted === true, `${type} details should mark interruption.`);
}

async function recoverAfterKill({ baseUrl, port, server, inFlight, type }) {
  await stopServer(server);
  const result = await inFlight;
  assert(result instanceof Error, `In-flight ${type} request should fail when the server is killed.`);
  const nextServer = await startReadyServer(baseUrl, port, false);
  const state = await requestJson(baseUrl, "/api/state");
  const operation = latestOperationByType(state, type);
  assertRecoveredBase(operation, type);
  return { server: nextServer, operation, state };
}

async function runCopyKillPhase(baseUrl, port, fixture) {
  let server = await startReadyServer(baseUrl, port, true);
  const inFlight = boundedFetch(`${baseUrl}/api/copy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: fixture.sources, targetDir: fixture.targetDir })
  }).catch((error) => error);

  const checkpoint = await waitForCheckpoint("copy", 2);
  assert(checkpoint.result.recovery.completedCount === 1, "Copy checkpoint should report one completed item.");
  assert(checkpoint.result.recovery.remainingCount === 2, "Copy checkpoint should report two remaining items.");
  assert(await pathExists(path.join(fixture.targetDir, "one.txt")), "First copied file should exist before crash.");
  assert(!(await pathExists(path.join(fixture.targetDir, "two.txt"))), "Second copy file should not exist before crash.");

  const recovered = await recoverAfterKill({ baseUrl, port, server, inFlight, type: "copy" });
  server = recovered.server;
  const operation = recovered.operation;
  assert(operation.result?.recovery?.completedCount === 1, "Recovered copy should preserve completed count.");
  assert(operation.result?.recovery?.remainingCount === 2, "Recovered copy should preserve remaining count.");
  assert(operation.result?.recovery?.retry?.body?.paths?.length === 2, "Recovered copy retry should target remaining paths only.");
  assert(await pathExists(path.join(fixture.targetDir, "one.txt")), "Completed copy item should remain on disk.");
  assert(!(await pathExists(path.join(fixture.targetDir, "two.txt"))), "Remaining copy item should not be copied during crash.");
  return { server, operation };
}

async function runMoveKillPhase(baseUrl, port, fixture, currentServer) {
  await stopServer(currentServer);
  let server = await startReadyServer(baseUrl, port, { operationDelay: true });
  const inFlight = boundedFetch(`${baseUrl}/api/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: fixture.sources, targetDir: fixture.targetDir })
  }).catch((error) => error);

  const checkpoint = await waitForCheckpoint("move", 2);
  assert(checkpoint.result.recovery.completedCount === 1, "Move checkpoint should report one completed item.");
  assert(checkpoint.result.recovery.remainingCount === 2, "Move checkpoint should report two remaining items.");
  assert(await pathExists(path.join(fixture.targetDir, "one.txt")), "First moved file should exist before crash.");
  assert(!(await pathExists(path.join(fixture.sourceDir, "one.txt"))), "First moved source should be absent before crash.");
  assert(await pathExists(path.join(fixture.sourceDir, "two.txt")), "Second move source should remain before crash.");
  assert(!(await pathExists(path.join(fixture.targetDir, "two.txt"))), "Second move target should not exist before crash.");

  const recovered = await recoverAfterKill({ baseUrl, port, server, inFlight, type: "move" });
  server = recovered.server;
  const operation = recovered.operation;
  assert(operation.result?.recovery?.completedCount === 1, "Recovered move should preserve completed count.");
  assert(operation.result?.recovery?.remainingCount === 2, "Recovered move should preserve remaining count.");
  assert(operation.result?.recovery?.retry?.body?.paths?.length === 2, "Recovered move retry should target remaining paths only.");
  assert(operation.undo?.type === "move-back", "Recovered move should preserve undo metadata for completed items.");
  assert(operation.undo?.items?.length === 1, "Recovered move undo should target the completed item only.");
  assert(await pathExists(path.join(fixture.targetDir, "one.txt")), "Recovered move target should remain on disk.");
  assert(!(await pathExists(path.join(fixture.sourceDir, "one.txt"))), "Recovered moved source should remain absent.");
  assert(await pathExists(path.join(fixture.sourceDir, "two.txt")), "Recovered remaining move source should remain.");
  assert(!(await pathExists(path.join(fixture.targetDir, "two.txt"))), "Recovered remaining move target should not exist.");
  return { server, operation };
}

async function runDeleteKillPhase(baseUrl, port, fixture, currentServer) {
  await stopServer(currentServer);
  let server = await startReadyServer(baseUrl, port, { operationDelay: true });
  const inFlight = boundedFetch(`${baseUrl}/api/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: fixture.sources })
  }).catch((error) => error);

  const checkpoint = await waitForCheckpoint("delete", 2);
  assert(checkpoint.result.recovery.completedCount === 1, "Delete checkpoint should report one completed item.");
  assert(checkpoint.result.recovery.remainingCount === 2, "Delete checkpoint should report two remaining items.");
  assert(!(await pathExists(path.join(fixture.sourceDir, "one.txt"))), "First deleted file should be absent before crash.");
  assert(await pathExists(path.join(fixture.sourceDir, "two.txt")), "Second delete source should remain before crash.");

  const recovered = await recoverAfterKill({ baseUrl, port, server, inFlight, type: "delete" });
  server = recovered.server;
  const operation = recovered.operation;
  assert(operation.result?.recovery?.completedCount === 1, "Recovered delete should preserve completed count.");
  assert(operation.result?.recovery?.remainingCount === 2, "Recovered delete should preserve remaining count.");
  assert(operation.result?.recovery?.retry?.body?.paths?.length === 2, "Recovered delete retry should target remaining paths only.");
  assert(operation.undo === null, "Recovered permanent delete should remain non-undoable.");
  assert(operation.result?.undoAvailable === false, "Recovered delete should state that undo is unavailable.");
  assert(!(await pathExists(path.join(fixture.sourceDir, "one.txt"))), "Recovered deleted item should remain absent.");
  assert(await pathExists(path.join(fixture.sourceDir, "two.txt")), "Recovered remaining delete source should remain.");
  return { server, operation };
}

async function runTrashKillPhase(baseUrl, port, fixture, currentServer) {
  await stopServer(currentServer);
  let server = await startReadyServer(baseUrl, port, { operationDelay: true });
  const inFlight = boundedFetch(`${baseUrl}/api/trash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: fixture.sources })
  }).catch((error) => error);

  const checkpoint = await waitForCheckpoint("trash", 2);
  const trashedDest = checkpoint.result.recovery.completed?.[0]?.dest;
  assert(checkpoint.result.recovery.completedCount === 1, "Trash checkpoint should report one completed item.");
  assert(checkpoint.result.recovery.remainingCount === 2, "Trash checkpoint should report two remaining items.");
  assert(trashedDest && (await pathExists(trashedDest)), "First trashed file should exist in app trash before crash.");
  assert(!(await pathExists(path.join(fixture.sourceDir, "one.txt"))), "First trash source should be absent before crash.");
  assert(await pathExists(path.join(fixture.sourceDir, "two.txt")), "Second trash source should remain before crash.");

  const recovered = await recoverAfterKill({ baseUrl, port, server, inFlight, type: "trash" });
  server = recovered.server;
  const operation = recovered.operation;
  const recoveredDest = operation.result?.recovery?.completed?.[0]?.dest;
  assert(operation.result?.recovery?.completedCount === 1, "Recovered trash should preserve completed count.");
  assert(operation.result?.recovery?.remainingCount === 2, "Recovered trash should preserve remaining count.");
  assert(operation.result?.recovery?.retry?.body?.paths?.length === 2, "Recovered trash retry should target remaining paths only.");
  assert(operation.undo?.type === "restore-trash", "Recovered trash should preserve restore metadata for completed items.");
  assert(operation.undo?.items?.length === 1, "Recovered trash undo should target the completed item only.");
  assert(recoveredDest && (await pathExists(recoveredDest)), "Recovered trash item should remain in app trash.");
  assert(!(await pathExists(path.join(fixture.sourceDir, "one.txt"))), "Recovered trashed source should remain absent.");
  assert(await pathExists(path.join(fixture.sourceDir, "two.txt")), "Recovered remaining trash source should remain.");
  return { server, operation };
}

async function runSyncKillPhase(baseUrl, port, fixture, currentServer) {
  await stopServer(currentServer);
  let server = await startReadyServer(baseUrl, port, { operationDelay: true });
  const body = {
    leftPath: fixture.leftDir,
    rightPath: fixture.rightDir,
    direction: "leftToRight",
    overwrite: false,
    mirrorDeletes: false,
    items: fixture.items
  };
  const inFlight = boundedFetch(`${baseUrl}/api/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).catch((error) => error);

  const checkpoint = await waitForCheckpoint("sync", 2);
  assert(checkpoint.result.recovery.completedCount === 1, "Sync checkpoint should report one completed item.");
  assert(checkpoint.result.recovery.remainingCount === 2, "Sync checkpoint should report two remaining items.");
  assert(await pathExists(path.join(fixture.rightDir, "one.txt")), "First synced file should exist before crash.");
  assert(!(await pathExists(path.join(fixture.rightDir, "two.txt"))), "Second synced file should not exist before crash.");

  const recovered = await recoverAfterKill({ baseUrl, port, server, inFlight, type: "sync" });
  server = recovered.server;
  const operation = recovered.operation;
  assert(operation.result?.recovery?.completedCount === 1, "Recovered sync should preserve completed count.");
  assert(operation.result?.recovery?.remainingCount === 2, "Recovered sync should preserve remaining count.");
  assert(operation.result?.recovery?.retry?.body?.items?.length === 2, "Recovered sync retry should target remaining relative paths only.");
  assert(operation.result?.recovery?.retry?.body?.items?.[0] === "two.txt", "Recovered sync retry should resume at the second item.");
  assert(await pathExists(path.join(fixture.rightDir, "one.txt")), "Completed sync item should remain on disk.");
  assert(!(await pathExists(path.join(fixture.rightDir, "two.txt"))), "Remaining sync item should not be copied during crash.");
  return { server, operation };
}

async function runRenameKillPhase(baseUrl, port, fixture, currentServer) {
  await stopServer(currentServer);
  let server = await startReadyServer(baseUrl, port, { operationDelay: true });
  const inFlight = boundedFetch(`${baseUrl}/api/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: fixture.source, name: fixture.name })
  }).catch((error) => error);

  const checkpoint = await waitForCheckpoint("rename", 0);
  assert(checkpoint.result.recovery.completedCount === 1, "Rename checkpoint should report one completed item.");
  assert(checkpoint.result.recovery.remainingCount === 0, "Rename checkpoint should report no remaining items.");
  assert(await pathExists(fixture.target), "Renamed file should exist before crash.");
  assert(!(await pathExists(fixture.source)), "Original rename path should not exist before crash.");

  const recovered = await recoverAfterKill({ baseUrl, port, server, inFlight, type: "rename" });
  server = recovered.server;
  const operation = recovered.operation;
  assert(operation.result?.recovery?.completedCount === 1, "Recovered rename should preserve completed count.");
  assert(operation.result?.recovery?.remainingCount === 0, "Recovered rename should preserve zero remaining count.");
  assert(operation.result?.recovery?.canRetryRemaining === false, "Recovered rename should not offer retry remaining.");
  assert(!operation.result?.recovery?.retry, "Recovered rename should not carry a remaining-work retry.");
  assert(operation.undo?.type === "rename-back", "Recovered rename should preserve undo metadata.");
  assert(await pathExists(fixture.target), "Recovered rename target should remain on disk.");
  assert(!(await pathExists(fixture.source)), "Recovered rename source should remain absent.");
  return { server, operation };
}

async function runStateSaveKillPhase(baseUrl, port, currentServer) {
  await requestJson(baseUrl, "/api/state", {
    method: "POST",
    body: JSON.stringify({ settings: { density: "compact", startupMode: "last" } })
  });
  const baselineState = await requestJson(baseUrl, "/api/state");
  assert(baselineState.settings?.density === "compact", "Baseline state save should complete before state crash test.");

  await stopServer(currentServer);
  let server = await startReadyServer(baseUrl, port, { stateDelay: true });
  const inFlight = boundedFetch(`${baseUrl}/api/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { density: "spacious", startupMode: "homeDownloads" } })
  }).catch((error) => error);

  const tempFile = await waitForStateTempFile();
  const tempState = JSON.parse(await fs.readFile(tempFile, "utf8"));
  assert(tempState.settings?.density === "spacious", "State temp file should contain the interrupted settings update.");
  assert((await readPersistedState()).settings?.density === "compact", "Live state file should remain on the previous complete settings.");

  await stopServer(server);
  const result = await inFlight;
  assert(result instanceof Error, "In-flight state save should fail when the server is killed.");

  server = await startReadyServer(baseUrl, port, false);
  const recoveredState = await requestJson(baseUrl, "/api/state");
  assert(recoveredState.settings?.density === "compact", "Recovered state should keep the last complete settings.");
  assert(recoveredState.settings?.density !== "spacious", "Interrupted settings should not partially replace state.");
  JSON.parse(await fs.readFile(statePath, "utf8"));
  return {
    server,
    state: {
      baselineDensity: baselineState.settings?.density,
      recoveredDensity: recoveredState.settings?.density,
      interruptedTempFile: tempFile
    }
  };
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 54000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = null;
  let completed = false;

  try {
    const copyPhase = await runCopyKillPhase(baseUrl, port, fixture.copy);
    server = copyPhase.server;
    const movePhase = await runMoveKillPhase(baseUrl, port, fixture.move, server);
    server = movePhase.server;
    const deletePhase = await runDeleteKillPhase(baseUrl, port, fixture.delete, server);
    server = deletePhase.server;
    const trashPhase = await runTrashKillPhase(baseUrl, port, fixture.trash, server);
    server = trashPhase.server;
    const syncPhase = await runSyncKillPhase(baseUrl, port, fixture.sync, server);
    server = syncPhase.server;
    const renamePhase = await runRenameKillPhase(baseUrl, port, fixture.rename, server);
    server = renamePhase.server;
    const statePhase = await runStateSaveKillPhase(baseUrl, port, server);
    server = statePhase.server;

    const outputPath = path.join(artifactsDir, "crash-kill-latest.json");
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          fixtureRoot,
          operations: {
            copy: {
              id: copyPhase.operation.id,
              status: copyPhase.operation.status,
              error: copyPhase.operation.error,
              progress: copyPhase.operation.progress,
              recovery: copyPhase.operation.result?.recovery,
              undo: copyPhase.operation.undo
            },
            move: {
              id: movePhase.operation.id,
              status: movePhase.operation.status,
              error: movePhase.operation.error,
              progress: movePhase.operation.progress,
              recovery: movePhase.operation.result?.recovery,
              undo: movePhase.operation.undo
            },
            delete: {
              id: deletePhase.operation.id,
              status: deletePhase.operation.status,
              error: deletePhase.operation.error,
              progress: deletePhase.operation.progress,
              recovery: deletePhase.operation.result?.recovery,
              undo: deletePhase.operation.undo,
              undoAvailable: deletePhase.operation.result?.undoAvailable
            },
            trash: {
              id: trashPhase.operation.id,
              status: trashPhase.operation.status,
              error: trashPhase.operation.error,
              progress: trashPhase.operation.progress,
              recovery: trashPhase.operation.result?.recovery,
              undo: trashPhase.operation.undo
            },
            sync: {
              id: syncPhase.operation.id,
              status: syncPhase.operation.status,
              error: syncPhase.operation.error,
              progress: syncPhase.operation.progress,
              recovery: syncPhase.operation.result?.recovery
            },
            rename: {
              id: renamePhase.operation.id,
              status: renamePhase.operation.status,
              error: renamePhase.operation.error,
              progress: renamePhase.operation.progress,
              recovery: renamePhase.operation.result?.recovery,
              undo: renamePhase.operation.undo
            }
          },
          stateSave: statePhase.state
        },
        null,
        2
      ),
      "utf8"
    );
    console.log("killed server during running copy checkpoint");
    console.log(`copy recovered remaining: ${copyPhase.operation.result.recovery.remainingCount}`);
    console.log("killed server during running move checkpoint");
    console.log(`move recovered remaining: ${movePhase.operation.result.recovery.remainingCount}`);
    console.log("killed server during running delete checkpoint");
    console.log(`delete recovered remaining: ${deletePhase.operation.result.recovery.remainingCount}`);
    console.log("killed server during running trash checkpoint");
    console.log(`trash recovered remaining: ${trashPhase.operation.result.recovery.remainingCount}`);
    console.log("killed server during running sync checkpoint");
    console.log(`sync recovered remaining: ${syncPhase.operation.result.recovery.remainingCount}`);
    console.log("killed server during running rename checkpoint");
    console.log(`rename recovered remaining: ${renamePhase.operation.result.recovery.remainingCount}`);
    console.log("killed server during atomic state save");
    console.log(`state recovered density: ${statePhase.state.recoveredDensity}`);
    console.log(`wrote ${outputPath}`);
    completed = true;
  } finally {
    await stopServer(server);
    await stopOwnedServers();
    if (completed && !keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    } else if (!completed) {
      console.error(`Retained failed crash fixture: ${runRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error);
  process.exitCode = 1;
});
